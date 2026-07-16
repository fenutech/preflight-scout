import { describe, expect, it } from "vitest";
import type { QAContract, QAFlowMission } from "@preflight-scout/core";
import { runAutomationCandidates } from "./missions.js";

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
