import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveExternalTool, splitExternalToolLines } from "./resolve-external-tool.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");
const tarballsDir = path.join(root, ".preflight-scout", "package-check");
const tarCommand = await resolveExternalTool("tar", {
  repoRoot: root,
  // Git Bash ships an MSYS tar that interprets native drive-letter paths as
  // remote archives. The Windows system tar accepts the native paths supplied
  // by Node and is outside repository-controlled PATH resolution.
  windowsSystem32Only: true
});
const rootFiles = new Set([
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/NOTICE",
  "package/OUTPUT-LICENSE.md",
  "package/THIRD_PARTY_NOTICES.md"
]);
const [mode, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length || (mode !== undefined && mode !== "--prepare")) {
  throw new Error("Usage: node scripts/verify-packed-packages.mjs [--prepare]");
}
if (mode === "--prepare") {
  await rm(tarballsDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  await mkdir(tarballsDir, { recursive: true });
  process.exit(0);
}

const packageEntries = await readdir(packagesDir, { withFileTypes: true });
const sourceManifests = await Promise.all(packageEntries
  .filter((entry) => entry.isDirectory())
  .map(async (entry) => ({
    directory: entry.name,
    manifest: JSON.parse(await readFile(path.join(packagesDir, entry.name, "package.json"), "utf8"))
  })));
const versions = new Map(sourceManifests.map(({ manifest }) => [manifest.name, manifest.version]));
const expectedTarballs = new Set(sourceManifests.map(({ manifest }) => tarballName(manifest)));
const actualTarballs = (await readdir(tarballsDir)).filter((name) => name.endsWith(".tgz"));

for (const name of actualTarballs) {
  if (!expectedTarballs.has(name)) throw new Error(`Package check directory contains unexpected tarball ${name}.`);
}
for (const name of expectedTarballs) {
  if (!actualTarballs.includes(name)) throw new Error(`Package check directory is missing ${name}.`);
}

for (const { manifest: source } of sourceManifests) {
  const tarball = path.join(tarballsDir, tarballName(source));
  if ((await stat(tarball)).size > 20 * 1024 * 1024) throw new Error(`${source.name} tarball exceeds the 20 MiB release limit.`);
  const [{ stdout: listingText }, { stdout: verboseText }] = await Promise.all([
    execFileAsync(tarCommand, ["-tzf", tarball], { maxBuffer: 1024 * 1024 * 4 }),
    execFileAsync(tarCommand, ["-tvzf", tarball], { maxBuffer: 1024 * 1024 * 8 })
  ]);
  const listing = splitExternalToolLines(listingText);
  const verbose = splitExternalToolLines(verboseText);
  if (!listing.length || listing.length > 2048) throw new Error(`${source.name} tarball has an invalid file count.`);
  if (verbose.length !== listing.length) throw new Error(`${source.name} tar listing metadata could not be reconciled.`);
  if (new Set(listing).size !== listing.length) throw new Error(`${source.name} tarball contains duplicate paths.`);

  const modes = new Map();
  for (let index = 0; index < listing.length; index++) {
    const entry = listing[index];
    const mode = verbose[index].slice(0, 10);
    validateArchivePath(source.name, entry);
    if (!rootFiles.has(entry) && !isAllowedDistPath(entry)) {
      throw new Error(`${source.name} tarball contains unexpected path ${entry}.`);
    }
    if (!mode.startsWith("-")) throw new Error(`${source.name} tarball contains a non-regular entry at ${entry}.`);
    modes.set(entry, mode);
  }

  for (const required of [...rootFiles, "package/dist/index.js", "package/dist/index.d.ts", "package/dist/.preflight-scout-build.json"]) {
    if (!modes.has(required)) throw new Error(`${source.name} tarball is missing ${required.replace("package/", "")}.`);
  }

  const packed = JSON.parse((await readArchiveFile(tarball, "package/package.json")).toString("utf8"));
  validatePackedManifest(source, packed, versions);
  if (source.name === "@preflight-scout/cli") {
    if (JSON.stringify(packed.bin) !== JSON.stringify({ "preflight-scout": "dist/index.js" })) {
      throw new Error("@preflight-scout/cli tarball must expose only preflight-scout -> dist/index.js.");
    }
    const cliMode = modes.get("package/dist/index.js");
    if (!cliMode || cliMode[3] !== "x" || cliMode[6] !== "x" || cliMode[9] !== "x") {
      throw new Error("@preflight-scout/cli dist/index.js is not executable for all users in the tarball.");
    }
  } else if (packed.bin !== undefined) {
    throw new Error(`${source.name} unexpectedly exposes a command-line binary.`);
  }

  const stamp = JSON.parse((await readArchiveFile(tarball, "package/dist/.preflight-scout-build.json")).toString("utf8"));
  validateBuildStamp(source, stamp, listing);
  for (const [output, expectedHash] of Object.entries(stamp.outputs)) {
    const archivePath = `package/${output}`;
    const content = await readArchiveFile(tarball, archivePath);
    const actualHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (actualHash !== expectedHash) throw new Error(`${source.name} tarball output hash mismatch for ${output}.`);
  }

  for (const entry of listing) {
    const content = await readArchiveFile(tarball, entry);
    scanPublishableContent(source.name, entry, content.toString("utf8"));
  }
}

console.log(`Verified ${sourceManifests.length} package tarballs: exact names, manifests, regular-file allowlists, CLI mode, build hashes, and publish-safe contents.`);

function tarballName(manifest) {
  return `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
}

function validateArchivePath(packageName, entry) {
  if (!entry.startsWith("package/") || entry.includes("\\") || /[\0\r\n]/.test(entry)) {
    throw new Error(`${packageName} tarball contains an invalid archive path.`);
  }
  const segments = entry.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${packageName} tarball contains an unsafe archive path ${entry}.`);
  }
  if (segments.some((segment) => segment === ".git" || segment === ".env" || segment === ".npmrc")) {
    throw new Error(`${packageName} tarball contains forbidden local metadata at ${entry}.`);
  }
}

