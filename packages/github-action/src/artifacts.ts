import artifact from "@actions/artifact";
import {
  readAnalysisArtifactBundle,
  type AnalysisManifest
} from "@preflight-scout/core";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_ARTIFACT_FILES = 5_000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SINGLE_ARTIFACT_BYTES = 512 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

type ArtifactUploader = (
  name: string,
  files: string[],
  rootDirectory: string,
  options: { compressionLevel: number }
) => Promise<{ id?: number }>;

export interface ArtifactUploadDependencies {
  uploader?: ArtifactUploader;
  /** Deterministic race seam used only by the package's security regressions. */
  beforeSourceOpen?: (relativePath: string) => void | Promise<void>;
  afterSourceOpen?: (relativePath: string) => void | Promise<void>;
  /** Deterministic staging-root seam used only by the package's security regressions. */
  stagingBase?: string;
}

interface DeclaredArtifact {
  relativePath: string;
  sha256: string;
}

interface StagedArtifact {
  root: string;
  files: string[];
  cleanupRoot: string;
}

const defaultUploader: ArtifactUploader = (name, files, rootDirectory, options) =>
  artifact.uploadArtifact(name, files, rootDirectory, options);

export async function uploadReportArtifact(
  outputDir: string,
  name: string,
  boundary: string,
  dependencies: ArtifactUploadDependencies = {}
): Promise<number | undefined> {
  const staged = await stageValidatedArtifactBundle(outputDir, boundary, dependencies);
  try {
    const response = await (dependencies.uploader ?? defaultUploader)(
      name,
      staged.files,
      staged.root,
      { compressionLevel: 6 }
    );
    return response.id;
  } finally {
    await fs.rm(staged.cleanupRoot, { recursive: true, force: true });
  }
}

async function stageValidatedArtifactBundle(
  outputDir: string,
  boundary: string,
  dependencies: ArtifactUploadDependencies
): Promise<StagedArtifact> {
  const sourceRoot = path.resolve(outputDir);
  await assertSafeSourceRoot(sourceRoot);
  const bundle = await readAnalysisArtifactBundle(sourceRoot, boundary);
  const declared = declaredArtifacts(bundle.manifest, bundle.manifestSha256);
  if (declared.length > MAX_ARTIFACT_FILES) {
    throw new Error(`Refusing artifact upload with more than ${MAX_ARTIFACT_FILES} files.`);
  }

  const stagingBase = await resolvePrivateStagingBase(sourceRoot, boundary, dependencies.stagingBase);
  const cleanupRoot = await fs.mkdtemp(path.join(stagingBase, "preflight-scout-action-upload-"));
  const stagingRoot = path.join(cleanupRoot, "artifact");
  try {
    await fs.chmod(cleanupRoot, 0o700);
    await fs.mkdir(stagingRoot, { mode: 0o700 });
    await fs.chmod(stagingRoot, 0o700);

    const stagedFiles: string[] = [];
    let totalBytes = 0;
    for (const entry of declared) {
      const remainingBytes = MAX_ARTIFACT_BYTES - totalBytes;
      if (remainingBytes < 0) {
        throw new Error(`Refusing artifact upload larger than ${MAX_ARTIFACT_BYTES} bytes.`);
      }
      const copiedBytes = await copyDeclaredArtifact({
        sourceRoot,
        stagingRoot,
        entry,
        maxBytes: Math.min(MAX_SINGLE_ARTIFACT_BYTES, remainingBytes),
        beforeSourceOpen: dependencies.beforeSourceOpen,
        afterSourceOpen: dependencies.afterSourceOpen
      });
      totalBytes += copiedBytes;
      if (totalBytes > MAX_ARTIFACT_BYTES) {
        throw new Error(`Refusing artifact upload larger than ${MAX_ARTIFACT_BYTES} bytes.`);
      }
      stagedFiles.push(path.join(stagingRoot, ...entry.relativePath.split("/")));
    }
    return { root: stagingRoot, files: stagedFiles, cleanupRoot };
  } catch (error) {
    await fs.rm(cleanupRoot, { recursive: true, force: true });
    throw error;
  }
}

