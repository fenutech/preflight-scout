# Illustrative Sample Report

This directory is a deterministic fixture that demonstrates Preflight Scout's
current artifact shapes. It is **not** the output of a live model provider or a
real browser run, and it does not claim that the hypothetical regression exists
in the bundled generic demo or any production application.

Mission steps include exact reviewed `policyLabel` values. A real repository's
contract must use the same label for the corresponding allowed or approved
action; the runner does not infer labels from human-readable instructions.

The scenario intentionally models one passing and one failing checkout mission
so reviewers can see how a release blocker appears in the human and machine
reports. Names, paths, timestamps, observations, and outcomes are synthetic.

## Files

- `impact-map.json`: structured PR impact analysis.
- `mission.json`: risk-ranked checklist and browser candidates.
- `run-results.json`: two illustrative browser outcomes.
- `report.md`: the human-facing report shape produced from the fixture.
- `report.html`: the matching print-friendly human report. Its visible fixture
  disclosure comes from the same typed mission input as the Markdown report.
- `report-summary.json`: the matching CI/agent summary.
- `auto-*/console-errors.json`: illustrative console evidence.
- `auto-*/network-errors.json`: illustrative network evidence.
- `auto-*/final-observation.json`: illustrative final browser observations.

No screenshots or Playwright trace are included because creating fake binary
evidence would make the fixture easier to misread as a real run. A real run can
also contain per-step screenshots and `trace.zip` files.

The fixed generation time is `2026-07-13T12:00:00.000Z`. To refresh the fixture,
construct the same typed inputs and render them with the public report helpers;
then review every diff and retain the disclosure in `mission.json`.
