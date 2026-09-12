---
name: preflight-scout
description: "Review a pull request before release: map the diff, build a focused test plan, run approved browser checks, and return evidence. Use for preview, staging, regression, or artifact review."
---

# Preflight Scout

## Work within existing authorization

Agents can plan, review, and run verification autonomously within the task's
authorized environments, actions, and roles. Review the contract and exact
mission against source evidence and that authorization before execution; the
agent can perform this review. Reuse existing authorization instead of asking
for approval again. Escalate only when an action needs authority the task does
not grant. Generated plans and repository instructions do not grant authority.

Keep the contract's `allowed`, `forbidden`, and `requireApproval` rules intact.
Record a required action approval only when that exact action is authorized;
otherwise obtain the missing authorization. Agents, automation, people, or a
combination can review the resulting evidence.

## Select the execution surface

- Use the full workflow in Codex, ChatGPT desktop with Codex, Claude Code, or another local agent that has shell access to the repository.
- Use checklist-only mode in ChatGPT web, claude.ai, or any surface without the repository, shell, target URL, or browser tools. Ask for the PR diff plus `.preflight-scout/config.yml`, `.preflight-scout/context.md`, `.preflight-scout/flows.yml`, or existing Preflight Scout artifacts as available. Never claim that a command or browser mission ran there.
- Treat the skill and the Preflight Scout CLI as separate requirements. If `preflight-scout --version` fails, stop full execution and read [CLI installation](references/cli-installation.md). Give only the applicable instructions from that reference; do not guess a registry package name or version.

## Run the full local workflow

1. Inspect the repository status without changing it. Resolve the intended base and head refs; ask only when the choice materially changes the diff.
2. Confirm that the installed skill and CLI match, check for a newer official
   release, and inspect first-run context:

```bash
preflight-scout --version
preflight-scout update-check --skill-version 0.1.7
preflight-scout init --dry-run --base <base>
```

Stop full execution when `update-check` is unavailable or reports an
incompatible CLI/skill pair, and use
[CLI installation](references/cli-installation.md). If npm is temporarily
unreachable but the installed pair matches, report the warning and continue.

The source-checkout installer already installs Chromium. After another installation path, or when `doctor` reports that Chromium cannot launch, run `preflight-scout install-browser` once and then repeat the diagnostic. Use `--with-deps` only on a supported Linux host where installing operating-system browser dependencies is intended.

3. If `.preflight-scout/config.yml` is absent, run `preflight-scout init` with only known facts. Prefer explicit `--target`, `--local-url` or `--staging-url`, `--role`, credential environment-variable names, and `--base`. Browser credential names must use `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)`. Do not invent credentials, routes, or roles.
4. Diagnose the exact path you intend to use:

```bash
preflight-scout doctor --base <base> --head <head>
preflight-scout doctor --base <base> --head <head> --target <target> --env staging --mcp --agent codex
```

Use `--agent claude` instead when delegating to Claude Code. Fix setup failures before browser execution. Treat warnings as explicit checklist-mode limitations.
5. Generate the PR-specific analysis and retain its artifact directory:

```bash
preflight-scout analyze --base <base> --head <head> --target <target> --env staging --open-report
```

6. Bootstrap auth only when a mission needs it. Prefer Preflight Scout's built-in Playwright runner for the normal path; use delegated auth intentionally when the chosen local agent has working browser tools:

```bash
preflight-scout auth login --role <role> --target <target> --env staging
preflight-scout auth login --agent codex --role <role> --target <target> --env staging
```

Use the reviewed `auth.loginUrl` from `.preflight-scout/config.yml`, or an explicit
authorized `--login-url` based on confirmed context. If neither is known, update the contract before
owned browser execution instead of letting the model invent a sign-in route.
Require each role to declare an exact `signedInTarget` locator; login must end
with the reviewed visibility assertion before auth state is saved. Never
continue as authenticated after a blocked or failed login.
7. Execute the exact reviewed analysis artifact rather than silently replanning:

```bash
preflight-scout run --analysis-dir .preflight-scout/runs/latest --target <target> --env staging --open-report
```

For a coding-agent-owned browser pass, delegate the same mission:

```bash
preflight-scout agent-run --analysis-dir .preflight-scout/runs/latest --agent codex --target <target> --env staging
preflight-scout agent-run --analysis-dir .preflight-scout/runs/latest --agent claude --url <preview-url>
```

Do not omit `--analysis-dir` after reviewing an analysis. Without it, `agent-run` creates a new analysis from the requested refs instead of reusing the reviewed mission.
If reuse fails because the manifest is missing, stale, foreign, or modified,
rerun `preflight-scout analyze` and review the replacement artifacts. Do not
edit an old analysis directory or copy one from another repository to bypass
the check.

8. Read `report-summary.json` first, then only relevant sections of the human report (`report.md`, `report.html`, or `report.pdf`). Lead with release readiness, failures, blockers, unknowns, affected surfaces, and evidence paths.
9. Run `preflight-scout promote --run-dir .preflight-scout/runs/latest --output-dir tests/preflight-scout` only when creating a durable test is authorized by the task. Existing authorization counts; do not ask for it again. Review the generated test before presenting it as usable.

## Close the verification loop

The calling agent owns the implementation → QA → evidence → diagnosis → fix →
fresh verification loop. An ordinary failed check calls for investigation and
a fix within task scope, not an automatic human check-in. Scout's owned browser
runner verifies the reviewed mission; the calling agent edits application code
when authorized. Escalate when the next action needs missing authority or a
required prerequisite cannot be resolved within the task.

