import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
  repository: { url: string; source: string };
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
    expect(packageJson.bin["pak-satpam-doctor"]).toBe("dist/diagnostics/cli.js");

    for (const target of Object.values(packageJson.bin)) {
      const source = target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts");
      expect(existsSync(join(root, source)), `${target} source`).toBe(true);
    }
  });

  it("uses the official npm package shape for MCP Registry metadata", () => {
    expect(serverJson.name).toBe(MCP_NAME);
    expect(serverJson.version).toBe(VERSION);
    expect(serverJson.repository).toEqual({ url: "https://github.com/hmrdkn-labs/pak-satpam", source: "github" });
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
    expect(readText("CHANGELOG.md")).toMatch(new RegExp(`^## \\[${VERSION.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));

    const npmWorkflow = readText(".github/workflows/publish-npm.yml");
    expect(npmWorkflow).toMatch(/tags:\s*\n\s+- ['"]v\*\.\*\.\*['"]/);
    expect(npmWorkflow).toMatch(/id-token:\s*write/);
    expect(npmWorkflow).toMatch(/npm publish --access public/);
    expect(npmWorkflow).not.toMatch(/NODE_AUTH_TOKEN/);

    const registryWorkflow = readText(".github/workflows/publish-mcp-registry.yml");
    expect(registryWorkflow).toMatch(/validate-package-metadata\.mjs --require-built/);
    expect(registryWorkflow).not.toMatch(/mcp-publisher publish/);

    const containerWorkflow = readText(".github/workflows/publish-container.yml");
    expect(containerWorkflow).toMatch(/workflow_dispatch:/);
    expect(containerWorkflow).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(containerWorkflow).toMatch(/provenance: mode=max/);
    expect(containerWorkflow).toMatch(/sbom: true/);
    expect(containerWorkflow).toContain(":${{ steps.metadata.outputs.version }}");
    expect(containerWorkflow).toContain(":v${{ steps.metadata.outputs.version }}");
    expect(containerWorkflow).toContain(":sha-${{ github.sha }}");
    expect(containerWorkflow).toContain("verify-published-image.mjs");
    expect(containerWorkflow).not.toMatch(/^\s+pull_request:\s*$/m);
    expect(containerWorkflow).not.toMatch(/^\s+push:\s*$/m);
    expect(npmWorkflow).not.toMatch(/^\s+pull_request:\s*$/m);
    const validationWorkflow = readText(".github/workflows/validate.yml");
    expect(validationWorkflow).toContain("release:validate -- --require-built");
    expect(validationWorkflow).not.toMatch(/npm publish|push:\s*true/);
    expect(readText("scripts/container-runtime-smoke.sh")).toContain("container-stdio-smoke.mjs");
    expect(readText("scripts/package-smoke.mjs")).toContain('"@hmrdkn-labs"');
    expect(readText("scripts/package-smoke.mjs")).not.toContain('"@hamardikan"');
    expect(readText("src/server/create-server.ts")).toMatch(/version: VERSION/);
  });

  it("pins the OCI build and exposes metadata-only verification", () => {
    const containerfile = readText("Containerfile");
    expect(containerfile.match(/FROM node:22\.22\.3-bookworm-slim@sha256:[0-9a-f]{64}/g)).toHaveLength(2);
    expect(containerfile).toContain("org.opencontainers.image.version");
    expect(containerfile).toContain("org.opencontainers.image.revision");
    expect(existsSync(join(root, "scripts/container-stdio-smoke.mjs"))).toBe(true);
    expect(existsSync(join(root, "scripts/prepare-release.mjs"))).toBe(true);
    expect(existsSync(join(root, "scripts/verify-published-image.mjs"))).toBe(true);
    expect(readText("scripts/verify-published-image.mjs")).toContain(".Provenance");
    expect(readText("scripts/verify-published-image.mjs")).toContain(".SBOM");
  });

  it("prepares a future version that passes metadata validation", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pak-satpam-release-prepare-"));
    try {
      for (const relativePath of ["package.json", "package-lock.json", "server.json", "CHANGELOG.md", "scripts/prepare-release.mjs", "scripts/validate-package-metadata.mjs"]) {
        const destination = join(temporary, relativePath);
        const parent = dirname(destination);
        mkdirSync(parent, { recursive: true });
        cpSync(join(root, relativePath), destination);
      }
      cpSync(join(root, "src"), join(temporary, "src"), { recursive: true });
      writeFileSync(join(temporary, "release-notes.md"), "Release preparation smoke.\n");

      execFileSync(process.execPath, ["scripts/prepare-release.mjs", "--version", "0.3.0", "--date", "2026-07-16", "--notes-file", "release-notes.md"], { cwd: temporary, stdio: "pipe" });
      execFileSync(process.execPath, ["scripts/validate-package-metadata.mjs", "--tag", "v0.3.0"], { cwd: temporary, stdio: "pipe" });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});

function readJson(relativePath: string): unknown {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}
