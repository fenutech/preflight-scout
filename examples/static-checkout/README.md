# Static Checkout Demo

Tiny browser target for manual Preflight Scout experiments.

```bash
python3 -m http.server 4173 -d examples/static-checkout
pnpm preflight-scout run --base HEAD~1 --head HEAD --url http://localhost:4173
```

Use this for future browser-runner tests with a mocked LLM decision loop.
