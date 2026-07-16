import path from "node:path";
import { createTrustedGit, resolveTrustedGitCommit, type TrustedGit } from "./trusted-git.js";
import type { ChangedFile, PullRequestContext } from "./types.js";

const MAX_GIT_BLOB_BYTES = 1024 * 1024;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const MAX_GIT_CONTEXT_FILES = 100;
export const MAX_GIT_CONTEXT_CHARS = 512 * 1024;

export async function readGitDiff(options: { base: string; head: string; cwd: string; includePatch?: boolean }): Promise<PullRequestContext> {
  const git = await createTrustedGit({ targetRoot: path.resolve(options.cwd) });
  const [baseCommit, headCommit] = await Promise.all([
    resolveTrustedGitCommit(git, options.cwd, options.base),
    resolveTrustedGitCommit(git, options.cwd, options.head)
  ]);
  const range = `${baseCommit}...${headCommit}`;
  const { stdout: names } = await git.exec(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", range, "--"], {
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024
  });
  const files = parseNameStatus(names);
  const stats = await readNumstat(options.cwd, range, git);
  for (const file of files) {
    const stat = stats.get(file.path);
    if (stat) {
      file.additions = stat.additions;
      file.deletions = stat.deletions;
    }
  }

  if (options.includePatch) {
    let contextChars = 0;
    let filesWithContext = 0;
    let totalBudgetExhausted = false;
    for (const [index, file] of files.entries()) {
      if (index >= MAX_GIT_CONTEXT_FILES) {
        markContextOmitted(file, "omitted_changed_file_limit");
        continue;
      }
      if (totalBudgetExhausted) {
        markContextOmitted(file, "omitted_total_budget");
        continue;
      }
      const { stdout } = await git.exec(
        ["diff", "--no-ext-diff", "--no-textconv", range, "--", literalPathspec(file.path)],
        { cwd: options.cwd, maxBuffer: 1024 * 1024 * 8 }
      );
      const patch = trimPatch(stdout);
      const content = file.status !== "deleted"
        ? await readChangedFileContent(options.cwd, headCommit, file.path, git)
        : undefined;
      const nextChars = patch.length + (content?.length ?? 0);
      if (contextChars + nextChars > MAX_GIT_CONTEXT_CHARS) {
        totalBudgetExhausted = true;
        markContextOmitted(file, "omitted_total_budget");
        continue;
      }
      file.patch = patch;
      file.contextStatus = "included";
      if (file.status !== "deleted") {
        file.content = content;
      }
      contextChars += nextChars;
      filesWithContext += 1;
    }
    const omittedFiles = files.length - filesWithContext;
    return {
      base: baseCommit,
      head: headCommit,
      files,
      contextCoverage: {
        totalFiles: files.length,
        filesWithContext,
        omittedFiles,
        contextChars,
        maxContextFiles: MAX_GIT_CONTEXT_FILES,
        maxContextChars: MAX_GIT_CONTEXT_CHARS,
        complete: omittedFiles === 0,
        ...(omittedFiles ? {
          note: "Preflight Scout retained path, status, and line-count metadata for every changed file, but omitted some patch/content context. Treat impact coverage as incomplete and report this uncertainty."
        } : {})
      }
    };
  }

  return { base: baseCommit, head: headCommit, files };
}

function markContextOmitted(
  file: ChangedFile,
  reason: "omitted_changed_file_limit" | "omitted_total_budget"
): void {
  file.contextStatus = reason;
  file.contextNote = reason === "omitted_changed_file_limit"
    ? `Patch/content omitted after the ${MAX_GIT_CONTEXT_FILES}-file context limit; metadata retained.`
    : `Patch/content omitted after the ${MAX_GIT_CONTEXT_CHARS}-character total context budget; metadata retained.`;
  file.patch = `[${file.contextNote} Treat impact as uncertain.]`;
  delete file.content;
}

export function parseNameStatus(output: string): ChangedFile[] {
  if (output.includes("\0")) return parseNullDelimitedNameStatus(output);
  return output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const [statusRaw, first, second] = line.split("\t");
      const code = statusRaw[0];
      const path = second ?? first;
      return {
        path,
        status: statusFromCode(code)
      };
    });
}

function parseNullDelimitedNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length;) {
    const statusRaw = fields[index++];
    if (!statusRaw) continue;
    const code = statusRaw[0];
    const firstPath = fields[index++];
    const secondPath = code === "R" || code === "C" ? fields[index++] : undefined;
    const filePath = secondPath ?? firstPath;
    if (!filePath) continue;
    files.push({ path: filePath, status: statusFromCode(code) });
  }
  return files;
}

function statusFromCode(code: string): ChangedFile["status"] {
  if (code === "A") return "added";
  if (code === "M") return "modified";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return "unknown";
}

function trimPatch(patch: string): string {
  const maxChars = 12000;
  if (patch.length <= maxChars) return patch;
  return `${patch.slice(0, maxChars)}\n\n[patch truncated by Preflight Scout]\n`;
}

async function readNumstat(cwd: string, range: string, git: TrustedGit): Promise<Map<string, { additions: number; deletions: number }>> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  const { stdout } = await git.exec(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", range, "--"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024
  });
  const records = stdout.split("\0");
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    const inlinePath = record.slice(secondTab + 1);
    const filePath = inlinePath || records[index + 1];
    if (!inlinePath) index += 2;
    if (!filePath) continue;
    stats.set(filePath, {
      additions: Number(additionsRaw) || 0,
      deletions: Number(deletionsRaw) || 0
    });
  }
  return stats;
}

async function readChangedFileContent(cwd: string, headCommit: string, filePath: string, git: TrustedGit): Promise<string | undefined> {
  try {
    const entry = await readHeadTreeEntry(cwd, headCommit, filePath, git);
    if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return undefined;

    const { stdout: sizeOutput } = await git.exec(["cat-file", "-s", entry.object], {
      cwd,
      maxBuffer: 1024
    });
    const size = Number(sizeOutput.trim());
    if (!Number.isSafeInteger(size) || size < 0) return undefined;
    if (size > MAX_GIT_BLOB_BYTES) {
      return `[file content omitted by Preflight Scout: Git blob is ${size} bytes]\n`;
    }

    const { stdout: content } = await git.exec(["cat-file", "blob", entry.object], {
      cwd,
      maxBuffer: MAX_GIT_BLOB_BYTES + 1
    });
    return content.length > 20000 ? `${content.slice(0, 20000)}\n\n[file content truncated by Preflight Scout]\n` : content;
  } catch {
    return undefined;
  }
}

async function readHeadTreeEntry(cwd: string, headCommit: string, filePath: string, git: TrustedGit): Promise<{
  mode: string;
  type: string;
  object: string;
} | undefined> {
  const { stdout } = await git.exec(
    ["ls-tree", "-z", "--full-tree", headCommit, "--", literalPathspec(filePath)],
    { cwd, maxBuffer: 64 * 1024 }
  );
  const records = stdout.split("\0").filter(Boolean);
  if (records.length !== 1) return undefined;

  const separator = records[0].indexOf("\t");
  if (separator === -1 || records[0].slice(separator + 1) !== filePath) return undefined;
  const [mode, type, object, ...extra] = records[0].slice(0, separator).split(" ");
  if (!mode || !type || !object || extra.length || !GIT_OBJECT_ID.test(object)) return undefined;
  return { mode, type, object };
}

function literalPathspec(filePath: string): string {
  return `:(top,literal)${filePath}`;
}
