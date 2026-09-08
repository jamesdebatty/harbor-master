import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ShipperError } from "../errors.js";
import { SUBSCRIPTION_CLI_DIAGNOSTICS, subscriptionCliDetails } from "./model-diagnostics.js";
import { ModelAdapterError, type ModelFailureKind, type ModelProvider } from "./live-models.js";

const NonEmpty = z.string().trim().min(1);
const ParameterName = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const WriteFileAction = z.object({
  kind: z.literal("write_file"),
  path: NonEmpty,
  content: z.string(),
}).strict();
const EditFileAction = z.object({
  kind: z.literal("edit_file"),
  path: NonEmpty,
  baseContentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  replacements: z.array(z.object({
    oldText: z.string().min(1),
    newText: z.string(),
  }).strict()).min(1),
}).strict();
const RunCommandAction = z.object({
  kind: z.literal("run_command"),
  commandId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  // Named pairs rather than a free-form map: OpenAI structured outputs refuse an object whose
  // keys are not declared, and one portable wire format beats a per-provider rewrite. A list can
  // state a name twice where a map could not, so a repeat is refused rather than resolved.
  // No default: a dropped null placeholder has to read as a missing property, not as an empty
  // list the model never sent.
  parameters: z.array(z.object({ name: ParameterName, value: z.string() }).strict())
    .refine((pairs) => new Set(pairs.map((pair) => pair.name)).size === pairs.length, "parameter names must be unique"),
}).strict();
const DocumentationDisposition = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("coverage_plan"),
    entries: z.array(z.object({ impact: NonEmpty, topic: NonEmpty, path: NonEmpty }).strict()).min(1),
  }).strict(),
  z.object({
    kind: z.literal("no_change_attestation"),
    changedSurfaces: z.array(NonEmpty),
    topicsExamined: z.array(NonEmpty),
    documentsExamined: z.array(NonEmpty).min(1),
    rationale: NonEmpty,
  }).strict(),
]);
export const PlanResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    fileActionSemantics: z.literal("base_bound_v1"),
    summary: NonEmpty,
    actions: z.array(z.discriminatedUnion("kind", [WriteFileAction, EditFileAction, RunCommandAction])).min(1),
    documentation: DocumentationDisposition,
    commitMessage: z.string().trim().min(1).max(100).refine((value) => !/[\r\n\0]/.test(value), "must be one safe line"),
  }).strict(),
  z.object({ kind: z.literal("clarification"), question: NonEmpty }).strict(),
  z.object({ kind: z.literal("refusal"), reason: NonEmpty }).strict(),
]);
const Finding = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  severity: z.enum(["advisory", "blocking"]),
  category: NonEmpty,
  location: NonEmpty,
  evidence: NonEmpty,
  requiredAction: NonEmpty,
  scopeRelation: z.enum(["in_scope", "scope_changing"]),
}).strict();
export const ReviewResponseSchema = z.object({
  verdict: z.enum(["approve", "changes_requested", "blocked"]),
  summary: NonEmpty,
  findings: z.array(Finding),
}).strict().superRefine((value, context) => {
  const blocking = value.findings.some((finding) => finding.severity === "blocking");
  if (value.verdict === "approve" && blocking) context.addIssue({ code: "custom", message: "approval cannot contain blocking findings" });
  if (value.verdict === "changes_requested" && !blocking) context.addIssue({ code: "custom", message: "changes_requested requires a blocking finding" });
});

const ProviderFailureSchema = z.object({
  kind: z.literal("provider_failure"),
  failure: z.enum(["refusal", "truncated", "malformed_output", "timeout", "rate_limit", "auth", "transport"]),
  message: NonEmpty.optional(),
  subscriptionCliDiagnostic: z.object({
    exitStatus: z.number().int(),
    category: z.enum(SUBSCRIPTION_CLI_DIAGNOSTICS),
  }).strict().optional(),
}).strict();
const attemptSequence = <T extends z.ZodType>(schema: T) => z.union([
  z.union([schema, ProviderFailureSchema]),
  z.array(z.union([schema, ProviderFailureSchema])).min(1),
]);
const plannerChannel = z.object({
  assignmentId: NonEmpty.optional(),
  provider: z.enum(["anthropic", "openai"]),
  modelRef: NonEmpty.optional(),
  responses: z.array(attemptSequence(PlanResponseSchema)).min(1),
}).strict();
const reviewerChannel = z.object({
  assignmentId: NonEmpty.optional(),
  provider: z.enum(["anthropic", "openai"]),
  modelRef: NonEmpty.optional(),
  responses: z.array(attemptSequence(ReviewResponseSchema)).min(1),
}).strict();

