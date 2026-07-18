import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BUILD_IDENTITY_FILE_BYTES = 512 * 1024 * 1024;

export type BuildIdentityReadFailure =
  | "unavailable"
  | "unsafe"
  | "oversized"
  | "changed-before-read"
  | "changed-while-read"
  | "device-identity-unavailable-before-read"
  | "device-identity-unavailable-while-read"
  | "device-identity-mismatch-before-read"
  | "device-identity-mismatch-while-read"
  | "file-id-unavailable-before-read"
  | "file-id-unavailable-while-read"
  | "file-id-mismatch-before-read"
  | "file-id-mismatch-while-read"
  | "snapshot-mismatch-before-read"
  | "snapshot-mismatch-while-read";

export class BuildIdentityReadError extends Error {
  constructor(readonly failure: BuildIdentityReadFailure) {
    super(`build identity file ${failure}`);
    this.name = "BuildIdentityReadError";
  }
}

export interface BuildIdentityStats {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface BuildIdentityFileOperations {
  lstat(filePath: string): BuildIdentityStats;
  stat(filePath: string): BuildIdentityStats;
  open(filePath: string, flags: number): number;
  fstat(descriptor: number): BuildIdentityStats;
  read(descriptor: number, buffer: Buffer, offset: number, length: number): number;
  close(descriptor: number): void;
}

export interface ReadBuildIdentityFileOptions {
  platform?: NodeJS.Platform;
  operations?: BuildIdentityFileOperations;
}

const nodeFileOperations: BuildIdentityFileOperations = {
  lstat: (filePath) => lstatSync(filePath, { bigint: true }),
  stat: (filePath) => statSync(filePath, { bigint: true }),
  open: (filePath, flags) => openSync(filePath, flags),
  fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
  read: (descriptor, buffer, offset, length) => readSync(descriptor, buffer, offset, length, null),
  close: (descriptor) => closeSync(descriptor)
};

/** Internal test seam for package paths derived from an ESM module URL. */
export function resolvePackageRuntimePaths(
  moduleUrl: string,
  platform: NodeJS.Platform = process.platform
): { modulePath: string; packageRoot: string; packageManifestPath: string } {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const modulePath = fileURLToPath(moduleUrl, { windows });
  const packageRoot = pathApi.dirname(pathApi.dirname(modulePath));
  return {
    modulePath,
    packageRoot,
    packageManifestPath: pathApi.join(packageRoot, "package.json")
  };
}

/** Internal test seam for platform-specific Node open flags. */
export function buildIdentityOpenFlags(
  platform: NodeJS.Platform = process.platform,
  noFollow: number | undefined = fsConstants.O_NOFOLLOW
): number {
  // Node does not support O_NOFOLLOW on Windows. The leaf lstat guards and
  // exact stat(path)-to-fstat(handle) identity checks below are mandatory
  // there; a runtime that cannot provide a comparable file ID fails closed.
  return fsConstants.O_RDONLY | (platform === "win32" ? 0 : (noFollow ?? 0));
}

export function readBuildIdentityFileSync(
  filePath: string,
  maxBytes: number,
  options: ReadBuildIdentityFileOptions = {}
): Buffer {
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes < 0
    || maxBytes > MAX_BUILD_IDENTITY_FILE_BYTES
  ) {
    throw new BuildIdentityReadError("oversized");
  }
  const operations = options.operations ?? nodeFileOperations;
  const platform = options.platform ?? process.platform;
  const limit = BigInt(maxBytes);

  const leafBefore = initialLeafStats(operations, filePath, limit);
  const pathBefore = comparablePathStats(
    operations,
    filePath,
    platform,
    leafBefore,
    limit,
    "changed-before-read"
  );

  let descriptor: number;
  try {
    descriptor = operations.open(filePath, buildIdentityOpenFlags(platform));
  } catch {
    throw new BuildIdentityReadError("changed-before-read");
  }

  try {
    let handleBefore: BuildIdentityStats;
    try {
      handleBefore = operations.fstat(descriptor);
    } catch {
      throw new BuildIdentityReadError("changed-before-read");
    }
    const pathAtOpen = comparablePathStats(
      operations,
      filePath,
      platform,
      leafBefore,
      limit,
      "changed-before-read"
    );
    if (
      !safeRegularFile(handleBefore, limit)
    ) {
      throw new BuildIdentityReadError("changed-before-read");
    }
    assertSameFileSnapshot(pathBefore, handleBefore, "before-read", platform);
    assertSameFileSnapshot(pathAtOpen, handleBefore, "before-read", platform);

    const contents = readDescriptorBounded(operations, descriptor, maxBytes);

    let handleAfter: BuildIdentityStats;
    try {
      handleAfter = operations.fstat(descriptor);
    } catch {
      throw new BuildIdentityReadError("changed-while-read");
    }
    const pathAfter = comparablePathStats(
      operations,
      filePath,
      platform,
      leafBefore,
      limit,
      "changed-while-read"
    );
    if (
      !safeRegularFile(handleAfter, limit)
      || BigInt(contents.length) !== handleBefore.size
    ) {
      throw new BuildIdentityReadError("changed-while-read");
    }
    assertSameFileSnapshot(handleBefore, handleAfter, "while-read", platform);
    assertSameFileSnapshot(pathAfter, handleAfter, "while-read", platform);
    return contents;
  } finally {
    try {
      operations.close(descriptor);
    } catch {
      throw new BuildIdentityReadError("changed-while-read");
    }
  }
}