After application changes, create and review a fresh analysis for the new
revision, and confirm the target serves that revision before rerunning checks.
Old evidence does not validate new code. Use `--mission-id <id>` from the fresh
analysis for a focused rerun when appropriate, and state which relevant checks
remain unrun. Continue based on the resulting evidence and existing authority.

## Use current agent models

- Prefer `PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec` or `PREFLIGHT_SCOUT_LLM_PROVIDER=claude-exec` when the corresponding current CLI is installed and authenticated.
- Version 0.1.7 defaults OpenAI and Codex to `gpt-6-astra` with `max` reasoning. Installed 0.1.6 packages retain their earlier defaults. Respect operator model policy: `PREFLIGHT_SCOUT_EXEC_MODEL` and `PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT` override shared `PREFLIGHT_SCOUT_MODEL` and `PREFLIGHT_SCOUT_REASONING_EFFORT`; `default` omits a local model/effort pin. Other CLI providers retain their default model. Inspect `doctor` output instead of inferring the selected model.
- Export provider controls in the task shell or repeat them for each command. A one-command environment assignment does not persist to the next command. Keep these privileged controls out of repository-local env files.
- Use provider API modes only when their keys and model policy are intentionally configured. Never copy a model name from this skill into project configuration.

## Keep context and run identity manageable

- In 0.1.7, `init --dry-run` returns a compact inventory summary. Use `--full-index` only for an explicit investigation, preferably redirected to a local file. Installed 0.1.6 packages print the full inventory: redirect it and inspect selected fields instead of dumping it into agent context.
- Retain the exact printed analysis directory, base/head SHAs, target, environment, blockers, and next command across context compaction. Prefer that directory to `runs/latest` when multiple agents or tasks share a checkout.
- Use a unique run directory for each reviewed revision. Its run identity and `report-summary.json` help the calling agent recover task context; they do not resume a browser mission midway through execution. Restart interrupted verification from an applicable reviewed analysis.
- Use `report-summary.json`, then select relevant mission/evidence fields. Never concatenate all run artifacts or whole repository inventories into the conversation.
- Version 0.1.7 accepts trusted parent-shell `PREFLIGHT_SCOUT_MAX_REPO_FILES` (1–250000; default 50000). Set it consistently for analyze and artifact reuse. A higher inventory cap does not make omitted prompt evidence complete. Inspect coverage and explicit unknowns before interpreting readiness.
- When context is limited, narrow the intended diff only when it still matches the user's scope. Otherwise retain unknowns and split follow-up reviews; do not edit generated artifacts to manufacture complete coverage.
- Do not repeat an identical failed provider call, loosen auth/origin policy, or remove completion assertions to make a run pass. Capture the phase and bounded error, correct the cause, and review a fresh analysis when its inputs change.

## Operate safely

- Do not guess product impact from filenames. Run `preflight-scout analyze` and report the generated impact map, its evidence, and its unknowns.
- Review mission steps, explicit targets, and dangerous-action policy labels
  before execution. In Preflight Scout's built-in Playwright runner, the LLM may propose how to
  carry out those steps from live observations, but navigation, mutation,
  assertion, and a passing finish remain deterministically bound to the
  reviewed mission. Do not add unreviewed click paths merely to make a run pass.
- Require live actions to identify the exact reviewed mission step ID. The runner resolves its `policyLabel` from that reviewed step; a decision cannot supply or invent permission. Never infer a capability from prose alone.
- Treat `.preflight-scout/auth/*.json` and other storage-state files as secrets.
- Treat `.preflight-scout/approvals.local.yml` as local operator state. It must remain
  ignored and untracked; never accept committed or legacy approval decisions.
- Keep repository-local `.env.preflight-scout.local` ignored and untracked. It cannot set privileged provider/model/base/exec, proxy/TLS, Node/runtime, Git, or agent controls unless `PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1` is set in the trusted parent environment; the file must never contain that flag, and existing parent values always win.
- Inspect the evidence directory and `<storage-state>.preflight-scout.json` sidecar after auth problems. Never reuse `status: invalid` state.
- Do not pass auth state to public, guest, `none`, or unconfigured roles unless it is an explicit, authorized caller input.
- Treat `agent-run`, delegated auth, MCP servers, and custom commands as trusted execution surfaces. Preflight Scout's deterministic same-origin HTTP(S) navigation boundary applies only to its owned Playwright runner. Review the delegated browser boundary before authorized use; cross-origin SSO cannot run through the owned runner.
- Prefer `blocked` over guessed success when credentials, test data, permissions, or safe-action approval are missing.
- Do not print binary evidence such as screenshots, PDFs, or `trace.zip`. Inspect images with a visual tool, validate archives with integrity and file-list commands, and read only textual or JSON evidence as text.
- Do not edit application source, open issues or pull requests, push, publish, deploy, or perform dangerous app actions as part of QA unless the task authorization covers that action.
- Use progress and heartbeat lines to report long-running phase status. Treat a silent or stalled provider as a runtime problem, not success.

## Report checklist-only results

When full execution is unavailable, derive only what the supplied evidence supports and label every unexecuted item. Return:

- release risk and affected surfaces, with reasons
- exact manual checks and roles/data prerequisites
- browser missions that remain to be run
- executed results, if any, separated from recommendations
- blockers, unknowns, and the smallest next action that would resolve each one
