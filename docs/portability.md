# Portability And Release Contract

Pak Satpam exposes the same MCP application through three supported launch
shapes. The transport and packaging change; tool names and schema version do
not.

| Distribution | Transport | Platforms |
| --- | --- | --- |
| npm package `@hamardikan/observability-agent-mcp` | stdio | Node.js 22 on Linux amd64 or arm64 |
| npm package `@hamardikan/observability-agent-mcp` | private Streamable HTTP | Node.js 22 on Linux amd64 or arm64 |
| OCI image `ghcr.io/hmrdkn-labs/pak-satpam` | stdio or private Streamable HTTP | `linux/amd64`, `linux/arm64` |
| npm package or OCI image | private CI observer companion | Node.js 22 on Linux amd64 or arm64 |

The public identifiers are compatibility contracts: npm package
`@hamardikan/observability-agent-mcp`, CLI `observability-agent-mcp`, HTTP
entrypoint `dist/http-cli.js`, OCI image
`ghcr.io/hmrdkn-labs/pak-satpam`, commit tag `sha-<commit>`, and
MCP schema version `1.0`. Portability work must not rename them.
The optional observer CLI `observability-agent-mcp-observer` is additive and
does not change the MCP server identity or tool contract.

The private HTTP transport keeps the full server at `/mcp` and, when CI is
configured, exposes an additional `/mcp/ci` surface containing exactly the five
CI tools. The CI-only surface is portable across the same OCI architectures and
fails closed with no route when CI is disabled.

## Stdio

The default CLI uses the deterministic local provider and does not open a
network listener:

```bash
npm ci
npm run build
npm run test:stdio
node dist/cli.js
```

An MCP client launches the built CLI with `node dist/cli.js`. Do not type
requests into the process directly.

## Private Streamable HTTP

This pre-release transport is for a private, single-operator network. It
requires an operator-owned YAML policy plus file-injected Grafana and MCP
tokens. Secret files must be regular files with mode `0600`; their contents are
not tool inputs or command arguments.

```bash
npm ci
npm run build
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=8765 \
MCP_HTTP_ALLOWED_HOSTS=127.0.0.1 \
OBSERVABILITY_PROVIDER_CONFIG=./runtime/provider-config.yml \
GRAFANA_TOKEN_FILE=./runtime/grafana-token \
MCP_TOKEN_FILE=./runtime/mcp-token \
node dist/http-cli.js
```

The allowed Host list is exact. Do not expose this mode publicly or treat its
static bearer credential as OAuth. Its protocol smoke check is:

```bash
node scripts/http-smoke.mjs http://127.0.0.1:8765/mcp ./runtime/mcp-token
```

## OCI

Use an immutable commit tag and select the target platform explicitly:

```bash
IMAGE=ghcr.io/hmrdkn-labs/pak-satpam:sha-<commit>
docker pull --platform linux/amd64 "$IMAGE"
docker run --rm --platform linux/amd64 "$IMAGE" dist/cli.js
docker pull --platform linux/arm64 "$IMAGE"
docker run --rm --platform linux/arm64 "$IMAGE" dist/cli.js
```

For private HTTP, mount the runtime directory read-only and pass the same
environment variables. The non-root image uses `node` as its entrypoint;
`dist/cli.js` selects stdio and `dist/http-cli.js` selects HTTP.

The same image runs the observer with `dist/observer/cli.js`. Deployments must
mount its policy, GitHub App identity, installation IDs, HMAC key, and writable
metadata-only state path explicitly. The observer opens only its configured
health/metrics listener and outbound GitHub/Hermes connections.

## Versioned Examples

The [`examples/v1`](../examples/v1/README.md) directory contains placeholder-
only contracts for observability-only, CI-only, combined, stdio, and private
HTTP profiles. The HTTP Compose examples build the local `Containerfile`, use
reserved `example.test` names, mount operator-created `0600` secret files, and
publish only to loopback. The CI-only client uses `/mcp/ci`; the combined
client uses `/mcp`.

The examples are starting points, not a deployment policy. Replace the
provider URLs, repository/workflow allowlist, and file paths in a private copy.
Do not add private hostnames, addresses, credentials, or topology to this
public repository.

## Gates

Validation runs the package/protocol gates, a non-publishing multi-platform
Buildx build, and a per-platform `--load` runtime smoke for both target
platforms. The runtime smoke starts the image as `node`, rejects an
unauthenticated or disallowed-host request, and completes a real MCP HTTP
handshake and read-only call. QEMU is used for emulated execution where the
host architecture requires it. The publish workflow repeats the release
contract check before publishing the existing GHCR image with provenance and
an SBOM. Neither gate deploys a workload or reads runtime secret files.

Private HTTP remains a private, single-operator mode. The examples bind to
loopback and the public release contract does not authorize public exposure.
