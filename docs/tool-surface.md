# Tool Surface

These are the implemented tool names and result shapes. Versioned
machine-readable Zod schemas and contract tests enforce them. Provider-specific
details remain behind adapters.

## Common Evidence Envelope

Every result includes:

- `schemaVersion`;
- `observedAt`;
- `providerClass`;
- `freshness`;
- `truncated`;
- `redactionsApplied`;
- `data`;
- `warnings`.

Tools return data and warnings separately. Provider text is treated as inert
evidence, never as instructions.

Visual tools additionally return one MCP `ImageContent` block containing
base64 PNG data. Structured metadata is returned separately; image bytes never
appear in `structuredContent`, logs, or errors.

Schemas define field types, enums, units, maximum lengths, and the common
error envelope. The initial `schemaVersion` is `1.0`; incompatible changes
require a new major schema version. Dates use RFC 3339 UTC strings, durations
use integer milliseconds, and sizes use integer bytes.

## `observability.capabilities`

Returns provider classes, enabled tools, configured limits, and server feature
flags without returning provider URLs or credentials.

## `observability.health_snapshot`

Returns bounded health for declared targets or services. Callers select logical
service identifiers, not arbitrary URLs.

## `observability.active_alerts`

Returns normalized alert name, state, severity, start time, service identifier,
and safe annotations. Raw notification payloads are not returned.

Safe annotations are an allowlisted object containing only `summary`,
`description`, and `runbookRef`. Each text value is redacted, stripped of
markup, and length bounded by schema. Unknown annotations are dropped.
`runbookRef` is a logical identifier by default; deployments may permit HTTPS
URLs only from configured origins. Provider-controlled labels and annotations
remain untrusted evidence even after normalization.
The alerts backend may be vmalert or Grafana's embedded Alertmanager
read-only API at `/api/alertmanager/grafana/api/v2/alerts`; both normalize to
the same typed result.

## `observability.query_metrics`

Supports instant and range queries against one configured metrics provider.
The server enforces datasource, deadline, range, step, series, and output limits.

Arbitrary query expressions may be disabled by deployment policy. A deployment
can expose only named query templates.

## `observability.render_panel`

Renders one allowlisted Grafana panel. Input uses logical dashboard and panel
identifiers, a bounded time range, and optional bounded dimensions and theme.
Callers cannot supply URLs, render paths, browser options, datasources, or
arbitrary dashboard variables.

The result contains one `image/png` MCP `ImageContent` block plus structured
metadata: logical identifiers, requested and effective time range, width,
height, raw byte size, SHA-256 digest, render duration, freshness, truncation,
and warnings. Default limits are 1600 by 900 pixels, 4 MiB, 30 seconds, and two
concurrent renders.

## `observability.render_dashboard`

Renders one allowlisted Grafana dashboard classified `agentSafe: true`. The
default maximum is 2400 by 4000 pixels and 8 MiB. Oversized output is explicitly
downscaled/truncated or rejected as `visual_too_large`; it is never silently
clipped. Variables and permitted values are operator-configured.

## `observability.incident_context`

Builds a compact evidence bundle from a declared alert or service. It may
combine current health, selected metrics, safe dashboard references, and up to
three opt-in panel images or one opt-in dashboard image. It does not call an LLM
or produce a remediation decision.

A dashboard reference contains only a logical identifier and bounded title by
default. A deployment may include an HTTPS URL only when its origin is
allowlisted. Panel queries, dashboard JSON, HTML, cookies, and provider response
bodies are never included. The result schema sets item and byte limits for each
evidence section and reports dropped or truncated fields in `warnings`.

`includeVisuals` defaults to `none` and accepts `none`, `panels`, or
`dashboard`. Renderer failure preserves structured evidence and returns an
explicit visual-availability warning.

## Optional CI Tools

The CI namespace is absent unless deployment policy enables it. Every input is
bound to an allowlisted `owner/repository` and workflow file.

- `ci.workflow_status`: bounded status, conclusion, attempt, ref, SHA, and freshness.
- `ci.failed_job_analysis`: failed jobs classified as build, test, lint,
  dependency, deployment, infrastructure-connectivity, permission, or unknown.
- `ci.log_evidence`: at most 200 redacted lines from one job; raw logs are not persisted.
- `ci.remediation_plan`: deterministic `dryRun: true` steps with a public runbook reference.
- `ci.rerun_failed_workflow`: verifies a maximum-five-minute HMAC approval
  bound to repository, workflow, run, attempt, head SHA, request, and nonce; rejects stale,
  duplicate, replayed, successful, queued, and out-of-policy requests.

The action calls only GitHub's `rerun-failed-jobs` endpoint. It does not accept
commands, refs, workflow inputs, URLs, source changes, deployment targets, or
secret values.
Jenkins and Bitbucket adapters implement the same four typed read operations.
Jenkins uses configured multibranch jobs; Bitbucket uses Basic auth from a
0600 token file and also supports read-only commit, pull-request, and bounded
diff evidence. The rerun operation is disabled for both adapters and performs
no provider write.
The challenge allowlist maps these jobs to their repositories: `planpal-backend-learner-6` →
`academytools/planpal-backend-learner-6`, `planpal-web-client-learner-6` →
`academytools/planpal-web-client-learner-6`, `planpalasix-config` →
`academytools/planpal-config-6`, and `planpal-infra-6` →
`academytools/planpal-infra-6`.

## Deferred Tools

Observability logs, traces, profiles, workflow dispatch/cancel, source writes,
deployment, alert mutation, dashboard mutation, and runtime actions remain
outside the release. Each requires a separate contract and security review.