function initialLeafStats(
  operations: BuildIdentityFileOperations,
  filePath: string,
  limit: bigint
): BuildIdentityStats {
  let leaf: BuildIdentityStats;
  try {
    leaf = operations.lstat(filePath);
  } catch {
    throw new BuildIdentityReadError("unavailable");
  }
  if (!leaf.isFile() || leaf.isSymbolicLink()) {
    throw new BuildIdentityReadError("unsafe");
  }
  if (leaf.size > limit) {
    throw new BuildIdentityReadError("oversized");
  }
  return leaf;
}

function comparablePathStats(
  operations: BuildIdentityFileOperations,
  filePath: string,
  platform: NodeJS.Platform,
  expectedLeaf: BuildIdentityStats,
  limit: bigint,
  failure: "changed-before-read" | "changed-while-read"
): BuildIdentityStats {
  try {
    const leafBefore = operations.lstat(filePath);
    if (!safeLeaf(leafBefore, limit)) {
      throw new BuildIdentityReadError(failure);
    }
    assertSameFileIdentity(expectedLeaf, leafBefore, failurePhase(failure), platform);

    // On Windows, stat(path) and fstat(handle) both query an opened target
    // handle and expose the file ID as ino. The volume ID is not comparable
    // across these Windows query paths, so it is deliberately ignored there.
    // lstat remains the separate non-following leaf guard. No metadata-only
    // fallback is allowed.
    const comparable = platform === "win32" ? operations.stat(filePath) : leafBefore;
    const leafAfter = platform === "win32" ? operations.lstat(filePath) : leafBefore;
    if (
      !safeRegularFile(comparable, limit)
      || !safeLeaf(leafAfter, limit)
    ) {
      throw new BuildIdentityReadError(failure);
    }
    assertSameFileIdentity(leafBefore, comparable, failurePhase(failure), platform);
    assertSameFileIdentity(comparable, leafAfter, failurePhase(failure), platform);
    assertSameFileIdentity(expectedLeaf, leafAfter, failurePhase(failure), platform);
    return comparable;
  } catch (error) {
    if (error instanceof BuildIdentityReadError) throw error;
    throw new BuildIdentityReadError(failure);
  }
}

function readDescriptorBounded(
  operations: BuildIdentityFileOperations,
  descriptor: number,
  maxBytes: number
): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    let bytesRead: number;
    try {
      bytesRead = operations.read(descriptor, chunk, 0, chunk.length);
    } catch {
      throw new BuildIdentityReadError("changed-while-read");
    }
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > chunk.length) {
      throw new BuildIdentityReadError("changed-while-read");
    }
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) throw new BuildIdentityReadError("changed-while-read");
  }
  return Buffer.concat(chunks, total);
}

function safeLeaf(stats: BuildIdentityStats, limit: bigint): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.size <= limit;
}

function safeRegularFile(stats: BuildIdentityStats, limit: bigint): boolean {
  return stats.isFile() && stats.size <= limit;
}

type IdentityFailurePhase = "before-read" | "while-read";

function failurePhase(
  failure: "changed-before-read" | "changed-while-read"
): IdentityFailurePhase {
  return failure === "changed-before-read" ? "before-read" : "while-read";
}

function assertSameFileIdentity(
  left: BuildIdentityStats,
  right: BuildIdentityStats,
  phase: IdentityFailurePhase,
  platform: NodeJS.Platform
): void {
  assertComparableIdentity(left, phase, platform);
  assertComparableIdentity(right, phase, platform);
  if (platform !== "win32" && left.dev !== right.dev) {
    throw new BuildIdentityReadError(`device-identity-mismatch-${phase}`);
  }
  if (left.ino !== right.ino) {
    throw new BuildIdentityReadError(`file-id-mismatch-${phase}`);
  }
}

function assertComparableIdentity(
  stats: BuildIdentityStats,
  phase: IdentityFailurePhase,
  platform: NodeJS.Platform
): void {
  // Windows stat(path) and fstat(handle) can expose unavailable or inconsistent
  // volume IDs for the same file. The exact file ID remains available as ino,
  // so Windows identity is file-ID based. POSIX requires both components.
  if (platform !== "win32" && stats.dev <= 0n) {
    throw new BuildIdentityReadError(`device-identity-unavailable-${phase}`);
  }
  if (stats.ino === 0n) {
    throw new BuildIdentityReadError(`file-id-unavailable-${phase}`);
  }
}

function assertSameFileSnapshot(
  left: BuildIdentityStats,
  right: BuildIdentityStats,
  phase: IdentityFailurePhase,
  platform: NodeJS.Platform
): void {
  assertSameFileIdentity(left, right, phase, platform);
  if (
    left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.size !== right.size
    || left.mtimeNs !== right.mtimeNs
    || left.ctimeNs !== right.ctimeNs
    || left.birthtimeNs !== right.birthtimeNs
  ) {
    throw new BuildIdentityReadError(`snapshot-mismatch-${phase}`);
  }
}
