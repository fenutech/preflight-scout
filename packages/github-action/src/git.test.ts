import { describe, expect, it, vi } from "vitest";
import { ensurePullRequestRefs, type GitCommand } from "./git.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const SAME_SHA = "c".repeat(40);

describe("ensurePullRequestRefs", () => {
  it("does not fetch when checkout already contains both PR commits", async () => {
    const runGit = vi.fn<GitCommand>(async (args) => {
      if (args[1] === "--is-shallow-repository") return "false\n";
      return `${commitFromVerifyArgs(args)}\n`;
    });

    await ensurePullRequestRefs(BASE_SHA, HEAD_SHA, runGit);

    expect(runGit).toHaveBeenCalledTimes(3);
    expect(runGit).toHaveBeenCalledWith([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${BASE_SHA}^{commit}`
    ]);
    expect(runGit).toHaveBeenCalledWith([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${HEAD_SHA}^{commit}`
    ]);
  });

  it("fetches only commits that are absent and verifies the fetched object", async () => {
    let headFetched = false;
    const runGit = vi.fn<GitCommand>(async (args) => {
      if (args[1] === "--is-shallow-repository") return "false\n";
      if (args[0] === "fetch") {
        headFetched = true;
        return "";
      }
      const sha = commitFromVerifyArgs(args);
      if (sha === HEAD_SHA && !headFetched) throw new Error("missing commit");
      return `${sha}\n`;
    });

    await ensurePullRequestRefs(BASE_SHA, HEAD_SHA, runGit);

    expect(runGit).toHaveBeenCalledWith([
      "fetch",
      "--no-tags",
      "origin",
      HEAD_SHA
    ]);
    expect(runGit).toHaveBeenLastCalledWith([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${HEAD_SHA}^{commit}`
    ]);
  });

  it("unshallows both PR histories and verifies both requested commits", async () => {
    const runGit = vi.fn<GitCommand>(async (args) => {
      if (args[1] === "--is-shallow-repository") return "true\n";
      if (args[0] === "fetch") return "";
      return `${commitFromVerifyArgs(args)}\n`;
    });

    await ensurePullRequestRefs(BASE_SHA, HEAD_SHA, runGit);

    expect(runGit).toHaveBeenCalledTimes(4);
    expect(runGit).toHaveBeenNthCalledWith(2, [
      "fetch",
      "--no-tags",
      "--unshallow",
      "origin",
      BASE_SHA,
      HEAD_SHA
    ]);
  });

  it("checks a shared base and head commit only once", async () => {
    const runGit = vi.fn<GitCommand>(async (args) => {
      if (args[1] === "--is-shallow-repository") return "false\n";
      return `${commitFromVerifyArgs(args)}\n`;
    });

    await ensurePullRequestRefs(SAME_SHA, SAME_SHA, runGit);

    expect(runGit).toHaveBeenCalledTimes(2);
  });

  it("rejects option-shaped or abbreviated revisions before invoking Git", async () => {
    const runGit = vi.fn<GitCommand>();

    await expect(ensurePullRequestRefs("--upload-pack=/tmp/attacker", HEAD_SHA, runGit)).rejects.toThrow(
      "full Git commit object IDs"
    );

    expect(runGit).not.toHaveBeenCalled();
  });

  it("fails closed when Git resolves a fetched object to a different commit", async () => {
    const runGit = vi.fn<GitCommand>(async (args) => {
      if (args[1] === "--is-shallow-repository") return "true\n";
      if (args[0] === "fetch") return "";
      return `${HEAD_SHA}\n`;
    });

    await expect(ensurePullRequestRefs(BASE_SHA, HEAD_SHA, runGit)).rejects.toThrow(
      "did not resolve fetched pull-request object"
    );
  });
});

function commitFromVerifyArgs(args: string[]): string {
  const revision = args[3] ?? "";
  return revision.endsWith("^{commit}") ? revision.slice(0, -9) : "";
}
