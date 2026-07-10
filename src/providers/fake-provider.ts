import {
  ActiveAlertsInputSchema,
  ActiveAlertsResultSchema,
  CapabilitiesInputSchema,
  CapabilitiesResultSchema,
  HealthSnapshotInputSchema,
  HealthSnapshotResultSchema,
  IncidentContextInputSchema,
  IncidentContextResultSchema,
  QueryMetricsInputSchema,
  QueryMetricsResultSchema,
  SCHEMA_VERSION,
  type ActiveAlertsInput,
  type ActiveAlertsResult,
  type CapabilitiesInput,
  type CapabilitiesResult,
  type HealthSnapshotInput,
  type HealthSnapshotResult,
  type IncidentContextInput,
  type IncidentContextResult,
  type QueryMetricsInput,
  type QueryMetricsResult,
} from "../domain/tool-schemas.js";
import type { Clock, ObservabilityProvider } from "./observability-provider.js";

const ALERT_STARTED_AT = "2026-07-09T23:30:00.000Z";

export class FakeObservabilityProvider implements ObservabilityProvider {
  constructor(private readonly clock: Clock = () => new Date()) {}

  async capabilities(input: CapabilitiesInput): Promise<CapabilitiesResult> {
    CapabilitiesInputSchema.parse(input);
    return CapabilitiesResultSchema.parse({
      ...this.evidenceFields(),
      data: {
        providerClasses: ["fake"],
        enabledTools: [
          "observability.capabilities",
          "observability.health_snapshot",
          "observability.active_alerts",
          "observability.query_metrics",
          "observability.render_panel",
          "observability.render_dashboard",
          "observability.incident_context",
        ],
        limits: {
          maxServices: 25,
          maxAlerts: 100,
          maxSeries: 50,
          maxRenderWidth: 2400,
          maxRenderHeight: 4000,
        },
        featureFlags: ["named-query-templates", "incident-context", "synthetic-visuals"],
      },
    });
  }

  async healthSnapshot(input: HealthSnapshotInput): Promise<HealthSnapshotResult> {
    const request = HealthSnapshotInputSchema.parse(input);
    const checkedAt = this.now();
    return HealthSnapshotResultSchema.parse({
      ...this.evidenceFields(checkedAt),
      data: {
        targets: request.services.map((serviceId) => this.healthTarget(serviceId, checkedAt)),
      },
    });
  }

  async activeAlerts(input: ActiveAlertsInput): Promise<ActiveAlertsResult> {
    const request = ActiveAlertsInputSchema.parse(input);
    const alerts = [this.alert()].filter((alert) => {
      const matchesService = request.services === undefined || request.services.includes(alert.serviceId);
      const matchesState = request.states === undefined || request.states.includes(alert.state);
      const matchesSeverity = request.severities === undefined || request.severities.includes(alert.severity);
      return matchesService && matchesState && matchesSeverity;
    });

    return ActiveAlertsResultSchema.parse({
      ...this.evidenceFields(),
      data: { alerts },
    });
  }

  async queryMetrics(input: QueryMetricsInput): Promise<QueryMetricsResult> {
    const request = QueryMetricsInputSchema.parse(input);
    const now = this.now();
    const isRange = request.from !== undefined;
    const timestamps = isRange
      ? [request.from as string, midpoint(request.from as string, request.to as string), request.to as string]
      : [request.at ?? now];

    const result = {
      ...this.evidenceFields(now),
      data: {
        queryTemplate: request.queryTemplate,
        queryKind: isRange ? "range" : "instant",
        ...(isRange
          ? { from: request.from, to: request.to, stepMs: request.stepMs }
          : {}),
        series: [
          {
            name: "request_rate",
            labels: { service: "api", environment: "test" },
            samples: timestamps.map((timestamp, index) => ({
              timestamp,
              value: 42 + index,
            })),
          },
        ],
      },
    };
    return QueryMetricsResultSchema.parse(result);
  }

  async incidentContext(input: IncidentContextInput): Promise<IncidentContextResult> {
    const request = IncidentContextInputSchema.parse(input);
    const observedAt = this.now();
    const serviceId = request.serviceId ?? "api";
    const warnings =
      request.includeVisuals === "none"
        ? []
        : [{ code: "visuals-unavailable", message: "Fake provider does not render visual evidence" }];

    return IncidentContextResultSchema.parse({
      ...this.evidenceFields(observedAt, warnings),
      data: {
        subject:
          request.alertId === undefined
            ? { serviceId }
            : { alertId: request.alertId, serviceId },
        health: [this.healthTarget(serviceId, observedAt)],
        alerts: request.alertId === undefined ? [] : [this.alert(request.alertId, serviceId)],
        dashboardRefs: [{ dashboardId: "service-overview", title: "Service overview" }],
        visuals: {
          requested: request.includeVisuals,
          available: false,
        },
      },
    });
  }

  private evidenceFields(observedAt = this.now(), warnings: Array<{ code: string; message: string }> = []) {
    return {
      schemaVersion: SCHEMA_VERSION,
      observedAt,
      providerClass: "fake" as const,
      freshness: "fresh" as const,
      truncated: false,
      redactionsApplied: false,
      warnings,
    };
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private healthTarget(serviceId: string, checkedAt: string) {
    if (serviceId === "api") {
      return { serviceId, status: "healthy" as const, summary: "API is responding normally", checkedAt };
    }
    if (serviceId === "worker") {
      return { serviceId, status: "degraded" as const, summary: "Worker queue latency is elevated", checkedAt };
    }
    return { serviceId, status: "unknown" as const, summary: "No fake data is configured for this service", checkedAt };
  }

  private alert(alertId = "api-latency-high", serviceId = "api") {
    return {
      alertId,
      name: "API latency high",
      state: "firing" as const,
      severity: "warning" as const,
      startsAt: ALERT_STARTED_AT,
      serviceId,
      annotations: {
        summary: "API latency is above the configured threshold",
        description: "The API latency percentile exceeded its test threshold",
        runbookRef: "api-latency-runbook",
      },
    };
  }
}

function midpoint(from: string, to: string): string {
  return new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString();
}
