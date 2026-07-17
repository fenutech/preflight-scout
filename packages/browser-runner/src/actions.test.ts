import { describe, expect, it } from "vitest";
import type { ApprovalState, QAContract, QAFlowMission } from "@preflight-scout/core";
import { BrowserDecisionSchema } from "@preflight-scout/core";
import { bindReviewedAssertionDecision, checkActionSafety, parseViewportSize } from "./actions.js";
import type { BrowserDecision } from "./types.js";

const noApprovals: ApprovalState = { approvals: [] };

function contract(input: Partial<QAContract["dangerousActions"]> = {}): QAContract {
  return {
    app: {},
    criticalFlows: [],
    sensitiveAreas: [],
    dangerousActions: {
      allowed: input.allowed ?? ["search"],
      requireApproval: input.requireApproval ?? [],
      forbidden: input.forbidden ?? []
    },
    testData: {},
    unknowns: []
  };
}

function mission(step: QAFlowMission["steps"][number]): QAFlowMission {
  return { id: "mission", title: "mission", risk: "high", reason: [], steps: [step] };
}

function decision(input: Partial<BrowserDecision> = {}): BrowserDecision {
  return {
    thought: "Use the reviewed control.",
    action: "click",
    missionStepId: "reviewed-action",
    target: "testid=reviewed-control",
    reason: "Exercise the reviewed action.",
    ...input
  };
}

describe("reviewed browser action boundary", () => {
  it("blocks prompt-injected Pay now/Delete targets that are absent from the reviewed mission", () => {
    const reviewed = mission({
      id: "reviewed-action",
      instruction: "Use the safe search control.",
      action: "click",
      policyLabel: "search",
      target: "testid=reviewed-control"
    });

    expect(checkActionSafety(decision({ missionStepId: undefined, target: "text=Pay now" }), contract({ forbidden: ["real_payment"] }), noApprovals, reviewed))
      .toContain("must name an exact reviewed missionStepId");
    expect(checkActionSafety(decision({ target: "text=Delete" }), contract({ forbidden: ["delete_record"] }), noApprovals, reviewed))
      .toContain("not the exact reviewed target");
  });

  it("requires an exact reviewed policy label and exact approval", () => {
    const reviewed = mission({
      id: "reviewed-action",
      instruction: "Submit the reviewed payment fixture.",
      action: "click",
      policyLabel: "submit_payment",
      target: "testid=reviewed-control",
      requiresApproval: true
    });
    const policy = contract({ allowed: [], requireApproval: ["submit_payment"] });

    expect(checkActionSafety(decision(), policy, noApprovals, reviewed)).toContain('Approval required for action "submit_payment"');
    expect(checkActionSafety(decision(), policy, {
      approvals: [{ action: "submit_payment", approvedAt: new Date(0).toISOString() }]
    }, reviewed)).toBeUndefined();
  });

  it("blocks fill value substitution and press-key substitution", () => {
    const fillMission = mission({
      id: "reviewed-action",
      instruction: "Enter the synthetic query.",
      action: "fill",
      policyLabel: "search",
      target: "testid=reviewed-control",
      value: "safe query"
    });
    expect(checkActionSafety(decision({ action: "fill", value: "different query" }), contract(), noApprovals, fillMission))
      .toContain("exact reviewed value");

    const pressMission = mission({
      id: "reviewed-action",
      instruction: "Press Enter in the reviewed field.",
      action: "press",
      policyLabel: "search",
      target: "testid=reviewed-control",
      value: "Enter"
    });
    expect(checkActionSafety(decision({ action: "press", value: "Control+Enter" }), contract(), noApprovals, pressMission))
      .toContain("exact reviewed value");
  });

  it("binds live assertion fields to the exact reviewed assertion", () => {
    const reviewed = mission({
      id: "reviewed-action",
      instruction: "Verify the reviewed total.",
      action: "assert_text",
      target: "testid=order-total",
      expected: "Total: $100.00"
    });
    const bound = bindReviewedAssertionDecision(decision({
      action: "assert",
      target: "text=Checkout",
      value: "A weaker substitute"
    }), reviewed);

    expect(bound.target).toBe("testid=order-total");
    expect(bound.value).toBe("Total: $100.00");
    expect(checkActionSafety(bound, contract(), noApprovals, reviewed)).toBeUndefined();
  });

  it("rejects oversized decisions and unsafe viewport allocations", () => {
    expect(BrowserDecisionSchema.safeParse(decision({ value: "x".repeat(4_097) })).success).toBe(false);
    expect(() => parseViewportSize("99999x99999")).toThrow("must not exceed");
    expect(() => parseViewportSize("4096x4096")).toThrow("8,000,000 total pixels");
    expect(parseViewportSize("390x844")).toEqual({ width: 390, height: 844 });
  });
});
