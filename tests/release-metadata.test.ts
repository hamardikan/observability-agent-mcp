import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { MCP_NAME, PACKAGE_NAME, VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = readJson("package.json") as {
  name: string;
  version: string;
  mcpName?: string;
  repository: { url: string };
  homepage: string;
  bugs: { url: string };
  bin: Record<string, string>;
};
const packageLock = readJson("package-lock.json") as {
  name: string;
  version: string;
  packages: { "": { name: string; version: string; bin: Record<string, string> } };
};
const serverJson = readJson("server.json") as {
  name: string;
  version: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport: { type: string };
  }>;
};

const legacyBins = {
  "observability-agent-mcp": "dist/cli.js",
  "observability-agent-mcp-observer": "dist/observer/cli.js",
  "observability-agent-mcp-approval": "dist/approval-cli.js",
  "observability-agent-mcp-approve": "dist/approval-cli.js",
};

describe("release metadata", () => {
  it("uses one Pak Satpam package identity everywhere", () => {
    expect(packageJson.name).toBe(PACKAGE_NAME);
    expect(packageJson.version).toBe(VERSION);
    expect(packageJson.mcpName).toBe(MCP_NAME);
    expect(packageJson.repository.url).toBe("git+https://github.com/hmrdkn-labs/pak-satpam.git");
    expect(packageJson.homepage).toBe("https://github.com/hmrdkn-labs/pak-satpam#readme");
    expect(packageJson.bugs.url).toBe("https://github.com/hmrdkn-labs/pak-satpam/issues");

    expect(packageLock.name).toBe(PACKAGE_NAME);
    expect(packageLock.version).toBe(VERSION);
    expect(packageLock.packages[""].name).toBe(PACKAGE_NAME);
    expect(packageLock.packages[""].version).toBe(VERSION);
    expect(packageLock.packages[""].bin).toEqual(packageJson.bin);
  });

  it("preserves legacy bins and only exposes built entrypoint aliases", () => {
    expect(packageJson.bin).toMatchObject(legacyBins);
    expect(packageJson.bin["pak-satpam"]).toBe("dist/cli.js");
    expect(packageJson.bin["pak-satpam-http"]).toBe("dist/http-cli.js");
    expect(packageJson.bin).not.toHaveProperty("pak-satpam-doctor");

    for (const target of Object.values(packageJson.bin)) {
      const source = target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
      expect(existsSync(join(root, source)), `${target} source`).toBe(true);
    }
  });

  it("uses the official npm package shape for MCP Registry metadata", () => {
    expect(serverJson.name).toBe(MCP_NAME);
    expect(serverJson.version).toBe(VERSION);
    expect(serverJson.packages).toEqual([
      {
        registryType: "npm",
        registryBaseUrl: "https://registry.npmjs.org",
        identifier: PACKAGE_NAME,
        version: VERSION,
        transport: { type: "stdio" },
      },
    ]);
  });

  it("has release notes and non-publishing registry validation", () => {
    expect(readText("CHANGELOG.md")).toMatch(new RegExp(`## \\[${VERSION.replaceAll(".", "\\.")}\\]`));

    const npmWorkflow = readText(".github/workflows/publish-npm.yml");
    expect(npmWorkflow).toMatch(/tags:\s*\n\s+- ['"]v\*\.\*\.\*['"]/);
    expect(npmWorkflow).toMatch(/id-token:\s*write/);
    expect(npmWorkflow).toMatch(/npm publish --access public/);
    expect(npmWorkflow).not.toMatch(/NODE_AUTH_TOKEN/);

    const registryWorkflow = readText(".github/workflows/publish-mcp-registry.yml");
    expect(registryWorkflow).toMatch(/validate-package-metadata\.mjs --require-built/);
    expect(registryWorkflow).not.toMatch(/mcp-publisher publish/);
  });
});

function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}
