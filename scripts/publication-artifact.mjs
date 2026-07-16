#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLIC_REPOSITORY = "fenutech/preflight-scout";
export const PUBLIC_REGISTRY = "https://registry.npmjs.org";
export const PUBLISH_ORDER = Object.freeze([
  "@preflight-scout/core",
  "@preflight-scout/agent-exec",
  "@preflight-scout/browser-runner",
  "@preflight-scout/mcp",
  "@preflight-scout/github-action",
  "@preflight-scout/cli"
]);

const SCRIPT_NAME = "publication-artifact.mjs";
const MANIFEST_NAME = "publication-manifest.json";
const CHECKSUMS_NAME = "SHA256SUMS";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function preparePublicationArtifact({ sourceDirectory, outputDirectory, version, commit }) {
  assertVersionAndCommit(version, commit);
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  if (source === output || output.startsWith(`${source}${path.sep}`)) {
    throw new Error("Publication output must not be the package-check source or one of its descendants.");
  }

  const expectedTarballs = expectedPackages(version).map((item) => item.file);
  const sourceEntries = await regularFiles(source);
  assertExactNames(sourceEntries, expectedTarballs, "package-check directory");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  for (const file of expectedTarballs) await copyFile(path.join(source, file), path.join(output, file));
  await copyFile(fileURLToPath(import.meta.url), path.join(output, SCRIPT_NAME));

  const packages = [];
  for (const expected of expectedPackages(version)) {
    const file = path.join(output, expected.file);
    const packed = await readPackedManifest(file);
    validatePackedManifest(packed, expected.name, version);
    const contents = await readFile(file);
    packages.push({
      name: expected.name,
      file: expected.file,
      sha256: digest(contents, "sha256"),
      integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`
    });
  }

  const publisher = await readFile(path.join(output, SCRIPT_NAME));
  const manifest = {
    schemaVersion: 1,
    repository: PUBLIC_REPOSITORY,
    version,
    commit,
    registry: `${PUBLIC_REGISTRY}/`,
    publishOrder: [...PUBLISH_ORDER],
    publisher: { file: SCRIPT_NAME, sha256: digest(publisher, "sha256") },
    packages
  };
  await writeFile(path.join(output, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });

  const checksummed = [...expectedTarballs, SCRIPT_NAME, MANIFEST_NAME].sort();
  const checksumLines = [];
  for (const file of checksummed) {
    checksumLines.push(`${digest(await readFile(path.join(output, file)), "sha256").slice("sha256:".length)}  ${file}`);
  }
  await writeFile(path.join(output, CHECKSUMS_NAME), `${checksumLines.join("\n")}\n`, { flag: "wx" });
  const checksumsSha256 = digest(await readFile(path.join(output, CHECKSUMS_NAME)), "sha256");
  await verifyPublicationArtifact({ directory: output, version, commit });
  return { directory: output, checksumsSha256, packageCount: packages.length };
}

export async function verifyPublicationArtifact({ directory, version, commit }) {
  assertVersionAndCommit(version, commit);
  const root = path.resolve(directory);
  const expectedTarballs = expectedPackages(version).map((item) => item.file);
  const expectedFiles = [...expectedTarballs, SCRIPT_NAME, MANIFEST_NAME, CHECKSUMS_NAME].sort();
  assertExactNames(await regularFiles(root), expectedFiles, "publication artifact");

  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST_NAME), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== PUBLIC_REPOSITORY ||
    manifest.registry !== `${PUBLIC_REGISTRY}/` ||
    manifest.version !== version ||
    manifest.commit !== commit ||
    JSON.stringify(manifest.publishOrder) !== JSON.stringify(PUBLISH_ORDER)
  ) {
    throw new Error("Publication manifest does not match the requested repository, version, commit, registry, or dependency order.");
  }

  const checksumEntries = parseChecksums(await readFile(path.join(root, CHECKSUMS_NAME), "utf8"));
  const checksummed = [...expectedTarballs, SCRIPT_NAME, MANIFEST_NAME].sort();
  assertExactNames([...checksumEntries.keys()].sort(), checksummed, CHECKSUMS_NAME);
  for (const [file, expectedHash] of checksumEntries) {
    if (digest(await readFile(path.join(root, file)), "sha256") !== expectedHash) {
      throw new Error(`Publication checksum mismatch for ${file}.`);
    }
  }

  if (
    manifest.publisher?.file !== SCRIPT_NAME ||
    manifest.publisher.sha256 !== digest(await readFile(path.join(root, SCRIPT_NAME)), "sha256")
  ) {
    throw new Error("Publication artifact contains an unexpected publisher script.");
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== PUBLISH_ORDER.length) {
    throw new Error("Publication manifest must contain exactly six packages.");
  }

  for (const expected of expectedPackages(version)) {
    const item = manifest.packages.find((candidate) => candidate.name === expected.name);
    if (!item || item.file !== expected.file || !/^sha256:[0-9a-f]{64}$/.test(item.sha256) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity)) {
      throw new Error(`Publication manifest has invalid metadata for ${expected.name}.`);
    }
    const contents = await readFile(path.join(root, item.file));
    if (item.sha256 !== digest(contents, "sha256")) throw new Error(`Publication manifest hash mismatch for ${item.file}.`);
    if (item.integrity !== `sha512-${createHash("sha512").update(contents).digest("base64")}`) {
      throw new Error(`Publication integrity mismatch for ${item.file}.`);
    }
    validatePackedManifest(await readPackedManifest(path.join(root, item.file)), expected.name, version);
  }
  return manifest;
}

export async function publishPublicationArtifact({
  directory,
  version,
  commit,
  mode,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawnSync,
  npmCommand,
  retryDelay = async () => new Promise((resolve) => setTimeout(resolve, 2000)),
  verificationAttempts = 6
}) {
  if (!new Set(["bootstrap-token", "trusted-publishing"]).has(mode)) {
    throw new Error("Publication mode must be bootstrap-token or trusted-publishing.");
  }
  if (mode === "bootstrap-token" && !env.NODE_AUTH_TOKEN?.trim()) {
    throw new Error("bootstrap-token mode requires the npm-production environment secret NPM_TOKEN.");
  }
  if (mode === "trusted-publishing" && env.NODE_AUTH_TOKEN?.trim()) {
    throw new Error("trusted-publishing mode refuses NODE_AUTH_TOKEN; npm must authenticate only with OIDC.");
  }

  const root = path.resolve(directory);
  const { manifest, registryIntegrities } = await checkPublicationRegistry({
    directory: root,
    version,
    commit,
    fetchImpl
  });
  const npm = npmCommand ?? await resolveNpm(root);
  const versionResult = spawnImpl(npm, ["--version"], { encoding: "utf8", env, shell: false });
  if (versionResult.status !== 0 || !npmVersionSupported(versionResult.stdout?.trim())) {
    throw new Error(`npm 11.5.1 or newer is required for trusted publication; found ${versionResult.stdout?.trim() || "an unusable npm"}.`);
  }

  for (const name of PUBLISH_ORDER) {
    const item = manifest.packages.find((candidate) => candidate.name === name);
    const existing = registryIntegrities.get(name);
    if (existing !== undefined) {
      console.log(`Verified existing ${name}@${version}; exact integrity matches, skipping.`);
      continue;
    }

    const result = spawnImpl(npm, [
      "publish",
      `./${item.file}`,
      "--access=public",
      "--provenance",
      `--registry=${PUBLIC_REGISTRY}/`
    ], { cwd: root, env, stdio: "inherit", shell: false });
    if (result.status !== 0) throw new Error(`npm publish failed for ${name}@${version} with exit code ${result.status}.`);

    let published;
    for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
      published = await registryIntegrity(fetchImpl, name, version);
      if (published !== undefined) break;
      if (attempt < verificationAttempts) await retryDelay();
    }
    if (published !== item.integrity) {
      throw new Error(`${name}@${version} was not observable with the candidate integrity after publication.`);
    }
    console.log(`Published and verified ${name}@${version}.`);
  }
}

export async function checkPublicationRegistry({ directory, version, commit, fetchImpl = fetch }) {
  const manifest = await verifyPublicationArtifact({ directory, version, commit });
  const registryIntegrities = new Map();
  for (const name of PUBLISH_ORDER) {
    const item = manifest.packages.find((candidate) => candidate.name === name);
    const existing = await registryIntegrity(fetchImpl, name, version);
    if (existing !== undefined && existing !== item.integrity) {
      throw new Error(`${name}@${version} already exists with different registry integrity.`);
    }
    registryIntegrities.set(name, existing);
  }
  return { manifest, registryIntegrities };
}

function expectedPackages(version) {
  return PUBLISH_ORDER.map((name) => ({
    name,
    file: `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`
  }));
}

function validatePackedManifest(packed, name, version) {
  if (packed.name !== name || packed.version !== version) throw new Error(`Packed manifest does not identify ${name}@${version}.`);
  if (packed.license !== "AGPL-3.0-only") throw new Error(`${name} has unexpected license metadata.`);
  if (packed.repository?.url !== "git+https://github.com/fenutech/preflight-scout.git") throw new Error(`${name} has unexpected repository metadata.`);
  if (packed.publishConfig?.access !== "public" || packed.publishConfig?.provenance !== true) {
    throw new Error(`${name} must request public access and provenance.`);
  }
  if (JSON.stringify(packed).includes("workspace:")) throw new Error(`${name} contains an unconverted workspace dependency.`);
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepack", "prepublishOnly"]) {
    if (packed.scripts?.[lifecycle]) throw new Error(`${name} contains forbidden packed lifecycle script ${lifecycle}.`);
  }
}

async function readPackedManifest(tarball) {
  const result = spawnSync("tar", ["-xOzf", tarball, "package/package.json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false
  });
  if (result.status !== 0) throw new Error(`Could not inspect packed manifest in ${path.basename(tarball)}.`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Packed manifest in ${path.basename(tarball)} is invalid JSON.`);
  }
}

async function regularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const metadata = await lstat(file);
    if (!entry.isFile() || !metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`${directory} contains a non-regular or hard-linked entry: ${entry.name}.`);
    }
    files.push(entry.name);
  }
  return files.sort();
}

