import type { ImpactMap, PullRequestContext, QAContract, RepoIndex } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import { ImpactMapSchema } from "./schemas.js";
import { normalizeRepoFileInventoryCoverage, redactRepoIndex } from "./redaction.js";
import { boundRepoIndexForPrompt, clipJsonString } from "./prompt-context.js";

export const MAX_IMPACT_PROMPT_CHARS = 192 * 1024;
export const INCOMPLETE_IMPACT_CONTEXT_UNKNOWN = "Impact input context was omitted or truncated; impact coverage is not exhaustive.";
export const INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN = "Repository file inventory is incomplete; impact coverage is not exhaustive.";
const MAX_IMPACT_UNKNOWNS = 200;
const MAX_PROMPT_CONTRACT_CHARS = 48 * 1024;
const MAX_PROMPT_PULL_REQUEST_CHARS = 104 * 1024;
const MAX_PROMPT_STRING_CHARS = 20 * 1024;

export async function createImpactMap(input: {
  repoIndex: RepoIndex;
  contract: QAContract;
  pullRequest: PullRequestContext;
  llm?: LLMClient;
}): Promise<ImpactMap> {
  if (!input.llm) {
    throw new Error("Preflight Scout impact mapping requires an LLM provider. Set PREFLIGHT_SCOUT_LLM_PROVIDER to openai/anthropic/gemini with an API key, or codex-exec/claude-exec/gemini-exec for a local agent CLI.");
  }

  const safeRepoIndex = redactRepoIndex(input.repoIndex);
  const prompt = impactPrompt(safeRepoIndex, input.contract, input.pullRequest);
  const impactMap = await input.llm.completeJson<ImpactMap>(prompt.messages, {
    schema: ImpactMapSchema,
    schemaName: "impact_map"
  });
  const requiredUnknowns: string[] = [];
  if (!normalizeRepoFileInventoryCoverage(input.repoIndex).complete) requiredUnknowns.push(INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN);
  if (!prompt.complete || input.pullRequest.contextCoverage?.complete === false
    || input.pullRequest.files.some((file) => file.contextStatus && file.contextStatus !== "included")) {
    requiredUnknowns.push(INCOMPLETE_IMPACT_CONTEXT_UNKNOWN);
  }
  impactMap.unknowns = [
    ...[...new Set(impactMap.unknowns)].filter((unknown) => !requiredUnknowns.includes(unknown)).slice(0, MAX_IMPACT_UNKNOWNS - requiredUnknowns.length),
    ...requiredUnknowns
  ];
  return ImpactMapSchema.parse(impactMap);
}

export function appendRequiredUnknown(unknowns: string[], required: string, maxItems: number): string[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new Error("maxItems must be a positive safe integer");
  }
  const otherUnknowns = [...new Set(unknowns)].filter((unknown) => unknown !== required);
  return [...otherUnknowns.slice(0, maxItems - 1), required];
}

function impactPrompt(repoIndex: RepoIndex, contract: QAContract, pullRequest: PullRequestContext): { messages: LLMMessage[]; complete: boolean } {
  const systemPrompt = `You are Preflight Scout's impact-mapping agent.

Return only valid JSON matching this shape:
{
  "summary": "string",
  "risk": "low|medium|high|critical",
  "changedFiles": [{"path":"string","status":"added|modified|deleted|renamed|unknown","patch":"string optional"}],
  "affectedRoutes": [{"path":"string","file":"string","kind":"page|api|unknown"}],
  "affectedAreas": [{"kind":"route|api|component|data|auth|billing|integration|config|test|unknown","name":"string","evidence":["file paths or patch facts"],"risk":"low|medium|high|critical"}],
  "suggestedRoles": ["string"],
  "unknowns": ["string"]
}

Your job is to infer product impact from code and config context, like a senior QA engineer reading the PR.
Do not use generic checklists.
Do not pretend certainty. If repo context is insufficient, add concrete unknowns.
If fileInventoryCoverage, contextCoverage, or promptCoverage says context is incomplete, state that in unknowns and do not claim exhaustive impact coverage.
The repositoryInventory field is bounded raw context, not a detected product map. The built-in indexer classifies package-manager evidence only; its other context is raw Git-visible file paths and selected root project-file excerpts. Empty frameworks, routes, components, tests, configFiles, or integrationHints arrays mean unclassified, not absent.
Every affected area must include evidence tied to changed files, routes, or explicit contract context.`;
  const repository = boundRepoIndexForPrompt(repoIndex, pullRequest.files.map((file) => file.path));
  const changedFiles = boundPullRequestForPrompt(pullRequest);
  const promptPayload = JSON.stringify({
    task: "Map this pull request to user-visible QA impact: routes, APIs, roles, data, integrations, and release risk.",
    repositoryInventory: repository.inventory,
    contract: boundContractForPrompt(contract),
    pullRequest: changedFiles.context
  });
  if (systemPrompt.length + promptPayload.length > MAX_IMPACT_PROMPT_CHARS) {
    throw new Error(`Impact prompt exceeds the ${MAX_IMPACT_PROMPT_CHARS}-character global safety budget.`);
  }
  return { complete: repository.complete && changedFiles.complete, messages: [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: promptPayload
    }
  ] };
}

