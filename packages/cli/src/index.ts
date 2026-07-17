#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  analyzePullRequest,
  browserCredentialKindForEnvName,
  createDefaultLLMFromEnv,
  approveAction,
  indexRepository,
  loadContract,
  readImpactMapArtifact,
  readMissionArtifact,
  readRunResultArtifact,
  readRunResultsArtifact,
  promoteRegressionTest,
  resolveTargetUrl,
  type MissionRunResult,
  type ProgressCallback,
  type QAContract,
  writeAnalysisArtifacts,
  writeInitialContract,
  writeTextEnsuringDir
} from "@preflight-scout/core";
import { canonicalizeStorageStatePath, checkBrowserAvailability, installChromium, printHtmlReportToPdf, validateStorageStateInput, verifyStoredAuthentication, writeStorageStateMetadata } from "@preflight-scout/browser-runner";
import { buildAgentEnvironment, renderAgentPrompt, runAgentAuthLogin, runAgentExecution, type AgentExecKind, type AgentExecResult } from "@preflight-scout/agent-exec";
import { executeMissionViaPromptTool, listMCPTools } from "@preflight-scout/mcp";
import { resolveReviewedAnalysis } from "./analysis.js";
import { buildAuthLoginMission, resolveAuthStorageStatePath } from "./auth.js";
import { createGenericDemoRepo } from "./demo.js";
import { renderDoctorReport, runDoctor } from "./doctor.js";
import { assertCanWriteConfig, createProgressReporter, loadEnvFile, parseTargetEnv, renderInitSummary, resolveAnalysisOutputDir, resolveBaseRef, resolveContractOutputDir, resolveRepoPath, resolveStorageOptions } from "./local.js";
import { runAutomationCandidates, safeArtifactSegment, selectAutomationCandidates } from "./missions.js";
import { openReport, renderArtifactSummary } from "./summary.js";
import { checkForUpdates, renderUpdateCheck } from "./update.js";

const program = new Command();

program
  .name("preflight-scout")
  .description("Release QA for pull requests")
  .version("0.1.4");

program
  .command("install-browser")
  .description("Install the Playwright Chromium build used by browser missions")
  .option("--with-deps", "also install operating-system browser dependencies", false)
  .action(async (options) => {
    await installChromium({ withDeps: options.withDeps });
    console.log("Playwright Chromium is installed for Preflight Scout.");
  });

program
  .command("update-check")
  .description("Check CLI and Agent Skill versions without changing installed software")
  .option("--skill-version <version>", "exact installed Agent Skill version to verify")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options) => {
    const cliVersion = program.version();
    if (!cliVersion) throw new Error("Preflight Scout CLI version metadata is missing.");
    const result = await checkForUpdates({
      cliVersion,
      skillVersion: options.skillVersion
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : renderUpdateCheck(result));
    if (!result.compatible) process.exitCode = 1;
  });

program
  .command("approve")
  .description("Approve a gated action for subsequent browser runs")
  .option("--root <path>", "repository root", process.cwd())
  .requiredOption("--action <action>", "action label from dangerousActions.requireApproval")
  .option("--reason <reason>", "approval reason")
  .action(async (options) => {
    const root = path.resolve(options.root);
    const state = await approveAction(root, options.action, options.reason);
    console.log(JSON.stringify(state, null, 2));
  });

