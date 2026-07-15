# CI Observer Contract

The optional observer is a companion process, not an MCP tool, LLM, or chat bot.
It turns allowlisted terminal GitHub Actions runs into signed internal events.

~~~text
GitHub Actions -> bounded poll or verified workflow_run webhook
               -> metadata-only lease/cursor/dedupe state
               -> red failure status / one-shot analysis / green recovery
                  (external agent may call Pak Satpam read tools)
~~~

## Inputs

The strict version 1 observer file contains:

- an exact repository/workflow allowlist;
- GitHub App ID and private key files;
- repository or owner installation ID files;
- an HMAC key file;
- optional GitHub webhook secret file;
- a private writable metadata-only state file;
- separate success/status and analysis URLs;
- trusted internal hosts;
- poll, payload, retry, timeout, lease, and health limits.

Every file is a regular 0600 file. Unknown fields, duplicate allowlist entries,
public delivery destinations, wildcard trusted hosts, and unsupported API
origins fail closed. Secret values are not persisted or emitted.

## Polling, Webhooks, And Dedupe

Polling always checks the newest terminal page, then scans a bounded backlog using
a cursor overlap. The default is a 30-second interval, 5-minute overlap,
24-hour initial lookback, 100 runs per page, and two backlog pages. A long-running
run that becomes terminal is therefore visible to the hot lane even if its
creation timestamp predates the cursor.

A verified GitHub workflow_run webhook is optional. It accepts only a signed
workflow_run payload, a terminal run, and an allowlisted repository/workflow.
Webhook and poll candidates share the event ID:

~~~text
repository:workflow:sha:conclusion
~~~

Duplicates in one poll, across pages, across webhook/poll paths, and across
restarts are suppressed by durable metadata-only state. The recovery thread ID
is stable for a repository/workflow pair:

~~~text
repository:workflow
~~~

Legacy version-1 records keyed by provider run ID remain readable and are
aliased to the SHA/conclusion identity on first observation.

## Goal 20 Notification Policy

Fresh `failure`, `cancelled`, `timed_out`, and `action_required` conclusions
emit one concise red status notification first. They may then perform at most
one bounded analysis attempt, recorded before provider calls. A failed analysis
delivery is not rebuilt on replay, restart, or another poll; transport retries
remain bounded inside the configured delivery sink. `success`, `skipped`, and
`neutral` conclusions are silent unless the target has a successfully delivered
red notification. The first such healthy `success` emits exactly one concise
green recovery on the stable repository/workflow thread; later successes are
silent. A failed recovery delivery retains the existing delivery backoff and
retries the same recovery identity, without creating another recovery event.

Only bounded redacted notification metadata and transition markers are durable;
analysis payloads, source, secrets, shell authority, and deployment authority
are not persisted or expanded.

## Stale Suppression

A terminal run older than stale_after_ms is observed as stale and recorded as
suppressed. Default stale_after_ms is one hour, with a schema maximum of seven
days. Stale runs never call either delivery route or failure-analysis providers.
Pagination truncation, provider failures, and delivery failures degrade health
and do not silently advance the cursor.

## Routes And Payloads

Fresh successful, skipped, neutral, and other non-analysis outcomes use the
success/status route. Fresh failure, cancelled, timed-out, and action-required
outcomes use that route first and the analysis route second. The analysis
payload contains bounded metadata, digests, classifications, provenance,
runbook references, and optional bounded SCM/telemetry evidence. It never
contains raw log lines or credentials.

Delivery signs timestamp.body with HMAC-SHA256, sends a deterministic
X-Request-ID, rejects redirects, and retries within configured attempts,
backoff, and timeout limits. HTTPS is accepted; HTTP is limited to a Tailscale
literal or explicitly trusted internal host.

## Health And Rollback

The optional health listener exposes sanitized /healthz and /metrics only.
Defaults are five failed jobs, 80 log lines, 128 KiB payloads, four delivery
attempts, 500 ms initial backoff, 10 seconds delivery timeout, and a 60-second
lease. Poll/page/payload/retry values have strict schema maximums.

Production deployment owns binding, credentials, allowlists, routes, restart
policy, resource limits, digest pinning, and rollback. Roll back to the prior
observer image/package with the same config and metadata state; do not delete
state during a normal rollback. The private edge observer and Hermes route are
not live merely because this companion is packaged.
