# Version 1 Examples

These examples describe the public version 1 runtime contract. They use only
reserved `example.test` hostnames, placeholder repository names, and operator-
supplied secret file paths. Replace those values in a deployment copy; do not
commit credentials or private network addresses here.

| Profile | Client endpoint | Runtime |
| --- | --- | --- |
| observability-only | `/mcp` | private Streamable HTTP, CI disabled |
| ci-only | `/mcp/ci` | private Streamable HTTP, CI enabled |
| combined | `/mcp` | private Streamable HTTP, observability and CI enabled |
| stdio | process stdin/stdout | local stdio, deterministic fake provider |
| private-http | `/mcp` | private Streamable HTTP with explicit loopback publishing |

The Compose files build the repository `Containerfile` locally and default to
`linux/amd64`. Select the other supported architecture with
`PLATFORM=linux/arm64`. HTTP profiles require the operator to provide regular
secret files with mode `0600` under each profile's `secrets/` directory.

Private HTTP is intentionally bound to loopback in these examples. Do not
change that binding to a public interface without completing the OAuth,
tenant-isolation, ingress, and authorization review described in the security
documentation.

Run an HTTP profile from the repository root with:

```bash
docker compose -f examples/v1/observability-only/compose.yml up --build
```

Use the matching `client-config.json` or send the standard MCP client request
to the endpoint with the operator-supplied bearer token. The CI-only profile
still requires the observability provider fields because the current HTTP
entrypoint always loads the complete version 1 runtime configuration.
