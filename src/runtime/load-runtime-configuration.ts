import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { LogicalIdSchema } from "../domain/tool-schemas.js";
import type { VisualAllowlist } from "../domain/visual-policy.js";
import { GrafanaVisualProvider } from "../providers/grafana-visual-provider.js";
import type {
  Clock,
  ObservabilityProvider,
  ObservabilityVisualProvider,
} from "../providers/observability-provider.js";
import { VictoriaMetricsProvider } from "../providers/victoriametrics-provider.js";
import { JenkinsProvider } from "../providers/jenkins-provider.js";
import { BitbucketProvider } from "../providers/bitbucket-provider.js";
import { CIRepositorySchema, CIWorkflowSchema } from "../domain/ci-schemas.js";
import { ApprovalTokenService, FileApprovalAuditStore } from "../ci/approval.js";
import { createCIAllowlist } from "../ci/policy.js";
import type { CIService } from "../ci/service.js";
import { GitHubActionsProvider } from "../providers/github-actions-provider.js";
import { GitHubAppTokenProvider } from "../providers/github-app-token-provider.js";
import { MappedGitHubAppTokenProvider } from "../providers/mapped-github-app-token-provider.js";

const MAX_CONFIG_BYTES = 256 * 1_024;

export const RUNTIME_PROFILES = ["observability-only", "ci-only", "combined"] as const;
export type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

const HttpProviderSchema = z
  .object({
    type: z.string().min(1).max(64),
    base_url: z.url(),
  })
  .strict();

const QuerySchema = z
  .object({
    expression: z.string().min(1).max(4_096),
    label_keys: z.array(LogicalIdSchema).max(20).default([]),
  })
  .strict();

const NumericMatchSchema = z
  .object({
    operator: z.enum(["eq", "gt", "gte", "lt", "lte"]),
    value: z.number().finite(),
  })
  .strict();

const ServiceHealthSchema = z
  .object({
    query_template: LogicalIdSchema,
    healthy_when: NumericMatchSchema,
    degraded_when: NumericMatchSchema.optional(),
    summary: z.string().min(1).max(512).refine((value) => !/[<>]/.test(value)),
  })
  .strict();

const DashboardSchema = z
  .object({
    uid: LogicalIdSchema,
    slug: LogicalIdSchema,
    title: z.string().min(1).max(256).refine((value) => !/[<>]/.test(value)),
    panels: z
      .record(
        LogicalIdSchema,
        z.object({ id: z.number().int().min(1).max(999_999_999) }).strict(),
      )
      .refine((panels) => Object.keys(panels).length <= 50),
  })
  .strict();

const CIAllowlistEntrySchema = z
  .object({ repo: CIRepositorySchema, workflows: z.array(CIWorkflowSchema).min(1).max(50) })
  .strict();
const GitHubInstallationSchema = z.union([
  z.object({ repo: CIRepositorySchema, installation_id_file: z.string().min(1).max(1_024) }).strict(),
  z.object({ owner: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/), installation_id_file: z.string().min(1).max(1_024) }).strict(),
]);
const GitHubAppSchema = z
  .object({
    app_id_file: z.string().min(1).max(1_024),
    installation_id_file: z.string().min(1).max(1_024).optional(),
    installations: z.array(GitHubInstallationSchema).min(1).max(100).optional(),
    pem_key_file: z.string().min(1).max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.installation_id_file === undefined) === (value.installations === undefined)) {
      context.addIssue({ code: "custom", path: ["installations"], message: "configure one installation mode" });
    }
  });
const CIConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["github", "jenkins", "bitbucket"]).default("github"),
    allowlist: z.array(CIAllowlistEntrySchema).max(100).default([]),
    github: z
      .object({
        api_base_url: z.literal("https://api.github.com").default("https://api.github.com"),
        app: GitHubAppSchema.optional(),
      })
      .strict()
      .optional(),
    jenkins: z
      .object({ base_url: z.url() })
      .strict()
      .optional(),
    bitbucket: z
      .object({ base_url: z.url(), token_file: z.string().min(1).max(1_024), username: z.string().min(1).max(256).optional() })
      .strict()
      .optional(),
    approval: z
      .object({
        key_file: z.string().min(1).max(1_024),
        replay_file: z.string().min(1).max(1_024),
        audit_file: z.string().min(1).max(1_024),
      })
      .strict()
      .optional(),
    max_freshness_seconds: z.number().int().min(1).max(3_600).default(300),
  })
  .strict();