const AdapterFixtureSchema = z.object({
  schemaVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
  planner: plannerChannel,
  reviewer: reviewerChannel,
  plannerFallbacks: z.array(plannerChannel.extend({ assignmentId: NonEmpty })).default([]),
  reviewerFallbacks: z.array(reviewerChannel.extend({ assignmentId: NonEmpty })).default([]),
}).strict();

export type PlanResponse = z.infer<typeof PlanResponseSchema>;
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

export class RecordedModelPair {
  readonly buildProvider: ModelProvider;
  readonly reviewProvider: ModelProvider;
  readonly buildModelRef: string;
  readonly reviewModelRef: string;
  private readonly fixture: z.infer<typeof AdapterFixtureSchema>;
  readonly fixtureDigest: string;

  constructor(pathInput: string) {
    const path = resolve(pathInput);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ShipperError("adapter fixture must be a regular non-symlink file", 3);
    let raw: unknown;
    try {
      const source = readFileSync(path, "utf8");
      this.fixtureDigest = createHash("sha256").update(source).digest("hex");
      raw = JSON.parse(source);
    } catch (error) {
      throw new ShipperError(`cannot read adapter fixture: ${error instanceof Error ? error.message : String(error)}`, 3);
    }
    const parsed = AdapterFixtureSchema.safeParse(raw);
    if (!parsed.success) throw new ShipperError("adapter fixture is invalid", 3, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    this.fixture = parsed.data;
    this.buildProvider = parsed.data.planner.provider;
    this.reviewProvider = parsed.data.reviewer.provider;
    this.buildModelRef = parsed.data.planner.modelRef ?? "recorded-planner";
    this.reviewModelRef = parsed.data.reviewer.modelRef ?? "recorded-reviewer";
  }

  private channel(role: "planner" | "reviewer", assignmentId: string, primaryAssignmentId: string) {
    const primary = this.fixture[role];
    const fallbacks = role === "planner" ? this.fixture.plannerFallbacks : this.fixture.reviewerFallbacks;
    const channel = assignmentId === primaryAssignmentId
      ? primary
      : fallbacks.find((candidate) => candidate.assignmentId === assignmentId);
    if (!channel) throw new ShipperError(`recorded fixture has no ${role} channel for assignment ${assignmentId}`, 3);
    return channel;
  }

  private event<T extends PlanResponse | ReviewResponse>(
    role: "planner" | "reviewer",
    assignmentId: string,
    primaryAssignmentId: string,
    index: number,
    malformedAttempt: number,
  ): T {
    const channel = this.channel(role, assignmentId, primaryAssignmentId);
    const slot = channel.responses[index - 1];
    if (!slot) throw new ShipperError(`${channel.provider} fixture has no ${role} response for attempt ${index}`, 3);
    const events = Array.isArray(slot) ? slot : [slot];
    const event = events[malformedAttempt];
    if (!event) throw new ShipperError(`${channel.provider} fixture has no malformed-output retry ${malformedAttempt} for ${role} attempt ${index}`, 3);
    if ("kind" in event && event.kind === "provider_failure") {
      const details = event.subscriptionCliDiagnostic
        ? subscriptionCliDetails(event.subscriptionCliDiagnostic.exitStatus, event.subscriptionCliDiagnostic.category)
        : [];
      throw new ModelAdapterError(
        event.failure as ModelFailureKind,
        event.message ?? `recorded ${event.failure}`,
        details,
        details,
      );
    }
    return structuredClone(event) as T;
  }

  plan(iteration: number, malformedAttempt: number, assignmentId: string, primaryAssignmentId: string): PlanResponse {
    return this.event<PlanResponse>("planner", assignmentId, primaryAssignmentId, iteration, malformedAttempt);
  }

  review(attempt: number, malformedAttempt: number, assignmentId: string, primaryAssignmentId: string): ReviewResponse {
    return this.event<ReviewResponse>("reviewer", assignmentId, primaryAssignmentId, attempt, malformedAttempt);
  }

  modelRef(role: "planner" | "reviewer", assignmentId: string, primaryAssignmentId: string, expectedProvider: ModelProvider): string {
    const channel = this.channel(role, assignmentId, primaryAssignmentId);
    if (channel.provider !== expectedProvider) {
      throw new ShipperError(`recorded ${role} provider does not match assignment ${assignmentId}`, 3);
    }
    return channel.modelRef ?? `recorded-${role}`;
  }
}
