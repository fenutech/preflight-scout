# Doctor

`preflight-scout doctor` checks whether a repository is ready for PR-aware QA analysis and browser execution.

It is intentionally generic. It does not infer product behavior. It verifies setup facts:

- git repository and optional base/head refs
- default or explicitly selected local env-file policy; repository-local files
  must be ignored and untracked
- `.preflight-scout/config.yml`
- exact LLM provider/key pairing (unknown, disabled, or mismatched providers fail)
- presence of credential environment variables named in the QA contract
- target URL reachability from the Preflight Scout process
- Playwright/Chromium availability
- optional bounded Codex, Claude, Gemini, or custom-agent runtime probe
- optional Codex, Claude, and Gemini MCP server lists

## Basic

```bash
preflight-scout doctor --base origin/main --head HEAD
```

## With Browser Target

```bash
preflight-scout doctor \
  --base origin/main \
  --head HEAD \
  --url https://preview.example.com
```

## With MCP Checks

```bash
preflight-scout doctor --mcp
```

## With a delegated agent runtime probe

Use `--agent` to check that an agent CLI can accept and finish one bounded,
noninteractive prompt:

```bash
preflight-scout doctor --base origin/main --head HEAD --agent codex
preflight-scout doctor --base origin/main --head HEAD --agent claude
```

The probe requests one exact readiness marker and tells the agent not to use
browser, network, shell, MCP, or filesystem tools. For built-in Codex, Claude,
and Gemini commands it also applies the client's available no-tool, sandbox,
and project-customization restrictions. It runs from a fresh temporary directory
outside the target repository, removes that directory afterward, and does not
forward raw provider API keys; use an already authenticated CLI session. Custom
commands remain trusted executables and must enforce their own isolation.

The probe has a hard 30-second cap; a smaller `--agent-timeout-ms` value is
allowed, while a larger value is still capped at 30 seconds. Timeout and startup
failures retain bounded, redacted diagnostics so a silent agent process is
reported as a runtime failure rather than browser evidence.

A passing agent probe confirms only that the selected agent's noninteractive
runtime can execute. It **does not** run delegated browser QA, reach the target
through that agent, inspect its browser tools, authenticate, or execute a
mission. Use `preflight-scout agent-run --analysis-dir <reviewed-analysis>` for the
actual delegated browser pass.

These doctor checks remain separate:

- the local-env check verifies Git ignore/tracking state and the privileged
  environment-control policy; it does not validate credentials with a provider
  or app.
- the contract/credential checks prove only that configuration parses and named
  values are present. Browser execution separately enforces the dedicated
  `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)` policy and exact role
  selection.
- `--url`, `--target`, and `--env` perform one target fetch from Preflight Scout. They
  accept only bounded absolute HTTP(S) URLs without embedded credentials, do
  not follow redirects, reject off-origin redirects, and cancel the response
  body after reading status/headers. They do not prove reachability from a
  delegated agent or that the app flow works.
- the normal Playwright check launches Preflight Scout's locally installed Chromium.
- `--mcp` inspects configured MCP server lists; it does not execute a browser
  mission or prove that an agent can call the listed server.
- `--agent` runs only the bounded agent-runtime probe described above.

Combine them when all are relevant, but interpret each result independently:

```bash
preflight-scout doctor \
  --base origin/main \
  --head HEAD \
  --url https://preview.example.com \
  --agent codex \
  --mcp
```

## JSON

```bash
preflight-scout doctor --json
```

Warnings mean Preflight Scout can still be useful, usually in checklist mode. Failures
mean an analysis or browser run is likely blocked. A clean doctor report is
setup evidence, not a QA pass, security scan, authentication test, or proof that
delegated browser controls are available.
