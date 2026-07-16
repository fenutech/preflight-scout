import path from "node:path";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { ImpactMap, MissionRunResult, PromotedRegressionTest, QAContract, QAMission } from "./types.js";
import { PromotedRegressionTestSchema } from "./schemas.js";

export async function promoteRegressionTest(input: {
  llm: LLMClient;
  contract: QAContract;
  impactMap: ImpactMap;
  mission: QAMission;
  runResults: MissionRunResult[];
  missionId?: string;
  outputDir?: string;
}): Promise<PromotedRegressionTest> {
  const promoted = await input.llm.completeJson<PromotedRegressionTest>(promotionPrompt(input), {
    schema: PromotedRegressionTestSchema,
    schemaName: "promoted_regression_test",
    maxRepairAttempts: 2
  });
  return normalizePromotion(promoted, input.outputDir ?? "tests/preflight-scout");
}

export function normalizePromotion(promotion: PromotedRegressionTest, outputDir: string): PromotedRegressionTest {
  const relative = promotion.filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (relative.includes("..")) {
    throw new Error(`Promotion filePath must stay inside ${outputDir}: ${promotion.filePath}`);
  }
  return {
    ...promotion,
    filePath: path.posix.join(outputDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), relative),
    content: promotion.content.endsWith("\n") ? promotion.content : `${promotion.content}\n`
  };
}

function promotionPrompt(input: {
  contract: QAContract;
  impactMap: ImpactMap;
  mission: QAMission;
  runResults: MissionRunResult[];
  missionId?: string;
  outputDir?: string;
}): LLMMessage[] {
  return [
    {
      role: "system",
      content: `You are Preflight Scout's regression promotion agent.

Turn proven PR-specific browser evidence into one durable Playwright test file.

Return only JSON matching:
{
  "filePath": "relative file path such as checkout-promo.spec.ts",
  "testTitle": "short title",
  "content": "complete Playwright test TypeScript source",
  "notes": ["human notes"],
  "coveredMissionIds": ["mission ids covered"]
}

Rules:
- The test must be generic Playwright TypeScript using @playwright/test.
- Keep selectors semantic and maintainable.
- Do not include real secrets. Use process.env for credentials and storage state assumptions.
- Preserve traceability in comments: mention the PR mission id(s) and why the test exists.
- If the evidence is failed or blocked, produce a test that captures the intended regression, and note what blocked confidence.
- Do not invent product behavior beyond the mission, impact map, contract, and browser evidence.`
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "Promote this Preflight Scout run into a durable Playwright regression test.",
        preferredOutputDir: input.outputDir ?? "tests/preflight-scout",
        missionId: input.missionId,
        contract: input.contract,
        impactMap: input.impactMap,
        mission: input.mission,
        runResults: input.runResults
      }, null, 2)
    }
  ];
}
