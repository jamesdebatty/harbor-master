import { z } from "zod";

const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const GitSha = z.string().regex(/^[0-9a-f]{40,64}$/);
const NonEmpty = z.string().min(1);
const GitIdentityName = z.string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, "must not have leading or trailing whitespace")
  .refine((value) => !/[\u0000-\u001f\u007f<>]/.test(value), "must not contain control characters or angle brackets");
const GitIdentityEmail = z.string()
  .max(320)
  .email()
  .refine((value) => !/[\u0000-\u001f\u007f<>]/.test(value), "must not contain control characters or angle brackets");
const CommitIdentity = z.object({ name: GitIdentityName, email: GitIdentityEmail }).strict();
const DefaultCommitIdentity = { name: "Graph Shipper", email: "graph-shipper@localhost.invalid" } as const;

const CredentialReference = z.object({
  id: Id,
  purpose: z.enum(["anthropic_model", "openai_model", "github_operator", "post_merge_operation"]),
}).strict();

const CommandParameter = z.object({
  type: z.enum(["positive_integer", "git_sha", "absolute_path", "opaque_id"]),
  pathRoot: z.string().optional(),
}).strict();

const Command = z.object({
  id: Id,
  argv: z.array(NonEmpty).min(1),
  authorizationSources: z.array(NonEmpty).min(1),
  cwd: z.enum(["runtime", "project_root", "worktree", "synced_main"]),
  timeoutSeconds: z.number().int().positive(),
  credentialRefs: z.array(Id),
  environmentPasslist: z.array(NonEmpty).default([]),
  sideEffect: z.enum(["none", "workspace", "repository", "github", "local_operation"]),
  idempotence: z.enum(["pure", "probe", "idempotent", "non_idempotent"]),
  dependencySources: z.object({
    manifest: NonEmpty,
    lockfile: NonEmpty,
  }).strict().optional(),
  parameters: z.record(Id, CommandParameter).default({}),
}).strict();

const AdmittedExecutable = z.object({
  id: Id,
  argvPrefix: z.array(NonEmpty).min(1),
  citation: NonEmpty,
}).strict();

const ModelAssignmentFields = {
  id: Id,
  provider: z.enum(["anthropic", "openai"]),
  modelRef: NonEmpty,
  fallbackAssignmentIds: z.array(Id).default([]),
};

const ModelAssignment = z.preprocess(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value) && !("transport" in value)
    ? { ...value, transport: "api" }
    : value,
  z.discriminatedUnion("transport", [
    z.object({ ...ModelAssignmentFields, transport: z.literal("api"), credentialRef: Id }).strict(),
    z.object({ ...ModelAssignmentFields, transport: z.literal("subscription_cli") }).strict(),
  ]),
);

const PolicyRule = z.object({
  id: Id,
  effect: z.enum(["read_only", "pre_approved", "consequential", "forbidden"]),
  actionKinds: z.array(NonEmpty).min(1),
  argvPrefix: z.array(NonEmpty).optional(),
  pathGlobs: z.array(NonEmpty).optional(),
  citation: NonEmpty,
}).strict();

const EarnedEvidence = z.object({
  observedAt: NonEmpty,
  againstHeadSha: GitSha,
  citation: NonEmpty,
}).strict();

const VerificationCheck = z.object({
  id: Id,
  cadence: z.enum(["every_cycle", "ship_path", "diff_triggered"]),
  triggerGlobs: z.array(NonEmpty).min(1),
  executor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("builtin"), check: Id }).strict(),
    z.object({ kind: z.literal("command"), commandRef: Id }).strict(),
  ]),
  failureClass: z.enum(["planner_feedback", "environment", "inconclusive_to_full_gate"]),
  earnedEvidence: EarnedEvidence,
}).strict();

