import { isSafeIndexedPath } from "./fs.js";
import type { PullRequestContext, QAContract, RepoFileInventoryCoverage, RepoIndex } from "./types.js";

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
  /(?<=["'=:\s])(AKIA[0-9A-Z]{16})(?=["'\s,;]|$)/g
];

const PEM_BEGIN_PREFIX = "-----BEGIN ";
const PEM_END_PREFIX = "-----END ";
const PEM_BOUNDARY_SUFFIX = "-----";

const OMITTED_SENSITIVE_FILE_CONTEXT = "[OMITTED_SENSITIVE_FILE_CONTEXT]";
export const MAX_REPO_INVENTORY_COVERAGE_NOTE_CHARS = 1024;
export const UNKNOWN_REPO_INVENTORY_COVERAGE_NOTE =
  "Repository file-inventory coverage metadata is unavailable. Treat the inventory as incomplete and non-exhaustive.";

export function redactText(value: string, additionalSecrets: Iterable<string> = []): string {
  // Parse PEM boundaries before substituting caller-controlled secret values.
  // Otherwise a secret that overlaps a boundary label could corrupt both the
  // BEGIN and END markers before the private-key scanner sees them.
  let redacted = redactPemPrivateKeys(value);
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

/**
 * Redact PEM private-key blocks without a cross-document regular expression.
 *
 * The scan only moves forward. Once a valid private-key opening boundary is
 * found, a missing matching closing boundary redacts through end-of-input. A
 * truncated private key is still sensitive, and failing closed also prevents
 * repeated unterminated BEGIN markers from triggering suffix rescans.
 */
function redactPemPrivateKeys(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let searchFrom = 0;

  while (searchFrom < value.length) {
    const beginStart = value.indexOf(PEM_BEGIN_PREFIX, searchFrom);
    if (beginStart === -1) break;

    const begin = parsePrivateKeyPemBegin(value, beginStart);
    if (!begin) {
      searchFrom = beginStart + PEM_BEGIN_PREFIX.length;
      continue;
    }

    parts.push(value.slice(cursor, beginStart), "[REDACTED_SECRET]");
    const endBoundary = `${PEM_END_PREFIX}${begin.label}${PEM_BOUNDARY_SUFFIX}`;
    const endStart = value.indexOf(endBoundary, begin.bodyStart);
    if (endStart === -1) {
      cursor = value.length;
      searchFrom = value.length;
      break;
    }

    // PEM blocks cannot be nested. If another opening boundary appears before
    // the matching END, the input is malformed and the first END may belong to
    // the inner block. Redact the remaining input instead of exposing an outer
    // tail after that ambiguous boundary.
    const nestedBeginStart = value.indexOf(PEM_BEGIN_PREFIX, begin.bodyStart);
    if (nestedBeginStart !== -1 && nestedBeginStart < endStart) {
      cursor = value.length;
      searchFrom = value.length;
      break;
    }

    cursor = endStart + endBoundary.length;
    searchFrom = cursor;
  }

  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

function parsePrivateKeyPemBegin(
  value: string,
  beginStart: number
): { label: string; bodyStart: number } | undefined {
  const labelStart = beginStart + PEM_BEGIN_PREFIX.length;
  let position = labelStart;

  while (position < value.length) {
    if (value.startsWith(PEM_BOUNDARY_SUFFIX, position)) {
      const label = value.slice(labelStart, position);
      if (!isPrivateKeyPemLabel(label)) return undefined;
      return {
        label,
        bodyStart: position + PEM_BOUNDARY_SUFFIX.length
      };
    }

    const code = value.charCodeAt(position);
    const isUppercaseAscii = code >= 65 && code <= 90;
    const isDigit = code >= 48 && code <= 57;
    if (code !== 32 && !isUppercaseAscii && !isDigit) return undefined;
    position += 1;
  }

  return undefined;
}

function isPrivateKeyPemLabel(label: string): boolean {
  return label === "PRIVATE KEY" || label.endsWith(" PRIVATE KEY");
}

export function redactRepoIndex(repoIndex: RepoIndex): RepoIndex {
  const redact = repoIndexRedactor(repoIndex.root);
  return {
    root: ".",
    files: redactPathList(repoIndex.files, redact),
    fileInventoryCoverage: redactRepoFileInventoryCoverage(repoIndex, redact),
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

/**
 * Older or caller-constructed RepoIndex values may not carry coverage metadata.
 * Absence is never evidence of exhaustive enumeration, so normalize it to an
 * explicit, deterministic non-exhaustive state before model or report use.
 */
export function normalizeRepoFileInventoryCoverage(
  repoIndex: Pick<RepoIndex, "files" | "fileInventoryCoverage">
): RepoFileInventoryCoverage {
  const coverage = repoIndex.fileInventoryCoverage;
  if (coverage) {
    if (coverage.state === "unknown") {
      return {
        state: "unknown",
        includedFiles: coverage.includedFiles,
        complete: false,
        note: coverage.note
      };
    }
    return {
      state: "known",
      maxFiles: coverage.maxFiles,
      includedFiles: coverage.includedFiles,
      complete: coverage.complete,
      ...(coverage.note ? { note: coverage.note } : {})
    };
  }
  return {
    state: "unknown",
    includedFiles: repoIndex.files.length,
    complete: false,
    note: UNKNOWN_REPO_INVENTORY_COVERAGE_NOTE
  };
}

function redactRepoFileInventoryCoverage(
  repoIndex: Pick<RepoIndex, "files" | "fileInventoryCoverage">,
  redact: (value: string) => string
): RepoFileInventoryCoverage {
  const coverage = normalizeRepoFileInventoryCoverage(repoIndex);
  if (coverage.state === "unknown") {
    return {
      state: "unknown",
      includedFiles: coverage.includedFiles,
      complete: false,
      note: clipCoverageNote(redact(coverage.note))
    };
  }
  return {
    state: "known",
    maxFiles: coverage.maxFiles,
    includedFiles: coverage.includedFiles,
    complete: coverage.complete,
    ...(coverage.note ? { note: clipCoverageNote(redact(coverage.note)) } : {})
  };
}

function clipCoverageNote(value: string): string {
  if (value.length <= MAX_REPO_INVENTORY_COVERAGE_NOTE_CHARS) return value;
  const suffix = "\n[truncated inventory-coverage note]";
  return `${value.slice(0, MAX_REPO_INVENTORY_COVERAGE_NOTE_CHARS - suffix.length)}${suffix}`;
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
