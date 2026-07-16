import { describe, expect, it } from "vitest";
import { createQAMission, type ImpactMap, type LLMClient, type LLMMessage, type QAContract, type StructuredJsonOptions } from "./index.js";

class CaptureLLM implements LLMClient {
  messages: LLMMessage[] = [];

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
      automationCandidates: [],
      unknowns: []
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
    expect(prompt).toContain("create an observe step");
  });
});

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
