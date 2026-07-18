# Maintainer release checklist

This checklist prepares and validates a release from the canonical public
repository, [`fenutech/preflight-scout`](https://github.com/fenutech/preflight-scout).
Completing it does not authorize a merge, tag, package publication, GitHub
release, or marketplace submission.

## Candidate

- [ ] Choose the next stable `X.Y.Z` version. Run `Prepare release branch` from
      `main` with that exact version, then use its compare link to open the ready
      pull request. Do not hand-edit a partial bump.
- [ ] Confirm the release commit arrived through a pull request with green
      required checks, resolved review threads, and a clear positive signal
      from the automated or assigned reviewer. An approval, thumbs-up, or
      explicit no-blocker comment counts; silence does not.
- [ ] Review the prepared diff and confirm it aligns all six package versions,
      CLI/MCP output, Codex and Claude plugin metadata, the skill's exact CLI
      compatibility check, website and documentation pins, and the promoted
      `CHANGELOG.md` section.
- [ ] Confirm supported Node.js, pnpm, Codex, and Claude Code versions.
- [ ] Confirm the maintainer still controls the npm `@preflight-scout` scope,
      all published package names, and each package's trusted-publisher
      configuration.

## Legal, security, and privacy

- [ ] Confirm `AGPL-3.0-only` metadata and review `LICENSE`, `NOTICE`,
      `COMMERCIAL-LICENSE.md`, `CONTRIBUTING.md`, and `OUTPUT-LICENSE.md`.
- [ ] Confirm every external contribution has the separately signed agreement
      required by `CONTRIBUTING.md`.
- [ ] Review the production dependency-license inventory and resolve unknown or
      incompatible licenses.
- [ ] Scan the candidate tree and packaged artifacts for credentials, cookies,
      personal data, private hostnames, local paths, and customer source.
- [ ] Review prompt-injection boundaries, shell execution, path containment,
      redaction, approval gates, and workflow permissions.
- [ ] Confirm GitHub private vulnerability reporting remains enabled and test
      the reporting path when repository security settings change.

## Documentation and installation

- [ ] Confirm public user and agent instructions recommend an exact, pinned npm
      CLI version only when the matching official release and live registry
      entry both exist. Do not advertise `latest` or treat source metadata as
      publication evidence.
- [ ] Install the packed CLI globally with npm in a clean temporary prefix, run
      the installed command, install Chromium explicitly, and exercise the
      browser-aware smoke path. Do not use pnpm for this consumer check.
- [ ] Follow the source install from a clean, stable checkout using
      `pnpm install:source-cli -- --bin-dir <temporary-bin>`.
- [ ] Confirm the installed wrapper pins the intended absolute Node executable
      and built CLI paths. Update the source, rerun the installer, and confirm
      the refreshed command still works.
- [ ] Start a fresh shell and agent task/session, then confirm the installed
      `preflight-scout --version` and Chromium-aware `preflight-scout doctor` path work
      without a shell function or direct `node .../dist/index.js` command.
- [ ] Confirm the required Windows source-wrapper jobs in CI and the manual
      Release Candidate workflow execute the generated `.cmd` wrapper
      successfully.
- [ ] Install the repository plugin from `plugin-stable` in current Codex and
      Claude Code clients. Confirm the branch still points to the previously
      published release while the new candidate is under review.
- [ ] In a clean profile without a direct skill copy, invoke
      `$preflight-scout:preflight-scout` in Codex and
      `/preflight-scout:preflight-scout` in Claude Code. Do not use
      `--ignore-user-config` for the Codex plugin smoke test.
- [ ] Validate and inspect `dist/preflight-scout-skill.zip`; test supported web
      uploads and their local-access limitations.
- [ ] Verify model names, client instructions, internal links, and external
      documentation links against current official sources.
- [ ] Confirm the GitHub Action documentation names a real released commit SHA,
      not a placeholder or an unpublished tag.
- [ ] Confirm every code, documentation, package, and website change comes from
      `fenutech/preflight-scout`. Do not release from
      `fenutech/preflight-scout-internal` or the archived historical staging
      repository.
- [ ] Keep `apps/site` in the same public monorepo. Confirm the root
      `wrangler.json` names `preflight-scout`, exports `apps/site/out`, pins its
      compatibility date, disables Wrangler telemetry, and contains no secret.
- [ ] Confirm Cloudflare Pages' native Git connection still points to
      `fenutech/preflight-scout` and protected `main`. Do not add AWS CDK,
      Terraform, OpenTofu, Direct Upload, or a Cloudflare API token to the
      repository or GitHub Actions.
- [ ] Build `apps/site` as a static export, run `pnpm check:site`, inspect the
      desktop and mobile routes in a real browser, and verify the live domain
      serves the same reviewed output without console errors or missing assets.
- [ ] Confirm all four canonical pages score cleanly for titles, descriptions,
      headings, social metadata, internal links, sitemap membership, and
      home-only site-name markup; confirm the sample report and Pages aliases
      return `noindex` without being blocked in `robots.txt`.
- [ ] Verify HTTP-to-HTTPS, `www`-to-apex, and trailing-slash redirects before
      submitting the sitemap to Google Search Console and Bing Webmaster Tools.
- [ ] After registry publication, confirm
      `npm view @preflight-scout/cli@<version> version`, install that exact
      version globally with npm, run `preflight-scout install-browser`, and
      repeat the fresh-shell and fresh-agent checks. Registry publication is
      not proven by a successful tarball smoke.

## Automated verification

Run from a clean checkout:

```bash
corepack enable
pnpm install --frozen-lockfile
VERSION="0.1.6" # replace with the exact <version> being validated
pnpm check:release-version -- "$VERSION"
pnpm build
pnpm check:site
pnpm typecheck
pnpm test:ci
pnpm playwright:install
pnpm test:browser
pnpm audit --prod --audit-level high
pnpm check:repo
pnpm check:package-assets
pnpm test:package-guard
pnpm test:source-cli-wrapper
pnpm test:repo-boundary
pnpm test:publication
pnpm pack:check
pnpm test:npm-global-smoke
PREFLIGHT_SCOUT_NPM_SMOKE_INSTALL_BROWSER=1 pnpm smoke:npm-global
PREFLIGHT_SCOUT_SMOKE_INSTALL_BROWSER=1 pnpm smoke:install
pnpm test:skill
pnpm package:skill
pnpm -r --filter './packages/*' publish --access public --dry-run --no-git-checks
```

- [ ] Inspect package tarballs for the expected README, license, notice,
      executable, runtime files, build-integrity stamp, registry metadata, and
      converted (non-`workspace:`) internal dependency ranges.
- [ ] Prove a package refuses `pack` and `publish --dry-run` when `dist` is
      missing or stale, then rebuild before continuing.
- [ ] Install the packed CLI in an empty project and exercise `--help`,
      `doctor`, the generic demo, and report generation.
- [ ] Run the generic demo through the installed skill, review its analysis,
      execute with `--analysis-dir`, and confirm the reviewed impact-map and
      mission hashes remain unchanged.
- [ ] Confirm missing, foreign-repository, commit-stale, contract-stale,
      mission-tampered, result-tampered, and evidence-tampered analysis
      directories fail before model or browser execution.
- [ ] Reuse one output directory for a fresh analysis and confirm browser
      results left by the prior generation cannot affect the new report or
      regression promotion.
- [ ] Review one synthetic or explicitly approved report covering passing,
      failed, blocked, and no-browser-evidence outcomes.
- [ ] Test authenticated storage-state save, reuse, rejection, and redaction
      with disposable credentials only.
- [ ] Test dedicated `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)`
      credential names, exact selected-role forwarding, rejection of provider
      or infrastructure mappings, and repository-local env-file trust controls.
- [ ] Test same-origin HTTP(S) browser blocking for unsafe schemes, off-origin
      interactions/redirects, and popups; confirm unsafe evidence and storage
      state are not retained. Review cross-origin SSO manually.

## Candidate artifacts

- [ ] Run the non-publishing `Release Candidate` workflow for the exact version.
- [ ] Record checksums for package tarballs and the Agent Skill archive.
- [ ] Review release notes, known limitations, upgrade notes, and license
      boundaries.
- [ ] Ask the assigned reviewer to verify installation, security boundaries,
      and the sample report, and wait for a clear positive signal before
      merging the release pull request.

## Authorized publication only

Stop here unless the maintainer explicitly authorizes each external action.

### Verify the website deployment

- [ ] When the release changes `apps/site`, inspect the Cloudflare preview
      deployment from the release pull request before merging it.
- [ ] After merge, confirm the production deployment came from the expected
      public `main` commit. A green Pages build does not authorize npm
      publication or a public announcement.
- [ ] Confirm `preflightscout.com` and `www.preflightscout.com` use active HTTPS,
      `www` redirects permanently to the apex while preserving the path and
      query string, and canonical/trailing-slash behavior is unchanged.
- [ ] Confirm the `pages.dev` alias remains noindexed and GitHub contains no
      Cloudflare API token.

### Release from the public repository

- [ ] Use a reviewed commit already in the public repository's normal history.
- [ ] Confirm the active `npm-production` environment still requires its
      reviewer and restricts deployment tags to the exact `v*` pattern.
- [ ] Confirm repository release immutability is enabled. It applies to future
      releases only; do not treat the older mutable `v0.1.0` release as a
      template for new releases.
- [ ] From an admin-authenticated maintainer shell, run the full
      `scripts/verify-publication-gates.mjs` command in the maintainer guide and
      retain its success output. The least-privilege Actions token cannot prove
      the immutable-release setting or an omitted ruleset bypass list.
- [ ] Confirm the active repository tag ruleset still protects `v*`, then
      create the exact stable tag `vX.Y.Z` at a commit contained in `main`.
      Prerelease or build-metadata tags are not supported. Pushing that tag is
      the only publication trigger.
- [ ] Confirm the exact `plugin-stable` ruleset has no bypass actors, blocks
      deletion and non-fast-forward updates, requires linear history and the
      GitHub Actions `Required` check, and still points to the prior published
      release.
- [ ] Verify each package-specific npm trusted publisher names
      `fenutech/preflight-scout`, workflow `publish.yml`, and environment
      `npm-production`. Confirm each relationship with
      `npm trust list <package>`.
- [ ] Confirm every package's publishing access requires two-factor
      authentication and disallows tokens. The `npm-production` environment
      must not contain `NPM_TOKEN`, and the publish job must not set
      `NODE_AUTH_TOKEN`.
- [ ] Let the tag-triggered `.github/workflows/publish.yml` validation finish,
      then approve its protected `npm-production` deployment. The workflow
      publishes only through package-specific trusted publishers and GitHub
      OIDC; do not publish locally.
- [ ] Confirm pre-publication validation accepted the exact successful
      `Required` check and rejected any version older than `plugin-stable`, an
      npm `latest` tag, or the latest GitHub release.
- [ ] Confirm the workflow verifies all six exact versions and each package's
      public `latest` tag, installs the exact CLI on Linux and Windows, and only
      then creates the matching latest GitHub release from the protected tag.
- [ ] Confirm the final release step fast-forwards `plugin-stable` to the exact
      tagged commit only after the GitHub API reports that release as immutable.
      It must never force-update or move backward.
- [ ] From an external clean environment, install that exact CLI version,
      install Chromium, and run the fresh-shell and fresh-agent checks again.
- [ ] Submit external marketplace entries only when that separate action was
      explicitly approved.
- [ ] Verify every public install path from a clean external account.
- [ ] Monitor install failures and security reports; issue a new corrected
      version rather than rewriting a published tag.
- [ ] If a protected release tag fails before publication, retain it as an
      audit record and prepare a new patch version. Never move or reuse it.