const ObservabilityProvidersSchema = z
  .object({
    metrics: HttpProviderSchema.extend({ type: z.literal("prometheus-compatible") }).strict(),
    alerts: HttpProviderSchema.extend({ type: z.enum(["vmalert", "grafana-alertmanager"]) }).strict(),
    grafana: HttpProviderSchema.extend({ type: z.literal("grafana") }).strict(),
  })
  .strict();

const ObservabilityPolicySchema = z
  .object({
    named_queries: z.record(LogicalIdSchema, QuerySchema),
    service_health: z.record(LogicalIdSchema, ServiceHealthSchema),
    dashboards: z.record(LogicalIdSchema, DashboardSchema),
  })
  .strict();

export const RuntimeConfigSchema = z
  .object({
    version: z.literal(1),
    profile: z.enum(RUNTIME_PROFILES),
    providers: ObservabilityProvidersSchema.optional(),
    policy: ObservabilityPolicySchema.optional(),
    ci: CIConfigSchema.optional(),
  })
  .strict()
  .superRefine((configuration, context) => {
    const needsObservability = configuration.profile !== "ci-only";
    if (needsObservability && (configuration.providers === undefined || configuration.policy === undefined)) {
      context.addIssue({ code: "custom", path: ["providers"], message: "observability configuration is required for this profile" });
    }
    if (configuration.profile === "observability-only" && configuration.ci?.enabled === true) {
      context.addIssue({ code: "custom", path: ["ci"], message: "CI requires the combined profile" });
    }
    if ((configuration.profile === "ci-only" || configuration.profile === "combined") && configuration.ci?.enabled !== true) {
      context.addIssue({ code: "custom", path: ["ci"], message: "enabled CI configuration is required for this profile" });
    }
    if (configuration.policy !== undefined) {
      for (const [serviceId, health] of Object.entries(configuration.policy.service_health)) {
        if (configuration.policy.named_queries[health.query_template] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["policy", "service_health", serviceId, "query_template"],
            message: "must reference a named query",
          });
        }
      }
    }
  });

export type RuntimeConfiguration = z.infer<typeof RuntimeConfigSchema>;

export function parseRuntimeConfiguration(document: string): RuntimeConfiguration {
  let raw: unknown;
  try {
    raw = parseYaml(document);
  } catch {
    throw new Error("Invalid runtime configuration");
  }
  const parsed = RuntimeConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid runtime configuration");
  }
  return parsed.data;
}

export interface LoadRuntimeConfigurationOptions {
  readonly configPath: string;
  readonly grafanaTokenPath?: string;
  readonly mcpTokenPath: string;
  readonly fetch: typeof globalThis.fetch;
  readonly clock?: Clock;
}

export class LoadedRuntimeConfiguration {
  readonly #bearerToken: string;

  constructor(
    public readonly profile: RuntimeProfile,
    public readonly provider: ObservabilityProvider | undefined,
    public readonly visualProvider: ObservabilityVisualProvider | undefined,
    public readonly visualAllowlist: VisualAllowlist | undefined,
    bearerToken: string,
    public readonly ci: CIService | undefined = undefined,
  ) {
    this.#bearerToken = bearerToken;
  }

  get bearerToken(): string {
    return this.#bearerToken;
  }
}

