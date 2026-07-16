import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { readTextIfExists, writeTextEnsuringDir } from "@preflight-scout/core";

const MAX_STORAGE_STATE_BYTES = 16 * 1024 * 1024;
const MAX_STORAGE_METADATA_BYTES = 64 * 1024;

export interface StorageStateMetadata {
  status: "valid" | "invalid";
  missionId?: string;
  savedAt: string;
  reason?: string;
  evidenceDir?: string;
  evidence?: {
    tracePath?: string;
    consolePath?: string;
    networkPath?: string;
    finalObservationPath?: string;
  };
}

export interface LoadedStorageStateInput {
  canonicalPath: string;
  state?: { cookies: unknown[]; origins: unknown[]; [key: string]: unknown };
  problem?: string;
}

export async function validateStorageStateInput(storageStatePath: string): Promise<string | undefined> {
  return (await loadStorageStateInput(storageStatePath)).problem;
}

export async function loadStorageStateInput(storageStatePath: string): Promise<LoadedStorageStateInput> {
  let canonicalPath: string;
  try {
    canonicalPath = await canonicalizeStorageStatePath(storageStatePath);
  } catch (error) {
    return {
      canonicalPath: path.resolve(storageStatePath),
      problem: `Storage-state path could not be canonicalized safely: ${storageStatePath}. ${(error as Error).message}`
    };
  }
  const metadataResult = await readStorageStateMetadata(canonicalPath);
  if (metadataResult.problem) return { canonicalPath, problem: metadataResult.problem };
  const metadata = metadataResult.metadata;
  if (metadata?.status === "invalid") {
    const reason = metadata.reason ? ` Reason: ${trimSentence(metadata.reason)}.` : "";
    const evidence = metadata.evidenceDir ? ` Previous auth evidence: ${metadata.evidenceDir}.` : "";
    const trace = metadata.evidence?.tracePath ? ` Trace: ${metadata.evidence.tracePath}.` : "";
    return {
      canonicalPath,
      problem: `Storage-state file is marked invalid by a previous Preflight Scout auth attempt: ${canonicalPath}.${reason}${evidence}${trace} Run preflight-scout auth login again or pass a different --storage-state path.`
    };
  }

  let text: string;
  try {
    const safeText = await readTextIfExists(canonicalPath, { maxBytes: MAX_STORAGE_STATE_BYTES });
    if (safeText === undefined) {
      return {
        canonicalPath,
        problem: `Storage-state file was not found: ${canonicalPath}. Run preflight-scout auth login for the needed role or pass --storage-state with an existing Playwright storageState JSON file.`
      };
    }
    text = safeText;
  } catch (error) {
    return {
      canonicalPath,
      problem: `Storage-state file could not be read safely: ${canonicalPath}. Symlinks and non-regular paths are not accepted. ${(error as Error).message}`
    };
  }

  try {
    const parsed = JSON.parse(text) as { cookies?: unknown; origins?: unknown; [key: string]: unknown };
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      return {
        canonicalPath,
        problem: `Storage-state file is not a Playwright storageState JSON object: ${canonicalPath}. Expected cookies and origins arrays.`
      };
    }
    return { canonicalPath, state: parsed as LoadedStorageStateInput["state"] };
  } catch (error) {
    return {
      canonicalPath,
      problem: `Storage-state file is not valid JSON: ${canonicalPath}. ${(error as Error).message}`
    };
  }
}

function trimSentence(value: string): string {
  return value.trim().replace(/[.。]+$/u, "");
}

export async function writeStorageStateMetadata(storageStatePath: string, metadata: StorageStateMetadata): Promise<void> {
  const canonicalPath = await canonicalizeStorageStatePath(storageStatePath);
  const metadataPath = storageStateMetadataPath(canonicalPath);
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STORAGE_METADATA_BYTES) {
    throw new Error(`Storage-state metadata exceeds the ${MAX_STORAGE_METADATA_BYTES}-byte safety limit.`);
  }
  await writeTextEnsuringDir(metadataPath, serialized, { mode: 0o600 });
}

async function readStorageStateMetadata(storageStatePath: string): Promise<{
  metadata?: StorageStateMetadata;
  problem?: string;
}> {
  const metadataPath = storageStateMetadataPath(storageStatePath);
  try {
    const text = await readTextIfExists(metadataPath, { maxBytes: MAX_STORAGE_METADATA_BYTES });
    if (text === undefined) return {};
    const parsed = JSON.parse(text) as unknown;
    if (!isStorageStateMetadata(parsed)) {
      return { problem: `Storage-state metadata is malformed: ${metadataPath}. Run preflight-scout auth login again before reusing this state.` };
    }
    return { metadata: parsed };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { problem: `Storage-state metadata is malformed: ${metadataPath}. Run preflight-scout auth login again before reusing this state.` };
    }
    return {
      problem: `Storage-state metadata could not be validated safely: ${metadataPath}. Run preflight-scout auth login again before reusing this state.`
    };
  }
}

function isStorageStateMetadata(value: unknown): value is StorageStateMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if ((candidate.status !== "valid" && candidate.status !== "invalid") || typeof candidate.savedAt !== "string" || !candidate.savedAt) return false;
  for (const key of ["missionId", "reason", "evidenceDir"] as const) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "string") return false;
  }
  if (candidate.evidence !== undefined) {
    if (!candidate.evidence || typeof candidate.evidence !== "object" || Array.isArray(candidate.evidence)) return false;
    const evidence = candidate.evidence as Record<string, unknown>;
    for (const key of ["tracePath", "consolePath", "networkPath", "finalObservationPath"] as const) {
      if (evidence[key] !== undefined && typeof evidence[key] !== "string") return false;
    }
  }
  return true;
}

function storageStateMetadataPath(storageStatePath: string): string {
  return `${storageStatePath}.preflight-scout.json`;
}

export async function canonicalizeStorageStatePath(storageStatePath: string): Promise<string> {
  if (!storageStatePath || storageStatePath.includes("\0")) {
    throw new Error("Storage-state path must be a non-empty filesystem path without NUL bytes.");
  }
  const resolved = path.resolve(storageStatePath);
  if (resolved.length > 4_096) throw new Error("Storage-state path exceeds the 4096-character safety limit.");

  const missingSegments: string[] = [];
  let cursor = path.dirname(resolved);
  for (;;) {
    try {
      const stats = await lstat(cursor);
      const canonicalExisting = await realpath(cursor);
      const canonicalStats = stats.isSymbolicLink() ? await lstat(canonicalExisting) : stats;
      if (!canonicalStats.isDirectory()) {
        throw new Error(`Storage-state parent is not a directory: ${cursor}`);
      }
      return path.join(canonicalExisting, ...missingSegments.reverse(), path.basename(resolved));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`Could not find an existing parent directory for ${resolved}`);
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