const DocumentationRule = z.object({
  id: Id,
  glob: NonEmpty,
  class: z.enum(["living", "historical", "generated", "vendored_reference", "ignored_transient"]),
  audience: z.enum(["user", "operator", "contributor", "reference", "architecture", "trust_security", "release"]).optional(),
  topics: z.array(NonEmpty),
  entryPoint: z.boolean(),
  protected: z.boolean(),
  sourceGlobs: z.array(NonEmpty).min(1).optional(),
  regenerateCommandRef: Id.optional(),
  driftCheckCommandRef: Id.optional(),
}).strict();

const Retry = z.object({
  maximumAttempts: z.number().int().positive(),
  backoffSeconds: z.number().int().nonnegative(),
}).strict();

const AbsolutePath = z.string().refine(
  (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value),
  "must be an absolute POSIX, drive-letter, or UNC path",
);

const CompensatingHook = z.object({
  id: Id,
  forPostMergeHookRef: Id,
  commandRef: Id,
  priorStateCaptureCommandRef: Id,
  successCheckCommandRef: Id,
  timeoutSeconds: z.number().int().positive(),
  retry: Retry,
  ownershipBoundary: z.object({
    owner: NonEmpty,
    exactTarget: AbsolutePath,
  }).strict(),
}).strict();

const PostMergeHook = z.object({
  id: Id,
  order: z.number().int().nonnegative(),
  commandRef: Id,
  successCheckCommandRef: Id,
  retry: Retry,
  onFailure: z.literal("escalate_preserve_state"),
  compensatingHookRef: Id.optional(),
}).strict();