function assertExactNames(actual, expected, label) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} does not contain the exact expected file set.`);
  }
}

function parseChecksums(value) {
  const entries = new Map();
  for (const line of value.trim().split("\n")) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/);
    if (!match || entries.has(match[2])) throw new Error(`${CHECKSUMS_NAME} is malformed.`);
    entries.set(match[2], `sha256:${match[1]}`);
  }
  return entries;
}

function digest(contents, algorithm) {
  return `${algorithm}:${createHash(algorithm).update(contents).digest("hex")}`;
}

async function registryIntegrity(fetchImpl, name, version) {
  const url = `${PUBLIC_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "preflight-scout-publisher" },
    redirect: "error"
  });
  if (response.status === 404) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(`Registry lookup for ${name}@${version} failed with HTTP ${response.status}.`);
  if (text.length > 1024 * 1024) throw new Error(`Registry lookup for ${name}@${version} exceeded 1 MiB.`);
  let metadata;
  try {
    metadata = JSON.parse(text);
  } catch {
    throw new Error(`Registry lookup for ${name}@${version} returned invalid JSON.`);
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(metadata.dist?.integrity ?? "")) {
    throw new Error(`Registry lookup for ${name}@${version} returned no valid sha512 integrity.`);
  }
  return metadata.dist.integrity;
}

