import { z } from "zod";

const LabelSchema = z.string().min(1).max(128);
const ShortTextSchema = z.string().max(512);
const TextSchema = z.string().max(4_096);
const LongTextSchema = z.string().max(262_144);
const PathTextSchema = z.string().max(4_096);
const EnvNameSchema = z.string().max(256);
const boundedRecord = <T extends z.ZodType>(value: T, maxEntries: number) => z
  .record(z.string().min(1).max(128), value)
  .refine((record) => Object.keys(record).length <= maxEntries, `record must contain at most ${maxEntries} entries`);

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);
const ArtifactIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "artifact ids must be safe single path segments");

export const RoleCredentialSchema = z.object({
  usernameEnv: EnvNameSchema.optional(),
  passwordEnv: EnvNameSchema.optional(),
  storageState: PathTextSchema.optional(),
  signedInTarget: PathTextSchema.optional(),
  notes: TextSchema.optional()
}).strict();

export const AppTargetSchema = z.object({
  url: PathTextSchema.optional(),
  localUrl: PathTextSchema.optional(),
  stagingUrl: PathTextSchema.optional(),
  description: TextSchema.optional()
}).strict();

export const QAContractSchema = z.object({
  app: z.object({
    name: ShortTextSchema.optional(),
    type: ShortTextSchema.optional(),
    url: PathTextSchema.optional(),
    localUrl: PathTextSchema.optional(),
    stagingUrl: PathTextSchema.optional(),
    targets: boundedRecord(AppTargetSchema, 50).optional(),
    previewUrlSource: z.enum(["vercel", "netlify", "github_deployment", "manual", "unknown"]).optional()
  }).strict(),
  auth: z.object({
    loginUrl: PathTextSchema.optional(),
    storageState: PathTextSchema.optional(),
    saveStorageState: PathTextSchema.optional(),
    roles: boundedRecord(RoleCredentialSchema, 50).optional()
  }).strict().optional(),
  defaults: z.object({
    baseRef: ShortTextSchema.optional(),
    target: LabelSchema.optional(),
    targetEnv: z.enum(["auto", "local", "staging"]).optional(),
    outputDir: PathTextSchema.optional(),
    maxTurns: z.number().int().positive().max(100).optional(),
    missionLimit: z.number().int().positive().max(100).optional(),
    headless: z.boolean().optional(),
    trace: z.boolean().optional(),
    allCandidates: z.boolean().optional(),
    storageState: PathTextSchema.optional(),
    saveStorageState: PathTextSchema.optional()
  }).strict().optional(),
  criticalFlows: z.array(ShortTextSchema).max(200),
  sensitiveAreas: z.array(ShortTextSchema).max(200),
  dangerousActions: z.object({
    allowed: z.array(LabelSchema).max(200),
    requireApproval: z.array(LabelSchema).max(200),
    forbidden: z.array(LabelSchema).max(200)
  }).strict(),
  testData: boundedRecord(z.string().max(10_000), 200),
  unknowns: z.array(TextSchema).max(200)
}).strict();

export const RepoRouteSchema = z.object({
  path: PathTextSchema,
  file: PathTextSchema,
  kind: z.enum(["page", "api", "unknown"])
}).strict();

export const ChangedFileSchema = z.object({
  path: PathTextSchema,
  status: z.enum(["added", "modified", "deleted", "renamed", "unknown"]),
  additions: z.number().int().nonnegative().max(100_000_000).optional(),
  deletions: z.number().int().nonnegative().max(100_000_000).optional(),
  patch: LongTextSchema.optional(),
  content: LongTextSchema.optional(),
  contextStatus: z.enum(["included", "omitted_changed_file_limit", "omitted_total_budget"]).optional(),
  contextNote: TextSchema.optional()
}).strict();

export const ImpactItemSchema = z.object({
  kind: z.enum(["route", "api", "component", "data", "auth", "billing", "integration", "config", "test", "unknown"]),
  name: ShortTextSchema,
  evidence: z.array(TextSchema).max(100),
  risk: RiskLevelSchema
}).strict();

export const ImpactMapSchema = z.object({
  summary: TextSchema,
  risk: RiskLevelSchema,
  changedFiles: z.array(ChangedFileSchema).max(2_000),
  affectedRoutes: z.array(RepoRouteSchema).max(2_000),
  affectedAreas: z.array(ImpactItemSchema).max(500),
  suggestedRoles: z.array(LabelSchema).max(100),
  unknowns: z.array(TextSchema).max(200)
}).strict();

