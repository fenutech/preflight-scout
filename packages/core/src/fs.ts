import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createTrustedGit, type TrustedGit } from "./trusted-git.js";
import type { KnownRepoFileInventoryCoverage } from "./types.js";

const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "tmp",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".nuxt",
  ".output",
  ".auth",
  ".aws",
  ".docker",
  ".gnupg",
  ".kube",
  ".ssh",
  ".pnpm-store",
  // Deny-only legacy namespace. Preflight Scout never reads retired state,
  // including old configs or approvals, even when force-added to Git.
  ".preflight",
  "out",
  "target",
  "playwright-report",
  "test-results",
  "blob-report",
  // Deny-only legacy path: stale pre-release checkouts may still contain
  // credential-bearing Action state under the retired namespace.
  ".preflight-trusted-action",
  ".preflight-scout-trusted-action"
]);

const DEFAULT_IGNORED_PATHS = [
  // Deny-only legacy paths. They are not supported runtime locations, but
  // must remain excluded from LLM-facing inventories after an upgrade.
  ".preflight/auth",
  ".preflight/runs",
  ".preflight/package-check",
  ".preflight-scout/auth",
  ".preflight-scout/runs",
  ".preflight-scout/package-check",
  ".yarn/cache",
  "playwright/.auth"
];

const GENERATED_ARCHIVE_PATTERN = /\.(?:tgz|tar|tar\.gz|zip|7z|rar)$/i;
const GENERATED_METADATA_PATTERN = /\.tsbuildinfo$/i;
const STORAGE_STATE_PATTERN = /(?:^|[-_.])storage[-_.]?state(?:[-_.][^/]*)?\.json$/i;
const SENSITIVE_FILE_PATTERN = /^(?:\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.yarnrc(?:\.ya?ml)?|auth\.json|kubeconfig|id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?|google-services\.json|GoogleService-Info\.plist)$/i;
const SENSITIVE_DATA_FILE_PATTERN = /^(?:credentials|secrets?|tokens?|client[-_]secret|service[-_]account)(?:$|(?:[._-][^/]*)?\.(?:cfg|conf|config|env|ini|json|plist|properties|toml|txt|xml|ya?ml))$/i;
const SENSITIVE_FILE_EXTENSION_PATTERN = /\.(?:jks|key|keystore|mobileprovision|p12|pem|pfx)$/i;

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function walkFiles(root: string, options: { maxFiles?: number } = {}): Promise<string[]> {
  const result = await walkFilesWithCoverage(root, options);
  if (!result.coverage.complete) {
    throw new Error(`Repository inventory exceeds the ${result.coverage.maxFiles}-file limit. Use walkFilesWithCoverage() to handle incomplete inventory explicitly.`);
  }
  return result.files;
}

export interface WalkFilesResult {
  files: string[];
  coverage: KnownRepoFileInventoryCoverage;
}

export async function walkFilesWithCoverage(root: string, options: { maxFiles?: number } = {}): Promise<WalkFilesResult> {
  const maxFiles = options.maxFiles ?? 5000;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) {
    throw new Error("maxFiles must be a non-negative safe integer");
  }

  const git = await trustedGitForWorkTree(root);
  const result = git
    ? await walkGitVisibleFiles(root, maxFiles, git)
    : await walkFileSystem(root, maxFiles);

  return {
    files: result.files,
    coverage: {
      state: "known",
      maxFiles,
      includedFiles: result.files.length,
      complete: !result.truncated,
      ...(result.truncated ? {
        note: `Repository inventory reached the ${maxFiles}-file limit; additional safe files were omitted.`
      } : {})
    }
  };
}

/**
 * Returns whether a repo-relative path is safe and useful to include in an LLM-facing
 * repository inventory. Git ignore rules are applied separately by walkFiles; these
 * exclusions are intentionally unconditional so generated or credential-bearing
 * artifacts cannot leak merely because they were force-added to Git.
 */
export function isSafeIndexedPath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath) || /^[A-Za-z]:[\\/]/.test(relativePath)) return false;

  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return false;

  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  if (segments.some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment))) return false;
  if (DEFAULT_IGNORED_PATHS.some((ignored) => lower === ignored || lower.startsWith(`${ignored}/`) || lower.includes(`/${ignored}/`) || lower.endsWith(`/${ignored}`))) return false;

  const name = segments.at(-1) ?? "";
  if (name.startsWith(".env")) return false;
  if (
    GENERATED_ARCHIVE_PATTERN.test(name)
    || GENERATED_METADATA_PATTERN.test(name)
    || STORAGE_STATE_PATTERN.test(name)
    || SENSITIVE_FILE_PATTERN.test(name)
    || SENSITIVE_DATA_FILE_PATTERN.test(name)
    || SENSITIVE_FILE_EXTENSION_PATTERN.test(name)
  ) return false;
  return true;
}

