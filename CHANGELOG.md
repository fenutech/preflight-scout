# Changelog

All notable changes to Preflight Scout are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Replaced PEM private-key redaction's cross-document regular expression with
  a forward-only, fail-closed boundary scanner, including truncated,
  mismatched, and nested key blocks.
- Bound reused analysis directories to the repository identity, indexed
  context, exact base and head commits, QA contract, artifact schema, and
  exact Preflight Scout-owned core plus CLI or Action package code/build that
  produced them. Browser results separately record the exact Preflight
  Scout-owned orchestrator plus browser-runner package code/build. Packaged
  entrypoints verify their metadata and declared outputs before accepting those
  identities; this is not an attestation of third-party dependencies, Node.js,
  the operating system, or the browser build.
  Missing, foreign, stale, modified, or post-build-patched artifacts now require
  a fresh reviewed analysis before browser or delegated execution.

### Changed

- Described the built-in repository index as a bounded inventory rather than a
  detected route/framework/component map, and marked empty reserved
  classification fields as unclassified instead of absent.

### Fixed

- Made explicit local and staging target selection fail closed when the selected
  environment has no configured URL, instead of falling through to another
  environment. `init --url` now follows the effective generated target and
  environment, and the GitHub Action keeps its explicit `app-url` input
  separate from the generic auto-mode URL environment variable.
- Added deterministic repository-inventory coverage metadata so analyses at
  the file limit remain distinguishable from silently truncated inventories,
  and carry incomplete coverage into model context and final report unknowns.
- Made each analysis manifest declare the current browser results and evidence,
  so files left by an older generation cannot change a new report or promoted
  test.
- Bound the Markdown, HTML, and JSON report outputs into the same manifest and
  made the GitHub Action upload a private, re-hashed staging copy of only the
  declared generation rather than mutable checkout files.
- Stored browser-result and evidence references as portable run-relative paths,
  so artifacts neither expose checkout paths nor break after a reviewed bundle
  is moved.
- Serialized same-directory artifact generations with an exclusive lock, and
  constrained cleanup and reads to the trusted repository boundary so a
  symlinked run-directory ancestor cannot redirect them outside the checkout.
- Isolated browser output in a unique evidence directory per invocation and
  made same-directory replacement revalidate the complete declared bundle, so
  concurrent commands or post-review evidence changes cannot be silently
  blessed by a new manifest.
- Rendered optional PDFs to a unique temporary path, publish them only after a
  lock-held bundle check, and record their digest through manifest-last
  publication, preventing an obsolete, stale, or modified PDF from being
  accepted as the current report.
- Preserved explicit external artifact directories through a separate canonical
  trust boundary, including the standard macOS `/tmp` filesystem alias.
- Required explicit repository-local CLI and GitHub Action artifact directories
  to be excluded by Git as directories, so contents-only ignore rules cannot
  re-include generated reports and invalidate the reviewed repository context.
- Bound `replay` to the reviewed analysis manifest instead of accepting a loose
  mission file.
- Isolated internal QA contract defaults from mutations of the public
  `DEFAULT_CONTRACT` compatibility object, and returned fresh deep copies for
  config-free and partial-config loads.
- Terminated delegated-agent and local-agent descendant processes on Windows
  after timeouts or output-limit violations by invoking the OS-owned
  `System32\taskkill.exe` by absolute path, with bounded cleanup and no
  taskkill output in diagnostics. POSIX process-group signaling is unchanged.

## [0.1.4] - 2026-07-17

### Fixed

- Kept automated release preparation within the GitHub Actions token boundary
  by requiring an explicit Release Candidate version instead of rewriting a
  workflow-file default on every release.

- Bound live browser assertion decisions to the exact target and expected text
  from the reviewed mission, so an LLM-supplied locator cannot weaken the
  assertion or incorrectly block execution when the reviewed assertion is
  valid.

## [0.1.3] - 2026-07-17

Publication of `v0.1.2` stopped before the first npm write because the
registry setup injected a placeholder `NODE_AUTH_TOKEN` into the token-free
trusted-publishing job. No package, GitHub release, or stable plugin channel
was changed; the protected tag remains as an audit record.

### Fixed

- Kept the npm publication job strictly OIDC-only by avoiding registry setup
  that injects a token placeholder. The pinned npm bootstrap and verified
  publisher both select the public registry explicitly.

## [0.1.2] - 2026-07-17

