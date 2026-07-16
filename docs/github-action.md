# GitHub Action

Preflight Scout's GitHub Action is the CI wrapper for the same core pipeline used by the CLI.

It can:

- analyze the PR diff and repo context
- post or update one PR comment
- keep the PR comment concise while uploading the full report as an artifact
- run one or all LLM-planned browser missions against a preview/staging URL
- upload the full evidence bundle: Markdown, HTML, JSON, screenshots, and browser run artifacts
- set a `Preflight Scout` commit status

## Release status

Version `0.1.0` is available from commit
`635367af48d1c75b95a08b3e97001258729c0d46`. The workflow below pins that
exact release. Review each later release before changing the SHA; do not use a
floating branch or major-version tag for this Action.

## Workflow template

```yaml
name: Preflight Scout
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  issues: write
  statuses: write
  deployments: read

jobs:
  preflight_scout:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          fetch-depth: 0
      - uses: fenutech/preflight-scout@635367af48d1c75b95a08b3e97001258729c0d46 # v0.1.0
        with:
          github-token: ${{ github.token }}
          mode: analyze-and-run
          mission-limit: "1"
          fail-on: needs_attention
        env:
          PREFLIGHT_SCOUT_LLM_PROVIDER: openai
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          PREFLIGHT_SCOUT_APP_URL: ${{ vars.PREVIEW_URL }}
```

Start with one ranked mission. Expand the limit only after reviewing the target,
credentials, browser actions, runtime, and provider cost.

For `analyze-and-run` and `run`, the composite Action installs its matching Playwright Chromium build and Linux browser dependencies before execution. `analyze` mode skips that download.

## Local-First Default

For standard development, run Preflight Scout locally by default and use GitHub Actions only when you explicitly want a hosted gate or a shareable artifact. This avoids spending Actions minutes and LLM credits while iterating.

Useful local commands:

```bash
pnpm build
pnpm test
pnpm pack:check
```

For the product itself, browser-heavy checks are local by default:

```bash
pnpm playwright:install
pnpm test:browser
```

Use the GitHub Action when you want PR comments, uploaded report bundles, or a
team-visible merge gate. This repository's own opt-in self-check analyzes a
same-repository PR head while executing only trusted default-branch Action code
through `pull_request_target`. It stays disabled unless the
`PREFLIGHT_SCOUT_SELF_CHECK_GITHUB` repository variable is `true` and the provider
secret exists.

## Inputs

- `mode`: `analyze`, `analyze-and-run`, or `run`.
- `app-url`: explicit preview/staging/local URL.
- `target`: named `app.targets` entry from `.preflight-scout/config.yml`.
- `target-env`: `auto`, `local`, or `staging` from `.preflight-scout/config.yml`.
- `detect-deployment-url`: when true, reads the latest successful GitHub Deployment URL for the PR head SHA.
- `mission-id`: run one generated browser mission.
- `mission-limit`: run the first N LLM-ranked browser missions when `all-candidates` is false. Defaults to `defaults.missionLimit`, then 1 in hosted CI.
- `all-candidates`: run every generated browser mission sequentially.
- `storage-state`: Playwright storage-state JSON to load for authenticated sessions.
- `save-storage-state`: write storage state after browser execution.
- `trace`: capture Playwright `trace.zip` for browser missions.
- `comment`: post or update the PR comment.
- `upload-artifact`: upload the report bundle.
- `fail-on`: CI gate behavior:
  - `never`: never fail the workflow because of QA findings.
  - `needs_attention`: fail on failed or blocked browser missions.
  - `failed_only`: fail only when at least one browser mission failed.

## PR Comment

The PR comment is intentionally short. It includes:

- verdict, risk, and gate mode
- browser pass/fail/block counts
- top failed or blocked missions
- a short must-test checklist
- changed surfaces
- artifact name/id for the full evidence bundle

The full report stays in the uploaded artifact so the PR thread remains readable.

## Outputs

- `verdict`
- `risk`
- `affected-count`
- `manual-check-count`
- `browser-mission-count`
- `passed-count`
- `failed-count`
- `blocked-count`
- `fail-on`
- `artifact-id`
- `app-url`
- `report-path`
- `report-html-path`
- `summary-path`

## URL Resolution

Browser mode resolves the target URL in this order:

1. `app-url` input
2. `PREFLIGHT_SCOUT_APP_URL` environment variable
3. latest successful GitHub Deployment URL for the PR head SHA
4. `.preflight-scout/config.yml` through `target` and `target-env`

This is deterministic environment discovery. The LLM still owns product reasoning and browser decisions.

## Artifacts

The uploaded artifact contains:

- `impact-map.json`
- `mission.json`
- `report.md`
- `report.html`
- `report-summary.json`
- `run-result.json` or `run-results.json`
- screenshots, `trace.zip`, console errors, network failures, and final browser observation

Do not upload or commit Playwright storage-state files unless they are explicitly scrubbed test fixtures.