async function trustedGitForWorkTree(root: string): Promise<TrustedGit | undefined> {
  try {
    const git = await createTrustedGit({ targetRoot: path.resolve(root) });
    const { stdout } = await git.exec(["rev-parse", "--is-inside-work-tree"], { cwd: root });
    return stdout.trim() === "true" ? git : undefined;
  } catch (error) {
    if (await hasGitMetadataInAncestors(root)) {
      throw new Error("Unable to inspect Git tracking and ignore rules safely.", { cause: error });
    }
    return undefined;
  }
}

async function hasGitMetadataInAncestors(root: string): Promise<boolean> {
  let current = path.resolve(root);
  while (true) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return true;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

interface BoundedFileWalk {
  files: string[];
  truncated: boolean;
}

async function walkGitVisibleFiles(root: string, maxFiles: number, git: TrustedGit): Promise<BoundedFileWalk> {
  const [tracked, untracked] = await Promise.all([
    listGitFiles(root, ["--cached"], git),
    listGitFiles(root, ["--others", "--exclude-standard"], git)
  ]);
  const candidates = [
    ...tracked.sort(),
    ...untracked.sort()
  ].filter(isSafeIndexedPath);
  const output: string[] = [];
  let truncated = false;

  for (const relative of new Set(candidates)) {
    try {
      const stat = await fs.lstat(path.join(root, relative));
      if (!isSafeRegularFile(stat)) continue;
      if (output.length >= maxFiles) {
        truncated = true;
        break;
      }
      output.push(relative);
    } catch {
      // A tracked path may have been deleted from the worktree between Git listing and indexing.
    }
  }

  return { files: output.sort(), truncated };
}

async function listGitFiles(root: string, selection: string[], git: TrustedGit): Promise<string[]> {
  const { stdout } = await git.exec(
    ["ls-files", "-z", ...selection, "--", "."],
    {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024
    }
  );
  return stdout.split("\0").filter(Boolean);
}

async function walkFileSystem(root: string, maxFiles: number): Promise<BoundedFileWalk> {
  const output: string[] = [];
  let truncated = false;

  async function visit(current: string): Promise<void> {
    if (truncated) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (truncated) break;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (!isSafeIndexedPath(relative)) continue;
      if (entry.isDirectory()) {
        if (await pathExists(path.join(absolute, ".git"))) continue;
        await visit(absolute);
      } else if (entry.isFile()) {
        try {
          const stats = await fs.lstat(absolute);
          if (!isSafeRegularFile(stats)) continue;
          if (output.length >= maxFiles) {
            truncated = true;
            break;
          }
          output.push(relative);
        } catch {
          // The entry may have changed after readdir; omit it rather than
          // following a replacement into LLM-facing repository context.
        }
      }
    }
  }

  await visit(root);
  return { files: output.sort(), truncated };
}

export interface BoundaryPathOptions {
  boundary?: string;
  maxBytes?: number;
}

export interface ReadTextOptions extends BoundaryPathOptions {
  /**
   * Advisory callers such as repository indexing may omit oversized files.
   * Structured configuration and artifact readers must keep the default
   * fail-closed `reject` behavior.
   */
  oversize?: "reject" | "omit";
}

