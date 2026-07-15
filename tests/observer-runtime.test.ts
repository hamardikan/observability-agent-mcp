import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryObserverMetrics,
  ObserverRuntime,
  type ObserverProvider,
} from "../src/observer/runtime.js";
import {
  FileObserverStateStore,
  InMemoryObserverStateStore,
} from "../src/observer/state.js";
import { HermesDelivery, signHermesPayload } from "../src/observer/delivery.js";
import type { ObserverConfig } from "../src/observer/config.js";
import type { CIWorkflowRun } from "../src/domain/ci-schemas.js";

const NOW = new Date("2026-07-14T00:00:00.000Z");
const SHA = "a".repeat(40);

function run(id: string, conclusion: CIWorkflowRun["conclusion"], updatedAt = NOW.toISOString()): CIWorkflowRun {
  return {
    id,
    repository: "owner/repo",
    workflow: "ci.yml",
    status: "completed",
    conclusion,
    runAttempt: 1,
    event: "workflow_dispatch",
    ref: "main",
    sha: SHA,
    createdAt: updatedAt,
    updatedAt,
  };
}

function config(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
  return {
    allowlist: [{ repo: "owner/repo", workflows: ["ci.yml"] }],
    stateFile: "/tmp/observer-state.json",
    hermesUrl: "https://hermes.example/ci-events",
    hmacKey: Buffer.from("hmac-key-that-is-at-least-32-bytes-long"),
    pollIntervalMs: 30_000,
    overlapMs: 5 * 60_000,
    staleAfterMs: 10 * 60_000,
    pageSize: 100,
    maxPages: 2,
    maxFailedJobs: 2,
    maxLogLines: 3,
    maxPayloadBytes: 32_000,
    leaseMs: 30_000,
    deliveryAttempts: 3,
    deliveryBackoffMs: 10,
    deliveryTimeoutMs: 1_000,
    ...overrides,
  };
}

function provider(overrides: Partial<ObserverProvider> = {}): ObserverProvider {
  return {
    listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [], hasMore: false }),
    getWorkflowStatus: vi.fn(),
    getFailedJobAnalysis: vi.fn().mockResolvedValue({
      schemaVersion: "1.0",
      observedAt: NOW.toISOString(),
      providerClass: "github-actions",
      freshness: "fresh",
      truncated: false,
      redactionsApplied: false,
      warnings: [],
      data: {
        run: run("1", "failure"),
        failedJobs: [{ id: "9", name: "test", status: "completed", conclusion: "failure", category: "test", failedSteps: ["unit"] }],
        categorySummary: { build: 0, test: 1, lint: 0, dependency: 0, deployment: 0, "infrastructure-connectivity": 0, permission: 0, unknown: 0 },
      },
    }),
    getLogEvidence: vi.fn().mockResolvedValue({
      schemaVersion: "1.0",
      observedAt: NOW.toISOString(),
      providerClass: "github-actions",
      freshness: "fresh",
      truncated: false,
      redactionsApplied: true,
      warnings: [],
      data: { runId: "1", jobId: "9", jobName: "test", available: true, lines: [{ sequence: 1, text: "token=[REDACTED]" }], sha256: createHash("sha256").update("token=[REDACTED]").digest("hex") },
    }),
    getRemediationPlan: vi.fn().mockResolvedValue({
      schemaVersion: "1.0",
      observedAt: NOW.toISOString(),
      providerClass: "github-actions",
      freshness: "fresh",
      truncated: false,
      redactionsApplied: false,
      warnings: [],
      data: { runId: "1", dryRun: true, actions: [{ category: "test", title: "test remediation review", steps: ["Inspect the bounded failure"], runbook: "docs/ci-cd-runbook.md#test" }] },
    }),
    rerunFailedWorkflow: vi.fn(),
    ...overrides,
  };
}

