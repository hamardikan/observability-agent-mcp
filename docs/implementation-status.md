# Implementation Status

Last reviewed: 2026-07-15
Source evidence: current committed HEAD; this status intentionally avoids a
self-stale pre-documentation SHA. Durable evidence: the Goal 19 contract
artifact at `docs/contracts/bitbucket-data-center-adapter.md` and its fixture
test at `tests/bitbucket-data-center-contract.test.ts`.

## Goal 19 Condition

The CP3 integration slice is implemented locally. The current source exposes the
direct provider-neutral SCM contract as ci.scm_change_evidence, carries all six
SCM budgets through the server/provider boundary, preserves provider-native IDs,
registers capabilities from provider metadata, and keeps the observer's poll and
webhook paths on one dedupe/stale-suppression state model. The Bitbucket Data
Center artifact is contract-only: its runtime selection is rejected, provider
requests are not attempted, and it contributes no MCP tools.

The local contract tests cover:

- CP3 SCM selectors, provider-neutral results, all six budgets, and digest output;
- GitHub Actions, Jenkins, and Bitbucket Cloud read adapters;
- Jenkins/Bitbucket reverse-proxy path joining without duplicate prefixes;
- provider-native numeric and UUID identifiers;
- bounded logs, SCM patches, metrics, telemetry references, and non-causal
  correlations;
- webhook/poll duplicate suppression, restart state, stale suppression, bounded
  pagination, and signed delivery;
- capability isolation and GitHub-only approval-gated rerun.

This status describes implementation and tests at the audit baseline. It is not a
publication or deployment receipt.

## Goal 20 Condition

The CI observer notification policy is implemented locally. Fresh terminal
failures, cancellations, timeouts, and action-required results emit state-
transition-only red status notifications and allow one durable, deduplicated
analysis attempt. Successes are silent except for the first healthy terminal
success after a successfully delivered non-success, which emits one green
recovery on a stable repository/workflow thread. SHA/conclusion event identity,
webhook/poll/restart/replay dedupe, optional state-field migration, bounded
metadata, and the existing cursor/lease/backoff contracts are covered by the
observer runtime tests.

Goal 20 does not change source, secret, shell, deploy, or provider authority.
Analysis transport retries remain bounded at the configured sink; a failed
runtime analysis attempt is not rebuilt because doing so would invoke analysis
again and violate the one-attempt policy.

## Implemented Product

- npm package identity @hmrdkn-labs/pak-satpam and MCP identity
  io.github.hmrdkn-labs/pak-satpam;
- preserved observability-agent-mcp, observer, approval, and approve aliases,
  plus pak-satpam, pak-satpam-http, and pak-satpam-doctor;
- stdio and private stateless Streamable HTTP transports;
- observability-only, ci-only, and combined runtime profiles;
- bounded Grafana, Prometheus-compatible metrics, vmalert/Alertmanager, CI, SCM,
  and telemetry evidence;
- non-root OCI packaging for linux/amd64 and linux/arm64;
- metadata-only doctor diagnostics and file-injected credentials;
- optional observer polling, verified GitHub workflow_run webhook intake,
  durable lease/dedupe state, stale suppression, signed routes, sanitized
  health/metrics, and Goal 20 state-transition-only notifications.

## Provider Status

| Provider | Read | SCM | Rerun | Status |
| --- | --- | --- | --- | --- |
| GitHub Actions | implemented | GitHub implemented | approval-gated failed jobs | built-in |
| Jenkins | implemented | multibranch implemented | unsupported | built-in read-only |
| Bitbucket Cloud | implemented | pull-request/diff implemented | unsupported | built-in read-only |
| Bitbucket Data Center | contract-only | contract-only | unsupported | no adapter |

The current telemetry runtime bridge queries named metrics only. Log and trace
types are bounded schema references, not raw log/trace provider integrations.
Bitbucket Data Center remains deferred until a separately reviewed adapter,
runtime configuration, and tool-surface gate exist.

## Publication And Deployment Blockers

- No publish or deploy was performed for this task.
- npm publication requires an authorized tag/release workflow and a recorded
  package artifact.
- OCI publication requires the authorized main-only workflow and an immutable
  GHCR digest; validation jobs are non-publishing.
- The private edge observer and Hermes route remain deployment-owner work and
  are not proven live by this repository.
- Private HTTP uses a static file-injected bearer and exact Host allowlists. It
  is not public OAuth, multi-tenant authorization, or a public endpoint.
- Public exposure remains blocked pending OAuth protected-resource metadata,
  issuer/audience/scope validation, Origin policy, ingress controls, and tenant
  isolation.

## Verification

The repository-defined aggregate gate is npm run validate. The foundation script
also checks required docs, package identity, forbidden private/secret surfaces,
workflow YAML, and local Markdown links. Multi-architecture and container
runtime checks are separate non-publishing gates in the validation workflow.

Historical objective and design evidence remain in the Goal 19 prompt,
architecture decisions, and changelog. They should not be read as publication
receipts.