program
  .command("auth")
  .description("Manage local browser authentication state")
  .command("login")
  .description("Use the LLM browser agent to log in and save Playwright storageState")
  .option("--root <path>", "repository root", process.cwd())
  .option("--env-file <path>", "load environment variables before login", ".env.preflight-scout.local")
  .option("--url <url>", "app URL; defaults to PREFLIGHT_SCOUT_APP_URL or .preflight-scout/config.yml")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging")
  .option("--role <name>", "auth role from .preflight-scout/config.yml")
  .option("--login-url <path-or-url>", "login path or URL")
  .option("--save-storage-state <path>", "where to write Playwright storageState JSON")
  .option("--agent <kind>", "external sandbox mode: delegate login to codex, claude, gemini, or custom agent with its own browser tools")
  .option("--command <command>", "custom command or command override for --agent")
  .option("--arg <arg...>", "custom command args for --agent")
  .option("--agent-timeout-ms <ms>", "maximum wall-clock time for delegated auth agent execution", "600000")
  .option("--agent-heartbeat-ms <ms>", "heartbeat interval while waiting for delegated auth agent execution", "30000")
  .option("--agent-probe-timeout-ms <ms>", "maximum wall-clock time for delegated runtime capability probe", "120000")
  .option("--probe-agent-runtime", "run delegated runtime capability probe before auth", false)
  .option("--skip-agent-probe", "deprecated alias; delegated runtime probe is skipped unless --probe-agent-runtime is set", false)
  .option("--allow-blocked", "exit zero even when auth is blocked or storage state is not created", false)
  .option("--max-turns <count>", "maximum LLM browser turns for login")
  .option("--no-trace", "disable Playwright trace.zip capture")
  .option("--headed", "show browser UI", false)
  .option("--output-dir <path>", "artifact output directory")
  .action(async (options) => {
    const progress = createProgressReporter();
    const root = path.resolve(options.root);
    progress("Loading environment and QA contract");
    await loadEnvFile(root, options.envFile);
    const contract = await loadContract(root);
    const appUrl = resolveTargetUrl(contract, { url: options.url, target: options.target, env: options.env ?? contract.defaults?.targetEnv ?? "auto" });
    const llm = options.agent ? undefined : createDefaultLLMFromEnv();
    if (!options.agent && !llm) throw new Error("Auth login requires an LLM provider.");
    progress(options.agent ? "Building delegated auth login prompt" : "Building parent-owned Playwright auth login mission");
    const mission = buildAuthLoginMission(contract, { role: options.role, startPath: options.loginUrl, saveStorageState: options.saveStorageState });
    const saveStorageState = await canonicalizeStorageStatePath(
      await resolveAuthStorageStatePath(root, contract, { role: mission.role, saveStorageState: options.saveStorageState })
    );
    const authOutputRole = safeArtifactSegment(mission.role ?? "default", "auth role");
    const outputDir = options.outputDir
      ? resolveRepoPath(root, options.outputDir)
      : await resolveContractOutputDir(root, path.join(".preflight-scout", "runs", "auth", authOutputRole));
    await writeTextEnsuringDir(path.join(outputDir, "auth-mission.json"), `${JSON.stringify(mission, null, 2)}\n`);
    const canonicalOutputDir = await fs.realpath(outputDir);
    if (isPathWithin(canonicalOutputDir, saveStorageState)) {
      throw new Error("Authenticated storage state must be saved outside the auth evidence output directory.");
    }
    if (options.agent) {
      progress(`Delegating auth login to external ${options.agent} sandbox`);
      const agentTimeoutMs = parseOptionalPositiveInteger(options.agentTimeoutMs, "--agent-timeout-ms") ?? 1000 * 60 * 10;
      const agentHeartbeatMs = parseOptionalPositiveInteger(options.agentHeartbeatMs, "--agent-heartbeat-ms") ?? 1000 * 30;
      const agentKind = options.agent as AgentExecKind;
      const delegatedContract = selectContractRoles(contract, mission.role ? [mission.role] : []);
      const agentEnv = buildAgentEnvironment(agentKind, {
        credentialEnvNames: selectedRoleCredentialEnvNames(contract, mission.role ? [mission.role] : [])
      });
      await Promise.all([
        fs.rm(saveStorageState, { force: true }),
        fs.rm(`${saveStorageState}.preflight-scout.json`, { force: true })
      ]);
      if (options.probeAgentRuntime && !options.skipAgentProbe) {
        const probeTimeoutMs = parseOptionalPositiveInteger(options.agentProbeTimeoutMs, "--agent-probe-timeout-ms") ?? 1000 * 60 * 2;
        const probeResult = await runDelegatedAuthCapabilityProbe({
          kind: agentKind,
          appUrl,
          contract: delegatedContract,
          outputDir,
          cwd: outputDir,
          targetRoot: root,
          command: options.command,
          args: options.arg,
          timeoutMs: probeTimeoutMs,
          heartbeatMs: agentHeartbeatMs,
          env: agentEnv,
          progress
        });
        if (!probeResult.ok) {
          await fs.rm(saveStorageState, { force: true });
          await writeStorageStateMetadata(saveStorageState, {
            status: "invalid",
            missionId: mission.id,
            savedAt: new Date().toISOString(),
            reason: probeResult.reason,
            evidenceDir: outputDir
          });
          console.log(renderAuthLoginFailureSummary({
            status: "blocked",
            reason: probeResult.reason,
            outputDir,
            storageState: saveStorageState
          }));
          if (!options.allowBlocked) process.exitCode = 1;
          return;
        }
      }
      let agentResult: AgentExecResult;
      try {
        const roleConfig = delegatedContract.auth?.roles?.[mission.role ?? ""];
        agentResult = await runAgentAuthLogin({
          kind: agentKind,
          appUrl,
          role: mission.role ?? "default",
          usernameEnv: roleConfig?.usernameEnv,
          passwordEnv: roleConfig?.passwordEnv,
          signedInTarget: roleConfig!.signedInTarget!,
          storageStateOutput: saveStorageState,
          evidenceDir: outputDir,
          startPath: mission.startPath,
          cwd: outputDir,
          targetRoot: root,
          command: options.command,
          args: options.arg,
          timeoutMs: agentTimeoutMs,
          heartbeatMs: agentHeartbeatMs,
          onProgress: progress,
          env: agentEnv,
          streamOutput: "signals"
        });
      } catch (error) {
        const reason = `Delegated auth agent failed: ${errorMessage(error)}`;
        await fs.rm(saveStorageState, { force: true });
        await writeStorageStateMetadata(saveStorageState, {
          status: "invalid",
          missionId: mission.id,
          savedAt: new Date().toISOString(),
          reason,
          evidenceDir: outputDir
        });
        await writeTextEnsuringDir(path.join(outputDir, "agent-error.txt"), `${reason}\n`);
        console.log(renderAuthLoginFailureSummary({
          status: "blocked",
          reason,
          outputDir,
          storageState: saveStorageState
        }));
        if (!options.allowBlocked) process.exitCode = 1;
        return;
      }
      await writeTextEnsuringDir(path.join(outputDir, "agent-stdout.md"), agentResult.stdout || "(no stdout)\n");
      if (agentResult.stderr) await writeTextEnsuringDir(path.join(outputDir, "agent-stderr.log"), agentResult.stderr);
      const storageProblem = await validateStorageStateInput(saveStorageState);
      const verificationSignalProblem = agentResult.stdout.split(/\r?\n/u).some((line) => line.trim() === "PREFLIGHT_SCOUT_AUTH_VERIFIED=1")
        ? undefined
        : "Delegated auth agent did not emit the required PREFLIGHT_SCOUT_AUTH_VERIFIED=1 signal after checking the reviewed signed-in marker.";
      const signedInTarget = delegatedContract.auth?.roles?.[mission.role ?? ""]?.signedInTarget;
      const markerProblem = agentResult.exitCode === 0 && !storageProblem && !verificationSignalProblem && signedInTarget
        ? await verifyStoredAuthentication({
            baseUrl: appUrl,
            startPath: mission.startPath ?? "/",
            signedInTarget,
            storageState: saveStorageState,
            headless: true
          })
        : undefined;
      const authVerificationProblem = storageProblem ?? verificationSignalProblem ?? markerProblem;
      if (agentResult.exitCode === 0 && !authVerificationProblem) {
        await fs.chmod(saveStorageState, 0o600);
        await writeStorageStateMetadata(saveStorageState, {
          status: "valid",
          missionId: mission.id,
          savedAt: new Date().toISOString(),
          evidenceDir: outputDir
        });
        console.log(`Saved authenticated storage state: ${saveStorageState}`);
        console.log(`Evidence: ${outputDir}`);
        return;
      }
      const reason = deriveDelegatedAuthFailureReason(authVerificationProblem, agentResult);
      await fs.rm(saveStorageState, { force: true });
      await writeStorageStateMetadata(saveStorageState, {
        status: "invalid",
        missionId: mission.id,
        savedAt: new Date().toISOString(),
        reason,
        evidenceDir: outputDir
      });
      console.log(renderAuthLoginFailureSummary({
        status: "blocked",
        reason,
        outputDir,
        storageState: saveStorageState
      }));
      if (!options.allowBlocked) process.exitCode = agentResult.exitCode && agentResult.exitCode !== 0 ? agentResult.exitCode : 1;
      return;
    }
    progress(`Running parent-owned Playwright auth login mission for role ${mission.role ?? "default"}`);
    const [runResult] = await runAutomationCandidates([mission], {
      appUrl,
      contract,
      llm: llm!,
      root,
      outputDir,
      headless: options.headed ? false : contract.defaults?.headless ?? true,
      maxTurns: parseOptionalPositiveInteger(options.maxTurns, "--max-turns") ?? contract.defaults?.maxTurns ?? 25,
      saveStorageState,
      trace: options.trace && contract.defaults?.trace !== false,
      progress
    });
    if (runResult?.status !== "passed") {
      console.log(renderAuthLoginFailureSummary({
        status: runResult?.status ?? "blocked",
        reason: runResult?.results.at(-1)?.message,
        outputDir,
        storageState: saveStorageState,
        evidence: runResult?.evidence
      }));
      if (!options.allowBlocked) process.exitCode = 1;
      return;
    }
    console.log(`Saved authenticated storage state: ${saveStorageState}`);
    console.log(`Evidence: ${outputDir}`);
  });

