import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { assertPathHasNoSymlinks, ensureSafeDirectoryForWrite, readTextIfExists, writeTextEnsuringDir } from "./fs.js";
import type { AnalysisManifest, AnalysisProvenance, ExecutionRuntimeIdentity, HumanReportSummary, ImpactMap, MissionRunResult, QAMission } from "./types.js";
import { AnalysisManifestSchema, ImpactMapSchema, MissionRunResultSchema, QAMissionSchema } from "./schemas.js";
import { buildHumanReportSummary, renderHumanReport, renderHumanReportHtml } from "./report.js";
import {
  ANALYSIS_MANIFEST_SCHEMA_VERSION,
  analysisRerunInstruction,
  assertAnalysisProvenanceMatches,
  assertAnalysisRuntimeCompatible,
  provenanceFromManifest,
  sha256Text
} from "./provenance.js";
import { z } from "zod";

const ANALYSIS_MANIFEST_FILE = "analysis-manifest.json";
const ANALYSIS_GENERATION_LOCK_FILE = ".analysis-generation.lock";
const MAX_ANALYSIS_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_DECLARED_EVIDENCE_FILES = 5_000;
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface AnalysisArtifacts {
  boundary: string;
  impactMap: ImpactMap;
  mission: QAMission;
  provenance?: AnalysisProvenance;
  executionRuntime?: ExecutionRuntimeIdentity;
  markdown?: string;
  runResult?: MissionRunResult;
  runResults?: MissionRunResult[];
  reportSummary?: HumanReportSummary;
  /**
   * Bounded compare-before-replace guard for commands that read and then
   * rewrite the same analysis directory.
   */
  expectedPreviousBundleSha256?: string;
}

export function defaultRunDir(root: string): string {
  return path.join(root, ".preflight-scout", "runs", "latest");
}

export interface AnalysisArtifactPublication {
  bundleSha256?: string;
}

