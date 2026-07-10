import assert from "node:assert/strict";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/cli.js"],
  cwd: process.cwd(),
  stderr: "pipe",
});
const client = new Client({ name: "stdio-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  assert(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));

  const health = CallToolResultSchema.parse(
    await client.callTool({
      name: "observability.health_snapshot",
      arguments: { services: ["api"] },
    }),
  );
  assert.equal(health.isError, undefined);
  assert.equal(health.structuredContent?.schemaVersion, "1.0");
} finally {
  await client.close();
}
