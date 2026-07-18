import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync
} from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustedGit } from "./trusted-git.js";
import {
  BuildIdentityReadError,
  readBuildIdentityFileSync,
  resolvePackageRuntimePaths
} from "./build-identity-file.js";
import { indexRepository } from "./repo-indexer.js";
import { redactRepoIndex } from "./redaction.js";
import type {
  AnalysisManifest,
  AnalysisProvenance,
  AnalysisRuntimeIdentity,
  QAContract,
  RepoIndex
} from "./types.js";

const packageManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
) as { version?: unknown };
const MAX_BUILD_STAMP_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_OUTPUT_FILES = 5_000;
const MAX_PACKAGE_OUTPUT_BYTES = 512 * 1024 * 1024;

export const ANALYSIS_MANIFEST_SCHEMA_VERSION = 2 as const;
export const PREFLIGHT_SCOUT_VERSION = requireToolVersion(packageManifest.version);
export const ANALYSIS_SCHEMA_DIGEST = sha256Text(
  "preflight-scout-analysis-schema-v2\0impact-map-v1\0qa-mission-v1\0mission-run-results-v1\0phase-runtime-identities-v1"
);
export const PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST = resolvePackageRuntimeIdentity(
  import.meta.url,
  "@preflight-scout/core"
);
export const PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME: AnalysisRuntimeIdentity = Object.freeze({
  entrypoint: "core-api",
  digest: createCompositeRuntimeDigest("analysis:core-api", {
    core: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
  }),
  coreDigest: PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST
});
/** Backward-compatible export name for callers that only need the core API identity. */
export const PREFLIGHT_SCOUT_TOOL_DIGEST = PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME.digest;

export async function createAnalysisProvenance(options: {
  root: string;
  baseCommit: string;
  headCommit: string;
  contract: QAContract;
  repoIndex?: RepoIndex;
  createdAt?: string;
  analysisRuntime?: AnalysisRuntimeIdentity;
}): Promise<AnalysisProvenance> {
  const analysisRuntime = options.analysisRuntime ?? PREFLIGHT_SCOUT_CORE_ANALYSIS_RUNTIME;
  requireAnalysisRuntimeIdentity(analysisRuntime);
  if (analysisRuntime.coreDigest !== PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST) {
    throw new Error("Cannot bind analysis provenance: the analysis entrypoint does not use this exact Preflight Scout core package code/build.");
  }
  return {
    createdAt: options.createdAt ?? new Date().toISOString(),
    toolVersion: PREFLIGHT_SCOUT_VERSION,
    analysisRuntime: { ...analysisRuntime },
    schemaDigest: ANALYSIS_SCHEMA_DIGEST,
    repositoryDigest: await repositoryIdentityDigest(options.root),
    repositoryContextDigest: sha256Text(
      `preflight-scout-repository-context-v1\0${stableSerialize(redactRepoIndex(options.repoIndex ?? await indexRepository(options.root)))}`
    ),
    baseCommit: requireGitCommit(options.baseCommit, "base commit"),
    headCommit: requireGitCommit(options.headCommit, "head commit"),
    contractDigest: sha256Text(`preflight-scout-contract-v1\0${stableSerialize(options.contract)}`)
  };
}

export function provenanceFromManifest(manifest: AnalysisManifest): AnalysisProvenance {
  return {
    createdAt: manifest.createdAt,
    toolVersion: manifest.toolVersion,
    analysisRuntime: { ...manifest.analysisRuntime },
    schemaDigest: manifest.schemaDigest,
    repositoryDigest: manifest.repositoryDigest,
    repositoryContextDigest: manifest.repositoryContextDigest,
    baseCommit: manifest.baseCommit,
    headCommit: manifest.headCommit,
    contractDigest: manifest.contractDigest
  };
}

