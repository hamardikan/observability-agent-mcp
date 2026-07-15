#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [repository, digest, version, revision] = process.argv.slice(2);
assert(repository === "ghcr.io/hmrdkn-labs/pak-satpam", "repository must be the canonical OCI identity");
assert(/^sha256:[0-9a-f]{64}$/.test(digest), "manifest digest must be sha256");
assert(version && isVersion(version), "version must be a strict semantic version");
assert(revision && /^[0-9a-f]{40}$/.test(revision), "revision must be a full commit SHA");

const immutableReference = `${repository}@${digest}`;
const tagReferences = [version, `v${version}`, `sha-${revision}`].map((tag) => `${repository}:${tag}`);
for (const reference of [immutableReference, ...tagReferences]) {
  assert(inspectDigest(reference) === digest, `${reference} does not resolve to ${digest}`);
}

const manifest = inspectRaw(immutableReference);
assert(manifest.mediaType === "application/vnd.oci.image.index.v1+json", "published image must be an OCI index");
const platforms = manifest.manifests
  .filter((entry) => isRuntimePlatform(entry.platform))
  .map((entry) => `${entry.platform.os}/${entry.platform.architecture}`)
  .sort();
assert(JSON.stringify(platforms) === JSON.stringify(["linux/amd64", "linux/arm64"]), `unexpected platforms: ${platforms.join(",")}`);

const provenance = inspectFormat(immutableReference, "{{json .Provenance}}");
const sbom = inspectFormat(immutableReference, "{{json .SBOM}}");
for (const platform of ["linux/amd64", "linux/arm64"]) {
  assert(provenance[platform]?.SLSA, `missing provenance attestation for ${platform}`);
  assert(sbom[platform]?.SPDX, `missing SPDX SBOM attestation for ${platform}`);
}

process.stdout.write(`published_image=ok digest=${digest} platforms=linux/amd64,linux/arm64 provenance=present sbom=spdx\n`);

function inspectDigest(reference) {
  return execFileSync("docker", ["buildx", "imagetools", "inspect", "--format", "{{.Manifest.Digest}}", reference], { encoding: "utf8" }).trim();
}

function inspectRaw(reference) {
  return JSON.parse(execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", reference], { encoding: "utf8" }));
}

function inspectFormat(reference, format) {
  return JSON.parse(execFileSync("docker", ["buildx", "imagetools", "inspect", "--format", format, reference], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
}

function isRuntimePlatform(platform) {
  return platform?.os && platform.architecture && platform.os !== "unknown" && platform.architecture !== "unknown";
}

function isVersion(value) {
  const match = value.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  return Boolean(match) && !(match[4] ?? "").split(".").some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"));
}
