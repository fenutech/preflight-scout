# Maintainer guide

## Repository policy

- `main` is the only default branch.
- Changes should arrive through focused branches and squash-merged pull
  requests.
- `Required` is the stable required-check candidate produced by the `CI`
  workflow. Matrix jobs, label automation, and opt-in self-checks should not
  be configured as required individually.
- Delete merged branches automatically and keep merge commits and rebase merges
  disabled.
- Keep Actions permissions read-only by default. Grant write scopes only in the
  workflow that needs them.
- Pin every external Action to a full commit SHA; Dependabot maintains those
  references.

When the repository plan supports branch rules, protect the default branch
with these rules:

1. block branch deletion and non-fast-forward pushes;
2. require a pull request with squash as the only merge method;
3. require review-thread resolution, with zero mandatory approvals while the
   project has one maintainer;
4. require a current branch and the `Required` status check;
5. require linear history; and
6. allow the repository owner to bypass only through a pull request, so an
   emergency override remains visible.

Do not enable a ruleset merely for appearance. Confirm the current account plan
can enforce it, and confirm the required check has completed successfully on
`main`, before turning enforcement on.

## Automation map

- `CI`: Node 22/24 build, typecheck, unit and browser tests, package health,
  dependency audit, tarball installation, and Agent Skill packaging.
- `Browser Tests (manual)`: on-demand reproduction of the browser suite.
- `Pull Request Labeler`: path-based area labels using trusted default-branch
  configuration.
- `Preflight Scout Self-check`: opt-in `pull_request_target` analysis. It reads the PR
  head but executes only trusted default-branch Action code, and accepts only
  same-repository PRs from trusted associations. It runs only when the
  repository variable and provider secret are both configured.
- `Release Candidate`: a manual, non-publishing validation workflow that checks
  versions, runs the full suite, produces checksummed candidate artifacts, and
  exercises npm's dry-run path.

Actual npm publication, tags, GitHub releases, and external marketplace
submissions require a separate explicit maintainer decision. The
release-candidate workflow cannot publish. Publish only from a reviewed public
tag through the protected workflow described in the
[release checklist](release-checklist.md).

## Labels

Use `bug`, `enhancement`, `documentation`, `security`, `dependencies`,
`breaking`, `skip-changelog`, and `needs-triage` for release and triage state.
Area labels are applied automatically for core, CLI, browser, GitHub Action,
MCP, agent execution, and Agent Skill paths.

Security reports never belong in a public issue. Follow `SECURITY.md` and keep
credentials, storage state, customer data, non-public source code, and exploit
details out of Actions artifacts and issue comments.
