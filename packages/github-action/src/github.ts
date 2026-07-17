import * as github from "@actions/github";
import { resolveTargetUrl, type QAContract } from "@preflight-scout/core";

export const REPORT_MARKER = "<!-- preflight-scout-report -->";

export type PullRequest = NonNullable<typeof github.context.payload.pull_request>;
export type Octokit = ReturnType<typeof github.getOctokit>;

export async function resolveActionAppUrl(input: {
  explicitUrl?: string;
  target?: string;
  targetEnv: string;
  contract: QAContract;
  octokit: Octokit;
  pull: PullRequest;
  detectDeploymentUrl: boolean;
}): Promise<string> {
  if (input.explicitUrl) {
    return resolveTargetUrl(input.contract, { url: input.explicitUrl, target: input.target, env: input.targetEnv });
  }
  if (input.targetEnv === "auto" && process.env.PREFLIGHT_SCOUT_APP_URL) {
    return resolveTargetUrl(input.contract, { url: process.env.PREFLIGHT_SCOUT_APP_URL, target: input.target, env: "auto" });
  }

  if (input.targetEnv === "auto" && input.detectDeploymentUrl) {
    const deploymentUrl = await findLatestSuccessfulDeploymentUrl(input.octokit, input.pull);
    if (deploymentUrl) {
      return resolveTargetUrl(input.contract, { url: deploymentUrl, target: input.target, env: "auto" });
    }
  }

  return resolveTargetUrl(input.contract, { target: input.target, env: input.targetEnv });
}

export async function upsertPullRequestComment(octokit: Octokit, pull: PullRequest, body: string): Promise<void> {
  const comments = await octokit.rest.issues.listComments({
    ...github.context.repo,
    issue_number: pull.number,
    per_page: 100
  });
  const markedComments = comments.data.filter((comment) => comment.body?.includes(REPORT_MARKER));
  let existing = markedComments.find((comment) => (
    comment.user?.type === "Bot" && comment.user.login.toLowerCase() === "github-actions[bot]"
  ));
  if (!existing && markedComments.length) {
    const authenticated = await authenticatedIdentity(octokit);
    if (authenticated) {
      existing = markedComments.find((comment) => (
        comment.user?.id === authenticated.id
        || comment.user?.login.toLowerCase() === authenticated.login.toLowerCase()
      ));
    }
  }
  if (existing) {
    await octokit.rest.issues.updateComment({
      ...github.context.repo,
      comment_id: existing.id,
      body
    });
    return;
  }
  await octokit.rest.issues.createComment({
    ...github.context.repo,
    issue_number: pull.number,
    body
  });
}

async function authenticatedIdentity(octokit: Octokit): Promise<{ id: number; login: string } | undefined> {
  try {
    const response = await octokit.rest.users.getAuthenticated();
    return { id: response.data.id, login: response.data.login };
  } catch {
    // Installation tokens do not always expose GET /user. The built-in
    // github-actions[bot] identity is handled without this lookup above.
    return undefined;
  }
}

export async function setCommitStatus(octokit: Octokit, pull: PullRequest, state: "error" | "failure" | "pending" | "success", description: string): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    ...github.context.repo,
    sha: pull.head.sha,
    state,
    context: "Preflight Scout",
    description
  });
}

export function defaultArtifactName(pull: PullRequest): string {
  return `preflight-scout-pr-${pull.number}-${pull.head.sha.slice(0, 7)}`;
}

async function findLatestSuccessfulDeploymentUrl(octokit: Octokit, pull: PullRequest): Promise<string | undefined> {
  const deployments = await octokit.rest.repos.listDeployments({
    ...github.context.repo,
    ref: pull.head.sha,
    per_page: 20
  });
  for (const deployment of deployments.data) {
    const statuses = await octokit.rest.repos.listDeploymentStatuses({
      ...github.context.repo,
      deployment_id: deployment.id,
      per_page: 10
    });
    const success = statuses.data.find((status) => status.state === "success" && (status.environment_url || status.target_url));
    if (success?.environment_url) return success.environment_url;
    if (success?.target_url) return success.target_url;
  }
  return undefined;
}
