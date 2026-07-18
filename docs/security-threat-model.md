# Security threat model

Preflight Scout runs on developer workstations and in CI. It can handle source code, pull-request diffs, browser screenshots, authenticated storage state, model-provider credentials, and commands delegated to local coding agents.

## Assets

- Provider API keys and authenticated local agent sessions.
- Test-user credentials named in `.preflight-scout/config.yml`.
- Playwright storage-state files under `.preflight-scout/auth/`.
- Screenshots, traces, console errors, network failures, and final observations.
- Repository and PR context sent to the configured model provider.

## Trust boundaries

- A repository under test can contain malicious text, scripts, dependencies, or agent instructions. Do not treat repository content as trusted merely because it is local.
- A tested webpage can attempt prompt injection through visible or hidden content.
- MCP servers and local coding agents are privileged code with filesystem, browser, or network access according to their configuration.
- Model providers receive the selected diff, repo, configuration, observations, and screenshots described in the report.
- Storage-state files and authenticated evidence are secrets even when the source repository is public.
- Repository-local environment files are repository-controlled input even when
  they are ignored by Git; parent-process environment values are the trusted
  control plane.

## Controls

- `preflight-scout doctor` checks configuration, provider readiness, credential-name
  presence, target reachability from the Preflight Scout process, Chromium launch,
  whether `.preflight-scout/auth/` is ignored, and whether a repository-local env file
  is ignored, untracked, and accepted by the env-control policy. Optional MCP
  and agent checks have the narrower scopes documented in `docs/doctor.md`.
- Repository indexing uses Git's tracked and untracked/non-ignored file sets
  when Git metadata is present. Credential, auth-state, generated-run, archive,
  cache, and build paths are excluded before the file cap even if force-tracked;
  unreadable Git metadata fails closed. The model receives a repo-relative,
  root- and secret-redacted copy rather than the raw index.
- Changed sensitive/generated files remain visible to impact analysis by path,
  status, and line counts, but their patch and file content are replaced before
  PR context is sent to the model.
- `run --analysis-dir`, `replay --mission`, `agent-run --analysis-dir`, report
  rebuilding, and regression promotion use a manifest written last for the current generation.
  Report rebuilding checks current core package/schema compatibility and the
  manifest's reviewed-artifact, declared-result, and evidence digests. Browser
  execution, delegated-agent execution, and promotion additionally compare the
  current repository identity, indexed context, exact commits, contract, and
  exact Preflight Scout analysis-entrypoint package code/build. Promotion also
  requires the same recorded Preflight Scout browser executor code/build.
  Packaged entrypoints verify their package metadata and every declared
  Preflight Scout-owned output before accepting those identities. This does not
  attest third-party dependencies, Node.js, the operating system, or the
  browser build.
  Missing, foreign, stale, or modified bundles fail closed before browser,
  delegated-agent, or promotion model execution. This detects inconsistent
  bundles; it is not a signature against replacement of the whole bundle and
  all digests by the same attacker.
- An exclusive run-directory generation lock covers same-directory
  compare-before-replace and manifest-last publication. Each browser invocation
  writes into a unique evidence-generation directory, and replacement
  revalidates the complete declared bundle while holding the lock. Artifact
  reads, cleanup, and writes reject symlinked ancestors outside their trusted
  boundary. Explicit external artifact paths receive a separately canonicalized
  boundary; contract-derived paths remain repository-confined.
- Optional PDF rendering uses a unique temporary path. `report.pdf` is replaced
  under the generation lock only after the complete source bundle is confirmed
  current; a late renderer for an obsolete generation fails closed.
- Run-result JSON contains portable run-relative evidence paths rather than raw
  checkout paths. Outside-run paths and URI-shaped evidence are rejected before
  any report artifact is written.
- Browser credentials are resolved from environment variables only when an action needs them. Names must match `PREFLIGHT_SCOUT_BROWSER_<LABEL>_(EMAIL|USERNAME|PASSWORD)`, and only mappings for the mission's exact selected role are exposed. Provider and infrastructure secret names are rejected even when a malicious contract maps them.
- Reports redact configured secrets and use environment-variable names instead of values.
- A repository-local `.env.preflight-scout.local` must be ignored and untracked.
  Privileged provider/model/base/exec, proxy/TLS, Node/runtime, Git, and
  local-agent controls are rejected unless
  `PREFLIGHT_SCOUT_TRUST_ENV_FILE_CONTROLS=1` is set in the parent environment. The
  file cannot set that flag, and it cannot override an existing parent value.
- Dangerous actions require an explicit contract allow-list or `preflight-scout approve`
  decision. Approval decisions live in ignored, untracked
  `.preflight-scout/approvals.local.yml`; tracked or legacy approval files fail closed.
- Preflight Scout's built-in Playwright runner treats the reviewed mission as an execution
  capability list. Navigation, mutation, and assertion decisions must bind to
  the exact reviewed mission step, target, and contract policy label;
  `finish_pass` fails closed until required reviewed-step coverage is present.
  Auth bootstrap starts from the reviewed `auth.loginUrl` (or an explicit human
  override), not an LLM-invented sign-in route.
- Preflight Scout's built-in Playwright missions enforce one exact HTTP(S) origin across
  direct navigation, clicks, form/key submissions, redirects, and popups.
  Non-HTTP(S), browser-internal, credential-bearing, and off-origin targets fail
  closed. Unsafe evidence and storage state are discarded or invalidated, and
  cross-origin SSO requires manual review.
- Default built-in local-agent planning runs without tools from a temporary
  directory outside the target repository with a narrow environment and bounded
  output. Explicit `PREFLIGHT_SCOUT_EXEC_COMMAND`/`PREFLIGHT_SCOUT_EXEC_ARGS` overrides are
  trusted-command escape hatches.
- Built-in delegated-agent commands apply provider sandbox and tool restrictions; mission prompts use stdin where supported. They receive a kind-specific minimal environment plus only the selected role's browser credentials. Their browser/MCP tooling is still outside Preflight Scout's built-in navigation boundary, and custom agents remain trusted executables.
- Timeout and output-limit cleanup terminates the spawned process group on
  POSIX. On Windows it invokes the OS-owned `System32\taskkill.exe` by absolute
  path with descendant-tree termination, a bounded wait, and no captured
  taskkill output.
- The optional doctor agent probe runs from a fresh temporary directory outside
  the target repository, strips provider API keys and unrelated environment
  variables, applies built-in no-tool restrictions, bounds/redacts error state,
  and removes the directory afterward. It tests an authenticated CLI session,
  not browser capability. Custom agent commands remain trusted executables.
- OpenAI API calls use `store: false`; other providers follow the account and API retention settings selected by the user.
- Auth state that is missing, malformed, or marked invalid blocks the mission instead of falling through to an uncontrolled browser run.

## Safe-use rules

- Run against local, preview, staging, or disposable environments and test accounts.
- Review the generated mission before granting a new tool, MCP server, credential, or production URL.
- Never commit `.preflight-scout/auth/`, API keys, or unsanitized authenticated evidence.
- Treat generated tests as code: review them before execution or merge.
- Review artifact retention settings in CI and delete evidence that contains sensitive data.
- Report suspected credential, command-execution, auth-state, or evidence-disclosure vulnerabilities through [SECURITY.md](../SECURITY.md), not a public issue.
