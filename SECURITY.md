# Security Policy

Preflight Scout reads source code and diffs, can launch a browser, may handle
authenticated storage state, and can delegate work to local or remote model
providers. Security reports are welcome and should be handled privately.

## Supported versions

Preflight Scout is pre-1.0. Before the first published release, fixes target the latest
maintained commit. After publication, security fixes target the newest minor
release line; older pre-1.0 lines may not receive backports.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's [private vulnerability reporting form](https://github.com/fenutech/preflight-scout/security/advisories/new)
when it is enabled. If the form is unavailable, email
[andrea@fenutech.com](mailto:andrea@fenutech.com). Do not include exploit details
in an issue, discussion, pull request, or other public message.

Include only what is needed to reproduce and assess the issue:

- affected version or commit;
- affected package, command, or integration;
- prerequisites and a minimal reproduction;
- expected and observed security boundary;
- realistic impact and attack scenario;
- suggested mitigation, if known.

Never send API keys, session cookies, Playwright storage-state files, customer
data, or credentials. Use synthetic data and redact logs and paths where
possible.

## What to report

Examples of useful reports include:

- credentials or sensitive application data leaking into prompts, logs,
  reports, screenshots, or CI artifacts;
- path traversal or writes outside the intended report, auth, or promoted-test
  directories;
- command injection or unintended command execution through repository content,
  configuration, provider output, MCP tools, or delegated agents;
- bypasses of allowed, approval-required, or forbidden browser actions;
- prompt injection that crosses a documented trust or action boundary;
- unsafe handling of GitHub tokens, provider keys, or browser storage state;
- dependency or packaging behavior that materially changes the trust boundary.

Ordinary model mistakes, flaky selectors, unsupported sites, or reports that are
merely incomplete belong in the normal bug tracker unless they also bypass a
security boundary.

## Response targets

These are good-faith targets for a maintainer-led project, not service-level
guarantees:

- acknowledgement within 5 business days;
- initial triage within 10 business days;
- progress updates at least every 14 days while a confirmed issue is open;
- coordinated disclosure after a fix or mitigation is available.

Please allow reasonable time for investigation and remediation before public
disclosure. The project will credit reporters who want attribution and will not
take action against good-faith research that avoids privacy violations, data
destruction, service disruption, persistence, or access beyond what is necessary
to demonstrate the issue.
