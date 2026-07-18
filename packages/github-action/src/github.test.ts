import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_MARKER, resolveActionAppUrl, upsertPullRequestComment, type Octokit, type PullRequest } from "./github.js";

describe("upsertPullRequestComment", () => {
  const pull = { number: 42 } as PullRequest;
  let previousRepository: string | undefined;
  let previousAppUrl: string | undefined;

  beforeEach(() => {
    previousRepository = process.env.GITHUB_REPOSITORY;
    previousAppUrl = process.env.PREFLIGHT_SCOUT_APP_URL;
    process.env.GITHUB_REPOSITORY = "preflight-scout/example";
    delete process.env.PREFLIGHT_SCOUT_APP_URL;
  });

  afterEach(() => {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
    if (previousAppUrl === undefined) delete process.env.PREFLIGHT_SCOUT_APP_URL;
    else process.env.PREFLIGHT_SCOUT_APP_URL = previousAppUrl;
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

describe("resolveActionAppUrl", () => {
  const pull = { number: 42, head: { sha: "a".repeat(40) } } as PullRequest;
  const contract = {
    app: { localUrl: "http://127.0.0.1:4173" },
    criticalFlows: [],
    sensitiveAreas: [],
    dangerousActions: { allowed: [], requireApproval: [], forbidden: [] },
    testData: {},
    unknowns: []
  };
  let previousAppUrl: string | undefined;

  beforeEach(() => {
    previousAppUrl = process.env.PREFLIGHT_SCOUT_APP_URL;
    delete process.env.PREFLIGHT_SCOUT_APP_URL;
  });

  afterEach(() => {
    if (previousAppUrl === undefined) delete process.env.PREFLIGHT_SCOUT_APP_URL;
    else process.env.PREFLIGHT_SCOUT_APP_URL = previousAppUrl;
  });

  it("does not let generic environment or deployment URLs override explicit local selection", async () => {
    process.env.PREFLIGHT_SCOUT_APP_URL = "https://generic.example.com";
    const listDeployments = vi.fn();
    const octokit = { rest: { repos: { listDeployments } } } as unknown as Octokit;

    await expect(resolveActionAppUrl({
      targetEnv: "local",
      contract,
      octokit,
      pull,
      detectDeploymentUrl: true
    })).resolves.toBe("http://127.0.0.1:4173");
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("fails closed before deployment discovery when explicit staging is unavailable", async () => {
    process.env.PREFLIGHT_SCOUT_APP_URL = "https://generic.example.com";
    const listDeployments = vi.fn();
    const octokit = { rest: { repos: { listDeployments } } } as unknown as Octokit;

    await expect(resolveActionAppUrl({
      targetEnv: "staging",
      contract,
      octokit,
      pull,
      detectDeploymentUrl: true
    })).rejects.toThrow("No staging app URL configured");
    expect(listDeployments).not.toHaveBeenCalled();
  });

  it("retains generic environment URL discovery for automatic selection", async () => {
    process.env.PREFLIGHT_SCOUT_APP_URL = "https://generic.example.com";
    const octokit = { rest: { repos: { listDeployments: vi.fn() } } } as unknown as Octokit;

    await expect(resolveActionAppUrl({
      targetEnv: "auto",
      contract,
      octokit,
      pull,
      detectDeploymentUrl: true
    })).resolves.toBe("https://generic.example.com");
  });
});
