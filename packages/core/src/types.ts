export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface RoleCredential {
  usernameEnv?: string;
  passwordEnv?: string;
  storageState?: string;
  signedInTarget?: string;
  notes?: string;
}

export interface AppTarget {
  url?: string;
  localUrl?: string;
  stagingUrl?: string;
  description?: string;
}

export interface QAContract {
  app: {
    name?: string;
    type?: string;
    url?: string;
    localUrl?: string;
    stagingUrl?: string;
    targets?: Record<string, AppTarget>;
    previewUrlSource?: "vercel" | "netlify" | "github_deployment" | "manual" | "unknown";
  };
  auth?: {
    loginUrl?: string;
    storageState?: string;
    saveStorageState?: string;
    roles?: Record<string, RoleCredential>;
  };
  defaults?: {
    baseRef?: string;
    target?: string;
    targetEnv?: "auto" | "local" | "staging";
    outputDir?: string;
    maxTurns?: number;
    missionLimit?: number;
    headless?: boolean;
    trace?: boolean;
    allCandidates?: boolean;
    storageState?: string;
    saveStorageState?: string;
  };
  criticalFlows: string[];
  sensitiveAreas: string[];
  dangerousActions: {
    allowed: string[];
    requireApproval: string[];
    forbidden: string[];
  };
  testData: Record<string, string>;
  unknowns: string[];
}

export interface RepoRoute {
  path: string;
  file: string;
  kind: "page" | "api" | "unknown";
}

export interface RepoIndex {
  root: string;
  files: string[];
  manifests: Record<string, string>;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  frameworks: string[];
  routes: RepoRoute[];
  components: Array<{ name: string; file: string }>;
  tests: string[];
  configFiles: string[];
  integrationHints: string[];
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "unknown";
  additions?: number;
  deletions?: number;
  patch?: string;
  content?: string;
  contextStatus?: "included" | "omitted_changed_file_limit" | "omitted_total_budget";
  contextNote?: string;
}

export interface PullRequestContextCoverage {
  totalFiles: number;
  filesWithContext: number;
  omittedFiles: number;
  contextChars: number;
  maxContextFiles: number;
  maxContextChars: number;
  complete: boolean;
  note?: string;
}

export interface PullRequestContext {
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  files: ChangedFile[];
  contextCoverage?: PullRequestContextCoverage;
}

export interface ImpactItem {
  kind: "route" | "api" | "component" | "data" | "auth" | "billing" | "integration" | "config" | "test" | "unknown";
  name: string;
  evidence: string[];
  risk: RiskLevel;
}

export interface ImpactMap {
  summary: string;
  risk: RiskLevel;
  changedFiles: ChangedFile[];
  affectedRoutes: RepoRoute[];
  affectedAreas: ImpactItem[];
  suggestedRoles: string[];
  unknowns: string[];
}

export type MissionStepAction =
  | "goto"
  | "login"
  | "click"
  | "fill"
  | "press"
  | "assert_visible"
  | "assert_text"
  | "observe"
  | "approval_gate";

export interface MissionStep {
  id: string;
  instruction: string;
  action: MissionStepAction;
  policyLabel?: string;
  target?: string;
  value?: string;
  valueEnv?: string;
  expected?: string;
  requiresApproval?: boolean;
}

export interface QAFlowMission {
  id: string;
  title: string;
  role?: string;
  startPath?: string;
  risk: RiskLevel;
  reason: string[];
  steps: MissionStep[];
}

export interface QAMission {
  id: string;
  title: string;
  risk: RiskLevel;
  summary: string;
  affectedAreas: ImpactItem[];
  manualChecklist: string[];
  edgeCases: string[];
  automationCandidates: QAFlowMission[];
  unknowns: string[];
}

export interface StepResult {
  stepId: string;
  status: "passed" | "failed" | "blocked" | "skipped";
  message: string;
  screenshotPath?: string;
}

export interface MissionRunResult {
  missionId: string;
  status: "passed" | "failed" | "blocked";
  results: StepResult[];
  artifacts: string[];
  evidence?: {
    tracePath?: string;
    consolePath?: string;
    networkPath?: string;
    finalObservationPath?: string;
  };
}

export type ProgressCallback = (message: string) => void;

export interface HumanReportSummary {
  generatedAt: string;
  title: string;
  risk: RiskLevel;
  verdict: "ready_for_human_review" | "needs_attention" | "no_browser_evidence";
  releaseDecision: {
    status: "ready_for_human_review" | "needs_browser_evidence" | "do_not_ship_yet";
    reason: string;
    nextSteps: string[];
  };
  counts: {
    affectedAreas: number;
    manualChecks: number;
    edgeCases: number;
    suggestedBrowserMissions: number;
    browserMissions: number;
    passed: number;
    failed: number;
    blocked: number;
  };
  browserMissions: Array<{
    id: string;
    title?: string;
    risk?: RiskLevel;
    status: MissionRunResult["status"];
    finalMessage?: string;
    artifacts: string[];
    evidence?: MissionRunResult["evidence"];
  }>;
}

export interface PromotedRegressionTest {
  filePath: string;
  testTitle: string;
  content: string;
  notes: string[];
  coveredMissionIds: string[];
}
