import type { ImpactMap, PullRequestContext, QAContract, RepoIndex } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import { ImpactMapSchema } from "./schemas.js";

export const MAX_IMPACT_PROMPT_CHARS = 900 * 1024;
export const INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN = "Repository file inventory is incomplete; impact coverage is not exhaustive.";
const MAX_IMPACT_UNKNOWNS = 200;
const MAX_PROMPT_REPO_INDEX_CHARS = 180 * 1024;
const MAX_PROMPT_CONTRACT_CHARS = 100 * 1024;
const MAX_PROMPT_PULL_REQUEST_CHARS = 600 * 1024;
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

  const impactMap = await input.llm.completeJson<ImpactMap>(impactPrompt(input.repoIndex, input.contract, input.pullRequest), {
    schema: ImpactMapSchema,
    schemaName: "impact_map"
  });
  if (input.repoIndex.fileInventoryCoverage?.complete === false) {
    impactMap.unknowns = appendRequiredUnknown(
      impactMap.unknowns,
      INCOMPLETE_REPOSITORY_INVENTORY_UNKNOWN,
      MAX_IMPACT_UNKNOWNS
    );
  }
  return ImpactMapSchema.parse(impactMap);
}

export function appendRequiredUnknown(unknowns: string[], required: string, maxItems: number): string[] {
  if (!Number.isSafeInteger(maxItems) || maxItems < 1) {
    throw new Error("maxItems must be a positive safe integer");
  }
  const otherUnknowns = [...new Set(unknowns)].filter((unknown) => unknown !== required);
  return [...otherUnknowns.slice(0, maxItems - 1), required];
}

