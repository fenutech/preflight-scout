#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const PUBLIC_REPOSITORY = "fenutech/preflight-scout";
export const PUBLICATION_ENVIRONMENT = "npm-production";
const API_ROOT = "https://api.github.com";

export async function verifyPublicationGates({
  fetchImpl = fetch,
  token,
  repository = PUBLIC_REPOSITORY
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

  return {
    repository: repo.full_name,
    visibility: repo.visibility,
    environment: environment.name,
    reviewerCount: reviewers.reviewers.length,
    tagPolicy: tagPolicy.name
  };
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
  const result = await verifyPublicationGates({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY
  });
  console.log(`Verified live publication gates: ${result.repository} is ${result.visibility}; ${result.environment} has ${result.reviewerCount} reviewer(s) and tag policy ${result.tagPolicy}.`);
}
