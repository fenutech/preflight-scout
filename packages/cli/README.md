# @preflight-scout/cli

CLI for pull-request impact reports and browser QA missions.

This package is part of [Preflight Scout](https://github.com/fenutech/preflight-scout), which maps pull-request changes, runs focused checks and bounded browser missions, and records release evidence.

## Install

Confirm the currently supported installation paths in the root README and the
npm registry. A package README may also be present in an unreleased source
archive, so do not treat this file alone as proof that a registry release exists.

Requirements: Node.js 22.13 or newer. For users and agents, the
recommended release installation uses npm. This README can exist in source
before publication, so first confirm that the official v0.1.0
release and the live registry both list @preflight-scout/cli@0.1.0.
After both checks pass:

```bash
npm view @preflight-scout/cli@0.1.0 version --registry=https://registry.npmjs.org/
npm install --global @preflight-scout/cli@0.1.0 --registry=https://registry.npmjs.org/
preflight-scout install-browser
preflight-scout --version
```

Keep the exact version pin. For a quick, non-durable trial after the same
release checks:

```bash
npm exec --yes --registry=https://registry.npmjs.org/ --package=@preflight-scout/cli@0.1.0 -- preflight-scout --help
```

Until that exact release is live—or when contributing—use a stable trusted
checkout of the monorepo. The source installer builds and verifies the CLI,
installs a durable wrapper, and installs Chromium:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm install:source-cli
preflight-scout --version
```

Create a repo-agnostic demo target:

```bash
preflight-scout demo --output /tmp/preflight-scout-generic-shop --force
```

## License

AGPL-3.0-only. See `LICENSE`. Generated reports and promoted tests are covered by the separate terms in `OUTPUT-LICENSE.md`.