export const MissionStepSchema = z.object({
  id: ArtifactIdSchema,
  instruction: TextSchema,
  action: z.enum(["goto", "login", "click", "fill", "press", "assert_visible", "assert_text", "observe", "approval_gate"]),
  policyLabel: LabelSchema.optional(),
  target: PathTextSchema.optional(),
  value: z.string().max(4_096).optional(),
  valueEnv: EnvNameSchema.optional(),
  expected: z.string().max(10_000).optional(),
  requiresApproval: z.boolean().optional()
}).strict().superRefine((step, context) => {
  const policyActions = new Set(["goto", "login", "click", "fill", "press"]);
  if (policyActions.has(step.action) && !step.policyLabel) {
    context.addIssue({ code: "custom", path: ["policyLabel"], message: `${step.action} steps require an explicit policyLabel` });
  }

  const targetActions = new Set(["goto", "click", "fill", "press", "assert_visible", "assert_text", "approval_gate"]);
  if (targetActions.has(step.action) && !step.target?.trim()) {
    context.addIssue({ code: "custom", path: ["target"], message: `${step.action} steps require an explicit target` });
  }

  if (step.action === "fill") {
    const hasLiteral = step.value !== undefined;
    const hasEnvironmentValue = Boolean(step.valueEnv?.trim());
    if (hasLiteral === hasEnvironmentValue) {
      context.addIssue({ code: "custom", path: ["value"], message: "fill steps require exactly one of value or valueEnv" });
    }
  }

  if (step.action === "assert_text" && step.expected === undefined) {
    context.addIssue({ code: "custom", path: ["expected"], message: "assert_text steps require expected text" });
  }
});

export const QAFlowMissionSchema = z.object({
  id: ArtifactIdSchema,
  title: ShortTextSchema,
  role: LabelSchema.optional(),
  startPath: PathTextSchema.optional(),
  risk: RiskLevelSchema,
  reason: z.array(TextSchema).max(100),
  steps: z.array(MissionStepSchema).max(200)
}).strict().superRefine((mission, context) => {
  const seen = new Set<string>();
  mission.steps.forEach((step, index) => {
    if (seen.has(step.id)) {
      context.addIssue({
        code: "custom",
        path: ["steps", index, "id"],
        message: `duplicate mission step id: ${step.id}`
      });
    }
    seen.add(step.id);
  });
});

export const QAMissionSchema = z.object({
  id: ArtifactIdSchema,
  title: ShortTextSchema,
  risk: RiskLevelSchema,
  summary: TextSchema,
  affectedAreas: z.array(ImpactItemSchema).max(500),
  manualChecklist: z.array(TextSchema).max(200),
  edgeCases: z.array(TextSchema).max(200),
  automationCandidates: z.array(QAFlowMissionSchema).max(100),
  unknowns: z.array(TextSchema).max(200)
}).strict().superRefine((mission, context) => {
  const seen = new Set<string>();
  mission.automationCandidates.forEach((candidate, index) => {
    if (seen.has(candidate.id)) {
      context.addIssue({
        code: "custom",
        path: ["automationCandidates", index, "id"],
        message: `duplicate automation candidate id: ${candidate.id}`
      });
    }
    seen.add(candidate.id);
  });
});

export const StepResultSchema = z.object({
  stepId: ArtifactIdSchema,
  status: z.enum(["passed", "failed", "blocked", "skipped"]),
  message: z.string().max(10_000),
  screenshotPath: PathTextSchema.optional()
}).strict();

export const MissionRunResultSchema = z.object({
  missionId: ArtifactIdSchema,
  status: z.enum(["passed", "failed", "blocked"]),
  results: z.array(StepResultSchema).max(1_000),
  artifacts: z.array(PathTextSchema).max(5_000),
  evidence: z.object({
    tracePath: PathTextSchema.optional(),
    consolePath: PathTextSchema.optional(),
    networkPath: PathTextSchema.optional(),
    finalObservationPath: PathTextSchema.optional()
  }).strict().optional()
}).strict();

export const BrowserDecisionSchema = z.object({
  thought: z.string().min(1).max(2_000),
  action: z.enum(["goto", "click", "fill", "press", "assert", "screenshot", "wait", "scroll", "set_viewport", "finish_pass", "finish_fail", "blocked"]),
  missionStepId: ArtifactIdSchema.optional(),
  target: z.string().max(2_048).optional(),
  value: z.string().max(4_096).optional(),
  reason: z.string().min(1).max(2_000),
  evidence_needed_next: z.string().max(1_000).optional()
}).strict();

export const PromotedRegressionTestSchema = z.object({
  filePath: PathTextSchema,
  testTitle: ShortTextSchema,
  content: LongTextSchema,
  notes: z.array(TextSchema).max(200),
  coveredMissionIds: z.array(ArtifactIdSchema).max(200)
}).strict();