function boundContractForPrompt(contract: QAContract): QAContract {
  const serialized = JSON.stringify(contract);
  if (serialized.length > MAX_PROMPT_CONTRACT_CHARS) {
    throw new Error(
      `QA contract exceeds the ${MAX_PROMPT_CONTRACT_CHARS}-character impact-prompt safety budget. Reduce contract records and string values before analysis.`
    );
  }
  return contract;
}

export function boundPullRequestForPrompt(
  pullRequest: PullRequestContext,
  maxChars = MAX_PROMPT_PULL_REQUEST_CHARS
): { context: Record<string, unknown>; complete: boolean } {
  if (!Number.isSafeInteger(maxChars) || maxChars < 16 * 1024 || maxChars > MAX_PROMPT_PULL_REQUEST_CHARS) {
    throw new Error(`Changed-file prompt budget must be an integer from ${16 * 1024} through ${MAX_PROMPT_PULL_REQUEST_CHARS} characters.`);
  }
  let truncatedFields = 0;
  const clip = (value: string, maxChars = MAX_PROMPT_STRING_CHARS): string => {
    const bounded = clipJsonString(value, maxChars);
    if (bounded !== value) truncatedFields += 1;
    return bounded;
  };
  const output: Record<string, unknown> = {
    ...(pullRequest.title ? { title: clip(pullRequest.title, 2048) } : {}),
    ...(pullRequest.body ? { body: clip(pullRequest.body, 8192) } : {}),
    ...(pullRequest.base ? { base: clip(pullRequest.base, 1024) } : {}),
    ...(pullRequest.head ? { head: clip(pullRequest.head, 1024) } : {}),
    ...(pullRequest.contextCoverage ? { contextCoverage: {
      totalFiles: pullRequest.contextCoverage.totalFiles,
      filesWithContext: pullRequest.contextCoverage.filesWithContext,
      omittedFiles: pullRequest.contextCoverage.omittedFiles,
      truncatedFiles: pullRequest.contextCoverage.truncatedFiles,
      contextChars: pullRequest.contextCoverage.contextChars,
      maxContextFiles: pullRequest.contextCoverage.maxContextFiles,
      maxContextChars: pullRequest.contextCoverage.maxContextChars,
      complete: pullRequest.contextCoverage.complete,
      ...(pullRequest.contextCoverage.note ? { note: clip(pullRequest.contextCoverage.note, 1024) } : {})
    } } : {}),
    files: []
  };
  const included = output.files as Array<Record<string, unknown>>;
  const sources: PullRequestContext["files"] = [];
  const reserve = 1536;
  let used = JSON.stringify(output).length;
  // Preserve metadata for every file that fits before any patch can consume the budget.
  for (const file of pullRequest.files) {
    const metadata = {
      path: file.path, status: file.status,
      ...(file.additions !== undefined ? { additions: file.additions } : {}),
      ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
      ...(file.contextStatus ? { contextStatus: file.contextStatus } : {}),
      ...(file.contextNote ? { contextNote: clip(file.contextNote, 1024) } : {})
    };
    const cost = JSON.stringify(metadata).length + 1;
    if (used + cost + reserve > maxChars) continue;
    included.push(metadata);
    sources.push(file);
    used += cost;
  }
  // Share the remaining space across changed files. Patches get priority over full head content.
  let remainingContextFiles = sources.filter((file) => file.patch || file.content).length;
  let omittedContextFiles = 0;
  let truncatedContextFiles = 0;
  for (const [index, file] of sources.entries()) {
    if (!file.patch && !file.content) continue;
    let allowance = Math.floor((maxChars - used - reserve) / remainingContextFiles--);
    let fieldsIncluded = 0;
    let partial = false;
    for (const key of ["patch", "content"] as const) {
      const original = file[key];
      if (!original) continue;
      const bounded = clipJsonString(original, Math.min(MAX_PROMPT_STRING_CHARS, Math.max(0, allowance - key.length - 4)));
      if (!bounded) { partial = true; continue; }
      const cost = JSON.stringify({ [key]: bounded }).length - 1;
      if (cost > allowance) { partial = true; continue; }
      included[index][key] = bounded;
      fieldsIncluded += 1;
      used += cost;
      allowance -= cost;
      if (bounded !== original) partial = true;
    }
    if (!fieldsIncluded) omittedContextFiles += 1;
    else if (partial) truncatedContextFiles += 1;
  }
  const omittedChangedFiles = pullRequest.files.length - included.length;
  const complete = omittedChangedFiles === 0 && omittedContextFiles === 0 && truncatedContextFiles === 0 && truncatedFields === 0;
  output.promptCoverage = {
    totalChangedFiles: pullRequest.files.length,
    includedChangedFiles: included.length,
    omittedChangedFiles, omittedContextFiles, truncatedContextFiles, truncatedFields, complete,
    ...(!complete ? { note: "Changed-file metadata is selected first, then remaining space is shared across patch/content excerpts. Context omitted or truncated by this budget is incomplete." } : {})
  };
  return { context: output, complete };
}
