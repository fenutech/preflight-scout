import path from "node:path";
import { readTextIfExists, writeTextEnsuringDir } from "./fs.js";
import type { HumanReportSummary, ImpactMap, MissionRunResult, QAMission } from "./types.js";
import { ImpactMapSchema, MissionRunResultSchema, QAMissionSchema } from "./schemas.js";
import { buildHumanReportSummary, renderHumanReport, renderHumanReportHtml } from "./report.js";
import { z } from "zod";

export interface AnalysisArtifacts {
  impactMap: ImpactMap;
  mission: QAMission;
  markdown?: string;
  runResult?: MissionRunResult;
  runResults?: MissionRunResult[];
  reportSummary?: HumanReportSummary;
}

export function defaultRunDir(root: string): string {
  return path.join(root, ".preflight-scout", "runs", "latest");
}

export async function writeAnalysisArtifacts(runDir: string, artifacts: AnalysisArtifacts): Promise<void> {
  await writeTextEnsuringDir(path.join(runDir, "impact-map.json"), `${JSON.stringify(artifacts.impactMap, null, 2)}\n`);
  await writeTextEnsuringDir(path.join(runDir, "mission.json"), `${JSON.stringify(artifacts.mission, null, 2)}\n`);
  const runResults = artifacts.runResults ?? (artifacts.runResult ? [artifacts.runResult] : undefined);
  const generatedAt = artifacts.reportSummary?.generatedAt ?? new Date().toISOString();
  const markdown = artifacts.markdown ?? renderHumanReport({
    impactMap: artifacts.impactMap,
    mission: artifacts.mission,
    runResults,
    runDir,
    generatedAt
  });
  const summary = artifacts.reportSummary ?? buildHumanReportSummary({
    impactMap: artifacts.impactMap,
    mission: artifacts.mission,
    runResults,
    generatedAt
  });
  await writeTextEnsuringDir(path.join(runDir, "report.md"), markdown);
  await writeTextEnsuringDir(path.join(runDir, "report.html"), renderHumanReportHtml({
    impactMap: artifacts.impactMap,
    mission: artifacts.mission,
    runResults,
    runDir,
    generatedAt
  }));
  await writeTextEnsuringDir(path.join(runDir, "report-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (artifacts.runResult) await writeTextEnsuringDir(path.join(runDir, "run-result.json"), `${JSON.stringify(artifacts.runResult, null, 2)}\n`);
  if (artifacts.runResults) await writeTextEnsuringDir(path.join(runDir, "run-results.json"), `${JSON.stringify(artifacts.runResults, null, 2)}\n`);
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