program
  .command("init")
  .description("Create local Preflight Scout config from repo context")
  .option("--root <path>", "repository root", process.cwd())
  .option("--dry-run", "print repo context without writing files", false)
  .option("--force", "overwrite existing .preflight-scout/config.yml", false)
  .option("--no-llm", "write a blank reviewed-by-human contract instead of asking the configured LLM")
  .option("--env-file <path>", "load environment variables before init", ".env.preflight-scout.local")
  .option("--url <url>", "default app URL")
  .option("--local-url <url>", "local development app URL")
  .option("--staging-url <url>", "staging or preview app URL")
  .option("--target <name>", "named app target for supplied URLs, for example frontend or admin")
  .option("--login-url <path-or-url>", "login path or URL")
  .option("--role <name>", "auth role name for the supplied credential env vars")
  .option("--username-env <name>", "environment variable containing the test username/email")
  .option("--password-env <name>", "environment variable containing the test password")
  .option("--storage-state <path>", "Playwright storageState path to load for authenticated runs")
  .option("--save-storage-state <path>", "Playwright storageState path to write after a login/session run")
  .option("--base <ref>", "default PR base ref")
  .option("--target-env <env>", "default target URL environment: auto, local, or staging")
  .option("--output-dir <path>", "default run artifact directory")
  .action(async (options) => {
    const progress = createProgressReporter();
    const root = path.resolve(options.root);
    progress("Loading environment");
    await loadEnvFile(root, options.envFile);
    progress("Indexing repository for initial QA contract");
    const repoIndex = await indexRepository(root);
    if (options.dryRun) {
      console.log(JSON.stringify(repoIndex, null, 2));
      console.log("\nRun without --dry-run to create .preflight-scout files.");
      return;
    }
    await assertCanWriteConfig(root, options.force);
    const llm = options.llm ? createDefaultLLMFromEnv() : undefined;
    if (options.llm && !llm) {
      throw new Error([
        "preflight-scout init needs an LLM provider.",
        "For codex-exec, set PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec. Optionally set PREFLIGHT_SCOUT_EXEC_MODEL and PREFLIGHT_SCOUT_EXEC_REASONING_EFFORT.",
        "For API providers, set OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
        "Or pass --no-llm for a blank contract."
      ].join("\n"));
    }
    progress(options.llm ? "Calling LLM init agent" : "Writing blank human-reviewed contract");
    const contract = await writeInitialContract(root, repoIndex, llm, {
      appUrl: options.url,
      localUrl: options.localUrl,
      stagingUrl: options.stagingUrl,
      target: options.target,
      loginUrl: options.loginUrl,
      role: options.role,
      usernameEnv: options.usernameEnv,
      passwordEnv: options.passwordEnv,
      storageState: options.storageState,
      saveStorageState: options.saveStorageState,
      baseRef: options.base,
      targetEnv: parseTargetEnv(options.targetEnv, "--target-env"),
      outputDir: options.outputDir
    });
    console.log(renderInitSummary(root, contract));
  });

program
  .command("demo")
  .description("Create a generic checkout demo repository with one PR-style change")
  .requiredOption("--output <path>", "directory where the standalone demo repo should be created")
  .option("--scenario <name>", "checkout or auth-dashboard", "checkout")
  .option("--force", "delete the output directory first", false)
  .action(async (options) => {
    if (options.scenario !== "checkout" && options.scenario !== "auth-dashboard") {
      throw new Error("--scenario must be checkout or auth-dashboard.");
    }
    const result = await createGenericDemoRepo({ output: options.output, force: options.force, scenario: options.scenario });
    console.log(`Created generic demo repo at ${result.root}`);
    console.log("");
    console.log("Try it:");
    console.log(`  cd ${result.root}`);
    console.log("  python3 -m http.server 4173");
    console.log("");
    console.log("Then, in another terminal:");
    console.log("  preflight-scout analyze");
    if (options.scenario === "auth-dashboard") {
      console.log("  PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL=qa@example.com PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD=password123 preflight-scout auth login");
    }
    console.log("  preflight-scout run");
  });

program
  .command("analyze")
  .description("Analyze a PR diff and generate a QA impact report")
  .option("--root <path>", "repository root", process.cwd())
  .option("--base <ref>", "base git ref; defaults to PREFLIGHT_SCOUT_BASE_REF, config defaults, or origin/HEAD")
  .option("--head <ref>", "head git ref", "HEAD")
  .option("--title <text>", "PR title or change title to include in LLM analysis")
  .option("--body <text>", "PR body or change description to include in LLM analysis")
  .option("--url <url>", "app URL context to validate; accepted for parity with doctor/run")
  .option("--target <name>", "named app target context from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL environment context: auto, local, or staging")
  .option("--env-file <path>", "load environment variables before analysis", ".env.preflight-scout.local")
  .option("--json", "print JSON instead of Markdown", false)
  .option("--print-report", "print the full Markdown report instead of a short summary", false)
  .option("--open-report", "open report.html after writing artifacts", false)
  .option("--pdf", "write report.pdf beside report.html", false)
  .option("--write-report <path>", "write Markdown report to a file")
  .option("--output-dir <path>", "artifact output directory")
  .action(async (options) => {
    const progress = createProgressReporter(!options.printReport);
    const root = path.resolve(options.root);
    progress("Loading environment and QA contract");
    await loadEnvFile(root, options.envFile);
    const contract = await loadContract(root);
    // Validate contract-derived filesystem policy before starting either LLM
    // call. This keeps legacy or hand-edited unsafe configs fail-fast.
    const outputDir = await resolveAnalysisOutputDir(root, options.outputDir, contract.defaults?.outputDir);
    const base = await resolveBaseRef(root, options.base, contract);
    const appUrl = resolveOptionalAnalysisTargetUrl(contract, { url: options.url, target: options.target, env: options.env });
    if (appUrl) progress(`Analysis target context: ${appUrl}`);
    progress("Starting PR impact analysis");
    const result = await analyzePullRequest({
      root,
      base,
      head: options.head,
      title: options.title,
      body: options.body,
      progress
    });
    progress(`Writing analysis artifacts to ${outputDir}`);
    await writeAnalysisArtifacts(outputDir, {
      impactMap: result.impactMap,
      mission: result.mission,
      markdown: result.markdown
    });
    if (options.writeReport) {
      await writeTextEnsuringDir(path.resolve(options.writeReport), result.markdown);
    }
    const reportPath = path.join(outputDir, "report.html");
    if (options.pdf) {
      progress("Rendering PDF report");
      await printHtmlReportToPdf({ htmlPath: reportPath, pdfPath: path.join(outputDir, "report.pdf") });
    }
    if (options.openReport) await openReport(reportPath, root);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (options.printReport) {
      console.log(result.markdown);
    } else {
      console.log(renderArtifactSummary({
        runDir: outputDir,
        impactMap: result.impactMap,
        mission: result.mission,
        appUrl,
        pdf: options.pdf
      }));
    }
  });