export function loadRuntimeConfiguration(
  options: LoadRuntimeConfigurationOptions,
): LoadedRuntimeConfiguration {
  const document = readBoundedFile(options.configPath, false);
  const bearerToken = readBoundedFile(options.mcpTokenPath, true).trim();
  if (bearerToken.length < 16) {
    throw new Error("Runtime secret is missing or too short");
  }

  const configuration = parseRuntimeConfiguration(document);

  let provider: ObservabilityProvider | undefined;
  let visualProvider: ObservabilityVisualProvider | undefined;
  let visualAllowlist: VisualAllowlist | undefined;
  if (configuration.profile !== "ci-only") {
    const providers = configuration.providers;
    const policy = configuration.policy;
    if (providers === undefined || policy === undefined) throw new Error("Invalid runtime configuration");
    const grafanaToken = options.grafanaTokenPath === undefined
      ? ""
      : readBoundedFile(options.grafanaTokenPath, true).trim();
    if (grafanaToken.length < 16) throw new Error("Runtime secret is missing or too short");
    const queryTemplates = Object.fromEntries(
      Object.entries(policy.named_queries).map(([name, query]) => [
        name,
        { expression: query.expression, labelKeys: query.label_keys },
      ]),
    );
    const serviceHealth = Object.fromEntries(
      Object.entries(policy.service_health).map(([name, health]) => [
        name,
        {
          queryTemplate: health.query_template,
          healthyWhen: health.healthy_when,
          ...(health.degraded_when === undefined ? {} : { degradedWhen: health.degraded_when }),
          summary: health.summary,
        },
      ]),
    );
    provider = new VictoriaMetricsProvider({
      baseUrl: providers.metrics.base_url,
      alertsBaseUrl: providers.alerts.base_url,
      alertsProvider: providers.alerts.type,
      fetch: options.fetch,
      queryTemplates,
      serviceHealth,
      visualsEnabled: true,
      dashboardRefs: Object.entries(policy.dashboards).map(
        ([dashboardId, dashboard]) => ({ dashboardId, title: dashboard.title }),
      ),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });

    const panels: Record<string, string> = {};
    const dashboards: Record<string, string> = {};
    const allowlistDashboards: Record<string, { panels: string[] }> = {};
    for (const [dashboardId, dashboard] of Object.entries(policy.dashboards)) {
      const basePath = `${encodeURIComponent(dashboard.uid)}/${encodeURIComponent(dashboard.slug)}`;
      dashboards[dashboardId] = `/render/d/${basePath}`;
      allowlistDashboards[dashboardId] = { panels: Object.keys(dashboard.panels) };
      for (const [panelId, panel] of Object.entries(dashboard.panels)) {
        panels[`${dashboardId}:${panelId}`] = `/render/d-solo/${basePath}?panelId=${String(panel.id)}`;
      }
    }
    visualAllowlist = { dashboards: allowlistDashboards };
    visualProvider = new GrafanaVisualProvider({
      baseUrl: providers.grafana.base_url,
      token: grafanaToken,
      fetch: options.fetch,
      panels,
      dashboards,
    });
  }

  const ci = buildCIConfiguration(configuration.ci, options);

  return new LoadedRuntimeConfiguration(
    configuration.profile,
    provider,
    visualProvider,
    visualAllowlist,
    bearerToken,
    ci,
  );
}

function buildCIConfiguration(
  configuration: z.infer<typeof CIConfigSchema> | undefined,
  options: LoadRuntimeConfigurationOptions,
): CIService | undefined {
  if (configuration?.enabled !== true) return undefined;
  if (configuration.allowlist.length === 0 || configuration.approval === undefined) {
    throw new Error("Invalid CI runtime configuration");
  }
  const repositories = configuration.allowlist.map((entry) => entry.repo);
  const clock = options.clock ?? (() => new Date());
  const provider = configuration.provider === "jenkins"
    ? configuration.jenkins === undefined
      ? (() => { throw new Error("Invalid CI runtime configuration"); })()
      : new JenkinsProvider({
          baseUrl: configuration.jenkins.base_url,
          fetch: options.fetch,
          ...(options.clock === undefined ? {} : { clock }),
          maxFreshnessMs: configuration.max_freshness_seconds * 1_000,
        })
    : configuration.provider === "bitbucket"
      ? configuration.bitbucket === undefined
        ? (() => { throw new Error("Invalid CI runtime configuration"); })()
        : new BitbucketProvider({
            baseUrl: configuration.bitbucket.base_url,
            tokenFile: configuration.bitbucket.token_file,
            ...(configuration.bitbucket.username === undefined ? {} : { username: configuration.bitbucket.username }),
            fetch: options.fetch,
            ...(options.clock === undefined ? {} : { clock }),
            maxFreshnessMs: configuration.max_freshness_seconds * 1_000,
          })
      : buildGitHubProvider(configuration, repositories, options, clock);
  const key = ApprovalTokenService.readKeyFile(configuration.approval.key_file);
  const audit = new FileApprovalAuditStore({
    replayPath: configuration.approval.replay_file,
    auditPath: configuration.approval.audit_file,
  });
  return {
    provider,
    policy: createCIAllowlist(Object.fromEntries(configuration.allowlist.map((entry) => [entry.repo, entry.workflows]))),
    approval: new ApprovalTokenService({ key, clock, audit }),
  };
}

