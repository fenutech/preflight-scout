import type { ApprovalState, LLMClient, ProgressCallback, QAContract } from "@preflight-scout/core";

export interface BrowserRunOptions {
  baseUrl: string;
  contract: QAContract;
  llm: LLMClient;
  outputDir?: string;
  headless?: boolean;
  maxTurns?: number;
  approvals?: ApprovalState;
  root?: string;
  storageState?: string;
  saveStorageState?: string;
  trace?: boolean;
  progress?: ProgressCallback;
}

export interface BrowserDecision {
  thought: string;
  action: "goto" | "click" | "fill" | "press" | "assert" | "screenshot" | "wait" | "scroll" | "set_viewport" | "finish_pass" | "finish_fail" | "blocked";
  missionStepId?: string;
  target?: string;
  value?: string;
  reason: string;
  evidence_needed_next?: string;
}

export interface BrowserObservation {
  url: string;
  title: string;
  text: string;
  viewport: { width: number; height: number } | null;
  scroll: { x: number; y: number; width: number; height: number };
  consoleErrors: string[];
  networkErrors: string[];
  interactive: Array<{ tag: string; role?: string; text?: string; label?: string; placeholder?: string; testid?: string }>;
}
