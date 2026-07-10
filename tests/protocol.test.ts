import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createObservabilityServer } from "../src/server/create-server.js";
import { FakeObservabilityProvider } from "../src/providers/fake-provider.js";

const FIXED_NOW = new Date("2026-07-10T00:00:00.000Z");

describe("observability MCP protocol", () => {
  let client: Client;
  let server: ReturnType<typeof createObservabilityServer>;
  let provider: FakeObservabilityProvider;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    provider = new FakeObservabilityProvider(() => FIXED_NOW);
    server = createObservabilityServer({ provider, clock: () => FIXED_NOW });
    client = new Client({ name: "protocol-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("discovers the complete read-only tool surface", async () => {
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "observability.capabilities",
      "observability.health_snapshot",
      "observability.active_alerts",
      "observability.query_metrics",
      "observability.render_panel",
      "observability.render_dashboard",
      "observability.incident_context",
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("returns deterministic structured health evidence", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "observability.health_snapshot",
        arguments: { services: ["api"] },
      }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: "1.0",
      observedAt: FIXED_NOW.toISOString(),
      providerClass: "fake",
      freshness: "fresh",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("returns PNG image content without copying bytes into structured content", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "observability.render_panel",
        arguments: {
          dashboardId: "service-overview",
          panelId: "request-rate",
          from: "2026-07-09T23:00:00.000Z",
          to: FIXED_NOW.toISOString(),
          width: 800,
          height: 450,
        },
      }),
    );

    expect(result.isError).not.toBe(true);
    expect(result.content.some((item) => item.type === "image")).toBe(true);
    const image = result.content.find((item) => item.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect("data" in (result.structuredContent ?? {})).toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      image && "data" in image ? image.data : "missing-image",
    );
  });

  it("rejects unknown input fields before invoking a tool", async () => {
    await expect(
      client.callTool({
        name: "observability.query_metrics",
        arguments: {
          queryTemplate: "request_rate",
          url: "https://not-allowed.example",
        },
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("does not echo rejected secret-like input", async () => {
    const secretSentinel = "Bearer goal10-secret-sentinel";
    const result = await client.callTool({
      name: "observability.query_metrics",
      arguments: {
        queryTemplate: "request_rate",
        authorization: secretSentinel,
      },
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).not.toContain(secretSentinel);
  });

  it.each(["throw", "malformed"] as const)(
    "sanitizes %s provider failures",
    async (failureMode) => {
      const secretSentinel = `goal10-provider-${failureMode}-secret`;
      const method = vi.spyOn(provider, "healthSnapshot");
      if (failureMode === "throw") {
        method.mockRejectedValue(new Error(secretSentinel));
      } else {
        method.mockResolvedValue({ secret: secretSentinel } as never);
      }

      const result = await client.callTool({
        name: "observability.health_snapshot",
        arguments: { services: ["api"] },
      });

      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain(secretSentinel);
      expect(JSON.stringify(result)).toContain("provider_unavailable");
    },
  );

  it("executes every remaining tool with schema-valid structured evidence", async () => {
    const calls = [
      { name: "observability.capabilities", arguments: {} },
      { name: "observability.active_alerts", arguments: { services: ["api"] } },
      {
        name: "observability.query_metrics",
        arguments: {
          queryTemplate: "request_rate",
          from: "2026-07-09T23:00:00.000Z",
          to: FIXED_NOW.toISOString(),
          stepMs: 60_000,
        },
      },
      {
        name: "observability.render_dashboard",
        arguments: {
          dashboardId: "service-overview",
          from: "2026-07-09T23:00:00.000Z",
          to: FIXED_NOW.toISOString(),
          width: 800,
          height: 600,
        },
      },
      {
        name: "observability.incident_context",
        arguments: { alertId: "api-latency-high", includeVisuals: "panels" },
      },
    ] as const;

    for (const call of calls) {
      const result = CallToolResultSchema.parse(await client.callTool(call));
      expect(result.isError, call.name).not.toBe(true);
      expect(result.structuredContent, call.name).toMatchObject({
        schemaVersion: "1.0",
        providerClass: "fake",
      });
    }
  });

  it("rejects out-of-policy visual dimensions", async () => {
    await expect(
      client.callTool({
        name: "observability.render_panel",
        arguments: {
          dashboardId: "service-overview",
          panelId: "request-rate",
          from: "2026-07-09T23:00:00.000Z",
          to: FIXED_NOW.toISOString(),
          width: 1601,
          height: 450,
        },
      }),
    ).resolves.toMatchObject({ isError: true });
  });
});
