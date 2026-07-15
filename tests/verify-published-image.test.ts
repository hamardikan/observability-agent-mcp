import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/published-image-with-attestations.json"), "utf8")) as {
  digest: string;
  raw: unknown;
  provenance: unknown;
  sbom: unknown;
};

describe("published image verification", () => {
  it("ignores unknown/unknown attestation manifests but verifies both attestation formats", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pak-satpam-image-verifier-"));
    const docker = join(temporary, "docker");
    const callLog = join(temporary, "docker-calls.jsonl");
    const version = "0.2.0";
    const revision = "f".repeat(40);
    const manifests = (fixture.raw as { manifests: Array<{ platform?: { os?: string; architecture?: string } }> }).manifests;
    expect(manifests).toHaveLength(4);
    expect(manifests.filter(({ platform }) => platform?.os !== "unknown" && platform?.architecture !== "unknown")).toHaveLength(2);
    expect(manifests.filter(({ platform }) => platform?.os === "unknown" && platform?.architecture === "unknown")).toHaveLength(2);
    const references = [
      `ghcr.io/hmrdkn-labs/pak-satpam@${fixture.digest}`,
      `ghcr.io/hmrdkn-labs/pak-satpam:${version}`,
      `ghcr.io/hmrdkn-labs/pak-satpam:v${version}`,
      `ghcr.io/hmrdkn-labs/pak-satpam:sha-${revision}`,
    ];

    writeFileSync(docker, `#!/usr/bin/env node
const fixture = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
const reference = args.at(-1);
const references = ${JSON.stringify(references)};
require("node:fs").appendFileSync(process.env.DOCKER_CALL_LOG, JSON.stringify(args) + String.fromCharCode(10));
if (args.includes("--raw")) {
  process.stdout.write(JSON.stringify(fixture.raw));
} else if (args.includes("{{json .Provenance}}")) {
  process.stdout.write(JSON.stringify(fixture.provenance));
} else if (args.includes("{{json .SBOM}}")) {
  process.stdout.write(JSON.stringify(fixture.sbom));
} else if (references.includes(reference)) {
  process.stdout.write(fixture.digest);
} else {
  process.stderr.write("unexpected docker reference: " + reference);
  process.exit(1);
}
`);
    chmodSync(docker, 0o755);

    try {
      const output = execFileSync(process.execPath, ["scripts/verify-published-image.mjs", "ghcr.io/hmrdkn-labs/pak-satpam", fixture.digest, version, revision], {
        cwd: root,
        env: { ...process.env, DOCKER_CALL_LOG: callLog, PATH: `${temporary}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });

      expect(output).toContain("platforms=linux/amd64,linux/arm64");
      expect(output).toContain("provenance=present sbom=spdx");
      const calls = readFileSync(callLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args.includes("{{json .Provenance}}"))).toHaveLength(1);
      expect(calls.filter((args) => args.includes("{{json .SBOM}}"))).toHaveLength(1);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
