import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_MARKER, upsertPullRequestComment, type Octokit, type PullRequest } from "./github.js";

describe("upsertPullRequestComment", () => {
  const pull = { number: 42 } as PullRequest;
  let previousRepository: string | undefined;

  beforeEach(() => {
    previousRepository = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = "preflight-scout/example";
  });

  afterEach(() => {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  });

  it("does not update a forged marker comment owned by another user", async () => {
    const updateComment = vi.fn();
    const createComment = vi.fn().mockResolvedValue({});
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [{
              id: 7,
              body: `attacker planted ${REPORT_MARKER}`,
              user: { id: 123, login: "attacker", type: "User" }
            }]
          }),
          updateComment,
          createComment
        },
        users: {
          getAuthenticated: vi.fn().mockResolvedValue({ data: { id: 999, login: "github-actions[bot]" } })
        }
      }
    } as unknown as Octokit;

    await upsertPullRequestComment(octokit, pull, `trusted report ${REPORT_MARKER}`);

    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledOnce();
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 42 }));
  });

  it("updates an existing marker comment owned by github-actions", async () => {
    const updateComment = vi.fn().mockResolvedValue({});
    const getAuthenticated = vi.fn();
    const octokit = {
      rest: {
        issues: {
          listComments: vi.fn().mockResolvedValue({
            data: [{
              id: 8,
              body: `previous report ${REPORT_MARKER}`,
              user: { id: 41898282, login: "github-actions[bot]", type: "Bot" }
            }]
          }),
          updateComment,
          createComment: vi.fn()
        },
        users: { getAuthenticated }
      }
    } as unknown as Octokit;

    await upsertPullRequestComment(octokit, pull, `replacement report ${REPORT_MARKER}`);

    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 8 }));
    expect(getAuthenticated).not.toHaveBeenCalled();
  });
});
