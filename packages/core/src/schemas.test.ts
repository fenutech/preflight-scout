import { describe, expect, it } from "vitest";
import { ImpactMapSchema, MissionRunResultSchema, MissionStepSchema, PromotedRegressionTestSchema, QAContractSchema, QAMissionSchema } from "./schemas.js";

const baseMission = {
  id: "qa-mission",
  title: "QA mission",
  risk: "medium" as const,
  summary: "Validate the reviewed change.",
  affectedAreas: [],
  manualChecklist: [],
  edgeCases: [],
  unknowns: []
};

function flow(id: string, stepIds: string[]) {
  return {
    id,
    title: id,
    risk: "medium" as const,
    reason: ["Reviewed regression."],
    steps: stepIds.map((stepId) => ({
      id: stepId,
      instruction: "Observe the result.",
      action: "observe" as const
    }))
  };
}

describe("QAMissionSchema uniqueness", () => {
  it("rejects duplicate automation candidate ids", () => {
    const result = QAMissionSchema.safeParse({
      ...baseMission,
      automationCandidates: [flow("duplicate", ["one"]), flow("duplicate", ["two"])]
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("duplicate automation candidate id"))).toBe(true);
  });

  it("rejects duplicate step ids within a candidate", () => {
    const result = QAMissionSchema.safeParse({
      ...baseMission,
      automationCandidates: [flow("candidate", ["duplicate", "duplicate"])]
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("duplicate mission step id"))).toBe(true);
  });
});

describe("artifact schema budgets", () => {
  it("requires deterministic mission fields while preserving dynamic login steps", () => {
    expect(MissionStepSchema.safeParse({ id: "click", instruction: "Click.", action: "click", target: "testid=submit" }).success).toBe(false);
    expect(MissionStepSchema.safeParse({ id: "fill", instruction: "Fill.", action: "fill", policyLabel: "fill", target: "testid=email" }).success).toBe(false);
    expect(MissionStepSchema.safeParse({ id: "assert", instruction: "Assert.", action: "assert_text", target: "testid=status" }).success).toBe(false);
    expect(MissionStepSchema.safeParse({
      id: "login",
      instruction: "Authenticate from the reviewed start path.",
      action: "login",
      policyLabel: "login"
    }).success).toBe(true);
  });

  it("requires nonblank reviewed text assertion evidence", () => {
    const assertion = {
      id: "assert",
      instruction: "Assert.",
      action: "assert_text" as const,
      target: "testid=status"
    };

    expect(MissionStepSchema.safeParse({ ...assertion, expected: "" }).success).toBe(false);
    expect(MissionStepSchema.safeParse({ ...assertion, expected: "   " }).success).toBe(false);
    expect(MissionStepSchema.safeParse({ ...assertion, expected: "Ready" }).success).toBe(true);
  });

  it("rejects unknown safety-policy and model control fields", () => {
    expect(QAContractSchema.safeParse({
      app: {},
      criticalFlows: [],
      sensitiveAreas: [],
      dangerousActions: { allowed: [], requireApproval: [], requireApprovals: ["submit_payment"], forbidden: [] },
      testData: {},
      unknowns: []
    }).success).toBe(false);

    expect(QAMissionSchema.safeParse({
      ...baseMission,
      automationCandidates: [],
      bypassPolicy: true
    }).success).toBe(false);
  });

  it("rejects oversized contract, impact, mission, run-result, and promotion fields", () => {
    expect(QAContractSchema.safeParse({
      app: {},
      criticalFlows: [],
      sensitiveAreas: [],
      dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
      testData: { hostile: "x".repeat(10_001) },
      unknowns: []
    }).success).toBe(false);

    expect(ImpactMapSchema.safeParse({
      summary: "x".repeat(4_097),
      risk: "high",
      changedFiles: [],
      affectedRoutes: [],
      affectedAreas: [],
      suggestedRoles: [],
      unknowns: []
    }).success).toBe(false);

    expect(QAMissionSchema.safeParse({
      ...baseMission,
      title: "x".repeat(513),
      automationCandidates: []
    }).success).toBe(false);

    expect(MissionRunResultSchema.safeParse({
      missionId: "mission",
      status: "blocked",
      results: [{ stepId: "step", status: "blocked", message: "x".repeat(10_001) }],
      artifacts: []
    }).success).toBe(false);

    expect(MissionRunResultSchema.safeParse({
      missionId: "../unsafe",
      status: "blocked",
      results: [],
      artifacts: []
    }).success).toBe(false);

    expect(PromotedRegressionTestSchema.safeParse({
      filePath: "tests/preflight-scout/example.spec.ts",
      testTitle: "Example",
      content: "x".repeat(262_145),
      notes: [],
      coveredMissionIds: []
    }).success).toBe(false);
  });
});