function declaredArtifacts(manifest: AnalysisManifest, manifestSha256: string): DeclaredArtifact[] {
  const byPath = new Map<string, string>();
  const add = (relativePath: string, sha256: string): void => {
    assertSafeRelativePath(relativePath);
    const previous = byPath.get(relativePath);
    if (previous && previous !== sha256) {
      throw new Error("Refusing artifact upload because the manifest declares conflicting file digests.");
    }
    byPath.set(relativePath, sha256);
  };

  add("analysis-manifest.json", manifestSha256);
  add("impact-map.json", manifest.artifacts.impactMapSha256);
  add("mission.json", manifest.artifacts.missionSha256);
  add("report.md", manifest.artifacts.reportMarkdownSha256);
  add("report.html", manifest.artifacts.reportHtmlSha256);
  add("report-summary.json", manifest.artifacts.reportSummarySha256);
  if (manifest.artifacts.reportPdfSha256) add("report.pdf", manifest.artifacts.reportPdfSha256);
  if (manifest.artifacts.currentResults) {
    add(manifest.artifacts.currentResults.path, manifest.artifacts.currentResults.sha256);
    for (const evidence of manifest.artifacts.currentResults.evidence) {
      add(evidence.path, evidence.sha256);
    }
  }

  return [...byPath.entries()]
    .map(([relativePath, sha256]) => ({ relativePath, sha256 }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function copyDeclaredArtifact(options: {
  sourceRoot: string;
  stagingRoot: string;
  entry: DeclaredArtifact;
  maxBytes: number;
  beforeSourceOpen?: ArtifactUploadDependencies["beforeSourceOpen"];
  afterSourceOpen?: ArtifactUploadDependencies["afterSourceOpen"];
}): Promise<number> {
  const { sourceRoot, stagingRoot, entry } = options;
  if (options.maxBytes < 0) {
    throw new Error(`Refusing artifact upload larger than ${MAX_ARTIFACT_BYTES} bytes.`);
  }
  const segments = entry.relativePath.split("/");
  const sourcePath = path.join(sourceRoot, ...segments);
  await assertNoSymlinkComponents(sourceRoot, sourcePath);
  await assertCanonicalSourcePath(sourceRoot, sourcePath);
  const leafBeforeOpen = await fs.lstat(sourcePath);
  if (!leafBeforeOpen.isFile() || leafBeforeOpen.isSymbolicLink() || leafBeforeOpen.nlink !== 1) {
    throw new Error(`Refusing non-regular or hard-linked declared artifact: ${entry.relativePath}`);
  }
  await options.beforeSourceOpen?.(entry.relativePath);

  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  try {
    source = await fs.open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await source.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== leafBeforeOpen.dev
      || before.ino !== leafBeforeOpen.ino
      || before.size !== leafBeforeOpen.size
    ) {
      throw new Error(`Refusing non-regular or hard-linked declared artifact: ${entry.relativePath}`);
    }
    if (before.size > options.maxBytes || before.size > MAX_SINGLE_ARTIFACT_BYTES) {
      throw new Error("Refusing artifact upload because a declared file exceeds its bounded size.");
    }
    await options.afterSourceOpen?.(entry.relativePath);

    const destinationPath = path.join(stagingRoot, ...segments);
    await ensurePrivateParents(stagingRoot, segments.slice(0, -1));
    destination = await fs.open(destinationPath, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      copied += bytesRead;
      if (copied > before.size || copied > options.maxBytes || copied > MAX_SINGLE_ARTIFACT_BYTES) {
        throw new Error("Refusing artifact upload because a declared file changed or exceeded its bounded size while staging.");
      }
      hash.update(buffer.subarray(0, bytesRead));
      await writeAll(destination, buffer, bytesRead);
    }
    const after = await source.stat();
    if (
      copied !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.nlink !== 1
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error("Refusing artifact upload because a declared file changed while staging.");
    }
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== entry.sha256) {
      throw new Error(`Refusing artifact upload because ${entry.relativePath} no longer matches its declared digest.`);
    }
    await destination.sync();
    await destination.chmod(0o600);
    await assertNoSymlinkComponents(sourceRoot, sourcePath);
    await assertCanonicalSourcePath(sourceRoot, sourcePath);
    return copied;
  } catch (error) {
    throw sanitizeStagingError(error, entry.relativePath);
  } finally {
    await destination?.close();
    await source?.close();
  }
}

async function writeAll(destination: FileHandle, buffer: Buffer, bytes: number): Promise<void> {
  let offset = 0;
  while (offset < bytes) {
    const result = await destination.write(buffer, offset, bytes - offset, null);
    if (result.bytesWritten <= 0) throw new Error("Could not stage a declared artifact completely.");
    offset += result.bytesWritten;
  }
}

async function ensurePrivateParents(root: string, segments: string[]): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Could not create a private artifact staging directory.");
    }
    await fs.chmod(current, 0o700);
  }
}

async function assertSafeSourceRoot(root: string): Promise<void> {
  const stats = await fs.lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Refusing artifact upload from an unsafe output directory.");
  }
}

async function resolvePrivateStagingBase(
  sourceRoot: string,
  boundary: string,
  testOverride?: string
): Promise<string> {
  const candidates = testOverride
    ? [testOverride]
    : [process.env.RUNNER_TEMP, tmpdir()].filter((value): value is string => Boolean(value));
  const [canonicalSource, canonicalBoundary] = await Promise.all([
    fs.realpath(sourceRoot),
    fs.realpath(path.resolve(boundary))
  ]);
  for (const value of [...new Set(candidates)]) {
    if (!path.isAbsolute(value)) continue;
    try {
      const candidate = path.resolve(value);
      const canonicalCandidate = await fs.realpath(candidate);
      const stats = await fs.lstat(canonicalCandidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
      if (
        isPathWithin(canonicalSource, canonicalCandidate)
        || isPathWithin(canonicalBoundary, canonicalCandidate)
      ) continue;
      return canonicalCandidate;
    } catch {
      // Try the next runner-owned temporary root without exposing its path.
    }
  }
  throw new Error("Refusing artifact upload because no safe runner temporary directory is available.");
}

async function assertCanonicalSourcePath(root: string, candidate: string): Promise<void> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Refusing a declared artifact outside the output directory.");
  }
}

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Refusing a declared artifact outside the output directory.");
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error("Refusing a declared artifact through a symbolic link.");
    }
  }
}

function assertSafeRelativePath(value: string): void {
  if (
    !value
    || value.includes("\\")
    || value.includes("\0")
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("Refusing an unsafe path declared by the analysis manifest.");
  }
}

function sanitizeStagingError(error: unknown, relativePath: string): Error {
  if (error instanceof Error && !error.message.includes(path.sep)) return error;
  return new Error(`Refusing artifact upload because ${relativePath} could not be staged safely.`);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
