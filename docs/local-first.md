# Local-First Preflight Scout Loop

Preflight Scout is designed to run locally by default. GitHub Actions is a publishing and team-gating layer, not the primary place to spend browser time or LLM credits.

## New Repo Setup

```bash
preflight-scout init \
  --target frontend \
  --local-url http://127.0.0.1:3000 \
  --base origin/main \
  --target-env local \
  --role standard_user \
  --username-env PREFLIGHT_SCOUT_BROWSER_STANDARD_USER_EMAIL \
  --password-env PREFLIGHT_SCOUT_BROWSER_STANDARD_USER_PASSWORD \
  --save-storage-state .preflight-scout/auth/standard_user.json
```

`preflight-scout init` writes:

- `.preflight-scout/config.yml`
- `.preflight-scout/context.md`
- `.preflight-scout/flows.yml`
- `.preflight-scout/policies.yml`
- `.env.preflight-scout.example`
- `.gitignore` entries for `.preflight-scout/auth/`, `.preflight-scout/runs/`,
  `.preflight-scout/approvals.local.yml`, and `.env.preflight-scout.local`

The LLM drafts product meaning from repo context. CLI flags only apply explicit human-supplied facts such as URLs, credential environment variable names, and base refs.
When you pass an explicit `--role`, Preflight Scout treats that as the configured auth role set for the draft instead of preserving speculative LLM-inferred roles.

## Daily Use

```bash
preflight-scout run --open-report
```

That command resolves its defaults from:

1. explicit CLI flags
2. `.env.preflight-scout.local`
3. `.preflight-scout/config.yml`
4. git remote metadata for the base ref

The run produces human-readable output in `.preflight-scout/runs/latest`:

- `report.md`
- `report.html`
- `report-summary.json`
- `impact-map.json`
- `mission.json`
- screenshots and browser evidence

The local CLI runs the first two LLM-ranked browser missions by default. Use `--mission-limit 1` for a cheaper smoke, `--mission-id <id>` for one explicit mission, or `--all-candidates` when you want the full LLM-proposed browser suite.

When you want a reviewable two-step loop, generate the exact mission first and then execute that same artifact:

```bash
preflight-scout analyze --output-dir .preflight-scout/runs/latest --open-report --pdf
preflight-scout run --analysis-dir .preflight-scout/runs/latest --open-report --pdf
```

This prevents a later browser run from replanning a different role or mission shape than the one you reviewed.

For repos with more than one app surface, configure named targets:

```yaml
app:
  targets:
    frontend:
      localUrl: http://127.0.0.1:3000
    admin:
      localUrl: http://127.0.0.1:3001
defaults:
  target: frontend
  missionLimit: 2
```

Then run a specific surface:

```bash
preflight-scout run --target admin --env local --open-report
```

## Promotion And PDF

When a dynamic run proves useful, promote it into a durable Playwright test:

```bash
preflight-scout promote --run-dir .preflight-scout/runs/latest --output-dir tests/preflight-scout
```

To produce a shareable human packet:

```bash
preflight-scout report --run-dir .preflight-scout/runs/latest --pdf
```

## Credentials And Sessions

Keep real values in `.env.preflight-scout.local`, not in git. A repository-local env
file is loaded only when Git proves that it is ignored and untracked. Existing
parent-environment values take precedence over values in the file.

```bash
OPENAI_API_KEY=...
PREFLIGHT_SCOUT_BROWSER_STANDARD_USER_EMAIL=tester@example.com
PREFLIGHT_SCOUT_BROWSER_STANDARD_USER_PASSWORD=...
```

Set provider selection, models, timeouts, base URLs, and exec controls in the
trusted parent shell instead, for example `export PREFLIGHT_SCOUT_LLM_PROVIDER=openai`.

Browser credential references must match
`PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)`. The browser runner and
delegated-agent paths expose only the credentials mapped to the mission's exact
selected role. Generic provider or infrastructure names are not valid browser
credentials.

By default the env file cannot set privileged provider selection, model,
base-ref/base-URL, `PREFLIGHT_SCOUT_EXEC_*`, proxy/TLS, Node/runtime, Git, or local-agent
configuration controls. If the file is intentionally trusted, set
`PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1` in the parent environment. That flag is
always forbidden inside the file, and parent values still win.

For authenticated apps, either give the browser agent credential env names in the config, or provide a Playwright storage state:

```bash
preflight-scout auth login --role standard_user --env local
preflight-scout auth login --role standard_user --env local --agent codex
preflight-scout run --storage-state .preflight-scout/auth/standard_user.json
```

`preflight-scout auth login` only marks a storage state valid after the browser mission reaches an observed signed-in state. Failed or blocked login attempts write a `.preflight-scout.json` sidecar beside the requested storage-state path, and later runs block cleanly instead of loading a known-bad session.
Preflight Scout only auto-loads storage state for missions whose `role` exactly matches a configured `auth.roles` entry. Public, guest, missing, or unconfigured roles do not inherit auth storage unless you pass `--storage-state` explicitly.
`preflight-scout auth login` uses a larger default browser-turn budget than normal missions because login routes often include cookie banners, splash pages, and redirects.
Use `--agent codex` or `--agent claude` when you want the LLM itself to use Playwright MCP/skill/CLI calls for login. The non-agent login path is still an LLM-driven browser loop, but Preflight Scout owns the Playwright execution boundary there.

That built-in Preflight Scout boundary permits only same-origin HTTP(S) main-frame
navigation. It blocks non-HTTP(S) schemes, embedded URL credentials,
off-origin interactions and redirect hops, and popups; a violation blocks the
mission and prevents unsafe evidence or authenticated state from being kept.
Cross-origin SSO must be reviewed manually. Delegated agents use their own
browser boundary instead.

Storage-state files should be treated like secrets unless they are scrubbed fixtures.
