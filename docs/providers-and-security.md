# Providers and security

Provider contracts and model choices were verified against official documentation on 2026-07-13. First-party models can be overridden with `PREFLIGHT_SCOUT_MODEL`; their defaults favor a current, production-suitable balance of quality, latency, and cost. OpenAI-compatible gateways require `PREFLIGHT_SCOUT_MODEL` because their model identifiers are provider-specific.

## Current defaults

| Provider | Default | Optional override and use | API contract |
| --- | --- | --- | --- |
| OpenAI | `gpt-5.6` | `gpt-5.6-terra` or `gpt-5.6-luna` for lower-cost workloads | Responses API with strict `text.format` JSON Schema |
| Anthropic | `claude-sonnet-5` | `claude-opus-4-8` for quality-first overrides | Messages API with `output_config.format.type=json_schema` |
| Google | `gemini-3.5-flash` | `gemini-3.1-pro-preview` when preview risk is acceptable | `generateContent` with `responseJsonSchema` |
| OpenAI-compatible gateway | none; `PREFLIGHT_SCOUT_MODEL` is required | gateway-specific | Chat Completions JSON mode |

The OpenAI default uses the flagship GPT-5.6 alias because impact mapping and browser decisions are quality-sensitive; Terra and Luna are explicit cost optimizations. Anthropic describes Claude Sonnet 5 as “The best combination of speed and intelligence.” Preflight Scout's previous Gemini default, `gemini-2.5-pro`, is scheduled for shutdown on 2026-10-16; Preflight Scout now chooses stable `gemini-3.5-flash`, while Google's like-for-like Pro replacement remains the preview `gemini-3.1-pro-preview`.

Local `codex-exec`, `claude-exec`, and `gemini-exec` runs do not pin a model unless `PREFLIGHT_SCOUT_EXEC_MODEL` is set. Omitting the override lets the installed agent use its current configured default.

## Structured-output contracts

Preflight Scout uses provider-native structured output where available, then validates every response with Zod before using it.

| Provider path | Request shape | Local validation |
| --- | --- | --- |
| OpenAI API | `/v1/responses` with `text.format.type=json_schema`, `strict: true`, and `store: false` | Zod parse, with one repair attempt |
| Anthropic API | `/v1/messages` with `output_config.format.type=json_schema` | Zod parse, with one repair attempt |
| Gemini API | `generateContent` with `responseMimeType=application/json` and `responseJsonSchema` | Zod parse, with one repair attempt |
| OpenAI-compatible gateway | `/chat/completions` JSON mode | Zod parse, with one repair attempt |
| Local agent CLI | `codex exec -`, `claude -p ...`, or `gemini -p ...`, with the prompt on stdin | Zod parse, with one repair attempt |

Provider API calls have a 120-second default timeout, accept only
`PREFLIGHT_SCOUT_LLM_TIMEOUT_MS` values from 1,000 through 600,000 milliseconds, and
stream at most 16 MiB before JSON parsing. HTTP/error diagnostics are read with
a much smaller cap, redacted, and truncated. Provider retries are limited to
four; set `PREFLIGHT_SCOUT_LLM_PROVIDER_ATTEMPTS` to an integer from 1 through 4.
Keep both controls in the trusted parent environment.

OpenAI strict structured output requires all object fields to be required. Preflight Scout converts optional object fields into nullable required fields for the request, then removes null object fields before Zod validation. First-party OpenAI calls use the Responses API; `openai-compatible` deliberately retains Chat Completions JSON mode because third-party gateways vary in Responses and strict-schema support, and it refuses to start until a gateway-specific `PREFLIGHT_SCOUT_MODEL` is set.

Anthropic Structured Outputs are generally available on the Claude API for
Sonnet 5. Preflight Scout uses the JSON-output form,
`output_config.format.type=json_schema`. For the Sonnet 5 default, Preflight Scout
disables adaptive thinking so the output budget is reserved for deterministic
JSON, uses an 8,192-token output ceiling, and fails explicitly on refusal or
truncation stop reasons. Gemini sends its key in the `x-goog-api-key` header and
uses `responseJsonSchema`, not query-string credentials or the older
`responseSchema` field.

## Visual browser decisions

The browser runner sends each live observation through the same LLM abstraction. Text observations are always included.

| Provider path | Screenshot support |
| --- | --- |
| OpenAI Responses API | `input_image` data URL |
| OpenAI-compatible Chat Completions | `image_url` data URL content |
| Anthropic Messages API | Base64 image content |
| Gemini API | `inlineData` image parts |
| `codex-exec` | `codex exec --image` |
| `claude-exec` / `gemini-exec` | Text/path-only structured mode; use `agent-run` with browser tools for full visual control |

## Agent CLI execution

Preflight Scout can hand the same mission to an installed coding agent.

| Agent | Default command | Prompt transport |
| --- | --- | --- |
| Codex | `codex exec -` | stdin |
| Claude Code | `claude -p "Execute the Preflight Scout mission provided on stdin."` | stdin |
| Gemini CLI | `gemini -p "Execute the Preflight Scout mission provided on stdin."` | stdin |

Mission prompts use stdin so the full mission is not exposed in process arguments. Custom commands default to argv for compatibility and can opt into stdin with `promptTransport: "stdin"`.