function impactPrompt(repoIndex: RepoIndex, contract: QAContract, pullRequest: PullRequestContext): LLMMessage[] {
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
Every affected area must include evidence tied to changed files, routes, or explicit contract context.`;
  const promptPayload = JSON.stringify({
    task: "Map this pull request to user-visible QA impact: routes, APIs, roles, data, integrations, and release risk.",
    repoIndex: boundRepoIndexForPrompt(repoIndex),
    contract: boundContractForPrompt(contract),
    pullRequest: boundPullRequestForPrompt(pullRequest)
  });
  if (systemPrompt.length + promptPayload.length > MAX_IMPACT_PROMPT_CHARS) {
    throw new Error(`Impact prompt exceeds the ${MAX_IMPACT_PROMPT_CHARS}-character global safety budget.`);
  }
  return [
    {
      role: "system",
      content: systemPrompt
    },
    {
      role: "user",
      content: promptPayload
    }
  ];
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

function boundPullRequestForPrompt(pullRequest: PullRequestContext): Record<string, unknown> {
  const output: Record<string, unknown> = {
    ...(pullRequest.title ? { title: clipPromptString(pullRequest.title) } : {}),
    ...(pullRequest.body ? { body: clipPromptString(pullRequest.body) } : {}),
    ...(pullRequest.base ? { base: clipPromptString(pullRequest.base) } : {}),
    ...(pullRequest.head ? { head: clipPromptString(pullRequest.head) } : {}),
    ...(pullRequest.contextCoverage ? { contextCoverage: pullRequest.contextCoverage } : {}),
    files: []
  };
  const included = output.files as Array<Record<string, unknown>>;
  let used = JSON.stringify(output).length;
  const reserve = 1024;
  for (const file of pullRequest.files) {
    const boundedFile: Record<string, unknown> = {
      ...file,
      path: clipPromptString(file.path),
      ...(file.patch ? { patch: clipPromptString(file.patch) } : {}),
      ...(file.content ? { content: clipPromptString(file.content) } : {}),
      ...(file.contextNote ? { contextNote: clipPromptString(file.contextNote) } : {})
    };
    const cost = JSON.stringify(boundedFile).length + 1;
    if (used + cost + reserve > MAX_PROMPT_PULL_REQUEST_CHARS) break;
    included.push(boundedFile);
    used += cost;
  }
  const omittedFiles = pullRequest.files.length - included.length;
  output.promptCoverage = {
    totalChangedFiles: pullRequest.files.length,
    includedChangedFiles: included.length,
    omittedChangedFiles: omittedFiles,
    complete: omittedFiles === 0,
    ...(omittedFiles ? {
      note: "Changed-file metadata beyond the deterministic impact-prompt budget was omitted. Treat impact coverage as incomplete and report this uncertainty."
    } : {})
  };
  return output;
}

function boundRepoIndexForPrompt(repoIndex: RepoIndex): Record<string, unknown> {
  const output: Record<string, unknown> = {
    root: clipPromptString(repoIndex.root),
    ...(repoIndex.fileInventoryCoverage ? { fileInventoryCoverage: repoIndex.fileInventoryCoverage } : {}),
    packageManager: repoIndex.packageManager,
    manifests: {},
    files: [],
    frameworks: [],
    routes: [],
    components: [],
    tests: [],
    configFiles: [],
    integrationHints: []
  };
  let used = JSON.stringify(output).length;
  const reserve = 2048;
  const canAdd = (value: unknown): boolean => {
    const cost = JSON.stringify(value).length + 1;
    if (used + cost + reserve > MAX_PROMPT_REPO_INDEX_CHARS) return false;
    used += cost;
    return true;
  };

  const manifests = output.manifests as Record<string, string>;
  for (const [name, contents] of Object.entries(repoIndex.manifests)) {
    const entry = [clipPromptString(name), clipPromptString(contents)] as const;
    if (!canAdd(entry)) break;
    manifests[entry[0]] = entry[1];
  }
  appendPromptArray(output.files as unknown[], repoIndex.files, canAdd, (value) => clipPromptString(value));
  appendPromptArray(output.frameworks as unknown[], repoIndex.frameworks, canAdd, (value) => clipPromptString(value));
  appendPromptArray(output.routes as unknown[], repoIndex.routes, canAdd, (value) => ({
    ...value,
    path: clipPromptString(value.path),
    file: clipPromptString(value.file)
  }));
  appendPromptArray(output.components as unknown[], repoIndex.components, canAdd, (value) => ({
    ...value,
    name: clipPromptString(value.name),
    file: clipPromptString(value.file)
  }));
  appendPromptArray(output.tests as unknown[], repoIndex.tests, canAdd, (value) => clipPromptString(value));
  appendPromptArray(output.configFiles as unknown[], repoIndex.configFiles, canAdd, (value) => clipPromptString(value));
  appendPromptArray(output.integrationHints as unknown[], repoIndex.integrationHints, canAdd, (value) => clipPromptString(value));

  const sourceCount = repoIndex.files.length
    + repoIndex.frameworks.length
    + repoIndex.routes.length
    + repoIndex.components.length
    + repoIndex.tests.length
    + repoIndex.configFiles.length
    + repoIndex.integrationHints.length
    + Object.keys(repoIndex.manifests).length;
  const includedCount = (output.files as unknown[]).length
    + (output.frameworks as unknown[]).length
    + (output.routes as unknown[]).length
    + (output.components as unknown[]).length
    + (output.tests as unknown[]).length
    + (output.configFiles as unknown[]).length
    + (output.integrationHints as unknown[]).length
    + Object.keys(manifests).length;
  output.promptCoverage = {
    totalEntries: sourceCount,
    includedEntries: includedCount,
    omittedEntries: sourceCount - includedCount,
    complete: sourceCount === includedCount,
    ...(sourceCount === includedCount ? {} : {
      note: "Repository-index entries beyond the deterministic impact-prompt budget were omitted."
    })
  };
  return output;
}

function appendPromptArray<T>(
  target: unknown[],
  source: T[],
  canAdd: (value: unknown) => boolean,
  transform: (value: T) => unknown
): void {
  for (const value of source) {
    const bounded = transform(value);
    if (!canAdd(bounded)) break;
    target.push(bounded);
  }
}

function clipPromptString(value: string): string {
  if (value.length <= MAX_PROMPT_STRING_CHARS) return value;
  const suffix = "\n[truncated for impact-prompt budget]";
  return `${value.slice(0, MAX_PROMPT_STRING_CHARS - suffix.length)}${suffix}`;
}
