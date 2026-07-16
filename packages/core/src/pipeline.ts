import { loadContract } from "./contract.js";
import { readGitDiff } from "./git-diff.js";
import { createDefaultLLMFromEnv, type LLMClient } from "./llm.js";
import { createImpactMap } from "./impact-mapper.js";
import { createQAMission } from "./mission-planner.js";
import { redactContract, redactPullRequestContext, redactRepoIndex } from "./redaction.js";
import { indexRepository } from "./repo-indexer.js";
import { renderMarkdownReport } from "./report.js";

export async function analyzePullRequest(options: {
  root: string;
  base: string;
  head: string;
  title?: string;
  body?: string;
  llm?: LLMClient;
  progress?: (message: string) => void;
}) {
  options.progress?.("Indexing repository context");
  const repoIndex = await indexRepository(options.root);
  options.progress?.("Loading Preflight Scout contract");
  const contract = await loadContract(options.root);
  options.progress?.(`Reading git diff ${options.base}...${options.head}`);
  const pullRequest = {
    ...await readGitDiff({ base: options.base, head: options.head, cwd: options.root, includePatch: true }),
    title: options.title,
    body: options.body
  };
  const llm = options.llm ?? createDefaultLLMFromEnv();
  const safeRepoIndex = redactRepoIndex(repoIndex);
  const safeContract = redactContract(contract);
  const safePullRequest = redactPullRequestContext(pullRequest);
  options.progress?.("Calling LLM impact mapper");
  const impactMap = await createImpactMap({ repoIndex: safeRepoIndex, contract: safeContract, pullRequest: safePullRequest, llm });
  options.progress?.("Calling LLM mission planner");
  const mission = await createQAMission({ impactMap, contract: safeContract, llm });
  options.progress?.("Rendering human QA report");
  const markdown = renderMarkdownReport({ impactMap, mission });
  return { repoIndex, contract, pullRequest, impactMap, mission, markdown };
}
