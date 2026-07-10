import type {
  ActiveAlertsInput,
  ActiveAlertsResult,
  CapabilitiesInput,
  CapabilitiesResult,
  HealthSnapshotInput,
  HealthSnapshotResult,
  IncidentContextInput,
  IncidentContextResult,
  QueryMetricsInput,
  QueryMetricsResult,
} from "../domain/tool-schemas.js";

export interface ObservabilityProvider {
  capabilities(input: CapabilitiesInput): Promise<CapabilitiesResult>;
  healthSnapshot(input: HealthSnapshotInput): Promise<HealthSnapshotResult>;
  activeAlerts(input: ActiveAlertsInput): Promise<ActiveAlertsResult>;
  queryMetrics(input: QueryMetricsInput): Promise<QueryMetricsResult>;
  incidentContext(input: IncidentContextInput): Promise<IncidentContextResult>;
}

export type Clock = () => Date;
