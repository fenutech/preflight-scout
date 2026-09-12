# Candidate validation and publication

Before releasing package changes, build the reviewed candidate, install its
actual tarballs into a clean npm prefix, and run real agent-driven QA through
the installed CLI. Inspect the evidence, then complete the normal checks and
review before an authorized merge or stable publication. Repeat the relevant
verification when code or package contents change.

The gate uses existing package tooling. It requires no custom registry,
permanent test infrastructure, test package, or public candidate publication.
Official npm, GitHub releases, and `plugin-stable` stay unchanged during this
local validation. Passing it does not prove official registry publication,
npm trusted publishing/OIDC, or public provenance; the protected stable
workflow verifies those separately.

## Build and identify the candidate

Start from the exact reviewed commit and complete the checks in the
[release checklist](release-checklist.md), including:

```bash
pnpm build
pnpm pack:check
PREFLIGHT_SCOUT_NPM_SMOKE_INSTALL_BROWSER=1 pnpm smoke:npm-global
PREFLIGHT_SCOUT_SMOKE_INSTALL_BROWSER=1 pnpm smoke:install
```

`pack:check` validates all six archives in `.preflight-scout/package-check`.
The npm global smoke checks the five runtime packages and generated command
in an isolated prefix, then removes that prefix. The all-package clean-install
smoke uses a deterministic agent fixture. These checks protect packaging and
runtime behavior; they do not establish that a real LLM successfully used the
installed candidate.

Record the source commit, exact package version, and SHA-256 hashes of all six
archives before installation. Keep that record with the private QA evidence.
Do not reuse evidence from older archives merely because their version strings
match. An unreleased candidate may retain the current source version; its
commit and artifact hashes identify the candidate.

## Retain a clean npm installation for agent QA

The following POSIX-shell example creates a private temporary prefix and empty
npm configuration without changing the user's global installation or npmrc.
Run it from the reviewed repository after `pack:check` passes. Use a fresh
directory for each candidate; keep the installation until its evidence has
been reviewed.

```bash
export SCOUT_TARBALL_DIR="$(pwd -P)/.preflight-scout/package-check"
export SCOUT_CANDIDATE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/preflight-scout-candidate.XXXXXX")"
mkdir -p "$SCOUT_CANDIDATE_ROOT/prefix" "$SCOUT_CANDIDATE_ROOT/npm-cache"
touch "$SCOUT_CANDIDATE_ROOT/user.npmrc" "$SCOUT_CANDIDATE_ROOT/global.npmrc"
git rev-parse HEAD > "$SCOUT_CANDIDATE_ROOT/candidate-commit.txt"
shasum -a 256 "$SCOUT_TARBALL_DIR"/*.tgz > "$SCOUT_CANDIDATE_ROOT/tarballs.sha256"
(
  cd "$SCOUT_CANDIDATE_ROOT"
  npm --userconfig "$SCOUT_CANDIDATE_ROOT/user.npmrc" \
    --globalconfig "$SCOUT_CANDIDATE_ROOT/global.npmrc" \
    --cache "$SCOUT_CANDIDATE_ROOT/npm-cache" \
    --registry https://registry.npmjs.org/ \
    install --prefix "$SCOUT_CANDIDATE_ROOT/prefix" --ignore-scripts \
    --no-audit --no-fund "$SCOUT_TARBALL_DIR"/*.tgz
  npm --userconfig "$SCOUT_CANDIDATE_ROOT/user.npmrc" \
    --globalconfig "$SCOUT_CANDIDATE_ROOT/global.npmrc" \
    ls --prefix "$SCOUT_CANDIDATE_ROOT/prefix" --all --json \
    > "$SCOUT_CANDIDATE_ROOT/installed-packages.json"
)
export SCOUT_CLI="$SCOUT_CANDIDATE_ROOT/prefix/node_modules/.bin/preflight-scout"
export PLAYWRIGHT_BROWSERS_PATH="$SCOUT_CANDIDATE_ROOT/browsers"
"$SCOUT_CLI" --version
"$SCOUT_CLI" --help
"$SCOUT_CLI" install-browser
```

The registry option above downloads third-party dependencies; Scout itself
must come from the six reviewed archive arguments. Check the installed graph
and resolved package files: all `@preflight-scout/*` packages must match the
candidate and remain inside the private prefix, with no workspace/source
links or older public copies. Compare each Scout entry's lockfile integrity
with its tarball's SHA-512 integrity and retain the lockfile, installed build
identities, and archive hashes. Stop if the install or identity checks fail; do not continue using a
different command found on `PATH`.

On Windows, use an equivalent private npm prefix and invoke its generated
`preflight-scout.cmd`. Keep the supported Windows installation checks from the
release checklist. The POSIX example does not replace them.

## Run actual agent verification

Use the candidate's matching direct Agent Skill from the reviewed commit in
an isolated task/profile. Keep the ordinary stable plugin registration intact.
Ensure every Scout command resolves to the installed candidate, including
commands launched by the calling agent. A source wrapper, `pnpm preflight-scout`,
or direct repository `dist/index.js` invocation does not test this boundary.

Use the installed CLI to create a [generic demo](generic-demo.md), or select an
authorized disposable application. Serve the demo on loopback and confirm the
target contains the intended application revision. Review its contract and
test data. Then select a real authenticated provider deliberately; keep model
and provider controls in the trusted task environment and record the settings.
For example, when Codex is the intended authenticated provider:

```bash
export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec
"$SCOUT_CLI" doctor --base HEAD~1 --head HEAD --agent codex
"$SCOUT_CLI" analyze --base HEAD~1 --head HEAD \
  --output-dir .preflight-scout/runs/installed-candidate
```

Run these commands from the demo repository. For another application,
substitute its reviewed refs, target, and a unique run directory. Inspect the
generated mission before execution. The calling agent can review and run it
under standing task authorization; generated plans do not grant permission.
Then execute that exact analysis through the same installed binary:

```bash
"$SCOUT_CLI" run --base HEAD~1 --head HEAD \
  --analysis-dir .preflight-scout/runs/installed-candidate \
  --output-dir .preflight-scout/runs/installed-candidate --all-candidates
```

Inspect `report-summary.json`, mission results, screenshots, and relevant
console/network observations. Verify a meaningful passing journey and a
known-negative outcome, and cover the changed behavior relevant to the
candidate. An expected failing application fixture demonstrates correct
detection only when the observed failure matches the fixture; a Scout defect,
missing execution, or unexplained blocker remains unresolved. Do not infer
success from a zero exit code or remove assertions to get a passing label.

Record the candidate commit and archive hashes, installed package identities,
Node/npm/agent/model settings, application revision, analysis and mission
identities, tested outcomes, and evidence paths. Keep raw logs, auth state,
credentials, private source, and personal paths private. Public review evidence
should use sanitized synthetic outcomes. After fixes, rebuild and reinstall
changed candidate artifacts and repeat relevant verification; old evidence
does not validate new code.

## Follow the existing stable release path

Passing installed-agent QA is an input to the existing CI and assigned review
gates. It does not authorize publication. Follow the [maintainer guide](maintainer-guide.md)
and [release checklist](release-checklist.md) for protected main/PR rules,
exact stable tags, environment approval, OIDC publication, official registry
install checks, immutable GitHub releases, and `plugin-stable` advancement.
Verify the native Git website preview before merge and the intended production
deployment after the authorized merge.

A public npm prerelease under `--tag next` may be useful for warranted external
testing with explicit publication authorization and a separately reviewed,
supported publishing path. It is optional, not a requirement for normal PRs.
The current official workflow remains stable-only; this guide does not add a
local publication workaround or change stable channel behavior.
