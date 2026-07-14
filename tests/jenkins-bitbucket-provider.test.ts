import { describe, expect, it, vi } from "vitest";
import { BitbucketProvider } from "../src/providers/bitbucket-provider.js";
import { JenkinsProvider } from "../src/providers/jenkins-provider.js";

const NOW = new Date("2026-07-10T00:00:00.000Z");

describe("Jenkins read-only CI adapter", () => {
  it("normalizes status, bounds/redacts console evidence, and never reruns", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 42,
        result: "FAILURE",
        building: false,
        timestamp: Date.parse("2026-07-10T00:00:00Z"),
        duration: 1_000,
        displayName: "main",
        actions: [{ lastBuiltRevision: { SHA1: "a".repeat(40) } }],
      })))
      .mockResolvedValueOnce(new Response("Authorization: Bearer jenkins-secret\ncompile failed\nthird line\n"));
    const adapter = new JenkinsProvider({ baseUrl: "https://jenkins.local", fetch, clock: () => NOW });

    const status = await adapter.getWorkflowStatus({ repo: "academytools/planpal-backend-learner-6", workflow: "planpal-backend", runId: "42" });
    const logs = await adapter.getLogEvidence({ repo: "academytools/planpal-backend-learner-6", workflow: "planpal-backend", runId: "42", jobId: "42", maxLines: 2 });

    expect(status.data.run).toMatchObject({ id: "42", conclusion: "failure", ref: "main", sha: "a".repeat(40) });
    expect(logs.data.lines).toEqual([{ sequence: 1, text: "[REDACTED]" }, { sequence: 2, text: "compile failed" }]);
    expect(logs.redactionsApplied).toBe(true);
    expect(logs.truncated).toBe(true);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ["https://jenkins.local/job/planpal-backend/job/main/42/api/json", "GET"],
      ["https://jenkins.local/job/planpal-backend/job/main/42/consoleText", "GET"],
    ]);
    await expect(adapter.rerunFailedWorkflow({ repo: "academytools/planpal-backend-learner-6", workflow: "planpal-backend", runId: "42" })).rejects.toMatchObject({ code: "permission" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("Bitbucket read-only CI adapter", () => {
  it("normalizes pipeline status, sends Basic auth, and provides bounded PR diff hunks", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        build_number: 7,
        state: { name: "FAILED" },
        created_on: "2026-07-10T00:00:00Z",
        completed_on: "2026-07-10T00:01:00Z",
        target: { ref_name: "main", commit: { hash: "b".repeat(40) } },
      })))
      .mockResolvedValueOnce(new Response("@@ -1,1 +1,1 @@\n-secret\n+safe\n"));
    const adapter = new BitbucketProvider({ baseUrl: "https://bitbucket.example", token: "reader:token-value", fetch, clock: () => NOW });

    const status = await adapter.getWorkflowStatus({ repo: "academytools/planpal-config-6", workflow: "pipeline", runId: "7" });
    const diff = await adapter.getDiffHunks("academytools/planpal-config-6", "12");

    expect(status.data.run).toMatchObject({ id: "7", conclusion: "failure", ref: "main", sha: "b".repeat(40) });
    expect(diff.hunks).toEqual(["@@ -1,1 +1,1 @@\n-secret\n+safe\n"]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: expect.objectContaining({ authorization: `Basic ${Buffer.from("reader:token-value").toString("base64")}` }) });
    expect(String(fetch.mock.calls[1]?.[0])).toBe("https://bitbucket.example/repositories/academytools/planpal-config-6/pullrequests/12/diff");
    await expect(adapter.rerunFailedWorkflow({ repo: "academytools/planpal-config-6", workflow: "pipeline", runId: "7" })).rejects.toMatchObject({ code: "permission" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("normalizes commit and pull-request status without returning provider payloads", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [{ key: "build", state: "SUCCESSFUL", name: "CI", description: "green" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 12, state: "OPEN", title: "Safe change", source: { branch: { name: "feature" } }, destination: { branch: { name: "main" } } })));
    const adapter = new BitbucketProvider({ baseUrl: "https://bitbucket.example", token: "reader:token-value", fetch });
    await expect(adapter.getCommitStatus("academytools/planpal-config-6", "a".repeat(40))).resolves.toEqual([{ key: "build", state: "SUCCESSFUL", name: "CI", description: "green" }]);
    await expect(adapter.getPullRequestStatus("academytools/planpal-config-6", "12")).resolves.toEqual({ id: "12", state: "OPEN", title: "Safe change", source: "feature", destination: "main" });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://bitbucket.example/repositories/academytools/planpal-config-6/commit/" + "a".repeat(40) + "/statuses",
      "https://bitbucket.example/repositories/academytools/planpal-config-6/pullrequests/12",
    ]);
  });

});