export async function writeAnalysisArtifacts(
  runDir: string,
  artifacts: AnalysisArtifacts
): Promise<AnalysisArtifactPublication> {
  if (artifacts.runResult && artifacts.runResults) {
    throw new Error("Write either runResult or runResults for one generation, not both.");
  }
  const impactMapText = `${JSON.stringify(artifacts.impactMap, null, 2)}\n`;
  const missionText = `${JSON.stringify(artifacts.mission, null, 2)}\n`;
  const suppliedRunResults = artifacts.runResults ?? (artifacts.runResult ? [artifacts.runResult] : undefined);
  const parsedRunResults = suppliedRunResults
    ? z.array(MissionRunResultSchema).max(100).parse(suppliedRunResults)
    : undefined;
  const runResults = parsedRunResults?.map((result) => normalizeRunResultPaths(runDir, result));
  if (runResults) assertRunResultsBelongToMission(runResults, artifacts.mission);
  if (runResults && artifacts.provenance && !artifacts.executionRuntime) {
    throw new Error("Bound browser results require the exact Preflight Scout executor package-code/build identity that produced them.");
  }
  let bundleSha256: string | undefined;
  await withAnalysisGenerationLock(runDir, artifacts.boundary, async () => {
    await invalidateCurrentGeneration(runDir, artifacts.boundary, artifacts.expectedPreviousBundleSha256);
    await writeTextEnsuringDir(path.join(runDir, "impact-map.json"), impactMapText, { boundary: artifacts.boundary });
    await writeTextEnsuringDir(path.join(runDir, "mission.json"), missionText, { boundary: artifacts.boundary });
    const generatedAt = artifacts.reportSummary?.generatedAt ?? new Date().toISOString();
    const markdown = artifacts.markdown ?? renderHumanReport({
      impactMap: artifacts.impactMap,
      mission: artifacts.mission,
      runResults,
      runDir,
      generatedAt
    });
    // A caller may have built reportSummary before its browser-result paths
    // were normalized for this run directory. Rebuild every derived field
    // from the normalized results and retain only the shared timestamp.
    const summary = buildHumanReportSummary({
      impactMap: artifacts.impactMap,
      mission: artifacts.mission,
      runResults,
      generatedAt
    });
    const reportHtml = renderHumanReportHtml({
      impactMap: artifacts.impactMap,
      mission: artifacts.mission,
      runResults,
      runDir,
      generatedAt
    });
    const reportSummaryText = `${JSON.stringify(summary, null, 2)}\n`;
    await writeTextEnsuringDir(path.join(runDir, "report.md"), markdown, { boundary: artifacts.boundary });
    await writeTextEnsuringDir(path.join(runDir, "report.html"), reportHtml, { boundary: artifacts.boundary });
    await writeTextEnsuringDir(path.join(runDir, "report-summary.json"), reportSummaryText, { boundary: artifacts.boundary });
    let currentResultPath: "run-result.json" | "run-results.json" | undefined;
    let currentResultText: string | undefined;
    let currentRunResults: MissionRunResult[] | undefined;
    if (artifacts.runResult) {
      const normalizedRunResult = runResults![0]!;
      const runResultText = `${JSON.stringify(normalizedRunResult, null, 2)}\n`;
      await writeTextEnsuringDir(path.join(runDir, "run-result.json"), runResultText, { boundary: artifacts.boundary });
      currentResultPath = "run-result.json";
      currentResultText = runResultText;
      currentRunResults = [normalizedRunResult];
    }
    if (artifacts.runResults) {
      const runResultsText = `${JSON.stringify(runResults, null, 2)}\n`;
      await writeTextEnsuringDir(path.join(runDir, "run-results.json"), runResultsText, { boundary: artifacts.boundary });
      currentResultPath = "run-results.json";
      currentResultText = runResultsText;
      currentRunResults = runResults;
    }
    if (artifacts.provenance) {
      const currentResults = currentResultPath && currentResultText && currentRunResults
        ? {
            path: currentResultPath,
            sha256: sha256Text(currentResultText),
            executionRuntime: artifacts.executionRuntime!,
            evidence: await collectEvidenceDigests(runDir, artifacts.boundary, currentRunResults)
          }
        : undefined;
      const manifest: AnalysisManifest = {
        kind: "preflight-scout-analysis",
        schemaVersion: ANALYSIS_MANIFEST_SCHEMA_VERSION,
        ...artifacts.provenance,
        artifacts: {
          impactMapSha256: sha256Text(impactMapText),
          missionSha256: sha256Text(missionText),
          reportMarkdownSha256: sha256Text(markdown),
          reportHtmlSha256: sha256Text(reportHtml),
          reportSummarySha256: sha256Text(reportSummaryText),
          ...(currentResults ? { currentResults } : {})
        }
      };
      AnalysisManifestSchema.parse(manifest);
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      if (Buffer.byteLength(manifestText, "utf8") > MAX_ANALYSIS_MANIFEST_BYTES) {
        throw analysisRerunInstruction("the analysis manifest exceeds its bounded artifact size");
      }
      await writeTextEnsuringDir(path.join(runDir, ANALYSIS_MANIFEST_FILE), manifestText, { boundary: artifacts.boundary });
      bundleSha256 = analysisBundleDigest(
        manifestText,
        impactMapText,
        missionText,
        markdown,
        reportHtml,
        reportSummaryText,
        currentResultText
      );
    }
  });
  return { bundleSha256 };
}

export interface AnalysisArtifactBundle {
  impactMap: ImpactMap;
  mission: QAMission;
  provenance: AnalysisProvenance;
  manifest: AnalysisManifest;
  manifestSha256: string;
  bundleSha256: string;
  reportHtml: string;
  runResults?: MissionRunResult[];
  executionRuntime?: ExecutionRuntimeIdentity;
}

