# Public alpha

Preflight Scout helps a coding agent check a pull request before release. The
agent proposes a plan and runs approved checks; you review the plan, browser
evidence, unknowns, and any request for a risky action. It is intended for
engineers testing against local, preview, or staging environments.

The [illustrative sample report](../examples/sample-report/report.md) shows the
human-facing result. Its [fixture disclosure](../examples/sample-report/README.md)
separates synthetic examples from real browser evidence.

## Install the skill and CLI

Full use requires both. The skill tells Codex or Claude Code how to operate
Preflight Scout; the CLI reads the repository, runs Chromium, and writes the
artifacts.

Requirements: Node.js 22.13 or newer. For users and agents, npm is the
recommended CLI installation after release. Before running these commands,
confirm that the official `v0.1.4` release and the live npm registry both list
the exact package. The source tree alone is not proof that the registry package
exists.

```bash
npm view @preflight-scout/cli@0.1.4 version --registry=https://registry.npmjs.org/
npm install --global @preflight-scout/cli@0.1.4 --registry=https://registry.npmjs.org/
preflight-scout install-browser
preflight-scout --version
```

Keep the exact version pin. The separate browser command avoids a large,
surprising download during npm installation. A quick, non-durable trial is
available after the same release checks:

```bash
npm exec --yes --registry=https://registry.npmjs.org/ --package=@preflight-scout/cli@0.1.4 -- preflight-scout --help
```

`npm exec` uses an ephemeral cached environment; it is not the installation to
give an agent for repeated work.

Until the exact release is live—or for contribution and development—install
from a trusted, stable source checkout with pnpm:

```bash
git clone https://github.com/fenutech/preflight-scout.git
cd preflight-scout
corepack enable
pnpm install --frozen-lockfile
pnpm install:source-cli
preflight-scout --version
```

The source installer builds the workspace, verifies the CLI distribution,
installs Chromium, and validates a durable wrapper in `~/.local/bin` (or
`XDG_BIN_HOME`). The wrapper pins the absolute current Node executable and built
CLI paths, so keep both at those paths. Select an explicit executable directory
when needed:

```bash
pnpm install:source-cli -- --bin-dir /absolute/path/to/bin
```

The installer refuses to replace an unrelated command. An intentional
`--force` replacement first keeps a timestamped backup. After updating the
source checkout, rerun `pnpm install --frozen-lockfile` and
`pnpm install:source-cli` so the build, verification, wrapper, and Chromium
installation remain aligned.

Keep the two parts on one release. Pair the released npm CLI with the
`plugin-stable` repository plugin. Pair an unreleased source CLI only with the
direct skill folder from that same checkout; `plugin-stable` intentionally stays
on the previous published release. Follow the complete, copyable
[Codex and Claude Code journeys](skills.md#complete-codex-journey), then start a
new client task or session so it discovers the skill.

Release candidates also support installation from locally packed tarballs. A
planned package name, source manifest, or packed tarball is not proof that a
registry release exists.

## Update an existing installation

Run the read-only release check before a QA pass:

```bash
preflight-scout update-check --skill-version 0.1.4
```

The `0.1.0` CLI predates this command. For that one upgrade, confirm the GitHub
`v0.1.4` release and npm package both exist, run the exact pinned install at the
top of this page, refresh the plugin, restart the client, and then use
`update-check` for later releases.

It compares the installed CLI and skill version with npm's official `latest`
release and prints exact commands when an update is available. It never runs
npm or changes files. Refresh the agent plugin separately:

```bash
# Codex
codex plugin marketplace upgrade preflight-scout

# Claude Code
claude plugin marketplace update preflight-scout
claude plugin update preflight-scout@preflight-scout
```

Restart the client and open a new task or session after updating the plugin.

## Run a local check

From the repository you want to test, initialize the local contract before the
first analysis. Replace the example target and URL with the app you actually
intend to test:

```bash
export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec
preflight-scout init --no-llm --target frontend --local-url http://127.0.0.1:3000 --base origin/main --target-env local
preflight-scout doctor --base origin/main --head HEAD --agent codex
preflight-scout analyze --base origin/main --head HEAD --open-report
preflight-scout run --analysis-dir .preflight-scout/runs/latest --target frontend --env local --open-report
```

`init --no-llm` writes `.preflight-scout/config.yml` and the required ignore
rules without making a model call. Review the generated contract before the
browser run. Use `claude-exec` and `--agent claude` when Claude Code is the
signed-in agent. In
PowerShell, set `$env:PREFLIGHT_SCOUT_LLM_PROVIDER = "codex-exec"` (or
`"claude-exec"`) instead of the `export` line.

For authenticated apps:

```bash
preflight-scout auth login --target frontend --role qa_user --env local
preflight-scout run --analysis-dir .preflight-scout/runs/latest --target frontend --env local --open-report
```

By default the CLI runs the highest-ranked automation candidates. Narrow the pass with `--mission-limit 1` or `--mission-id <id>`, or use `--all-candidates` intentionally.

## Alpha expectations

- Preflight Scout can miss or misclassify problems. Review the plan, browser actions, promoted tests, and release result.
- Use test accounts and non-production environments.
- Keep provider keys and Playwright storage state out of git.
- Keep `.env.preflight-scout.local` ignored and untracked, and use only dedicated
  `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)` browser credentials.
- Treat `agent-run`, delegated auth, MCP servers, and custom commands as trusted
  execution. The deterministic same-origin HTTP(S) browser boundary applies to
  Preflight Scout's built-in Playwright runner, not an external agent's browser.
- A blocked mission is useful evidence; do not weaken a guardrail merely to produce a green report.
- File product feedback and reproducible bugs, but use the private security channel in `SECURITY.md` for vulnerabilities or exposed credentials.
