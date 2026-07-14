import { createServer, type Server } from "node:http";

import { CIRepositorySchema, CIRunIdSchema, CIWorkflowSchema, type CIWorkflowRun } from "../domain/ci-schemas.js";
import { redactMetadata } from "../ci/redaction.js";
import { CIProviderError, type CIProvider } from "../providers/ci-provider.js";
import { GitHubActionsProvider } from "../providers/github-actions-provider.js";
import { loadObserverConfiguration, observerRuntimeConfig, readObserverSecretFile, type ObserverConfig } from "./config.js";
import { MappedGitHubAppTokenProvider } from "../providers/mapped-github-app-token-provider.js";
import { z } from "zod";
import { HermesDelivery, type ObserverDeliveryRoute } from "./delivery.js";
import { FileObserverStateStore, type ObserverSeenRecord, type ObserverStateDocument, type ObserverStateStore, type ObserverTargetState } from "./state.js";

export type ObserverOutcome = "success" | "failure" | "cancelled" | "timed_out" | "action_required" | "skipped" | "neutral" | "stale" | "unavailable" | "malformed";

export type ObserverProvider = CIProvider & {
  listWorkflowRuns(input: {
    repo: string;
    workflow: string;
    createdAfter?: string;
    page: number;
    perPage: number;
  }): Promise<{ runs: readonly CIWorkflowRun[]; hasMore: boolean; nextPage?: number }>;
};

export interface ObserverEvent {
  readonly schemaVersion: "1.0";
  readonly type: "ci.run.observed";
  readonly eventId: string;
  readonly observedAt: string;
  readonly repo: string;
  readonly workflow: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly terminalConclusion: CIWorkflowRun["conclusion"];
  readonly outcome: ObserverOutcome;
  readonly freshness: "fresh" | "stale";
  readonly updatedAt: string;
  readonly analysis?: unknown;
  readonly evidence?: readonly unknown[];
  readonly remediation?: unknown;
  readonly warnings: readonly { code: string; message: string }[];
}

export interface ObserverPollSummary {
  readonly skipped: boolean;
  readonly observed: readonly { eventId: string; runId: string; outcome: ObserverOutcome }[];
  readonly delivered: number;
  readonly errors: readonly { repo: string; workflow: string; outcome: "unavailable" | "malformed" }[];
  readonly truncatedTargets: number;
}

export interface ObserverMetricsSnapshot {
  readonly polls: number;
  readonly deliveries: number;
  readonly deliveryFailures: number;
  readonly targetErrors: number;
  readonly observations: number;
  readonly outcomes: Readonly<Record<ObserverOutcome, number>>;
  readonly targetCount: number;
  readonly truncatedTargets: number;
  readonly lastPollDegraded: boolean;
  readonly lastPollAt?: string;
  readonly lastError?: "unavailable" | "malformed";
}

type MutableObserverState = {
  version: 1;
  targets: Record<string, ObserverTargetState>;
  updatedAt: string;
};

const PROVIDER_BACKOFF_BASE_MS = 5_000;
const PROVIDER_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;