export async function readAnalysisArtifactBundle(
  runDir: string,
  boundary: string,
  expectedProvenance?: AnalysisProvenance,
  expectedExecutionRuntime?: ExecutionRuntimeIdentity
): Promise<AnalysisArtifactBundle> {
  try {
    await assertPathHasNoSymlinks(boundary, runDir, { allowMissing: false, leafType: "directory" });
  } catch {
    throw analysisRerunInstruction("the analysis directory could not be read safely");
  }
  const { manifest, text: manifestText } = await readAnalysisManifest(runDir, boundary);
  assertAnalysisRuntimeCompatible(manifest);
  if (expectedProvenance) assertAnalysisProvenanceMatches(manifest, expectedProvenance);

  const impactMapText = await readBoundAnalysisArtifact(runDir, boundary, "impact-map.json");
  if (sha256Text(impactMapText) !== manifest.artifacts.impactMapSha256) {
    throw analysisRerunInstruction("impact-map.json no longer matches its reviewed digest");
  }
  const missionText = await readBoundAnalysisArtifact(runDir, boundary, "mission.json");
  if (sha256Text(missionText) !== manifest.artifacts.missionSha256) {
    throw analysisRerunInstruction("mission.json no longer matches its reviewed digest");
  }
  const reportMarkdownText = await readBoundAnalysisArtifact(runDir, boundary, "report.md");
  if (sha256Text(reportMarkdownText) !== manifest.artifacts.reportMarkdownSha256) {
    throw analysisRerunInstruction("report.md no longer matches its declared digest");
  }
  const reportHtmlText = await readBoundAnalysisArtifact(runDir, boundary, "report.html");
  if (sha256Text(reportHtmlText) !== manifest.artifacts.reportHtmlSha256) {
    throw analysisRerunInstruction("report.html no longer matches its declared digest");
  }
  const reportSummaryText = await readBoundAnalysisArtifact(runDir, boundary, "report-summary.json");
  if (sha256Text(reportSummaryText) !== manifest.artifacts.reportSummarySha256) {
    throw analysisRerunInstruction("report-summary.json no longer matches its declared digest");
  }
  await validateDeclaredPdf(runDir, boundary, manifest.artifacts.reportPdfSha256);

  let impactMap: ImpactMap;
  let mission: QAMission;
  try {
    impactMap = ImpactMapSchema.parse(JSON.parse(impactMapText));
    mission = QAMissionSchema.parse(JSON.parse(missionText));
  } catch {
    throw analysisRerunInstruction("the reviewed impact map or mission is malformed");
  }

  const currentResults = manifest.artifacts.currentResults
    ? await readManifestRunResults(runDir, boundary, manifest.artifacts.currentResults)
    : undefined;
  if (expectedExecutionRuntime && manifest.artifacts.currentResults) {
    const actualExecutionRuntime = manifest.artifacts.currentResults?.executionRuntime;
    if (
      !actualExecutionRuntime
      || actualExecutionRuntime.entrypoint !== expectedExecutionRuntime.entrypoint
      || actualExecutionRuntime.digest !== expectedExecutionRuntime.digest
    ) {
      throw analysisRerunInstruction("the exact Preflight Scout browser-executor package code/build has changed");
    }
  }
  const runResults = currentResults?.runResults;
  if (runResults) assertRunResultsBelongToMission(runResults, mission);
  const manifestSha256 = sha256Text(manifestText);
  return {
    impactMap,
    mission,
    provenance: provenanceFromManifest(manifest),
    manifest,
    manifestSha256,
    reportHtml: reportHtmlText,
    bundleSha256: analysisBundleDigest(
      manifestText,
      impactMapText,
      missionText,
      reportMarkdownText,
      reportHtmlText,
      reportSummaryText,
      currentResults?.text
    ),
    runResults,
    executionRuntime: manifest.artifacts.currentResults?.executionRuntime
  };
}

