# Agent Skill installation

The Agent Skill is the recommended, agent-first way to use Preflight Scout from
Codex or Claude Code. It teaches the agent how to turn a change into a focused
QA plan, run safe checks when tools are available, and report evidence without
claiming that an unexecuted check passed. A human still reviews the mission,
evidence, unknowns, and risky-action approvals.

See the [illustrative sample report](../examples/sample-report/report.md) and its
[fixture disclosure](../examples/sample-report/README.md) before a first run.

The skill and CLI are separate:

- The skill is the agent-facing workflow.
- The CLI provides repository analysis, browser execution, and report artifacts.
- Installing the skill does not install the CLI or grant shell, repository,
  browser, network, or credential access.

Without the CLI or local tools, the skill remains useful in checklist-only mode
for supplied diffs and reports. Full local verification requires both the skill
and a source or package installation of the CLI.

## Recommended: install the repository plugin

The repository exposes the same canonical skill through Codex and Claude
plugin manifests. Both clients are pinned to the `plugin-stable` branch, which
advances only after the matching npm and GitHub release has passed live install
verification. Pair this channel with the released npm CLI. For an unreleased
source CLI, use the direct skill folder from the same checkout instead.

Codex:

```bash
codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable
codex plugin add preflight-scout@preflight-scout
```

Alternatively, after adding the marketplace, open `/plugins`, choose
`preflight-scout`, and install **Preflight Scout** there. The client fetches the
released skill from the public GitHub repository. Adding the source as a client
marketplace does not create an external marketplace listing or install the
separate CLI.

Invoke the installed Codex plugin with `$preflight-scout:preflight-scout`. Restart
the client if the plugin does not appear. The shorter `$preflight-scout` name is
for a directly copied Codex skill.

Claude Code:

```bash
claude plugin marketplace add fenutech/preflight-scout@plugin-stable
claude plugin install preflight-scout@preflight-scout
```

Invoke the installed Claude plugin with `/preflight-scout:preflight-scout`. Restart
the client if the plugin does not appear. These installs provide the skill, not
the separate Preflight Scout CLI.

## Package the skill

From a trusted checkout of this repository:

```bash
skills/scripts/package-skill.sh
```

This validates the canonical source at `skills/preflight-scout/` and writes
`dist/preflight-scout-skill.zip`. The archive contains one top-level
`preflight-scout/` folder with `SKILL.md`, `agents/openai.yaml`, supporting
references, and the AGPL license. It does not upload or publish anything.

## Direct Codex installation

Codex discovers personal skills under `~/.agents/skills/` and repository skills
under `.agents/skills/`. For a personal installation from this checkout:

```bash
mkdir -p ~/.agents/skills/preflight-scout
cp -R skills/preflight-scout/. ~/.agents/skills/preflight-scout/
```

For a project-scoped installation, copy the same folder to
`.agents/skills/preflight-scout/` in that project. Codex supports symlinked skill
folders, so contributors who want live updates from this checkout can instead
use:

```bash
mkdir -p ~/.agents/skills
ln -s "$(pwd)/skills/preflight-scout" ~/.agents/skills/preflight-scout
```

Do not run the symlink command over an existing installation. Codex normally
detects skill changes automatically; restart it if the skill does not appear.
Invoke the skill explicitly with `$preflight-scout`, or ask for release QA and let
its description match the request.

Use this direct-folder route for local development or when plugin installation
is unavailable.

## ChatGPT web

Where personal Skills and uploads are enabled:

1. Select the profile icon, then **Skills**.
2. Select **Create**, then **Upload from your computer**.
3. Upload `dist/preflight-scout-skill.zip`.

Workspace controls and plan availability may hide these options. ChatGPT web
cannot automatically reach a developer's local repository, app, browser
session, or CLI. Supply a diff or report for checklist-only review, or use Codex
on the workstation for the full workflow.

## Direct Claude Code installation

The copy-based installation works across current Claude Code releases:

```bash
mkdir -p ~/.claude/skills/preflight-scout
cp -R skills/preflight-scout/. ~/.claude/skills/preflight-scout/
```

For a project-scoped installation, copy the folder to
`.claude/skills/preflight-scout/` in that project. Claude Code exposes it as
`/preflight-scout` and can also invoke it when the request matches the description.