export function assertAnalysisProvenanceMatches(
  actual: AnalysisManifest,
  expected: AnalysisProvenance
): void {
  if (actual.toolVersion !== expected.toolVersion) {
    throw provenanceMismatch(
      `the artifacts were created by Preflight Scout ${actual.toolVersion}, but this runtime is ${expected.toolVersion}`
    );
  }
  if (
    actual.analysisRuntime.entrypoint !== expected.analysisRuntime.entrypoint
    || actual.analysisRuntime.digest !== expected.analysisRuntime.digest
    || actual.analysisRuntime.coreDigest !== expected.analysisRuntime.coreDigest
  ) {
    throw provenanceMismatch("the exact Preflight Scout analysis-producer package code/build has changed");
  }
  if (actual.schemaDigest !== expected.schemaDigest) {
    throw provenanceMismatch("the analysis artifact schema has changed");
  }
  if (actual.repositoryDigest !== expected.repositoryDigest) {
    throw provenanceMismatch("the artifacts belong to a different repository");
  }
  if (actual.repositoryContextDigest !== expected.repositoryContextDigest) {
    throw provenanceMismatch("the indexed repository context has changed");
  }
  if (actual.baseCommit !== expected.baseCommit) {
    throw provenanceMismatch("the reviewed base commit has changed");
  }
  if (actual.headCommit !== expected.headCommit) {
    throw provenanceMismatch("the reviewed head commit has changed");
  }
  if (actual.contractDigest !== expected.contractDigest) {
    throw provenanceMismatch("the Preflight Scout contract has changed");
  }
}

export function assertAnalysisRuntimeCompatible(manifest: AnalysisManifest): void {
  if (manifest.toolVersion !== PREFLIGHT_SCOUT_VERSION) {
    throw provenanceMismatch(
      `the artifacts were created by Preflight Scout ${manifest.toolVersion}, but this runtime is ${PREFLIGHT_SCOUT_VERSION}`
    );
  }
  if (manifest.analysisRuntime.coreDigest !== PREFLIGHT_SCOUT_CORE_RUNTIME_DIGEST) {
    throw provenanceMismatch("the exact Preflight Scout core report package code/build has changed");
  }
  if (manifest.schemaDigest !== ANALYSIS_SCHEMA_DIGEST) {
    throw provenanceMismatch("the analysis artifact schema has changed");
  }
}

export function sha256Text(contents: string): string {
  return `sha256:${createHash("sha256").update(contents, "utf8").digest("hex")}`;
}

export function createCompositeRuntimeDigest(
  phase: string,
  contributors: Readonly<Record<string, string>>
): string {
  if (!/^[a-z][a-z0-9:-]{2,63}$/.test(phase)) {
    throw new Error("Preflight Scout runtime identity phase is invalid.");
  }
  const entries = Object.entries(contributors)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!entries.length) throw new Error("Preflight Scout runtime identity has no contributors.");
  for (const [label, digest] of entries) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(label) || !isSha256(digest)) {
      throw new Error("Preflight Scout runtime identity contributor is invalid.");
    }
  }
  return sha256Text(`preflight-scout-runtime-v1\0${PREFLIGHT_SCOUT_VERSION}\0${ANALYSIS_SCHEMA_DIGEST}\0${phase}\0${stableSerialize(Object.fromEntries(entries))}`);
}

export function analysisRerunInstruction(reason: string): Error {
  return new Error(
    `Refusing reviewed analysis reuse because ${reason}. `
    + "Rerun `preflight-scout analyze` for the current repository and diff, review the regenerated artifacts, then retry using the new analysis directory."
  );
}

async function repositoryIdentityDigest(root: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  const git = await createTrustedGit({ targetRoot: resolvedRoot });
  try {
    const { stdout } = await git.exec(["remote", "get-url", "--all", "origin"], {
      cwd: resolvedRoot,
      maxBuffer: 64 * 1024
    });
    const remotes = stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => normalizeRemoteIdentity(value, resolvedRoot))
      .sort();
    if (remotes.length) {
      return sha256Text(`preflight-scout-repository-v1\0origin\0${stableSerialize(remotes)}`);
    }
  } catch {
    // A repository without origin remains safely reusable only inside the same
    // local Git common directory. The raw path is hashed and never persisted.
  }

  const { stdout } = await git.exec(["rev-parse", "--git-common-dir"], {
    cwd: resolvedRoot,
    maxBuffer: 64 * 1024
  });
  const commonDir = path.resolve(resolvedRoot, stdout.trim());
  const canonicalCommonDir = await realpath(commonDir);
  return sha256Text(`preflight-scout-repository-v1\0local\0${canonicalCommonDir}`);
}