export async function createAnalysisEvidenceDirectory(runDir: string, boundary: string): Promise<string> {
  const generationsRoot = path.join(path.resolve(runDir), "browser-evidence");
  try {
    await ensureSafeDirectoryForWrite(boundary, generationsRoot);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generationDir = path.join(generationsRoot, randomUUID());
      try {
        await mkdir(generationDir, { mode: 0o700 });
        return generationDir;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } catch {
    // Keep private artifact paths out of diagnostics.
  }
  throw new Error("Could not create an exclusive browser-evidence generation directory safely.");
}

export async function publishAnalysisPdf(options: {
  runDir: string;
  boundary: string;
  temporaryPdfPath: string;
  expectedBundleSha256: string;
}): Promise<string> {
  const runDir = path.resolve(options.runDir);
  const temporaryPdfPath = path.resolve(options.temporaryPdfPath);
  const reportPdfPath = path.join(runDir, "report.pdf");
  let publishedBundleSha256: string | undefined;
  const temporaryRelativePath = normalizeRunRelativePath(runDir, temporaryPdfPath);
  if (!/^browser-evidence\/[0-9a-f-]{36}\/report\.pdf$/.test(temporaryRelativePath)) {
    throw new Error("Temporary PDF output must use an exclusive analysis evidence directory.");
  }
  try {
    await withAnalysisGenerationLock(runDir, options.boundary, async () => {
      const current = await readAnalysisArtifactBundle(runDir, options.boundary);
      if (current.bundleSha256 !== options.expectedBundleSha256) {
        throw analysisRerunInstruction("the analysis generation changed while report.pdf was rendering");
      }
      await assertPathHasNoSymlinks(options.boundary, temporaryPdfPath, {
        allowMissing: false,
        leafType: "file"
      });
      const stats = await lstat(temporaryPdfPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > MAX_EVIDENCE_FILE_BYTES) {
        throw new Error("Refusing unsafe or oversized temporary PDF output.");
      }
      const pdfDigest = await digestEvidenceFile(options.boundary, temporaryPdfPath);
      await assertPathHasNoSymlinks(options.boundary, reportPdfPath, { allowMissing: true, leafType: "file" });
      await rm(reportPdfPath, { force: true });
      await rename(temporaryPdfPath, reportPdfPath);
      const updatedManifest: AnalysisManifest = {
        ...current.manifest,
        artifacts: {
          ...current.manifest.artifacts,
          reportPdfSha256: pdfDigest.sha256
        }
      };
      AnalysisManifestSchema.parse(updatedManifest);
      const manifestText = `${JSON.stringify(updatedManifest, null, 2)}\n`;
      await writeTextEnsuringDir(path.join(runDir, ANALYSIS_MANIFEST_FILE), manifestText, {
        boundary: options.boundary
      });
      publishedBundleSha256 = (await readAnalysisArtifactBundle(runDir, options.boundary)).bundleSha256;
    });
  } finally {
    try {
      await assertPathHasNoSymlinks(options.boundary, temporaryPdfPath, { allowMissing: true, leafType: "file" });
      await rm(temporaryPdfPath, { force: true });
    } catch {
      // A failed safe-cleanup check must not turn into a path-bearing diagnostic.
    }
  }
  if (!publishedBundleSha256) throw new Error("Could not publish a manifest-bound report.pdf.");
  return publishedBundleSha256;
}

export async function readMissionArtifact(filePath: string): Promise<QAMission> {
  const text = await readTextIfExists(filePath, { maxBytes: 16 * 1024 * 1024 });
  if (!text) throw new Error(`Mission artifact not found: ${filePath}`);
  return QAMissionSchema.parse(JSON.parse(text));
}

export async function readImpactMapArtifact(filePath: string): Promise<ImpactMap> {
  const text = await readTextIfExists(filePath, { maxBytes: 16 * 1024 * 1024 });
  if (!text) throw new Error(`Impact map artifact not found: ${filePath}`);
  return ImpactMapSchema.parse(JSON.parse(text));
}

export async function readRunResultArtifact(filePath: string): Promise<MissionRunResult> {
  const text = await readTextIfExists(filePath, { maxBytes: 16 * 1024 * 1024 });
  if (!text) throw new Error(`Run result artifact not found: ${filePath}`);
  return MissionRunResultSchema.parse(JSON.parse(text));
}

export async function readRunResultsArtifact(filePath: string): Promise<MissionRunResult[]> {
  const text = await readTextIfExists(filePath, { maxBytes: 16 * 1024 * 1024 });
  if (!text) throw new Error(`Run results artifact not found: ${filePath}`);
  return z.array(MissionRunResultSchema).parse(JSON.parse(text));
}

async function readAnalysisManifest(runDir: string, boundary: string): Promise<{ manifest: AnalysisManifest; text: string }> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(path.join(runDir, ANALYSIS_MANIFEST_FILE), {
      boundary,
      maxBytes: MAX_ANALYSIS_MANIFEST_BYTES
    });
  } catch {
    throw analysisRerunInstruction("analysis-manifest.json could not be read safely");
  }
  if (!text) {
    throw analysisRerunInstruction("analysis-manifest.json is missing (legacy analysis directories are not reusable)");
  }
  try {
    return { manifest: AnalysisManifestSchema.parse(JSON.parse(text)), text };
  } catch {
    throw analysisRerunInstruction("analysis-manifest.json is malformed or uses an unsupported schema");
  }
}

async function readBoundAnalysisArtifact(
  runDir: string,
  boundary: string,
  name: "impact-map.json" | "mission.json" | "report.md" | "report.html" | "report-summary.json"
): Promise<string> {
  try {
    const text = await readTextIfExists(path.join(runDir, name), {
      boundary,
      maxBytes: 16 * 1024 * 1024
    });
    if (text) return text;
  } catch {
    // Replace path-bearing low-level diagnostics with an actionable, redacted
    // provenance failure.
  }
  throw analysisRerunInstruction(`${name} is missing or could not be read safely`);
}

