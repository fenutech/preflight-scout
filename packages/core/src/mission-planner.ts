import type { ImpactMap, QAMission, QAContract } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import { QAMissionSchema } from "./schemas.js";
import { INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN } from "./impact-mapper.js";

const MAX_MISSION_UNKNOWNS = 200;

export async function createQAMission(input: {
  impactMap: ImpactMap;
  contract: QAContract;
  llm?: LLMClient;
}): Promise<QAMission> {
  if (!input.llm) {
    throw new Error("Preflight Scout mission planning requires an LLM provider. Set PREFLIGHT_SCOUT_LLM_PROVIDER to openai/anthropic/gemini with an API key, or codex-exec/claude-exec/gemini-exec for a local agent CLI.");
  }

  const generatedMission = await input.llm.completeJson<QAMission>(missionPrompt(input.impactMap, input.contract), {
    schema: QAMissionSchema,
    schemaName: "qa_mission"
  });
  const mission = QAMissionSchema.parse(generatedMission);
  const runnableCandidates = mission.automationCandidates.filter(hasFinalStateCompletionAssertion);
  const omittedCandidates = mission.automationCandidates.filter((candidate) => !hasFinalStateCompletionAssertion(candidate));
  const requiredUnknowns = omittedCandidates.map((candidate) =>
    `Automation candidate "${candidate.id}" was omitted because it has no valid reviewed assert_visible/assert_text completion step after its final state-changing action. Keep this check manual or regenerate it with explicit final-state evidence.`
  );
  if (input.impactMap.unknowns.includes(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN)) {
    requiredUnknowns.push(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  }
  return QAMissionSchema.parse({
    ...mission,
    automationCandidates: runnableCandidates,
    unknowns: appendRequiredUnknowns(mission.unknowns, requiredUnknowns)
  });
}

function hasFinalStateCompletionAssertion(candidate: QAMission["automationCandidates"][number]): boolean {
  let finalStateChangeIndex = -1;
  candidate.steps.forEach((step, index) => {
    if (isReviewedStateChange(step)) finalStateChangeIndex = index;
  });
  return candidate.steps.some((step, index) => index > finalStateChangeIndex && isValidCompletionAssertion(step));
}

function isReviewedStateChange(step: QAMission["automationCandidates"][number]["steps"][number]): boolean {
  return step.action === "goto"
    || step.action === "login"
    || step.action === "click"
    || step.action === "fill"
    || step.action === "press";
}

function isValidCompletionAssertion(step: QAMission["automationCandidates"][number]["steps"][number]): boolean {
  if (!step.target?.trim()) return false;
  if (step.action === "assert_visible") return true;
  return step.action === "assert_text" && Boolean(step.expected?.trim());
}

function appendRequiredUnknowns(unknowns: string[], required: string[]): string[] {
  const uniqueRequired = [...new Set(required)].slice(0, MAX_MISSION_UNKNOWNS);
  const requiredSet = new Set(uniqueRequired);
  const providerUnknowns = [...new Set(unknowns)].filter((unknown) => !requiredSet.has(unknown));
  return [
    ...providerUnknowns.slice(0, MAX_MISSION_UNKNOWNS - uniqueRequired.length),
    ...uniqueRequired
  ];
}

function missionPrompt(impactMap: ImpactMap, contract: QAContract): LLMMessage[] {
  return [
    {
      role: "system",
      content: `You are Preflight Scout's mission-planning agent.

Return only valid JSON matching this shape:
{
  "id": "string",
  "title": "string",
  "risk": "low|medium|high|critical",
  "summary": "string",
  "affectedAreas": [{"kind":"route|api|component|data|auth|billing|integration|config|test|unknown","name":"string","evidence":["string"],"risk":"low|medium|high|critical"}],
  "manualChecklist": ["specific human QA checks"],
  "edgeCases": ["specific edge cases"],
  "automationCandidates": [{
    "id": "string",
    "title": "string",
    "role": "string optional",
    "startPath": "string optional",
    "risk": "low|medium|high|critical",
    "reason": ["why this browser mission matters"],
    "steps": [{
      "id": "string",
      "instruction": "string",
      "action": "goto|login|click|fill|press|assert_visible|assert_text|observe|approval_gate",
      "policyLabel": "exact dangerousActions allowed/requireApproval/forbidden label; required for goto/login/click/fill/press",
      "target": "string optional",
      "value": "string optional",
      "valueEnv": "string optional",
      "expected": "string optional",
      "requiresApproval": false
    }]
  }],
  "unknowns": ["string"]
}

Plan like a real QA person. Figure out exactly what to click, type, inspect, and assert.
Use the QA Contract for credentials, safe actions, dangerous actions, and business context.
When an authenticated flow is needed, use an exact configured auth role name from contract.auth.roles. If no configured role fits, explain the missing role in unknowns instead of inventing a generic role such as "user".
If a configured role includes username/password env var names, assume those values can be used by the browser runner through valueEnv/env references without exposing the secret value.
Do not invent test data or credentials. If needed data is missing, add it to unknowns.
Use approval_gate only for an exact action label listed in contract.dangerousActions.requireApproval. Put that exact label in the step target and set requiresApproval to true. Never use approval_gate merely because a locator is missing.
Every goto, login, click, fill, or press step must set policyLabel to one exact label from contract.dangerousActions.allowed, requireApproval, or forbidden. This field is the reviewed semantic intent; do not use a locator, step id, synonym, or generic browser verb unless that exact string is present in the contract. A requireApproval policyLabel also requires an approval_gate with the same exact target. Do not automate forbidden policy labels.
Every step id must be unique within its automation candidate.
Browser steps must be executable but conservative: prefer labels, visible text, routes, and high-level observations.
Keep each automation candidate narrow enough for an autonomous browser agent to finish in one short run. Prefer one primary user journey or one layout risk per candidate, roughly 3-6 meaningful actions. Split broad cross-page checks into multiple candidates instead of creating one long mission that samples many pages.
Every automation candidate must include at least one explicit assert_visible or assert_text step after its final reviewed state-changing step (goto, login, click, fill, or press), with an exact reviewed target and nonblank expected text for assert_text. These are the only completion assertions that can support a passed browser result.
Assertions before a later goto, login, click, fill, or press step are intermediate evidence only. Preserve them when they are useful, but add separate final-state assertions after the last state-changing step.
Use separate reviewed assertions for independently addressable completion claims instead of combining several claims into one observation.
An observe step is discovery-only: it is not executable completion coverage, cannot be the only finish condition, and cannot prove that an element is absent from the accessibility tree.
Each candidate should have a clear finish condition the browser agent can verify from the live page, screenshot, URL, visible text, console errors, or network failures.
For click/fill/assert targets, use explicit target prefixes only:
- css=<selector>
- text=<visible text>
- label=<accessible label>
- testid=<data-testid>
- role=<role>|name=<accessible name>

Do not rely on the runner to guess locators. If you cannot identify a target from repository evidence, use an observe step only to discover the control, then add an exact reviewed assertion. If no safe completion assertion can be planned from repository evidence, keep the check in manualChecklist or unknowns instead of emitting an automation candidate.`
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "Create a PR-specific QA mission with precise manual checks and executable browser mission steps.",
          impactMap,
          contract
        },
        null,
        2
      )
    }
  ];
}
