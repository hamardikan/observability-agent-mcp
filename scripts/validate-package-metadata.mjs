#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const requireBuilt = args.includes("--require-built");
const tagIndex = args.indexOf("--tag");
const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];

assert(!args.some((arg, index) => arg === "--tag" && (args[index + 1] === undefined || args[index + 1].startsWith("--"))), "--tag requires a value");
assert(args.every((arg, index) => arg === "--require-built" || (arg === "--tag" ? true : index > 0 && args[index - 1] === "--tag")), "unknown argument");

const packageJson = readJson("package.json");
const packageLock = readJson("package-lock.json");
const serverJson = readJson("server.json");
const version = packageJson.version;
const packageName = "@hmrdkn-labs/pak-satpam";
const mcpName = "io.github.hmrdkn-labs/pak-satpam";
const legacyBins = {
  "observability-agent-mcp": "dist/cli.js",
  "observability-agent-mcp-observer": "dist/observer/cli.js",
  "observability-agent-mcp-approval": "dist/approval-cli.js",
  "observability-agent-mcp-approve": "dist/approval-cli.js",
};

assert(packageJson.name === packageName, `package name must be ${packageName}`);
assert(packageJson.mcpName === mcpName, `package mcpName must be ${mcpName}`);
assert(isVersion(version), "package version must be a concrete semantic version");
assert(packageJson.repository?.url === "git+https://github.com/hmrdkn-labs/pak-satpam.git", "package repository is not canonical");
assert(packageJson.homepage === "https://github.com/hmrdkn-labs/pak-satpam#readme", "package homepage is not canonical");
assert(packageJson.bugs?.url === "https://github.com/hmrdkn-labs/pak-satpam/issues", "package issue URL is not canonical");

assert(packageLock.name === packageName && packageLock.version === version, "package-lock root identity is inconsistent");
assert(packageLock.packages?.[""].name === packageName, "package-lock root package name is inconsistent");
assert(packageLock.packages?.[""].version === version, "package-lock root package version is inconsistent");

const bins = packageJson.bin;
for (const [name, target] of Object.entries(legacyBins)) {
  assert(bins[name] === target, `legacy bin ${name} changed`);
}
assert(bins["pak-satpam"] === "dist/cli.js", "pak-satpam must point to the stdio build");
assert(bins["pak-satpam-http"] === "dist/http-cli.js", "pak-satpam-http must point to the HTTP build");
assert(bins["pak-satpam-doctor"] === undefined, "doctor alias cannot be declared without a doctor build");
for (const [name, target] of Object.entries(bins)) {
  assert(target.startsWith("dist/") && target.endsWith(".js"), `bin ${name} must point to a dist JavaScript file`);
  const source = join(root, target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
  assert(existsSync(source), `bin ${name} has no source entrypoint: ${source}`);
  if (requireBuilt) {
    const built = join(root, target);
    assert(existsSync(built) && statSync(built).isFile(), `bin ${name} has no built entrypoint: ${built}`);
  }
}
assert(JSON.stringify(sortObject(packageLock.packages[""].bin)) === JSON.stringify(sortObject(bins)), "package-lock bin metadata is inconsistent");

assert(serverJson.$schema === "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", "server.json schema is not canonical");
assert(serverJson.name === mcpName, "server.json name does not match mcpName");
assert(serverJson.version === version, "server.json version is inconsistent");
assert(serverJson.packages?.length === 1, "server.json must declare exactly one package");
const [serverPackage] = serverJson.packages;
assert(serverPackage.registryType === "npm", "server.json package must use npm");
assert(serverPackage.registryBaseUrl === "https://registry.npmjs.org", "server.json npm registry is not canonical");
assert(serverPackage.identifier === packageName, "server.json package identifier is inconsistent");
assert(serverPackage.version === version, "server.json package version is inconsistent");
assert(serverPackage.transport?.type === "stdio", "server.json package transport must be stdio");

assert(readText("CHANGELOG.md").includes(`## [${version}]`), "CHANGELOG.md has no package version entry");
if (tag !== undefined) {
  assert(tag === `v${version}`, `release tag ${tag} does not match package version ${version}`);
}

process.stdout.write(`package_metadata=ok name=${packageName} version=${version} bins=${Object.keys(bins).length}\n`);

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function isVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
