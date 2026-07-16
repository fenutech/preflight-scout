import assert from "node:assert/strict";
import { verifyPublicationGates } from "./verify-publication-gates.mjs";

const valid = {
  repository: { full_name: "fenutech/preflight-scout", private: false, visibility: "public" },
  environment: {
    name: "npm-production",
    protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "reviewer" } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  },
  policies: { total_count: 1, branch_policies: [{ id: 1, name: "v*", type: "tag" }] }
};

await verifyPublicationGates({ token: "test", fetchImpl: fakeFetch(valid) });
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, repository: { ...valid.repository, private: true, visibility: "private" } }) }),
  /live and public/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, environment: { ...valid.environment, protection_rules: [] } }) }),
  /require at least one reviewer/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, policies: { total_count: 1, branch_policies: [{ name: "v*", type: "branch" }] } }) }),
  /deployment tag policy v\*/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", repository: "fork/preflight-scout", fetchImpl: fakeFetch(valid) }),
  /restricted to fenutech\/preflight-scout/
);

console.log("Publication gate checks fail closed on private/fork repositories, missing reviewers, and non-tag policies.");

function fakeFetch(fixtures) {
  return async (url) => {
    const body = url.includes("deployment-branch-policies")
      ? fixtures.policies
      : url.includes("/environments/")
        ? fixtures.environment
        : fixtures.repository;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}