Current Claude Code releases support symlinked skill directories. Contributors
can use a development symlink instead of a copy:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skills/preflight-scout" ~/.claude/skills/preflight-scout
```

Do not run the symlink command over an existing installation. If a client does
not discover the symlink reliably, use the copy-based installation above.
Claude Code detects `SKILL.md` changes in an existing skills directory; restart
it when the top-level skills directory was created after the session started.

## claude.ai

With code execution and custom Skills enabled:

1. Open **Customize → Skills**.
2. Select **+**, then **Create skill**.
3. Select **Upload a skill** and upload `dist/preflight-scout-skill.zip`.

The claude.ai execution environment is separate from the user's workstation.
Use it to review supplied diffs and Preflight Scout artifacts; use Claude Code for
local repository and browser access.

## Install the CLI

Requirements: Node.js 22.13 or newer. For users and agents, prefer the released
npm package. Because this source may be visible before publication, first
confirm that the official `v0.1.3` release and the live npm registry both list
`@preflight-scout/cli@0.1.3`. If either is missing, skip this install and use the
source path below.

```bash
npm view @preflight-scout/cli@0.1.3 version --registry=https://registry.npmjs.org/
npm install --global @preflight-scout/cli@0.1.3 --registry=https://registry.npmjs.org/
preflight-scout install-browser
preflight-scout --version
```

Keep the exact version pin. Installing the browser explicitly avoids a large
download during npm `postinstall`. For a quick trial after the same release
checks:

```bash
npm exec --yes --registry=https://registry.npmjs.org/ --package=@preflight-scout/cli@0.1.3 -- preflight-scout --help
```

That command uses an ephemeral cached environment. It is not durable enough
for repeated agent work.

Until the exact release is live—or for contributors—use the CLI from a trusted,
stable source checkout with pnpm:

```bash
cd "/absolute/path/to/preflight-scout"
corepack enable
pnpm install --frozen-lockfile
pnpm install:source-cli
preflight-scout --version
```

`install:source-cli` builds the workspace, verifies the CLI distribution,
installs Chromium, validates the command, and writes a durable wrapper to
`~/.local/bin` (or `XDG_BIN_HOME`). The wrapper pins the absolute current Node
executable and built CLI paths. It survives fresh shells and agent tasks, so
keep both at their current paths. Use a user-selected executable directory when
needed:

```bash
pnpm install:source-cli -- --bin-dir /absolute/path/to/bin
```

The installer refuses to overwrite an unrelated command unless `--force` is
explicit; forced replacement keeps a timestamped backup. If the executable
directory is not on `PATH`, invoke the printed absolute path or ask before
changing the user's shell configuration. After updating the source checkout,
rerun `pnpm install --frozen-lockfile` and `pnpm install:source-cli`. A planned
npm package name is not evidence that a registry release exists.

An unreleased source CLI must use the direct Codex or Claude Code skill from
that same checkout. Do not pair it with `plugin-stable`, which stays on the
previous published release until the complete publication workflow succeeds.

## Update the CLI and plugin

The released CLI and marketplace plugin use the same version. Before a full
agent-operated run, compare the installed pair with npm:

```bash
preflight-scout update-check --skill-version 0.1.3
```

The `0.1.0` CLI does not have this command. To bootstrap the first update,
confirm the GitHub `v0.1.3` release and npm package both exist, install the exact
`@preflight-scout/cli@0.1.3` package from [Install the CLI](#install-the-cli),
refresh the plugin, restart the client, and then run `update-check`.

The command is read-only. It contacts only the public npm registry, does not
send repository data, and prints an exact pinned npm command when a newer
release exists. A CLI/skill version mismatch blocks the full workflow until the
pair is aligned.

Refresh Codex's Git marketplace snapshot, then restart Codex and open a new
task:

```bash
codex plugin marketplace upgrade preflight-scout
```

Claude Code can update the marketplace and installed plugin explicitly:

```bash
claude plugin marketplace update preflight-scout
claude plugin update preflight-scout@preflight-scout
```

Third-party Claude marketplaces do not auto-update by default. Leave that
default unless you intentionally want Claude Code to refresh trusted plugin
content automatically. Direct folder copies remain manual; replace the copied
skill from a reviewed release or use the repository plugin instead.

Installations created before the stable channel existed need one migration.
Codex requires removing the old marketplace source, re-adding it, and
installing the plugin again. Claude Code can replace the source directly:

```bash
# Codex
codex plugin marketplace remove preflight-scout
codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable
codex plugin add preflight-scout@preflight-scout

