// @preflight-scout-requires-browser
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBrowserMission } from "@preflight-scout/browser-runner";
import {
  analyzePullRequest,
  readImpactMapArtifact,
  readMissionArtifact,
  readRunResultsArtifact,
  writeAnalysisArtifacts,
  type ImpactMap,
  type LLMClient,
  type LLMMessage,
  type MissionRunResult,
  type QAMission,
  type StructuredJsonOptions
} from "@preflight-scout/core";
import { buildAuthLoginMission } from "./auth.js";
import { createGenericDemoRepo } from "./demo.js";

class GenericRepoSmokeLLM implements LLMClient {
  private browserTurn = 0;

  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName === "impact_map") return impactMap() as T;
    if (options.schemaName === "qa_mission") return mission() as T;
    if (options.schemaName === "browser_decision") return this.browserDecision() as T;
    throw new Error(`Unexpected schema in smoke LLM: ${options.schemaName}`);
  }

  private browserDecision() {
    this.browserTurn += 1;
    const decisions = [
      {
        thought: "The changed promo flow needs a valid coupon check.",
        action: "fill",
        missionStepId: "fill-valid-coupon",
        target: "testid=promo-code",
        value: "SAVE10",
        reason: "Fill the promo field with the valid coupon from the demo contract."
      },
      {
        thought: "Apply the entered coupon.",
        action: "click",
        missionStepId: "apply-valid-coupon",
        target: "testid=apply-promo",
        reason: "Click the apply button to trigger the changed checkout logic."
      },
      {
        thought: "Verify the expected discounted total.",
        action: "assert",
        missionStepId: "verify-discounted-total",
        target: "text=Total: $90.00",
        reason: "The valid coupon should discount the demo cart."
      },
      {
        thought: "Evidence is enough.",
        action: "finish_pass",
        reason: "The generic checkout promo flow passed with browser evidence."
      }
    ];
    return decisions[this.browserTurn - 1] ?? decisions.at(-1);
  }
}

class StaticJsonLLM implements LLMClient {
  constructor(private readonly responses: Record<string, unknown>) {}

  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    const response = this.responses[options.schemaName];
    if (!response) throw new Error(`Unexpected schema in static LLM: ${options.schemaName}`);
    return response as T;
  }
}

class BrowserQueueLLM implements LLMClient {
  private turn = 0;

  constructor(private readonly decisions: unknown[]) {}

  async completeJson<T>(_messages: LLMMessage[], options: StructuredJsonOptions<T>): Promise<T> {
    if (options.schemaName !== "browser_decision") throw new Error(`Unexpected schema in browser queue LLM: ${options.schemaName}`);
    const decision = this.decisions[this.turn] ?? this.decisions.at(-1);
    this.turn += 1;
    return decision as T;
  }
}

