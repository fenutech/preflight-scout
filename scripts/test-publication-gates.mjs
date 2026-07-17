import assert from "node:assert/strict";
import { verifyPublicationGates } from "./verify-publication-gates.mjs";

const valid = {
  repository: { full_name: "fenutech/preflight-scout", private: false, visibility: "public" },
  immutableReleases: { enabled: true },
  stablePluginBranch: {
    name: "plugin-stable",
    protected: true,
    commit: { sha: "635367af48d1c75b95a08b3e97001258729c0d46" }
  },
  environment: {
    name: "npm-production",
    protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "reviewer" } }] }],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
  },
  policies: { total_count: 1, branch_policies: [{ id: 1, name: "v*", type: "tag" }] },
  rulesets: [
    { id: 7, name: "Protect release tags", target: "tag", enforcement: "active" },
    { id: 8, name: "Protect plugin-stable", target: "branch", enforcement: "active" }
  ],
  rulesetDetails: {
    7: {
      id: 7,
      name: "Protect release tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }]
    },
    8: {
      id: 8,
      name: "Protect plugin-stable",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/plugin-stable"], exclude: [] } },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: "Required", integration_id: 15368 }]
          }
        }
      ]
    }
  }
};

const result = await verifyPublicationGates({ token: "test", fetchImpl: fakeFetch(valid) });
assert.equal(result.tagRuleset, "Protect release tags");
assert.equal(result.immutableReleaseSetting, "verified");
assert.equal(result.stablePluginBranch, "plugin-stable");
assert.equal(result.stableBranchRuleset, "Protect plugin-stable");
assert.equal(result.stableBranchBypassActors, "verified");
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, repository: { ...valid.repository, private: true, visibility: "private" } }) }),
  /live and public/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, environment: { ...valid.environment, protection_rules: [] } }) }),
  /require at least one reviewer/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, immutableReleases: { enabled: false } }) }),
  /immutable releases enabled/
);
const workflowTokenCalls = [];
const { bypass_actors: _omittedByGitHub, ...workflowVisibleStableRuleset } = valid.rulesetDetails[8];
const workflowTokenResult = await verifyPublicationGates({
  token: "test",
  checkImmutableReleaseSetting: false,
  allowOmittedStableBranchBypassActors: true,
  fetchImpl: fakeFetch(withRuleset(valid, 8, workflowVisibleStableRuleset), workflowTokenCalls)
});
assert.equal(workflowTokenResult.immutableReleaseSetting, "admin-only-check-deferred");
assert.equal(workflowTokenResult.stableBranchBypassActors, "admin-only-check-deferred");
assert.equal(workflowTokenCalls.some((url) => url.endsWith("/immutable-releases")), false);
await assert.rejects(
  verifyPublicationGates({ token: "test", checkImmutableReleaseSetting: "false", fetchImpl: fakeFetch(valid) }),
  /must be a boolean/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", allowOmittedStableBranchBypassActors: "true", fetchImpl: fakeFetch(valid) }),
  /must be a boolean/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch(withRuleset(valid, 8, workflowVisibleStableRuleset))
  }),
  /must not allow bypass actors/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    allowOmittedStableBranchBypassActors: true,
    fetchImpl: fakeFetch(withRuleset(valid, 8, {
      ...valid.rulesetDetails[8],
      bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }]
    }))
  }),
  /must not allow bypass actors/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch({ ...valid, stablePluginBranch: { ...valid.stablePluginBranch, protected: false } })
  }),
  /plugin-stable must exist as a protected branch/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, policies: { total_count: 1, branch_policies: [{ name: "v*", type: "branch" }] } }) }),
  /deployment tag policy v\*/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", repository: "fork/preflight-scout", fetchImpl: fakeFetch(valid) }),
  /restricted to fenutech\/preflight-scout/
);
await assert.rejects(
  verifyPublicationGates({ token: "test", fetchImpl: fakeFetch({ ...valid, rulesets: [] }) }),
  /active tag ruleset/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch({
      ...valid,
      rulesetDetails: {
        ...valid.rulesetDetails,
        7: { ...valid.rulesetDetails[7], rules: [{ type: "creation" }, { type: "update" }] }
      }
    })
  }),
  /protect tag creation, update, and deletion/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch({
      ...valid,
      rulesetDetails: {
        ...valid.rulesetDetails,
        7: {
          ...valid.rulesetDetails[7],
          conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v0.1.0"] } }
        }
      }
    })
  }),
  /applying exactly to refs\/tags\/v\*/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch({
      ...valid,
      rulesetDetails: {
        ...valid.rulesetDetails,
        7: {
          ...valid.rulesetDetails[7],
          conditions: { ref_name: { include: ["refs/tags/v*", "refs/tags/release-*"], exclude: [] } }
        }
      }
    })
  }),
  /applying exactly to refs\/tags\/v\*/
);

