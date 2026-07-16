# Generic Demo Repository

Use the generic demo command to create a standalone checkout app with a PR-style change:

```bash
preflight-scout demo --output /tmp/preflight-scout-generic-shop --force
cd /tmp/preflight-scout-generic-shop
python3 -m http.server 4173
```

`--force` replaces only a directory carrying Preflight Scout's exact demo marker.
Unrelated directories, symlinked output components, filesystem roots, the home
directory, and the current working directory are refused.

Then run Preflight Scout from the demo repo:

```bash
export PREFLIGHT_SCOUT_LLM_PROVIDER=openai
export OPENAI_API_KEY=...
preflight-scout analyze
preflight-scout run --analysis-dir .preflight-scout/runs/latest
```

The demo's `.preflight-scout/config.yml` supplies `defaults.baseRef` and the local URL, so the normal local loop does not require repeating those flags.

Browser execution writes replayable evidence next to the report:

- per-step screenshots
- Playwright `trace.zip`
- `console-errors.json`
- `network-errors.json`
- `final-observation.json`

The demo repo contains:

- a base checkout page
- one committed PR-style change that adds expired-promo feedback
- `.preflight-scout/config.yml` with generic checkout context and safe test data

This is intentionally self-contained. It tests the universal loop: PR diff -> LLM impact map -> QA mission -> browser evidence -> human report.

## Authenticated Demo

Use the auth-dashboard scenario to exercise login/session bootstrap:

```bash
preflight-scout demo --scenario auth-dashboard --output /tmp/preflight-scout-auth-dashboard --force
cd /tmp/preflight-scout-auth-dashboard
python3 -m http.server 4173
```

Then, in another terminal:

```bash
export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec
export PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL=qa@example.com
export PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD=password123
preflight-scout auth login --env local
preflight-scout run --env local --open-report
```

The demo proves the generic authenticated loop without depending on an external application.
