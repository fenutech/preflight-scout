import { describe, expect, it } from "vitest";
import { z } from "zod";
import { completeWithRepair, type LLMMessage, type StructuredJsonOptions } from "./llm.js";
import { normalizePromotion, promoteRegressionTest } from "./promotion.js";
import type { ImpactMap, LLMClient, MissionRunResult, PromotedRegressionTest, QAContract, QAMission } from "./index.js";

class PromotionLLM implements LLMClient {
  async completeJson<T>(_messages: LLMMessage[], _options: StructuredJsonOptions<T>): Promise<T> {
    return {
      filePath: "checkout-promo.spec.ts",
      testTitle: "Checkout promo regression",
      content: "import { test, expect } from '@playwright/test';\n\ntest('checkout promo regression', async ({ page }) => { await page.goto('/'); });",
      notes: ["Generated from Preflight Scout mission evidence."],
      coveredMissionIds: ["valid-coupon"]
    } as T;
  }
}

const contract: QAContract = {
  app: { localUrl: "http://127.0.0.1:3000" },
  criticalFlows: [],
  sensitiveAreas: [],
  dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
  testData: {},
  unknowns: []
};

const impactMap: ImpactMap = {
  summary: "Checkout changed",
  risk: "medium",
  changedFiles: [{ path: "checkout.ts", status: "modified" }],
  affectedRoutes: [],
  affectedAreas: [],
  suggestedRoles: [],
  unknowns: []
};

const mission: QAMission = {
  id: "checkout",
  title: "Checkout QA",
  risk: "medium",
  summary: "Checkout changed",
  affectedAreas: [],
  manualChecklist: [],
  edgeCases: [],
  automationCandidates: [],
  unknowns: []
};

const runResults: MissionRunResult[] = [
  { missionId: "valid-coupon", status: "passed", results: [{ stepId: "turn-1", status: "passed", message: "Passed" }], artifacts: [] }
];

describe("regression promotion", () => {
  it("asks the LLM for a durable Playwright test and scopes the output path", async () => {
    const result = await promoteRegressionTest({
      llm: new PromotionLLM(),
      contract,
      impactMap,
      mission,
      runResults,
      outputDir: "tests/preflight-scout"
    });

    expect(result.filePath).toBe("tests/preflight-scout/checkout-promo.spec.ts");
    expect(result.content).toContain("@playwright/test");
    expect(result.content.endsWith("\n")).toBe(true);
  });

  it("rejects promoted paths that escape the output directory", () => {
    const promotion: PromotedRegressionTest = {
      filePath: "../escape.spec.ts",
      testTitle: "Escape",
      content: "test('x', async () => {});",
      notes: [],
      coveredMissionIds: []
    };

    expect(() => normalizePromotion(promotion, "tests/preflight-scout")).toThrow("must stay inside");
  });
});

describe("LLM provider retry", () => {
  it("retries transient provider failures before validating JSON", async () => {
    let attempts = 0;
    const result = await completeWithRepair([{ role: "user", content: "return json" }], {
      schemaName: "example",
      schema: z.object({ ok: z.boolean() }),
      maxProviderAttempts: 2
    }, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient 503");
      return '{"ok":true}';
    });

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
  });
});