function isAllowedDistPath(entry) {
  if (!entry.startsWith("package/dist/") || entry === "package/dist/") return false;
  const relative = entry.slice("package/dist/".length);
  return relative === ".preflight-scout-build.json" || /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:js|js\.map|d\.ts|d\.ts\.map|json)$/.test(relative);
}

function validatePackedManifest(source, packed, packageVersions) {
  if (packed.name !== source.name || packed.version !== source.version) {
    throw new Error(`${source.name} tarball identifies itself as ${packed.name}@${packed.version}.`);
  }
  if (JSON.stringify(packed).includes("workspace:")) throw new Error(`${source.name} tarball contains an unconverted workspace protocol.`);
  if (JSON.stringify(Object.keys(packed).sort()) !== JSON.stringify(Object.keys(source).sort())) {
    throw new Error(`${source.name} tarball changed the package.json top-level field set.`);
  }

  for (const [field, value] of Object.entries(source)) {
    if (["dependencies", "optionalDependencies", "peerDependencies", "scripts"].includes(field)) continue;
    if (stableJson(packed[field]) !== stableJson(value)) {
      throw new Error(`${source.name} tarball changed package.json field ${field}.`);
    }
  }
  for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const expected = Object.fromEntries(Object.entries(source[section] ?? {}).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? resolveWorkspaceRange(range, packageVersions.get(name)) : range
    ]));
    if (stableJson(packed[section] ?? {}) !== stableJson(expected)) {
      throw new Error(`${source.name} tarball changed ${section} beyond workspace-range conversion.`);
    }
  }
  const expectedScripts = Object.fromEntries(Object.entries(source.scripts ?? {})
    .filter(([name]) => name !== "prepack" && name !== "prepublishOnly"));
  if (stableJson(packed.scripts ?? {}) !== stableJson(expectedScripts)) {
    throw new Error(`${source.name} tarball changed scripts beyond removing release-only verification hooks.`);
  }
  for (const lifecycle of ["preinstall", "install", "postinstall"]) {
    if (packed.scripts?.[lifecycle]) throw new Error(`${source.name} tarball contains forbidden ${lifecycle} lifecycle code.`);
  }
}

function validateBuildStamp(source, stamp, listing) {
  if (stamp.schemaVersion !== 2 || stamp.packageName !== source.name || stamp.packageVersion !== source.version) {
    throw new Error(`${source.name} tarball contains a build stamp for a different package or schema.`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(stamp.inputHash) || !stamp.outputs || typeof stamp.outputs !== "object") {
    throw new Error(`${source.name} tarball contains an invalid build stamp.`);
  }
  const stampedPaths = Object.keys(stamp.outputs).sort();
  const packedOutputs = listing
    .filter((entry) => entry.startsWith("package/dist/") && entry !== "package/dist/.preflight-scout-build.json")
    .map((entry) => entry.slice("package/".length))
    .sort();
  if (!stampedPaths.length || JSON.stringify(stampedPaths) !== JSON.stringify(packedOutputs)) {
    throw new Error(`${source.name} tarball build stamp does not cover every dist output exactly.`);
  }
  for (const [output, hash] of Object.entries(stamp.outputs)) {
    if (!output.startsWith("dist/") || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`${source.name} tarball contains an invalid build-stamp output entry.`);
    }
  }
}

async function readArchiveFile(tarball, entry) {
  const { stdout } = await execFileAsync(tarCommand, ["-xOzf", tarball, entry], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function scanPublishableContent(packageName, entry, content) {
  const forbidden = [
    { label: "a local macOS user path", pattern: /\/(?:Users|Volumes)\// },
    { label: "a local Linux user path", pattern: /\/(?:home\/[^/\s]+|root)\// },
    { label: "a local Windows user path", pattern: /[A-Za-z]:[\\/]+Users[\\/]/i },
    { label: "a private key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
    { label: "a GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
    { label: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
    { label: "a GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
    { label: "a PyPI token", pattern: /\bpypi-[A-Za-z0-9_-]{30,}\b/ },
    { label: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { label: "an OpenAI-style secret key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { label: "a Stripe secret key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9_]{16,}\b/ },
    { label: "a Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/ },
    { label: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ }
  ];
  for (const item of forbidden) {
    if (item.pattern.test(content)) throw new Error(`${packageName} tarball ${entry} contains ${item.label}.`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (value && typeof value === "object") {
    return JSON.stringify(Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, JSON.parse(stableJson(item))])));
  }
  return JSON.stringify(value);
}

function resolveWorkspaceRange(range, version) {
  if (!version) throw new Error(`Cannot resolve internal workspace range ${range} without a package version.`);
  const specifier = range.slice("workspace:".length);
  if (specifier === "*") return version;
  if (specifier === "^") return `^${version}`;
  if (specifier === "~") return `~${version}`;
  return specifier;
}
