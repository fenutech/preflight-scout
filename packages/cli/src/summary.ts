import { spawn } from "node:child_process";
import path from "node:path";
import {
  buildHumanReportSummary,
  resolveTrustedExecutable,
  type ImpactMap,
  type MissionRunResult,
  type QAMission
} from "@preflight-scout/core";

export interface ArtifactSummaryInput {
  runDir: string;
  impactMap: ImpactMap;
  mission: QAMission;
  runResults?: MissionRunResult[];
  appUrl?: string;
  pdf?: boolean;
}

export function renderArtifactSummary(input: ArtifactSummaryInput): string {
  const summary = buildHumanReportSummary({
    impactMap: input.impactMap,
    mission: input.mission,
    runResults: input.runResults
  });
  const reportMd = path.join(input.runDir, "report.md");
  const reportHtml = path.join(input.runDir, "report.html");
  const reportPdf = path.join(input.runDir, "report.pdf");
  const reportJson = path.join(input.runDir, "report-summary.json");
  const lines = [
    "Preflight Scout complete",
    `Verdict: ${formatVerdict(summary.verdict)}`,
    `Risk: ${summary.risk.toUpperCase()}`,
    `Checklist: ${summary.counts.manualChecks} manual checks, ${summary.counts.edgeCases} edge cases`,
    `Browser: ${summary.counts.browserMissions} executed, ${summary.counts.passed} passed, ${summary.counts.failed} failed, ${summary.counts.blocked} blocked`
  ];
  if (input.appUrl) lines.push(`Target URL: ${input.appUrl}`);
  lines.push("");
  lines.push("Reports:");
  lines.push(`- Markdown: ${reportMd}`);
  lines.push(`- HTML: ${reportHtml}`);
  if (input.pdf) lines.push(`- PDF: ${reportPdf}`);
  lines.push(`- Summary JSON: ${reportJson}`);

  const evidence = collectEvidence(summary.browserMissions.flatMap((mission) => [
    ...mission.artifacts,
    mission.evidence?.tracePath,
    mission.evidence?.consolePath,
    mission.evidence?.networkPath,
    mission.evidence?.finalObservationPath
  ]));
  if (evidence.length) {
    lines.push("");
    lines.push("Evidence:");
    for (const item of evidence.slice(0, 8)) lines.push(`- ${item}`);
    if (evidence.length > 8) lines.push(`- ...and ${evidence.length - 8} more artifacts`);
  }

  const attention = summary.browserMissions.filter((mission) => mission.status !== "passed");
  if (attention.length) {
    lines.push("");
    lines.push("Needs attention:");
    for (const mission of attention) {
      lines.push(`- ${mission.title ?? mission.id}: ${mission.status.toUpperCase()}${mission.finalMessage ? ` - ${mission.finalMessage}` : ""}`);
    }
  }

  return lines.join("\n");
}

export async function openReport(reportPath: string, targetRoot: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const resolved = await resolveTrustedExecutable({ command, targetRoot: path.resolve(targetRoot) });
  const child = spawn(resolved.executable, [path.resolve(reportPath)], {
    detached: true,
    env: reportOpenerEnvironment(resolved.env),
    shell: false,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", () => undefined);
  child.unref();
}

function reportOpenerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = /^(PATH|HOME|USER|LOGNAME|TMPDIR|TMP|TEMP|LANG|LC_.+|TZ|DISPLAY|WAYLAND_DISPLAY|XDG_.+|DBUS_SESSION_BUS_ADDRESS|SYSTEMROOT|WINDIR|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH)$/i;
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.test(key)));
}

function collectEvidence(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item)))];
}

function formatVerdict(verdict: ReturnType<typeof buildHumanReportSummary>["verdict"]): string {
  if (verdict === "ready_for_human_review") return "ready for human review";
  if (verdict === "needs_attention") return "needs attention before production";
  return "no browser evidence yet";
}