Publication stopped before the first npm write. This ruleset-gate fix therefore
ships in `0.1.3`; the protected `v0.1.2` tag remains as an audit record.

### Fixed

- Kept the admin-only no-bypass ruleset assertion in the maintainer pre-tag
  gate while allowing the least-privilege GitHub Actions token to validate the
  complete visible `plugin-stable` ruleset shape without misreading GitHub's
  omitted `bypass_actors` field as a configured bypass.

## [0.1.1] - 2026-07-17

Publication stopped at the live repository gate before any artifact, npm
package, or GitHub release was created. These changes ultimately ship in
`0.1.3`; the protected `v0.1.1` tag remains as an audit record.

### Added

- Added a read-only `update-check` command that compares the installed CLI,
  Agent Skill, and npm's official release without changing the machine or
  sending repository data.
- Added one protected-tag release path that validates and publishes through
  GitHub OIDC, verifies all six npm `latest` tags and clean Linux/Windows
  installs, creates the matching latest GitHub release, then advances a
  protected `plugin-stable` channel for Codex and Claude Code.
- Added a deterministic release-preparation workflow that creates a tested
  lockstep version branch and ready-PR link without merging, tagging, or
  publishing.
- Enabled immutable GitHub releases for future tags and added the setting to
  the live publication gate.

### Changed

- Removed the one-time `0.1.0` npm recovery workflow after all packages and
  public installation checks passed.
- Made the live publication gate wait for all six package versions before the
  clean CLI installation check.
- Made the public GitHub repository the only active source for code, packages,
  releases, documentation, and the website.

### Fixed

- Kept LLM-generated init contracts on the guarded
  `.preflight-scout/runs/latest` artifact path unless a human supplies an
  explicit init path, and made both `analyze` and unreviewed `run` planning
  reject unsafe legacy paths before starting either model call.

## [0.1.0] - 2026-07-16

Initial public alpha release.

### Added

- Repository indexing, diff analysis, impact mapping, and risk-ranked
  QA mission planning.
- Safe browser missions with explicit approval boundaries, authenticated-session
  bootstrap, screenshots, Playwright traces, console errors, network errors, and
  final observations.
- Human-facing Markdown, HTML, and optional PDF reports alongside a structured
  JSON summary for CI and agent handoffs.
- Local CLI workflows for initialization, diagnostics, analysis, browser runs,
  replay, reporting, regression-test promotion, and generic demo repositories.
- Reviewable two-step execution: both `run` and `agent-run` can reuse the exact
  validated impact map and mission through `--analysis-dir` without replanning.
- OpenAI, Anthropic, Gemini, OpenAI-compatible, Codex CLI, Claude Code, Gemini
  CLI, MCP, and custom agent execution paths.
- GitHub Action integration for PR comments, status gates, and evidence artifact
  uploads.
- A validated, portable Agent Skill and repository plugin manifests for Codex
  and Claude Code, plus deterministic upload archives for supported web surfaces.
- AGPL-3.0-only source licensing, a commercial-license path, contributor terms,
  and an explicit MIT boundary for generated-output templates created by Preflight Scout.
- A security policy, focused contribution templates, release notes, and a
  maintainer release checklist.
- Reproducible CI and browser gates, immutable Action pins, dependency updates,
  path-based labeling, and a non-publishing release-candidate workflow.
- A manual-only, tag-bound npm publication workflow that separates unprivileged
  validation from environment-approved publication, verifies exact tarball
  checksums and registry integrity, supports a one-time protected bootstrap
  token, and then requires package-specific npm trusted publishing.
- An illustrative, deterministic report fixture showing the shape of a release
  blocker without claiming a live LLM or browser run.
- A durable source-checkout CLI installer that builds and verifies the runtime,
  installs Chromium, pins the absolute Node and built-CLI paths, preserves a
  conflicting command on forced replacement, and exposes `preflight-scout` across
  fresh shells and agent tasks.
- A pinned npm-first installation path for released CLI users, with explicit
  Chromium setup and isolated global-install smoke coverage for the five runtime
  packages while pnpm remains the source workspace manager.
- Deterministic package build-integrity stamps and pack-time verification that
  reject missing or stale distribution output before publication.
- A bounded delegated-agent doctor probe with progress heartbeats, redacted
  timeout diagnostics, and an explicit boundary between runtime readiness and
  actual browser QA.
- A static, crawlable Preflight Scout website with install, example-report, and
  security routes, canonical metadata, sitemap and robots files, structured
  homepage data, exact Codex and Claude Code paths, and a release-console
  interface matching the report.