The same CLIs can plan missions with `PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec`, `claude-exec`, or `gemini-exec`. This is convenient when the developer is already authenticated locally. Provider APIs remain easier to budget and constrain in CI.

With the default built-in command, structured planning runs from a fresh
temporary directory outside the target repository. Preflight Scout requests no tool
use, applies each client's available project/tool restrictions, resolves a
trusted executable outside the target checkout, passes only common runtime
settings plus a narrow local-agent auth/configuration allowlist, bounds output, and
removes the directory afterward. Setting `PREFLIGHT_SCOUT_EXEC_COMMAND` or
`PREFLIGHT_SCOUT_EXEC_ARGS` deliberately switches to a trusted-command escape hatch
that retains the caller-supplied command's historical working-directory and
environment behavior.

```bash
PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec \
PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT=high \
preflight-scout run
```

Set `PREFLIGHT_SCOUT_EXEC_MODEL` only when a reproducible pin is more important than following the agent's current default. When overriding `PREFLIGHT_SCOUT_EXEC_ARGS`, include `{images}` where Codex screenshot arguments should be inserted.

For full browser-agent execution, use `agent-run` with the agent's browser/MCP configuration. Codex and Claude Code are the primary supported delegated paths; Gemini delegated browser control remains best-effort.

`agent-run` and delegated auth are intentionally different from isolated
planning. Built-in agent kinds receive a kind-specific minimal environment and
only the dedicated browser credentials for the mission's selected role; custom
agents receive a minimal environment by default. Credential values are redacted
from returned output, output is bounded, and timed-out process groups are
terminated. The delegated agent, its custom command, and its browser/MCP setup
remain trusted execution surfaces outside Preflight Scout's deterministic Playwright
navigation boundary.

`preflight-scout doctor --agent <kind>` is intentionally narrower than `agent-run`.
It starts the built-in CLI from a fresh directory outside the target repository,
uses the client's available no-tool/project-isolation flags, strips provider API
keys and unrelated environment variables, and accepts only a fixed readiness
marker. It therefore requires an already authenticated CLI session and does not
prove browser, MCP, target-URL, or credential access. A custom command is trusted
code and must provide its own equivalent isolation.

## Secret-handling rules

- Keep provider keys in environment variables or a secret manager, never in repo files.
- A repository-local `.env.preflight-scout.local` must be ignored and untracked.
  Preflight Scout refuses privileged provider-selection, model, base-ref/base-URL,
  execution, proxy/TLS, Node/runtime, Git, and agent-configuration controls from
  that file unless the trusted parent environment sets
  `PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1`. The flag is forbidden inside the file,
  and parent-environment values always take precedence.
- `.gitignore` is part of the repository-disclosure boundary: Preflight Scout indexes
  tracked files plus untracked, non-ignored files and separately excludes known
  credential, auth-state, run-output, archive, cache, and build paths. The
  LLM-facing repository index replaces the absolute checkout root and redacts
  detected secrets across manifests, routes, components, and integration hints.
  For a changed sensitive/generated path, Preflight Scout keeps only path/status/line
  metadata and replaces the patch and content before model analysis.
- Never expose provider keys in browser or mobile client code.
- Use restricted API keys and CI secret stores; rotate credentials after suspected exposure.
- Treat MCP servers, coding agents, and target-repository instructions as privileged input. A malicious repository or webpage can attempt prompt injection.
- Browser credentials must use
  `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)` and be named by the exact
  selected role in `.preflight-scout/config.yml`. The runner resolves `env:NAME` only
  at execution time and fails closed when a value is missing, mapped to another
  role, or uses a provider/infrastructure name such as `OPENAI_API_KEY` or
  `PREFLIGHT_SCOUT_DATABASE_PASSWORD`.
- Each configured auth role must provide a reviewed `signedInTarget` locator.
  Login succeeds and auth state is saved only after an `assert_visible` step
  confirms that exact post-login marker.
- Mission `policyLabel` values are exact capability labels. Browser decisions
  must bind to both the reviewed step ID and label; human-readable instructions
  do not grant implied actions.
- Owned and delegated paths accept only a bounded absolute HTTP(S) starting
  target without embedded credentials. Preflight Scout's built-in Playwright missions
  additionally remain on its exact origin. Non-HTTP(S) and browser-internal URLs, embedded
  URL credentials, off-origin clicks/forms/redirects, and popups block the
  mission. Evidence and auth state from a violated boundary are discarded or
  invalidated; cross-origin SSO requires manual review. Delegated browser agents
  do not inherit this deterministic boundary.
- Keep `.preflight-scout/auth/` ignored. Storage-state files may contain cookies, bearer tokens, and local/session storage.
- `preflight-scout approve` stores decisions in `.preflight-scout/approvals.local.yml` and
  loads them only when Git proves the file is ignored and untracked. Do not
  commit approvals; legacy `.preflight-scout/approvals.yml` files are refused.
- Upload authenticated screenshots, traces, and network evidence only after reviewing them for secrets and personal data.
- Use disposable test accounts and staging, preview, or local environments. Do not automate production writes.

## Official references

- [OpenAI GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Codex CLI](https://developers.openai.com/codex/cli)
- [Anthropic models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Gemini deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
