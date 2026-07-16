import { isSafeIndexedPath } from "./fs.js";
import type { PullRequestContext, QAContract, RepoIndex } from "./types.js";

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9_]+/g,
  /sk_test_[A-Za-z0-9_]+/g,
  /pk_live_[A-Za-z0-9_]+/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /pypi-[A-Za-z0-9_-]{30,}/g,
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /(?<=["'=:\s])(AKIA[0-9A-Z]{16})(?=["'\s,;]|$)/g
];

const OMITTED_SENSITIVE_FILE_CONTEXT = "[OMITTED_SENSITIVE_FILE_CONTEXT]";

export function redactText(value: string, additionalSecrets: Iterable<string> = []): string {
  let redacted = value;
  const secrets = [...new Set([...envSecretValues(), ...additionalSecrets].filter((item) => item.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED_ENV_SECRET]");
  }
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  }
  return redacted;
}

export function redactRepoIndex(repoIndex: RepoIndex): RepoIndex {
  const redact = repoIndexRedactor(repoIndex.root);
  return {
    root: ".",
    files: redactPathList(repoIndex.files, redact),
    manifests: Object.fromEntries(
      Object.entries(repoIndex.manifests)
        .filter(([key]) => isSafeIndexedPath(key))
        .map(([key, value]) => [redact(key), redact(value)])
    ),
    packageManager: repoIndex.packageManager,
    frameworks: repoIndex.frameworks.map(redact),
    routes: repoIndex.routes
      .filter((route) => isSafeIndexedPath(route.file))
      .map((route) => ({ ...route, path: redact(route.path), file: redact(route.file) })),
    components: repoIndex.components
      .filter((component) => isSafeIndexedPath(component.file))
      .map((component) => ({ name: redact(component.name), file: redact(component.file) })),
    tests: redactPathList(repoIndex.tests, redact),
    configFiles: redactPathList(repoIndex.configFiles, redact),
    integrationHints: repoIndex.integrationHints.map(redact)
  };
}

export function redactPullRequestContext(pullRequest: PullRequestContext): PullRequestContext {
  return {
    ...pullRequest,
    title: pullRequest.title ? redactText(pullRequest.title) : undefined,
    body: pullRequest.body ? redactText(pullRequest.body) : undefined,
    files: pullRequest.files.map((file) => {
      const includeFileContext = isSafeIndexedPath(file.path);
      return {
        ...file,
        path: redactText(file.path),
        patch: file.patch
          ? includeFileContext ? redactText(file.patch) : OMITTED_SENSITIVE_FILE_CONTEXT
          : undefined,
        content: file.content
          ? includeFileContext ? redactText(file.content) : OMITTED_SENSITIVE_FILE_CONTEXT
          : undefined
      };
    })
  };
}

export function redactContract(contract: QAContract): QAContract {
  return JSON.parse(redactText(JSON.stringify(contract))) as QAContract;
}

function envSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => {
      if (!value) return false;
      if (/^PREFLIGHT_SCOUT_BROWSER_[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:EMAIL|USERNAME|PASSWORD)$/.test(key)) return true;
      // Deny-only legacy match: stale pre-release credentials remain secrets,
      // even though the old environment namespace is no longer supported.
      if (/^PREFLIGHT_BROWSER_[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:EMAIL|USERNAME|PASSWORD)$/.test(key)) return true;
      return /(TOKEN|KEY|SECRET|PASSWORD|PASS|API|AUTH|CREDENTIAL|COOKIE|SESSION|HEADER|PROXY)/i.test(key)
        && value.length >= 8;
    })
    .map(([, value]) => value as string);
}

function redactPathList(paths: string[], redact: (value: string) => string): string[] {
  return [...new Set(paths.filter(isSafeIndexedPath).map(redact))];
}

function repoIndexRedactor(root: string): (value: string) => string {
  const slashRoot = root.replaceAll("\\", "/");
  const rootVariants = [...new Set([
    root,
    slashRoot,
    root.replaceAll("\\", "\\\\"),
    JSON.stringify(root).slice(1, -1),
    JSON.stringify(slashRoot).slice(1, -1)
  ])]
    .filter((candidate) => candidate.length > 1 && candidate !== ".")
    .sort((left, right) => right.length - left.length);
  const windowsRoot = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(root);
  return (value: string) => {
    let redacted = value;
    for (const rootVariant of rootVariants) {
      redacted = windowsRoot
        ? redacted.replace(new RegExp(escapeRegExp(rootVariant), "gi"), "[REDACTED_REPO_ROOT]")
        : redacted.split(rootVariant).join("[REDACTED_REPO_ROOT]");
    }
    return redactText(redacted);
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