function buildGitHubProvider(
  configuration: z.infer<typeof CIConfigSchema>,
  repositories: readonly string[],
  options: LoadRuntimeConfigurationOptions,
  clock: Clock,
): GitHubActionsProvider {
  if (configuration.github === undefined) throw new Error("Invalid CI runtime configuration");
  const app = configuration.github.app;
  const readTokenProvider = app === undefined
    ? undefined
    : app.installations !== undefined
      ? MappedGitHubAppTokenProvider.fromFiles({
          appIdFile: app.app_id_file,
          pemKeyFile: app.pem_key_file,
          installations: app.installations.map((entry) => "repo" in entry
            ? { repo: entry.repo, installationIdFile: entry.installation_id_file }
            : { owner: entry.owner, installationIdFile: entry.installation_id_file }),
          repositories,
          fetch: options.fetch,
          clock,
          apiBaseUrl: configuration.github.api_base_url,
          actionsPermission: "read",
        })
      : GitHubAppTokenProvider.fromPemFile({
          appId: readNumericSecretFile(app.app_id_file),
          installationId: readNumericSecretFile(app.installation_id_file ?? ""),
          pemKeyFile: app.pem_key_file,
          allowedRepositories: repositories,
          fetch: options.fetch,
          clock,
          apiBaseUrl: configuration.github.api_base_url,
          actionsPermission: "read",
        });
  const writeTokenProvider = app === undefined
    ? undefined
    : app.installations !== undefined
      ? MappedGitHubAppTokenProvider.fromFiles({
          appIdFile: app.app_id_file,
          pemKeyFile: app.pem_key_file,
          installations: app.installations.map((entry) => "repo" in entry
            ? { repo: entry.repo, installationIdFile: entry.installation_id_file }
            : { owner: entry.owner, installationIdFile: entry.installation_id_file }),
          repositories,
          fetch: options.fetch,
          clock,
          apiBaseUrl: configuration.github.api_base_url,
          actionsPermission: "write",
        })
      : GitHubAppTokenProvider.fromPemFile({
          appId: readNumericSecretFile(app.app_id_file),
          installationId: readNumericSecretFile(app.installation_id_file ?? ""),
          pemKeyFile: app.pem_key_file,
          allowedRepositories: repositories,
          fetch: options.fetch,
          clock,
          apiBaseUrl: configuration.github.api_base_url,
          actionsPermission: "write",
        });
  if (readTokenProvider === undefined || writeTokenProvider === undefined) throw new Error("CI runtime configuration requires a GitHub App or token file");
  return new GitHubActionsProvider({
    tokenProvider: readTokenProvider,
    writeTokenProvider,
    fetch: options.fetch,
    ...(options.clock === undefined ? {} : { clock }),
    apiBaseUrl: configuration.github.api_base_url,
    maxFreshnessMs: configuration.max_freshness_seconds * 1_000,
  });
}

function readNumericSecretFile(path: string): string {
  const value = readBoundedFile(path, true).trim();
  if (!/^\d+$/.test(value)) throw new Error("Invalid CI runtime configuration");
  return value;
}

function readBoundedFile(path: string, secret: boolean): string {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error(secret ? "Invalid secret file" : "Invalid runtime configuration");
  }
  if (secret && (metadata.mode & 0o077) !== 0) {
    throw new Error("Secret file permissions are too broad");
  }
  return readFileSync(path, "utf8");
}