async function readManifestRunResults(
  runDir: string,
  boundary: string,
  currentResults: NonNullable<AnalysisManifest["artifacts"]["currentResults"]>
): Promise<{ runResults: MissionRunResult[]; text: string }> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(path.join(runDir, currentResults.path), {
      boundary,
      maxBytes: 16 * 1024 * 1024
    });
  } catch {
    throw analysisRerunInstruction("the declared browser result artifact could not be read safely");
  }
  if (!text || sha256Text(text) !== currentResults.sha256) {
    throw analysisRerunInstruction("the declared browser result artifact is missing or no longer matches its digest");
  }
  try {
    const runResults = currentResults.path === "run-results.json"
      ? z.array(MissionRunResultSchema).parse(JSON.parse(text))
      : [MissionRunResultSchema.parse(JSON.parse(text))];
    const actualEvidence = await collectEvidenceDigests(runDir, boundary, runResults);
    if (JSON.stringify(actualEvidence) !== JSON.stringify(currentResults.evidence)) {
      throw analysisRerunInstruction("the declared browser evidence is missing, changed, or belongs to another generation");
    }
    return { runResults, text };
  } catch {
    throw analysisRerunInstruction("the declared browser result or evidence artifacts are malformed or no longer match their digests");
  }
}

async function validateDeclaredPdf(
  runDir: string,
  boundary: string,
  expectedDigest?: string
): Promise<void> {
  const reportPdfPath = path.join(runDir, "report.pdf");
  if (expectedDigest) {
    try {
      const actual = await digestEvidenceFile(boundary, reportPdfPath);
      if (actual.sha256 === expectedDigest) return;
    } catch {
      // Replace low-level/path-bearing diagnostics with one bounded failure.
    }
    throw analysisRerunInstruction("report.pdf is missing or no longer matches its declared digest");
  }
  try {
    await assertPathHasNoSymlinks(boundary, reportPdfPath, { allowMissing: true, leafType: "file" });
    await lstat(reportPdfPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw analysisRerunInstruction("an undeclared report.pdf could not be checked safely");
  }
  throw analysisRerunInstruction("an undeclared stale report.pdf is present");
}

function assertRunResultsBelongToMission(runResults: MissionRunResult[], mission: QAMission): void {
  const reviewed = new Set(mission.automationCandidates.map((candidate) => candidate.id));
  const seen = new Set<string>();
  for (const result of runResults) {
    if (!reviewed.has(result.missionId) || seen.has(result.missionId)) {
      throw analysisRerunInstruction("the declared browser results do not match the reviewed mission candidates");
    }
    seen.add(result.missionId);
  }
}

async function invalidateCurrentGeneration(
  runDir: string,
  boundary: string,
  expectedBundleSha256?: string
): Promise<void> {
  const root = path.resolve(runDir);
  if (expectedBundleSha256) {
    let currentBundle: AnalysisArtifactBundle | undefined;
    try {
      currentBundle = await readAnalysisArtifactBundle(root, boundary);
    } catch {
      // Replace artifact-specific diagnostics with one bounded generation
      // mismatch that tells the operator how to recover safely.
    }
    if (!currentBundle || currentBundle.bundleSha256 !== expectedBundleSha256) {
      throw analysisRerunInstruction("the analysis generation changed while this command was running");
    }
  }
  for (const name of [ANALYSIS_MANIFEST_FILE, "run-result.json", "run-results.json", "report.pdf"] as const) {
    const candidate = path.join(root, name);
    await assertPathHasNoSymlinks(boundary, candidate, { allowMissing: true, leafType: "file" });
    await rm(candidate, { force: true });
  }
}

function normalizeRunResultPaths(runDir: string, result: MissionRunResult): MissionRunResult {
  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => normalizeRunRelativePath(runDir, artifact)),
    results: result.results.map((step) => ({
      ...step,
      ...(step.screenshotPath
        ? { screenshotPath: normalizeRunRelativePath(runDir, step.screenshotPath) }
        : {})
    })),
    ...(result.evidence
      ? {
          evidence: Object.fromEntries(Object.entries(result.evidence).map(([name, evidencePath]) => [
            name,
            evidencePath ? normalizeRunRelativePath(runDir, evidencePath) : evidencePath
          ])) as MissionRunResult["evidence"]
        }
      : {})
  };
}

