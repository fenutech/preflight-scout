# Browser Evidence

Browser missions produce human-readable reports and replayable artifacts.

For each mission, Preflight Scout writes:

- per-step screenshots
- `trace.zip` from Playwright tracing
- `console-errors.json`
- `network-errors.json`
- `final-observation.json`

`report.md` and `report.html` link to the evidence. In CI, the GitHub Action
validates the manifest, re-hashes only the declared report/result/evidence
files into a private staging directory, and uploads that immutable staged set.
Undeclared or stale files in the run directory are not uploaded.

Trace capture is enabled by default:

```bash
preflight-scout run --base origin/main --head HEAD --url https://preview.example.com
```

Disable traces when artifact size matters:

```bash
preflight-scout run --base origin/main --head HEAD --url https://preview.example.com --no-trace
```

The trace is not product reasoning. It is deterministic evidence capture around decisions made by the LLM browser agent.

Evidence is retained only while Preflight Scout's built-in browser remains on the exact
HTTP(S) origin selected for the mission. The runner blocks unsafe schemes,
embedded URL credentials, off-origin interactions and redirect hops, and
popups. If that boundary is violated during an action or finalization, the
mission becomes blocked, unsafe screenshots and final observations are removed,
trace/console/network artifacts are discarded, and requested auth state is
marked invalid instead of being saved as reusable state. Cross-origin SSO must
be reviewed manually.

This evidence boundary applies to `preflight-scout run` and non-delegated
`preflight-scout auth login`. `agent-run` and delegated auth use the external agent's
browser and evidence controls.
