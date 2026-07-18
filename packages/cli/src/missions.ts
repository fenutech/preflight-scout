import path from "node:path";
import { runBrowserMission } from "@preflight-scout/browser-runner";
import type { LLMClient, MissionRunResult, ProgressCallback, QAContract, QAFlowMission, QAMission } from "@preflight-scout/core";

export function selectAutomationCandidates(mission: QAMission, options: { missionId?: string; allCandidates?: boolean; missionLimit?: number } = {}): QAFlowMission[] {
  if (options.missionId && options.allCandidates) {
    throw new Error("Use either --mission-id or --all-candidates, not both.");
  }

  if (options.missionId) {
    const selected = mission.automationCandidates.find((candidate) => candidate.id === options.missionId);
    if (!selected) {
      const available = mission.automationCandidates.map((candidate) => candidate.id).join(", ") || "(none)";
      throw new Error(`Automation candidate "${options.missionId}" was not found. Available candidates: ${available}`);
    }
    return [selected];
  }

  if (!mission.automationCandidates.length) return [];
  if (options.allCandidates) return mission.automationCandidates;
  return mission.automationCandidates.slice(0, options.missionLimit ?? 2);
}

export async function runAutomationCandidates(
  missions: QAFlowMission[],
  options: {
    appUrl: string;
    contract: QAContract;
    llm: LLMClient;
    root: string;
    outputDir: string;
    headless: boolean;
    maxTurns?: number;
    storageState?: string;
    saveStorageState?: string;
    trace?: boolean;
    progress?: ProgressCallback;
  }
): Promise<MissionRunResult[]> {
  if (missions.length > 1 && options.saveStorageState) {
    throw new Error("Refusing to save authentication state during a multi-mission run. Run one authentication mission at a time so storage state remains in its dedicated .preflight-scout/auth path and never enters evidence directories.");
  }
  const useMissionSubdirs = missions.length > 1;
  const missionArtifactSegments = missions.map((mission) => safeArtifactSegment(mission.id, "mission id"));
  const runResults: MissionRunResult[] = [];
  for (const [index, mission] of missions.entries()) {
    options.progress?.(`Running mission ${index + 1}/${missions.length}: ${mission.title}`);
    const missionOutputDir = useMissionSubdirs ? path.join(options.outputDir, missionArtifactSegments[index]!) : options.outputDir;
    const runResult = await runBrowserMission(mission, {
      baseUrl: options.appUrl,
      contract: options.contract,
      llm: options.llm,
      root: options.root,
      outputDir: missionOutputDir,
      headless: options.headless,
      maxTurns: options.maxTurns,
      storageState: options.storageState,
      saveStorageState: options.saveStorageState,
      trace: options.trace,
      progress: options.progress
    });
    runResults.push(runResult);
  }
  return runResults;
}

export function safeArtifactSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe single path segment containing only letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}