await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch({
      ...valid,
      rulesets: valid.rulesets.filter((ruleset) => ruleset.target !== "branch")
    })
  }),
  /active branch ruleset/
);
for (const conditions of [
  { ref_name: { include: ["refs/heads/plugin-stable"], exclude: ["refs/heads/emergency"] } },
  { ref_name: { include: ["refs/heads/plugin-stable", "refs/heads/main"], exclude: [] } },
  { ref_name: { include: ["plugin-stable"], exclude: [] } }
]) {
  await assert.rejects(
    verifyPublicationGates({
      token: "test",
      fetchImpl: fakeFetch(withRuleset(valid, 8, { ...valid.rulesetDetails[8], conditions }))
    }),
    /applying exactly to refs\/heads\/plugin-stable with no exclusions/
  );
}
for (const requiredType of ["deletion", "non_fast_forward", "required_linear_history", "required_status_checks"]) {
  await assert.rejects(
    verifyPublicationGates({
      token: "test",
      fetchImpl: fakeFetch(withRuleset(valid, 8, {
        ...valid.rulesetDetails[8],
        rules: valid.rulesetDetails[8].rules.filter((rule) => rule.type !== requiredType)
      }))
    }),
    /contain exactly these protection rules/
  );
}
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch(withRuleset(valid, 8, {
      ...valid.rulesetDetails[8],
      rules: [...valid.rulesetDetails[8].rules, { type: "deletion" }]
    }))
  }),
  /contain exactly these protection rules/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch(withRuleset(valid, 8, { ...valid.rulesetDetails[8], rules: { type: "deletion" } }))
  }),
  /well-formed rules array/
);
for (const required_status_checks of [
  [{ context: "required", integration_id: 15368 }],
  [{ context: "Required", integration_id: 1 }],
  [
    { context: "Required", integration_id: 15368 },
    { context: "Other", integration_id: 15368 }
  ]
]) {
  const rules = valid.rulesetDetails[8].rules.map((rule) =>
    rule.type === "required_status_checks"
      ? { ...rule, parameters: { ...rule.parameters, required_status_checks } }
      : rule
  );
  await assert.rejects(
    verifyPublicationGates({
      token: "test",
      fetchImpl: fakeFetch(withRuleset(valid, 8, { ...valid.rulesetDetails[8], rules }))
    }),
    /strictly require exactly the Required status check from GitHub Actions integration 15368/
  );
}
for (const parameters of [
  {
    strict_required_status_checks_policy: false,
    do_not_enforce_on_create: false,
    required_status_checks: [{ context: "Required", integration_id: 15368 }]
  },
  {
    strict_required_status_checks_policy: true,
    do_not_enforce_on_create: true,
    required_status_checks: [{ context: "Required", integration_id: 15368 }]
  }
]) {
  const rules = valid.rulesetDetails[8].rules.map((rule) =>
    rule.type === "required_status_checks" ? { ...rule, parameters } : rule
  );
  await assert.rejects(
    verifyPublicationGates({
      token: "test",
      fetchImpl: fakeFetch(withRuleset(valid, 8, { ...valid.rulesetDetails[8], rules }))
    }),
    /strictly require exactly the Required status check/
  );
}
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch(withRuleset(valid, 8, {
      ...valid.rulesetDetails[8],
      bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }]
    }))
  }),
  /must not allow bypass actors/
);
await assert.rejects(
  verifyPublicationGates({
    token: "test",
    fetchImpl: fakeFetch(withRuleset(valid, 8, { ...valid.rulesetDetails[8], enforcement: "evaluate" }))
  }),
  /details that do not match its active branch summary/
);

console.log("Publication gate checks fail closed on private/fork repositories, an unprotected stable plugin branch, weak environment policies, and missing or incomplete tag and plugin-stable rulesets.");

function withRuleset(fixtures, id, ruleset) {
  return {
    ...fixtures,
    rulesetDetails: { ...fixtures.rulesetDetails, [id]: ruleset }
  };
}

function fakeFetch(fixtures, calls = []) {
  return async (url) => {
    calls.push(url);
    let body;
    if (url.endsWith("/immutable-releases")) body = fixtures.immutableReleases;
    else if (url.endsWith("/branches/plugin-stable")) body = fixtures.stablePluginBranch;
    else if (url.includes("deployment-branch-policies")) body = fixtures.policies;
    else if (url.endsWith("/rulesets?per_page=100")) body = fixtures.rulesets;
    else if (/\/rulesets\/\d+$/.test(url)) {
      const id = Number.parseInt(url.match(/\/rulesets\/(\d+)$/)[1], 10);
      body = fixtures.rulesetDetails[id];
    } else if (url.includes("/environments/")) body = fixtures.environment;
    else body = fixtures.repository;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}