describe("portable observer runtime", () => {
  it("observes multiple terminal runs, rescans newest pages, and deduplicates deliveries", async () => {
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockResolvedValue({ runs: [run("2", "success"), run("1", "failure")], hasMore: false }),
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({
      config: config(),
      provider: ci,
      state: new InMemoryObserverStateStore(),
      deliver,
      clock: () => NOW,
      metrics: new InMemoryObserverMetrics(),
    });

    const first = await runtime.pollOnce();
    const second = await runtime.pollOnce();

    expect(first.observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "1", outcome: "failure" }),
      expect.objectContaining({ runId: "2", outcome: "success" }),
    ]));
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(ci.listWorkflowRuns).toHaveBeenNthCalledWith(1, expect.objectContaining({
      page: 1,
      perPage: 100,
    }));
    expect(ci.listWorkflowRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 1, createdAfter: expect.any(String) }));
    expect(second.delivered).toBe(0);
    expect(ci.rerunFailedWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
    ["cancelled", "cancelled"],
    ["timed_out", "timed_out"],
    ["action_required", "action_required"],
    ["skipped", "skipped"],
    ["neutral", "neutral"],
  ] as const)("maps %s terminal conclusions", async (conclusion, outcome) => {
    const runtime = new ObserverRuntime({
      config: config(),
      provider: provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("1", conclusion)], hasMore: false }) }),
      state: new InMemoryObserverStateStore(),
      deliver: vi.fn().mockResolvedValue(undefined),
      clock: () => NOW,
    });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ observed: [expect.objectContaining({ outcome })] });
  });

  it("marks old runs stale and maps provider failures without leaking error text", async () => {
    const secret = "provider-secret-must-not-escape";
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockResolvedValueOnce({ runs: [run("1", "success", "2026-07-13T23:00:00.000Z")], hasMore: false })
        .mockResolvedValueOnce({ runs: [], hasMore: false })
        .mockRejectedValueOnce(Object.assign(new Error(secret), { code: "malformed" })),
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    const stale = await runtime.pollOnce();
    const malformed = await runtime.pollOnce();

    expect(stale.observed[0]).toMatchObject({ outcome: "stale" });
    expect(malformed.errors).toEqual([{ repo: "owner/repo", workflow: "ci.yml", outcome: "malformed" }]);
    expect(JSON.stringify(malformed)).not.toContain(secret);
  });

  it("retrieves bounded analysis, evidence, and remediation for failures", async () => {
    const ci = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("1", "failure")], hasMore: false }) });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config({ maxFailedJobs: 1, maxLogLines: 3 }), provider: ci, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await runtime.pollOnce();

    expect(ci.getFailedJobAnalysis).toHaveBeenCalledWith({ repo: "owner/repo", workflow: "ci.yml", runId: "1" });
    expect(ci.getLogEvidence).toHaveBeenCalledWith({ repo: "owner/repo", workflow: "ci.yml", runId: "1", jobId: "9", maxLines: 3 });
    expect(ci.getRemediationPlan).toHaveBeenCalledWith({ repo: "owner/repo", workflow: "ci.yml", runId: "1" });
    expect(deliver.mock.calls[0]?.[2]).toBe("success");
    expect(deliver.mock.calls[1]?.[2]).toBe("analysis");
    expect(JSON.stringify(deliver.mock.calls[1]?.[0])).not.toContain("provider-secret");
    expect(JSON.stringify(deliver.mock.calls[1]?.[0])).not.toContain("token=[REDACTED]");
    expect(JSON.stringify(deliver.mock.calls[1]?.[0])).not.toContain('"failedSteps"');
    expect(String(deliver.mock.calls[1]?.[0])).toContain('"ciEvidence"');
    expect(String(deliver.mock.calls[1]?.[0])).toContain('"runbook":"docs/ci-cd-runbook.md#test"');
  });

  it("delivers one bounded failure analysis notification", async () => {
    const ci = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("50", "failure")], hasMore: false }) });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 2 });
    expect(deliver.mock.calls.map((call) => call[2])).toEqual(["success", "analysis"]);
    expect(deliver.mock.calls.map((call) => call[1])).toEqual(["owner/repo:ci.yml:50:1:status", "owner/repo:ci.yml:50:1:analysis"]);
    expect(JSON.parse(String(deliver.mock.calls[0]?.[0])).type).toBe("ci.run.observed");
    expect(JSON.parse(String(deliver.mock.calls[0]?.[0])).outcome).toBe("failure");
    expect(JSON.parse(String(deliver.mock.calls[1]?.[0])).type).toBe("ci.failure.analysis");
    expect(JSON.parse(String(deliver.mock.calls[1]?.[0])).analysis).toBeDefined();
  });

  it("retries a failed analysis route without duplicating the direct status notice", async () => {
    const state = new InMemoryObserverStateStore();
    let now = NOW;
    const ci = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("51", "failure")], hasMore: false }) });
    const deliver = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("analysis transport secret"))
      .mockResolvedValueOnce(undefined);
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state, deliver, clock: () => now });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 1 });
    const recordAfterFailure = Object.values(state.load().targets)[0]?.seen["owner/repo:ci.yml:51:1"];
    expect(recordAfterFailure).toMatchObject({ delivery: "delivered", statusDelivery: "delivered", analysisDelivery: "pending" });
    expect(state.load().targets["owner/repo\u001fci.yml"]).toMatchObject({ deliveryBackoffUntil: "2026-07-14T00:00:00.010Z" });
    now = new Date("2026-07-14T00:00:00.010Z");
    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 1 });
    expect(deliver.mock.calls.map((call) => call[2])).toEqual(["success", "analysis", "analysis"]);
    expect(deliver.mock.calls.map((call) => call[1])).toEqual(["owner/repo:ci.yml:51:1:status", "owner/repo:ci.yml:51:1:analysis", "owner/repo:ci.yml:51:1:analysis"]);
  });

  it("recovers both route delivery records after an observer restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "observer-critical-restart-"));
    const statePath = join(directory, "state.json");
    try {
      const firstDelivery = vi.fn().mockResolvedValue(undefined);
      const first = new ObserverRuntime({
        config: config({ stateFile: statePath }),
        provider: provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("52", "failure")], hasMore: false }) }),
        state: new FileObserverStateStore({ filePath: statePath, leaseMs: 30_000, clock: () => NOW }),
        deliver: firstDelivery,
        clock: () => NOW,
      });
      await first.pollOnce();
      expect(firstDelivery).toHaveBeenCalledTimes(2);
      expect(Object.values(new FileObserverStateStore({ filePath: statePath, leaseMs: 30_000, clock: () => NOW }).load().targets)[0]?.seen["owner/repo:ci.yml:52:1"]).toMatchObject({ statusDelivery: "delivered", analysisDelivery: "delivered" });

      const secondDelivery = vi.fn().mockResolvedValue(undefined);
      const second = new ObserverRuntime({
        config: config({ stateFile: statePath }),
        provider: provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("52", "failure")], hasMore: false }) }),
        state: new FileObserverStateStore({ filePath: statePath, leaseMs: 30_000, clock: () => NOW }),
        deliver: secondDelivery,
        clock: () => NOW,
      });
      await second.pollOnce();
      expect(secondDelivery).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("delivers successful runs on the status route only", async () => {
    const ci = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("53", "success")], hasMore: false }) });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 1 });
    expect(deliver).toHaveBeenCalledWith(expect.any(String), "owner/repo:ci.yml:53:1:status", "success");
    expect(JSON.parse(String(deliver.mock.calls[0]?.[0]))).not.toHaveProperty("analysis");
    expect(ci.getFailedJobAnalysis).not.toHaveBeenCalled();
  });

  it("records stale runs without delivering status or analysis", async () => {
    const stale = run("54", "failure", new Date(NOW.getTime() - 11 * 60_000).toISOString());
    const ci = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [stale], hasMore: false }) });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const state = new InMemoryObserverStateStore();
    const metrics = new InMemoryObserverMetrics();
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state, deliver, clock: () => NOW, metrics });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 0, observed: [{ runId: "54", outcome: "stale" }] });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 0, observed: [] });

    expect(deliver).not.toHaveBeenCalled();
    expect(ci.getFailedJobAnalysis).not.toHaveBeenCalled();
    expect(ci.getLogEvidence).not.toHaveBeenCalled();
    expect(ci.getRemediationPlan).not.toHaveBeenCalled();
    expect(Object.values(state.load().targets)[0]?.seen["owner/repo:ci.yml:54:1"]).toMatchObject({
      delivery: "suppressed",
      statusDelivery: "suppressed",
      analysisDelivery: "suppressed",
    });
    expect(metrics.snapshot()).toMatchObject({ suppressed: 1, deliveries: 0 });
  });

  it("enforces exact repository/workflow allowlists", async () => {
    const ci = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [], hasMore: false }) });
    const runtime = new ObserverRuntime({
      config: config({ allowlist: [{ repo: "owner/other", workflows: ["allowed.yml"] }] }),
      provider: ci,
      state: new InMemoryObserverStateStore(),
      deliver: vi.fn(),
      clock: () => NOW,
    });
    await runtime.pollOnce();
    expect(ci.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({ repo: "owner/other", workflow: "allowed.yml" }));
    expect(ci.listWorkflowRuns).not.toHaveBeenCalledWith(expect.objectContaining({ repo: "owner/repo", workflow: "../ci.yml" }));
  });

  it("deduplicates the same run when overlapping provider pages repeat it", async () => {
    const duplicate = run("77", "success");
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockResolvedValueOnce({ runs: [duplicate], hasMore: true, nextPage: 2 })
        .mockResolvedValueOnce({ runs: [duplicate], hasMore: false }),
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config({ maxPages: 2 }), provider: ci, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await runtime.pollOnce();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("reconciles a verified webhook with polling using one provider-neutral event identity", async () => {
    const candidate = run("81", "success");
    const listTerminalRuns = vi.fn().mockResolvedValue({ runs: [candidate], hasMore: false });
    const verify = vi.fn().mockResolvedValue([candidate]);
    const source = {
      providerClass: "jenkins",
      listTerminalRuns,
      webhookVerifier: { verify },
    };
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({
      config: config(),
      provider: provider(),
      source,
      state: new InMemoryObserverStateStore(),
      deliver,
      clock: () => NOW,
    });

    const webhook = await runtime.ingestWebhook({ headers: { "x-provider-signature": "verified-by-adapter" }, body: "provider payload" });
    const poll = await runtime.pollOnce();

    expect(verify).toHaveBeenCalledWith({ headers: { "x-provider-signature": "verified-by-adapter" }, body: "provider payload" });
    expect(webhook).toMatchObject({ accepted: true, delivered: 1, observed: [{ runId: "81", outcome: "success" }] });
    expect(poll).toMatchObject({ delivered: 0, observed: [] });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(deliver.mock.calls[0]?.[0]))).toMatchObject({ source: "webhook", providerClass: "jenkins", eventId: "owner/repo:ci.yml:81:1" });
  });

  it("deduplicates both status and analysis across webhook then poll", async () => {
    const candidate = run("85", "failure");
    const source = {
      listTerminalRuns: vi.fn().mockResolvedValue({ runs: [candidate], hasMore: false }),
      webhookVerifier: { verify: vi.fn().mockResolvedValue([candidate]) },
    };
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config(), provider: provider(), source, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await expect(runtime.ingestWebhook({ headers: {}, body: "signed" })).resolves.toMatchObject({ accepted: true, delivered: 2 });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 0, observed: [] });
    expect(deliver.mock.calls.map((call) => call[2])).toEqual(["success", "analysis"]);
  });

  it("does not redeliver a webhook after polling has settled the same run", async () => {
    const candidate = run("84", "success");
    const state = new InMemoryObserverStateStore();
    const deliver = vi.fn().mockResolvedValue(undefined);
    const source = {
      listTerminalRuns: vi.fn().mockResolvedValue({ runs: [candidate], hasMore: false }),
      webhookVerifier: { verify: vi.fn().mockResolvedValue([candidate]) },
    };
    const runtime = new ObserverRuntime({ config: config(), provider: provider(), source, state, deliver, clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 1 });
    await expect(runtime.ingestWebhook({ headers: {}, body: "duplicate" })).resolves.toMatchObject({ accepted: true, delivered: 0, observed: [] });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not call provider analysis or delivery for stale webhook runs", async () => {
    const stale = run("82", "failure", new Date(NOW.getTime() - 11 * 60_000).toISOString());
    const ci = provider({ listWorkflowRuns: vi.fn(), getFailedJobAnalysis: vi.fn(), getLogEvidence: vi.fn(), getRemediationPlan: vi.fn() });
    const source = {
      listTerminalRuns: vi.fn(),
      webhookVerifier: { verify: vi.fn().mockResolvedValue([stale]) },
    };
    const deliver = vi.fn();
    const runtime = new ObserverRuntime({ config: config(), provider: ci, source, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await expect(runtime.ingestWebhook({ headers: {}, body: "stale" })).resolves.toMatchObject({ accepted: true, delivered: 0, observed: [{ outcome: "stale" }] });
    expect(source.listTerminalRuns).not.toHaveBeenCalled();
    expect(ci.getFailedJobAnalysis).not.toHaveBeenCalled();
    expect(ci.getLogEvidence).not.toHaveBeenCalled();
    expect(ci.getRemediationPlan).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails closed when a provider webhook verifier rejects the payload", async () => {
    const source = {
      listTerminalRuns: vi.fn(),
      webhookVerifier: { verify: vi.fn().mockRejectedValue(new Error("signature detail must not escape")) },
    };
    const ci = provider({ getFailedJobAnalysis: vi.fn(), getLogEvidence: vi.fn(), getRemediationPlan: vi.fn() });
    const deliver = vi.fn();
    const runtime = new ObserverRuntime({ config: config(), provider: ci, source, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await expect(runtime.ingestWebhook({ headers: {}, body: "untrusted" })).resolves.toMatchObject({ accepted: false, errors: [{ repo: "unknown", workflow: "unknown", outcome: "malformed" }] });
    expect(source.listTerminalRuns).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("persists delivery backoff so a failed sink is not retried on every poll", async () => {
    let now = NOW;
    const listWorkflowRuns = vi.fn().mockResolvedValue({ runs: [run("83", "success")], hasMore: false });
    const ci = provider({ listWorkflowRuns });
    const deliver = vi.fn().mockRejectedValue(new Error("sink unavailable"));
    const state = new InMemoryObserverStateStore();
    const runtime = new ObserverRuntime({ config: config({ deliveryAttempts: 1, deliveryBackoffMs: 100 }), provider: ci, state, deliver, clock: () => now });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 0, errors: [] });
    const callsAfterFailure = listWorkflowRuns.mock.calls.length;
    expect(Object.values(state.load().targets)[0]).toMatchObject({ deliveryBackoffMs: 100, deliveryBackoffUntil: "2026-07-14T00:00:00.100Z" });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 0, errors: [{ outcome: "unavailable" }] });
    expect(listWorkflowRuns).toHaveBeenCalledTimes(callsAfterFailure);
    now = new Date("2026-07-14T00:00:00.100Z");
    await runtime.pollOnce();
    expect(listWorkflowRuns.mock.calls.length).toBeGreaterThan(callsAfterFailure);
  });
});

