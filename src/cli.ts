#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FakeObservabilityProvider } from "./providers/fake-provider.js";
import { createObservabilityServer } from "./server/create-server.js";

const server = createObservabilityServer({
  provider: new FakeObservabilityProvider(() => new Date()),
  clock: () => new Date(),
});

const shutdown = async (): Promise<void> => {
  await server.close();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write("observability-agent-mcp failed to start\n");
  process.exitCode = 1;
}