function normalizeRemoteIdentity(value: string, root: string): string {
  if (isWindowsDrivePath(value) || isWindowsUncPath(value)) {
    return normalizeWindowsLocalIdentity(value);
  }
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    if (parsed.protocol === "file:") {
      const windowsFile = Boolean(parsed.host) || /^\/[A-Za-z]:[\\/]/.test(parsed.pathname);
      const localPath = fileURLToPath(parsed, { windows: windowsFile });
      return windowsFile
        ? normalizeWindowsLocalIdentity(localPath)
        : `file://${path.resolve(root, localPath)}`;
    }
    const pathname = normalizeRepositoryPath(parsed.pathname);
    if (parsed.host) return `remote://${parsed.host.toLowerCase()}${pathname}`;
    return `file://${path.resolve(root, value)}`;
  } catch {
    const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    if (scp?.[1] && scp[2]) {
      return `remote://${scp[1].toLowerCase()}${normalizeRepositoryPath(`/${scp[2]}`)}`;
    }
    return `file://${path.resolve(root, value)}`;
  }
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isWindowsUncPath(value: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

function normalizeWindowsLocalIdentity(value: string): string {
  let normalized = path.win32.normalize(value).replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (/^[A-Za-z]:/.test(normalized)) normalized = `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`;
  if (normalized.startsWith("//")) {
    const [host, share, ...rest] = normalized.slice(2).split("/");
    normalized = `//${host!.toLowerCase()}/${share!.toLowerCase()}${rest.length ? `/${rest.join("/")}` : ""}`;
  }
  return `file-win:${normalized}`;
}

function normalizeRepositoryPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function requireToolVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Preflight Scout package version metadata is invalid.");
  }
  return value;
}

export function resolvePackageRuntimeIdentity(moduleUrl: string, expectedPackageName: string): string {
  const { modulePath, packageRoot, packageManifestPath } = resolvePackageRuntimePaths(moduleUrl);
  let installedManifest: { name?: unknown; version?: unknown };
  try {
    installedManifest = JSON.parse(readBuildIdentityFileSync(packageManifestPath, 1024 * 1024).toString("utf8"));
  } catch (error) {
    throw packageIdentityError(expectedPackageName, packageMetadataFailure(error));
  }
  if (installedManifest.name !== expectedPackageName || installedManifest.version !== PREFLIGHT_SCOUT_VERSION) {
    throw packageIdentityError(expectedPackageName, "package metadata does not match this release");
  }
  const currentSourceHash = computeCurrentPackageSourceHash(packageRoot, expectedPackageName);
  const moduleLabel = path.relative(packageRoot, modulePath).split(path.sep).join("/");
  if (moduleLabel.startsWith("src/")) {
    if (!currentSourceHash) throw packageIdentityError(expectedPackageName, "source identity is unavailable");
    return sha256Text(`preflight-scout-package-source-v1\0${expectedPackageName}\0${currentSourceHash}`);
  }
  if (!moduleLabel.startsWith("dist/")) {
    throw packageIdentityError(expectedPackageName, "loaded from an unsupported package location");
  }
  return verifyPackageDistBuildIdentity(
    packageRoot,
    modulePath,
    expectedPackageName,
    PREFLIGHT_SCOUT_VERSION,
    currentSourceHash
  );
}

/** Package-private test seam; the package export map does not expose this module. */
export function verifyCoreDistBuildIdentity(
  packageDirectory: string,
  modulePath: string,
  expectedSourceHash?: string
): string {
  return verifyPackageDistBuildIdentity(
    packageDirectory,
    modulePath,
    "@preflight-scout/core",
    PREFLIGHT_SCOUT_VERSION,
    expectedSourceHash
  );
}

