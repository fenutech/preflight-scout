import { describe, expect, it } from "vitest";
import { createQAMission, INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN, type ImpactMap, type LLMClient, type LLMMessage, type QAContract, type QAFlowMission, type StructuredJsonOptions } from "./index.js";

class CaptureLLM implements LLMClient {
  messages: LLMMessage[] = [];

  constructor(
    private readonly unknowns: string[] = [],
    private readonly automationCandidates: QAFlowMission[] = []
  ) {}

  async completeJson<T>(messages: LLMMessage[], _options: StructuredJsonOptions<T>): Promise<T> {
    this.messages = messages;
    return {
      id: "auth-qa",
      title: "Auth QA",
      risk: "medium",
      summary: "Validate auth",
      affectedAreas: [],
      manualChecklist: [],
      edgeCases: [],
      automationCandidates: this.automationCandidates,
      unknowns: this.unknowns
    } as T;
  }
}

describe("createQAMission", () => {
  it("tells the LLM to use configured role names instead of inventing auth roles", async () => {
    const llm = new CaptureLLM();
    await createQAMission({
      impactMap: impactMap(),
      contract: contract(),
      llm
    });

    const prompt = llm.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("use an exact configured auth role name");
    expect(prompt).toContain("instead of inventing a generic role");
    expect(prompt).toContain("qa_user");
    expect(prompt).toContain("PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL");
  });

  it("reserves approval gates for configured action labels rather than missing locators", async () => {
    const llm = new CaptureLLM();
    await createQAMission({
      impactMap: impactMap(),
      contract: contract(),
      llm
    });

    const prompt = llm.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("Use approval_gate only for an exact action label");
    expect(prompt).toContain("Never use approval_gate merely because a locator is missing");
    expect(prompt).toContain("use an observe step only to discover the control");
  });

  it("requires reviewed completion assertions and keeps observe steps discovery-only", async () => {
    const llm = new CaptureLLM();
    await createQAMission({
      impactMap: impactMap(),
      contract: contract(),
      llm
    });

    const prompt = llm.messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("Every automation candidate must include at least one explicit assert_visible or assert_text step after its final reviewed state-changing step");
    expect(prompt).toContain("Assertions before a later goto, login, click, fill, or press step are intermediate evidence");
    expect(prompt).toContain("An observe step is discovery-only");
    expect(prompt).toContain("cannot prove that an element is absent from the accessibility tree");
    expect(prompt).toContain("keep the check in manualChecklist or unknowns");
  });

  it("omits candidates without final-state assertions while preserving intermediate and completion evidence", async () => {
    const llm = new CaptureLLM([], [assertableTransition(), assertionBeforeMutationTransition(), assertionlessTransition()]);

    const mission = await createQAMission({ impactMap: impactMap(), contract: contract(), llm });

    expect(mission.automationCandidates.map((candidate) => candidate.id)).toEqual(["promo-expired-assertable"]);
    expect(mission.automationCandidates[0]?.steps.filter((step) => step.action === "assert_visible" || step.action === "assert_text"))
      .toHaveLength(3);
    expect(mission.unknowns).toContain(
      "Automation candidate \"promo-valid-to-expired\" was omitted because it has no valid reviewed assert_visible/assert_text completion step after its final state-changing action. Keep this check manual or regenerate it with explicit final-state evidence."
    );
    expect(mission.unknowns).toContain(
      "Automation candidate \"promo-asserted-before-transition\" was omitted because it has no valid reviewed assert_visible/assert_text completion step after its final state-changing action. Keep this check manual or regenerate it with explicit final-state evidence."
    );
  });

  it("preserves deterministic incomplete-inventory context when the model omits it", async () => {
    const llm = new CaptureLLM();
    const input = impactMap();
    input.unknowns.push(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);

    const mission = await createQAMission({ impactMap: input, contract: contract(), llm });

    expect(mission.unknowns).toContain(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  });

  it("reserves schema space for deterministic inventory coverage", async () => {
    const llm = new CaptureLLM(
      Array.from({ length: 200 }, (_, index) => `provider unknown ${index}`),
      [assertionlessTransition()]
    );
    const input = impactMap();
    input.unknowns.push(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);

    const mission = await createQAMission({ impactMap: input, contract: contract(), llm });

    expect(mission.unknowns).toHaveLength(200);
    expect(mission.unknowns).toContain(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
    expect(mission.unknowns).toContain(
      "Automation candidate \"promo-valid-to-expired\" was omitted because it has no valid reviewed assert_visible/assert_text completion step after its final state-changing action. Keep this check manual or regenerate it with explicit final-state evidence."
    );
  });
});

function assertionlessTransition(): QAFlowMission {
  return {
    id: "promo-valid-to-expired",
    title: "Replace a valid discount with an expired coupon",
    startPath: "/",
    risk: "high",
    reason: ["Verify the pricing-sensitive transition."],
    steps: [{
      id: "transition-fill",
      instruction: "Enter the expired coupon.",
      action: "fill",
      policyLabel: "fill",
      target: "testid=promo-code",
      value: "EXPIRED10"
    }, {
      id: "transition-click",
      instruction: "Apply the expired coupon.",
      action: "click",
      policyLabel: "click",
      target: "testid=apply-promo"
    }, {
      id: "transition-finish",
      instruction: "Confirm the alert, total, console, and network state.",
      action: "observe",
      target: "testid=promo-error",
      expected: "The expiration alert and Total: $100.00 are visible with no console or network errors."
    }]
  };
}

function assertableTransition(): QAFlowMission {
  return {
    id: "promo-expired-assertable",
    title: "Verify the expired coupon result",
    startPath: "/",
    risk: "high",
    reason: ["Bind the final state to reviewed evidence."],
    steps: [{
      id: "initial-total",
      instruction: "Record the reviewed starting total.",
      action: "assert_text",
      target: "testid=order-total",
      expected: "Total: $100.00"
    }, {
      id: "expired-code",
      instruction: "Enter the expired coupon.",
      action: "fill",
      policyLabel: "fill",
      target: "testid=promo-code",
      value: "EXPIRED10"
    }, {
      id: "apply-expired-code",
      instruction: "Apply the expired coupon.",
      action: "click",
      policyLabel: "click",
      target: "testid=apply-promo"
    }, {
      id: "expired-alert",
      instruction: "Verify the expiration alert is visible.",
      action: "assert_visible",
      target: "testid=promo-error"
    }, {
      id: "restored-total",
      instruction: "Verify the original total is restored.",
      action: "assert_text",
      target: "testid=order-total",
      expected: "Total: $100.00"
    }]
  };
}

function assertionBeforeMutationTransition(): QAFlowMission {
  return {
    id: "promo-asserted-before-transition",
    title: "Do not mistake initial state for completion evidence",
    startPath: "/",
    risk: "high",
    reason: ["An assertion before the transition is intermediate evidence only."],
    steps: [{
      id: "initial-total",
      instruction: "Verify the initial total.",
      action: "assert_text",
      target: "testid=order-total",
      expected: "Total: $100.00"
    }, {
      id: "expired-code",
      instruction: "Enter the expired coupon.",
      action: "fill",
      policyLabel: "fill",
      target: "testid=promo-code",
      value: "EXPIRED10"
    }, {
      id: "apply-expired-code",
      instruction: "Apply the expired coupon.",
      action: "click",
      policyLabel: "click",
      target: "testid=apply-promo"
    }]
  };
}

function impactMap(): ImpactMap {
  return {
    summary: "Auth dashboard changed.",
    risk: "high",
    changedFiles: [{ path: "src/dashboard.tsx", status: "modified" }],
    affectedRoutes: [],
    affectedAreas: [{ kind: "auth", name: "Dashboard", evidence: ["src/dashboard.tsx changed"], risk: "high" }],
    suggestedRoles: ["qa_user"],
    unknowns: []
  };
}

function contract(): QAContract {
  return {
    app: { localUrl: "http://127.0.0.1:4173" },
    auth: {
      roles: {
        qa_user: {
          usernameEnv: "PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL",
          passwordEnv: "PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD",
          storageState: ".preflight-scout/auth/qa_user.json"
        }
      }
    },
    criticalFlows: ["login"],
    sensitiveAreas: ["auth"],
    dangerousActions: { allowed: ["login"], requireApproval: [], forbidden: [] },
    testData: {},
    unknowns: []
  };
}
