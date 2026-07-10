# Observability Agent MCP

A portable, read-only Model Context Protocol server for turning observability
data into bounded evidence that AI agents can inspect safely.

## Status

Runnable local foundation. The TypeScript MCP server exposes the complete
read-only tool contract over stdio using deterministic fake data and synthetic
PNG visuals. Production Grafana and Prometheus-compatible adapters are not
connected yet.

## Product Boundary

This project provides deterministic tools for observability evidence. It does
not run an LLM, receive chat messages, execute shell commands, deploy workloads,
or remediate production systems.

```text
AI client
  | stdio (implemented)
  v
Observability Agent MCP
  - strict tool schemas
  - query and response limits
  - label and value redaction
  - normalized evidence bundles
  |
  +--> deterministic fake provider (implemented)
  +--> Grafana API (planned)
  +--> Prometheus-compatible API (planned)
       - Prometheus
       - VictoriaMetrics
```

The model and agent loop remain in the client. This server only returns
structured evidence.

## First Tool Set

| Tool | Purpose |
| --- | --- |
| `observability.capabilities` | Describe configured providers and safe limits. |
| `observability.health_snapshot` | Return bounded service and target health. |
| `observability.active_alerts` | Return normalized active alert metadata. |
| `observability.query_metrics` | Run a bounded instant or range metrics query. |
| `observability.render_panel` | Return one allowlisted Grafana panel as PNG evidence. |
| `observability.render_dashboard` | Return one allowlisted Grafana dashboard as PNG evidence. |
| `observability.incident_context` | Build a compact evidence bundle for one alert or service. |

Version 1 is read-only. It will not create dashboards, modify alert rules,
silence alerts, restart services, run scripts, or trigger deployments.

## Portability

The current foundation can be consumed through:

- stdio for local desktop and CLI agents;
- a locally built OCI image;
- the package CLI produced by `npm pack`.

Authenticated Streamable HTTP is planned, not implemented. No package or image
has been published yet.

Remote HTTP deployment requires authentication. Publishing this repository does
not imply that an MCP endpoint should be exposed without OAuth, network policy,
rate limits, and audience-bound scopes.

## Run Locally

Node.js 22 and npm are required.

```bash
npm ci
npm run build
node dist/cli.js
```

The process speaks MCP over stdio, so launch it from an MCP client rather than
typing into the terminal. A client command definition is:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/observability-agent-mcp/dist/cli.js"]
}
```

Inspect tool discovery and run every local gate with:

```bash
npm run inspector:list
npm run validate
```

Build and run the non-root OCI image over stdio with:

```bash
npm run container:build
docker run --rm -i observability-agent-mcp:local
```

## Relationship To Grafana MCP

The [official Grafana MCP server](https://github.com/grafana/mcp-grafana) is the
preferred reference and fast path for broad Grafana capabilities. This project
will not duplicate its dashboard and administration surface.

| Capability | Grafana MCP | This project |
| --- | --- | --- |
| Broad Grafana dashboards and administration | Primary owner | Not implemented |
| Grafana datasource queries | Supported | Narrow adapter only |
| Direct Prometheus-compatible backend without Grafana | Not the primary path | Supported goal |
| Provider-neutral incident evidence | Provider-specific | Primary owner |
| Conservative read-only public contract | Configurable broad surface | Required default |

The unique scope here is:

- compact incident-context evidence;
- conservative read-only defaults;
- direct Prometheus-compatible operation when Grafana is absent;
- provider-neutral schemas;
- predictable limits and redaction for agent use.

Grafana visuals are first-class evidence. Rendering tools return an MCP
`ImageContent` PNG plus structured metadata for the source, observation window,
dimensions, byte size, freshness, truncation, and warnings. Visuals are opt-in;
normal metric queries do not spend rendering resources or image context.

There is no automatic delegation between the two servers. Use Grafana MCP when
an agent needs Grafana-native dashboards, incidents, administration, or its
existing query tools. Use this project's namespace when the client needs the
same bounded evidence contract across Grafana and direct
Prometheus-compatible backends. `active_alerts` and `incident_context` are
normalized here rather than forwarded to Grafana MCP; `query_metrics` selects
one configured adapter and never calls another MCP server. Deployments may
offer both namespaces, but each request has one explicit owner.

## Read Next

- [Architecture](docs/architecture.md)
- [Security Model](docs/security-model.md)
- [Tool Surface](docs/tool-surface.md)
- [Client Compatibility](docs/client-compatibility.md)
- [Test Strategy](docs/test-strategy.md)
- [Roadmap](docs/roadmap.md)
- [Implementation Status](docs/implementation-status.md)
- [Grafana Visual Context ADR](docs/decisions/0002-grafana-visual-context.md)
- [Contributing](CONTRIBUTING.md)

## License

Apache License 2.0. See [LICENSE](LICENSE).