program
  .command("run")
  .description("Run LLM-ranked browser missions against a URL")
  .option("--root <path>", "repository root", process.cwd())
  .option("--base <ref>", "base git ref; defaults to PREFLIGHT_SCOUT_BASE_REF, config defaults, or origin/HEAD")
  .option("--head <ref>", "head git ref", "HEAD")
  .option("--title <text>", "PR title or change title to include in LLM analysis")
  .option("--body <text>", "PR body or change description to include in LLM analysis")
  .option("--analysis-dir <path>", "reuse impact-map.json and mission.json from a previous preflight-scout analyze run")
  .option("--env-file <path>", "load environment variables before running", ".env.preflight-scout.local")
  .option("--url <url>", "app URL; defaults to PREFLIGHT_SCOUT_APP_URL or .preflight-scout/config.yml")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging")
  .option("--mission-id <id>", "run one automation candidate by id")
  .option("--all-candidates", "run every automation candidate sequentially", false)
  .option("--mission-limit <count>", "number of LLM-ranked automation candidates to run")
  .option("--max-turns <count>", "maximum LLM browser turns per mission")
  .option("--storage-state <path>", "Playwright storageState JSON to load before the browser mission")
  .option("--save-storage-state <path>", "write Playwright storageState JSON after the browser mission")
  .option("--no-trace", "disable Playwright trace.zip capture")
  .option("--headed", "show browser UI", false)
  .option("--open-report", "open report.html after writing artifacts", false)
  .option("--pdf", "write report.pdf beside report.html", false)
  .option("--print-report", "print the full Markdown report instead of a short summary", false)
  .option("--output-dir <path>", "artifact output directory")
  .action(async (options) => {
    const progress = createProgressReporter(!options.printReport);
    const root = path.resolve(options.root);
    progress("Loading environment and QA contract");
    await loadEnvFile(root, options.envFile);
    const contract = await loadContract(root);
    const outputDir = await resolveAnalysisOutputDir(root, options.outputDir, contract.defaults?.outputDir);
    const analysisDir = options.analysisDir ? resolveRepoPath(root, options.analysisDir) : undefined;
    const analysis = await resolveReviewedAnalysis({
      analysisDir,
      analyze: () => analyzeForRun(root, contract, {
        base: options.base,
        head: options.head,
        title: options.title,
        body: options.body,
        progress
      })
    });
    if (analysisDir) progress(`Reusing analysis artifacts from ${analysisDir}`);
    const appUrl = resolveTargetUrl(contract, { url: options.url, target: options.target, env: options.env ?? contract.defaults?.targetEnv ?? "auto" });
    const llm = createDefaultLLMFromEnv();
    if (!llm) throw new Error("Browser execution requires an LLM provider.");
    const selectedMissions = selectAutomationCandidates(analysis.mission, {
      missionId: options.missionId,
      allCandidates: options.allCandidates || contract.defaults?.allCandidates,
      missionLimit: parseOptionalPositiveInteger(options.missionLimit, "--mission-limit") ?? contract.defaults?.missionLimit
    });
    progress(`Selected ${selectedMissions.length} browser mission(s)`);
    const storage = await resolveStorageOptions(root, contract, selectedMissions, {
      storageState: options.storageState,
      saveStorageState: options.saveStorageState
    });
    if (storage.storageState) progress(`Using storage state ${storage.storageState}`);
    const storageProblem = storage.storageState ? await validateStorageStateInput(storage.storageState) : undefined;
    const runResults = storageProblem
      ? blockMissionsForInvalidStorage(selectedMissions, storageProblem, progress)
      : await runAutomationCandidates(selectedMissions, {
          appUrl,
          contract,
          llm,
          root,
          outputDir,
          headless: options.headed ? false : contract.defaults?.headless ?? true,
          maxTurns: parseOptionalPositiveInteger(options.maxTurns, "--max-turns") ?? contract.defaults?.maxTurns,
          storageState: storage.storageState,
          saveStorageState: storage.saveStorageState,
          trace: options.trace && contract.defaults?.trace !== false,
          progress
        });
    const runResult = runResults[0];
    await writeAnalysisArtifacts(outputDir, {
      impactMap: analysis.impactMap,
      mission: analysis.mission,
      runResult,
      runResults
    });
    if (options.pdf) {
      progress("Rendering PDF report");
      await printHtmlReportToPdf({ htmlPath: path.join(outputDir, "report.html"), pdfPath: path.join(outputDir, "report.pdf") });
    }
    if (options.openReport) await openReport(path.join(outputDir, "report.html"), root);
    console.log(options.printReport
      ? await fs.readFile(path.join(outputDir, "report.md"), "utf8")
      : renderArtifactSummary({
          runDir: outputDir,
          impactMap: analysis.impactMap,
          mission: analysis.mission,
          runResults,
          appUrl,
          pdf: options.pdf
        }));
  });

