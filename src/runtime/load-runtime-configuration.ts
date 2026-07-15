import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { LogicalIdSchema } from "../domain/tool-schemas.js";
import { CIProviderEndpointSchema, CIProviderNameSchema } from "../domain/ci-provider-contracts.js";
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
import type { CIProviderRuntimeMetadata, CIService, CIProviderType } from "../ci/service.js";
import { GitHubActionsProvider } from "../providers/github-actions-provider.js";
import { GitHubAppTokenProvider } from "../providers/github-app-token-provider.js";
import { MappedGitHubAppTokenProvider } from "../providers/mapped-github-app-token-provider.js";
import { CIProviderRegistry } from "../providers/ci-provider-registry.js";
import { READ_ONLY_CI_PROVIDER_CAPABILITIES, APPROVAL_GATED_CI_PROVIDER_CAPABILITIES } from "../domain/ci-provider-contracts.js";

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
const CIProviderTypeSchema = z.enum(["github", "jenkins", "bitbucket"]);
const CIProviderBaseUrlSchema = z.string().min(1).max(2_048).url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}, "must be an HTTP(S) base URL without credentials, query, or fragment");
const JenkinsConfigSchema = z
  .object({ base_url: CIProviderBaseUrlSchema.optional(), endpoint: CIProviderEndpointSchema.optional(), allow_insecure_http: z.boolean().default(false) })
  .strict()
  .superRefine((value, context) => {
    if ((value.base_url === undefined) === (value.endpoint === undefined)) {
      context.addIssue({ code: "custom", path: ["endpoint"], message: "configure exactly one base_url or endpoint" });
      return;
    }
    const url = new URL(value.endpoint?.origin ?? value.base_url as string);
    if (url.protocol === "http:" && (value.allow_insecure_http !== true || !["127.0.0.1", "::1"].includes(url.hostname.toLowerCase().replace(/^\[|\]$/g, "")))) {
      context.addIssue({ code: "custom", path: ["base_url"], message: "cleartext HTTP requires explicit loopback opt-in" });
    }
  });
const BitbucketConfigSchema = z
  .object({ base_url: CIProviderBaseUrlSchema.optional(), endpoint: CIProviderEndpointSchema.optional(), token_file: z.string().min(1).max(1_024), username: z.string().min(1).max(256).optional() })
  .strict()
  .superRefine((value, context) => {
    if ((value.base_url === undefined) === (value.endpoint === undefined)) {
      context.addIssue({ code: "custom", path: ["endpoint"], message: "configure exactly one base_url or endpoint" });
      return;
    }
    if (new URL(value.endpoint?.origin ?? value.base_url as string).protocol !== "https:") context.addIssue({ code: "custom", path: ["base_url"], message: "Bitbucket credentials require HTTPS" });
  });
const GitHubConfigSchema = z
  .object({
    api_base_url: CIProviderBaseUrlSchema.optional(),
    api_endpoint: CIProviderEndpointSchema.optional(),
    app: GitHubAppSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.api_base_url !== undefined && value.api_endpoint !== undefined) {
      context.addIssue({ code: "custom", path: ["api_endpoint"], message: "configure exactly one api_base_url or api_endpoint" });
    }
    const origin = value.api_endpoint?.origin ?? value.api_base_url;
    if (origin !== undefined) {
      const url = new URL(origin);
      if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port !== "") {
        context.addIssue({ code: "custom", path: ["api_base_url"], message: "GitHub API base URL is not trusted" });
      }
    }
  });
const NamedCIProviderSchema = z
  .object({
    type: CIProviderTypeSchema,
    github: GitHubConfigSchema.optional(),
    jenkins: JenkinsConfigSchema.optional(),
    bitbucket: BitbucketConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const configured = value.type === "github" ? value.github : value.type === "jenkins" ? value.jenkins : value.bitbucket;
    if (configured === undefined) context.addIssue({ code: "custom", path: [value.type], message: "provider configuration is required" });
  });
const CIConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: CIProviderTypeSchema.default("github"),
    provider_name: CIProviderNameSchema.optional(),
    providers: z.record(CIProviderNameSchema, NamedCIProviderSchema).refine((providers) => Object.keys(providers).length <= 20).optional(),
    allowlist: z.array(CIAllowlistEntrySchema).max(100).default([]),
    github: GitHubConfigSchema.optional(),
    jenkins: JenkinsConfigSchema.optional(),
    bitbucket: BitbucketConfigSchema.optional(),
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
    if (configuration.ci?.providers !== undefined) {
      if (configuration.ci.provider_name === undefined) {
        context.addIssue({ code: "custom", path: ["ci", "provider_name"], message: "named provider selection is required" });
      } else if (configuration.ci.providers[configuration.ci.provider_name] === undefined) {
        context.addIssue({ code: "custom", path: ["ci", "provider_name"], message: "selected provider is not configured" });
      }
    } else if (configuration.ci?.provider_name !== undefined) {
      context.addIssue({ code: "custom", path: ["ci", "provider_name"], message: "named providers are not configured" });
    }
    if (configuration.ci?.enabled === true) {
      const ci = configuration.ci;
      const selected = ci.providers === undefined || ci.provider_name === undefined
        ? { type: ci.provider, github: ci.github, jenkins: ci.jenkins, bitbucket: ci.bitbucket }
        : ci.providers[ci.provider_name];
      if (selected !== undefined) {
        const providerConfig = selected.type === "github" ? selected.github : selected.type === "jenkins" ? selected.jenkins : selected.bitbucket;
        if (providerConfig === undefined) {
          context.addIssue({ code: "custom", path: ["ci", selected.type], message: "selected provider configuration is required" });
        }
        if (selected.type === "github") {
          if (selected.github?.app === undefined) context.addIssue({ code: "custom", path: ["ci", "github", "app"], message: "GitHub App configuration is required" });
          if (ci.approval === undefined) context.addIssue({ code: "custom", path: ["ci", "approval"], message: "approval configuration is required for rerun capability" });
        }
      }
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

export interface RuntimeProviderMetadata {
  readonly observability?: {
    readonly metrics: string;
    readonly alerts: string;
    readonly grafana: string;
  };
  readonly ci?: CIProviderRuntimeMetadata;
}

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

export function runtimeProviderMetadata(configuration: RuntimeConfiguration): RuntimeProviderMetadata {
  const observability = configuration.providers === undefined
    ? undefined
    : {
        metrics: configuration.providers.metrics.type,
        alerts: configuration.providers.alerts.type,
        grafana: configuration.providers.grafana.type,
      };
  const ci = configuration.ci?.enabled === true ? resolveCIProvider(configuration.ci).metadata : undefined;
  return {
    ...(observability === undefined ? {} : { observability }),
    ...(ci === undefined ? {} : { ci }),
  };
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
    public readonly runtimeMetadata: RuntimeProviderMetadata = {},
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
  const runtimeMetadata = runtimeProviderMetadata(configuration);

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
    runtimeMetadata,
  );
}

type CIConfiguration = z.infer<typeof CIConfigSchema>;

interface ResolvedCIProviderConfiguration {
  readonly name: string;
  readonly type: CIProviderType;
  readonly github?: CIConfiguration["github"];
  readonly jenkins?: CIConfiguration["jenkins"];
  readonly bitbucket?: CIConfiguration["bitbucket"];
}

interface ResolvedCIProvider {
  readonly configuration: ResolvedCIProviderConfiguration;
  readonly metadata: CIProviderRuntimeMetadata;
}

function resolveCIProvider(configuration: CIConfiguration): ResolvedCIProvider {
  if (configuration.providers !== undefined) {
    const name = configuration.provider_name;
    const selected = name === undefined ? undefined : configuration.providers[name];
    if (name === undefined || selected === undefined) throw new Error("Invalid CI runtime configuration");
    return {
      configuration: { name, type: selected.type, github: selected.github, jenkins: selected.jenkins, bitbucket: selected.bitbucket },
      metadata: {
        name,
        type: selected.type,
        capabilities: { read: true, rerun: selected.type === "github" },
        approvalRequired: selected.type === "github",
      },
    };
  }
  return {
    configuration: { name: configuration.provider, type: configuration.provider, github: configuration.github, jenkins: configuration.jenkins, bitbucket: configuration.bitbucket },
    metadata: {
      name: configuration.provider,
      type: configuration.provider,
      capabilities: { read: true, rerun: configuration.provider === "github" },
      approvalRequired: configuration.provider === "github",
    },
  };
}

