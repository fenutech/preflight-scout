# CLI installation

Read this reference only when `preflight-scout --version` fails on a local execution surface.

## Recommended release installation

Requirements: Node.js 22.13 or newer. For users and agents, prefer the exact
released npm package. First confirm both of these facts:

1. The official Preflight Scout release documentation lists `v0.1.6`.
2. The live npm registry lists `@preflight-scout/cli@0.1.6`.

Do not infer registry availability from a planned package name in source, this
skill, a packed tarball, or an old checkout. If either check fails, continue to
[Source installation](#source-installation).

After both checks pass:

```bash
npm view @preflight-scout/cli@0.1.6 version --registry=https://registry.npmjs.org/
npm install --global @preflight-scout/cli@0.1.6 --registry=https://registry.npmjs.org/
preflight-scout install-browser
preflight-scout --version
```

Keep the exact version pin. Do not silently substitute `latest`. The explicit
browser step avoids a large download during npm `postinstall` and makes the
runtime requirement visible to the user.

For a quick trial after the same two checks:

```bash
npm exec --yes --registry=https://registry.npmjs.org/ --package=@preflight-scout/cli@0.1.6 -- preflight-scout --help
```

`npm exec` uses an ephemeral cached environment. It is not a durable
installation for future shells or agent tasks. Installing the CLI also does not
install the Agent Skill; full agent-operated local QA requires both.

For an existing installation, run the read-only compatibility and registry
check before the full workflow:

```bash
preflight-scout update-check --skill-version 0.1.6
```

If it reports a newer release, use the exact pinned npm command it prints,
install Chromium again, and refresh the Codex or Claude Code marketplace plugin
as described in the public installation guide. The command never installs or
changes anything itself.

## Source installation

Use this path until the exact release is live, or when working on Preflight
Scout itself.

Install from a stable source checkout that the user can already access.
Requirements are Node.js 22.13 or newer and pnpm 11.12 or newer. Reuse an
existing canonical checkout instead of cloning a second copy; the durable
command will point to this checkout.

```bash
cd "/absolute/path/to/preflight-scout"
corepack enable
pnpm install --frozen-lockfile
pnpm install:source-cli
preflight-scout --version
```

`install:source-cli` builds the workspace, verifies the CLI distribution,
installs Chromium, validates the command, and writes a durable `preflight-scout`
wrapper to `~/.local/bin` (or `XDG_BIN_HOME`). The wrapper pins the absolute
current Node executable and built CLI paths, so it survives fresh shells and
agent tasks but requires both targets to remain at those paths.
To select another executable directory:

```bash
pnpm install:source-cli -- --bin-dir /absolute/path/to/bin
```

The installer refuses to replace an unrelated command. Use `--force` only when
replacement is intentional; the installer keeps a timestamped backup. If the
chosen directory is not on `PATH`, use the absolute command printed by the
installer. Change shell configuration only when the user asks.

After pulling or otherwise updating that checkout, rerun
`pnpm install --frozen-lockfile` and `pnpm install:source-cli`. This refreshes the
build verification, Chromium installation, and pinned wrapper target.

For an unreleased source CLI, install `skills/preflight-scout/` directly from
this same checkout into the client's skills directory. Do not pair it with the
`plugin-stable` marketplace channel, which remains on the previous published
release until npm, live-install, and GitHub release verification all pass.

Do not clone a private repository unless the user confirms that the current environment has access. If no accessible source checkout exists, explain that full execution is blocked and continue in checklist-only mode using the supplied diff and Preflight Scout artifacts.

The installer runs the normal Chromium install. Use
`preflight-scout install-browser --with-deps` only on a supported Linux host where
installing operating-system browser dependencies is intended, and then repeat
`preflight-scout doctor`.