program
  .command("replay")
  .description("Run an existing mission artifact against a URL without re-analyzing the PR")
  .option("--root <path>", "repository root", process.cwd())
  .requiredOption("--mission <path>", "path to mission.json")
  .option("--env-file <path>", "load environment variables before running", ".env.preflight-scout.local")
  .option("--url <url>", "app URL; defaults to PREFLIGHT_SCOUT_APP_URL or .preflight-scout/config.yml")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging")
  .option("--mission-id <id>", "run one automation candidate by id")
  .option("--all-candidates", "run every automation candidate sequentially", false)
  .option("--mission-limit <count>", "number of LLM-ranked automation candidates to run")
  .option("--max-turns <count>", "maximum LLM browser turns per mission")
  .option("--storage-state <path>", "Playwright storageState JSON to load before the browser mission")
  .option("--save-storage-state <path>", "write Playwright storageState JSON after the browser mission")
  .option("--no-trace", "disable Playwright trace.zip capture")
  .option("--headed", "show browser UI", false)
  .option("--open-report", "open report.html after writing artifacts", false)
  .option("--pdf", "write report.pdf beside report.html", false)
  .option("--print-report", "print the full Markdown report instead of JSON", false)
  .option("--output-dir <path>", "artifact output directory")
  .action(async (options) => {
    const progress = createProgressReporter(!options.printReport);
    const root = path.resolve(options.root);
    progress("Loading environment and mission artifact");
    await loadEnvFile(root, options.envFile);
    const mission = await readMissionArtifact(path.resolve(options.mission));
    const contract = await loadContract(root);
    const appUrl = resolveTargetUrl(contract, { url: options.url, target: options.target, env: options.env ?? contract.defaults?.targetEnv ?? "auto" });
    const llm = createDefaultLLMFromEnv();
    if (!llm) throw new Error("Browser execution requires an LLM provider.");
    const outputDir = options.outputDir
      ? resolveRepoPath(root, options.outputDir)
      : await resolveContractOutputDir(root, contract.defaults?.outputDir ?? ".preflight-scout/runs/latest");
    const selectedMissions = selectAutomationCandidates(mission, {
      missionId: options.missionId,
      allCandidates: options.allCandidates || contract.defaults?.allCandidates,
      missionLimit: parseOptionalPositiveInteger(options.missionLimit, "--mission-limit") ?? contract.defaults?.missionLimit
    });
    progress(`Selected ${selectedMissions.length} browser mission(s)`);
    const storage = await resolveStorageOptions(root, contract, selectedMissions, {
      storageState: options.storageState,
      saveStorageState: options.saveStorageState
    });
    if (storage.storageState) progress(`Using storage state ${storage.storageState}`);
    const runResults = await runAutomationCandidates(selectedMissions, {
      appUrl,
      contract,
      llm,
      root,
      outputDir,
      headless: options.headed ? false : contract.defaults?.headless ?? true,
      maxTurns: parseOptionalPositiveInteger(options.maxTurns, "--max-turns") ?? contract.defaults?.maxTurns,
      storageState: storage.storageState,
      saveStorageState: storage.saveStorageState,
      trace: options.trace && contract.defaults?.trace !== false,
      progress
    });
    const impactMap = await readImpactMapArtifact(path.join(path.dirname(path.resolve(options.mission)), "impact-map.json"));
    await writeAnalysisArtifacts(outputDir, {
      impactMap,
      mission,
      runResult: runResults[0],
      runResults
    });
    if (options.pdf) {
      progress("Rendering PDF report");
      await printHtmlReportToPdf({ htmlPath: path.join(outputDir, "report.html"), pdfPath: path.join(outputDir, "report.pdf") });
    }
    if (options.openReport) await openReport(path.join(outputDir, "report.html"), root);
    if (options.printReport) {
      console.log(await fs.readFile(path.join(outputDir, "report.md"), "utf8"));
    } else {
      console.log(renderArtifactSummary({ runDir: outputDir, impactMap, mission, runResults, appUrl, pdf: options.pdf }));
    }
  });

program
  .command("report")
  .description("Rebuild the human QA report from run artifacts")
  .option("--run-dir <path>", "run artifact directory", ".preflight-scout/runs/latest")
  .option("--open-report", "open report.html after writing artifacts", false)
  .option("--pdf", "write report.pdf beside report.html", false)
  .option("--print", "print Markdown report after writing", false)
  .action(async (options) => {
    const progress = createProgressReporter(!options.print);
    const runDir = path.resolve(options.runDir);
    progress(`Loading run artifacts from ${runDir}`);
    const impactMap = await readImpactMapArtifact(path.join(runDir, "impact-map.json"));
    const mission = await readMissionArtifact(path.join(runDir, "mission.json"));
    const runResultsPath = path.join(runDir, "run-results.json");
    const runResultPath = path.join(runDir, "run-result.json");
    const runResults = await exists(runResultsPath)
      ? await readRunResultsArtifact(runResultsPath)
      : await exists(runResultPath)
        ? [await readRunResultArtifact(runResultPath)]
        : undefined;
    await writeAnalysisArtifacts(runDir, { impactMap, mission, runResults });
    const reportPath = path.join(runDir, "report.md");
    if (options.pdf) {
      progress("Rendering PDF report");
      await printHtmlReportToPdf({ htmlPath: path.join(runDir, "report.html"), pdfPath: path.join(runDir, "report.pdf") });
    }
    if (options.openReport) await openReport(path.join(runDir, "report.html"), runDir);
    if (options.print) {
      console.log(await fs.readFile(reportPath, "utf8"));
    } else {
      console.log(`Wrote ${reportPath}`);
      console.log(`Wrote ${path.join(runDir, "report.html")}`);
      if (options.pdf) console.log(`Wrote ${path.join(runDir, "report.pdf")}`);
      console.log(`Wrote ${path.join(runDir, "report-summary.json")}`);
    }
  });

program
  .command("promote")
  .description("Ask the LLM to promote a Preflight Scout run into a durable Playwright test")
  .option("--root <path>", "repository root", process.cwd())
  .option("--env-file <path>", "load environment variables before promotion", ".env.preflight-scout.local")
  .option("--run-dir <path>", "run artifact directory", ".preflight-scout/runs/latest")
  .option("--mission-id <id>", "mission id to focus promotion on")
  .option("--output-dir <path>", "test output directory", "tests/preflight-scout")
  .option("--dry-run", "print the promoted test JSON without writing files", false)
  .action(async (options) => {
    const root = path.resolve(options.root);
    await loadEnvFile(root, options.envFile);
    const runDir = resolveRepoPath(root, options.runDir);
    const contract = await loadContract(root);
    const impactMap = await readImpactMapArtifact(path.join(runDir, "impact-map.json"));
    const mission = await readMissionArtifact(path.join(runDir, "mission.json"));
    const runResultsPath = path.join(runDir, "run-results.json");
    const runResultPath = path.join(runDir, "run-result.json");
    const runResults = await exists(runResultsPath)
      ? await readRunResultsArtifact(runResultsPath)
      : await exists(runResultPath)
        ? [await readRunResultArtifact(runResultPath)]
        : [];
    const llm = createDefaultLLMFromEnv();
    if (!llm) throw new Error("Regression promotion requires an LLM provider.");
    const promotion = await promoteRegressionTest({
      llm,
      contract,
      impactMap,
      mission,
      runResults,
      missionId: options.missionId,
      outputDir: options.outputDir
    });
    if (options.dryRun) {
      console.log(JSON.stringify(promotion, null, 2));
      return;
    }
    const filePath = resolveRepoPath(root, promotion.filePath);
    await writeTextEnsuringDir(filePath, promotion.content);
    const notesPath = `${filePath}.notes.md`;
    await writeTextEnsuringDir(notesPath, [
      `# ${promotion.testTitle}`,
      "",
      `Covered missions: ${promotion.coveredMissionIds.join(", ") || "none"}`,
      "",
      ...promotion.notes.map((note) => `- ${note}`)
    ].join("\n"));
    console.log(`Wrote ${filePath}`);
    console.log(`Wrote ${notesPath}`);
  });