/** Package-private test seam for exact identities of every published runtime package. */
export function verifyPackageDistBuildIdentity(
  packageDirectory: string,
  modulePath: string,
  expectedPackageName: string,
  expectedPackageVersion: string,
  expectedSourceHash?: string
): string {
  const stampPath = path.join(packageDirectory, "dist", ".preflight-scout-build.json");
  let stamp: {
    schemaVersion?: unknown;
    packageName?: unknown;
    packageVersion?: unknown;
    packageRuntimeHash?: unknown;
    sourceHash?: unknown;
    inputHash?: unknown;
    outputs?: unknown;
  };
  try {
    stamp = JSON.parse(readBuildIdentityFileSync(stampPath, MAX_BUILD_STAMP_BYTES).toString("utf8"));
  } catch {
    throw packageIdentityError(expectedPackageName, "the build stamp is missing or malformed");
  }
  if (
    stamp.schemaVersion !== 3
    || stamp.packageName !== expectedPackageName
    || stamp.packageVersion !== expectedPackageVersion
    || typeof stamp.packageRuntimeHash !== "string"
    || !isSha256(stamp.packageRuntimeHash)
    || typeof stamp.sourceHash !== "string"
    || !isSha256(stamp.sourceHash)
    || typeof stamp.inputHash !== "string"
    || !isSha256(stamp.inputHash)
    || !stamp.outputs
    || typeof stamp.outputs !== "object"
    || Array.isArray(stamp.outputs)
  ) {
    throw packageIdentityError(expectedPackageName, "the build stamp is invalid");
  }
  if (expectedSourceHash && expectedSourceHash !== stamp.sourceHash) {
    throw packageIdentityError(expectedPackageName, "source and build stamp differ");
  }
  const packageManifestPath = path.join(packageDirectory, "package.json");
  let installedManifest: unknown;
  try {
    installedManifest = JSON.parse(readBuildIdentityFileSync(packageManifestPath, 1024 * 1024).toString("utf8"));
  } catch (error) {
    throw packageIdentityError(expectedPackageName, packageMetadataFailure(error));
  }
  if (hashRuntimeManifest(installedManifest) !== stamp.packageRuntimeHash) {
    throw packageIdentityError(expectedPackageName, "package metadata changed after build");
  }

  const outputEntries = Object.entries(stamp.outputs as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!outputEntries.length || outputEntries.length > MAX_PACKAGE_OUTPUT_FILES) {
    throw packageIdentityError(expectedPackageName, "the declared output count is invalid");
  }
  const loadedModuleLabel = path.relative(packageDirectory, modulePath).split(path.sep).join("/");
  let loadedModuleDeclared = false;
  let totalOutputBytes = 0;
  for (const [label, expectedDigest] of outputEntries) {
    if (!isSafeDistOutputLabel(label) || typeof expectedDigest !== "string" || !isSha256(expectedDigest)) {
      throw packageIdentityError(expectedPackageName, "a declared output is invalid");
    }
    const outputPath = path.resolve(packageDirectory, ...label.split("/"));
    const relativeOutput = path.relative(packageDirectory, outputPath);
    if (path.isAbsolute(relativeOutput) || relativeOutput === ".." || relativeOutput.startsWith(`..${path.sep}`)) {
      throw packageIdentityError(expectedPackageName, "a declared output leaves the package");
    }
    let actualDigest: string;
    try {
      const contents = readBuildIdentityFileSync(outputPath, MAX_PACKAGE_OUTPUT_BYTES - totalOutputBytes);
      totalOutputBytes += contents.length;
      actualDigest = sha256Buffer(contents);
    } catch {
      throw packageIdentityError(expectedPackageName, "a declared output is missing or unsafe");
    }
    if (actualDigest !== expectedDigest) {
      throw packageIdentityError(expectedPackageName, "a packed output changed after build");
    }
    if (label === loadedModuleLabel) loadedModuleDeclared = true;
  }
  if (!loadedModuleDeclared) {
    throw packageIdentityError(expectedPackageName, "the loaded module is not a declared output");
  }
  return sha256Text(`preflight-scout-package-dist-v1\0${expectedPackageName}\0${stableSerialize({
    packageRuntimeHash: stamp.packageRuntimeHash,
    sourceHash: stamp.sourceHash,
    inputHash: stamp.inputHash,
    outputs: stamp.outputs
  })}`);
}

function computeCurrentPackageSourceHash(packageRoot: string, expectedPackageName: string): string | undefined {
  const sourceRoot = path.join(packageRoot, "src");
  let sourceFiles: string[];
  try {
    sourceFiles = collectSourceFilesSync(sourceRoot);
  } catch {
    return undefined;
  }
  const files = [path.join(packageRoot, "package.json"), ...sourceFiles]
    .map((file) => ({
      file,
      label: `packages/${expectedPackageName.slice(expectedPackageName.indexOf("/") + 1)}/${path.relative(packageRoot, file).split(path.sep).join("/")}`
    }))
    .sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
  const hash = createHash("sha256");
  for (const { file, label } of files) {
    const contents = readFileSync(file);
    hash.update(`${label.length}:${label}:${contents.length}:`);
    hash.update(contents);
  }
  return `sha256:${hash.digest("hex")}`;
}

