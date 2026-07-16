# Maintainer release checklist

This checklist prepares and validates a release candidate. Completing it does
not authorize a tag, package publication, GitHub release, or marketplace
submission.

## Candidate

- [ ] Choose the exact version and commit; confirm the tree is clean.
- [ ] Align package versions, CLI output, Action metadata, skill metadata, and
      the matching `CHANGELOG.md` section.
- [ ] Confirm supported Node.js, pnpm, Codex, and Claude Code versions.
- [ ] Before the first npm release, confirm the maintainer controls the npm
      `@preflight-scout` scope and can publish all six package names; reserve or
      rename the scope before advertising registry installation. This is a hard
      gate, not a post-publication cleanup item.

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
- [ ] Enable and test GitHub private vulnerability reporting before announcing
      the release or publishing packages.

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
- [ ] Install the repository plugin in current Codex and Claude Code clients.
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
- [ ] Treat the clean public bootstrap as one coordinated, unannounced launch
      window: create the public repository with its final canonical URLs, build
      and inspect the noindexed Pages alias, publish and verify the exact npm
      release, then connect `preflightscout.com` before announcing the project.
- [ ] Keep `apps/site` in the same public monorepo. Confirm the root
      `wrangler.json` names `preflight-scout`, exports `apps/site/out`, pins its
      compatibility date, disables Wrangler telemetry, and contains no secret.
- [ ] Use Cloudflare Pages' native Git connection to
      `fenutech/preflight-scout`. Do not add AWS CDK, Terraform, OpenTofu,
      Direct Upload, or a Cloudflare API token to the repository or GitHub
      Actions.
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
VERSION="0.1.0" # replace with the exact <version> being validated
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
pnpm test:public-export
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
- [ ] Ask a second reviewer to verify installation, security boundaries, and
      the sample report.

## Authorized publication only

Stop here unless the maintainer explicitly authorizes each external action.

### Connect Cloudflare Pages

- [ ] After the clean public repository exists, explicitly authorize the
      one-time Pages setup before connecting any GitHub or Cloudflare account.
- [ ] Connect the native Cloudflare Pages Git integration only to
      `fenutech/preflight-scout`, use protected `main`, and reproduce the
      reviewed root, Node, build-command, and output-directory settings from the
      private runbook.
- [ ] Inspect the noindexed `pages.dev` deployment before adding a product
      domain. A green Pages build does not authorize npm publication or public
      announcement.
- [ ] Only after the exact npm release and external install smoke pass, add and
      validate `preflightscout.com`, then add `www.preflightscout.com` and a
      permanent Single Redirect that preserves the request path and query
      string while sending `www` to the apex.
- [ ] Confirm active HTTPS, HTTP-to-HTTPS, `www`-to-apex, trailing-slash, and
      noindex behavior from an external browser. Confirm GitHub contains no
      Cloudflare API token.

### Release from the public repository

- [ ] Use a reviewed commit already in the repository's normal history.
- [ ] Configure the repository's `npm-production` environment before
      running the workflow. Require at least one reviewer, restrict selected
      deployment tags to the exact `v*` pattern, and do not rely on the
      unprotected environment GitHub would create automatically.
- [ ] Add an active repository tag ruleset for `v*`, then create the protected
      `v<version>` tag at a commit contained in `main`.
- [ ] For the first publication only, create or confirm the npm
      `preflight-scout` organization, enable account-level 2FA, and create a
      short-lived granular token with **Read and write** under **Packages and
      scopes** for `@preflight-scout` plus **Bypass 2FA**. Organization access
      alone is not enough. Store the token as the `NPM_TOKEN` secret only on
      `npm-production`, dispatch
      `.github/workflows/publish.yml` in `bootstrap-token` mode on that tag, and
      review the exact typed confirmation. Do not publish locally: local
      publication cannot satisfy this repository's provenance requirement.
- [ ] After the first publication, configure each of the six package-specific
      npm trusted publishers for `fenutech/preflight-scout`, workflow `publish.yml`,
      environment `npm-production`, with `npm publish` allowed. Use the package
      settings or `npm trust github <package> --repo fenutech/preflight-scout
      --file publish.yml --env npm-production --allow-publish`, then verify each
      relationship with `npm trust list <package>`.
- [ ] After all six trusted publishers are verified, set each package's
      **Publishing access** to **Require two-factor authentication and disallow
      tokens**, delete the `NPM_TOKEN` environment secret, and revoke the
      one-time bootstrap token. Do not retain either as a fallback.
- [ ] For every later version, dispatch the same workflow in
      `trusted-publishing` mode. That mode must have no `NODE_AUTH_TOKEN` and
      authenticates only through GitHub OIDC.
- [ ] Create the GitHub release or submit marketplace entries only when those
      separate external actions were explicitly approved.
- [ ] Verify every public install path from a clean external account.
- [ ] Monitor install failures and security reports; issue a new corrected
      version rather than rewriting a published tag.
