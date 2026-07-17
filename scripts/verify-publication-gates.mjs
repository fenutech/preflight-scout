#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PUBLIC_REPOSITORY = "fenutech/preflight-scout";
export const PUBLICATION_ENVIRONMENT = "npm-production";
export const STABLE_PLUGIN_BRANCH = "plugin-stable";
const API_ROOT = "https://api.github.com";

export async function verifyPublicationGates({
  fetchImpl = fetch,
  token,
  repository = PUBLIC_REPOSITORY,
  checkImmutableReleaseSetting = true,
  allowOmittedStableBranchBypassActors = false
} = {}) {
  if (repository !== PUBLIC_REPOSITORY) {
    throw new Error(`Publication is restricted to ${PUBLIC_REPOSITORY}; received ${repository || "an empty repository"}.`);
  }
  if (!token) throw new Error("GITHUB_TOKEN is required to verify live publication gates.");

  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "preflight-scout-publication-gate",
    "x-github-api-version": "2026-03-10"
  };
  const repo = await getJson(fetchImpl, `${API_ROOT}/repos/${PUBLIC_REPOSITORY}`, headers, "public repository");
  if (repo.full_name !== PUBLIC_REPOSITORY || repo.private !== false || repo.visibility !== "public") {
    throw new Error(`${PUBLIC_REPOSITORY} must be live and public before npm publication.`);
  }

  if (typeof checkImmutableReleaseSetting !== "boolean") {
    throw new Error("checkImmutableReleaseSetting must be a boolean.");
  }
  if (typeof allowOmittedStableBranchBypassActors !== "boolean") {
    throw new Error("allowOmittedStableBranchBypassActors must be a boolean.");
  }
  if (checkImmutableReleaseSetting) {
    const immutableReleases = await getJson(
      fetchImpl,
      `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/immutable-releases`,
      headers,
      "immutable release settings"
    );
    if (immutableReleases.enabled !== true) {
      throw new Error(`${PUBLIC_REPOSITORY} must have immutable releases enabled before npm publication.`);
    }
  }

  const stablePluginBranch = await getJson(
    fetchImpl,
    `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/branches/${STABLE_PLUGIN_BRANCH}`,
    headers,
    `${STABLE_PLUGIN_BRANCH} branch`
  );
  if (
    stablePluginBranch.name !== STABLE_PLUGIN_BRANCH ||
    stablePluginBranch.protected !== true ||
    !/^[0-9a-f]{40}$/.test(stablePluginBranch.commit?.sha ?? "")
  ) {
    throw new Error(`${STABLE_PLUGIN_BRANCH} must exist as a protected branch before npm publication.`);
  }

  const environment = await getJson(
    fetchImpl,
    `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/environments/${PUBLICATION_ENVIRONMENT}`,
    headers,
    `${PUBLICATION_ENVIRONMENT} environment`
  );
  const reviewers = environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
  if (!reviewers || !Array.isArray(reviewers.reviewers) || reviewers.reviewers.length === 0) {
    throw new Error(`${PUBLICATION_ENVIRONMENT} must require at least one reviewer.`);
  }
  if (environment.deployment_branch_policy?.custom_branch_policies !== true) {
    throw new Error(`${PUBLICATION_ENVIRONMENT} must use selected branch and tag policies.`);
  }

  const policies = await getJson(
    fetchImpl,
    `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/environments/${PUBLICATION_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
    headers,
    `${PUBLICATION_ENVIRONMENT} deployment policies`
  );
  const tagPolicy = policies.branch_policies?.find((policy) => policy.name === "v*" && policy.type === "tag");
  if (!tagPolicy) {
    throw new Error(`${PUBLICATION_ENVIRONMENT} must contain the exact custom deployment tag policy v*.`);
  }

  const rulesets = await getJson(
    fetchImpl,
    `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/rulesets?per_page=100`,
    headers,
    "repository rulesets"
  );
  if (!Array.isArray(rulesets)) throw new Error("Repository rulesets must be returned as an array.");
  const activeTagRulesets = rulesets.filter((ruleset) => ruleset?.target === "tag" && ruleset?.enforcement === "active");
  if (activeTagRulesets.length === 0) {
    throw new Error("The public repository must have an active tag ruleset for refs/tags/v*.");
  }

  let protectedTagRuleset;
  let incompletelyProtectedTagRuleset;
  for (const summary of activeTagRulesets) {
    if (!Number.isSafeInteger(summary.id) || summary.id <= 0) {
      throw new Error("GitHub returned an invalid active tag ruleset identifier.");
    }
    const ruleset = await getJson(
      fetchImpl,
      `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/rulesets/${summary.id}`,
      headers,
      `tag ruleset ${summary.id}`
    );
    const includes = ruleset.conditions?.ref_name?.include;
    const excludes = ruleset.conditions?.ref_name?.exclude;
    if (
      !Array.isArray(includes) ||
      includes.length !== 1 ||
      includes[0] !== "refs/tags/v*" ||
      !Array.isArray(excludes) ||
      excludes.length !== 0
    ) {
      continue;
    }
    const ruleTypes = new Set(Array.isArray(ruleset.rules) ? ruleset.rules.map((rule) => rule?.type) : []);
    if (["creation", "update", "deletion"].every((type) => ruleTypes.has(type))) {
      protectedTagRuleset = ruleset;
      break;
    }
    incompletelyProtectedTagRuleset = ruleset;
  }
  if (!protectedTagRuleset) {
    if (incompletelyProtectedTagRuleset) {
      throw new Error("The refs/tags/v* ruleset must protect tag creation, update, and deletion.");
    }
    throw new Error("The public repository must have an active tag ruleset applying exactly to refs/tags/v* with no exclusions.");
  }

  const activeBranchRulesets = rulesets.filter(
    (ruleset) => ruleset?.target === "branch" && ruleset?.enforcement === "active"
  );
  if (activeBranchRulesets.length === 0) {
    throw new Error(`The public repository must have an active branch ruleset for refs/heads/${STABLE_PLUGIN_BRANCH}.`);
  }

  let protectedStableBranchRuleset;
  let stableBranchBypassActors;
  let stableBranchRulesError;
  for (const summary of activeBranchRulesets) {
    if (!Number.isSafeInteger(summary.id) || summary.id <= 0) {
      throw new Error("GitHub returned an invalid active branch ruleset identifier.");
    }
    const ruleset = await getJson(
      fetchImpl,
      `${API_ROOT}/repos/${PUBLIC_REPOSITORY}/rulesets/${summary.id}`,
      headers,
      `branch ruleset ${summary.id}`
    );
    if (
      ruleset.id !== summary.id ||
      ruleset.target !== "branch" ||
      ruleset.enforcement !== "active"
    ) {
      throw new Error(`GitHub returned branch ruleset ${summary.id} with details that do not match its active branch summary.`);
    }

    const includes = ruleset.conditions?.ref_name?.include;
    const excludes = ruleset.conditions?.ref_name?.exclude;
    if (
      !Array.isArray(includes) ||
      includes.length !== 1 ||
      includes[0] !== `refs/heads/${STABLE_PLUGIN_BRANCH}` ||
      !Array.isArray(excludes) ||
      excludes.length !== 0
    ) {
      continue;
    }

    const bypassActorsOmitted = !Object.hasOwn(ruleset, "bypass_actors");
    if (bypassActorsOmitted && !allowOmittedStableBranchBypassActors) {
      stableBranchRulesError = `The refs/heads/${STABLE_PLUGIN_BRANCH} ruleset must not allow bypass actors.`;
      continue;
    }
    if (!bypassActorsOmitted && (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0)) {
      stableBranchRulesError = `The refs/heads/${STABLE_PLUGIN_BRANCH} ruleset must not allow bypass actors.`;
      continue;
    }

    const rulesError = validateStableBranchRules(ruleset.rules);
    if (!rulesError) {
      protectedStableBranchRuleset = ruleset;
      stableBranchBypassActors = bypassActorsOmitted ? "admin-only-check-deferred" : "verified";
      break;
    }
    stableBranchRulesError = rulesError;
  }
  if (!protectedStableBranchRuleset) {
    if (stableBranchRulesError) throw new Error(stableBranchRulesError);
    throw new Error(`The public repository must have an active branch ruleset applying exactly to refs/heads/${STABLE_PLUGIN_BRANCH} with no exclusions.`);
  }

  return {
    repository: repo.full_name,
    visibility: repo.visibility,
    immutableReleaseSetting: checkImmutableReleaseSetting ? "verified" : "admin-only-check-deferred",
    stablePluginBranch: stablePluginBranch.name,
    stablePluginCommit: stablePluginBranch.commit.sha,
    environment: environment.name,
    reviewerCount: reviewers.reviewers.length,
    tagPolicy: tagPolicy.name,
    tagRuleset: protectedTagRuleset.name,
    stableBranchRuleset: protectedStableBranchRuleset.name,
    stableBranchBypassActors
  };
}

function validateStableBranchRules(rules) {
  if (!Array.isArray(rules) || rules.some((rule) => !rule || typeof rule.type !== "string" || rule.type.length === 0)) {
    return `The refs/heads/${STABLE_PLUGIN_BRANCH} ruleset must return a well-formed rules array.`;
  }

  const requiredRuleTypes = [
    "deletion",
    "non_fast_forward",
    "required_linear_history",
    "required_status_checks"
  ];
  if (rules.length !== requiredRuleTypes.length) {
    return `The refs/heads/${STABLE_PLUGIN_BRANCH} ruleset must contain exactly these protection rules: ${requiredRuleTypes.join(", ")}.`;
  }
  for (const type of requiredRuleTypes) {
    if (rules.filter((rule) => rule.type === type).length !== 1) {
      return `The refs/heads/${STABLE_PLUGIN_BRANCH} ruleset must contain each required protection rule exactly once: ${requiredRuleTypes.join(", ")}.`;
    }
  }

  const statusRule = rules.find((rule) => rule.type === "required_status_checks");
  const statusChecks = statusRule.parameters?.required_status_checks;
  if (
    statusRule.parameters?.strict_required_status_checks_policy !== true ||
    statusRule.parameters?.do_not_enforce_on_create !== false ||
    !Array.isArray(statusChecks) ||
    statusChecks.length !== 1 ||
    statusChecks[0]?.context !== "Required" ||
    statusChecks[0]?.integration_id !== 15368
  ) {
    return `The refs/heads/${STABLE_PLUGIN_BRANCH} ruleset must strictly require exactly the Required status check from GitHub Actions integration 15368.`;
  }

  return undefined;
}

async function getJson(fetchImpl, url, headers, label) {
  const response = await fetchImpl(url, { headers, redirect: "error" });
  const text = await response.text();
  if (!response.ok) throw new Error(`Could not verify ${label}: GitHub returned HTTP ${response.status}.`);
  if (text.length > 1024 * 1024) throw new Error(`Could not verify ${label}: response exceeded 1 MiB.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Could not verify ${label}: GitHub returned invalid JSON.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--github-actions-token") || arguments_.length > 1) {
    throw new Error("Usage: node scripts/verify-publication-gates.mjs [--github-actions-token]");
  }
  const usesGitHubActionsToken = arguments_[0] === "--github-actions-token";
  const result = await verifyPublicationGates({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
    checkImmutableReleaseSetting: !usesGitHubActionsToken,
    allowOmittedStableBranchBypassActors: usesGitHubActionsToken
  });
  console.log(`Verified live publication gates: ${result.repository} is ${result.visibility}; immutable-release setting ${result.immutableReleaseSetting}; ${result.stablePluginBranch} is protected at ${result.stablePluginCommit} by ${result.stableBranchRuleset} with bypass actors ${result.stableBranchBypassActors}; ${result.environment} has ${result.reviewerCount} reviewer(s), tag policy ${result.tagPolicy}, and active tag ruleset ${result.tagRuleset}.`);
}
