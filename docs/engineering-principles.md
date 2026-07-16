# Engineering Principles

## Keep reasoning explicit

Preflight Scout delegates all reasoning to LLMs.

Allowed deterministic code:

- collect git diffs
- collect file trees
- read explicit config
- execute explicit browser instructions
- collect live browser observations
- redact secrets
- format reports
- call provider APIs

Forbidden deterministic code:

- infer product impact with regexes
- infer affected flows with hardcoded path rules
- infer browser click targets with code fallbacks instead of an LLM browser turn
- invent risk scores from file names
- generate QA checklists from templates
- silently downgrade to generic output when no LLM is configured

If an LLM is unavailable, Preflight Scout must stop and ask for one.

If the LLM cannot infer something, the output must contain a concrete `unknown` or `blocked` item.

Every conclusion must be traceable to a prompt, typed output, or captured evidence.

All prompt outputs are typed contracts:

- `QAContract`
- `ImpactMap`
- `QAMission`
- `BrowserDecision`

Provider adapters must request structured output and validate with Zod. Invalid output gets one repair attempt, then fails loudly.

Browser automation follows the same rule:

```text
observe current page -> prompt LLM for next action -> execute exactly that action -> observe again
```

Preflight Scout does not precompile a brittle click script and hope it works.