- A committed `wrangler.json` for the same-repository Cloudflare Pages static
  export, with native Git deployment and no Cloudflare credential in GitHub.
- A closed SEO gate for unique titles, descriptions, canonicals, headings,
  social metadata, sitemap membership, noindex report artifacts, local links,
  and home-only site-name markup, plus a 1200x630 product social image.
- A byte-for-byte fixture guard proving that the public sample HTML and Markdown
  come from the same renderer used by real CLI runs.
- A dark flight-instrument HTML/PDF report system and matching portable
  Markdown hierarchy, with lime pass signals, red release blockers, and the
  complete human-review evidence packet retained.

### Fixed

- Corrected exact-version npm registry negotiation and moved all six integrity
  checks ahead of publication, so a mismatch fails before any new tarball is
  published and a matching partial release can resume safely.
- Kept report metadata, totals, and footer text inside proportional desktop and
  mobile frame safe areas, including wrapped repository and branch labels.
- Removed the unused Next.js client runtime from the pure static website export
  while retaining working mobile navigation and command-copy controls through a
  small progressive-enhancement script.
- Prevented browser-extension attributes added to the document root from
  triggering a false hydration warning in the local development preview.

- Required the OS-owned Windows `tar.exe` for packed-package verification and
  normalized its CRLF listings, so Git Bash cannot reinterpret native
  drive-letter paths as remote archives.
- Accepted Node's unavailable zero device ID for Windows path stats while still
  requiring a nonzero matching file ID and stable size, link, timestamp, and
  trusted-boundary checks around every npm-smoke input.

### Security

- Added static Pages response headers for a restrictive content-security
  policy, denied framing and unused browser capabilities, and explicit
  noindex coverage for Pages aliases and raw report artifacts.
- Documented the approval-gated Cloudflare domain setup and the complete npm
  handoff from one-time bootstrap token to six verified trusted publishers,
  token removal, and OIDC-only releases.
- Kept credentials behind environment-variable references and storage-state
  boundaries instead of embedding secret values in mission prompts.
- Added output redaction, action allow/approval/forbid controls, and guidance for
  private vulnerability disclosure.
- Validated mission approval gates against exact contract action labels before
  browser launch, normalize human-readable browser targets against those labels,
  expose only current approved labels to the live agent, and fail closed on
  malformed or unapproved gates.
- Limited workflow permissions, kept opt-in LLM self-checks on trusted Action
  code, and blocked forked or untrusted PRs from consuming provider secrets.
- Restricted repository indexing to tracked or intentionally unignored files,
  excluded credential and generated artifacts before the file cap, removed the
  absolute local root from model context, and applied the same redaction to
  first-run contract generation.
- Made advisory repository indexing omit oversized manifest contents instead
  of aborting the run, while retaining strict size rejection for structured
  configuration, approval, mission, and evidence artifacts.
- Confined Preflight Scout's built-in browser missions to one exact HTTP(S) origin across
  direct navigation, clicks, forms, key submissions, redirects, and popups;
  unsafe evidence and authenticated state are discarded or invalidated, while
  cross-origin SSO remains a manual flow.
- Retried the observed transient Chromium screenshot protocol failure at most
  once, deleting partial evidence and rechecking the same-origin boundary
  immediately before the retry; all other capture failures still fail closed.
- Required dedicated
  `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)` browser credentials,
  exposed only the selected role to browser and delegated-agent execution, and
  rejected provider or infrastructure mappings from malicious contracts.
- Gave built-in delegated agents kind-specific minimal environments, made
  custom-agent inheritance minimal by default, redacted successful subprocess
  output, bounded capture, and terminated timed-out process groups.
- Required repository-local `.env.preflight-scout.local` files to be ignored and
  untracked. Privileged provider/model/base/exec, proxy/TLS, Node/runtime, Git,
  and agent controls require the parent-only
  `PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1` opt-in and cannot override parent values.
- Isolated default built-in local-agent planning from the target checkout and
  tools, while preserving explicit command/argument overrides and delegated
  browser agents as clearly documented trusted execution paths.

### Known limitations

- LLM and browser results require human review; a passing report is not a proof
  of correctness or security.
- Browser access, local repository access, provider credentials, and compatible
  agent tooling depend on the runtime in which Preflight Scout is installed.
- Package names, repository settings, security-advisory intake, and marketplace
  acceptance are external release gates and require independent verification.
