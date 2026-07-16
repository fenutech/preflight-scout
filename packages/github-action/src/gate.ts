import type { HumanReportSummary } from "@preflight-scout/core";

export type FailOnMode = "never" | "needs_attention" | "failed_only";

export function parseFailOn(value: string | undefined): FailOnMode {
  const mode = value || "needs_attention";
  if (mode === "never" || mode === "needs_attention" || mode === "failed_only") return mode;
  throw new Error('fail-on must be "never", "needs_attention", or "failed_only".');
}

export function shouldFail(summary: HumanReportSummary, failOn: FailOnMode): boolean {
  if (failOn === "never") return false;
  if (failOn === "needs_attention") return summary.verdict === "needs_attention";
  return summary.counts.failed > 0;
}

export function statusDescription(summary: HumanReportSummary, failing: boolean): string {
  if (!failing) return "Preflight Scout completed";
  if (summary.counts.failed > 0) return "Preflight Scout found failed browser missions";
  if (summary.counts.blocked > 0) return "Preflight Scout has blocked browser missions";
  return "Preflight Scout needs attention";
}