function buildCIConfiguration(
  configuration: CIConfiguration | undefined,
  options: LoadRuntimeConfigurationOptions,
): CIService | undefined {
  if (configuration?.enabled !== true) return undefined;
  if (configuration.allowlist.length === 0) {
    throw new Error("Invalid CI runtime configuration");
  }
  const selected = resolveCIProvider(configuration);
  const repositories = configuration.allowlist.map((entry) => entry.repo);
  const clock = options.clock ?? (() => new Date());
  const provider = selected.configuration.type === "jenkins"
    ? selected.configuration.jenkins === undefined
      ? (() => { throw new Error("Invalid CI runtime configuration"); })()
      : new JenkinsProvider({
          ...(selected.configuration.jenkins.endpoint === undefined
            ? { baseUrl: selected.configuration.jenkins.base_url! }
            : { endpoint: selected.configuration.jenkins.endpoint }),
          allowInsecureHttp: selected.configuration.jenkins.allow_insecure_http,
          fetch: options.fetch,
          providerName: selected.metadata.name,
          ...(options.clock === undefined ? {} : { clock }),
          maxFreshnessMs: configuration.max_freshness_seconds * 1_000,
        })
    : selected.configuration.type === "bitbucket"
      ? selected.configuration.bitbucket === undefined
        ? (() => { throw new Error("Invalid CI runtime configuration"); })()
        : new BitbucketProvider({
            ...(selected.configuration.bitbucket.endpoint === undefined
              ? { baseUrl: selected.configuration.bitbucket.base_url! }
              : { endpoint: selected.configuration.bitbucket.endpoint }),
            tokenFile: selected.configuration.bitbucket.token_file,
            ...(selected.configuration.bitbucket.username === undefined ? {} : { username: selected.configuration.bitbucket.username }),
            fetch: options.fetch,
            providerName: selected.metadata.name,
            ...(options.clock === undefined ? {} : { clock }),
            maxFreshnessMs: configuration.max_freshness_seconds * 1_000,
          })
      : buildGitHubProvider(selected.configuration, repositories, options, clock, configuration.max_freshness_seconds);
  const approval = selected.metadata.approvalRequired
    ? configuration.approval === undefined
      ? (() => { throw new Error("Invalid CI runtime configuration"); })()
      : (() => {
          const key = ApprovalTokenService.readKeyFile(configuration.approval.key_file);
          const audit = new FileApprovalAuditStore({
            replayPath: configuration.approval.replay_file,
            auditPath: configuration.approval.audit_file,
          });
          return new ApprovalTokenService({ key, clock, audit });
        })()
    : undefined;
  const providerRegistry = new CIProviderRegistry([{
    name: selected.metadata.name,
    kind: selected.metadata.type,
    capabilities: selected.metadata.capabilities.rerun
      ? APPROVAL_GATED_CI_PROVIDER_CAPABILITIES
      : READ_ONLY_CI_PROVIDER_CAPABILITIES,
    provider,
  }]);
  return {
    provider,
    policy: createCIAllowlist(Object.fromEntries(configuration.allowlist.map((entry) => [entry.repo, entry.workflows]))),
    runtimeMetadata: selected.metadata,
    providerRegistry,
    ...(approval === undefined ? {} : { approval }),
  };
}

function buildGitHubProvider(
  configuration: ResolvedCIProviderConfiguration,
  repositories: readonly string[],
  options: LoadRuntimeConfigurationOptions,
  clock: Clock,
  maxFreshnessSeconds: number,
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
          ...(configuration.github.api_endpoint === undefined
            ? { apiBaseUrl: configuration.github.api_base_url ?? "https://api.github.com" }
            : { apiEndpoint: configuration.github.api_endpoint }),
          actionsPermission: "read",
        })
      : GitHubAppTokenProvider.fromPemFile({
          appId: readNumericSecretFile(app.app_id_file),
          installationId: readNumericSecretFile(app.installation_id_file ?? ""),
          pemKeyFile: app.pem_key_file,
          allowedRepositories: repositories,
          fetch: options.fetch,
          clock,
          ...(configuration.github.api_endpoint === undefined
            ? { apiBaseUrl: configuration.github.api_base_url ?? "https://api.github.com" }
            : { apiEndpoint: configuration.github.api_endpoint }),
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
          ...(configuration.github.api_endpoint === undefined
            ? { apiBaseUrl: configuration.github.api_base_url ?? "https://api.github.com" }
            : { apiEndpoint: configuration.github.api_endpoint }),
          actionsPermission: "write",
        })
      : GitHubAppTokenProvider.fromPemFile({
          appId: readNumericSecretFile(app.app_id_file),
          installationId: readNumericSecretFile(app.installation_id_file ?? ""),
          pemKeyFile: app.pem_key_file,
          allowedRepositories: repositories,
          fetch: options.fetch,
          clock,
          ...(configuration.github.api_endpoint === undefined
            ? { apiBaseUrl: configuration.github.api_base_url ?? "https://api.github.com" }
            : { apiEndpoint: configuration.github.api_endpoint }),
          actionsPermission: "write",
        });
  if (readTokenProvider === undefined || writeTokenProvider === undefined) throw new Error("CI runtime configuration requires a GitHub App or token file");
  return new GitHubActionsProvider({
    tokenProvider: readTokenProvider,
    writeTokenProvider,
    fetch: options.fetch,
    ...(options.clock === undefined ? {} : { clock }),
    ...(configuration.github.api_endpoint === undefined
      ? { apiBaseUrl: configuration.github.api_base_url ?? "https://api.github.com" }
      : { endpoint: configuration.github.api_endpoint }),
    maxFreshnessMs: maxFreshnessSeconds * 1_000,
    providerName: configuration.name,
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
