import path from "node:path";
import { runBrowserMission } from "@preflight-scout/browser-runner";
import type { LLMClient, MissionRunResult, QAContract, QAFlowMission, QAMission } from "@preflight-scout/core";

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
  }
): Promise<MissionRunResult[]> {
  if (missions.length > 1 && options.saveStorageState) {
    throw new Error("Refusing to save authentication state during a multi-mission run. Authentication state must remain outside uploaded evidence directories.");
  }
  const useMissionSubdirs = missions.length > 1;
  const runResults: MissionRunResult[] = [];
  for (const mission of missions) {
    const missionOutputDir = useMissionSubdirs ? path.join(options.outputDir, mission.id) : options.outputDir;
    runResults.push(await runBrowserMission(mission, {
      baseUrl: options.appUrl,
      contract: options.contract,
      llm: options.llm,
      root: options.root,
      outputDir: missionOutputDir,
      headless: options.headless,
      maxTurns: options.maxTurns,
      storageState: options.storageState,
      saveStorageState: options.saveStorageState,
      trace: options.trace
    }));
  }
  return runResults;
}

export function selectAutomationCandidates(mission: QAMission, options: { missionId?: string; allCandidates?: boolean; missionLimit?: number } = {}): QAFlowMission[] {
  if (options.missionId && options.allCandidates) {
    throw new Error("Use either mission-id or all-candidates, not both.");
  }
  if (!mission.automationCandidates.length) {
    throw new Error("Mission artifact does not include automationCandidates.");
  }
  if (options.missionId) {
    const selected = mission.automationCandidates.find((candidate) => candidate.id === options.missionId);
    if (!selected) {
      const available = mission.automationCandidates.map((candidate) => candidate.id).join(", ");
      throw new Error(`Automation candidate "${options.missionId}" was not found. Available candidates: ${available}`);
    }
    return [selected];
  }
  return options.allCandidates ? mission.automationCandidates : mission.automationCandidates.slice(0, options.missionLimit ?? 1);
}
