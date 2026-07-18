#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { manifestPathLabel, portablePathLabel, relativePathLabel } from "./package-build-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pathLabelsScript = path.join(root, "scripts", "package-build-paths.mjs");
const mode = process.argv[2];
const packageDir = process.argv[3]
  ? path.resolve(root, process.argv[3])
  : process.cwd();
const stampPath = path.join(packageDir, "dist", ".preflight-scout-build.json");

if (!new Set(["clean", "write", "verify"]).has(mode)) {
  throw new Error("Usage: node scripts/package-build-integrity.mjs <clean|write|verify> [package-directory]");
}

const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
if (!manifest.name?.startsWith("@preflight-scout/")) {
  throw new Error(`${relativePathLabel(root, packageDir)} is not a publishable Preflight Scout package.`);
}

if (mode === "clean") {
  await rm(path.join(packageDir, "dist"), { recursive: true, force: true });
  await rm(path.join(packageDir, "tsconfig.tsbuildinfo"), { force: true });
  console.log(`Cleaned build output for ${manifest.name}.`);
  process.exit(0);
}

const sourceFiles = await collectSourceFiles();
const inputs = await collectBuildInputs(sourceFiles);
const outputs = await collectBuildOutputs();
assertDeclaredEntrypoints(outputs);

const expected = {
  schemaVersion: 3,
  packageName: manifest.name,
  packageVersion: manifest.version,
  packageRuntimeHash: hashRuntimeManifest(manifest),
  sourceHash: await hashFiles(sourceIdentityInputs(sourceFiles)),
  inputHash: await hashFiles(inputs),
  outputs: await hashFileMap(outputs)
};

