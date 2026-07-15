import { z } from "zod";

/** Provider names are deployment-owned keys, not a closed provider enum. */
export const CIProviderNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export type CIProviderName = z.infer<typeof CIProviderNameSchema>;

/** Provider kinds identify adapter contracts but remain extensible. */
export const CIProviderKindSchema = CIProviderNameSchema;
export type CIProviderKind = z.infer<typeof CIProviderKindSchema>;

export const CIProviderCapabilitySchema = z.enum(["read", "rerun"]);
export type CIProviderCapability = z.infer<typeof CIProviderCapabilitySchema>;

export const CIRerunModeSchema = z.enum(["unsupported", "approval-gated"]);
export type CIRerunMode = z.infer<typeof CIRerunModeSchema>;

export const CIProviderCapabilitiesSchema = z
  .object({
    read: z.literal(true),
    rerun: CIRerunModeSchema,
  })
  .strict();
export type CIProviderCapabilities = z.infer<typeof CIProviderCapabilitiesSchema>;

export const READ_ONLY_CI_PROVIDER_CAPABILITIES = Object.freeze({
  read: true,
  rerun: "unsupported",
} satisfies CIProviderCapabilities);

export const APPROVAL_GATED_CI_PROVIDER_CAPABILITIES = Object.freeze({
  read: true,
  rerun: "approval-gated",
} satisfies CIProviderCapabilities);

const CIProviderOriginSchema = z
  .string()
  .min(1)
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (url.pathname === "" || url.pathname === "/")
    );
  }, "must be an HTTP(S) origin without credentials, path, query, or fragment");

const CIProviderEndpointPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/[^\s?#]*$/, "must be an absolute endpoint path without query or fragment");

/**
 * An origin and an endpoint path are separate by design. This prevents an
 * adapter from treating a complete endpoint URL as a base and appending its
 * endpoint path a second time.
 */
export const CIProviderEndpointSchema = z
  .object({
    origin: CIProviderOriginSchema,
    path: CIProviderEndpointPathSchema,
  })
  .strict();
export type CIProviderEndpoint = z.infer<typeof CIProviderEndpointSchema>;

/** Parse a configured URL as an origin plus an optional reverse-proxy prefix. */
export function ciProviderEndpointFromUrl(value: string): CIProviderEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CI provider base URL must be a valid URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("CI provider base URL must not contain credentials, query, or fragment");
  }
  return normalizeCIProviderEndpoint({ origin: url.origin, path: url.pathname || "/" });
}

/** Permit cleartext only for explicitly enabled, anonymous loopback development endpoints. */
export function assertCIProviderTransport(
  endpoint: CIProviderEndpoint,
  options: { readonly providerLabel: string; readonly credentialed: boolean; readonly allowInsecureHttp?: boolean },
): void {
  const normalized = normalizeCIProviderEndpoint(endpoint);
  const origin = new URL(normalized.origin);
  if (origin.protocol !== "http:") return;
  if (options.credentialed) throw new Error(`${options.providerLabel} credentials require HTTPS`);
  if (options.allowInsecureHttp !== true || !isLoopbackHost(origin.hostname)) {
    throw new Error(`${options.providerLabel} cleartext HTTP is only allowed for explicit loopback development`);
  }
}

const GitHubProviderConfigSchema = z
  .object({
    kind: z.literal("github-actions"),
    endpoint: CIProviderEndpointSchema,
    capabilities: z
      .object({ read: z.literal(true), rerun: z.literal("approval-gated") })
      .strict(),
  })
  .strict();

const JenkinsProviderConfigSchema = z
  .object({
    kind: z.literal("jenkins"),
    endpoint: CIProviderEndpointSchema,
    capabilities: z
      .object({ read: z.literal(true), rerun: z.literal("unsupported") })
      .strict(),
    branch: z.string().min(1).max(256).regex(/^[^\s?#]+$/).optional(),
  })
  .strict();

const BitbucketProviderConfigSchema = z
  .object({
    kind: z.literal("bitbucket"),
    endpoint: CIProviderEndpointSchema,
    capabilities: z
      .object({ read: z.literal(true), rerun: z.literal("unsupported") })
      .strict(),
    token_file: z.string().min(1).max(1_024),
    username: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new URL(value.endpoint.origin).protocol === "http:") {
      context.addIssue({ code: "custom", path: ["endpoint", "origin"], message: "Bitbucket credentials require HTTPS" });
    }
  });

/** Built-in config contracts validate capability declarations per adapter. */
export const CIProviderConfigSchema = z.discriminatedUnion("kind", [
  GitHubProviderConfigSchema,
  JenkinsProviderConfigSchema,
  BitbucketProviderConfigSchema,
]);
export type CIProviderConfig = z.infer<typeof CIProviderConfigSchema>;

export const CINamedProviderConfigSchema = z
  .object({
    name: CIProviderNameSchema,
    config: CIProviderConfigSchema,
  })
  .strict();
export type CINamedProviderConfig = z.infer<typeof CINamedProviderConfigSchema>;

export const CIProviderRegistryConfigSchema = z
  .record(CIProviderNameSchema, CIProviderConfigSchema)
  .refine((providers) => Object.keys(providers).length <= 16, "at most 16 named CI providers are supported");
export type CIProviderRegistryConfig = z.infer<typeof CIProviderRegistryConfigSchema>;

export const CIProviderDescriptorSchema = z
  .object({
    name: CIProviderNameSchema,
    kind: CIProviderKindSchema,
    capabilities: CIProviderCapabilitiesSchema,
    endpoint: CIProviderEndpointSchema.optional(),
  })
  .strict();
export type CIProviderDescriptor = z.infer<typeof CIProviderDescriptorSchema>;

export function supportsCIProviderCapability(
  capabilities: CIProviderCapabilities,
  capability: CIProviderCapability,
): boolean {
  return capability === "read" || capabilities.rerun === "approval-gated";
}

export function normalizeCIProviderEndpoint(endpoint: CIProviderEndpoint): CIProviderEndpoint {
  const parsed = CIProviderEndpointSchema.parse(endpoint);
  const origin = new URL(parsed.origin);
  return {
    origin: origin.origin,
    path: normalizePath(parsed.path),
  };
}

/** Resolve a relative API path without duplicating an endpoint path. */
export function resolveCIProviderUrl(endpoint: CIProviderEndpoint, requestPath = ""): URL {
  const normalized = normalizeCIProviderEndpoint(endpoint);
  if (requestPath.includes("#")) throw new Error("provider request paths must not contain fragments");
  if (requestPath.startsWith("//")) throw new Error("provider request paths must be relative paths");

  const requestUrl = isAbsoluteUrl(requestPath)
    ? new URL(requestPath)
    : new URL(requestPath, "https://pak-satpam-request.invalid");
  if (isAbsoluteUrl(requestPath) && requestUrl.origin !== normalized.origin) {
    throw new Error("provider request URL origin does not match the configured origin");
  }

  const requestedPath = normalizePath(requestUrl.pathname);
  const path = requestedPath === normalized.path || requestedPath.startsWith(`${normalized.path}/`)
    ? requestedPath
    : joinPath(normalized.path, requestedPath);
  const result = new URL(normalized.origin);
  result.pathname = path;
  result.search = requestUrl.search;
  return result;
}

function normalizePath(path: string): string {
  const normalized = `/${path.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? "/" : normalized;
}

function joinPath(prefix: string, suffix: string): string {
  if (prefix === "/") return suffix;
  if (suffix === "/") return prefix;
  return `${prefix}/${suffix.replace(/^\/+/, "")}`;
}

function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1";
}
