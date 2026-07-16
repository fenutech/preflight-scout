import type { HumanReportSummary, ImpactMap, QAMission } from "@preflight-scout/core";
import { REPORT_MARKER } from "./github.js";

export interface PullRequestCommentInput {
  summary: HumanReportSummary;
  impactMap: ImpactMap;
  mission: QAMission;
  artifactName?: string;
  artifactId?: number;
  appUrl?: string;
  failOn: string;
}

export function renderPullRequestComment(input: PullRequestCommentInput): string {
  const lines: string[] = [];
  lines.push("## Preflight Scout");
  lines.push("");
  lines.push(`**Verdict:** ${formatVerdict(input.summary.verdict)}  `);
  lines.push(`**Release readiness:** ${formatReleaseDecision(input.summary.releaseDecision.status)}  `);
  lines.push(`**Risk:** ${input.summary.risk.toUpperCase()}  `);
  lines.push(`**Browser:** ${input.summary.counts.passed} passed, ${input.summary.counts.failed} failed, ${input.summary.counts.blocked} blocked  `);
  lines.push(`**Manual checks:** ${input.summary.counts.manualChecks}  `);
  if (input.appUrl) lines.push(`**Target:** ${markdownInlineCode(input.appUrl)}  `);
  lines.push(`**Gate:** ${escapeUntrustedMarkdown(input.failOn)}`);
  lines.push("");

  const topIssues = input.summary.browserMissions
    .filter((mission) => mission.status !== "passed")
    .slice(0, 5);
  if (topIssues.length) {
    lines.push("### Needs Attention");
    lines.push(escapeUntrustedMarkdown(input.summary.releaseDecision.reason));
    lines.push("");
    for (const issue of topIssues) {
      lines.push(`- **${issue.status.toUpperCase()}** ${escapeUntrustedMarkdown(issue.title ?? issue.id)}: ${escapeUntrustedMarkdown(truncate(issue.finalMessage ?? "No final message.", 260))}`);
    }
    lines.push("");
  }

  lines.push("### Must Test Before Prod");
  for (const item of input.mission.manualChecklist.slice(0, 8)) {
    lines.push(`- [ ] ${escapeUntrustedMarkdown(item)}`);
  }
  if (input.mission.manualChecklist.length > 8) {
    lines.push(`- ...and ${input.mission.manualChecklist.length - 8} more in the full report.`);
  }
  lines.push("");

  lines.push("### Changed Surfaces");
  for (const area of input.mission.affectedAreas.slice(0, 8)) {
    lines.push(`- **${area.risk.toUpperCase()}** ${escapeUntrustedMarkdown(area.name)} (${escapeUntrustedMarkdown(area.kind)})`);
  }
  if (input.mission.affectedAreas.length > 8) {
    lines.push(`- ...and ${input.mission.affectedAreas.length - 8} more in the full report.`);
  }
  lines.push("");

  lines.push("### Full Evidence");
  const artifactLabel = escapeUntrustedMarkdown(input.artifactName ?? "preflight-scout artifact");
  lines.push(`Download **${artifactLabel}** from this workflow run for \`report.html\`, \`report.md\`, screenshots, traces, console/network JSON, and machine-readable summaries.`);
  if (input.artifactId) lines.push(`Artifact id: \`${input.artifactId}\`.`);
  lines.push("");
  lines.push(`<sub>Generated ${escapeUntrustedMarkdown(input.summary.generatedAt)}. Full report remains in workflow artifacts to keep this PR readable.</sub>`);
  lines.push("");
  lines.push(REPORT_MARKER);
  return lines.join("\n");
}

function formatReleaseDecision(status: HumanReportSummary["releaseDecision"]["status"]): string {
  if (status === "ready_for_human_review") return "Ready for human review";
  if (status === "needs_browser_evidence") return "Needs browser evidence";
  return "Do not ship yet";
}

function formatVerdict(verdict: HumanReportSummary["verdict"]): string {
  if (verdict === "ready_for_human_review") return "Ready for human review";
  if (verdict === "needs_attention") return "Needs attention before production";
  return "Checklist only, no browser evidence";
}

function truncate(value: string, maxLength: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}...`;
}

function escapeUntrustedMarkdown(value: string): string {
  let clean = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):/g, "$1\u200b:");
  for (const character of ["\\", "`", "*", "_", "[", "]", "(", ")", "#", "~", "|"]) {
    clean = clean.replaceAll(character, `\\${character}`);
  }
  return clean;
}

function markdownInlineCode(value: string): string {
  const clean = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@(?=[A-Za-z0-9_-])/g, "@\u200b")
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):/g, "$1\u200b:");
  const longestRun = Math.max(0, ...[...clean.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${clean}${fence}`;
}
