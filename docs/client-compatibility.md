# Client Compatibility

The server must not depend on one agent vendor.

## Required Clients

Each release candidate is exercised through:

- the official MCP Inspector;
- one stdio desktop or CLI client;
- one Streamable HTTP client;
- a protocol-level integration test independent of a specific LLM.

Codex, Claude, and other MCP-compatible agents are consumers, not compile-time
dependencies.

| Surface | Current implementation | Public release gate |
| --- | --- | --- |
| MCP Inspector | initialization and seven-tool discovery tested | every enabled tool |
| stdio client | SDK and process smoke tested | two independent client implementations |
| Streamable HTTP client | static-Bearer private transport tested | OAuth plus two authenticated concurrent clients |
| MCP image content | synthetic PNG and provider fallback tested | panel and dashboard PNG displayed by two clients |

## Compatibility Rules

- Use standard MCP initialization and tool discovery.
- Support stdio and Streamable HTTP; do not add a custom transport.
- Keep tools deterministic without relying on client-specific prompt behavior.
- Do not require a client to send credentials as tool arguments.
- Return structured errors and stable schema versions.
- Publish a compatibility matrix for every tagged release.
- Preserve structured metadata when a client cannot display image content; an
  undisplayed image must not be interpreted as healthy or empty evidence.

## Remote Deployment

Public remote compatibility is not considered complete until OAuth discovery,
authorization failures, token audience checks, Origin validation, reconnects,
timeouts, and concurrent clients are tested. Negative coverage also includes
replay attempts, scope escalation, malformed authorization metadata, provider
timeout isolation, cross-client state isolation, and credential non-sharing.

For a canonical endpoint such as `https://mcp.example.test/mcp`, the server
publishes protected-resource metadata at the RFC 9728 well-known location
derived from that resource. A request without credentials receives a response
equivalent to:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="observability:capabilities"
```

A valid token lacking `observability:alerts:read` receives HTTP 403 with a
Bearer challenge containing `error="insufficient_scope"`,
`scope="observability:alerts:read"`, and the same `resource_metadata` URL.
Tests assert the exact resource identifier, metadata URL, authorization-server
relationship, audience/resource validation, and challenge headers. Example
hostnames are documentation placeholders and are never runtime defaults.

Each tagged release publishes the exact client versions and pass/fail status.

The current private HTTP mode intentionally precedes that public gate. It uses
one file-injected Bearer credential, exact allowed Host values, stateless SDK
transport instances, and no public ingress. A 401 response contains only a
generic `WWW-Authenticate: Bearer` challenge. It must not be exposed as the
OAuth-complete public endpoint described above.

## Versioned Installation Profiles

The executable examples in [`examples/v1`](../examples/v1/README.md) keep the
client contract explicit:

| Profile | Client configuration | Endpoint |
| --- | --- | --- |
| observability-only | `examples/v1/observability-only/compose.yml` | `/mcp` |
| ci-only | `examples/v1/ci-only/compose.yml` | `/mcp/ci` |
| combined | `examples/v1/combined/compose.yml` | `/mcp` |
| stdio | `examples/v1/stdio/client-config.json` | process stdin/stdout |
| private-http | `examples/v1/private-http/client-config.json` | `/mcp` |

HTTP profiles are intentionally loopback-bound and require operator-supplied
secret files. The hostnames and repository names in the examples are reserved
placeholders. A deployment must not infer public exposure, credential scope,
or private topology from these files.

The container release gate runs the same standard MCP client handshake against
separately loaded `linux/amd64` and `linux/arm64` images. It verifies
initialization, tool discovery, a read-only health call, non-root execution,
missing-bearer rejection, and disallowed-host rejection before reporting the
platform as compatible.