function analysisBundleDigest(
  manifestText: string,
  impactMapText: string,
  missionText: string,
  reportMarkdownText: string,
  reportHtmlText: string,
  reportSummaryText: string,
  currentResultText?: string
): string {
  return sha256Text([
    "preflight-scout-analysis-bundle-v2",
    sha256Text(manifestText),
    sha256Text(impactMapText),
    sha256Text(missionText),
    sha256Text(reportMarkdownText),
    sha256Text(reportHtmlText),
    sha256Text(reportSummaryText),
    currentResultText ? sha256Text(currentResultText) : "no-current-results"
  ].join("\0"));
}

function normalizeRunRelativePath(runDir: string, source: string): string {
  if (hasUriScheme(source)) {
    throw analysisRerunInstruction("browser evidence contains a non-local path");
  }
  const root = path.resolve(runDir);
  const candidate = path.isAbsolute(source) ? path.resolve(source) : path.resolve(root, source);
  const relative = path.relative(root, candidate);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw analysisRerunInstruction("browser evidence leaves the declared run directory");
  }
  return relative.split(path.sep).join("/");
}

async function withAnalysisGenerationLock(
  runDir: string,
  boundary: string,
  writeGeneration: () => Promise<void>
): Promise<void> {
  const root = path.resolve(runDir);
  const trustedBoundary = path.resolve(boundary);
  await ensureSafeDirectoryForWrite(trustedBoundary, root);
  const lockPath = path.join(root, ANALYSIS_GENERATION_LOCK_FILE);
  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Refusing analysis artifact write because another writer owns this run directory. "
        + "Retry after it finishes. If a crashed process left the generation lock, remove it only after confirming no writer is active."
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    await writeGeneration();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function collectEvidenceDigests(
  runDir: string,
  boundary: string,
  runResults: MissionRunResult[]
): Promise<Array<{ path: string; sha256: string }>> {
  const root = path.resolve(runDir);
  const sources = new Set<string>();
  for (const result of runResults) {
    for (const artifact of result.artifacts) {
      sources.add(artifact);
      assertEvidenceCount(sources.size);
    }
    for (const step of result.results) {
      if (step.screenshotPath) {
        sources.add(step.screenshotPath);
        assertEvidenceCount(sources.size);
      }
    }
    for (const evidence of Object.values(result.evidence ?? {})) {
      if (evidence) {
        sources.add(evidence);
        assertEvidenceCount(sources.size);
      }
    }
  }

  const entries: Array<{ path: string; sha256: string }> = [];
  let totalBytes = 0;
  for (const source of sources) {
    if (hasUriScheme(source)) {
      throw analysisRerunInstruction("browser evidence contains a non-local path");
    }
    const candidate = path.isAbsolute(source) ? path.resolve(source) : path.resolve(root, source);
    const relative = path.relative(root, candidate);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw analysisRerunInstruction("browser evidence leaves the declared run directory");
    }
    const portablePath = relative.split(path.sep).join("/");
    let digest: { sha256: string; bytes: number };
    try {
      digest = await digestEvidenceFile(boundary, candidate);
    } catch {
      throw analysisRerunInstruction("browser evidence is missing or could not be read safely");
    }
    totalBytes += digest.bytes;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
      throw analysisRerunInstruction("browser evidence exceeds the bounded artifact size");
    }
    entries.push({ path: portablePath, sha256: digest.sha256 });
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertEvidenceCount(count: number): void {
  if (count > MAX_DECLARED_EVIDENCE_FILES) {
    throw analysisRerunInstruction("browser evidence contains too many declared files");
  }
}

async function digestEvidenceFile(boundary: string, filePath: string): Promise<{ sha256: string; bytes: number }> {
  await assertPathHasNoSymlinks(boundary, filePath, { allowMissing: false, leafType: "file" });
  const leafStats = await lstat(filePath);
  if (!leafStats.isFile() || leafStats.isSymbolicLink() || leafStats.nlink !== 1) {
    throw new Error("unsafe evidence file");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile()
      || stats.nlink !== 1
      || stats.size > MAX_EVIDENCE_FILE_BYTES
      || stats.dev !== leafStats.dev
      || stats.ino !== leafStats.ino
      || stats.size !== leafStats.size
    ) {
      throw new Error("unsafe evidence file");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_EVIDENCE_FILE_BYTES) throw new Error("oversized evidence file");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (bytes !== stats.size) throw new Error("evidence changed while hashing");
    return { sha256: `sha256:${hash.digest("hex")}`, bytes };
  } finally {
    await handle.close();
  }
}

function hasUriScheme(value: string): boolean {
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(value)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}