program
  .command("mission-prompt")
  .description("Render a mission artifact as an agent prompt for Codex, Claude, Gemini, or MCP usage")
  .option("--root <path>", "repository root", process.cwd())
  .requiredOption("--mission <path>", "path to mission.json")
  .option("--env-file <path>", "load environment variables before rendering", ".env.preflight-scout.local")
  .option("--url <url>", "app URL; defaults to PREFLIGHT_SCOUT_APP_URL or .preflight-scout/config.yml")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging")
  .option("--mission-id <id>", "render one automation candidate by id")
  .option("--all-candidates", "render every automation candidate", false)
  .option("--mission-limit <count>", "number of LLM-ranked automation candidates to render")
  .action(async (options) => {
    const root = path.resolve(options.root);
    await loadEnvFile(root, options.envFile);
    const mission = await readMissionArtifact(path.resolve(options.mission));
    const contract = await loadContract(root);
    const appUrl = resolveTargetUrl(contract, { url: options.url, target: options.target, env: options.env ?? contract.defaults?.targetEnv ?? "auto" });
    const selectedMission = {
      ...mission,
      automationCandidates: selectAutomationCandidates(mission, {
        missionId: options.missionId,
        allCandidates: options.allCandidates || contract.defaults?.allCandidates,
        missionLimit: parseOptionalPositiveInteger(options.missionLimit, "--mission-limit") ?? contract.defaults?.missionLimit
      })
    };
    console.log(renderAgentPrompt({
      kind: "custom",
      appUrl,
      mission: selectedMission,
      contract
    }));
  });

program
  .command("agent-run")
  .description("Delegate a QA mission to an external coding agent such as Codex, Claude, or Gemini")
  .option("--root <path>", "repository root", process.cwd())
  .option("--base <ref>", "base git ref; defaults to PREFLIGHT_SCOUT_BASE_REF, config defaults, or origin/HEAD")
  .option("--head <ref>", "head git ref", "HEAD")
  .option("--title <text>", "PR title or change title to include in LLM analysis")
  .option("--body <text>", "PR body or change description to include in LLM analysis")
  .option("--analysis-dir <path>", "reuse impact-map.json and mission.json from a previous preflight-scout analyze run")
  .option("--env-file <path>", "load environment variables before running", ".env.preflight-scout.local")
  .option("--url <url>", "app URL; defaults to PREFLIGHT_SCOUT_APP_URL or .preflight-scout/config.yml")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging")
  .option("--mission-id <id>", "delegate one automation candidate by id")
  .option("--all-candidates", "delegate every automation candidate", false)
  .option("--mission-limit <count>", "number of LLM-ranked automation candidates to delegate")
  .requiredOption("--agent <kind>", "codex, claude, gemini, or custom")
  .option("--command <command>", "custom command or command override")
  .option("--arg <arg...>", "custom command args")
  .action(async (options) => {
    const root = path.resolve(options.root);
    await loadEnvFile(root, options.envFile);
    const contract = await loadContract(root);
    const analysisDir = options.analysisDir ? resolveRepoPath(root, options.analysisDir) : undefined;
    const analysis = await resolveReviewedAnalysis({
      analysisDir,
      analyze: async () => {
        const base = await resolveBaseRef(root, options.base, contract);
        return analyzePullRequest({ root, base, head: options.head, title: options.title, body: options.body });
      }
    });
    const appUrl = resolveTargetUrl(contract, { url: options.url, target: options.target, env: options.env ?? contract.defaults?.targetEnv ?? "auto" });
    const mission = {
      ...analysis.mission,
      automationCandidates: selectAutomationCandidates(analysis.mission, {
        missionId: options.missionId,
        allCandidates: options.allCandidates || contract.defaults?.allCandidates,
        missionLimit: parseOptionalPositiveInteger(options.missionLimit, "--mission-limit") ?? contract.defaults?.missionLimit
      })
    };
    const agentKind = options.agent as AgentExecKind;
    const selectedRoles = [...new Set(mission.automationCandidates.flatMap((candidate) => candidate.role ? [candidate.role] : []))];
    const delegatedContract = selectContractRoles(contract, selectedRoles);
    const result = await runAgentExecution({
      kind: agentKind,
      appUrl,
      mission,
      contract: delegatedContract,
      cwd: root,
      targetRoot: root,
      command: options.command,
      args: options.arg,
      env: buildAgentEnvironment(agentKind, {
        credentialEnvNames: selectedRoleCredentialEnvNames(contract, selectedRoles)
      })
    });
    console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 1;
  });

program
  .command("mcp-tools")
  .description("List tools exposed by an MCP server")
  .requiredOption("--command <command>", "MCP server command")
  .option("--arg <arg...>", "MCP server args")
  .action(async (options) => {
    const tools = await listMCPTools({ command: options.command, args: options.arg });
    console.log(JSON.stringify(tools, null, 2));
  });

program
  .command("mcp-setup")
  .description("Print Playwright MCP setup commands for Codex, Claude, or Gemini")
  .option("--agent <kind>", "codex, claude, gemini, or all", "all")
  .option("--output-dir <path>", "Playwright MCP artifact directory", ".preflight-scout/mcp")
  .action((options) => {
    console.log(renderMcpSetup(options.agent, options.outputDir));
  });

