import { describe, expect, it } from "vitest";
import type { QAContract, QAFlowMission } from "@preflight-scout/core";
import { ACTION_ANALYSIS_RUNTIME, ACTION_EXECUTION_RUNTIME, runAutomationCandidates } from "./missions.js";

const contract: QAContract = {
  app: {},
  criticalFlows: [],
  sensitiveAreas: [],
  dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
  testData: {},
  unknowns: []
};

function mission(id: string): QAFlowMission {
  return { id, title: id, risk: "medium", reason: [], steps: [] };
}

describe("runAutomationCandidates", () => {
  it("uses separate exact Preflight Scout package identities for analysis and browser execution", () => {
    expect(ACTION_ANALYSIS_RUNTIME).toMatchObject({
      entrypoint: "github-action",
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      coreDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    expect(ACTION_EXECUTION_RUNTIME).toMatchObject({
      entrypoint: "github-action-browser",
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    });
    expect(ACTION_EXECUTION_RUNTIME.digest).not.toBe(ACTION_ANALYSIS_RUNTIME.digest);
  });

  it("never places saved authentication state in per-mission evidence directories", async () => {
    await expect(runAutomationCandidates([mission("one"), mission("two")], {
      appUrl: "https://example.test",
      contract,
      llm: { completeJson: async () => { throw new Error("must not run"); } },
      root: "/tmp/repo",
      outputDir: "/tmp/repo/.preflight-scout/runs/latest",
      headless: true,
      saveStorageState: "/tmp/repo/.preflight-scout/auth/session.json"
    })).rejects.toThrow("multi-mission run");
  });
});
