# Preflight Scout Report

> RELEASE QA REPORT / LOCAL FILES / REVIEW BEFORE SHIPPING

- Generated: 2026-07-13T12:00:00.000Z
- Mission: Validate promo-code totals and feedback
- Risk: **HIGH**
- Verdict: **Needs attention before production**

## Release result

### DO NOT SHIP YET

1 browser check failed; 0 were blocked.

Next steps:
- Review the failed or blocked mission evidence.
- Fix the issue or provide the missing credentials, permissions, approval, or safe test data.
- Rerun Preflight Scout before production.

## Mission summary

Illustrative fixture only — no live model or browser run. This example checks whether promo-code feedback changes the checkout total.

### Counts

- Affected areas: 2
- Manual checks: 4
- Edge cases: 3
- Suggested browser missions: 2
- Executed browser missions: 2
- Browser outcomes: 1 passed, 1 failed, 0 blocked

## Manual checks before production

- [ ] Apply SAVE10 and confirm the total changes from $100.00 to $90.00.
- [ ] Apply EXPIRED10 and confirm the error is visible while the total remains $100.00.
- [ ] Apply an unknown code and confirm no stale success or error state remains.
- [ ] Confirm no payment or order submission occurs during promo validation.

## Affected areas by risk

- **HIGH** Checkout total calculation (billing)
- **MEDIUM** Expired promo feedback (component)

## Changed areas

### Checkout total calculation

Kind: `billing`  
Risk: **HIGH**

- src/checkout.js changes how valid and expired promo codes update the displayed total.

### Expired promo feedback

Kind: `component`  
Risk: **MEDIUM**

- index.html adds an alert element and src/checkout.js controls its visibility.

## Affected Routes

- `/` (page) from `index.html`

## Edge cases to check

- Apply a valid code after an expired code.
- Apply the same code twice.
- Submit whitespace and mixed-case promo values.

## Browser results

### Results

- **Valid promo updates the total**: PASSED - SAVE10 reduced the displayed total from $100.00 to $90.00.
- **Expired promo preserves the total**: FAILED - Expired-code feedback was visible, but the total changed to $90.00; expected $100.00.

### Valid promo updates the total

Status: **PASSED**  
Risk: **HIGH**  
Role: `guest_buyer`  
Start: `/`

Why this mattered:
- The pricing branch changed and directly affects the amount shown to the buyer.

Result timeline:
- PASSED `turn-1`: Opened the checkout at the synthetic local target.
- PASSED `turn-2`: SAVE10 reduced the displayed total from $100.00 to $90.00.

Evidence:
- [console-errors.json](auto-valid-promo/console-errors.json)
- [network-errors.json](auto-valid-promo/network-errors.json)
- [final-observation.json](auto-valid-promo/final-observation.json)

### Expired promo preserves the total

Status: **FAILED**  
Risk: **HIGH**  
Role: `guest_buyer`  
Start: `/`

Why this mattered:
- The new expired-code branch must not apply a discount.

Result timeline:
- PASSED `turn-1`: Opened the checkout at the synthetic local target.
- FAILED `turn-2`: Expired-code feedback was visible, but the total changed to $90.00; expected $100.00.

Evidence:
- [console-errors.json](auto-expired-promo/console-errors.json)
- [network-errors.json](auto-expired-promo/network-errors.json)
- [final-observation.json](auto-expired-promo/final-observation.json)


## Machine-readable summary

```json
{
  "generatedAt": "2026-07-13T12:00:00.000Z",
  "title": "Validate promo-code totals and feedback",
  "risk": "high",
  "verdict": "needs_attention",
  "releaseDecision": {
    "status": "do_not_ship_yet",
    "reason": "1 browser check failed; 0 were blocked.",
    "nextSteps": [
      "Review the failed or blocked mission evidence.",
      "Fix the issue or provide the missing credentials, permissions, approval, or safe test data.",
      "Rerun Preflight Scout before production."
    ]
  },
  "counts": {
    "affectedAreas": 2,
    "manualChecks": 4,
    "edgeCases": 3,
    "suggestedBrowserMissions": 2,
    "browserMissions": 2,
    "passed": 1,
    "failed": 1,
    "blocked": 0
  },
  "browserMissions": [
    {
      "id": "auto-valid-promo",
      "title": "Valid promo updates the total",
      "risk": "high",
      "status": "passed",
      "finalMessage": "SAVE10 reduced the displayed total from $100.00 to $90.00.",
      "artifacts": [
        "auto-valid-promo/console-errors.json",
        "auto-valid-promo/network-errors.json",
        "auto-valid-promo/final-observation.json"
      ],
      "evidence": {
        "consolePath": "auto-valid-promo/console-errors.json",
        "networkPath": "auto-valid-promo/network-errors.json",
        "finalObservationPath": "auto-valid-promo/final-observation.json"
      }
    },
    {
      "id": "auto-expired-promo",
      "title": "Expired promo preserves the total",
      "risk": "high",
      "status": "failed",
      "finalMessage": "Expired-code feedback was visible, but the total changed to $90.00; expected $100.00.",
      "artifacts": [
        "auto-expired-promo/console-errors.json",
        "auto-expired-promo/network-errors.json",
        "auto-expired-promo/final-observation.json"
      ],
      "evidence": {
        "consolePath": "auto-expired-promo/console-errors.json",
        "networkPath": "auto-expired-promo/network-errors.json",
        "finalObservationPath": "auto-expired-promo/final-observation.json"
      }
    }
  ]
}
```

<!-- preflight-scout-report -->
<!-- Template material generated by Preflight Scout in this artifact is licensed under MIT. https://github.com/fenutech/preflight-scout/blob/main/OUTPUT-LICENSE.md -->