async function resolveNpm(artifactRoot) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? "npm.cmd" : "npm");
    try {
      const canonical = await realpath(candidate);
      if (canonical === artifactRoot || canonical.startsWith(`${artifactRoot}${path.sep}`)) continue;
      if ((await stat(canonical)).isFile()) return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error("Could not resolve npm outside the publication artifact.");
}

function npmVersionSupported(value) {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
}

function assertVersionAndCommit(version, commit) {
  if (!SEMVER.test(version ?? "")) throw new Error("Publication version must be exact SemVer without a leading v.");
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("Publication commit must be a full lowercase Git SHA.");
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("Publication artifact arguments must be --name value pairs.");
    values[flag.slice(2)] = value;
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.command === "prepare") {
    const result = await preparePublicationArtifact({
      sourceDirectory: args.source,
      outputDirectory: args.output,
      version: args.version,
      commit: args.commit
    });
    console.log(JSON.stringify(result));
  } else if (args.command === "verify") {
    await verifyPublicationArtifact({ directory: args.directory, version: args.version, commit: args.commit });
    console.log(`Verified publication artifact for ${PUBLIC_REPOSITORY}@${args.commit}: six exact ${args.version} tarballs and checksums.`);
  } else if (args.command === "check-registry") {
    const { registryIntegrities } = await checkPublicationRegistry({
      directory: args.directory,
      version: args.version,
      commit: args.commit
    });
    const existing = [...registryIntegrities.values()].filter((integrity) => integrity !== undefined).length;
    console.log(`Registry preflight passed for ${PUBLIC_REPOSITORY}@${args.version}: ${existing} existing, ${PUBLISH_ORDER.length - existing} missing.`);
  } else if (args.command === "publish") {
    await publishPublicationArtifact({ directory: args.directory, version: args.version, commit: args.commit, mode: args.mode });
  } else {
    throw new Error("Usage: publication-artifact.mjs <prepare|verify|check-registry|publish> [--name value ...]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