# Claude Code
claude plugin marketplace add fenutech/preflight-scout@plugin-stable
```

## Complete Codex journey

1. Choose one aligned pair: the verified npm CLI plus `plugin-stable`, or the
   source CLI plus the [direct Codex skill](#direct-codex-installation) from the
   same checkout. Confirm the durable command:

   ```bash
   preflight-scout --version
   ```

2. For the released npm CLI, install the plugin:

   ```bash
   codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable
   codex plugin add preflight-scout@preflight-scout
   ```

   For a source CLI, use the direct skill instructions instead and invoke
   `$preflight-scout`.

3. Quit and reopen Codex, then start a **new task** rooted in the repository
   containing the change. A task that was already running before installation
   may not discover the new plugin.

4. Send this exact first-run prompt:

   ```text
   Use $preflight-scout:preflight-scout to verify the current change against origin/main. First confirm preflight-scout --version and run setup diagnostics. Let me review the generated mission before browser execution, do not run dangerous actions, and finish with release readiness plus evidence paths.
   ```

The directly copied Codex skill uses `$preflight-scout` instead of the namespaced
plugin name.

## Complete Claude Code journey

1. Choose one aligned pair: the verified npm CLI plus `plugin-stable`, or the
   source CLI plus the [direct Claude Code skill](#direct-claude-code-installation)
   from the same checkout. Confirm the durable command:

   ```bash
   preflight-scout --version
   ```

2. For the released npm CLI, install the plugin:

   ```bash
   claude plugin marketplace add fenutech/preflight-scout@plugin-stable
   claude plugin install preflight-scout@preflight-scout
   ```

   For a source CLI, use the direct skill instructions instead and invoke
   `/preflight-scout`.

3. Exit Claude Code, open a **new session** in the repository containing the
   change, and confirm that `/preflight-scout:preflight-scout` is available. A session
   started before installation may not discover the plugin.

4. Send this exact first-run prompt:

   ```text
   Use /preflight-scout:preflight-scout to verify the current change against origin/main. First confirm preflight-scout --version and run setup diagnostics. Let me review the generated mission before browser execution, do not run dangerous actions, and finish with release readiness plus evidence paths.
   ```

The directly copied Claude Code skill uses `/preflight-scout` instead of the
namespaced plugin name.

## What the agent runs

The first-run local sequence is:

```bash
preflight-scout --version
preflight-scout install-browser # only when the install path did not already install Chromium, or doctor reports it missing
preflight-scout init --dry-run --base origin/main
preflight-scout init --base origin/main # only when .preflight-scout/config.yml is absent
preflight-scout doctor --base origin/main --head HEAD
preflight-scout analyze --base origin/main --head HEAD --open-report
```

Add `--mcp --agent codex` or `--mcp --agent claude` to `doctor` before
delegating browser execution. Configure an app target and disposable test
credentials named with
`PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)` before authenticated
browser missions. The delegated agent's browser remains outside Preflight Scout's
deterministic same-origin Playwright boundary.

## Maintenance contract

- Keep `skills/preflight-scout/` as the only source of truth.
- Keep the required `agents/openai.yaml` metadata additive so Claude can ignore
  it safely while Codex gets the richer display information.
- Let Codex or Claude Code use its configured model unless reproducibility
  requires a deliberate pin.
- Never turn planned checks into claimed results.
- Treat storage state and credential values as secrets.
- Validate the archive and smoke-test current stable clients before a release.

## Official references

- OpenAI: https://learn.chatgpt.com/docs/build-skills
- OpenAI ChatGPT Skills: https://help.openai.com/en/articles/20001066
- OpenAI plugins: https://learn.chatgpt.com/docs/build-plugins
- Anthropic Claude Code Skills: https://code.claude.com/docs/en/skills
- Anthropic custom Skills: https://support.claude.com/en/articles/12512198-how-to-create-custom-skills
- Anthropic Skills in Claude: https://support.claude.com/en/articles/12512180-use-skills-in-claude
