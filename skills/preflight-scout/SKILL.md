---
name: preflight-scout
description: "Review a pull request before release: map the diff, build a focused test plan, run approved browser checks, and return evidence. Use for preview, staging, regression, or artifact review."
---

# Preflight Scout

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
preflight-scout update-check --skill-version 0.1.4
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
human-supplied `--login-url`. If neither is known, update the contract before
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

Do not omit `--analysis-dir` after reviewing an analysis. Without it, `agent-run` creates a new analysis from the requested refs instead of reusing the approved mission.

8. Read `report-summary.json` and the human report (`report.md`, `report.html`, or `report.pdf`). Lead with release readiness, failures, blockers, unknowns, affected surfaces, and evidence paths.
9. Run `preflight-scout promote --run-dir .preflight-scout/runs/latest --output-dir tests/preflight-scout` only after the user approves creating a durable test. Review the generated test before presenting it as usable.

## Use current agent models

- Prefer `PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec` or `PREFLIGHT_SCOUT_LLM_PROVIDER=claude-exec` when the corresponding current CLI is installed and authenticated.
- Leave `PREFLIGHT_SCOUT_MODEL` and `PREFLIGHT_SCOUT_EXEC_MODEL` unset to use that CLI's current default model. Pin a model only when the user requests reproducibility or the repository explicitly requires one.
- Use provider API modes only when their keys and model policy are intentionally configured. Never copy a model name from this skill into project configuration.

## Operate safely

- Do not guess product impact from filenames. Run `preflight-scout analyze` and report the generated impact map, its evidence, and its unknowns.
- Review mission steps, explicit targets, and dangerous-action policy labels
  before execution. In Preflight Scout's built-in Playwright runner, the LLM may propose how to
  carry out those steps from live observations, but navigation, mutation,
  assertion, and a passing finish remain deterministically bound to the
  reviewed mission. Do not add unreviewed click paths merely to make a run pass.
- Require each live decision to repeat the exact reviewed step ID and
  `policyLabel`; never infer a capability from prose alone.
- Treat `.preflight-scout/auth/*.json` and other storage-state files as secrets.
- Treat `.preflight-scout/approvals.local.yml` as local operator state. It must remain
  ignored and untracked; never accept committed or legacy approval decisions.
- Keep repository-local `.env.preflight-scout.local` ignored and untracked. It cannot set privileged provider/model/base/exec, proxy/TLS, Node/runtime, Git, or agent controls unless `PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1` is set in the trusted parent environment; the file must never contain that flag, and existing parent values always win.
- Inspect the evidence directory and `<storage-state>.preflight-scout.json` sidecar after auth problems. Never reuse `status: invalid` state.
- Do not pass auth state to public, guest, `none`, or unconfigured roles unless the human explicitly supplies it.
- Treat `agent-run`, delegated auth, MCP servers, and custom commands as trusted execution surfaces. Preflight Scout's deterministic same-origin HTTP(S) navigation boundary applies only to its owned Playwright runner; cross-origin SSO and delegated browser boundaries require manual review.
- Prefer `blocked` over guessed success when credentials, test data, permissions, or safe-action approval are missing.
- Do not print binary evidence such as screenshots, PDFs, or `trace.zip`. Inspect images with a visual tool, validate archives with integrity and file-list commands, and read only textual or JSON evidence as text.
- Do not edit application source, open issues or pull requests, push, publish, deploy, or perform dangerous app actions as part of QA unless the user separately authorizes that action.
- Use progress and heartbeat lines to report long-running phase status. Treat a silent or stalled provider as a runtime problem, not success.

## Report checklist-only results

When full execution is unavailable, derive only what the supplied evidence supports and label every unexecuted item. Return:

- release risk and affected surfaces, with reasons
- exact manual checks and roles/data prerequisites
- browser missions that remain to be run
- executed results, if any, separated from recommendations
- blockers, unknowns, and the smallest next action that would resolve each one
