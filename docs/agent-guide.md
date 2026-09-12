# Preflight Scout: agent guide

Preflight Scout turns "done" into verifiable evidence under explicit execution
boundaries. It reads an exact Git diff and bounded repository context, proposes
a QA plan, runs reviewed browser missions within declared permissions, and
writes evidence for agents, CI, and human reviewers. It does not establish
that an entire repository is correct.

Use standing authorization for the intended environments, actions, and roles.
An authorized agent can review the generated mission and run it without asking
a person to approve each run or action. Escalate only when the task needs
authority that has not been granted. The LLM cannot grant itself permissions
or bypass the contract's approval-required and forbidden actions. A project
may consume evidence through automated gates, human review, or both.

The analysis manifest ties reviewed artifacts to source revisions, context,
and contract. It does not attest which build a target URL serves; verify that
deployment separately. The built-in browser runner enforces reviewed actions
and the target origin. Delegated agent execution is a separate trusted surface.

Discovery URL: [preflightscout.com/llms.txt](https://preflightscout.com/llms.txt).
This guide is available as plain Markdown at
[preflightscout.com/agent-guide.md](https://preflightscout.com/agent-guide.md).
Read the installed Agent Skill for the full operating workflow. Website and
`main` documentation may be newer than your installed CLI; use the matching
release tag for version-specific details.

## 1. Choose the available execution path

For an installation request, follow the
[agent setup instructions](https://preflightscout.com/agent-setup/prompt.md),
then return here for an authorized QA task.

- Repository and shell available: use the CLI plus the installed Agent Skill.
  Start with `preflight-scout --version` and `preflight-scout --help`.
- Missing CLI: follow the [installation page](https://preflightscout.com/install/).
  Confirm that the exact official GitHub release and npm version both exist.
  Install the same version of the CLI and skill, then install Chromium with
  `preflight-scout install-browser`. Restart the agent client and open a fresh
  task after adding or updating its plugin.
- No repository, shell, target, or browser access: review the supplied diff and
  artifacts in checklist-only mode. State which checks remain unexecuted.

The CLI and skill are separate requirements. Before a full pass, run
`preflight-scout update-check --skill-version <installed-skill-version>` with
the exact compatibility value from the installed skill. A missing command or
an incompatible pair needs an update; a registry outage with a matching pair
is a warning. An unreleased source CLI should use the direct skill from the
same checkout, not `plugin-stable`.

## 2. Establish the exact inputs

Inspect Git status and resolve the intended base and head commits. Substitute
the reviewed refs and a unique run name in the commands below; angle-bracket
values are placeholders. Do not assume `origin/main` is the correct base.

```bash
preflight-scout init --dry-run --base <base>
preflight-scout doctor --base <base> --head <head>
```

Published 0.1.6 prints the full inventory for `init --dry-run`. Redirect that
output to a private local file and inspect selected fields to keep it out of
the conversation. Source builds after 0.1.6 print a compact summary; use
`--dry-run --full-index` only when the full indexed inventory is needed.

If the contract is absent, `preflight-scout init --no-llm --base <base>` creates
a blank contract without a model call. Fill only known targets, flows, roles,
and URLs. Read `.preflight-scout/config.yml`, `context.md`, and `flows.yml` as
needed. Do not invent product behavior or credential values.

Select a configured provider deliberately. For an authenticated local Codex
CLI, set `PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec`; for Claude Code, use
`claude-exec`. The [provider guide](https://github.com/fenutech/preflight-scout/blob/main/docs/providers-and-security.md)
documents defaults and model overrides. Keep provider/model/execution controls
in the trusted parent environment; do not let a repository-local env file
silently change the execution policy.
Export them in the task shell or repeat them for each command: a one-command
environment assignment does not configure the next command.

Add `--target <target> --env staging` to diagnostics and execution when using
a named staging target. Add `--agent codex` or `--agent claude` to `doctor`
for a bounded runtime probe, and `--mcp` when you intend delegated browser work.
Resolve diagnostic failures before execution.

## 3. Analyze once, then review the artifacts

```bash
preflight-scout analyze --base <base> --head <head> --output-dir .preflight-scout/runs/<run-id>
```

Keep the short CLI output. Read the relevant parts of `report-summary.json`,
`impact-map.json`, and `mission.json` in that directory. Review the proposed
steps, exact targets, roles, assertions, and dangerous-action policy labels.
Check unknowns and omitted context before deciding what is covered.

For large repositories and long conversations:

- Keep each run directory distinct. Do not let concurrent agents share
  `runs/latest` or overwrite each other's artifacts.
- Read summaries first, then selected findings, mission candidates, and
  relevant source ranges. Avoid dumping the full inventory, diff, all JSON
  artifacts, or the full Markdown report into the conversation.
- Keep missing or truncated input visible as a limitation. Inspect the
  relevant source directly when needed; do not infer complete review coverage
  from a bounded context window.
- Before a handoff or context compaction, record the repository, exact base
  and head commits, run directory, chosen mission IDs, target, completed
  checks, and unresolved blockers. Keep credentials and auth-state contents
  out of that handoff.
- A tool timeout or interrupted caller is not proof that its child process
  exited. Check the process and run artifacts before launching a duplicate.

## 4. Execute the reviewed analysis

For Preflight Scout's owned Playwright browser, use the same refs and run
directory and supply the approved target:

```bash
preflight-scout run --base <base> --head <head> --analysis-dir .preflight-scout/runs/<run-id> --output-dir .preflight-scout/runs/<run-id> --url <approved-url>
```

Use `--mission-id <id>` to run one selected candidate. Without `--analysis-dir`,
execution can create a new plan. A stale, modified, foreign, or incompatible
analysis must be regenerated and reviewed; do not edit its manifest or copy
artifacts from another repository to make reuse pass.

Use `agent-run` with `--agent codex` or `--agent claude` only when intentionally
delegating the browser to that agent. Preserve the same refs, `--analysis-dir`,
`--output-dir`, and target. The delegated browser follows that agent's sandbox
and tools; it is outside Preflight Scout's deterministic same-origin boundary.
See [agent and MCP setup](https://github.com/fenutech/preflight-scout/blob/main/docs/agent-mcp.md).

Authenticate only when the mission needs it, using a reviewed login URL and
signed-in locator. Browser credential names use
`PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)`.
Use disposable accounts and keep storage state, local approvals, env files,
and raw evidence private. The user's existing authorization and scope apply;
this guide does not authorize deployment, publication, or app-side mutations.

## 5. Report what the evidence establishes

Read the updated summary and report, then inspect the evidence for material
results. Lead with readiness, failures, blockers, unknowns, affected surfaces,
and local evidence paths. Distinguish passing checks from unexecuted plans.
An empty candidate list means no browser checks ran; it is not a browser pass.
A process exiting successfully does not by itself prove release readiness.

Open screenshots with an image tool and traces with appropriate archive or
browser tooling. Do not print images, PDFs, or `trace.zip` as text. Do not
upload raw reports or session logs from a private repository to public issues.
Publish only a sanitized reproduction when the user authorizes it.

## Recovery references

- Setup, missing browser, or provider failures: [doctor guide](https://github.com/fenutech/preflight-scout/blob/main/docs/doctor.md).
- Credentials, local env files, approvals, or model inputs: [security boundaries](https://preflightscout.com/security/).
- Evidence locations and browser limitations: [evidence guide](https://github.com/fenutech/preflight-scout/blob/main/docs/evidence.md).
- Full workflow and installation variants: [Agent Skill guide](https://github.com/fenutech/preflight-scout/blob/main/docs/skills.md).
- Reproducible local exercise: [generic demo](https://github.com/fenutech/preflight-scout/blob/main/docs/generic-demo.md).
