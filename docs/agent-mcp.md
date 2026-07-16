# Agent And MCP Setup

Preflight Scout has two browser execution paths.

The built-in `preflight-scout run` path keeps Playwright inside Preflight Scout. The
configured LLM proposes actions from live evidence, while the runner permits
navigation, mutation, and assertion only when each decision binds to an exact
human-reviewed mission step, target, and policy label. A passing finish requires
reviewed-step coverage. The LLM does not directly hold Playwright tools in this
mode.

The `preflight-scout agent-run` path hands the same mission to an external coding agent such as Codex or Claude. That agent can use its own browser/MCP tools.

These are different trust boundaries. Preflight Scout's built-in Playwright runner enforces an
exact same-origin HTTP(S) boundary and fails closed on unsafe schemes,
off-origin interactions or redirects, and popups. Cross-origin SSO is manual.
A delegated agent's browser follows that agent's own sandbox and MCP policy; it
is not covered by Preflight Scout's deterministic navigation boundary.

For auth, prefer delegated mode when MCP/Playwright tools are available:

```bash
preflight-scout auth login --agent codex --role qa_user --env staging
```

In delegated auth mode, Preflight Scout supplies the target URL, a contract containing
only the selected role, that role's dedicated
`PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)` credential names, and the
storage-state destination. Provider/infrastructure names are rejected. The
agent must use Playwright MCP, a Playwright skill, or Playwright CLI/library
calls to authenticate and save the storage state.

## Codex

`preflight-scout mcp-setup` only prints setup commands; it does not install or change
MCP configuration. Review its output, then run the printed commands separately.
For Codex:

```bash
preflight-scout mcp-setup --agent codex
```

The output is equivalent to:

```bash
codex mcp add playwright -- npx -y @playwright/mcp@0.0.78 --isolated --output-dir .preflight-scout/mcp
codex mcp list
```

Run a mission through Codex:

```bash
preflight-scout analyze --base origin/main --head HEAD --output-dir .preflight-scout/runs/latest
preflight-scout agent-run --analysis-dir .preflight-scout/runs/latest --agent codex --url https://preview.example.com
preflight-scout agent-run --analysis-dir .preflight-scout/runs/latest --agent codex --env staging --mission-id auto-public-checkout
```

For structured LLM-provider mode:

```bash
export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec
export PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT=high
preflight-scout run --analysis-dir .preflight-scout/runs/latest --env staging
```

For a fully delegated Codex browser pass, configure Playwright MCP and use `agent-run`. For a browser pass owned by Preflight Scout, use `PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec` and `preflight-scout run`; Preflight Scout passes screenshots to `codex exec --image`.

The default `codex-exec` planning subprocess is isolated, bounded, and asked not
to use tools. `agent-run` is the intentional trusted-agent path with repository
and browser capabilities. Custom commands and explicit execution-command or
argument overrides are trusted escape hatches.

## Claude Code

For Claude Code, first print the setup commands:

```bash
preflight-scout mcp-setup --agent claude
```

Then review and run the equivalent output:

```bash
claude mcp add playwright -- npx -y @playwright/mcp@0.0.78 --isolated --output-dir .preflight-scout/mcp
claude mcp list
```

Run a mission through Claude:

```bash
preflight-scout analyze --base origin/main --head HEAD --output-dir .preflight-scout/runs/latest
preflight-scout agent-run --analysis-dir .preflight-scout/runs/latest --agent claude --url https://preview.example.com
```

Claude API mode remains available for structured analysis and browser decisions:

```bash
export PREFLIGHT_SCOUT_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=...
preflight-scout run --analysis-dir .preflight-scout/runs/latest --env staging
```

Preflight Scout currently defaults Anthropic API calls to `claude-sonnet-5`. Set `PREFLIGHT_SCOUT_MODEL` only when you need a deliberate pin such as `claude-opus-4-8`.

## Gemini

Gemini remains best-effort for delegated browser execution. Use it when its
local MCP setup is healthy for your environment.

```bash
preflight-scout mcp-setup --agent gemini
```

Then review and run the equivalent output before starting a delegated mission:

```bash
gemini mcp add playwright npx -y @playwright/mcp@0.0.78 --isolated --output-dir .preflight-scout/mcp
gemini mcp list
preflight-scout analyze --base origin/main --head HEAD --output-dir .preflight-scout/runs/latest
preflight-scout agent-run --analysis-dir .preflight-scout/runs/latest --agent gemini --url https://preview.example.com
```

If Gemini CLI cannot reliably use Playwright MCP for a repo, use Codex or Claude for `agent-run` and keep Gemini API for structured planning only.

## Mission Prompt Bridge

To inspect exactly what an external agent receives:

```bash
preflight-scout mission-prompt --mission .preflight-scout/runs/latest/mission.json --env staging
```

This is useful for custom agents, ChatGPT/Claude skills, or manual debugging.

## Safety

- MCP servers are privileged local code. Only install servers you trust.
- `@latest` resolves at install time. Use a reviewed, pinned MCP package version
  in controlled environments.
- Keep browser sessions and storage-state files out of git.
- Keep `.env.preflight-scout.local` ignored and untracked. It cannot set privileged
  provider/model/base/exec, proxy/TLS, Node/runtime, Git, or agent controls
  unless the trusted parent process sets
  `PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1`; the file may never set that flag, and
  existing parent values always win.
- Use test accounts and staging data.
- Let the LLM decide what to click, assert, retry, fail, or block from live browser evidence. Deterministic code only transports the mission, tools, screenshots, and guardrails.
