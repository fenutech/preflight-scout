import artifact from "@actions/artifact";
import type { MissionRunResult } from "@preflight-scout/core";
import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_ARTIFACT_FILES = 5_000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

const REPORT_FILES = ["impact-map.json", "mission.json", "report.html", "report.md", "report-summary.json"] as const;

export async function uploadReportArtifact(outputDir: string, name: string, runResults?: MissionRunResult[]): Promise<number | undefined> {
  const files = await listArtifactFiles(outputDir, reportArtifactPaths(outputDir, runResults));
  if (!files.length) return undefined;
  const response = await artifact.uploadArtifact(name, files, outputDir, { compressionLevel: 6 });
  return response.id;
}

export function reportArtifactPaths(outputDir: string, runResults?: MissionRunResult[]): string[] {
  const paths = REPORT_FILES.map((name) => path.join(outputDir, name));
  if (runResults !== undefined) paths.push(path.join(outputDir, "run-results.json"));
  for (const result of runResults ?? []) {
    paths.push(...result.artifacts);
    for (const step of result.results) {
      if (step.screenshotPath) paths.push(step.screenshotPath);
    }
    if (result.evidence) {
      for (const evidencePath of Object.values(result.evidence)) {
        if (evidencePath) paths.push(evidencePath);
      }
    }
  }
  return [...new Set(paths)];
}

export async function listArtifactFiles(dir: string, expectedPaths: Iterable<string>): Promise<string[]> {
  const root = path.resolve(dir);
  const rootStats = await fs.lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Refusing artifact upload from non-directory or symbolic-link root: ${root}`);
  }
  const canonicalRoot = await fs.realpath(root);
  const files: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const expectedPath of expectedPaths) {
    if (hasUriScheme(expectedPath)) {
      throw new Error(`Refusing non-local artifact path: ${expectedPath}`);
    }
    const candidate = path.isAbsolute(expectedPath) ? path.resolve(expectedPath) : path.resolve(root, expectedPath);
    if (!isPathWithin(root, candidate)) {
      throw new Error(`Refusing artifact entry outside the upload root: ${candidate}`);
    }
    await assertNoSymlinkComponents(root, candidate);
    const stats = await fs.lstat(candidate);
    if (!stats.isFile()) {
      throw new Error(`Refusing to upload non-regular artifact entry: ${candidate}`);
    }
    // Hard links can alias a runner-owned file outside the evidence tree even
    // though lstat reports a regular file, so upload only uniquely-linked files.
    if (stats.nlink !== 1) {
      throw new Error(`Refusing to upload hard-linked artifact entry: ${candidate}`);
    }
    const canonicalCandidate = await assertCanonicalArtifactPath(canonicalRoot, candidate);
    if (seen.has(canonicalCandidate)) continue;
    seen.add(canonicalCandidate);
    files.push(candidate);
    totalBytes += stats.size;
    if (files.length > MAX_ARTIFACT_FILES) {
      throw new Error(`Refusing artifact upload with more than ${MAX_ARTIFACT_FILES} files.`);
    }
    if (totalBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`Refusing artifact upload larger than ${MAX_ARTIFACT_BYTES} bytes.`);
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  // Revalidate after discovery so a path replaced before it is handed to the
  // artifact client fails closed.
  for (const file of files) {
    const stats = await fs.lstat(file);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
      throw new Error(`Artifact entry changed during safe upload discovery: ${file}`);
    }
    await assertCanonicalArtifactPath(canonicalRoot, file);
  }
  return files;
}

async function assertCanonicalArtifactPath(canonicalRoot: string, candidate: string): Promise<string> {
  const canonicalCandidate = await fs.realpath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing artifact entry outside the upload root: ${candidate}`);
  }
  return canonicalCandidate;
}

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to upload artifact through symbolic link: ${current}`);
    }
  }
}

function hasUriScheme(value: string): boolean {
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(value)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
