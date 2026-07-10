import { describe, expect, it } from "vitest";
import {
  ActiveAlertsInputSchema,
  ActiveAlertsResultSchema,
  CapabilitiesInputSchema,
  HealthSnapshotInputSchema,
  IncidentContextInputSchema,
  LogicalIdSchema,
  QueryMetricsInputSchema,
  RenderDashboardInputSchema,
  RenderPanelInputSchema,
} from "../src/domain/tool-schemas.js";
import { FakeObservabilityProvider } from "../src/providers/fake-provider.js";

const FIXED_NOW = new Date("2026-07-10T00:00:00.000Z");
const RANGE = {
  from: "2026-07-09T23:00:00.000Z",
  to: "2026-07-10T00:00:00.000Z",
};

describe("domain tool schemas", () => {
  it("rejects unknown keys and URL-like values at the boundary", () => {
    expect(CapabilitiesInputSchema.safeParse({ providerUrl: "https://attacker.invalid" }).success).toBe(false);
    expect(HealthSnapshotInputSchema.safeParse({ services: ["api"], url: "https://attacker.invalid" }).success).toBe(false);
    expect(ActiveAlertsInputSchema.safeParse({ url: "https://attacker.invalid" }).success).toBe(false);
    expect(QueryMetricsInputSchema.safeParse({ queryTemplate: "request-rate", url: "https://attacker.invalid" }).success).toBe(false);
    expect(LogicalIdSchema.safeParse("https://attacker.invalid").success).toBe(false);
    expect(IncidentContextInputSchema.safeParse({ serviceId: "api", includeVisuals: "none", renderUrl: "file:///etc/passwd" }).success).toBe(false);
    expect(RenderPanelInputSchema.safeParse({ dashboardId: "service-overview", panelId: "request-rate", ...RANGE, datasource: "private" }).success).toBe(false);
    expect(RenderDashboardInputSchema.safeParse({ dashboardId: "service-overview", ...RANGE, url: "https://attacker.invalid" }).success).toBe(false);
  });

  it("enforces service, query, and visual bounds", () => {
    expect(HealthSnapshotInputSchema.safeParse({ services: Array.from({ length: 26 }, (_, index) => `service-${index}`) }).success).toBe(false);
    expect(QueryMetricsInputSchema.safeParse({ queryTemplate: "request-rate", ...RANGE, stepMs: 999 }).success).toBe(false);
    expect(
      QueryMetricsInputSchema.safeParse({
        queryTemplate: "request-rate",
        from: "2026-07-08T00:00:00.000Z",
        to: "2026-07-10T00:00:01.000Z",
        stepMs: 60_000,
      }).success,
    ).toBe(false);
    expect(RenderPanelInputSchema.safeParse({ dashboardId: "service-overview", panelId: "request-rate", ...RANGE, width: 1601, height: 900 }).success).toBe(false);
    expect(RenderDashboardInputSchema.safeParse({ dashboardId: "service-overview", ...RANGE, width: 2400, height: 4001 }).success).toBe(false);
  });

  it("requires a single incident subject and safe normalized alert annotations", () => {
    expect(IncidentContextInputSchema.safeParse({ includeVisuals: "none" }).success).toBe(false);
    expect(IncidentContextInputSchema.safeParse({ alertId: "api-alert", serviceId: "api" }).success).toBe(false);
    expect(
      ActiveAlertsResultSchema.safeParse({
        schemaVersion: "1.0",
        observedAt: FIXED_NOW.toISOString(),
        providerClass: "fake",
        freshness: "fresh",
        truncated: false,
        redactionsApplied: false,
        warnings: [],
        data: {
          alerts: [
            {
              alertId: "api-alert",
              name: "API alert",
              state: "firing",
              severity: "warning",
              startsAt: FIXED_NOW.toISOString(),
              serviceId: "api",
              annotations: { runbookRef: "https://untrusted.invalid/runbook" },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

describe("FakeObservabilityProvider", () => {
  it("returns deterministic evidence from the injected clock", async () => {
    const provider = new FakeObservabilityProvider(() => FIXED_NOW);

    await expect(provider.capabilities({})).resolves.toMatchObject({
      schemaVersion: "1.0",
      observedAt: FIXED_NOW.toISOString(),
      providerClass: "fake",
      freshness: "fresh",
      data: { enabledTools: expect.arrayContaining(["observability.health_snapshot"]) },
    });
    await expect(provider.healthSnapshot({ services: ["api", "worker"] })).resolves.toMatchObject({
      observedAt: FIXED_NOW.toISOString(),
      data: {
        targets: [
          { serviceId: "api", status: "healthy" },
          { serviceId: "worker", status: "degraded" },
        ],
      },
    });
    await expect(provider.activeAlerts({ services: ["api"] })).resolves.toMatchObject({
      data: { alerts: [{ alertId: "api-latency-high", serviceId: "api", state: "firing" }] },
    });
  });

  it("returns bounded deterministic metric and incident evidence", async () => {
    const provider = new FakeObservabilityProvider(() => FIXED_NOW);

    await expect(
      provider.queryMetrics({ queryTemplate: "request-rate", ...RANGE, stepMs: 60_000 }),
    ).resolves.toMatchObject({
      data: {
        queryKind: "range",
        series: [{ samples: [{ value: 42 }, { value: 43 }, { value: 44 }] }],
      },
    });
    await expect(provider.incidentContext({ alertId: "api-latency-high", includeVisuals: "panels" })).resolves.toMatchObject({
      warnings: [{ code: "visuals-unavailable" }],
      data: {
        subject: { alertId: "api-latency-high", serviceId: "api" },
        visuals: { requested: "panels", available: false },
      },
    });
  });

  it("validates direct provider calls before producing evidence", async () => {
    const provider = new FakeObservabilityProvider(() => FIXED_NOW);
    await expect(
      provider.queryMetrics({ queryTemplate: "request-rate", url: "https://attacker.invalid" } as never),
    ).rejects.toThrow();
  });
});