function collectSourceFilesSync(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFilesSync(file));
    else if (entry.isFile() && !file.endsWith(".test.ts")) files.push(file);
  }
  return files;
}

function isSafeDistOutputLabel(label: string): boolean {
  if (!/^dist\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(label) || path.posix.isAbsolute(label)) return false;
  const segments = label.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..")
    && label !== "dist/.preflight-scout-build.json";
}

function isSha256(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function sha256Buffer(contents: Buffer): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function hashRuntimeManifest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Preflight Scout cannot establish an exact package build identity: package metadata is invalid.");
  }
  const manifest = value as Record<string, unknown>;
  const packageVersion = typeof manifest.version === "string" ? manifest.version : undefined;
  return sha256Text(stableSerialize({
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    main: manifest.main,
    types: manifest.types,
    exports: manifest.exports,
    imports: manifest.imports,
    bin: manifest.bin,
    engines: manifest.engines,
    dependencies: canonicalizeInternalDependencyRanges(manifest.dependencies, packageVersion),
    optionalDependencies: canonicalizeInternalDependencyRanges(manifest.optionalDependencies, packageVersion),
    peerDependencies: canonicalizeInternalDependencyRanges(manifest.peerDependencies, packageVersion)
  }));
}

function packageMetadataFailure(error: unknown): string {
  if (!(error instanceof BuildIdentityReadError)) return "package metadata is malformed";
  switch (error.failure) {
    case "unavailable":
      return "package metadata is unavailable";
    case "unsafe":
      return "package metadata is not a safe regular file";
    case "oversized":
      return "package metadata exceeds the safety limit";
    case "changed-before-read":
      return "package metadata changed before it could be read";
    case "changed-while-read":
      return "package metadata changed while it was read";
    case "device-identity-unavailable-before-read":
      return "package metadata has no comparable device identity before reading";
    case "device-identity-unavailable-while-read":
      return "package metadata has no comparable device identity while reading";
    case "device-identity-mismatch-before-read":
      return "package metadata path and handle device identities differ before reading";
    case "device-identity-mismatch-while-read":
      return "package metadata device identity changed while it was read";
    case "file-id-unavailable-before-read":
      return "package metadata has no comparable file identity before reading";
    case "file-id-unavailable-while-read":
      return "package metadata has no comparable file identity while reading";
    case "file-id-mismatch-before-read":
      return "package metadata path and handle file identities differ before reading";
    case "file-id-mismatch-while-read":
      return "package metadata file identity changed while it was read";
    case "snapshot-mismatch-before-read":
      return "package metadata path and handle snapshots differ before reading";
    case "snapshot-mismatch-while-read":
      return "package metadata snapshot changed while it was read";
  }
}

function canonicalizeInternalDependencyRanges(value: unknown, packageVersion?: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !packageVersion) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, range]) => [
    name,
    name.startsWith("@preflight-scout/") && typeof range === "string" && range.startsWith("workspace:")
      ? packageVersion
      : range
  ]));
}

function requireAnalysisRuntimeIdentity(identity: AnalysisRuntimeIdentity): void {
  if (
    !new Set(["core-api", "cli", "github-action"]).has(identity.entrypoint)
    || !isSha256(identity.digest)
    || !isSha256(identity.coreDigest)
  ) {
    throw new Error("Cannot bind analysis provenance: the analysis runtime identity is invalid.");
  }
}

function packageIdentityError(packageName: string, reason: string): Error {
  const label = /^@preflight-scout\/[a-z0-9-]+$/.test(packageName) ? packageName : "the runtime package";
  return new Error(`Preflight Scout cannot establish an exact ${label} build identity: ${reason}.`);
}

function requireGitCommit(value: string, label: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error(`Cannot bind analysis provenance: ${label} is not an exact Git commit object.`);
  }
  return value;
}

function provenanceMismatch(reason: string): Error {
  return analysisRerunInstruction(reason);
}
