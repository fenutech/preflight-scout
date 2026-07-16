import * as core from "@actions/core";
import path from "node:path";

export interface ActionInputs {
  token: string;
  mode: "analyze" | "analyze-and-run";
  appUrl?: string;
  target?: string;
  targetEnv: string;
  outputDir: string;
  missionId?: string;
  allCandidates: boolean;
  missionLimit?: number;
  maxTurns?: number;
  headless: boolean;
  storageState?: string;
  saveStorageState?: string;
  trace: boolean;
  comment: boolean;
  uploadArtifact: boolean;
  artifactName?: string;
  detectDeploymentUrl: boolean;
  failOn: string;
}

export function readInputs(): ActionInputs {
  const token = inputValue("github-token");
  if (!token) throw new Error("github-token is required.");

  const rawMode = inputValue("mode") || "analyze";
  const mode = rawMode === "run" ? "analyze-and-run" : rawMode;
  if (mode !== "analyze" && mode !== "analyze-and-run") {
    throw new Error('mode must be "analyze", "analyze-and-run", or "run".');
  }

  return {
    token,
    mode,
    appUrl: inputValue("app-url"),
    target: inputValue("target"),
    targetEnv: inputValue("target-env") || "auto",
    outputDir: path.resolve(inputValue("output-dir") || ".preflight-scout/runs/github-action"),
    missionId: inputValue("mission-id"),
    allCandidates: booleanInput("all-candidates", false),
    missionLimit: parseOptionalPositiveInteger(inputValue("mission-limit"), "mission-limit"),
    maxTurns: parseOptionalPositiveInteger(inputValue("max-turns"), "max-turns"),
    headless: booleanInput("headless", true),
    storageState: optionalPathInput("storage-state"),
    saveStorageState: optionalPathInput("save-storage-state"),
    trace: booleanInput("trace", true),
    comment: booleanInput("comment", true),
    uploadArtifact: booleanInput("upload-artifact", true),
    artifactName: inputValue("artifact-name"),
    detectDeploymentUrl: booleanInput("detect-deployment-url", true),
    failOn: inputValue("fail-on") || "needs_attention"
  };
}

export function inputValue(name: string): string | undefined {
  const value = core.getInput(name);
  if (value) return value;
  return process.env[`PREFLIGHT_SCOUT_${name.toUpperCase().replace(/-/g, "_")}`] || undefined;
}

function optionalPathInput(name: string): string | undefined {
  const value = inputValue(name);
  return value ? path.resolve(value) : undefined;
}

function booleanInput(name: string, defaultValue: boolean): boolean {
  const value = inputValue(name);
  if (value === undefined) return defaultValue;
  if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

function parseOptionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}
