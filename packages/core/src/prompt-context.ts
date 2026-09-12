import path from "node:path";
import type { RepoIndex } from "./types.js";

export const MAX_PROMPT_REPO_INDEX_CHARS = 32 * 1024;
const TRUNCATED = "\n[truncated by Preflight Scout context budget]";

/** Budget serialized JSON, including escaping, rather than assuming one character per byte/token. */
export function clipJsonString(value: string, maxSerializedChars: number): string {
  if (JSON.stringify(value).length <= maxSerializedChars) return value;
  if (JSON.stringify(TRUNCATED).length > maxSerializedChars) return "";
  let low = 0;
  let high = Math.min(value.length, maxSerializedChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, middle) + TRUNCATED).length <= maxSerializedChars) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + TRUNCATED;
}

/** Select context by path proximity only; this is not product or risk classification. */
export function prioritizeRepositoryPaths(files: string[], changedPaths: string[] = []): string[] {
  const changed = new Set(changedPaths);
  const directories = new Set(changedPaths.map((file) => path.posix.dirname(file)).filter((directory) => directory !== "."));
  const score = (file: string): number => changed.has(file) ? 0
    : directories.has(path.posix.dirname(file)) ? 1
      : !file.includes("/") ? 2 : 3;
  return [...files].sort((left, right) => score(left) - score(right) || (left < right ? -1 : left > right ? 1 : 0));
}

export function boundRepoIndexForPrompt(repoIndex: RepoIndex, changedPaths: string[] = []): {
  inventory: Record<string, unknown>;
  complete: boolean;
} {
  const output: Record<string, unknown> = {
    root: ".",
    fileInventoryCoverage: repoIndex.fileInventoryCoverage,
    packageManager: repoIndex.packageManager,
    manifests: {}, files: [], frameworks: [], routes: [], components: [], tests: [], configFiles: [], integrationHints: []
  };
  const reserve = 1024;
  let used = JSON.stringify(output).length;
  let totalEntries = 0;
  let includedEntries = 0;
  let truncatedEntries = 0;
  const add = (value: unknown, insert: () => void): boolean => {
    totalEntries += 1;
    const cost = JSON.stringify(value).length + 1;
    if (used + cost + reserve > MAX_PROMPT_REPO_INDEX_CHARS) return false;
    insert();
    used += cost;
    includedEntries += 1;
    return true;
  };
  for (const [name, content] of Object.entries(repoIndex.manifests).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const clipped = clipJsonString(content, 4096);
    if (add([name, clipped], () => { (output.manifests as Record<string, string>)[name] = clipped; }) && clipped !== content) truncatedEntries += 1;
  }
  // Preserve caller-provided structured evidence before filling remaining space with raw paths.
  for (const key of ["frameworks", "routes", "components", "tests", "configFiles", "integrationHints"] as const) {
    for (const value of repoIndex[key]) add(value, () => { (output[key] as unknown[]).push(value); });
  }
  for (const file of prioritizeRepositoryPaths(repoIndex.files, changedPaths)) {
    add(file, () => { (output.files as string[]).push(file); });
  }
  const omittedEntries = totalEntries - includedEntries;
  const complete = omittedEntries === 0 && truncatedEntries === 0;
  output.promptCoverage = {
    totalEntries, includedEntries, omittedEntries, truncatedEntries, complete,
    selection: "Root project excerpts and classified evidence first; changed paths and their directory siblings before other raw paths.",
    ...(!complete ? { note: "Repository context was selected or truncated to fit the prompt. Treat impact coverage as incomplete." } : {})
  };
  return { inventory: output, complete };
}
