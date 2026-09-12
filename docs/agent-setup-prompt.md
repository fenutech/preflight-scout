# Set up Preflight Scout for this coding agent

<!-- Source template: the site build replaces {{RELEASE_VERSION}} with the website package version. -->

The user asked you to install and set up Preflight Scout. Carry out the
applicable supported setup below, then verify it. Do not stop at describing
commands or ask for the same installation approval again. Ask only for a
missing choice you cannot infer or an interactive login the user must complete.

This is installation and agent onboarding. Do not initialize a QA contract,
analyze a repository, run browser missions, create credentials, accept new
terms, deploy, or publish as part of setup. Preserve existing configuration and
unrelated tools. Never overwrite a custom wrapper, skill, or MCP configuration
without resolving the conflict with the user.

## Inspect before installing

1. Identify the current agent (Codex, Claude Code, or another agent), operating
   system, available shell, and whether you have local terminal access.
2. Check `node --version`, `npm --version`, and `preflight-scout --version`.
   Node.js 22.13 or newer is required. If the runtime is missing, explain that
   prerequisite; do not silently replace a system-wide Node installation.
3. Inspect the installed agent's version and plugin help/list commands before
   changing its setup. Reuse a working matching CLI and skill. Do not downgrade
   a newer compatible installation or replace a source-checkout wrapper with
   an npm binary. For existing source installs, follow the
   [source installation guide](https://github.com/fenutech/preflight-scout/blob/main/skills/preflight-scout/references/cli-installation.md#source-installation)
   and keep the CLI and direct skill from that same checkout.
4. If you have no local terminal access, explain that this surface cannot
   perform local installation and supports checklist-only review. Link to
   [local installation](https://preflightscout.com/install/) for Codex or Claude
   Code; do not claim an installation happened. Installation does not require
   an application repository; repository access is needed for a later QA pass.

## Install the released CLI when needed

These commands target release **{{RELEASE_VERSION}}**. First verify the official
[GitHub release](https://github.com/fenutech/preflight-scout/releases/tag/v{{RELEASE_VERSION}})
exists and the live npm registry returns that exact version:

```bash
npm view @preflight-scout/cli@{{RELEASE_VERSION}} version --registry=https://registry.npmjs.org/
```

If either check fails, do not guess another version or use `latest`. Follow
the source installation guide only when a source installation is appropriate.
If a newer matching CLI and skill are already working, retain them and use
their own exact release instructions instead of the commands below.

For an absent or older release installation:

```bash
npm install --global @preflight-scout/cli@{{RELEASE_VERSION}} --registry=https://registry.npmjs.org/
preflight-scout install-browser
```

If the exact CLI is already present, skip reinstalling it. Running
`preflight-scout install-browser` checks/downloads the matching Chromium;
it does not run a QA mission. Do not automatically add `--with-deps` or use
`sudo` to work around permissions. Report the specific missing prerequisite
or installation conflict.

## Add the skill for the current agent

Install only the plugin for the agent the user is using. If both clients are
installed, prefer the current task's client; ask only if that is unknown.
Inspect existing plugin state and skip already-correct registrations.
The `plugin-stable` channel moves only after the official CLI and matching
GitHub release are verified. Check its skill compatibility version before
pairing it with an older pinned CLI. If the channel has advanced, retain a
working matching pair or verify the newer exact release before updating both.

### Codex

```bash
codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable
codex plugin add preflight-scout@preflight-scout
```

For an existing plugin that needs a refresh:

```bash
codex plugin marketplace upgrade preflight-scout
```

After restart, invoke `$preflight-scout:preflight-scout`.

### Claude Code

```bash
claude plugin marketplace add fenutech/preflight-scout@plugin-stable
claude plugin install preflight-scout@preflight-scout
```

For an existing plugin that needs a refresh:

```bash
claude plugin marketplace update preflight-scout
claude plugin update preflight-scout@preflight-scout
```

After restart, invoke `/preflight-scout:preflight-scout`.

### Other local agents or clients without plugin support

Follow the [direct skill installation instructions](https://github.com/fenutech/preflight-scout/blob/main/docs/skills.md).
Use the skill from the exact CLI release, or the same checkout for a source
install. Do not invent a client-specific plugin command or overwrite an
existing custom skill. The CLI can still be used directly when the agent has
shell and repository access; no separate browser MCP is required for its
owned Playwright runner.

## Verify and hand back a usable setup

For the release installed above, run:

```bash
preflight-scout --version
preflight-scout --help
preflight-scout update-check --skill-version {{RELEASE_VERSION}}
```

For a retained newer or source installation, use the exact compatibility value
from its installed skill instead. Confirm the intended CLI is on `PATH`, the
matching Chromium installation completed, and the current agent's skill/plugin
is installed. A registry outage with a matching installed pair is a warning;
an incompatible pair is unresolved setup.

When the authenticated current client is known, explain its provider for the
next QA task: `PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec` or `claude-exec`. Respect
an existing operator provider/model policy. Export provider settings in that
task's shell or repeat them per command; do not write privileged controls to a
repository env file. Do not create API keys or add MCP servers just to finish
this setup. If the client needs interactive authentication, leave that step to
the user and say what remains unverified.

End with a concise report of what was reused or installed, the actual verified
CLI/skill versions, and any remaining prerequisite. Ask the user to restart
the coding-agent client and start a new task so the plugin can be discovered;
do not claim the current task can see a newly installed skill. Give the exact
invocation for their client and link to the
[agent workflow guide](https://preflightscout.com/agent-guide.md) for their first
authorized QA pass.
