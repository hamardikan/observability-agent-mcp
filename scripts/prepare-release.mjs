#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const version = valueAfter("--version");
const date = valueAfter("--date");
const notesFile = valueAfter("--notes-file");

assert(version && isVersion(version), "--version must be a strict semantic version");
assert(date && isDate(date), "--date must use a valid YYYY-MM-DD date");
assert(notesFile, "--notes-file is required");
assert(args.every((arg, index) => ["--version", "--date", "--notes-file"].includes(arg) || index > 0 && ["--version", "--date", "--notes-file"].includes(args[index - 1])), "unknown argument");

const packageJson = readJson("package.json");
assert(packageJson.version !== version, `package version is already ${version}`);
const notes = readFileSync(resolve(notesFile), "utf8").trim();
assert(notes && !/^#+\s/m.test(notes), "release notes must contain prose or list items, not headings");

execFileSync("npm", ["version", "--no-git-tag-version", "--ignore-scripts", version], { stdio: "inherit" });

const updatedPackage = readJson("package.json");
const serverJson = readJson("server.json");
serverJson.version = version;
assert(Array.isArray(serverJson.packages), "server.json packages must be an array");
serverJson.packages = serverJson.packages.map((entry) => ({ ...entry, version }));
writeJson("server.json", serverJson);

const sourceVersionPath = "src/version.ts";
const sourceVersion = readText(sourceVersionPath);
const replaced = sourceVersion.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`);
assert(replaced !== sourceVersion, "src/version.ts VERSION export not found");
writeFileSync(join(process.cwd(), sourceVersionPath), replaced);

const changelogPath = "CHANGELOG.md";
const changelog = readText(changelogPath);
const heading = `## [${version}] - ${date}`;
const entry = `${heading}\n\n${notes}\n\n`;
const firstRelease = changelog.search(/^## \[/m);
assert(firstRelease >= 0, "CHANGELOG.md has no release section");
writeFileSync(join(process.cwd(), changelogPath), `${changelog.slice(0, firstRelease)}${entry}${changelog.slice(firstRelease)}`);

process.stdout.write(`release_prepared=ok version=${updatedPackage.version} date=${date} tag=v${version}\n`);

function valueAfter(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function writeJson(relativePath, value) {
  writeFileSync(join(process.cwd(), relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function isVersion(value) {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  return Boolean(match) && !(match[4] ?? "").split(".").some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"));
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
