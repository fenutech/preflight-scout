# Maintainer guide

## Source of truth

[`fenutech/preflight-scout`](https://github.com/fenutech/preflight-scout) is the
only active source repository for Preflight Scout. Start every code change,
documentation change, release, and package build from this repository and send
it through a public pull request.

`fenutech/preflight-scout-internal` is for private operational notes. It must
never mirror source code, patches, release artifacts, or package contents.
The former private staging repository is a read-only historical archive, not a
source for new branches, fixes, or releases.

## Repository policy

- `main` is the only default branch.
- Changes should arrive through focused branches and squash-merged pull
  requests.
- Do not merge a pull request until required checks are green, review threads
  are resolved, and the automated or assigned reviewer gives a clear positive
  signal. A GitHub approval, a thumbs-up, or an explicit no-blocker comment
  counts. Silence or an absent review does not.
- `Required` is the stable required-check candidate produced by the `CI`
  workflow. Matrix jobs, label automation, and opt-in self-checks should not
  be configured as required individually.
- Delete merged branches automatically and keep merge commits and rebase merges
  disabled.
- Keep Actions permissions read-only by default. Grant write scopes only in the
  workflow that needs them.
- Pin every external Action to a full commit SHA; Dependabot maintains those
  references.
- Keep repository release immutability enabled. Future published releases lock
  their tag and assets and receive a GitHub release attestation.
- Keep the exact `plugin-stable` ruleset active with no bypass actors. It blocks
  deletion and non-fast-forward updates, requires linear history, and requires
  the GitHub Actions `Required` check. It is a release channel, not a
  development branch: only `publish.yml` may fast-forward it after npm and
  GitHub release verification.

The active default-branch rules:

1. block branch deletion and non-fast-forward pushes;
2. require a pull request with squash as the only merge method;
3. require review-thread resolution; a native approval count may remain zero
   when the automated reviewer cannot submit formal approvals, but the positive
   reviewer-signal rule above still applies;
4. require a current branch and the `Required` status check;
5. require linear history; and
6. allow the repository owner to bypass only through a pull request, so an
   emergency override remains visible.

Keep the rules active and verify them after repository ownership, plan, or
workflow changes. Do not weaken them to work around a failing check or missing
review signal.

## Automation map

- `CI`: Node 22/24 build, typecheck, unit and browser tests, package health,
  dependency audit, tarball installation, and Agent Skill packaging.
- `Browser Tests (manual)`: on-demand reproduction of the browser suite.
- `Pull Request Labeler`: path-based area labels using trusted default-branch
  configuration.
- `Preflight Scout Self-check`: opt-in `pull_request_target` analysis. It reads the PR
  head but executes only trusted default-branch Action code, and accepts only
  same-repository PRs from trusted associations. It runs only when the
  repository variable and provider secret are both configured.
- `Release Candidate`: a manual, non-publishing validation workflow that checks
  versions, runs the full suite, produces checksummed candidate artifacts, and
  exercises npm's dry-run path.
- `Prepare release branch`: a maintainer supplies the next stable SemVer.
  The workflow updates every lockstep version surface, promotes the changelog,
  creates `codex/release-vX.Y.Z`, dispatches `CI` for its commit, and returns a
  compare link for the maintainer to open the ready pull request. It cannot
  create or approve a pull request, merge, tag, publish, or create a release.
- `Publish npm packages`: a protected stable `vX.Y.Z` tag starts validation
  automatically.
  Before the protected environment can be approved, it rejects a tag that is
  behind `plugin-stable`, npm `latest`, or the latest GitHub release, and it
  requires the exact successful `Required` check on the tagged commit. Its
  environment-gated job publishes all six packages through package-specific npm
  trusted publishers, verifies the public `latest` tag and clean installs on
  Linux and Windows, creates and verifies the matching immutable latest GitHub
  release, then fast-forwards `plugin-stable` to that exact commit.

The repository's immutable-release setting uses an administration-read API that
the normal GitHub Actions token cannot access. GitHub also omits a ruleset's
`bypass_actors` field from the metadata-only response available to that token.
Do not add a PAT to work around either boundary. Immediately before creating a
release tag, run the full gate from an admin-authenticated maintainer shell
without printing the token:

```bash
GITHUB_REPOSITORY=fenutech/preflight-scout \
GITHUB_TOKEN="$(gh auth token)" \
node scripts/verify-publication-gates.mjs
```

The `--github-actions-token` mode defers only the two unavailable admin fields.
It still verifies the visible branch rules exactly and rejects any bypass list
that GitHub does return. The environment reviewer confirms the admin gate before
approving publication, and the release job verifies the actual release's
`immutable` field before advancing `plugin-stable`.

The version choice, release-PR merge, protected tag, production-environment
approval, and any external marketplace submission remain explicit maintainer
decisions. The preparation and release-candidate workflows cannot publish.
Publish only from a reviewed public tag through the protected workflow in the
[release checklist](release-checklist.md).

## Website and agent discovery

The website is the static Next.js export in `apps/site/out`. Cloudflare Pages
builds it through the native Git connection to the public repository: pull
requests receive previews, and protected `main` supplies production. Keep the
credential-free root `wrangler.json`; do not replace this path with Direct
Upload, a repository token, or an extra deployment workflow. A website-only
change does not require an npm or plugin release.

The homepage and footer expose [the agent index](https://preflightscout.com/llms.txt).
The primary action on the homepage and install page copies an agent setup
request pointing to [the setup instructions](https://preflightscout.com/agent-setup/prompt.md).
The button provides visible copy feedback and a selectable prompt if both
clipboard methods fail. `docs/agent-setup-prompt.md` is the setup template;
the build replaces its release token from `apps/site/package.json`. Never
hardcode a separate installation version in the component or generated file.
Its short list leads to [the plain Markdown guide](https://preflightscout.com/agent-guide.md),
installation, the released skill, and focused references. The index is a
discovery aid; it does not promise automatic crawler or agent support.
`docs/agent-guide.md` is the only guide source. `sync-site-assets.mjs` copies
it into the ignored public build input alongside the canonical sample report
and rendered setup guide before both development and production builds. Edit the source guide, not its
generated copy. Keep the index below 4 KiB and the guide below 16 KiB so agents
can load onboarding without a large context cost. Link to detailed references
instead of embedding their full content.
Keep setup instructions below 16 KiB, limited to idempotent installation and
verification. They must distinguish local setup from later authorized QA.

Build with `pnpm --filter @preflight-scout/site build`, then run
`pnpm check:site`. After Chromium is installed, run `pnpm test:site:browser`
for the maintained onboarding, copy fallback, desktop/mobile, and text-route
smoke. It serves the export on an ephemeral loopback port and captures copy
requests inside an isolated browser context without replacing the operator's
system clipboard. The static verifier checks source/export parity, context budgets,
local and source-document link targets, static discovery links, response-type
headers, SEO, and the existing security boundaries. Inspect desktop and mobile
routes and copy controls in a real browser. For an authorized deployment,
inspect the PR preview, follow the normal reviewed-PR merge rules, and verify
the production commit, routes, guides, and edge headers. See the
[release checklist](release-checklist.md) for the complete publication gates.

Keep `Cache-Control: no-transform` on the public site. Cloudflare email
obfuscation can mistake scoped npm names for email addresses and replace
`@preflight-scout/cli@VERSION` with an unreadable link in raw HTML. A browser
may decode that link; a coding agent fetching instructions must not need to.
[Cloudflare documents this header as an obfuscation opt-out](https://developers.cloudflare.com/waf/tools/scrape-shield/email-address-obfuscation/).
The global `_headers` rule retains normal `public, max-age=0, must-revalidate`
caching. The fingerprinted `/_next/static/*` rule detaches that value before
setting its existing immutable lifetime plus `no-transform`, because
[matching Pages header rules otherwise combine values](https://developers.cloudflare.com/pages/configuration/headers/).
Do not enable a decode script or add Cloudflare credentials to work around it.

After building the exact reviewed website revision, verify each deployed
preview with `node apps/site/scripts/check-production.mjs https://DEPLOYMENT.pages.dev`.
After the authorized merge, run `node apps/site/scripts/check-production.mjs`
against the canonical production origin. This read-only HTTP check compares
visible npm commands, every copy value, the manual prompt, and all three agent
text endpoints against the export without executing JavaScript. It rejects
email-obfuscation markup or scripts, wrong MIME types, missing `no-transform`,
changed cache lifetimes, and stale fingerprinted CSS. It requires no tokens.
Run it against the custom domain as well as the preview: zone transformations
can differ. Keep browser QA for the interactive copy flow; raw HTTP and browser
checks cover different failure modes. Deployment is not verified until both
pass on the intended commit.

## Labels

Use `bug`, `enhancement`, `documentation`, `security`, `dependencies`,
`breaking`, `skip-changelog`, and `needs-triage` for release and triage state.
Area labels are applied automatically for core, CLI, browser, GitHub Action,
MCP, agent execution, and Agent Skill paths.

Security reports never belong in a public issue. Follow `SECURITY.md` and keep
credentials, storage state, customer data, non-public source code, and exploit
details out of Actions artifacts and issue comments.