describe("generic repo smoke", () => {
  let dir: string;
  let repoRoot: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-generic-smoke-"));
    repoRoot = (await createGenericDemoRepo({ output: path.join(dir, "shop") })).root;
    server = createServer(async (req, res) => {
      const requestPath = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
      const filePath = path.join(repoRoot, requestPath.replace(/^\//, ""));
      const body = await readFile(filePath, "utf8");
      res.writeHead(200, { "content-type": filePath.endsWith(".js") ? "text/javascript" : "text/html" });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start smoke server");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  it("analyzes a fresh arbitrary repo, runs a browser mission, and writes human reports", async () => {
    const llm = new GenericRepoSmokeLLM();
    const analysis = await analyzePullRequest({
      root: repoRoot,
      base: "HEAD~1",
      head: "HEAD",
      llm
    });
    const runResult = await runBrowserMission(analysis.mission.automationCandidates[0]!, {
      baseUrl,
      contract: analysis.contract,
      llm,
      outputDir: path.join(dir, "run"),
      headless: true,
      maxTurns: 6
    });
    const runResults: MissionRunResult[] = [runResult];
    await writeAnalysisArtifacts(path.join(dir, "run"), {
      impactMap: analysis.impactMap,
      mission: analysis.mission,
      runResults
    });

    expect(analysis.pullRequest.files.map((file) => file.path)).toEqual(expect.arrayContaining(["index.html", "src/checkout.js"]));
    expect(runResult.status).toBe("passed");
    expect(runResult.evidence?.tracePath).toContain("trace.zip");
    await expect(readImpactMapArtifact(path.join(dir, "run", "impact-map.json"))).resolves.toMatchObject({ summary: expect.stringContaining("promo") });
    await expect(readMissionArtifact(path.join(dir, "run", "mission.json"))).resolves.toMatchObject({ title: "Validate generic checkout promo feedback" });
    await expect(readRunResultsArtifact(path.join(dir, "run", "run-results.json"))).resolves.toHaveLength(1);
    await expect(readFile(path.join(dir, "run", "report.md"), "utf8")).resolves.toContain("Generic checkout valid coupon");
    await expect(readFile(path.join(dir, "run", "report.md"), "utf8")).resolves.toContain("trace.zip");
    await expect(readFile(path.join(dir, "run", "report.html"), "utf8")).resolves.toContain("Generic checkout valid coupon");
  });

  it("bootstraps auth storage and validates the authenticated dashboard demo", async () => {
    const authRoot = (await createGenericDemoRepo({ output: path.join(dir, "auth-dashboard"), scenario: "auth-dashboard" })).root;
    const authServer = createServer(async (req, res) => {
      const requestPath = req.url === "/" || req.url === "/login" ? "/index.html" : req.url ?? "/index.html";
      const filePath = path.join(authRoot, requestPath.replace(/^\//, ""));
      const body = await readFile(filePath, "utf8");
      res.writeHead(200, { "content-type": filePath.endsWith(".js") ? "text/javascript" : "text/html" });
      res.end(body);
    });
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    const address = authServer.address();
    if (!address || typeof address === "string") throw new Error("Could not start auth smoke server");
    const authBaseUrl = `http://127.0.0.1:${address.port}`;
    const storageState = path.join(dir, "auth-dashboard-state.json");
    process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL = "qa@example.com";
    process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD = "password123";

    try {
      const analysis = await analyzePullRequest({
        root: authRoot,
        base: "HEAD~1",
        head: "HEAD",
        llm: new StaticJsonLLM({
          impact_map: authImpactMap(),
          qa_mission: authMission()
        })
      });
      const loginResult = await runBrowserMission(buildAuthLoginMission(analysis.contract, { role: "qa_user" }), {
        baseUrl: authBaseUrl,
        contract: analysis.contract,
        llm: new BrowserQueueLLM([
          { thought: "Enter email.", action: "fill", missionStepId: "login-and-confirm-session", target: "label=Email", value: "env:PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL", reason: "Use configured email." },
          { thought: "Enter password.", action: "fill", missionStepId: "login-and-confirm-session", target: "label=Password", value: "env:PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD", reason: "Use configured password." },
          { thought: "Submit.", action: "click", missionStepId: "login-and-confirm-session", target: "testid=sign-in", reason: "Submit login form." },
          { thought: "Verify signed-in marker.", action: "assert", missionStepId: "confirm-signed-in-marker", target: "testid=welcome", reason: "The reviewed signed-in marker is visible." },
          { thought: "Done.", action: "finish_pass", reason: "Authenticated state observed." }
        ]),
        outputDir: path.join(dir, "auth-login"),
        headless: true,
        maxTurns: 7,
        saveStorageState: storageState
      });
      const missionResult = await runBrowserMission(analysis.mission.automationCandidates[0]!, {
        baseUrl: authBaseUrl,
        contract: analysis.contract,
        llm: new BrowserQueueLLM([
          { thought: "Check admin analytics.", action: "assert", missionStepId: "assert-admin-analytics", target: "text=Admin analytics", reason: "Admin analytics panel should be visible after the PR." },
          { thought: "Check metric.", action: "assert", missionStepId: "assert-conversion-rate", target: "text=Conversion rate: 12%", reason: "Changed analytics metric should render." },
          { thought: "Done.", action: "finish_pass", reason: "Authenticated dashboard analytics passed." }
        ]),
        outputDir: path.join(dir, "auth-run"),
        headless: true,
        maxTurns: 5,
        storageState
      });
      await writeAnalysisArtifacts(path.join(dir, "auth-run"), {
        impactMap: analysis.impactMap,
        mission: analysis.mission,
        runResults: [missionResult]
      });

      expect(loginResult.status).toBe("passed");
      expect(missionResult.status).toBe("passed");
      await expect(readFile(storageState, "utf8")).resolves.toContain("demo-user");
      await expect(readFile(path.join(dir, "auth-run", "report.md"), "utf8")).resolves.toContain("Verdict: **Ready for human review**");
      await expect(readFile(path.join(dir, "auth-run", "report.md"), "utf8")).resolves.toContain("Admin analytics");
    } finally {
      await new Promise<void>((resolve, reject) => authServer.close((error) => (error ? reject(error) : resolve())));
      delete process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL;
      delete process.env.PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD;
    }
  }, 15_000);
});

function impactMap(): ImpactMap {
  return {
    summary: "The PR changes generic checkout promo validation and adds expired coupon feedback.",
    risk: "medium",
    changedFiles: [
      { path: "index.html", status: "modified" },
      { path: "src/checkout.js", status: "modified" }
    ],
    affectedRoutes: [{ path: "/", file: "index.html", kind: "page" }],
    affectedAreas: [
      {
        kind: "component",
        name: "Checkout promo code form",
        evidence: ["index.html adds a promo error role=alert", "src/checkout.js changes promo validation behavior"],
        risk: "medium"
      }
    ],
    suggestedRoles: ["guest"],
    unknowns: []
  };
}

function mission(): QAMission {
  const areas = impactMap().affectedAreas;
  return {
    id: "generic-checkout-promo",
    title: "Validate generic checkout promo feedback",
    risk: "medium",
    summary: "Confirm the changed promo code behavior still discounts valid coupons and reports expired coupons.",
    affectedAreas: areas,
    manualChecklist: [
      "Apply SAVE10 and verify the checkout total changes to $90.00.",
      "Apply EXPIRED10 and verify an accessible expired-promo error appears while the total remains $100.00."
    ],
    edgeCases: ["Empty promo code", "Unknown promo code", "Repeated apply clicks"],
    automationCandidates: [
      {
        id: "generic-valid-coupon",
        title: "Generic checkout valid coupon",
        role: "guest",
        startPath: "/",
        risk: "medium",
        reason: ["The changed checkout JavaScript controls promo discount behavior."],
        steps: [{
          id: "fill-valid-coupon",
          instruction: "Enter the reviewed valid coupon.",
          action: "fill",
          policyLabel: "fill",
          target: "testid=promo-code",
          value: "SAVE10"
        }, {
          id: "apply-valid-coupon",
          instruction: "Apply the reviewed coupon.",
          action: "click",
          policyLabel: "click",
          target: "testid=apply-promo"
        }, {
          id: "verify-discounted-total",
          instruction: "Verify the discounted total.",
          action: "assert_text",
          target: "text=Total: $90.00",
          expected: "Total: $90.00"
        }]
      }
    ],
    unknowns: []
  };
}

function authImpactMap(): ImpactMap {
  return {
    summary: "The PR adds an authenticated admin analytics panel to the dashboard.",
    risk: "high",
    changedFiles: [
      { path: "index.html", status: "modified" },
      { path: "src/auth-dashboard.js", status: "modified" }
    ],
    affectedRoutes: [{ path: "/", file: "index.html", kind: "page" }],
    affectedAreas: [
      {
        kind: "auth",
        name: "Authenticated dashboard admin analytics",
        evidence: ["index.html adds the admin analytics panel", "src/auth-dashboard.js reveals the panel after login"],
        risk: "high"
      }
    ],
    suggestedRoles: ["qa_user"],
    unknowns: []
  };
}

function authMission(): QAMission {
  const areas = authImpactMap().affectedAreas;
  return {
    id: "auth-dashboard-admin-analytics",
    title: "Validate authenticated dashboard analytics",
    risk: "high",
    summary: "Confirm an authenticated user can see the new admin analytics panel after login.",
    affectedAreas: areas,
    manualChecklist: ["Log in as qa_user and verify the admin analytics panel appears."],
    edgeCases: ["Missing session", "Invalid credentials", "Unauthenticated direct dashboard load"],
    automationCandidates: [
      {
        id: "auth-dashboard-visible-analytics",
        title: "Authenticated dashboard analytics panel",
        role: "qa_user",
        startPath: "/",
        risk: "high",
        reason: ["The changed dashboard JavaScript controls authenticated analytics visibility."],
        steps: [{
          id: "assert-admin-analytics",
          instruction: "Verify the admin analytics heading.",
          action: "assert_visible",
          target: "text=Admin analytics"
        }, {
          id: "assert-conversion-rate",
          instruction: "Verify the conversion metric.",
          action: "assert_text",
          target: "text=Conversion rate: 12%",
          expected: "Conversion rate: 12%"
        }]
      }
    ],
    unknowns: []
  };
}