export async function readTextIfExists(filePath: string, options: ReadTextOptions = {}): Promise<string | undefined> {
  const resolved = path.resolve(filePath);
  const boundary = options.boundary ?? await findGitRootFromPath(path.dirname(resolved));
  if (boundary) {
    await assertPathHasNoSymlinks(boundary, resolved, { allowMissing: true, leafType: "file" });
  } else {
    try {
      const stats = await fs.lstat(resolved);
      if (!isSafeRegularFile(stats)) {
        throw new Error(`Refusing to read non-regular file ${resolved}`);
      }
    } catch (error) {
      if (isMissingPathError(error)) return undefined;
      throw error;
    }
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Refusing to read non-regular file ${resolved}`);
    if (stats.nlink !== 1) throw new Error(`Refusing to read hard-linked file ${resolved}`);
    const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("maxBytes must be a non-negative safe integer");
    const omitOversized = options.oversize === "omit";
    if (stats.size > maxBytes) {
      if (omitOversized) return undefined;
      throw new Error(`Refusing to read oversized text file ${resolved}: ${stats.size} bytes exceeds ${maxBytes}`);
    }
    return await readBoundedText(handle, maxBytes, resolved, omitOversized);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function readBoundedText(
  handle: FileHandle,
  maxBytes: number,
  filePath: string,
  omitOversized: boolean
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      if (omitOversized) return undefined;
      throw new Error(`Refusing to read oversized text file ${filePath}: content exceeds ${maxBytes} bytes`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    chunks.push(buffer.subarray(0, bytesRead));
  }
  if (total > maxBytes) {
    if (omitOversized) return undefined;
    throw new Error(`Refusing to read oversized text file ${filePath}: content exceeds ${maxBytes} bytes`);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export interface WriteTextOptions extends BoundaryPathOptions {
  mode?: number;
}

export async function writeTextEnsuringDir(filePath: string, contents: string, options: WriteTextOptions = {}): Promise<void> {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  const repositoryBoundary = options.boundary ?? await findGitRootFromPath(parent);
  const anchor = repositoryBoundary ? path.resolve(repositoryBoundary) : await nearestExistingDirectory(parent);

  await ensureSafeDirectoryPath(anchor, parent);
  await assertWritableTarget(resolved);

  const temporaryPath = path.join(parent, `.${path.basename(resolved)}.preflight-scout-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", options.mode ?? 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await ensureSafeDirectoryPath(anchor, parent);
    await assertWritableTarget(resolved);
    if (process.platform === "win32") await fs.rm(resolved, { force: true });
    await fs.rename(temporaryPath, resolved);
  } finally {
    await handle?.close();
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function assertPathHasNoSymlinks(
  boundary: string,
  candidate: string,
  options: { allowMissing?: boolean; leafType?: "any" | "file" | "directory" } = {}
): Promise<void> {
  const resolvedBoundary = path.resolve(boundary);
  const resolvedCandidate = path.resolve(candidate);
  if (!isPathWithin(resolvedBoundary, resolvedCandidate)) {
    throw new Error(`Refusing path outside trusted boundary ${resolvedBoundary}: ${resolvedCandidate}`);
  }

  const relative = path.relative(resolvedBoundary, resolvedCandidate);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let cursor = resolvedBoundary;
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) cursor = path.join(cursor, segments[index - 1]!);
    const isLeaf = index === segments.length;
    try {
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink()) throw new Error(`Refusing path that traverses symbolic link ${cursor}`);
      if (!isLeaf && !stats.isDirectory()) throw new Error(`Refusing path with non-directory ancestor ${cursor}`);
      if (isLeaf && options.leafType === "file" && !stats.isFile()) {
        throw new Error(`Refusing non-regular file ${cursor}`);
      }
      if (isLeaf && options.leafType === "file" && stats.nlink !== 1) {
        throw new Error(`Refusing hard-linked file ${cursor}`);
      }
      if (isLeaf && options.leafType === "directory" && !stats.isDirectory()) {
        throw new Error(`Refusing non-directory path ${cursor}`);
      }
    } catch (error) {
      if (isMissingPathError(error) && options.allowMissing !== false) return;
      throw error;
    }
  }
}

export async function ensureSafeDirectoryForWrite(boundary: string, directory: string): Promise<void> {
  await ensureSafeDirectoryPath(path.resolve(boundary), path.resolve(directory));
}

async function nearestExistingDirectory(candidate: string): Promise<string> {
  let cursor = path.resolve(candidate);
  for (;;) {
    try {
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Refusing write through unsafe directory ${cursor}`);
      }
      return cursor;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Could not find a safe existing directory for ${candidate}`);
    cursor = parent;
  }
}

async function findGitRootFromPath(start: string): Promise<string | undefined> {
  let cursor = path.resolve(start);
  for (;;) {
    try {
      await fs.lstat(path.join(cursor, ".git"));
      return cursor;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

async function ensureSafeDirectoryPath(boundary: string, directory: string): Promise<void> {
  const resolvedBoundary = path.resolve(boundary);
  const resolvedDirectory = path.resolve(directory);
  if (!isPathWithin(resolvedBoundary, resolvedDirectory)) {
    throw new Error(`Refusing write outside trusted boundary ${resolvedBoundary}: ${resolvedDirectory}`);
  }

  const relative = path.relative(resolvedBoundary, resolvedDirectory);
  let cursor = resolvedBoundary;
  const boundaryStats = await fs.lstat(cursor);
  if (boundaryStats.isSymbolicLink() || !boundaryStats.isDirectory()) {
    throw new Error(`Refusing unsafe write boundary ${cursor}`);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Refusing write through unsafe directory ${cursor}`);
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        await fs.mkdir(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const stats = await fs.lstat(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Refusing write through unsafe directory ${cursor}`);
      }
    }
  }
}

async function assertWritableTarget(filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Refusing to replace non-regular file ${filePath}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSafeRegularFile(stats: Stats): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1;
}