program
  .command("mcp-run")
  .description("Send a Preflight Scout mission prompt to an MCP tool")
  .option("--root <path>", "repository root", process.cwd())
  .option("--base <ref>", "base git ref; defaults to PREFLIGHT_SCOUT_BASE_REF, config defaults, or origin/HEAD")
  .option("--head <ref>", "head git ref", "HEAD")
  .option("--title <text>", "PR title or change title to include in LLM analysis")
  .option("--body <text>", "PR body or change description to include in LLM analysis")
  .option("--env-file <path>", "load environment variables before running", ".env.preflight-scout.local")
  .option("--url <url>", "app URL; defaults to PREFLIGHT_SCOUT_APP_URL or .preflight-scout/config.yml")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging")
  .option("--mission-id <id>", "send one automation candidate by id")
  .option("--all-candidates", "send every automation candidate", false)
  .option("--mission-limit <count>", "number of LLM-ranked automation candidates to send")
  .requiredOption("--server-command <command>", "MCP server command")
  .option("--server-arg <arg...>", "MCP server args")
  .requiredOption("--tool <name>", "MCP tool name that accepts a prompt")
  .option("--argument-name <name>", "prompt argument name", "prompt")
  .action(async (options) => {
    const root = path.resolve(options.root);
    await loadEnvFile(root, options.envFile);
    const contract = await loadContract(root);
    const base = await resolveBaseRef(root, options.base, contract);
    const analysis = await analyzePullRequest({ root, base, head: options.head, title: options.title, body: options.body });
    const appUrl = resolveTargetUrl(analysis.contract, { url: options.url, target: options.target, env: options.env ?? contract.defaults?.targetEnv ?? "auto" });
    const mission = {
      ...analysis.mission,
      automationCandidates: selectAutomationCandidates(analysis.mission, {
        missionId: options.missionId,
        allCandidates: options.allCandidates || contract.defaults?.allCandidates,
        missionLimit: parseOptionalPositiveInteger(options.missionLimit, "--mission-limit") ?? contract.defaults?.missionLimit
      })
    };
    const result = await executeMissionViaPromptTool({
      server: { command: options.serverCommand, args: options.serverArg },
      toolName: options.tool,
      argumentName: options.argumentName,
      mission,
      appUrl
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("doctor")
  .description("Check local setup for analysis and browser execution")
  .option("--root <path>", "repository root", process.cwd())
  .option("--env-file <path>", "load environment variables before checking", ".env.preflight-scout.local")
  .option("--base <ref>", "base git ref to validate, e.g. origin/main")
  .option("--head <ref>", "head git ref to validate", "HEAD")
  .option("--url <url>", "app URL to reach-check")
  .option("--target <name>", "named app target from .preflight-scout/config.yml app.targets")
  .option("--env <env>", "target URL from config: auto, local, or staging", "auto")
  .option("--timeout-ms <ms>", "URL and command timeout in milliseconds", "5000")
  .option("--mcp", "check Codex/Claude/Gemini MCP server lists", false)
  .option("--agent <kind>", "run a bounded non-interactive runtime probe for codex, claude, gemini, or custom")
  .option("--agent-command <command>", "custom command or command override for --agent")
  .option("--agent-arg <arg...>", "custom command args for --agent")
  .option("--agent-timeout-ms <ms>", "delegated runtime probe timeout in milliseconds (maximum 30000)", "30000")
  .option("--json", "print machine-readable JSON", false)
  .action(async (options) => {
    const report = await runDoctor({
      root: options.root,
      envFile: options.envFile,
      base: options.base,
      head: options.head,
      url: options.url,
      target: options.target,
      env: options.env,
      timeoutMs: parseOptionalPositiveInteger(options.timeoutMs, "--timeout-ms"),
      checkMcp: options.mcp,
      checkBrowser: checkBrowserAvailability,
      agent: options.agent as AgentExecKind | undefined,
      agentCommand: options.agentCommand,
      agentArgs: options.agentArg,
      agentTimeoutMs: parseOptionalPositiveInteger(options.agentTimeoutMs, "--agent-timeout-ms")
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
    if (!report.ok) process.exitCode = 1;
  });

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function analyzeForRun(
  root: string,
  contract: QAContract,
  options: {
    base?: string;
    head: string;
    title?: string;
    body?: string;
    progress: ProgressCallback;
  }
): Promise<Pick<Awaited<ReturnType<typeof analyzePullRequest>>, "impactMap" | "mission">> {
  const base = await resolveBaseRef(root, options.base, contract);
  options.progress("Starting PR impact analysis");
  return analyzePullRequest({
    root,
    base,
    head: options.head,
    title: options.title,
    body: options.body,
    progress: options.progress
  });
}

function renderMcpSetup(agent: string, outputDir: string): string {
  const commands = {
    codex: [
      `codex mcp add playwright -- npx -y @playwright/mcp@0.0.78 --isolated --output-dir ${shellQuote(outputDir)}`,
      "codex mcp list"
    ],
    claude: [
      `claude mcp add playwright -- npx -y @playwright/mcp@0.0.78 --isolated --output-dir ${shellQuote(outputDir)}`,
      "claude mcp list"
    ],
    gemini: [
      `gemini mcp add playwright npx -y @playwright/mcp@0.0.78 --isolated --output-dir ${shellQuote(outputDir)}`,
      "gemini mcp list"
    ]
  };
  if (agent === "all") return Object.entries(commands).map(([name, list]) => `# ${name}\n${list.join("\n")}`).join("\n\n");
  if (agent !== "codex" && agent !== "claude" && agent !== "gemini") {
    throw new Error("--agent must be codex, claude, gemini, or all.");
  }
  return commands[agent].join("\n");
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveOptionalAnalysisTargetUrl(contract: QAContract, options: { url?: string; target?: string; env?: string }): string | undefined {
  const explicit = Boolean(options.url || options.target || options.env);
  try {
    return resolveTargetUrl(contract, options);
  } catch (error) {
    if (explicit) throw error;
    return undefined;
  }
}

function blockMissionsForInvalidStorage(missions: Array<{ id: string }>, reason: string, progress: ProgressCallback): MissionRunResult[] {
  progress(`Storage state is invalid; blocking ${missions.length} mission(s) before browser launch.`);
  return missions.map((mission) => ({
    missionId: mission.id,
    status: "blocked",
    results: [{ stepId: "storage-state", status: "blocked", message: reason }],
    artifacts: []
  }));
}

function renderAuthLoginFailureSummary(input: {
  status: string;
  reason?: string;
  outputDir: string;
  storageState: string;
  evidence?: MissionRunResult["evidence"];
}): string {
  const lines = [
    "Auth failed",
    `Status: ${input.status}`,
    `Reason: ${input.reason ?? "Authenticated state was not verified."}`,
    `Evidence: ${input.outputDir}`,
    `Storage state: invalid, not reusable: ${input.storageState}`,
    `Status metadata: ${input.storageState}.preflight-scout.json`
  ];
  if (input.evidence?.tracePath) lines.push(`Trace: ${input.evidence.tracePath}`);
  if (input.evidence?.finalObservationPath) lines.push(`Final observation: ${input.evidence.finalObservationPath}`);
  if (input.evidence?.consolePath) lines.push(`Console errors: ${input.evidence.consolePath}`);
  if (input.evidence?.networkPath) lines.push(`Network errors: ${input.evidence.networkPath}`);
  lines.push("Next: verify the test credentials, rerun with --headed, or rerun with --agent codex after confirming Playwright MCP is configured.");
  return lines.join("\n");
}

function deriveDelegatedAuthFailureReason(storageProblem: string | undefined, result: AgentExecResult): string {
  const reportedCause = extractPrimaryCause([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (reportedCause && storageProblem) return `${reportedCause} ${storageProblem}`;
  if (reportedCause) return reportedCause;
  if (storageProblem) return storageProblem;
  return `Agent exited with ${result.exitCode ?? "unknown status"}`;
}

async function runDelegatedAuthCapabilityProbe(options: {
  kind: AgentExecKind;
  appUrl: string;
  contract: QAContract;
  outputDir: string;
  cwd: string;
  targetRoot: string;
  command?: string;
  args?: string[];
  timeoutMs: number;
  heartbeatMs: number;
  env: NodeJS.ProcessEnv;
  progress: ProgressCallback;
}): Promise<{ ok: boolean; reason?: string }> {
  options.progress("Probing delegated runtime capabilities");
  const result = await runAgentExecution({
    kind: options.kind,
    appUrl: options.appUrl,
    contract: options.contract,
    mission: {
      id: "delegated-runtime-probe",
      title: "Probe delegated browser runtime capabilities",
      risk: "medium",
      summary: "Confirm the delegated agent sandbox can reach the target URL, write evidence, and use browser automation before auth.",
      affectedAreas: [],
      manualChecklist: [],
      edgeCases: [],
      automationCandidates: [],
      unknowns: []
    },
    evidenceDir: options.outputDir,
    cwd: options.cwd,
    targetRoot: options.targetRoot,
    command: options.command,
    args: options.args,
    timeoutMs: options.timeoutMs,
    heartbeatMs: options.heartbeatMs,
    onProgress: options.progress,
    env: options.env,
    streamOutput: "signals",
    additionalInstructions: [
      "This is a capability probe only. Do not log in, use credentials, create issues, push, publish, deploy, or edit app source.",
      "From inside this delegated runtime, check whether the target URL is reachable.",
      "Check whether you can write a tiny evidence note in the evidence directory.",
      "Check whether you can use a browser automation tool: Playwright MCP, Playwright skill, Playwright CLI/library, or an installed browser driver.",
      "Do not start the app server; report blocked if the delegated sandbox cannot reach the already-running target.",
      "End with exactly one line `PREFLIGHT_SCOUT_PROBE_STATUS=pass` or `PREFLIGHT_SCOUT_PROBE_STATUS=blocked`.",
      "If blocked, also include a line starting exactly `Primary cause:`. Use precise causes like `target unreachable from delegated agent sandbox` or `browser launch blocked by provider sandbox`."
    ]
  });
  await writeTextEnsuringDir(path.join(options.outputDir, "agent-probe-stdout.md"), result.stdout || "(no stdout)\n");
  if (result.stderr) await writeTextEnsuringDir(path.join(options.outputDir, "agent-probe-stderr.log"), result.stderr);
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const status = combined.match(/PREFLIGHT_SCOUT_PROBE_STATUS\s*=\s*(pass|blocked|fail)/i)?.[1]?.toLowerCase();
  if (result.exitCode !== 0) {
    return { ok: false, reason: `Delegated runtime probe failed: agent exited with ${result.exitCode}. ${extractPrimaryCause(combined) ?? ""}`.trim() };
  }
  if (status === "pass") return { ok: true };
  if (status === "blocked" || status === "fail") {
    return { ok: false, reason: `Delegated runtime probe blocked: ${extractPrimaryCause(combined) ?? "required browser/runtime capability was unavailable from inside the delegated agent sandbox."}` };
  }
  options.progress("Delegated runtime probe did not return PREFLIGHT_SCOUT_PROBE_STATUS; continuing with auth mission");
  return { ok: true };
}

function extractPrimaryCause(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*Primary cause:\s*(.+?)\s*$/i);
    if (match?.[1]) return match[1];
  }
  const rejectedLine = output.split(/\r?\n/).find((line) => /incorrect email or password|notauthorizedexception|credentials? rejected|invalid credentials/i.test(line));
  return rejectedLine?.trim();
}

function selectedRoleCredentialEnvNames(contract: QAContract, roles: readonly string[]): string[] {
  const envNames: string[] = [];
  for (const role of new Set(roles)) {
    const roleConfig = contract.auth?.roles?.[role];
    for (const [kind, key] of [
      ["username", roleConfig?.usernameEnv],
      ["password", roleConfig?.passwordEnv]
    ] as const) {
      if (!key) continue;
      if (browserCredentialKindForEnvName(key) !== kind) {
        throw new Error(
          `Credential environment variable ${key} is not an authorized dedicated browser credential for ${kind}; use PREFLIGHT_SCOUT_BROWSER_<ROLE_OR_LABEL>_(EMAIL|USERNAME|PASSWORD).`
        );
      }
      envNames.push(key);
    }
  }
  return [...new Set(envNames)];
}

function selectContractRoles(contract: QAContract, roles: readonly string[]): QAContract {
  if (!contract.auth) return contract;
  const selectedRoles = Object.fromEntries(
    [...new Set(roles)].flatMap((role) => {
      const roleConfig = contract.auth?.roles?.[role];
      return roleConfig ? [[role, roleConfig] as const] : [];
    })
  );
  return {
    ...contract,
    auth: {
      ...contract.auth,
      roles: selectedRoles
    }
  };
}

function parseOptionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function rejectUnknownHelpCommand(command: Command, argv: string[]): void {
  const args = argv.slice(2);
  const firstCommand = args.find((arg) => !arg.startsWith("-"));
  if (!firstCommand || !args.some((arg) => arg === "--help" || arg === "-h")) return;
  const commandNames = command.commands.flatMap((candidate) => [candidate.name(), ...candidate.aliases()]);
  if (commandNames.includes(firstCommand)) return;
  const suggestion = closestCommand(firstCommand, commandNames);
  process.stderr.write(`error: unknown command '${firstCommand}'${suggestion ? `. Did you mean '${suggestion}'?` : ""}\n`);
  process.exit(1);
}

function closestCommand(value: string, candidates: string[]): string | undefined {
  let best: { value: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    if (!best || distance < best.distance) best = { value: candidate, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(value.length / 2)) ? best.value : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const nextDiagonal = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = nextDiagonal;
    }
  }
  return previous[right.length] ?? Number.POSITIVE_INFINITY;
}

rejectUnknownHelpCommand(program, process.argv);
await program.parseAsync();