export class InMemoryObserverMetrics {
  #polls = 0;
  #deliveries = 0;
  #deliveryFailures = 0;
  #targetErrors = 0;
  #observations = 0;
  #targetCount = 0;
  #truncatedTargets = 0;
  #lastPollDegraded = false;
  #lastPollAt: string | undefined;
  #lastError: "unavailable" | "malformed" | undefined;
  readonly #outcomes: Record<ObserverOutcome, number> = {
    success: 0, failure: 0, cancelled: 0, timed_out: 0, action_required: 0, skipped: 0, neutral: 0, stale: 0, unavailable: 0, malformed: 0,
  };

  recordPoll(targetCount: number, at: string): void { this.#polls += 1; this.#targetCount = targetCount; this.#lastPollAt = at; }
  recordObservation(outcome: ObserverOutcome): void { this.#observations += 1; this.#outcomes[outcome] += 1; }
  recordDelivery(): void { this.#deliveries += 1; }
  recordDeliveryFailure(): void { this.#deliveryFailures += 1; }
  recordTargetError(outcome: "unavailable" | "malformed"): void { this.#targetErrors += 1; this.#lastError = outcome; this.#outcomes[outcome] += 1; }
  finishPoll(options: { targetErrors: number; truncatedTargets: number; deliveryFailures: number }): void {
    this.#truncatedTargets = options.truncatedTargets;
    this.#lastPollDegraded = options.targetErrors > 0 || options.truncatedTargets > 0 || options.deliveryFailures > 0;
    if (options.targetErrors === 0) this.#lastError = undefined;
  }
  snapshot(): ObserverMetricsSnapshot {
    return {
      polls: this.#polls,
      deliveries: this.#deliveries,
      deliveryFailures: this.#deliveryFailures,
      targetErrors: this.#targetErrors,
      observations: this.#observations,
      outcomes: { ...this.#outcomes },
      targetCount: this.#targetCount,
      truncatedTargets: this.#truncatedTargets,
      lastPollDegraded: this.#lastPollDegraded,
      ...(this.#lastPollAt === undefined ? {} : { lastPollAt: this.#lastPollAt }),
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    };
  }
}

export class ObserverRuntime {
  readonly #config: ObserverConfig;
  readonly #provider: ObserverProvider;
  readonly #state: ObserverStateStore;
  readonly #deliver: (body: string, eventId: string, route?: ObserverDeliveryRoute) => Promise<unknown>;
  readonly #clock: () => Date;
  readonly #metrics: InMemoryObserverMetrics;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling = false;

  constructor(options: {
    config: ObserverConfig;
    provider: ObserverProvider;
    state: ObserverStateStore;
    deliver: (body: string, eventId: string, route?: ObserverDeliveryRoute) => Promise<unknown>;
    clock?: () => Date;
    metrics?: InMemoryObserverMetrics;
  }) {
    this.#config = options.config;
    this.#provider = options.provider;
    this.#state = options.state;
    this.#deliver = options.deliver;
    this.#clock = options.clock ?? (() => new Date());
    this.#metrics = options.metrics ?? new InMemoryObserverMetrics();
  }

  get metrics(): InMemoryObserverMetrics { return this.#metrics; }

  async pollOnce(): Promise<ObserverPollSummary> {
    const release = this.#state.acquireLease();
    if (release === undefined) return { skipped: true, observed: [], delivered: 0, errors: [], truncatedTargets: 0 };
    const now = this.#clock();
    this.#metrics.recordPoll(this.targetCount(), now.toISOString());
    const observed: Array<{ eventId: string; runId: string; outcome: ObserverOutcome }> = [];
    const errors: Array<{ repo: string; workflow: string; outcome: "unavailable" | "malformed" }> = [];
    let delivered = 0;
    let truncatedTargets = 0;
    let pollDeliveryFailures = 0;
    try {
      const state = this.#state.load();
      const mutableState = cloneState(state);
      for (const target of targets(this.#config)) {
        const targetKey = targetKeyFor(target.repo, target.workflow);
        const previous = mutableState.targets[targetKey] ?? { page: 1, seen: {} };
        const initialPage = previous.page ?? 1;
        const scanCursor = previous.cursor ?? new Date(now.getTime() - (this.#config.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS)).toISOString();
        const backoffUntil = previous.backoffUntil === undefined ? undefined : Date.parse(previous.backoffUntil);
        if (backoffUntil !== undefined && Number.isFinite(backoffUntil) && backoffUntil > now.getTime()) {
          this.#metrics.recordTargetError("unavailable");
          errors.push({ repo: target.repo, workflow: target.workflow, outcome: "unavailable" });
          continue;
        }

        let backlogPage = initialPage;
        let backlogPagesFetched = 0;
        let backlogHasMore = false;
        let targetFailedDelivery = false;
        let targetTruncated = false;
        let currentTarget: ObserverTargetState = { ...previous, page: backlogPage, cursor: scanCursor };
        try {
          const attempted = new Set<string>();
          const processRuns = async (runs: readonly CIWorkflowRun[]): Promise<boolean> => {
            for (const candidate of runs) {
              let run: CIWorkflowRun;
              try { run = ObserverRunSchema.parse(candidate); } catch {
                this.#metrics.recordTargetError("malformed");
                errors.push({ repo: target.repo, workflow: target.workflow, outcome: "malformed" });
                continue;
              }
              if (run.repository !== target.repo || run.workflow !== target.workflow) {
                this.#metrics.recordTargetError("malformed");
                errors.push({ repo: target.repo, workflow: target.workflow, outcome: "malformed" });
                continue;
              }
              if (run.status !== "completed") continue;
              const eventId = observerEventId(run);
              const prior = (mutableState.targets[targetKey] ?? currentTarget).seen[eventId];
              if (attempted.has(eventId)) continue;
              attempted.add(eventId);
              const statusDelivered = prior?.statusDelivery === "delivered" || prior?.delivery === "delivered";
              const analysisRequired = isAnalysisConclusion(run.conclusion);
              const analysisDelivered = !analysisRequired || prior?.analysisDelivery === "delivered";
              if (statusDelivered && analysisDelivered) continue;
              const outcome = outcomeForRun(run, now, this.#config.staleAfterMs);
              this.#metrics.recordObservation(outcome);
              observed.push({ eventId, runId: run.id, outcome });
              if (!statusDelivered) {
                const statusEvent = await this.buildEvent(run, outcome, now, false);
                currentTarget = markSeen(mutableState.targets[targetKey] ?? currentTarget, eventId, { outcome, observedAt: statusEvent.observedAt, delivery: "pending", statusDelivery: "pending" });
                mutableState.targets[targetKey] = currentTarget;
                this.#state.save(withUpdatedAt(mutableState, now));
                try {
                  await this.#deliver(serializeObserverEvent(statusEvent, this.#config.maxPayloadBytes), deliveryEventId(eventId, "status"), "success");
                  currentTarget = markSeen(mutableState.targets[targetKey] ?? currentTarget, eventId, { outcome, observedAt: statusEvent.observedAt, delivery: "delivered", deliveredAt: now.toISOString(), statusDelivery: "delivered", statusDeliveredAt: now.toISOString() });
                  mutableState.targets[targetKey] = currentTarget;
                  this.#state.save(withUpdatedAt(mutableState, now));
                  this.#metrics.recordDelivery();
                  delivered += 1;
                } catch {
                  this.#metrics.recordDeliveryFailure();
                  pollDeliveryFailures += 1;
                  return true;
                }
              }
              if (analysisRequired && !analysisDelivered) {
                const analysisEvent = await this.buildEvent(run, outcome, now, true);
                currentTarget = markSeen(mutableState.targets[targetKey] ?? currentTarget, eventId, { outcome, observedAt: analysisEvent.observedAt, analysisDelivery: "pending" });
                mutableState.targets[targetKey] = currentTarget;
                this.#state.save(withUpdatedAt(mutableState, now));
                try {
                  await this.#deliver(serializeObserverEvent(analysisEvent, this.#config.maxPayloadBytes), deliveryEventId(eventId, "analysis"), "analysis");
                  currentTarget = markSeen(mutableState.targets[targetKey] ?? currentTarget, eventId, { outcome, observedAt: analysisEvent.observedAt, analysisDelivery: "delivered", analysisDeliveredAt: now.toISOString() });
                  mutableState.targets[targetKey] = currentTarget;
                  this.#state.save(withUpdatedAt(mutableState, now));
                  this.#metrics.recordDelivery();
                  delivered += 1;
                } catch {
                  this.#metrics.recordDeliveryFailure();
                  pollDeliveryFailures += 1;
                  return true;
                }
              }
            }
            return false;
          };

          // The hot lane is always unfiltered page one. GitHub's created-time
          // filter cannot see a run created long ago that only became terminal.
          const hotResult = await this.#provider.listWorkflowRuns({
            repo: target.repo,
            workflow: target.workflow,
            page: 1,
            perPage: this.#config.pageSize,
          });
          targetFailedDelivery = await processRuns(hotResult.runs);

          // The backlog lane owns durable page/cursor state. Its filter is
          // computed once and reused unchanged across every page in the scan.
          const backlogCreatedAfter = createdAfterWithOverlap(scanCursor, this.#config.overlapMs);
          while (!targetFailedDelivery && backlogPagesFetched < this.#config.maxPages) {
            currentTarget = { ...currentTarget, page: backlogPage, cursor: scanCursor };
            mutableState.targets[targetKey] = currentTarget;
            this.#state.save(withUpdatedAt(mutableState, now));
            const listInput: {
              repo: string;
              workflow: string;
              page: number;
              perPage: number;
              createdAfter?: string;
            } = {
              repo: target.repo,
              workflow: target.workflow,
              page: backlogPage,
              perPage: this.#config.pageSize,
            };
            if (backlogCreatedAfter !== undefined) listInput.createdAfter = backlogCreatedAfter;
            const result = await this.#provider.listWorkflowRuns(listInput);
            backlogPagesFetched += 1;
            backlogHasMore = result.hasMore;
            const nextPage = result.nextPage ?? backlogPage + 1;
            if (backlogHasMore && (!Number.isInteger(nextPage) || nextPage <= backlogPage)) throw new CIProviderError("malformed");
            targetFailedDelivery = await processRuns(result.runs);
            if (targetFailedDelivery || !backlogHasMore) break;
            backlogPage = nextPage;
          }
          if (targetFailedDelivery) {
            mutableState.targets[targetKey] = { ...currentTarget, page: backlogPage };
            this.#state.save(withUpdatedAt(mutableState, now));
          } else if (backlogHasMore) {
            targetTruncated = true;
            mutableState.targets[targetKey] = { ...currentTarget, page: backlogPage };
            this.#state.save(withUpdatedAt(mutableState, now));
          } else {
            const cleanTarget = withoutBackoff({ ...currentTarget, cursor: now.toISOString(), page: 1 });
            mutableState.targets[targetKey] = pruneSeen(cleanTarget);
            this.#state.save(withUpdatedAt(mutableState, now));
          }
        } catch (error) {
          const outcome = providerErrorOutcome(error);
          this.#metrics.recordTargetError(outcome);
          errors.push({ repo: target.repo, workflow: target.workflow, outcome });
          const persisted = { ...currentTarget, page: backlogPage };
          mutableState.targets[targetKey] = isProviderBackoffError(error)
            ? withProviderBackoff(persisted, now)
            : persisted;
          this.#state.save(withUpdatedAt(mutableState, now));
          continue;
        }
        if (targetTruncated) truncatedTargets += 1;
      }
      this.#metrics.finishPoll({ targetErrors: errors.length, truncatedTargets, deliveryFailures: pollDeliveryFailures });
      return { skipped: false, observed, delivered, errors, truncatedTargets };
    } finally {
      release();
    }
  }

  async start(): Promise<() => Promise<void>> {
    await this.pollOnce();
    this.#timer = setInterval(() => {
      if (this.#polling) return;
      this.#polling = true;
      void this.pollOnce().finally(() => { this.#polling = false; });
    }, this.#config.pollIntervalMs);
    return async () => {
      if (this.#timer !== undefined) clearInterval(this.#timer);
      this.#timer = undefined;
    };
  }

  health(): { status: "ok" | "degraded"; metrics: ObserverMetricsSnapshot } {
    const metrics = this.#metrics.snapshot();
    return { status: metrics.lastPollDegraded ? "degraded" : "ok", metrics };
  }

  private targetCount(): number { return targets(this.#config).length; }

  private async buildEvent(run: CIWorkflowRun, outcome: ObserverOutcome, now: Date, includeAnalysis: boolean): Promise<ObserverEvent> {
    const warnings: Array<{ code: string; message: string }> = [];
    let analysis: unknown;
    let evidence: unknown[] | undefined;
    let remediation: unknown;
    if (includeAnalysis && isAnalysisConclusion(run.conclusion)) {
      const input = { repo: run.repository, workflow: run.workflow, runId: run.id };
      try {
        const result = await this.#provider.getFailedJobAnalysis(input);
        analysis = {
          failedJobCount: result.data.failedJobs.length,
          categorySummary: result.data.categorySummary,
        };
        evidence = [];
        for (const job of result.data.failedJobs.slice(0, this.#config.maxFailedJobs)) {
          try {
            const log = await this.#provider.getLogEvidence({ ...input, jobId: job.id, maxLines: this.#config.maxLogLines });
            evidence.push({
              jobId: job.id,
              category: job.category,
              redactionsApplied: log.redactionsApplied,
              truncated: log.truncated,
              lineCount: log.data.lines.length,
              sha256: log.data.sha256,
            });
          } catch (error) {
            warnings.push({ code: providerErrorOutcome(error), message: "Job evidence unavailable" });
          }
        }
      } catch (error) {
        warnings.push({ code: providerErrorOutcome(error), message: "Failure analysis unavailable" });
      }
      try {
        const plan = (await this.#provider.getRemediationPlan(input)).data;
        remediation = {
          dryRun: true,
          actionCount: plan.actions.length,
          actions: plan.actions.map((action) => ({
            category: action.category,
            runbook: action.runbook,
          })),
        };
      } catch (error) {
        warnings.push({ code: providerErrorOutcome(error), message: "Remediation plan unavailable" });
      }
    }
    return {
      schemaVersion: "1.0",
      type: "ci.run.observed",
      eventId: observerEventId(run),
      observedAt: now.toISOString(),
      repo: run.repository,
      workflow: run.workflow,
      runId: run.id,
      runAttempt: run.runAttempt,
      terminalConclusion: run.conclusion,
      outcome,
      freshness: outcome === "stale" ? "stale" : "fresh",
      updatedAt: run.updatedAt,
      ...(analysis === undefined ? {} : { analysis }),
      ...(evidence === undefined ? {} : { evidence }),
      ...(remediation === undefined ? {} : { remediation }),
      warnings,
    };
  }
}

export function createObserverRuntimeFromFiles(options: {
  configPath: string;
  fetch: typeof globalThis.fetch;
  clock?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}): ObserverRuntime {
  const fileConfig = loadObserverConfiguration(options.configPath);
  const hmacKey = readObserverSecretFile(fileConfig.hermes.hmac_key_file);
  const config = observerRuntimeConfig(fileConfig, hmacKey);
  const clock = options.clock ?? (() => new Date());
  const tokenProvider = MappedGitHubAppTokenProvider.fromFiles({
    appIdFile: fileConfig.github.app_id_file,
    pemKeyFile: fileConfig.github.pem_key_file,
    installations: fileConfig.github.installations.map((entry) => "repo" in entry
      ? { repo: entry.repo, installationIdFile: entry.installation_id_file }
      : { owner: entry.owner, installationIdFile: entry.installation_id_file }),
    repositories: fileConfig.allowlist.map((entry) => entry.repo),
    fetch: options.fetch,
    clock,
    apiBaseUrl: fileConfig.github.api_base_url,
    actionsPermission: "read",
  });
  const provider = new GitHubActionsProvider({ tokenProvider, fetch: options.fetch, clock, apiBaseUrl: fileConfig.github.api_base_url });
  const state = new FileObserverStateStore({ filePath: config.stateFile, leaseMs: config.leaseMs, clock });
  const delivery = new HermesDelivery({
    url: config.successUrl ?? config.hermesUrl ?? "",
    ...(config.analysisUrl === undefined ? {} : { analysisUrl: config.analysisUrl }),
    ...(config.trustedHermesHosts === undefined ? {} : { trustedInternalHosts: config.trustedHermesHosts }),
    key: hmacKey,
    fetch: options.fetch,
    clock,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    maxAttempts: config.deliveryAttempts,
    backoffMs: config.deliveryBackoffMs,
    timeoutMs: config.deliveryTimeoutMs,
  });
  return new ObserverRuntime({ config, provider, state, deliver: (body, eventId, route) => delivery.deliver(body, eventId, route), clock });
}

export function observerEventId(run: Pick<CIWorkflowRun, "repository" | "workflow" | "id" | "runAttempt">): string {
  return `${run.repository}:${run.workflow}:${run.id}:${run.runAttempt}`;
}

export function outcomeForRun(run: Pick<CIWorkflowRun, "status" | "conclusion" | "updatedAt">, now: Date, staleAfterMs: number): ObserverOutcome {
  if (run.status !== "completed") return "malformed";
  const updated = Date.parse(run.updatedAt);
  if (!Number.isFinite(updated)) return "malformed";
  if (now.getTime() - updated > staleAfterMs) return "stale";
  switch (run.conclusion) {
    case "success": return "success";
    case "failure": return "failure";
    case "cancelled": return "cancelled";
    case "timed_out": return "timed_out";
    case "action_required": return "action_required";
    case "skipped": return "skipped";
    case "neutral": return "neutral";
    default: return "malformed";
  }
}

export function renderObserverMetrics(snapshot: ObserverMetricsSnapshot): string {
  const lines = [
    `observer_polls_total ${snapshot.polls}`,
    `observer_deliveries_total ${snapshot.deliveries}`,
    `observer_delivery_failures_total ${snapshot.deliveryFailures}`,
    `observer_target_errors_total ${snapshot.targetErrors}`,
    `observer_observations_total ${snapshot.observations}`,
    `observer_targets ${snapshot.targetCount}`,
    `observer_truncated_targets ${snapshot.truncatedTargets}`,
  ];
  for (const outcome of Object.keys(snapshot.outcomes).sort()) lines.push(`observer_outcomes_total{outcome="${outcome}"} ${snapshot.outcomes[outcome as ObserverOutcome]}`);
  return `${lines.join("\n")}\n`;
}

export function createObserverHealthServer(runtime: ObserverRuntime, options: { host: string; port: number }): Server {
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      const health = runtime.health();
      response.writeHead(health.status === "ok" ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: health.status, metrics: health.metrics }));
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(renderObserverMetrics(runtime.metrics.snapshot()));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(options.port, options.host);
  return server;
}

function targets(config: ObserverConfig): Array<{ repo: string; workflow: string }> {
  return config.allowlist.flatMap((entry) => entry.workflows.map((workflow) => ({ repo: entry.repo, workflow })));
}

function targetKeyFor(repo: string, workflow: string): string { return `${repo}\u001f${workflow}`; }

function createdAfterWithOverlap(cursor: string, overlapMs: number): string | undefined {
  const cursorMs = Date.parse(cursor);
  return Number.isFinite(cursorMs) ? new Date(cursorMs - overlapMs).toISOString() : undefined;
}

function isAnalysisConclusion(conclusion: CIWorkflowRun["conclusion"]): boolean {
  return conclusion === "failure" || conclusion === "cancelled" || conclusion === "timed_out" || conclusion === "action_required";
}

function outcomeForProviderError(error: unknown): "unavailable" | "malformed" {
  return error instanceof CIProviderError && error.code === "malformed" || error !== null && typeof error === "object" && (error as { code?: unknown }).code === "malformed" ? "malformed" : "unavailable";
}

const providerErrorOutcome = outcomeForProviderError;

function isProviderBackoffError(error: unknown): boolean {
  if (error instanceof CIProviderError) return error.code === "unavailable";
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown };
  return value.code === "unavailable" || value.code === "rate_limited" || value.code === "too_many_requests" || value.status === 429;
}

function withProviderBackoff(target: ObserverTargetState, now: Date): ObserverTargetState {
  const delay = Math.min(PROVIDER_BACKOFF_MAX_MS, Math.max(PROVIDER_BACKOFF_BASE_MS, (target.backoffMs ?? PROVIDER_BACKOFF_BASE_MS / 2) * 2));
  return {
    ...target,
    backoffMs: delay,
    backoffUntil: new Date(now.getTime() + delay).toISOString(),
  };
}

function withoutBackoff(target: ObserverTargetState): ObserverTargetState {
  const next = { ...target };
  delete next.backoffMs;
  delete next.backoffUntil;
  return next;
}

function serializeObserverEvent(event: ObserverEvent, maxBytes: number): string {
  const redacted = redactMetadata(event) as Record<string, unknown>;
  let body = JSON.stringify(redacted);
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  delete redacted.evidence;
  redacted.warnings = [...(Array.isArray(redacted.warnings) ? redacted.warnings : []), { code: "payload_truncated", message: "Bounded evidence omitted" }];
  body = JSON.stringify(redacted);
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return JSON.stringify({ schemaVersion: "1.0", type: "ci.run.observed", eventId: event.eventId, observedAt: event.observedAt, repo: event.repo, workflow: event.workflow, runId: event.runId, runAttempt: event.runAttempt, terminalConclusion: event.terminalConclusion, outcome: event.outcome, freshness: event.freshness, updatedAt: event.updatedAt, warnings: [{ code: "payload_truncated", message: "Bounded evidence omitted" }] });
}

function deliveryEventId(eventId: string, route: "status" | "analysis"): string {
  return `${eventId}:${route}`;
}

function markSeen(target: ObserverTargetState, eventId: string, record: Pick<ObserverSeenRecord, "outcome" | "observedAt"> & Partial<ObserverSeenRecord>): ObserverTargetState {
  const previous = target.seen[eventId];
  const merged: ObserverSeenRecord = {
    ...previous,
    ...record,
    outcome: record.outcome,
    observedAt: record.observedAt,
    delivery: record.delivery ?? previous?.delivery ?? "pending",
  };
  return { ...target, seen: { ...target.seen, [eventId]: merged } };
}

function pruneSeen(target: ObserverTargetState): ObserverTargetState {
  const entries = Object.entries(target.seen);
  if (entries.length <= 1_000) return target;
  const retained = entries.filter(([, record]) => record.delivery === "pending" || record.analysisDelivery === "pending").concat(entries.filter(([, record]) => record.delivery === "delivered" && record.analysisDelivery !== "pending").slice(-900));
  return { ...target, seen: Object.fromEntries(retained) };
}

function withUpdatedAt(state: ObserverStateDocument, now: Date): ObserverStateDocument {
  return { ...state, updatedAt: now.toISOString() };
}

function cloneState(state: ObserverStateDocument): MutableObserverState {
  return JSON.parse(JSON.stringify(state)) as MutableObserverState;
}

const ObserverRunSchema = z.object({
  id: CIRunIdSchema,
  repository: CIRepositorySchema,
  workflow: CIWorkflowSchema,
  status: z.literal("completed"),
  conclusion: z.enum(["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown"]).nullable(),
  runAttempt: z.number().int().min(1).max(100),
  event: z.string().min(1).max(64),
  ref: z.string().min(1).max(256),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  createdAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith("Z")),
  updatedAt: z.iso.datetime({ offset: true }).refine((value) => value.endsWith("Z")),
}).strict();