if (mode === "write") {
  await writeFile(stampPath, `${JSON.stringify(expected, null, 2)}\n`);
  console.log(`Recorded build integrity for ${manifest.name} (${outputs.length} files).`);
} else {
  let actual;
  try {
    actual = JSON.parse(await readFile(stampPath, "utf8"));
  } catch {
    throw new Error(`${manifest.name} has no valid dist/.preflight-scout-build.json. Run pnpm build before packing or publishing.`);
  }

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${manifest.name} dist is missing, changed, or stale. Run pnpm build before packing or publishing.`);
  }
  console.log(`Verified build integrity for ${manifest.name} (${outputs.length} files).`);
}

async function collectBuildInputs(sourceFiles) {
  return [
    { file: path.join(packageDir, "package.json"), label: relativePathLabel(root, path.join(packageDir, "package.json")) },
    { file: path.join(packageDir, "tsconfig.json"), label: relativePathLabel(root, path.join(packageDir, "tsconfig.json")) },
    { file: path.join(root, "package.json"), label: "package.json" },
    { file: path.join(root, "pnpm-lock.yaml"), label: "pnpm-lock.yaml" },
    { file: path.join(root, "pnpm-workspace.yaml"), label: "pnpm-workspace.yaml" },
    { file: path.join(root, "tsconfig.base.json"), label: "tsconfig.base.json" },
    { file: fileURLToPath(import.meta.url), label: "scripts/package-build-integrity.mjs" },
    { file: pathLabelsScript, label: "scripts/package-build-paths.mjs" },
    ...await resolveTypeScriptToolchainInputs(),
    ...sourceFiles.map((file) => ({ file, label: relativePathLabel(root, file) }))
  ];
}

async function collectSourceFiles() {
  return collectFiles(path.join(packageDir, "src"), (file) => !file.endsWith(".test.ts"));
}

function sourceIdentityInputs(sourceFiles) {
  return [
    { file: path.join(packageDir, "package.json"), label: relativePathLabel(root, path.join(packageDir, "package.json")) },
    ...sourceFiles.map((file) => ({ file, label: relativePathLabel(root, file) }))
  ];
}

async function resolveTypeScriptToolchainInputs() {
  const requireFromScript = createRequire(import.meta.url);
  let manifestPath;
  try {
    manifestPath = requireFromScript.resolve("typescript/package.json");
  } catch (error) {
    throw new Error("Cannot resolve the TypeScript compiler used by this workspace. Run pnpm install before building or verifying packages.", { cause: error });
  }

  const toolchainRoot = path.dirname(manifestPath);
  const toolchainManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const inputs = [{ file: manifestPath, label: "toolchain/typescript/package.json" }];
  const candidates = new Set([
    typeof toolchainManifest.bin === "string" ? toolchainManifest.bin : toolchainManifest.bin?.tsc,
    "lib/tsc.js",
    "lib/typescript.js",
    "lib/getExePath.js"
  ].filter(Boolean));

  for (const relative of candidates) {
    const file = path.resolve(toolchainRoot, relative);
    if (await exists(file)) inputs.push({ file, label: `toolchain/typescript/${portablePathLabel(relative)}` });
  }

  const baseName = toolchainManifest.name?.startsWith("@")
    ? toolchainManifest.name.split("/")[1]
    : toolchainManifest.name;
  const platformPackageName = baseName
    ? `@typescript/${baseName}-${process.platform}-${process.arch}`
    : undefined;
  if (platformPackageName && toolchainManifest.optionalDependencies?.[platformPackageName]) {
    const requireFromToolchain = createRequire(manifestPath);
    const platformManifestPath = requireFromToolchain.resolve(`${platformPackageName}/package.json`);
    const platformRoot = path.dirname(platformManifestPath);
    const platformManifest = JSON.parse(await readFile(platformManifestPath, "utf8"));
    const binaryName = Object.keys(toolchainManifest.bin ?? {})[0] ?? "tsc";
    const binaryPath = path.join(platformRoot, "lib", `${binaryName}${process.platform === "win32" ? ".exe" : ""}`);
    inputs.push({ file: platformManifestPath, label: "toolchain/typescript-platform/package.json" });
    if (!await exists(binaryPath)) throw new Error(`Resolved TypeScript platform compiler is missing: ${binaryPath}`);
    inputs.push({ file: binaryPath, label: "toolchain/typescript-platform/compiler" });
  }

  return inputs;
}

async function collectBuildOutputs() {
  const distDir = path.join(packageDir, "dist");
  try {
    await access(distDir);
  } catch {
    throw new Error(`${manifest.name} has no dist directory. Run pnpm build before packing or publishing.`);
  }
  const files = await collectFiles(distDir, (file) => file !== stampPath);
  if (files.length === 0) {
    throw new Error(`${manifest.name} dist directory is empty. Run pnpm build before packing or publishing.`);
  }
  return files.map((file) => ({ file, label: relativePathLabel(packageDir, file) }));
}

function assertDeclaredEntrypoints(outputs) {
  const outputNames = new Set(outputs.map(({ label }) => label));
  const declared = new Set([manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]);
  collectExportPaths(manifest.exports, declared);
  for (const entrypoint of declared) {
    if (typeof entrypoint !== "string") continue;
    const normalized = manifestPathLabel(entrypoint);
    if (!outputNames.has(normalized)) {
      throw new Error(`${manifest.name} is missing declared build entrypoint ${entrypoint}. Run pnpm build before packing or publishing.`);
    }
  }
}

function collectExportPaths(value, output) {
  if (typeof value === "string") {
    output.add(value);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const nested of Object.values(value)) collectExportPaths(nested, output);
}

async function hashFiles(entries) {
  const hash = createHash("sha256");
  for (const { file, label } of normalizeLabels(entries)) {
    const contents = await readFile(file);
    hash.update(`${label.length}:${label}:${contents.length}:`);
    hash.update(contents);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function hashFileMap(entries) {
  const output = {};
  for (const { file, label } of normalizeLabels(entries)) {
    output[label] = `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
  }
  return output;
}

function hashRuntimeManifest(value) {
  return `sha256:${createHash("sha256").update(stableSerialize({
    name: value.name,
    version: value.version,
    type: value.type,
    main: value.main,
    types: value.types,
    exports: value.exports,
    imports: value.imports,
    bin: value.bin,
    engines: value.engines,
    dependencies: canonicalizeInternalDependencyRanges(value.dependencies, value.version),
    optionalDependencies: canonicalizeInternalDependencyRanges(value.optionalDependencies, value.version),
    peerDependencies: canonicalizeInternalDependencyRanges(value.peerDependencies, value.version)
  }), "utf8").digest("hex")}`;
}

function canonicalizeInternalDependencyRanges(value, packageVersion) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof packageVersion !== "string") return value;
  return Object.fromEntries(Object.entries(value).map(([name, range]) => [
    name,
    name.startsWith("@preflight-scout/") && typeof range === "string" && range.startsWith("workspace:")
      ? packageVersion
      : range
  ]));
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    .join(",")}}`;
}

function normalizeLabels(entries) {
  const normalized = entries.map(({ file, label }) => ({ file, label: portablePathLabel(label) }));
  const labels = new Set();
  for (const { label } of normalized) {
    if (labels.has(label)) throw new Error(`Build-integrity path label is duplicated: ${label}`);
    labels.add(label);
  }
  return normalized.sort((a, b) => a.label.localeCompare(b.label));
}

async function collectFiles(directory, include) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(file, include));
    else if (entry.isFile() && include(file)) files.push(file);
  }
  return files;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