export const ProjectContractSchema = z.object({
  metadata: z.object({
    schemaVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
    projectId: Id,
    displayName: NonEmpty,
    canonicalPath: z.literal(".graph-shipper/project.yaml"),
  }).strict(),
  repository: z.object({
    github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    defaultBranch: NonEmpty,
    primaryCloneRealpath: AbsolutePath,
    repoFacts: z.object({
      observedAt: NonEmpty,
      observedHeadSha: GitSha,
      evidenceRef: NonEmpty,
      revalidateBefore: z.array(z.enum(["binding_admission", "work_run", "merge", "post_merge"])).min(1),
    }).strict(),
  }).strict(),
  credentials: z.object({ references: z.array(CredentialReference) }).strict(),
  executableAllowlist: z.array(AdmittedExecutable).default([]),
  commands: z.array(Command),
  models: z.object({
    buildAssignments: z.array(ModelAssignment).min(1),
    reviewAssignments: z.array(ModelAssignment).min(1),
    requireOppositeProvider: z.literal(true),
    repositoryContext: z.object({
      includeGlobs: z.array(NonEmpty).min(1),
      excludeGlobs: z.array(NonEmpty).default([]),
    }).strict(),
  }).strict(),
  workSources: z.object({
    allowedKinds: z.array(z.enum(["github_issue", "github_query", "specification", "feature_request"])).min(1),
    namedIssueQueries: z.array(z.object({
      id: Id,
      query: NonEmpty,
      order: z.enum(["oldest_first", "priority_then_oldest"]),
    }).strict()),
    maximumItemsPerQueueRun: z.number().int().positive(),
    requireRevisionPin: z.literal(true),
    requireAcceptanceCriteria: z.literal(true),
  }).strict(),
  workspace: z.discriminatedUnion("strategy", [
    z.object({
      strategy: z.literal("managed_git_worktree"),
      rootTemplate: NonEmpty,
      preparationCommandRefs: z.array(Id).default([]),
      retainOnFailure: z.literal(true),
    }).strict(),
    z.object({
      strategy: z.literal("project_helper"),
      rootTemplate: NonEmpty,
      collisionProbeCommandRef: Id,
      createCommandRef: Id,
      closeCommandRef: Id,
      retainOnFailure: z.literal(true),
    }).strict(),
  ]),
  autonomy: z.object({
    maximum: z.enum(["local_only", "open_pr", "merge_when_green"]),
    default: z.enum(["local_only", "open_pr", "merge_when_green"]),
    forbidBranchProtectionBypass: z.literal(true),
    allowStatusComments: z.boolean(),
  }).strict(),
  approvalPolicy: z.object({
    defaultEffect: z.literal("forbidden"),
    noForbiddenOverride: z.literal(true),
    rules: z.array(PolicyRule),
  }).strict(),
  verification: z.object({
    failFast: z.literal(true),
    scrubGitLocalEnvironment: z.literal(true),
    checks: z.array(VerificationCheck).min(1),
  }).strict(),
  github: z.object({
    pullRequest: z.object({
      draft: z.literal(false),
      baseBranch: NonEmpty,
      sourceReference: z.object({ kind: z.literal("neutral"), prefix: NonEmpty }).strict().optional(),
    }).strict(),
    requiredHostedChecks: z.array(NonEmpty),
    requiredCheckSource: z.enum(["check_runs", "commit_statuses"]).optional(),
    trustedFeedback: z.object({
      reviewerActors: z.array(NonEmpty),
      githubApps: z.array(NonEmpty),
      requiredCheckProducers: z.array(NonEmpty),
    }).strict(),
    requireBranchProtection: z.literal(true),
    mergeMethod: z.enum(["merge", "squash", "rebase"]),
  }).strict(),
  delivery: z.discriminatedUnion("strategy", [
    z.object({
      strategy: z.literal("github_direct"),
      terminalPredicate: z.literal("merged_and_reconciled"),
      commitIdentity: CommitIdentity.default(DefaultCommitIdentity),
    }).strict(),
    z.object({
      strategy: z.literal("project_coordinator"),
      enqueueCommandRef: Id,
      terminalPredicateCommandRef: Id,
      commitIdentity: CommitIdentity.default(DefaultCommitIdentity),
    }).strict(),
  ]),
  concurrency: z.object({
    defaultWorkRuns: z.number().int().positive(),
    maximumWorkRuns: z.number().int().positive(),
    serializeMergePerProject: z.literal(true),
    serializePostMergePerProject: z.literal(true),
  }).strict(),
  documentation: z.object({
    rules: z.array(DocumentationRule).min(1),
    formatCommandRefs: z.array(Id).default([]),
    inventoryCommandRefs: z.array(Id).default([]),
    diagramChecks: z.array(z.object({
      id: Id,
      sourceGlobs: z.array(NonEmpty).min(1),
      diagramGlobs: z.array(NonEmpty).min(1),
      commandRef: Id,
    }).strict()).default([]),
    requiredLivingEntryPoints: z.array(NonEmpty).min(1),
    triggerMatrix: z.array(z.object({
      pathGlobs: z.array(NonEmpty).min(1),
      impacts: z.array(NonEmpty).min(1),
      topics: z.array(NonEmpty),
    }).strict()).min(1),
    releaseRecord: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("changelog_unreleased"), path: NonEmpty }).strict(),
      z.object({ kind: z.literal("none") }).strict(),
    ]),
    allowReviewedNoChangeAttestation: z.literal(true),
    blockBroadRewriteWithoutWorkItemAuthority: z.literal(true),
  }).strict(),
  postMergeHooks: z.array(PostMergeHook),
  compensatingHooks: z.array(CompensatingHook).default([]),
  cleanup: z.object({
    onLocalOnlyHandoff: z.literal("preserve_owned_branch_and_worktree"),
    removeOwnedWorktreeAfterDeliveryTerminalSuccess: z.literal(true),
    removeOwnedBranchAfterDeliveryTerminalSuccess: z.boolean(),
    preserveDiagnosticsOnFailure: z.literal(true),
    neverTouchUnownedPaths: z.literal(true),
  }).strict(),
  budgets: z.object({
    maximumIterations: z.number().int().positive(),
    wallClockMinutes: z.number().int().positive(),
    malformedModelOutputRetries: z.literal(1),
  }).strict(),
}).strict();

export type ProjectContract = z.infer<typeof ProjectContractSchema>;