describe("observer state and Hermes delivery", () => {
  it("writes private state atomically and leases it", () => {
    const directory = mkdtempSync(join(tmpdir(), "observer-state-"));
    const path = join(directory, "state.json");
    try {
      const first = new FileObserverStateStore({ filePath: path, leaseMs: 30_000, clock: () => NOW });
      const second = new FileObserverStateStore({ filePath: path, leaseMs: 30_000, clock: () => NOW });
      const release = first.acquireLease();
      expect(release).toBeTypeOf("function");
      expect(second.acquireLease()).toBeUndefined();
      first.save({ version: 1, targets: {}, updatedAt: NOW.toISOString() });
      expect(statSync(path).mode & 0o077).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
      release?.();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reloads suppressed delivery records from private file state", () => {
    const directory = mkdtempSync(join(tmpdir(), "observer-suppressed-state-"));
    const path = join(directory, "state.json");
    try {
      const state = new FileObserverStateStore({ filePath: path, leaseMs: 30_000, clock: () => NOW });
      state.save({
        version: 1,
        updatedAt: NOW.toISOString(),
        targets: {
          target: {
            page: 1,
            seen: {
              "owner/repo:ci.yml:54:1": {
                outcome: "stale",
                observedAt: NOW.toISOString(),
                delivery: "suppressed",
                statusDelivery: "suppressed",
                analysisDelivery: "suppressed",
              },
            },
          },
        },
      });
      expect(state.load().targets.target?.seen["owner/repo:ci.yml:54:1"]).toMatchObject({ delivery: "suppressed" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signs timestamp.body and retries bounded delivery without persisting the key", async () => {
    const key = Buffer.from("hmac-key-that-is-at-least-32-bytes-long");
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("try again", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const delivery = new HermesDelivery({ url: "https://hermes.example/events", key, fetch, clock: () => NOW, sleep: vi.fn().mockResolvedValue(undefined), maxAttempts: 2, backoffMs: 10, timeoutMs: 1_000 });
    const body = JSON.stringify({ schemaVersion: "1.0", outcome: "success", runId: "1" });

    await expect(delivery.deliver(body, "event-1")).resolves.toEqual({ delivered: true, attempts: 2 });
    const timestamp = String(Math.floor(NOW.getTime() / 1_000));
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error", body });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Signature-V2": signHermesPayload(key, timestamp, body),
      "X-Request-ID": "event-1",
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("X-GitHub-Event");
    expect(fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-observer-timestamp");
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(key.toString());
  });

  it("does not retry a bounded Hermes 429 forever", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("quota", { status: 429 }));
    const delivery = new HermesDelivery({ url: "https://hermes.example/events", key: Buffer.from("hmac-key-that-is-at-least-32-bytes-long"), fetch, clock: () => NOW, sleep: vi.fn().mockResolvedValue(undefined), maxAttempts: 3, backoffMs: 1, timeoutMs: 1_000 });
    await expect(delivery.deliver("{}", "quota-event")).rejects.toMatchObject({ code: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("contains model/provider quota failures as metadata warnings", async () => {
    const ci = provider({
      listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("43", "failure")], hasMore: false }),
      getFailedJobAnalysis: vi.fn().mockRejectedValue(Object.assign(new Error("model quota secret"), { code: "unavailable" })),
      getRemediationPlan: vi.fn().mockRejectedValue(Object.assign(new Error("provider quota secret"), { code: "unavailable" })),
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state: new InMemoryObserverStateStore(), deliver, clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 2 });
    expect(String(deliver.mock.calls[1]?.[0])).not.toContain("quota secret");
    expect(String(deliver.mock.calls[1]?.[0])).toContain('"code":"ci-analysis-unavailable"');
  });

  it("recovers a cursor and dedupe record after an observer restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "observer-restart-"));
    const statePath = join(directory, "state.json");
    try {
      const firstProvider = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("42", "success")], hasMore: false }) });
      const firstDelivery = vi.fn().mockResolvedValue(undefined);
      const first = new ObserverRuntime({ config: config({ stateFile: statePath }), provider: firstProvider, state: new FileObserverStateStore({ filePath: statePath, leaseMs: 30_000, clock: () => NOW }), deliver: firstDelivery, clock: () => NOW });
      await first.pollOnce();
      expect(Object.values(new FileObserverStateStore({ filePath: statePath, leaseMs: 30_000, clock: () => NOW }).load().targets)[0]).toMatchObject({ page: 1, cursor: NOW.toISOString() });

      const secondProvider = provider({ listWorkflowRuns: vi.fn().mockResolvedValue({ runs: [run("42", "success")], hasMore: false }) });
      const secondDelivery = vi.fn().mockResolvedValue(undefined);
      const second = new ObserverRuntime({ config: config({ stateFile: statePath }), provider: secondProvider, state: new FileObserverStateStore({ filePath: statePath, leaseMs: 30_000, clock: () => NOW }), deliver: secondDelivery, clock: () => NOW });
      await second.pollOnce();

      expect(secondProvider.listWorkflowRuns).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
      expect(secondProvider.listWorkflowRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 1, createdAfter: expect.any(String) }));
      expect(secondDelivery).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("continues a truncated page window from durable next-page state", async () => {
    const state = new InMemoryObserverStateStore();
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockResolvedValueOnce({ runs: [run("1", "success")], hasMore: false })
        .mockResolvedValueOnce({ runs: [run("1", "success")], hasMore: true, nextPage: 2 })
        .mockResolvedValueOnce({ runs: [run("2", "success")], hasMore: false })
        .mockResolvedValueOnce({ runs: [run("3", "success")], hasMore: false }),
    });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const runtime = new ObserverRuntime({ config: config({ maxPages: 1 }), provider: ci, state, deliver, clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ truncatedTargets: 1, delivered: 1 });
    expect(Object.values(state.load().targets)[0]).toMatchObject({ page: 2 });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ truncatedTargets: 0, delivered: 2 });
    expect(ci.listWorkflowRuns).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
    expect(vi.mocked(ci.listWorkflowRuns).mock.calls[0]?.[0]).not.toHaveProperty("createdAfter");
    expect(ci.listWorkflowRuns).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 1, createdAfter: "2026-07-12T23:55:00.000Z" }));
    expect(ci.listWorkflowRuns).toHaveBeenNthCalledWith(3, expect.objectContaining({ page: 1 }));
    expect(vi.mocked(ci.listWorkflowRuns).mock.calls[2]?.[0]).not.toHaveProperty("createdAfter");
    expect(ci.listWorkflowRuns).toHaveBeenNthCalledWith(4, expect.objectContaining({ page: 2, createdAfter: "2026-07-12T23:55:00.000Z" }));
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it("keeps one createdAfter filter across all durable backlog pages", async () => {
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockResolvedValueOnce({ runs: [run("10", "success")], hasMore: false })
        .mockResolvedValueOnce({ runs: [run("10", "success")], hasMore: true, nextPage: 2 })
        .mockResolvedValueOnce({ runs: [run("11", "success")], hasMore: false }),
    });
    const runtime = new ObserverRuntime({ config: config({ maxPages: 2 }), provider: ci, state: new InMemoryObserverStateStore(), deliver: vi.fn().mockResolvedValue(undefined), clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ delivered: 2, truncatedTargets: 0 });
    const calls = vi.mocked(ci.listWorkflowRuns).mock.calls;
    const firstBacklog = calls[1]?.[0];
    const secondBacklog = calls[2]?.[0];
    expect(firstBacklog).toMatchObject({ page: 1, createdAfter: "2026-07-12T23:55:00.000Z" });
    expect(secondBacklog).toMatchObject({ page: 2, createdAfter: firstBacklog?.createdAfter });
  });

  it.each(["unavailable", "rate_limited"] as const)("persists bounded %s polling backoff across polls", async (code) => {
    let now = NOW;
    const state = new InMemoryObserverStateStore();
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("provider secret"), { code }))
        .mockResolvedValue({ runs: [], hasMore: false }),
    });
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state, deliver: vi.fn(), clock: () => now });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ errors: [{ outcome: "unavailable" }] });
    expect(Object.values(state.load().targets)[0]).toMatchObject({ backoffMs: 5_000, backoffUntil: "2026-07-14T00:00:05.000Z" });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ errors: [{ outcome: "unavailable" }] });
    expect(ci.listWorkflowRuns).toHaveBeenCalledTimes(1);

    now = new Date("2026-07-14T00:00:05.000Z");
    await expect(runtime.pollOnce()).resolves.toMatchObject({ errors: [], delivered: 0 });
    expect(ci.listWorkflowRuns).toHaveBeenCalledTimes(3);
    expect(Object.values(state.load().targets)[0]).not.toHaveProperty("backoffUntil");
  });

  it("degrades current health when the bounded terminal window is truncated and recovers on a clean poll", async () => {
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockResolvedValueOnce({ runs: [run("1", "success")], hasMore: false })
        .mockResolvedValueOnce({ runs: [], hasMore: true, nextPage: 2 })
        .mockResolvedValueOnce({ runs: [], hasMore: true, nextPage: 3 })
        .mockResolvedValueOnce({ runs: [], hasMore: false })
        .mockResolvedValueOnce({ runs: [run("1", "success")], hasMore: false }),
    });
    const runtime = new ObserverRuntime({ config: config({ maxPages: 2 }), provider: ci, state: new InMemoryObserverStateStore(), deliver: vi.fn().mockResolvedValue(undefined), clock: () => NOW });

    await expect(runtime.pollOnce()).resolves.toMatchObject({ truncatedTargets: 1 });
    expect(runtime.health()).toMatchObject({ status: "degraded", metrics: { truncatedTargets: 1 } });
    await expect(runtime.pollOnce()).resolves.toMatchObject({ truncatedTargets: 0 });
    expect(runtime.health()).toMatchObject({ status: "ok", metrics: { truncatedTargets: 0 } });
  });

  it("recovers current health after a transient provider failure", async () => {
    let now = NOW;
    const ci = provider({
      listWorkflowRuns: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("transient"), { code: "unavailable" }))
        .mockResolvedValue({ runs: [], hasMore: false }),
    });
    const runtime = new ObserverRuntime({ config: config(), provider: ci, state: new InMemoryObserverStateStore(), deliver: vi.fn(), clock: () => now });

    await runtime.pollOnce();
    expect(runtime.health()).toMatchObject({ status: "degraded", metrics: { lastError: "unavailable" } });
    now = new Date("2026-07-14T00:00:05.000Z");
    await runtime.pollOnce();
    expect(runtime.health()).toMatchObject({ status: "ok" });
    expect(runtime.health().metrics).not.toHaveProperty("lastError");
  });
});
