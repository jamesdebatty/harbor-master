import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { ProjectContract } from "../contracts/schema.js";
import { globMatches } from "../contracts/globs.js";
import { ShipperError } from "../errors.js";
import { RecordedModelPair, type PlanResponse, type ReviewResponse } from "../adapters/model-fixture.js";
import {
  AnthropicPlannerAdapter, AnthropicReviewerAdapter, ModelAdapterError,
  OpenAIPlannerAdapter, OpenAIReviewerAdapter,
  type ModelFailureKind, type PlannerAdapter, type PlannerInput, type ReviewerAdapter, type ReviewerInput,
} from "../adapters/live-models.js";
import {
  AnthropicSubscriptionPlannerAdapter, AnthropicSubscriptionReviewerAdapter,
  OpenAISubscriptionPlannerAdapter, OpenAISubscriptionReviewerAdapter,
  probeSubscriptionProvider,
} from "../adapters/subscription-models.js";
import {
  ActivatedCommandRegistry, environmentValueErrors, renderCommand,
  type CommandResult, type CommandRoots,
} from "../actions/commands.js";
import { PostMergeAdapter, type OperationalCommandResult } from "../adapters/post-merge.js";
import { EnvironmentCredentialBroker } from "../brokers/environment.js";
import { LocalAuthorityBroker } from "../brokers/local-authority.js";
import type { AuthorityLease, AuthorityOperation } from "../brokers/ports.js";
import { StateStore, type PersistedWorkRun } from "../state/store.js";
import { JsonlTraceWriter } from "../trace/jsonl.js";
import { PersistenceRedactor } from "../security/redact.js";
import type { RunRequest } from "./schema.js";
import { RUNTIME_REVISION, VERSION } from "../version.js";
import {
  GitHubAdapter,
  type IssueRevisionObservation,
  type MergeGuardObservation,
  type MergeReceipt,
  type PullRequestObservation,
  type PullRequestReceipt,
  type ReviewPublicationReceipt,
  type SourceClosureReceipt,
} from "../adapters/github.js";
import { RecordedGitHubTransport } from "../adapters/github-fixture.js";
import { LiveGitHubTransport } from "../adapters/github-live.js";
import { SAFE_GIT_CONFIG, safeGitEnvironment } from "../runtime/git-safety.js";

type Plan = Extract<PlanResponse, { kind: "plan" }>;
type Status = PersistedWorkRun["status"];

interface OwnedWorkspace {
  path: string;
  gitDirectory: string;
}

interface WorktreeOutputFinding {
  path: string;
  detail: string;
  kind: "visible" | "unsafe_ignored";
}

interface WorkspacePreparationStatusDrift {
  untrackedFindings: WorktreeOutputFinding[];
  unsafeIgnoredFindings: WorktreeOutputFinding[];
  trackedFindings: ReadonlyMap<string, WorktreeOutputFinding>;
}

interface PinnedTrackedBlob {
  mode: "100644" | "100755" | "120000";
  objectId: string;
  path: string;
}

interface PostMergeState {
  status: "running" | "succeeded" | "failed" | "compensated" | "compensation_exhausted" | "compensation_ambiguous";
  mergedSha: string;
  hooks: Array<Record<string, unknown>>;
  priorState: Record<string, { path: string; digest: string }>;
  compensation: Record<string, unknown> | null;
}

interface RunState extends Record<string, unknown> {
  runId: string;
  projectId: string;
  repository: string;
  contractDigest: string;
  request: RunRequest;
  baseSha: string;
  headSha: string | null;
  branch: string;
  workspacePath: string | null;
  workspaceGitDirectory: string | null;
  phase: string;
  status: Status;
  iteration: number;
  reviewAttempt: number;
  refreshAttempt: number;
  startedAt: string;
  deadlineAt: string;
  runtimeVersion: string;
  runtimeRevision: string | null;
  maximumIterations: number;
  plan: Plan | null;
  preparedFileActions: PreparedFileAction[] | null;
  gatedPlan: Plan | null;
  repairFeedbackDigest: string | null;
  /**
   * The repository-local Git configuration, digested the moment the owned worktree is confirmed
   * created and before any preparation command has run. There is no environment variable that
   * suppresses the repo-local config the way GIT_CONFIG_GLOBAL suppresses the global one, so a
   * denylist of keys is the only alternative and stays permanently incomplete: `core.ignoreCase`,
   * for one, reaches the same untracked-file enumeration `SAFE_GIT_CONFIG` cannot reach because it
   * is not a command whose effect a `-c` override can cancel. Comparing this digest after
   * preparation catches a change to any key, including ones no denylist entry names yet. Null only
   * before the first digest is taken, or when the contract declares no preparation commands.
  */
  localConfigDigest: string | null;
  sharedAttributesDigest: string | null;
  changedFiles: string[];
  verification: Record<string, unknown> | null;
  documentation: Record<string, unknown> | null;
  reviewVerdict: Record<string, unknown> | null;
  priorFindings: ReviewResponse["findings"];
  findingDispositions: Array<Record<string, unknown>>;
  commandResults: CommandResult[];
  reviewBundle: Record<string, unknown> | null;
  errors: string[];
  adapterBinding: Record<string, unknown>;
  activeBuildAssignmentId: string;
  activeReviewAssignmentId: string;
  modelInvocations: Array<{
    role: "planner" | "reviewer";
    assignmentId: string;
    provider: "anthropic" | "openai";
    modelRef: string;
    graphAttempt: number;
    malformedAttempt: number;
    outcome: "success" | ModelFailureKind;
  }>;
  pullRequest: (PullRequestReceipt & { draft: false }) | null;
  hosted: PullRequestObservation | null;
  sourceRevision: IssueRevisionObservation | null;
  reviewPublication: ReviewPublicationReceipt | null;
  mergeGuard: MergeGuardObservation | null;
  merge: MergeReceipt | null;
  sourceClosure: SourceClosureReceipt | null;
  postMerge: PostMergeState | null;
  terminal: Record<string, unknown> | null;
  cleanup: Record<string, unknown> | null;
}

interface PreparedFileAction {
  actionIndex: number;
  path: string;
  content: string;
  desiredDigest: string;
  precondition: { kind: "absent" } | { kind: "exact_file"; contentSha256: string };
}

export interface WorkRunOutput {
  ok: true;
  runId: string;
  projectId: string;
  status: Status;
  phase: string;
  autonomy: "local_only" | "open_pr" | "merge_when_green";
  buildProvider: "anthropic" | "openai";
  reviewProvider: "anthropic" | "openai";
  baseSha: string;
  headSha: string;
  branch: string;
  workspacePath: string;
  verification: Record<string, unknown>;
  documentation: Record<string, unknown>;
  reviewVerdict: Record<string, unknown>;
  modelRuntimeIdentity: Record<string, unknown>;
  modelFailures: Array<{
    role: "planner" | "reviewer";
    kind: ModelFailureKind;
    graphAttempt: number;
    malformedAttempt: number;
  }>;
  evidencePath: string;
  iterations: number;
  reviewAttempts: number;
  pullRequest?: PullRequestReceipt & { draft: false };
  hosted?: PullRequestObservation;
  delivery?: Record<string, unknown>;
}

export interface PausedWorkRunOutput {
  ok: true;
  runId: string;
  projectId: string;
  status: "paused";
  phase: string;
  autonomy: "local_only" | "open_pr" | "merge_when_green";
  baseSha: string;
  headSha: string | null;
  branch: string;
  workspacePath: string | null;
  reason: "graceful_drain";
}

class InjectedCrash extends ShipperError {
  constructor(effect: string) {
    super(`injected process crash after ${effect} external apply and before receipt`, 3);
    this.name = "InjectedCrash";
  }
}

class InjectedIntentCrash extends ShipperError {
  constructor(effect: string) {
    super(`injected process crash after ${effect} intent and before external apply`, 3);
    this.name = "InjectedIntentCrash";
  }
}

class InjectedNodeCrash extends ShipperError {
  constructor(node: string) {
    super(`injected process crash after durable ${node} checkpoint`, 3);
    this.name = "InjectedNodeCrash";
  }
}

class DrainAtBoundary extends Error {
  constructor() {
    super("graceful drain requested");
    this.name = "DrainAtBoundary";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function deliveryCommandValues(
  command: ProjectContract["commands"][number],
  input: { pullRequestNumber: number; expectedHeadSha: string; runId: string },
): Record<string, string> {
  const available: Record<string, string> = {
    pr_number: String(input.pullRequestNumber),
    expected_head_sha: input.expectedHeadSha,
    run_id: input.runId,
  };
  return Object.fromEntries(Object.keys(command.parameters).map((name) => {
    const value = available[name];
    if (!value) throw new ShipperError(`${command.id}: unsupported Delivery Strategy parameter ${name}`, 4);
    return [name, value];
  }));
}

function gitRaw(root: string, args: string[]): string {
  try {
    return execFileSync("git", [...SAFE_GIT_CONFIG, ...args], {
      cwd: root,
      encoding: "utf8",
      env: safeGitEnvironment(root),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : "";
    throw new ShipperError(`Git Work Run operation failed: ${stderr || (error instanceof Error ? error.message : String(error))}`, 3);
  }
}

function assertNoExternalGitFilters(projectRoot: string): void {
  const probe = spawnSync("git", [
    ...SAFE_GIT_CONFIG,
    "config", "--local", "--includes", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
    env: safeGitEnvironment(projectRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.status === 0 && probe.stdout.trim()) {
    throw new ShipperError("repository-local Git filters are not supported by local-only Work Runs", 3, probe.stdout.trim().split("\n"));
  }
  if (probe.status !== 0 && probe.status !== 1) {
    throw new ShipperError("Git filter safety probe failed", 3, [probe.stderr.trim() || `git exited ${probe.status ?? "without status"}`]);
  }
}

function git(root: string, args: string[]): string {
  return gitRaw(root, args).trim();
}

function ownedWorkspaceGitRaw(workspace: OwnedWorkspace, args: string[]): string {
  try {
    return execFileSync("git", [...SAFE_GIT_CONFIG, ...args], {
      cwd: workspace.path,
      encoding: "utf8",
      env: safeGitEnvironment(workspace.path, workspace.gitDirectory),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : "";
    throw new ShipperError(`Git Work Run operation failed: ${stderr || (error instanceof Error ? error.message : String(error))}`, 3);
  }
}

function ownedWorkspaceGit(workspace: OwnedWorkspace, args: string[]): string {
  return ownedWorkspaceGitRaw(workspace, args).trim();
}

function gitCommitIdentityArgs(identity: ProjectContract["delivery"]["commitIdentity"]): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}

function captureOwnedWorkspace(workspacePath: string): OwnedWorkspace {
  const path = resolve(workspacePath);
  const gitDirectory = realpathSync(git(workspacePath, ["rev-parse", "--absolute-git-dir"]));
  const relation = relative(realpathSync(path), gitDirectory);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new ShipperError("owned workspace Git directory must remain outside the target worktree", 4);
  }
  return { path, gitDirectory };
}

function persistedOwnedWorkspace(state: RunState, expectedPath: string): OwnedWorkspace | null {
  if (state.workspacePath !== expectedPath || typeof state.workspaceGitDirectory !== "string") return null;
  let gitDirectory: string;
  try {
    gitDirectory = realpathSync(state.workspaceGitDirectory);
  } catch {
    return null;
  }
  if (gitDirectory !== state.workspaceGitDirectory) return null;
  return { path: resolve(state.workspacePath), gitDirectory };
}

// Scoped to neither --local nor --worktree: an unscoped, --includes read merges exactly the
// files a probe run from workspacePath would itself consult (repo-local config, config.worktree
// when extensions.worktreeConfig has turned it on, and anything either pulls in through
// include.path or includeIf), with the global and system tiers already off in safeGitEnvironment.
// A denylisted key can still be neutralized with a `-c` override at the point it is used; this
// digest exists to catch every other key, so it is deliberately not filtered to the six
// SAFE_GIT_CONFIG names.
function repositoryLocalConfigDigest(workspace: OwnedWorkspace): string {
  return digest(ownedWorkspaceGit(workspace, ["config", "--includes", "--list"]));
}

function unexcludedUntrackedSnapshot(workspace: OwnedWorkspace): Map<string, string> {
  const probe = gitProvenanceProbe(workspace, ["ls-files", "--others", "-z", "--"]);
  if (probe.status !== 0 || probe.stderr.length > 0) {
    throw new ShipperError("Git untracked path enumeration failed", 3, [probe.failure]);
  }
  return new Map(probe.stdout.split("\0").filter(Boolean).map((path) => {
    let stat;
    try {
      stat = lstatSync(join(workspace.path, path), { bigint: true });
    } catch (error) {
      throw new ShipperError("untracked path changed during gate snapshot", 4, [
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    const signature = [
      stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.rdev,
      stat.size, stat.blksize, stat.blocks, stat.mtimeNs, stat.ctimeNs,
    ].join(":");
    return [path, signature];
  }));
}

function untrackedSnapshotDelta(before: Map<string, string>, after: Map<string, string>): string[] {
  const delta: string[] = [];
  for (const [path, signature] of after) {
    const prior = before.get(path);
    if (prior === undefined) delta.push(`${path}: untracked path created by declared pure command`);
    else if (prior !== signature) delta.push(`${path}: untracked path changed by declared pure command`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) delta.push(`${path}: untracked path removed by declared pure command`);
  }
  return delta;
}

function sharedExcludeDigest(workspace: OwnedWorkspace): string {
  return sharedGitMetadataDigest(workspace, "info/exclude", "shared Git exclude file");
}

function sharedAttributesDigest(workspace: OwnedWorkspace): string {
  return sharedGitMetadataDigest(workspace, "info/attributes", "shared Git attributes file");
}

function sharedGitMetadataDigest(workspace: OwnedWorkspace, gitPath: string, label: string): string {
  const path = resolve(workspace.path, ownedWorkspaceGit(workspace, ["rev-parse", "--git-path", gitPath]));
  if (!existsSync(path)) return "absent";
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ShipperError(`${label} must be a regular non-symlink file`, 4, [path]);
  }
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function captureWorkspacePreparationBaseline(state: RunState, workspace: OwnedWorkspace): void {
  state.localConfigDigest = repositoryLocalConfigDigest(workspace);
  state.sharedAttributesDigest = sharedAttributesDigest(workspace);
}

// One status pass answers the untracked, ignored, unmerged, and ordinarily visible tracked side,
// because porcelain v2 with --ignored=matching carries the trichotomy this used to need three
// views to reconstruct. An ignored directory can collapse to one '!' record, so the structural
// walk remains the only view inside it. Every path this pass reports is drift unless the contract
// declared it, and the parse never compares a Git-produced path to a filesystem-produced one:
// there is nothing here for a Unicode normalization form or a case-fold to disagree about, because
// only Git's own answer is ever read back.
//
// A rogue nested .git entry is invisible to that pass by construction: Git does not look past a
// repository boundary, ignored or not, so a payload written under one is silent regardless of
// what hid the containing directory. Clause 2 below is the structural walk that finds it. Tracked
// content is compared by Clause 4 to checkout-filtered bytes rendered from the pinned base, while
// the observed worktree bytes are never passed through clean filters. Index flags, sparse state,
// and the stat cache are not evidence.
function assertWorkspacePreparationPostcondition(workspace: OwnedWorkspace, baseSha: string): void {
  const structuralDetails: string[] = [];
  // The structural walk runs first and fails closed on its own terms. git status only warns
  // about a directory it cannot open, still exits zero, and folds that warning into the same
  // stderr collectStatusDrift would otherwise treat as an unrelated probe failure; the walk's
  // own, more specific "owned worktree enumeration failed" is the one that should win.
  collectRogueEmbeddedRepositories(workspace, structuralDetails);
  const status = collectStatusDrift(workspace);
  const trackedDetails = new Map(
    [...status.trackedFindings].map(([path, finding]) => [path, finding.detail]),
  );
  for (const [path, detail] of collectSuppressedTrackedPaths(workspace)) {
    if (!trackedDetails.has(path)) trackedDetails.set(path, detail);
  }
  for (const [path, detail] of collectTrackedContentDrift(workspace, baseSha)) trackedDetails.set(path, detail);
  const untrackedDetails = status.untrackedFindings.map((finding) => finding.detail);
  const unsafeIgnoredDetails = status.unsafeIgnoredFindings.map((finding) => finding.detail);
  const undeclared = [
    ...trackedDetails.values(), ...structuralDetails, ...untrackedDetails, ...unsafeIgnoredDetails,
  ];
  if (undeclared.length === 0) return;
  const reported = undeclared.length > 20
    ? [...undeclared.slice(0, 20), `and ${undeclared.length - 20} more undeclared paths`]
    : undeclared;
  throw new ShipperError("workspace preparation left output the project has not declared", 4, [
    ...reported,
    ...(untrackedDetails.length > 0 || unsafeIgnoredDetails.length > 0 ? [
      "install output must be ignored by a tracked .gitignore; a shared info/exclude, a core.excludesFile, or an uncommitted .gitignore is writable by the install itself",
    ] : []),
    `retained worktree: ${workspace.path}`,
  ]);
}

function undeclaredWorktreeOutput(workspace: OwnedWorkspace): WorktreeOutputFinding[] {
  const status = collectStatusDrift(workspace);
  return [
    ...status.trackedFindings.values(),
    ...status.untrackedFindings,
    ...status.unsafeIgnoredFindings,
  ];
}

function boundWorktreeOutputFindings(findings: string[]): { findings: string[]; totalCount: number } {
  return { findings: findings.slice(0, 20), totalCount: findings.length };
}

function cleanupOutputFindingsFromIntent(intent: Record<string, unknown>): { findings: string[]; totalCount: number } {
  const findings = intent.undeclaredWorktreeOutput;
  const totalCount = intent.undeclaredWorktreeOutputCount;
  if (!Array.isArray(findings) || !findings.every((finding) => typeof finding === "string")
    || typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0
    || findings.length !== Math.min(totalCount, 20)) {
    throw new ShipperError("cleanup intent carries invalid hidden-output evidence", 4);
  }
  return { findings, totalCount };
}

function reviewPublicationFromReceipt(
  receipt: Record<string, unknown> | undefined,
  expected: { headSha: string; runId: string; reviewProvider: "anthropic" | "openai"; reviewBundleDigest: string },
): ReviewPublicationReceipt {
  if (!receipt
    || !Number.isSafeInteger(receipt.commentId)
    || receipt.headSha !== expected.headSha
    || receipt.runId !== expected.runId
    || receipt.reviewProvider !== expected.reviewProvider
    || receipt.reviewBundleDigest !== expected.reviewBundleDigest
    || !["published", "adopted"].includes(String(receipt.disposition))) {
    throw new ShipperError("review publication effect carries an invalid receipt", 4);
  }
  return {
    disposition: "adopted",
    commentId: receipt.commentId as number,
    headSha: expected.headSha,
    runId: expected.runId,
    reviewProvider: expected.reviewProvider,
    reviewBundleDigest: expected.reviewBundleDigest,
  };
}

// Clause 1. Every '?' path is undeclared outright: --ignored=matching means a path git status
// still calls untracked is not ignored by anything, whatever hid it from the older two-view join.
// Every '1'/'2' path is tracked drift, submodule or not: the <sub> field's own bits (a commit
// change, tracked changes, or untracked content) are folded into the same XY the general case
// already reads, so there is no separate submodule question to ask. Only '!' needs a second call,
// because status names the ignored path but not the rule that decided it.
//
function collectStatusDrift(workspace: OwnedWorkspace): WorkspacePreparationStatusDrift {
  const probe = gitProvenanceProbe(workspace, ["status", "--porcelain=v2", "-z", "-uall", "--ignored=matching"]);
  assertGitProbeSucceeded(probe, "Git status probe failed");
  const tokens = probe.stdout.split("\0");
  const untrackedFindings: WorktreeOutputFinding[] = [];
  const unsafeIgnoredFindings: WorktreeOutputFinding[] = [];
  const ignoredPaths: string[] = [];
  const trackedFindings = new Map<string, WorktreeOutputFinding>();
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index] ?? "";
    if (record.length === 0) continue;
    switch (record[0]) {
      case "?":
        {
          const path = afterFields(record, 1);
          untrackedFindings.push({ path, detail: `${path}: untracked and not ignored by any rule`, kind: "visible" });
        }
        break;
      case "!":
        ignoredPaths.push(afterFields(record, 1));
        break;
      case "1": {
        const path = afterFields(record, 8);
        trackedFindings.set(path, { path, detail: `${path}: tracked change left in the owned worktree`, kind: "visible" });
        break;
      }
      case "2": {
        const path = afterFields(record, 9);
        const origin = tokens[index + 1];
        if (!origin) throw new ShipperError("Git returned an incomplete porcelain v2 rename record", 3, [record]);
        index += 1;
        trackedFindings.set(path, { path, detail: `${path}: tracked change left in the owned worktree`, kind: "visible" });
        trackedFindings.set(origin, { path: origin, detail: `${origin}: tracked change left in the owned worktree`, kind: "visible" });
        break;
      }
      case "u": {
        const path = afterFields(record, 10);
        trackedFindings.set(path, { path, detail: `${path}: unmerged path left in the owned worktree`, kind: "visible" });
        break;
      }
      default:
        throw new ShipperError("Git returned an invalid porcelain v2 status record", 3, [record]);
    }
  }
  collectIgnoredProvenance(workspace, ignoredPaths, unsafeIgnoredFindings);
  return { untrackedFindings, unsafeIgnoredFindings, trackedFindings };
}

// Returns the substring of a space-delimited porcelain v2 record after its first `fieldCount`
// fields. Every fixed field before the path is a mode or a hash with no embedded space, so the
// path is exactly what follows the nth space.
function afterFields(record: string, fieldCount: number): string {
  let index = 0;
  for (let step = 0; step < fieldCount; step += 1) {
    const next = record.indexOf(" ", index);
    if (next < 0) throw new ShipperError("Git returned an invalid porcelain v2 status record", 3, [record]);
    index = next + 1;
  }
  return record.slice(index);
}

// Which rule decided each ignored path, carried over unchanged from the two-view join: only a
// tracked .gitignore is a rule the contract digest reaches, core.excludesFile is neutralized on
// this probe so an install cannot promote a tracked file into that role, and a path opening with
// the ':' pathspec sigil is refused unprobed rather than resolved against the wrong path.
function collectIgnoredProvenance(
  workspace: OwnedWorkspace,
  ignoredPaths: string[],
  findings: WorktreeOutputFinding[],
): void {
  const probeable: string[] = [];
  for (const path of ignoredPaths) {
    if (path.startsWith(":")) findings.push({
      path,
      detail: `${path}: opens with a pathspec sigil and cannot be attributed to a rule`,
      kind: "unsafe_ignored",
    });
    else probeable.push(path);
  }
  if (probeable.length === 0) return;
  const decided = gitProvenanceProbe(
    workspace,
    ["-c", "core.excludesFile=", "check-ignore", "-v", "-z", "--non-matching", "--stdin"],
    probeable.map((path) => `${path}\0`).join(""),
  );
  // check-ignore exits 1 when no input path is ignored, which is a verdict rather than a failure.
  if (decided.status !== 0 && decided.status !== 1) {
    throw new ShipperError("Git ignore provenance probe failed", 3, [decided.failure]);
  }
  const fields = decided.stdout.split("\0");
  const trackedSources = new Map<string, boolean>();
  // <source>\0<line>\0<pattern>\0<path>\0, with an empty source for a path no rule ignores.
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const source = fields[index] ?? "";
    let sourceIsTracked = trackedSources.get(source);
    if (sourceIsTracked === undefined) {
      sourceIsTracked = isTrackedGitignore(workspace, source);
      trackedSources.set(source, sourceIsTracked);
    }
    if (!sourceIsTracked) {
      const path = fields[index + 3] ?? "";
      findings.push({ path, detail: `${path}: ${source || "ignored by no rule"}`, kind: "unsafe_ignored" });
    }
  }
}

// Clause 4. Ask Git for the pinned blobs after the same checkout filters a fresh owned worktree
// receives, then compare those expected bytes and modes to disk in memory. No worktree index fact
// participates and no repository content crosses the Persistence Boundary.
function collectTrackedContentDrift(workspace: OwnedWorkspace, baseSha: string): ReadonlyMap<string, string> {
  const blobs = pinnedTrackedBlobs(workspace, baseSha);
  const fileModeMatters = gitBooleanConfig(workspace, "core.filemode", true);
  const symbolicLinksEnabled = gitBooleanConfig(workspace, "core.symlinks", true);
  const drifted = new Map<string, string>();
  for (const blob of blobs) {
    const absolutePath = resolve(workspace.path, blob.path);
    const relation = relative(workspace.path, absolutePath);
    if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
      drifted.set(blob.path, `${blob.path}: tracked content resolves outside the owned worktree`);
      continue;
    }
    assertNoSymlinkAncestors(dirname(absolutePath), [workspace.path]);
    let stat: Stats | null;
    let content: Buffer;
    try {
      stat = lstatIfPresent(absolutePath);
      if (stat === null) {
        drifted.set(blob.path, `${blob.path}: tracked content differs from the pinned base`);
        continue;
      }
      content = stat.isSymbolicLink()
        ? readlinkSync(absolutePath, { encoding: "buffer" })
        : readFileSync(absolutePath);
    } catch (error) {
      drifted.set(blob.path, `${blob.path}: tracked content could not be read safely: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const expectedSymbolicLink = blob.mode === "120000" && symbolicLinksEnabled;
    const expectedRegularFile = blob.mode !== "120000" || !symbolicLinksEnabled;
    const executable = stat.mode & 0o111;
    if ((expectedSymbolicLink && !stat.isSymbolicLink())
      || (expectedRegularFile && !stat.isFile())
      || (blob.mode === "100755" && fileModeMatters && executable === 0)
      || (blob.mode === "100644" && fileModeMatters && executable !== 0)) {
      drifted.set(blob.path, `${blob.path}: tracked content differs from the pinned base`);
      continue;
    }
    const algorithm = blob.objectId.length === 40 ? "sha1" : "sha256";
    const rawObjectId = createHash(algorithm)
      .update(`blob ${content.byteLength}\0`)
      .update(content)
      .digest("hex");
    if (rawObjectId !== blob.objectId && !content.equals(filteredPinnedBlobContent(workspace, blob))) {
      drifted.set(blob.path, `${blob.path}: tracked content differs from the pinned base`);
    }
  }
  return drifted;
}

function pinnedTrackedBlobs(workspace: OwnedWorkspace, baseSha: string): PinnedTrackedBlob[] {
  const tree = gitProvenanceProbe(workspace, ["ls-tree", "-r", "-z", "--full-tree", baseSha]);
  assertGitProbeSucceeded(tree, "Git pinned-tree enumeration failed");
  const blobs: PinnedTrackedBlob[] = [];
  for (const record of tree.stdout.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(" ");
    const [mode, type, expectedObjectId] = metadata;
    if (metadata.length !== 3 || typeof type !== "string" || typeof expectedObjectId !== "string"
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedObjectId)) {
      throw new ShipperError("Git returned an invalid pinned-tree record", 3, [record]);
    }
    if (type === "commit") continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755" && mode !== "120000")) {
      throw new ShipperError("Git returned an unsupported pinned-tree object", 3, [record]);
    }
    blobs.push({ mode, objectId: expectedObjectId, path: record.slice(tab + 1) });
  }
  return blobs;
}

function filteredPinnedBlobContent(workspace: OwnedWorkspace, blob: PinnedTrackedBlob): Buffer {
  const probe = spawnGitProvenance(workspace, [
    "cat-file", "--filters", `--path=${blob.path}`, blob.objectId,
  ], undefined, true);
  const stderr = Buffer.isBuffer(probe.stderr) ? probe.stderr.toString("utf8").trim() : String(probe.stderr ?? "").trim();
  if (probe.status !== 0 || stderr.length > 0 || !Buffer.isBuffer(probe.stdout)) {
    throw new ShipperError("Git filtered pinned-content probe failed", 3, [stderr || probe.error?.message || `git exited ${probe.status ?? "without status"}`]);
  }
  return probe.stdout;
}

function gitBooleanConfig(workspace: OwnedWorkspace, key: string, fallback: boolean): boolean {
  const probe = gitProvenanceProbe(workspace, ["config", "--bool", "--get", key]);
  if (probe.status === 1 && probe.stderr.length === 0) return fallback;
  assertGitProbeSucceeded(probe, `Git boolean configuration probe failed: ${key}`);
  const value = probe.stdout.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ShipperError(`Git returned an invalid boolean configuration value: ${key}`, 3, [value]);
}

// A fresh owned worktree inherits neither bit. Refusing either one after preparation succeeds is
// therefore fail-closed evidence handling, not a restriction on legitimate project state.
function collectSuppressedTrackedPaths(workspace: OwnedWorkspace): ReadonlyMap<string, string> {
  const probe = gitProvenanceProbe(workspace, ["ls-files", "-v", "-z", "--"]);
  assertGitProbeSucceeded(probe, "Git tracked-path suppression probe failed");
  const suppressed = new Map<string, string>();
  for (const record of probe.stdout.split("\0").filter(Boolean)) {
    if (record.length < 3 || record[1] !== " ") {
      throw new ShipperError("Git returned an invalid tracked-path suppression record", 3, [record]);
    }
    const tag = record[0] ?? "";
    const path = record.slice(2);
    if (tag === "S") suppressed.set(path, `${path}: marked skip-worktree`);
    else if (/^[a-z]$/.test(tag)) suppressed.set(path, `${path}: marked assume-unchanged`);
  }
  return suppressed;
}

// Clause 2 and 3. Any entry named .git below the root is a repository boundary Git will not look
// past, ignored or not, so the only way to find a rogue one is to walk the filesystem for the name
// and ask Git what it thinks of the containing directory. ls-files --stage on that directory
// returns a single 160000 entry for a registered gitlink (clause 1 already covers whatever is
// dirty inside it) or nothing at all for a rogue .git, in which case the whole subtree beneath it
// is drift without needing to be enumerated. The comparison here is the mode Git reports back,
// never a path read from one source compared against a path read from the other.
//
// A symlink is a leaf: withFileTypes reports a symlink's own dirent type regardless of what it
// points to, so the walk never follows one, whether it escapes the worktree or loops back into it.
//
// The walk fails closed rather than warns. git status only warns about a directory it cannot open
// and still exits zero, which is exactly the gap an install can hide a tree behind; a directory
// this walk cannot read is drift, full stop.
function collectRogueEmbeddedRepositories(workspace: OwnedWorkspace, undeclared: string[]): void {
  const workspacePath = workspace.path;
  const walk = (absolute: string, relativePath: string): void => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      throw new ShipperError("owned worktree enumeration failed", 3, [
        `${relativePath || "."}: ${error instanceof Error ? error.message : String(error)}`,
        `retained worktree: ${workspacePath}`,
      ]);
    }
    for (const entry of entries) {
      if (relativePath.length === 0 && entry.name === ".git") continue;
      const path = relativePath.length > 0 ? `${relativePath}/${entry.name}` : entry.name;
      // Preserve PR #49's required case-variant regression: on a case-insensitive worktree the
      // filesystem resolves .GIT as the same reserved boundary Git spells .git, so byte-exact
      // matching would reopen the blind subtree under another spelling.
      if (entry.name.toLowerCase() === ".git") {
        if (relativePath.length > 0) {
          const stage = gitProvenanceProbe(workspace, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", relativePath]);
          if (stage.status !== 0) {
            throw new ShipperError("Git index enumeration failed", 3, [stage.failure]);
          }
          const records = stage.stdout.split("\0").filter((record) => record.length > 0);
          if (records.length === 1 && (records[0] ?? "").startsWith("160000 ")) continue;
        }
        undeclared.push(`${path}: nested .git entry is not a registered submodule`);
        continue;
      }
      if (!entry.isDirectory()) continue;
      walk(join(absolute, entry.name), path);
    }
  };
  walk(workspacePath, "");
}

function isTrackedGitignore(workspace: OwnedWorkspace, source: string): boolean {
  if (source.length === 0 || isAbsolute(source) || basename(source) !== ".gitignore") return false;
  return gitProvenanceProbe(workspace, ["--literal-pathspecs", "ls-files", "--error-unmatch", "-z", "--", source]).status === 0;
}

// An untracked dependency tree is one path per file here, so neither probe can run under
// execFileSync's default one-megabyte buffer. A spawn that never ran reports no streams at all,
// so the failure detail is resolved where both cases are in view.
function gitProvenanceProbe(
  workspace: OwnedWorkspace,
  args: string[],
  input?: string,
): {
  status: number | null; stdout: string; stderr: string; failure: string;
} {
  const probe = spawnGitProvenance(workspace, args, input);
  const stderr = typeof probe.stderr === "string" ? probe.stderr.trim() : (probe.stderr?.toString("utf8") ?? "").trim();
  const stdout = typeof probe.stdout === "string" ? probe.stdout : probe.stdout?.toString("utf8");
  return {
    status: probe.status,
    stdout: stdout ?? "",
    stderr,
    failure: stderr || probe.error?.message || `git exited ${probe.status ?? "without status"}`,
  };
}

function spawnGitProvenance(
  workspace: OwnedWorkspace,
  args: string[],
  input?: string | Buffer,
  binary = false,
) {
  return spawnSync("git", [...SAFE_GIT_CONFIG, ...args], {
    cwd: workspace.path,
    input,
    ...(binary ? {} : { encoding: "utf8" as const }),
    env: safeGitEnvironment(workspace.path, workspace.gitDirectory),
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function assertGitProbeSucceeded(
  probe: { status: number | null; stderr: string; failure: string },
  message: string,
): void {
  if (probe.status !== 0 || probe.stderr.length > 0) throw new ShipperError(message, 3, [probe.failure]);
}

function findUnattributableWorktreeOutput(
  prepared: PreparedFileAction[] | null,
  findings: WorktreeOutputFinding[],
): WorktreeOutputFinding[] {
  if (prepared === null || new Set(prepared.map((action) => action.path)).size !== prepared.length) return findings;
  const plannedPaths = new Set(prepared.map((action) => action.path));
  return findings.filter((finding) => !plannedPaths.has(finding.path));
}

function worktreeOutputIsAttributable(
  prepared: PreparedFileAction[] | null,
  findings: WorktreeOutputFinding[],
): prepared is PreparedFileAction[] {
  return prepared !== null
    && new Set(prepared.map((action) => action.path)).size === prepared.length
    && findings.every((finding) => prepared.some((action) => action.path === finding.path));
}

function reclaimOwnedTempRoot(ownedTempPath: string, dataRoot: string): void {
  if (!existsSync(ownedTempPath)) return;
  assertNoSymlinkAncestors(ownedTempPath, [dataRoot]);
  const observed = lstatSync(ownedTempPath);
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new ShipperError("cleanup refused an invalid owned temp root", 4, [ownedTempPath]);
  }
  rmSync(ownedTempPath, { recursive: true });
}

function isAncestor(workspace: OwnedWorkspace, ancestor: string, descendant: string): boolean {
  if (!/^[0-9a-f]{40,64}$/.test(ancestor) || !/^[0-9a-f]{40,64}$/.test(descendant)) return false;
  try {
    ownedWorkspaceGit(workspace, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function isRegisteredOwnedWorktree(projectRoot: string, workspace: OwnedWorkspace): boolean {
  if (!existsSync(workspace.path)) return false;
  try {
    const canonicalWorkspace = realpathSync(workspace.path);
    const registered = git(projectRoot, ["worktree", "list", "--porcelain"])
      .split("\n")
      .some((line) => line === `worktree ${canonicalWorkspace}`);
    if (!registered) return false;
    const projectCommon = realpathSync(resolve(projectRoot, git(projectRoot, ["rev-parse", "--git-common-dir"])));
    const workspaceCommon = realpathSync(resolve(workspace.gitDirectory, ownedWorkspaceGit(workspace, ["rev-parse", "--git-common-dir"])));
    return projectCommon === workspaceCommon;
  } catch {
    return false;
  }
}

function validateRequestAgainstContract(request: RunRequest, contract: ProjectContract): {
  build: ProjectContract["models"]["buildAssignments"][number];
  review: ProjectContract["models"]["reviewAssignments"][number];
} {
  const errors: string[] = [];
  if (request.workItem.projectId !== contract.metadata.projectId) errors.push("Work Item project does not match the activated Project Contract");
  if (request.workItem.baseBranch !== contract.repository.defaultBranch) errors.push("Work Item base branch does not match the Project Contract");
  if (!contract.workSources.allowedKinds.includes(request.workItem.source.kind)) errors.push("Work Item source kind is not contract-authorized");
  const autonomyRank = { local_only: 0, open_pr: 1, merge_when_green: 2 } as const;
  if (autonomyRank[request.autonomy] > autonomyRank[contract.autonomy.maximum]) errors.push("requested autonomy exceeds the activated Project Contract");
  if (contract.workspace.strategy !== "managed_git_worktree") errors.push("T-022 supports only the managed Git worktree workspace strategy");
  if (contract.verification.checks.some((check) => check.executor.kind !== "command")) {
    errors.push("T-022 supports only explicitly allowlisted command verification checks");
  }
  const build = contract.models.buildAssignments.find((assignment) => assignment.id === request.buildAssignmentId);
  const review = contract.models.reviewAssignments.find((assignment) => assignment.id === request.reviewAssignmentId);
  if (!build) errors.push("unknown build assignment");
  if (!review) errors.push("unknown review assignment");
  if (build && review && build.provider === review.provider) errors.push("Review Provider must be opposite the Build Provider");
  for (const path of request.workItem.repositoryContextManifest?.paths ?? []) {
    if (!modelContextPathAllowed(contract, path)) errors.push(`repository context path exceeds the activated Project Contract: ${path}`);
  }
  if (errors.length > 0 || !build || !review) throw new ShipperError("Run Request exceeds the activated contract", 3, errors);
  return { build, review };
}

function assertModelActionAuthorized(contract: ProjectContract, actionKind: string, path?: string): void {
  const matching = contract.approvalPolicy.rules.filter((rule) => (
    (rule.actionKinds.includes(actionKind) || rule.actionKinds.includes("*"))
    && (!path || !rule.pathGlobs || rule.pathGlobs.some((glob) => globMatches(glob, path)))
  ));
  const forbidden = matching.find((rule) => rule.effect === "forbidden");
  const allowed = matching.find((rule) => rule.effect === "pre_approved" || (rule.effect === "read_only" && actionKind.startsWith("run_command:")));
  if (forbidden || !allowed) {
    throw new ShipperError(`activated approval policy denied ${actionKind}${path ? ` at ${path}` : ""}`, 4, [
      forbidden ? `forbidden by ${forbidden.id}: ${forbidden.citation}` : `default effect: ${contract.approvalPolicy.defaultEffect}`,
    ]);
  }
}

function preparePlanFileActions(
  plan: Plan,
  contract: ProjectContract,
  registry: ActivatedCommandRegistry,
  workspace: OwnedWorkspace,
): PreparedFileAction[] {
  assertModelSafeContent("Build Provider plan", JSON.stringify(plan));
  const seenPaths = new Set<string>();
  const prepared: PreparedFileAction[] = [];
  for (const [actionIndex, action] of plan.actions.entries()) {
    if (action.kind === "run_command") {
      const command = registry.get(action.commandId);
      assertModelActionAuthorized(contract, `run_command:${command.id}`);
      if (command.cwd !== "worktree" || command.sideEffect !== "none" || command.idempotence !== "pure") {
        throw new ShipperError(`${command.id}: model-selected commands must be pure observations in the owned worktree`, 3);
      }
      renderCommand(command, Object.fromEntries(action.parameters.map((parameter) => [parameter.name, parameter.value])));
      continue;
    }
    assertModelActionAuthorized(contract, "write_file", action.path);
    registry.assertMutablePath(action.path);
    const target = safeWorkspaceFile(workspace.path, action.path);
    if (seenPaths.has(action.path)) throw new ShipperError(`plan targets a file more than once: ${action.path}`, 3);
    seenPaths.add(action.path);
    if (action.kind === "write_file") {
      if (existsSync(target)) throw new ShipperError(`write_file requires a new path; use edit_file for existing path: ${action.path}`, 3);
      assertModelSafeContent(action.path, action.content);
      prepared.push({
        actionIndex, path: action.path, content: action.content, desiredDigest: digest(action.content),
        precondition: { kind: "absent" },
      });
      continue;
    }
    if (!existsSync(target)) throw new ShipperError(`edit_file requires an existing path: ${action.path}`, 3);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ShipperError(`edit_file target is not a regular file: ${action.path}`, 3);
    const source = readFileSync(target, "utf8");
    if (digest(source) !== action.baseContentSha256) throw new ShipperError(`edit_file base digest is stale: ${action.path}`, 3);
    const spans = action.replacements.map((replacement) => {
      const matches: number[] = [];
      for (let cursor = 0; cursor <= source.length - replacement.oldText.length;) {
        const match = source.indexOf(replacement.oldText, cursor);
        if (match < 0) break;
        matches.push(match);
        cursor = match + 1;
      }
      if (matches.length === 0) throw new ShipperError(`edit_file oldText was not found: ${action.path}`, 3);
      if (matches.length > 1) throw new ShipperError(`edit_file oldText is ambiguous: ${action.path}`, 3);
      return { start: matches[0]!, end: matches[0]! + replacement.oldText.length, newText: replacement.newText };
    });
    const ordered = [...spans].sort((left, right) => left.start - right.start);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.start < ordered[index - 1]!.end) throw new ShipperError(`edit_file replacements overlap: ${action.path}`, 3);
    }
    let content = source;
    for (const span of [...ordered].sort((left, right) => right.start - left.start)) {
      content = `${content.slice(0, span.start)}${span.newText}${content.slice(span.end)}`;
    }
    assertModelSafeContent(action.path, content);
    prepared.push({
      actionIndex, path: action.path, content, desiredDigest: digest(content),
      precondition: { kind: "exact_file", contentSha256: action.baseContentSha256 },
    });
  }
  return prepared;
}

function resolveWorkspacePath(projectRoot: string, template: string, runId: string): string {
  const expanded = template
    .replaceAll("<repo-parent>", dirname(projectRoot))
    .replaceAll("<run-id>", runId);
  if (expanded.includes("<")) throw new ShipperError("workspace root template contains an unknown placeholder", 3);
  const path = resolve(expanded);
  if (!isAbsolute(path)) throw new ShipperError("workspace root template must resolve to an absolute path", 3);
  const canonicalPath = canonicalProspectivePath(path);
  const fromProject = relative(realpathSync(projectRoot), canonicalPath);
  if (fromProject === "" || (!fromProject.startsWith("..") && !isAbsolute(fromProject))) {
    throw new ShipperError("owned workspace must remain outside the primary clone", 3);
  }
  return path;
}

function canonicalProspectivePath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function safeWorkspaceFile(workspacePath: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new ShipperError(`workspace action path is invalid: ${relativePath}`, 3);
  }
  if (relativePath === ".git" || relativePath.startsWith(".git/") || relativePath === ".gitattributes" || relativePath === ".graph-shipper/project.yaml") {
    throw new ShipperError(`workspace action path is protected: ${relativePath}`, 3);
  }
  const canonicalWorkspace = realpathSync(workspacePath);
  const target = resolve(canonicalWorkspace, relativePath);
  const fromWorkspace = relative(canonicalWorkspace, target);
  if (!fromWorkspace || fromWorkspace.startsWith("..") || isAbsolute(fromWorkspace)) {
    throw new ShipperError(`workspace action escapes the owned worktree: ${relativePath}`, 3);
  }
  let cursor = canonicalWorkspace;
  for (const segment of relativePath.split(/[\\/]/).slice(0, -1)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new ShipperError(`workspace action traverses a symlink: ${relativePath}`, 3);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new ShipperError(`workspace action target is a symlink: ${relativePath}`, 3);
  return target;
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assertNoSymlinkAncestors(path: string, trustedRoots: string[]): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const segment of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      const trustedSystemAncestor = trustedRoots.some((trustedRoot) => {
        const relation = relative(cursor, resolve(trustedRoot));
        return relation !== "" && !relation.startsWith("..") && !isAbsolute(relation);
      });
      if (!trustedSystemAncestor) throw new ShipperError(`owned path traverses a symlink: ${cursor}`, 3);
    }
  }
}

function persisted(state: RunState): PersistedWorkRun {
  return {
    runId: state.runId,
    projectId: state.projectId,
    contractDigest: state.contractDigest,
    workItemRevision: state.request.workItem.source.revision,
    phase: state.phase,
    status: state.status,
    state,
    createdAt: state.startedAt,
    updatedAt: new Date().toISOString(),
  };
}

function checkpoint(store: StateStore, trace: JsonlTraceWriter, state: RunState, phase: string, payload: Record<string, unknown> = {}): void {
  state.phase = phase;
  store.checkpointWorkRun(persisted(state));
  trace.append(state.runId, { at: new Date().toISOString(), eventType: "checkpoint", payload: { phase, ...payload } });
}

async function prepareEffect(
  store: StateStore,
  state: RunState,
  broker: LocalAuthorityBroker,
  kind: AuthorityOperation,
  target: string,
  desiredDigest: string,
  metadata: Record<string, unknown> = {},
): Promise<{
  effectId: string;
  lease: AuthorityLease;
  alreadyCompleted: boolean;
  terminalState?: "applied" | "adopted" | "failed" | "indeterminate";
  receipt?: Record<string, unknown>;
}> {
  const effectId = digest([state.projectId, state.runId, state.request.workItem.source.revision, state.contractDigest, state.headSha, kind, target, desiredDigest]);
  const existing = store.effect(effectId);
  if (existing && existing.state !== "prepared") {
    return {
      effectId,
      lease: existing.intent.authorityLease as unknown as AuthorityLease,
      alreadyCompleted: true,
      terminalState: existing.state,
      ...(existing.receipt ? { receipt: existing.receipt } : {}),
    };
  }
  const now = new Date();
  const request = {
    contractDigest: state.contractDigest,
    projectId: state.projectId,
    repository: state.repository,
    workRunId: state.runId,
    workItemRevision: state.request.workItem.source.revision,
    expectedHeadSha: state.headSha ?? state.baseSha,
    ...(typeof metadata.expectedBaseSha === "string" ? { expectedBaseSha: metadata.expectedBaseSha } : {}),
    operation: kind,
    budget: {
      iteration: state.iteration,
      maximumIterations: state.maximumIterations,
      deadlineAt: state.deadlineAt,
    },
    autonomy: state.request.autonomy,
    ...(typeof metadata.hookId === "string" ? { hookId: metadata.hookId } : {}),
    expiresAt: new Date(Math.min(now.getTime() + 5 * 60_000, Date.parse(state.deadlineAt))).toISOString(),
  };
  const decision = await broker.issueLease(request);
  if (!decision.allowed) throw new ShipperError(`Authority Broker denied ${kind}`, 4, [decision.reason]);
  const lease = decision.lease;
  store.prepareEffect({
    effectId, runId: state.runId, kind, target, desiredDigest, state: "prepared",
    intent: { effectId, kind, target, desiredDigest, replayPolicy: "reconcile_before_replay", authorityLease: lease, ...metadata },
    preparedAt: now.toISOString(),
  });
  return { effectId, lease, alreadyCompleted: false };
}

function assertLease(state: RunState, lease: AuthorityLease, kind: AuthorityOperation, hookId?: string): void {
  const errors: string[] = [];
  if (lease.contractDigest !== state.contractDigest) errors.push("contract digest changed");
  if (lease.projectId !== state.projectId) errors.push("project changed");
  if (lease.repository !== state.repository) errors.push("repository changed");
  if (lease.workRunId !== state.runId) errors.push("Work Run changed");
  if (lease.workItemRevision !== state.request.workItem.source.revision) errors.push("Work Item revision changed");
  if (lease.expectedHeadSha !== (state.headSha ?? state.baseSha)) errors.push("expected head changed");
  if (kind === "merge_exact_head" && lease.expectedBaseSha !== state.baseSha) errors.push("expected base changed");
  if (lease.autonomy !== state.request.autonomy) errors.push("autonomy changed");
  if (lease.budget.maximumIterations !== state.maximumIterations || lease.budget.iteration !== state.iteration || lease.budget.deadlineAt !== state.deadlineAt) {
    errors.push("budget scope changed");
  }
  if (Date.parse(lease.budget.deadlineAt) <= Date.now()) errors.push("Work Run budget expired");
  if (lease.operation !== kind) errors.push("operation changed");
  if (hookId !== undefined && lease.hookId !== hookId) errors.push("hook changed");
  if (Date.parse(String(lease.expiresAt)) <= Date.now()) errors.push("lease expired");
  if (errors.length > 0) throw new ShipperError(`local Authority Lease denied ${kind}`, 4, errors);
}

function completeEffect(store: StateStore, effectId: string, observed: Record<string, unknown>): void {
  store.completeEffect(effectId, "applied", observed, new Date().toISOString());
}

async function writeWorkspaceFile(
  store: StateStore,
  state: RunState,
  authority: LocalAuthorityBroker,
  workspacePath: string,
  path: string,
  content: string,
  precondition: PreparedFileAction["precondition"],
  crashAfterIntent?: string,
  crashAfterEffect?: string,
): Promise<void> {
  const target = safeWorkspaceFile(workspacePath, path);
  const desiredDigest = digest(content);
  const { effectId, lease, alreadyCompleted } = await prepareEffect(
    store, state, authority, "file_write", path, desiredDigest, { precondition },
  );
  if (alreadyCompleted) {
    if (!existsSync(target) || digest(readFileSync(target, "utf8")) !== desiredDigest) {
      throw new ShipperError(`completed file effect drifted: ${path}`, 4);
    }
    return;
  }
  if (crashAfterIntent === "file_write") throw new InjectedIntentCrash("file_write");
  assertLease(state, lease, "file_write");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (precondition.kind === "absent" && existsSync(target)) {
    throw new ShipperError(`prepared new-file target is no longer absent: ${path}`, 4);
  }
  if (precondition.kind === "exact_file" && !existsSync(target)) {
    throw new ShipperError(`prepared edit target disappeared before file effect: ${path}`, 4);
  }
  const flags = precondition.kind === "absent"
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
    : constants.O_RDWR | (constants.O_NOFOLLOW ?? 0);
  let descriptor: number;
  try {
    descriptor = openSync(target, flags, 0o600);
  } catch (error) {
    if (precondition.kind === "absent" && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ShipperError(`prepared new-file target is no longer absent: ${path}`, 4);
    }
    if (precondition.kind === "exact_file" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ShipperError(`prepared edit target disappeared before file effect: ${path}`, 4);
    }
    throw error;
  }
  try {
    if (precondition.kind === "exact_file") {
      const observed = readFileSync(descriptor, "utf8");
      if (digest(observed) !== precondition.contentSha256) {
        throw new ShipperError(`prepared edit target changed before file effect: ${path}`, 4);
      }
      ftruncateSync(descriptor, 0);
    }
    writeSync(descriptor, content, 0, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const observedDigest = digest(readFileSync(target, "utf8"));
  if (observedDigest !== desiredDigest) throw new ShipperError(`file effect postcondition failed: ${path}`, 3);
  if (crashAfterEffect === "file_write") throw new InjectedCrash("file_write");
  completeEffect(store, effectId, { path, contentDigest: observedDigest });
}

function changedFiles(workspace: OwnedWorkspace, baseSha: string): string[] {
  return ownedWorkspaceGitRaw(workspace, ["diff", "--name-only", "-z", `${baseSha}..HEAD`, "--"]).split("\0").filter(Boolean);
}

function modelContextPathAllowed(contract: ProjectContract, path: string): boolean {
  const policy = contract.models.repositoryContext;
  return policy.includeGlobs.some((glob) => globMatches(glob, path))
    && !policy.excludeGlobs.some((glob) => globMatches(glob, path));
}

function sensitiveModelContextPath(path: string): boolean {
  const normalized = path.toLowerCase().replaceAll("\\", "/");
  const name = basename(normalized);
  return name === ".env"
    || name.startsWith(".env.")
    || [".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "secrets.json"].includes(name)
    || /(?:^|\/)(?:secrets?|credentials?)(?:\/|\.|$)/.test(normalized)
    || /\.(?:pem|key|p12|pfx)$/.test(name);
}

function credentialSignature(content: string): string | null {
  const signatures: Array<[string, RegExp]> = [
    ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
    ["Anthropic token", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
    ["OpenAI token", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
    ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
    ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
    ["bearer credential", /\b(?:authorization\s*[:=]\s*["']?)?bearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ];
  return signatures.find(([, pattern]) => pattern.test(content))?.[0] ?? null;
}

function assertModelSafeContent(label: string, content: string): void {
  const signature = credentialSignature(content);
  if (signature) throw new ShipperError("model context contains credential-like material", 4, [`${label}: ${signature}`]);
}

function collectRepositoryEvidence(
  contract: ProjectContract,
  workspace: OwnedWorkspace,
  manifest?: RunRequest["workItem"]["repositoryContextManifest"],
): {
  entries: Array<{ path: string; content: string; contentSha256: string }>;
  truncated: boolean;
  byteLimit: number;
  omittedPaths: number;
} {
  const trackedPaths = ownedWorkspaceGitRaw(workspace, ["ls-files", "-z", "--"]).split("\0").filter(Boolean);
  const tracked = new Set(trackedPaths);
  const paths = manifest?.paths ?? trackedPaths;
  const evidence: Array<{ path: string; content: string; contentSha256: string }> = [];
  let totalBytes = 0;
  let truncated = false;
  let omittedPaths = 0;
  for (const path of paths) {
    if (path === ".graph-shipper/project.yaml") continue;
    if (!modelContextPathAllowed(contract, path)) {
      if (manifest) throw new ShipperError(`repository context path exceeds the activated Project Contract: ${path}`, 4);
      omittedPaths += 1;
      continue;
    }
    if (manifest && !tracked.has(path)) throw new ShipperError(`repository context manifest path is not tracked: ${path}`, 4);
    if (sensitiveModelContextPath(path)) {
      throw new ShipperError("model context contains credential-like material", 4, [`${path}: sensitive path`]);
    }
    const absolute = join(workspace.path, path);
    let stat;
    try {
      let cursor = realpathSync(workspace.path);
      for (const segment of path.split("/")) {
        cursor = join(cursor, segment);
        const current = lstatSync(cursor);
        if (current.isSymbolicLink()) throw new ShipperError(`repository context manifest path traverses a symlink: ${path}`, 4);
      }
      stat = lstatSync(absolute);
    } catch (error) {
      if (error instanceof ShipperError) throw error;
      if (manifest) throw new ShipperError(`repository context manifest path is missing: ${path}`, 4);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      if (manifest) throw new ShipperError(`repository context manifest path is not a regular file: ${path}`, 4);
      continue;
    }
    if (stat.size > 128 * 1024) {
      if (manifest) throw new ShipperError(`repository context manifest file exceeds 128 KiB: ${path}`, 4);
      continue;
    }
    const bytes = readFileSync(absolute);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      if (manifest) throw new ShipperError(`repository context manifest path is not UTF-8 text: ${path}`, 4);
      continue;
    }
    if (content.includes("\0")) {
      if (manifest) throw new ShipperError(`repository context manifest path contains binary content: ${path}`, 4);
      continue;
    }
    assertModelSafeContent(path, content);
    totalBytes += bytes.byteLength;
    if (totalBytes > 1024 * 1024) {
      if (manifest) throw new ShipperError("repository context manifest exceeds the 1 MiB limit", 4, [path]);
      truncated = true;
      break;
    }
    evidence.push({ path, content, contentSha256: digest(content) });
  }
  return {
    entries: evidence,
    truncated: manifest ? false : truncated,
    byteLimit: 1024 * 1024,
    omittedPaths: manifest ? 0 : omittedPaths,
  };
}

async function documentationGate(
  contract: ProjectContract,
  contractDigest: string,
  workItemRevision: string,
  documentationAuthority: RunRequest["workItem"]["documentationAuthority"],
  plan: Plan,
  workspace: OwnedWorkspace,
  baseSha: string,
  headSha: string,
  files: string[],
  commands: ActivatedCommandRegistry,
  roots: CommandRoots,
  verificationEvidence: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workspacePath = workspace.path;
  const errors: string[] = [];
  const markdown = ownedWorkspaceGit(workspace, ["ls-files", "--", "*.md"]).split("\n").filter(Boolean);
  const baseMarkdown = ownedWorkspaceGit(workspace, ["ls-tree", "-r", "--name-only", baseSha, "--", "*.md"]).split("\n").filter(Boolean);
  for (const removed of baseMarkdown.filter((path) => !markdown.includes(path))) {
    if (!documentationAuthority.renameFromPaths.includes(removed)) errors.push(`${removed}: tracked documentation rename/deletion lacks Work Item authority`);
  }
  for (const path of markdown) {
    const rules = contract.documentation.rules.filter((rule) => globMatches(rule.glob, path));
    if (rules.length !== 1) errors.push(`${path}: expected exactly one Documentation Catalog classification`);
    if (rules[0]?.class === "ignored_transient") errors.push(`${path}: tracked Markdown cannot be ignored_transient`);
  }
  for (const path of files.filter((file) => file.endsWith(".md"))) {
    const rule = contract.documentation.rules.find((candidate) => globMatches(candidate.glob, path));
    if (rule?.protected && !documentationAuthority.protectedPaths.includes(path)) errors.push(`${path}: protected documentation changed without Work Item authority`);
  }
  if (contract.documentation.blockBroadRewriteWithoutWorkItemAuthority) {
    const numstat = ownedWorkspaceGit(workspace, ["diff", "--numstat", `${baseSha}..${headSha}`, "--", "*.md"]);
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [addedText = "0", deletedText = "0", path = ""] = line.split("\t");
      const churn = Number(addedText) + Number(deletedText);
      if (Number.isFinite(churn) && churn > 200 && !documentationAuthority.broadRewritePaths.includes(path)) {
        errors.push(`${path}: broad documentation rewrite lacks Work Item authority`);
      }
    }
  }
  const triggered = contract.documentation.triggerMatrix
    .filter((entry) => files.some((file) => entry.pathGlobs.some((glob) => globMatches(glob, file))))
    .flatMap((entry) => entry.impacts.flatMap((impact) => entry.topics.map((topic) => ({ impact, topic }))));
  const minimum = triggered.filter(({ impact }) => !(impact === "release_record" && contract.documentation.releaseRecord.kind === "none"));
  if (plan.documentation.kind === "no_change_attestation") {
    if (files.some((file) => file.endsWith(".md"))) errors.push("No-Change Attestation is invalid when Markdown changed");
    if (minimum.length > 0) errors.push("No-Change Attestation cannot remove deterministic documentation impacts");
  } else {
    for (const requirement of minimum) {
      const entry = plan.documentation.entries.find((candidate) => candidate.impact === requirement.impact && candidate.topic === requirement.topic);
      if (!entry) {
        errors.push(`missing documentation coverage for ${requirement.impact}:${requirement.topic}`);
        continue;
      }
      if (!files.includes(entry.path)) errors.push(`${entry.path}: coverage document did not change on the exact head`);
      const rule = contract.documentation.rules.find((candidate) => globMatches(candidate.glob, entry.path));
      if (rule?.class !== "living" || !rule.topics.includes(entry.topic)) errors.push(`${entry.path}: coverage does not map to a living canonical topic`);
    }
  }
  const links = new Map<string, string[]>();
  const anchors = new Map<string, Set<string>>();
  const declaredFacts = new Map<string, { value: string; path: string }>();
  const markdownSources = new Map<string, { source: string; enforceLivingChecks: boolean }>();
  for (const path of markdown) {
    const absolute = join(workspacePath, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      errors.push(`${path}: tracked Markdown path is unreadable`);
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isFile()) {
      errors.push(`${path}: tracked Markdown path is not a regular file`);
      continue;
    }
    const source = readFileSync(absolute, "utf8");
    const documentClass = contract.documentation.rules.find((rule) => globMatches(rule.glob, path))?.class;
    const enforceLivingChecks = documentClass === "living" || documentClass === "generated";
    markdownSources.set(path, { source, enforceLivingChecks });
    const headingAnchors = [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => (match[1] ?? "")
      .trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-"));
    if (enforceLivingChecks && new Set(headingAnchors).size !== headingAnchors.length) errors.push(`${path}: duplicate Markdown heading anchors`);
    anchors.set(path, new Set(headingAnchors));
    if (enforceLivingChecks) {
      if ((source.match(/^```/gm)?.length ?? 0) % 2 !== 0) errors.push(`${path}: unclosed fenced code block`);
      for (const match of source.matchAll(/<!--\s*graph-shipper-fact:([a-z0-9._-]+)=([^>]+?)\s*-->/g)) {
        const key = match[1] ?? "";
        const value = (match[2] ?? "").trim();
        const previous = declaredFacts.get(key);
        if (previous && previous.value !== value) errors.push(`${path}: deterministic contradiction for ${key} with ${previous.path}`);
        else declaredFacts.set(key, { value, path });
      }
    }
  }
  for (const [path, document] of markdownSources) {
    if (!document.enforceLivingChecks) continue;
    const { source } = document;
    const localLinks: string[] = [];
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1] ?? "";
      if (!rawTarget || /^(?:https?:|mailto:)/.test(rawTarget)) continue;
      const [targetPart = "", fragment = ""] = rawTarget.split("#", 2);
      let decodedTarget: string;
      try {
        decodedTarget = decodeURIComponent(targetPart);
      } catch {
        errors.push(`${path}: malformed percent-encoding in link ${rawTarget}`);
        continue;
      }
      const resolvedTarget = targetPart ? resolve(dirname(join(workspacePath, path)), decodedTarget) : join(workspacePath, path);
      const relativeResolvedTarget = relative(workspacePath, resolvedTarget);
      if (relativeResolvedTarget.startsWith("..") || isAbsolute(relativeResolvedTarget)) {
        errors.push(`${path}: relative link escapes the owned worktree: ${rawTarget}`);
        continue;
      }
      if (!existsSync(resolvedTarget)) {
        errors.push(`${path}: broken relative link ${rawTarget}`);
        continue;
      }
      const canonicalLinkedTarget = realpathSync(resolvedTarget);
      const canonicalLinkRelation = relative(realpathSync(workspacePath), canonicalLinkedTarget);
      if (canonicalLinkRelation.startsWith("..") || isAbsolute(canonicalLinkRelation)) {
        errors.push(`${path}: relative link resolves through a symlink outside the owned worktree: ${rawTarget}`);
        continue;
      }
      const relativeTarget = relativeResolvedTarget.replaceAll("\\", "/");
      if (relativeTarget.endsWith(".md")) localLinks.push(relativeTarget);
      if (fragment && relativeTarget.endsWith(".md") && !anchors.get(relativeTarget)?.has(fragment.toLowerCase())) {
        errors.push(`${path}: broken Markdown anchor ${rawTarget}`);
      }
    }
    links.set(path, localLinks);
  }
  const reachable = new Set<string>();
  const queue = [...contract.documentation.requiredLivingEntryPoints];
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path || reachable.has(path)) continue;
    reachable.add(path);
    for (const target of links.get(path) ?? []) queue.push(target);
  }
  for (const path of markdown) {
    const rule = contract.documentation.rules.find((candidate) => globMatches(candidate.glob, path));
    if (rule?.class === "living" && !reachable.has(path)) errors.push(`${path}: living documentation is not discoverable from a required entry point`);
  }
  for (const rule of contract.documentation.rules.filter((candidate) => candidate.class === "generated")) {
    if (!rule.driftCheckCommandRef) continue;
    const result = await executeGateCommand(commands, rule.driftCheckCommandRef, roots, workspace);
    if (result.exitCode !== 0) errors.push(`${rule.id}: generated documentation drift check failed`);
  }
  const checkResults: Array<Record<string, unknown>> = [];
  for (const commandRef of [...contract.documentation.formatCommandRefs, ...contract.documentation.inventoryCommandRefs]) {
    const result = await executeGateCommand(commands, commandRef, roots, workspace);
    checkResults.push({ commandId: result.commandId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    if (result.exitCode !== 0) errors.push(`${commandRef}: declared documentation check failed`);
  }
  for (const diagram of contract.documentation.diagramChecks) {
    if (!files.some((file) => diagram.sourceGlobs.some((glob) => globMatches(glob, file)))) continue;
    if (!files.some((file) => diagram.diagramGlobs.some((glob) => globMatches(glob, file)))) {
      errors.push(`${diagram.id}: diagram source changed without a corresponding diagram change`);
    }
    const result = await executeGateCommand(commands, diagram.commandRef, roots, workspace);
    checkResults.push({ commandId: result.commandId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
    if (result.exitCode !== 0) errors.push(`${diagram.id}: diagram drift check failed`);
  }
  if (errors.length > 0) throw new ShipperError("Documentation Freshness Gate failed", 3, errors);
  const evidence = {
    workItemRevision,
    contractDigest,
    baseSha,
    headSha,
    actualDiffDigest: digest(ownedWorkspaceGit(workspace, ["diff", "--no-ext-diff", `${baseSha}..${headSha}`, "--"])),
    behaviorEvidenceDigest: verificationEvidence.evidenceDigest,
    changedMarkdown: files.filter((file) => file.endsWith(".md")),
    deterministicMinimum: minimum,
    disposition: plan.documentation,
    catalogDigest: digest(contract.documentation),
    checkResults,
  };
  return { ...evidence, evidenceDigest: digest(evidence) };
}

async function executeGateCommand(
  commands: ActivatedCommandRegistry,
  commandId: string,
  roots: CommandRoots,
  workspace: OwnedWorkspace,
  values: Record<string, string> = {},
  diagnosticsRoot?: string,
): Promise<CommandResult> {
  const beforeConfig = repositoryLocalConfigDigest(workspace);
  const beforeExclude = sharedExcludeDigest(workspace);
  const beforeUntracked = unexcludedUntrackedSnapshot(workspace);
  const before = ownedWorkspaceGit(workspace, ["status", "--porcelain", "--untracked-files=all"]);
  const beforeHead = ownedWorkspaceGit(workspace, ["rev-parse", "HEAD"]);
  if (before) throw new ShipperError(`${commandId}: evidence workspace was dirty before a declared pure gate`, 4, [before]);
  // Gates no longer receive GIT_DIR/GIT_WORK_TREE pins (they leak into any Git the gate itself
  // runs), so a `.git` pointer that a preparation step swapped is put back to the captured
  // Git directory before the gate discovers it from cwd. The worktree is runtime-owned.
  const capturedGitDirectory = realpathSync(workspace.gitDirectory);
  const pointerPath = join(workspace.path, ".git");
  if (realpathSync(git(workspace.path, ["rev-parse", "--absolute-git-dir"])) !== capturedGitDirectory) {
    if (!lstatSync(pointerPath).isFile()) {
      throw new ShipperError(`${commandId}: owned worktree Git directory was replaced before a declared pure gate`, 4, [
        `retained worktree: ${workspace.path}`,
      ]);
    }
    writeFileSync(pointerPath, `gitdir: ${capturedGitDirectory}\n`);
    if (realpathSync(git(workspace.path, ["rev-parse", "--absolute-git-dir"])) !== capturedGitDirectory) {
      throw new ShipperError(`${commandId}: owned worktree Git directory could not be restored before a declared pure gate`, 4, [
        `retained worktree: ${workspace.path}`,
      ]);
    }
  }
  const result = await commands.execute(commandId, values, roots);
  try {
    assertModelSafeContent(`${commandId} stdout`, result.stdout);
    assertModelSafeContent(`${commandId} stderr`, result.stderr);
  } catch (error) {
    // Keep the offending output out of state and traces, but let the operator
    // read it from a private file so the failure is diagnosable.
    if (error instanceof ShipperError && diagnosticsRoot) {
      mkdirSync(diagnosticsRoot, { recursive: true, mode: 0o700 });
      const path = join(diagnosticsRoot, `${commandId}-${Date.now()}.log`);
      writeFileSync(
        path,
        `==== exit_code ====\n${result.exitCode}\n==== stdout ====\n${result.stdout}\n==== stderr ====\n${result.stderr}\n`,
        { mode: 0o600 },
      );
      throw new ShipperError(error.message, 4, [...error.details, `command_diagnostic_path:${path}`]);
    }
    throw error;
  }
  if (repositoryLocalConfigDigest(workspace) !== beforeConfig) {
    throw new ShipperError(`${commandId}: declared pure command changed the repository-local Git configuration`, 4, [
      `retained worktree: ${workspace.path}`,
    ]);
  }
  if (sharedExcludeDigest(workspace) !== beforeExclude) {
    throw new ShipperError(`${commandId}: declared pure command mutated the evidence repository`, 4, [
      "shared info/exclude changed by declared pure command",
      `retained worktree: ${workspace.path}`,
    ]);
  }
  const untrackedDelta = untrackedSnapshotDelta(beforeUntracked, unexcludedUntrackedSnapshot(workspace));
  const after = ownedWorkspaceGit(workspace, ["status", "--porcelain", "--untracked-files=all"]);
  const afterHead = ownedWorkspaceGit(workspace, ["rev-parse", "HEAD"]);
  if (after || afterHead !== beforeHead || untrackedDelta.length > 0) {
    throw new ShipperError(`${commandId}: declared pure command mutated the evidence repository`, 4, [
      ...untrackedDelta,
      ...(after ? [after] : []),
      ...(afterHead !== beforeHead ? [`${beforeHead} -> ${afterHead}`] : []),
    ]);
  }
  return result;
}

function writeEvidence(dataRoot: string, runId: string, evidence: Record<string, unknown>, redactor: PersistenceRedactor): string {
  const root = join(dataRoot, "runs", runId);
  assertNoSymlinkAncestors(root, [dataRoot]);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const path = join(root, "evidence.json");
  const source = `${redactor.serialize(evidence, 2)}\n`;
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ShipperError("evidence artifact must be a regular non-symlink file", 3);
    if (readFileSync(path, "utf8") !== source) throw new ShipperError("existing evidence artifact does not match the durable finalization state", 4);
    return path;
  }
  const temporaryPath = join(root, `.evidence.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(descriptor, source, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, path);
    const directory = openSync(root, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
  return path;
}

export async function executeLocalWorkRun(input: {
  projectRoot: string;
  dataRoot: string;
  contract: ProjectContract;
  contractDigest: string;
  request: RunRequest;
  adapterFixturePath?: string;
  githubFixturePath?: string;
  allowDisposableFixtureReconciliation?: boolean;
  allowDisposableFixtureOperations?: boolean;
  allowCredentialedModelCalls?: boolean;
  allowLiveGitHubMutations?: boolean;
  allowLiveMerge?: boolean;
  allowLiveOperationalHooks?: boolean;
  runtimeRoot: string;
  runId?: string;
  resume?: boolean;
  crashAfterIntent?: string;
  crashAfterEffect?: string;
  crashAfterReceipt?: string;
  crashAtNode?: string;
}): Promise<WorkRunOutput | PausedWorkRunOutput> {
  const runId = input.runId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new ShipperError("run ID contains unsafe characters", 3);
  const refusedEnvironment = input.contract.commands.flatMap(environmentValueErrors);
  if (refusedEnvironment.length > 0) {
    throw new ShipperError("operator environment carries credential material a declared command would receive", 3, refusedEnvironment);
  }
  const { build, review } = validateRequestAgainstContract(input.request, input.contract);
  const autonomy = input.request.autonomy;
  const registry = new ActivatedCommandRegistry(input.contract, input.projectRoot, {
    dataRoot: input.dataRoot, projectId: input.contract.metadata.projectId, runId,
  });
  assertNoExternalGitFilters(input.projectRoot);
  const redactor = new PersistenceRedactor();
  const operationalBroker = new EnvironmentCredentialBroker(redactor);
  const postMergeAdapter = new PostMergeAdapter(registry, operationalBroker);
  let activeDeadlineAt = new Date(Date.now() + input.contract.budgets.wallClockMinutes * 60_000).toISOString();
  const recordedAdapters = input.adapterFixturePath ? new RecordedModelPair(input.adapterFixturePath) : null;
  const recordedGitHub = input.githubFixturePath
    ? new RecordedGitHubTransport(input.githubFixturePath, join(input.dataRoot, "github-fixtures", `${runId}.json`))
    : null;
  if (recordedGitHub && input.allowLiveGitHubMutations) {
    throw new ShipperError("choose exactly one of --github-fixture or --allow-live-github-mutations", 3);
  }
  if (input.request.autonomy !== "local_only" && !recordedGitHub && !input.allowLiveGitHubMutations) {
    throw new ShipperError(`${input.request.autonomy} requires an offline --github-fixture or explicit live GitHub authorization`, 3);
  }
  if (input.request.autonomy === "local_only" && (recordedGitHub || input.allowLiveGitHubMutations)) {
    throw new ShipperError("local_only does not accept a GitHub fixture or live GitHub authorization", 3);
  }
  if (input.request.autonomy === "merge_when_green" && recordedGitHub && !input.allowDisposableFixtureReconciliation) {
    throw new ShipperError("merge_when_green fixture execution requires explicit disposable target-reconciliation authorization", 3);
  }
  if (input.request.autonomy === "merge_when_green" && input.allowLiveGitHubMutations && !input.allowLiveMerge) {
    throw new ShipperError("merge_when_green live execution requires explicit live merge authorization", 3);
  }
  if ((input.allowLiveMerge || input.allowLiveOperationalHooks) && !input.allowLiveGitHubMutations) {
    throw new ShipperError("live merge and live operational-hook authorization require --allow-live-github-mutations", 3);
  }
  if (input.contract.postMergeHooks.length > 0) {
    if (input.allowLiveGitHubMutations && !input.allowLiveOperationalHooks) {
      throw new ShipperError("operational hooks against a live target require explicit live operational-hook authorization", 3);
    }
    if (!input.allowLiveGitHubMutations && !input.allowDisposableFixtureOperations) {
      throw new ShipperError("operational hooks require explicit disposable-fixture authorization until a live canary is separately authorized", 3);
    }
  }
  let liveGitHub: LiveGitHubTransport | null = null;
  let liveGitHubCredentialRef: string | null = null;
  if (input.allowLiveGitHubMutations) {
    const operator = input.contract.credentials.references.find((reference) => reference.purpose === "github_operator");
    if (!operator) throw new ShipperError("live GitHub authorization requires a github_operator credential reference", 3);
    const githubBroker = new EnvironmentCredentialBroker(redactor);
    await githubBroker.probe({
      referenceId: operator.id, purpose: "github_operator",
      projectId: input.contract.metadata.projectId, workRunId: runId,
    });
    liveGitHubCredentialRef = operator.id;
    liveGitHub = new LiveGitHubTransport({
      repository: input.contract.repository.github,
      credentialRef: operator.id,
      projectId: input.contract.metadata.projectId,
      workRunId: runId,
      broker: githubBroker,
      deadlineAt: () => activeDeadlineAt,
    });
  }
  const githubTransport = recordedGitHub ?? liveGitHub;
  const githubAdapter = githubTransport
    ? new GitHubAdapter({ repository: input.contract.repository.github, transport: githubTransport })
    : null;
  let liveBroker: EnvironmentCredentialBroker | null = null;
  if (recordedAdapters) {
    if (build.provider !== recordedAdapters.buildProvider || review.provider !== recordedAdapters.reviewProvider) {
      throw new ShipperError("adapter providers do not match the activated role assignments", 3);
    }
  } else if (input.allowCredentialedModelCalls) {
    const selectedAssignments = [build, review];
    if (selectedAssignments.some((assignment) => assignment.transport === "api")) {
      liveBroker = new EnvironmentCredentialBroker(redactor);
      for (const assignment of selectedAssignments.filter((candidate) => candidate.transport === "api")) {
        await liveBroker.probe({
          referenceId: assignment.credentialRef, purpose: `${assignment.provider}_model`,
          projectId: input.contract.metadata.projectId, workRunId: runId,
        });
      }
    }
    for (const provider of new Set(selectedAssignments
      .filter((assignment) => assignment.transport === "subscription_cli")
      .map((assignment) => assignment.provider))) {
      await probeSubscriptionProvider(provider);
    }
  } else {
    throw new ShipperError("choose an offline --adapter-fixture or explicitly allow credentialed model calls", 3);
  }
  const adapterBinding: Record<string, unknown> = recordedAdapters
    ? {
        mode: "recorded", fixtureDigest: recordedAdapters.fixtureDigest,
        buildProvider: build.provider, buildModelRef: recordedAdapters.buildModelRef,
        reviewProvider: review.provider, reviewModelRef: recordedAdapters.reviewModelRef,
      }
    : {
        mode: build.transport === review.transport
          ? build.transport === "subscription_cli" ? "subscription" : "api"
          : "mixed",
        buildAssignmentId: build.id, buildProvider: build.provider, buildModelRef: build.modelRef, buildTransport: build.transport,
        reviewAssignmentId: review.id, reviewProvider: review.provider, reviewModelRef: review.modelRef, reviewTransport: review.transport,
      };
  if (recordedGitHub) {
    adapterBinding.github = { mode: "recorded", fixtureDigest: recordedGitHub.fixtureDigest };
  } else if (liveGitHub) {
    adapterBinding.github = { mode: "live", repository: input.contract.repository.github, credentialRef: liveGitHubCredentialRef };
  }
  const now = new Date();
  let baseSha = git(input.projectRoot, ["rev-parse", input.request.workItem.baseBranch]);
  const branch = `graph-shipper/${runId}`;
  const workspacePath = resolveWorkspacePath(input.projectRoot, input.contract.workspace.rootTemplate, runId);
  const state: RunState = {
    runId,
    projectId: input.contract.metadata.projectId,
    repository: input.contract.repository.github,
    contractDigest: input.contractDigest,
    request: input.request,
    baseSha,
    headSha: null,
    branch,
    workspacePath: null,
    workspaceGitDirectory: null,
    phase: "intake_complete",
    status: "running",
    iteration: 0,
    reviewAttempt: 0,
    refreshAttempt: 0,
    startedAt: now.toISOString(),
    deadlineAt: activeDeadlineAt,
    runtimeVersion: VERSION,
    runtimeRevision: RUNTIME_REVISION,
    plan: null,
    preparedFileActions: null,
    gatedPlan: null,
    repairFeedbackDigest: null,
    localConfigDigest: null,
    sharedAttributesDigest: null,
    changedFiles: [],
    verification: null,
    documentation: null,
    reviewVerdict: null,
    priorFindings: [],
    findingDispositions: [],
    commandResults: [],
    reviewBundle: null,
    errors: [],
    adapterBinding,
    activeBuildAssignmentId: build.id,
    activeReviewAssignmentId: review.id,
    modelInvocations: [],
    maximumIterations: input.contract.budgets.maximumIterations,
    pullRequest: null,
    hosted: null,
    sourceRevision: null,
    reviewPublication: null,
    mergeGuard: null,
    merge: null,
    sourceClosure: null,
    postMerge: null,
    terminal: null,
    cleanup: null,
  };
  const store = new StateStore(input.dataRoot, redactor);
  const claimToken = randomUUID();
  try {
    store.claimWorkRun(runId, input.contract.metadata.projectId, claimToken, input.contract.concurrency.maximumWorkRuns);
  } catch (error) {
    store.close();
    throw error;
  }
  const trace = new JsonlTraceWriter(join(input.dataRoot, "traces"), redactor);
  let authority: LocalAuthorityBroker;
  let drainRequested = false;
  let resumedPhase: string | null = null;
  let reconcilePreparedMerge = false;
  let resumeAccepted = !input.resume;
  const requestDrain = (): void => { drainRequested = true; };
  const drainAtBoundary = (): void => { if (drainRequested) throw new DrainAtBoundary(); };
  process.on("SIGINT", requestDrain);
  process.on("SIGTERM", requestDrain);
  try {
    let createWorkspace = !input.resume;
    let ownedWorkspace: OwnedWorkspace | null = null;
    const boundWorkspace = (): OwnedWorkspace => {
      if (!ownedWorkspace) throw new ShipperError("durable workspace Git directory binding is unavailable", 4);
      return ownedWorkspace;
    };
    const preparationCommandRefs = input.contract.workspace.strategy === "managed_git_worktree"
      ? input.contract.workspace.preparationCommandRefs
      : [];
    const workspaceCreationCheckpointPhase = preparationCommandRefs.length > 0 ? "workspace_prepare" : "plan";
    let prepareWorkspace = false;
    if (input.resume) {
      const saved = store.workRun(runId);
      if (!saved) throw new ShipperError(`unknown Work Run: ${runId}`, 3);
      if (saved.status === "completed") throw new ShipperError(`Work Run ${runId} is already completed`, 3);
      if (saved.status === "escalated") throw new ShipperError(`Work Run ${runId} is escalated and cannot resume automatically`, 3);
      if (digest(saved.state.adapterBinding) !== digest(adapterBinding)) {
        throw new ShipperError("model adapter binding changed since the durable Work Run checkpoint", 4);
      }
      if (saved.state.runtimeRevision !== RUNTIME_REVISION) {
        throw new ShipperError("Graph Shipper runtime revision changed since the durable Work Run checkpoint", 4);
      }
      resumeAccepted = true;
      Object.assign(state, saved.state);
      state.activeBuildAssignmentId ??= build.id;
      state.activeReviewAssignmentId ??= review.id;
      state.modelInvocations ??= [];
      state.runtimeVersion ??= VERSION;
      state.pullRequest ??= null;
      state.hosted ??= null;
      state.sourceRevision ??= null;
      state.reviewPublication ??= null;
      state.mergeGuard ??= null;
      state.merge ??= null;
      state.sourceClosure ??= null;
      state.postMerge ??= null;
      state.terminal ??= null;
      state.cleanup ??= null;
      state.refreshAttempt ??= 0;
      state.gatedPlan ??= null;
      state.preparedFileActions ??= null;
      state.repairFeedbackDigest ??= null;
      state.localConfigDigest ??= null;
      state.sharedAttributesDigest ??= null;
      state.workspaceGitDirectory ??= null;
      delete (state as Record<string, unknown>).modelFailures;
      baseSha = state.baseSha;
      activeDeadlineAt = state.deadlineAt;
      ownedWorkspace = persistedOwnedWorkspace(state, workspacePath);
      const pending = store.preparedEffect(runId);
      if (pending) {
        if (pending.kind === "workspace_create" && pending.target === workspacePath) {
          if (!existsSync(workspacePath)) {
            createWorkspace = true;
          } else {
            let observedBase: string | null = null;
            let observedBranch: string | null = null;
            let undeclaredOutput: WorktreeOutputFinding[] = [];
            let probeError: string | null = ownedWorkspace ? null : "durable workspace Git directory binding is unavailable";
            try {
              if (ownedWorkspace) {
                observedBase = ownedWorkspaceGit(ownedWorkspace, ["rev-parse", "HEAD"]);
                observedBranch = ownedWorkspaceGit(ownedWorkspace, ["branch", "--show-current"]);
                undeclaredOutput = undeclaredWorktreeOutput(ownedWorkspace);
              }
            } catch (error) {
              probeError = error instanceof Error ? error.message : String(error);
            }
            const registered = ownedWorkspace ? isRegisteredOwnedWorktree(input.projectRoot, ownedWorkspace) : false;
            if (observedBase !== baseSha || observedBranch !== branch || undeclaredOutput.length > 0 || !registered || probeError) {
              store.completeEffect(pending.effectId, "indeterminate", {
                workspacePath, observedBase, observedBranch,
                undeclaredOutput: undeclaredOutput.map((finding) => finding.detail), registered, probeError,
              }, new Date().toISOString());
              state.status = "escalated";
              state.workspacePath = workspacePath;
              checkpoint(store, trace, state, "escalated", { reason: "indeterminate_side_effect" });
              throw new ShipperError("workspace effect is indeterminate; preserved for human inspection", 4);
            }
            store.completeEffect(pending.effectId, "adopted", { workspacePath, branch, baseSha }, new Date().toISOString());
            state.workspacePath = workspacePath;
            if (preparationCommandRefs.length > 0) captureWorkspacePreparationBaseline(state, boundWorkspace());
            prepareWorkspace = true;
            checkpoint(store, trace, state, workspaceCreationCheckpointPhase, { reconciliation: "adopted_after_crash" });
          }
        } else if (pending.kind === "workspace_prepare" && state.workspacePath === workspacePath
          && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
          const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          const observedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
          if (observedHead !== baseSha || observedBranch !== branch) {
            store.completeEffect(pending.effectId, "indeterminate", { observedHead, observedBranch }, new Date().toISOString());
            throw new ShipperError("prepared workspace preparation drifted; preserved for human inspection", 4);
          }
          try {
            assertWorkspacePreparationPostcondition(boundWorkspace(), baseSha);
          } catch (error) {
            store.completeEffect(pending.effectId, "indeterminate", {
              observedHead, observedBranch, reason: "workspace preparation postcondition failed during reconciliation",
            }, new Date().toISOString());
            throw error;
          }
          resumedPhase = "workspace_prepare";
          state.status = "running";
          checkpoint(store, trace, state, "workspace_prepare", { reconciliation: "idempotent_preparation_replay", commandRef: pending.target });
        } else if (pending.kind === "file_write" && state.workspacePath === workspacePath && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
          const target = safeWorkspaceFile(workspacePath, pending.target);
          const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          const observedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
          const worktreeOutput = undeclaredWorktreeOutput(boundWorkspace());
          const outputIsAttributable = worktreeOutputIsAttributable(state.preparedFileActions, worktreeOutput);
          const unattributableOutput = outputIsAttributable ? [] : worktreeOutput;
          if (observedHead !== (state.headSha ?? baseSha) || observedBranch !== branch
            || !outputIsAttributable) {
            store.completeEffect(pending.effectId, "indeterminate", {
              observedHead, observedBranch,
              undeclaredOutput: unattributableOutput.map((finding) => finding.detail),
            }, new Date().toISOString());
            throw new ShipperError("prepared file-write workspace drifted; preserved for human inspection", 4, [
              ...unattributableOutput.map((finding) => finding.detail),
            ]);
          }
          const prepared = state.preparedFileActions?.find((action) => (
            action.path === pending.target && action.desiredDigest === pending.desiredDigest
          ));
          const intentPrecondition = pending.intent.precondition;
          if (!prepared || typeof intentPrecondition !== "object" || intentPrecondition === null
            || digest(intentPrecondition) !== digest(prepared.precondition)) {
            throw new ShipperError("prepared file-write intent does not match its durable action", 4);
          }
          const targetExists = existsSync(target);
          const observedDigest = targetExists ? digest(readFileSync(target, "utf8")) : null;
          if (observedDigest === pending.desiredDigest) {
            store.completeEffect(pending.effectId, "adopted", { path: pending.target, contentDigest: pending.desiredDigest }, new Date().toISOString());
            resumedPhase = "act";
            state.status = "running";
            checkpoint(store, trace, state, "act", { reconciliation: "adopted_file_after_crash" });
          } else if (prepared.precondition.kind === "absent" && !targetExists) {
            resumedPhase = "act";
            state.status = "running";
          } else if (prepared.precondition.kind === "exact_file"
            && observedDigest === prepared.precondition.contentSha256) {
            resumedPhase = "act";
            state.status = "running";
          } else {
            store.completeEffect(pending.effectId, "indeterminate", { path: pending.target, observedDigest }, new Date().toISOString());
            throw new ShipperError("file-write effect is indeterminate; workspace preserved for human inspection", 4);
          }
        } else if (pending.kind === "commit_create" && state.workspacePath === workspacePath && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
          const parentSha = String(pending.intent.parentSha ?? "");
          const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          const observedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
          const undeclaredOutput = undeclaredWorktreeOutput(boundWorkspace());
          const observedParent = ownedWorkspaceGit(boundWorkspace(), ["log", "-1", "--format=%P"]);
          const trailer = ownedWorkspaceGit(boundWorkspace(), ["log", "-1", "--format=%B"]);
          if (observedBranch !== branch || undeclaredOutput.length > 0) {
            store.completeEffect(pending.effectId, "indeterminate", {
              observedHead, observedBranch,
              undeclaredOutput: undeclaredOutput.map((finding) => finding.detail),
            }, new Date().toISOString());
            throw new ShipperError("prepared commit workspace drifted; preserved for human inspection", 4, [
              ...undeclaredOutput.map((finding) => finding.detail),
            ]);
          } else if (observedParent === parentSha && trailer.includes(`Graph-Shipper-Run: ${runId}`)) {
            store.completeEffect(pending.effectId, "adopted", { headSha: observedHead, parentSha, branch }, new Date().toISOString());
            state.headSha = observedHead;
            state.changedFiles = changedFiles(boundWorkspace(), baseSha);
            resumedPhase = "verify";
            state.status = "running";
            checkpoint(store, trace, state, "verify", { reconciliation: "adopted_commit_after_crash", headSha: observedHead });
          } else if (observedHead === parentSha) {
            resumedPhase = "act";
            state.status = "running";
          } else {
            store.completeEffect(pending.effectId, "indeterminate", { observedHead, observedParent, parentSha, trailer }, new Date().toISOString());
            throw new ShipperError("commit effect is indeterminate; workspace preserved for human inspection", 4);
          }
        } else if (pending.kind === "enqueue_delivery"
          && state.request.autonomy === "merge_when_green"
          && input.contract.delivery.strategy === "project_coordinator"
          && state.workspacePath === workspacePath
          && state.pullRequest
          && state.headSha
          && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
          const terminalCommand = registry.get(input.contract.delivery.terminalPredicateCommandRef);
          const values = deliveryCommandValues(terminalCommand, {
            pullRequestNumber: state.pullRequest.number, expectedHeadSha: state.headSha, runId,
          });
          const probe = await registry.execute(terminalCommand.id, values, {
            runtime: input.runtimeRoot, project_root: input.projectRoot, worktree: workspacePath,
            worktreeGitDirectory: boundWorkspace().gitDirectory,
            synced_main: input.projectRoot, deadlineAt: state.deadlineAt,
          });
          state.commandResults.push(probe);
          let body: Record<string, unknown>;
          try { body = JSON.parse(probe.stdout) as Record<string, unknown>; } catch { body = {}; }
          if (probe.exitCode === 0 && body.terminal === true && /^[0-9a-f]{40,64}$/.test(String(body.mergedSha ?? ""))) {
            store.completeEffect(pending.effectId, "adopted", {
              reconciliation: "terminal_predicate_observed", mergedSha: body.mergedSha,
            }, new Date().toISOString());
            state.merge = {
              disposition: "adopted", headSha: state.headSha, baseSha: state.baseSha,
              mergedSha: String(body.mergedSha), method: input.contract.github.mergeMethod,
            };
            resumedPhase = "finalize";
            state.status = "running";
            checkpoint(store, trace, state, "sync_local_main", { reconciliation: "adopted_enqueue_after_crash" });
          } else {
            resumedPhase = "enqueue_delivery";
            state.status = "running";
            checkpoint(store, trace, state, "enqueue_delivery", { reconciliation: "idempotent_enqueue_retry_required" });
          }
        } else if (["post_merge_hook", "compensating_hook"].includes(pending.kind)
          && state.request.autonomy === "merge_when_green"
          && state.workspacePath === workspacePath
          && state.merge?.mergedSha
          && git(input.projectRoot, ["rev-parse", input.contract.repository.defaultBranch]) === state.merge.mergedSha) {
          const successCheckCommandRef = String(pending.intent.successCheckCommandRef ?? "");
          const successCheckValues = typeof pending.intent.successCheckValues === "object" && pending.intent.successCheckValues !== null
            ? pending.intent.successCheckValues as Record<string, string>
            : {};
          const probe = await postMergeAdapter.execute(successCheckCommandRef, successCheckValues, {
            runtime: input.runtimeRoot, project_root: input.projectRoot, worktree: workspacePath,
            worktreeGitDirectory: boundWorkspace().gitDirectory,
            synced_main: input.projectRoot, deadlineAt: state.deadlineAt,
          }, { projectId: state.projectId, workRunId: runId, dataRoot: input.dataRoot });
          const { stdoutBytes: _privateProbeBytes, ...probeEvidence } = probe;
          state.commandResults.push(probeEvidence);
          if (probe.exitCode === 0) {
            store.completeEffect(pending.effectId, "adopted", {
              reconciliation: "success_probe_observed", commandId: pending.intent.commandId,
              successCheckCommandRef, mergedSha: state.merge.mergedSha,
            }, new Date().toISOString());
            resumedPhase = pending.kind;
            state.status = "running";
            checkpoint(store, trace, state, pending.kind, { reconciliation: "adopted_after_crash" });
            if (pending.kind === "compensating_hook" && state.postMerge) {
              state.postMerge.status = "compensated";
              state.postMerge.compensation = {
                id: pending.intent.compensationId, status: "succeeded", reconciliation: "success_probe_observed",
                mergedSha: state.merge.mergedSha,
              };
              checkpoint(store, trace, state, "post_merge_escalation", {
                mergedSha: state.merge.mergedSha, status: "compensated", reconciliation: "adopted_after_crash",
              });
              throw new ShipperError("post-merge retries exhausted; compensation succeeded after crash reconciliation", 4);
            }
          } else if (pending.intent.idempotence === "idempotent") {
            store.completeEffect(pending.effectId, "failed", {
              reconciliation: "idempotent_retry_required", successCheckCommandRef, probeExitCode: probe.exitCode,
            }, new Date().toISOString());
            resumedPhase = pending.kind;
            state.status = "running";
            checkpoint(store, trace, state, pending.kind, { reconciliation: "idempotent_retry_required" });
          } else {
            store.completeEffect(pending.effectId, "indeterminate", {
              reconciliation: "success_probe_not_satisfied", successCheckCommandRef, probeExitCode: probe.exitCode,
            }, new Date().toISOString());
            if (state.postMerge && pending.kind === "compensating_hook") {
              state.postMerge.status = "compensation_ambiguous";
              state.postMerge.compensation = {
                id: pending.intent.compensationId, status: "ambiguous", mergedSha: state.merge.mergedSha,
              };
            }
            state.status = "escalated";
            state.errors.push(`${pending.kind}: effect is ambiguous after process death`);
            checkpoint(store, trace, state, "escalated", { reason: "indeterminate_post_merge_effect", effectId: pending.effectId });
            throw new ShipperError(`${pending.kind}: effect is ambiguous after process death`, 4);
          }
        } else if (pending.kind === "cleanup_owned_resources" && state.request.autonomy === "merge_when_green" && state.terminal?.satisfied === true) {
          const recordedOutput = cleanupOutputFindingsFromIntent(pending.intent);
          const worktreeRemoved = !existsSync(workspacePath);
          const branchRemoved = !git(input.projectRoot, ["branch", "--list", branch]);
          const ownedTempPath = join(input.dataRoot, "tmp", runId);
          const temporaryArtifactsRemoved = !existsSync(ownedTempPath);
          const expectedWorktreeRemoved = input.contract.cleanup.removeOwnedWorktreeAfterDeliveryTerminalSuccess;
          const expectedBranchRemoved = input.contract.cleanup.removeOwnedBranchAfterDeliveryTerminalSuccess;
          if (worktreeRemoved !== expectedWorktreeRemoved || branchRemoved !== expectedBranchRemoved || !temporaryArtifactsRemoved) {
            store.completeEffect(pending.effectId, "indeterminate", { worktreeRemoved, branchRemoved, temporaryArtifactsRemoved }, new Date().toISOString());
            throw new ShipperError("owned cleanup effect is indeterminate; unrelated resources were not touched", 4);
          }
          state.cleanup = {
            worktreeRemoved, branchRemoved, temporaryArtifactsRemoved: [ownedTempPath], workspacePath, branch,
            undeclaredWorktreeOutput: recordedOutput.findings,
            undeclaredWorktreeOutputCount: recordedOutput.totalCount,
          };
          store.completeEffect(pending.effectId, "adopted", { ...state.cleanup }, new Date().toISOString());
          resumedPhase = "finalize";
          state.status = "running";
          checkpoint(store, trace, state, "finalize", { reconciliation: "adopted_cleanup_after_crash" });
        } else if (pending.kind === "refresh_base"
          && state.workspacePath === workspacePath
          && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
          const undeclaredOutput = undeclaredWorktreeOutput(boundWorkspace());
          if (undeclaredOutput.length > 0) {
            throw new ShipperError(
              "base refresh left undeclared worktree output",
              4,
              undeclaredOutput.map((finding) => finding.detail),
            );
          }
          const nextBaseSha = String(pending.intent?.nextBaseSha ?? "");
          const previousHeadSha = String(pending.intent?.previousHeadSha ?? "");
          if (!/^[0-9a-f]{40,64}$/.test(nextBaseSha) || !/^[0-9a-f]{40,64}$/.test(previousHeadSha)) {
            throw new ShipperError("resume found a prepared effect outside the durable Work Run scope", 4);
          }
          const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          const rebased = observedHead !== previousHeadSha
            && ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]) === branch
            && ownedWorkspaceGit(boundWorkspace(), ["log", "-1", "--format=%B"]).includes(`Graph-Shipper-Run: ${runId}`)
            && isAncestor(boundWorkspace(), nextBaseSha, observedHead);
          if (!rebased && observedHead !== previousHeadSha) {
            const rebaseInProgress = ["rebase-merge", "rebase-apply"]
              .some((marker) => existsSync(resolve(workspacePath, ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "--git-path", marker]))));
            store.completeEffect(pending.effectId, "indeterminate", { nextBaseSha, previousHeadSha, observedHead, rebaseInProgress }, new Date().toISOString());
            throw new ShipperError("base refresh left the owned worktree on an unattributable head", 4, [
              `expected ${previousHeadSha} or this run's rebase onto ${nextBaseSha}`, `observed ${observedHead}`,
              ...(rebaseInProgress ? ["a rebase is in progress; `git rebase --abort` returns the worktree to the previous head"] : []),
            ]);
          }
          if (rebased) {
            state.baseSha = nextBaseSha;
            baseSha = nextBaseSha;
            state.headSha = observedHead;
            state.changedFiles = changedFiles(boundWorkspace(), nextBaseSha);
            store.completeEffect(pending.effectId, "adopted", { previousHeadSha, headSha: observedHead, baseSha: nextBaseSha }, new Date().toISOString());
          } else {
            store.completeEffect(pending.effectId, "failed", {
              reconciliation: "idempotent_retry_required", nextBaseSha, previousHeadSha, observedHead,
            }, new Date().toISOString());
            state.refreshAttempt += 1;
          }
          state.verification = null;
          state.documentation = null;
          state.reviewVerdict = null;
          state.reviewBundle = null;
          state.hosted = null;
          state.reviewPublication = null;
          state.mergeGuard = null;
          resumedPhase = "verify";
          state.status = "running";
          checkpoint(store, trace, state, "verify", {
            reconciliation: rebased ? "adopted_base_refresh_after_crash" : "base_refresh_not_observed",
            headSha: state.headSha, baseSha: state.baseSha,
          });
        } else if (["push_branch", "upsert_pull_request", "publish_review_verdict", "enqueue_delivery", "merge_exact_head", "sync_local_main", "close_source"].includes(pending.kind)
          && state.request.autonomy !== "local_only"
          && state.workspacePath === workspacePath
          && (!["push_branch", "upsert_pull_request"].includes(pending.kind) || pending.target === branch)
          && state.headSha
          && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())
          && ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]) === state.headSha) {
          resumedPhase = pending.kind;
          reconcilePreparedMerge = pending.kind === "merge_exact_head";
          state.status = "running";
          checkpoint(store, trace, state, pending.kind, { reconciliation: "external_effect_probe_required" });
        } else {
          throw new ShipperError("resume found a prepared effect outside the durable Work Run scope", 4);
        }
      } else if (state.status === "running" && state.phase === "act" && state.workspacePath === workspacePath
        && store.latestEffect(runId, "commit_create") && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
        const completedCommit = store.latestEffect(runId, "commit_create")!;
        const receiptHead = String(completedCommit.receipt?.headSha ?? "");
        const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
        const observedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
        const undeclaredOutput = undeclaredWorktreeOutput(boundWorkspace());
        const unattributableOutput = findUnattributableWorktreeOutput(state.preparedFileActions, undeclaredOutput);
        const unacceptableOutput = undeclaredOutput.filter((finding) => (
          finding.kind === "unsafe_ignored" || unattributableOutput.includes(finding)
        ));
        if (observedBranch !== branch || unacceptableOutput.length > 0) {
          throw new ShipperError("repair workspace drifted before stale-receipt reconciliation", 4, [
            observedBranch, ...unacceptableOutput.map((finding) => finding.detail),
          ]);
        }
        const trailer = ownedWorkspaceGit(boundWorkspace(), ["log", "-1", "--format=%B"]);
        if (receiptHead === state.headSha && observedHead === state.headSha) {
          resumedPhase = "act";
          state.status = "running";
          checkpoint(store, trace, state, "act", { reconciliation: "ignored_stale_commit_receipt" });
        } else if (receiptHead !== observedHead || !trailer.includes(`Graph-Shipper-Run: ${runId}`)) {
          throw new ShipperError("completed commit receipt no longer matches the owned workspace", 4);
        } else {
          state.headSha = observedHead;
          state.changedFiles = changedFiles(boundWorkspace(), baseSha);
          state.status = "running";
          resumedPhase = "verify";
          checkpoint(store, trace, state, "verify", { reconciliation: "adopted_commit_receipt_after_restart", headSha: observedHead });
        }
      } else if (["paused", "running"].includes(state.status) && state.workspacePath === workspacePath && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
        const expectedHead = state.headSha ?? baseSha;
        const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
        const observedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
        const undeclaredOutput = undeclaredWorktreeOutput(boundWorkspace());
        const unattributableOutput = findUnattributableWorktreeOutput(state.preparedFileActions, undeclaredOutput);
        const attributableActState = state.status === "running" && state.phase === "act"
          && unattributableOutput.length === 0;
        if (observedHead !== expectedHead || observedBranch !== branch
          || (undeclaredOutput.length > 0 && !attributableActState)) {
          state.status = "escalated";
          checkpoint(store, trace, state, "escalated", {
            reason: "workspace_drift", observedHead, observedBranch,
            undeclaredOutput: unattributableOutput.map((finding) => finding.detail),
          });
          throw new ShipperError("workspace drifted from its durable checkpoint", 4, [
            ...unattributableOutput.map((finding) => finding.detail),
          ]);
        }
        resumedPhase = state.phase;
        state.status = "running";
        checkpoint(store, trace, state, state.phase, { reconciliation: "resumed_durable_node" });
      } else if (state.status === "running" && state.phase === "workspace_intent" && !existsSync(workspacePath)) {
        createWorkspace = true;
      } else {
        const completedWorkspace = state.phase === "workspace_intent" ? store.latestEffect(runId, "workspace_create") : undefined;
        if (completedWorkspace && completedWorkspace.target === workspacePath && isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())
          && ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]) === baseSha && ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]) === branch) {
          state.workspacePath = workspacePath;
          state.status = "running";
          if (preparationCommandRefs.length > 0) captureWorkspacePreparationBaseline(state, boundWorkspace());
          prepareWorkspace = true;
          checkpoint(store, trace, state, workspaceCreationCheckpointPhase, { reconciliation: "adopted_workspace_receipt_after_restart" });
        } else {
          throw new ShipperError("resume found no safely reconcilable durable node", 3);
        }
      }
    }
    authority = new LocalAuthorityBroker({
      contractDigest: input.contractDigest,
      projectId: input.contract.metadata.projectId,
      repository: input.contract.repository.github,
      workRunId: runId,
      workItemRevision: input.request.workItem.source.revision,
      autonomy,
      allowedOperations: new Set([
        "workspace_create", "workspace_prepare", "file_write", "commit_create",
        ...(input.request.autonomy !== "local_only"
          ? ["push_branch", "upsert_pull_request", "publish_review_verdict"] as const
          : []),
        ...(input.request.autonomy === "merge_when_green" ? [
          "enqueue_delivery", "refresh_base", "merge_exact_head",
          "sync_local_main", "close_source", "cleanup_owned_resources", "post_merge_hook", "compensating_hook",
        ] as const : []),
      ]),
      maximumIterations: state.maximumIterations,
      deadlineAt: state.deadlineAt,
    });
    if (createWorkspace) {
      if (!input.resume) {
        store.createWorkRun(persisted(state));
        checkpoint(store, trace, state, "workspace_intent");
      }
      if (existsSync(workspacePath)) throw new ShipperError(`workspace collision at ${workspacePath}`, 3);
      if (git(input.projectRoot, ["branch", "--list", branch])) throw new ShipperError(`workspace branch collision: ${branch}`, 3);
      const workspaceEffect = await prepareEffect(store, state, authority, "workspace_create", workspacePath, digest([branch, baseSha]));
      assertLease(state, workspaceEffect.lease, "workspace_create");
      assertNoSymlinkAncestors(dirname(workspacePath), [input.projectRoot, input.dataRoot]);
      mkdirSync(dirname(workspacePath), { recursive: true, mode: 0o700 });
      git(input.projectRoot, ["worktree", "add", "-b", branch, workspacePath, baseSha]);
      ownedWorkspace = captureOwnedWorkspace(workspacePath);
      const observedBase = ownedWorkspaceGit(ownedWorkspace, ["rev-parse", "HEAD"]);
      const observedBranch = ownedWorkspaceGit(ownedWorkspace, ["branch", "--show-current"]);
      if (observedBase !== baseSha || observedBranch !== branch) throw new ShipperError("workspace creation postcondition failed", 3);
      state.workspacePath = ownedWorkspace.path;
      state.workspaceGitDirectory = ownedWorkspace.gitDirectory;
      checkpoint(store, trace, state, "workspace_intent", { gitDirectoryBound: true });
      if (input.crashAfterEffect === "workspace_create") throw new InjectedCrash("workspace_create");
      completeEffect(store, workspaceEffect.effectId, { workspacePath, branch, baseSha });
      if (input.crashAfterReceipt === "workspace_create") throw new InjectedNodeCrash("workspace receipt");
      if (preparationCommandRefs.length > 0) captureWorkspacePreparationBaseline(state, boundWorkspace());
      prepareWorkspace = true;
      checkpoint(store, trace, state, workspaceCreationCheckpointPhase);
      drainAtBoundary();
    }

    const commandResults = state.commandResults;
    const commandDiagnosticsRoot = join(input.dataRoot, "command-diagnostics", runId);
    const roots = {
      runtime: input.runtimeRoot, project_root: input.projectRoot, worktree: workspacePath,
      worktreeGitDirectory: boundWorkspace().gitDirectory,
      synced_main: input.projectRoot, deadlineAt: state.deadlineAt,
    };
    if (preparationCommandRefs.length > 0 && (prepareWorkspace || resumedPhase === "workspace_prepare")) {
      for (const commandRef of preparationCommandRefs) {
        const command = registry.get(commandRef);
        const effect = await prepareEffect(store, state, authority, "workspace_prepare", commandRef, digest([command.argv, baseSha]));
        if (effect.alreadyCompleted) {
          if (effect.terminalState === "applied" || effect.terminalState === "adopted") continue;
          throw new ShipperError(`workspace preparation receipt is ${effect.terminalState}: ${commandRef}`, 4, [
            `retained worktree: ${workspacePath}`,
          ]);
        }
        assertLease(state, effect.lease, "workspace_prepare");
        const result = await registry.execute(commandRef, {}, roots);
        if (result.exitCode !== 0) {
          throw new ShipperError(`workspace preparation command failed: ${commandRef}`, 4, [
            `exit code ${result.exitCode}`, `retained worktree: ${workspacePath}`,
          ]);
        }
        const preparedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
        const preparedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
        if (preparedHead !== baseSha || preparedBranch !== branch) {
          throw new ShipperError("workspace preparation changed the owned worktree head or branch", 4, [
            `command: ${commandRef}`,
            `expected head: ${baseSha}`,
            `observed head: ${preparedHead}`,
            `expected branch: ${branch}`,
            `observed branch: ${preparedBranch}`,
            `retained worktree: ${workspacePath}`,
          ]);
        }
        if (input.crashAfterEffect === `workspace_prepare:${commandRef}`) throw new InjectedCrash(`workspace_prepare:${commandRef}`);
        completeEffect(store, effect.effectId, { commandRef, exitCode: result.exitCode });
        if (input.crashAfterReceipt === `workspace_prepare:${commandRef}`) throw new InjectedNodeCrash(`workspace_prepare:${commandRef} receipt`);
      }
      if (state.localConfigDigest !== null && repositoryLocalConfigDigest(boundWorkspace()) !== state.localConfigDigest) {
        throw new ShipperError("workspace preparation changed the repository-local Git configuration", 4, [
          "declared preparation output must not rewrite the shared Git configuration",
          `retained worktree: ${workspacePath}`,
        ]);
      }
      if (state.sharedAttributesDigest !== null && sharedAttributesDigest(boundWorkspace()) !== state.sharedAttributesDigest) {
        throw new ShipperError("workspace preparation changed the shared Git attributes", 4, [
          "declared preparation output must not rewrite shared attribute rules",
          `retained worktree: ${workspacePath}`,
        ]);
      }
      assertWorkspacePreparationPostcondition(boundWorkspace(), baseSha);
      checkpoint(store, trace, state, "plan", { preparedCommandRefs: preparationCommandRefs });
      drainAtBoundary();
    }

    const priorFindings = state.priorFindings;
    let verificationEvidence: Record<string, unknown> | null = state.verification;
    let documentationEvidence: Record<string, unknown> | null = state.documentation;
    let reviewVerdict: Record<string, unknown> | null = state.reviewVerdict;
    let reuseCommittedHead = resumedPhase !== null && [
      "verify", "documentation", "independent_review", "publish_review_verdict", "enqueue_delivery",
      "merge_exact_head", "sync_local_main", "post_merge_hook", "compensating_hook", "post_merge_prior_state",
      "post_merge_prior_state_captured", "post_merge_hook_succeeded", "post_merge_complete", "close_source", "terminal_predicate",
    ].includes(resumedPhase);
    let reusePlannedActions = resumedPhase === "act";
    let reusePreparedReviewAttempt = resumedPhase === "independent_review" && state.reviewAttempt > 0;
    const finalizeOnly = resumedPhase !== null && [
      "finalize", "push_branch", "upsert_pull_request", "hosted_monitoring", "publish_review_verdict",
      "enqueue_delivery", "merge_exact_head", "sync_local_main", "post_merge_hook", "compensating_hook",
      "post_merge_prior_state", "post_merge_prior_state_captured", "post_merge_hook_succeeded", "post_merge_complete",
      "close_source", "terminal_predicate",
    ].includes(resumedPhase);
    type ModelAssignment = ProjectContract["models"]["buildAssignments"][number];
    const assignmentChain = (primaryId: string, assignments: ModelAssignment[]): ModelAssignment[] => {
      const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
      const chain: ModelAssignment[] = [];
      const seen = new Set<string>();
      const visit = (assignmentId: string): void => {
        if (seen.has(assignmentId)) return;
        seen.add(assignmentId);
        const assignment = byId.get(assignmentId);
        if (!assignment) throw new ShipperError(`configured model assignment disappeared: ${assignmentId}`, 4);
        chain.push(assignment);
        for (const fallbackId of assignment.fallbackAssignmentIds) visit(fallbackId);
      };
      visit(primaryId);
      return chain;
    };
    const plannerAdapter = (assignment: ModelAssignment): PlannerAdapter => {
      if (assignment.transport === "subscription_cli") {
        const options = {
          modelRef: assignment.modelRef,
          scratchRoot: join(input.dataRoot, "subscription-model-invocations"),
          deadlineAt: () => activeDeadlineAt,
          diagnosticsRoot: join(input.dataRoot, "subscription-cli-diagnostics", runId),
        };
        return assignment.provider === "anthropic"
          ? new AnthropicSubscriptionPlannerAdapter(options)
          : new OpenAISubscriptionPlannerAdapter(options);
      }
      if (!liveBroker) throw new ShipperError("credentialed planner is unavailable", 3);
      const options = {
        modelRef: assignment.modelRef, credentialRef: assignment.credentialRef,
        projectId: input.contract.metadata.projectId, workRunId: runId, broker: liveBroker,
        deadlineAt: () => activeDeadlineAt,
      };
      return assignment.provider === "anthropic" ? new AnthropicPlannerAdapter(options) : new OpenAIPlannerAdapter(options);
    };
    const reviewerAdapter = (assignment: ModelAssignment): ReviewerAdapter => {
      if (assignment.transport === "subscription_cli") {
        const options = {
          modelRef: assignment.modelRef,
          scratchRoot: join(input.dataRoot, "subscription-model-invocations"),
          deadlineAt: () => activeDeadlineAt,
          diagnosticsRoot: join(input.dataRoot, "subscription-cli-diagnostics", runId),
        };
        return assignment.provider === "anthropic"
          ? new AnthropicSubscriptionReviewerAdapter(options)
          : new OpenAISubscriptionReviewerAdapter(options);
      }
      if (!liveBroker) throw new ShipperError("credentialed reviewer is unavailable", 3);
      const options = {
        modelRef: assignment.modelRef, credentialRef: assignment.credentialRef,
        projectId: input.contract.metadata.projectId, workRunId: runId, broker: liveBroker,
        deadlineAt: () => activeDeadlineAt,
      };
      return assignment.provider === "anthropic" ? new AnthropicReviewerAdapter(options) : new OpenAIReviewerAdapter(options);
    };
    const invocationModelRef = (
      role: "planner" | "reviewer",
      assignment: ModelAssignment,
      primaryAssignmentId: string,
    ): string => recordedAdapters
      ? recordedAdapters.modelRef(role, assignment.id, primaryAssignmentId, assignment.provider)
      : assignment.modelRef;
    const recordModelInvocation = (
      role: "planner" | "reviewer",
      assignment: ModelAssignment,
      primaryAssignmentId: string,
      graphAttempt: number,
      malformedAttempt: number,
      outcome: "success" | ModelFailureKind,
    ): void => {
      state.modelInvocations.push({
        role,
        assignmentId: assignment.id,
        provider: assignment.provider,
        modelRef: invocationModelRef(role, assignment, primaryAssignmentId),
        graphAttempt,
        malformedAttempt,
        outcome,
      });
    };
    const invokeModelRole = async <T>(options: {
      role: "planner" | "reviewer";
      graphAttempt: number;
      primaryAssignmentId: string;
      activeAssignmentId: string;
      assignments: ModelAssignment[];
      failureLabel: "Build" | "Review";
      invokeRecorded: (assignment: ModelAssignment, malformedAttempt: number) => T;
      invokeLive: (assignment: ModelAssignment) => Promise<T>;
    }): Promise<{ response: T; assignmentId: string }> => {
      let lastFailure: ModelAdapterError | null = null;
      for (const assignment of assignmentChain(options.activeAssignmentId, options.assignments)) {
        let malformedAttempt = 0;
        while (true) {
          try {
            const response = recordedAdapters
              ? options.invokeRecorded(assignment, malformedAttempt)
              : await options.invokeLive(assignment);
            recordModelInvocation(
              options.role, assignment, options.primaryAssignmentId,
              options.graphAttempt, malformedAttempt, "success",
            );
            return { response, assignmentId: assignment.id };
          } catch (error) {
            if (!(error instanceof ModelAdapterError)) throw error;
            recordModelInvocation(
              options.role, assignment, options.primaryAssignmentId,
              options.graphAttempt, malformedAttempt, error.kind,
            );
            if (error.kind === "malformed_output" && malformedAttempt < input.contract.budgets.malformedModelOutputRetries) {
              malformedAttempt += 1;
              continue;
            }
            lastFailure = error;
            break;
          }
        }
      }
      if (lastFailure) {
        throw new ModelAdapterError(
          lastFailure.kind,
          `${options.failureLabel} Provider failed: ${lastFailure.kind}`,
          lastFailure.details,
          lastFailure.durableDetails,
        );
      }
      throw new ShipperError(`${options.failureLabel} Provider assignments were exhausted`, 3);
    };
    const acceptPlannerResponse = (response: PlanResponse): PlanResponse => {
      if (response.kind === "refusal") {
        // The reason is model-authored free text that may quote repository
        // content: keep it out of the result, state, and traces, but let the
        // operator read it from a private file.
        const diagnosticsRoot = join(input.dataRoot, "subscription-cli-diagnostics", runId);
        mkdirSync(diagnosticsRoot, { recursive: true, mode: 0o700 });
        const path = join(diagnosticsRoot, `planner-refusal-${Date.now()}.txt`);
        writeFileSync(path, `${response.reason}\n`, { mode: 0o600 });
        throw new ModelAdapterError("refusal", "Build Provider failed: refusal", [`planner_refusal_path:${path}`]);
      }
      return response;
    };
    const invokePlanner = async (plannerInput: PlannerInput, iteration: number): Promise<PlanResponse> => {
      const result = await invokeModelRole<PlanResponse>({
        role: "planner", graphAttempt: iteration, primaryAssignmentId: build.id,
        activeAssignmentId: state.activeBuildAssignmentId,
        assignments: input.contract.models.buildAssignments, failureLabel: "Build",
        invokeRecorded: (assignment, malformedAttempt) => acceptPlannerResponse(recordedAdapters!.plan(
          iteration, malformedAttempt, assignment.id, build.id,
        )),
        invokeLive: async (assignment) => acceptPlannerResponse(await plannerAdapter(assignment).plan(plannerInput)),
      });
      state.activeBuildAssignmentId = result.assignmentId;
      return result.response;
    };
    const invokeReviewer = async (reviewerInput: ReviewerInput, attempt: number): Promise<ReviewResponse> => {
      const result = await invokeModelRole<ReviewResponse>({
        role: "reviewer", graphAttempt: attempt, primaryAssignmentId: review.id,
        activeAssignmentId: state.activeReviewAssignmentId,
        assignments: input.contract.models.reviewAssignments, failureLabel: "Review",
        invokeRecorded: (assignment, malformedAttempt) => recordedAdapters!.review(
          attempt, malformedAttempt, assignment.id, review.id,
        ),
        invokeLive: (assignment) => reviewerAdapter(assignment).review(reviewerInput),
      });
      state.activeReviewAssignmentId = result.assignmentId;
      return result.response;
    };
    const currentModelRuntimeIdentity = (): Record<string, unknown> => {
      const activeBuild = input.contract.models.buildAssignments.find((assignment) => assignment.id === state.activeBuildAssignmentId);
      const activeReview = input.contract.models.reviewAssignments.find((assignment) => assignment.id === state.activeReviewAssignmentId);
      if (!activeBuild || !activeReview) throw new ShipperError("active model assignment disappeared from the contract", 4);
      return {
        runtimeVersion: state.runtimeVersion,
        runtimeRevision: state.runtimeRevision,
        build: {
          provider: activeBuild.provider,
          transport: activeBuild.transport,
          modelRef: recordedAdapters
            ? recordedAdapters.modelRef("planner", activeBuild.id, build.id, activeBuild.provider)
            : activeBuild.modelRef,
        },
        review: {
          provider: activeReview.provider,
          transport: activeReview.transport,
          modelRef: recordedAdapters
            ? recordedAdapters.modelRef("reviewer", activeReview.id, review.id, activeReview.provider)
            : activeReview.modelRef,
        },
        invocations: state.modelInvocations,
      };
    };
    const normalizedModelFailures = (): WorkRunOutput["modelFailures"] => state.modelInvocations
      .filter((invocation) => invocation.outcome !== "success")
      .map((invocation) => ({
        role: invocation.role,
        kind: invocation.outcome as ModelFailureKind,
        graphAttempt: invocation.graphAttempt,
        malformedAttempt: invocation.malformedAttempt,
      }));

    const operationalRoots = () => ({
      runtime: input.runtimeRoot,
      project_root: input.projectRoot,
      worktree: workspacePath,
      worktreeGitDirectory: boundWorkspace().gitDirectory,
      synced_main: input.projectRoot,
      deadlineAt: state.deadlineAt,
    });
    const operationalCommandValues = (commandId: string, values: Record<string, string> = {}): Record<string, string> => {
      const command = registry.get(commandId);
      const available: Record<string, string | undefined> = {
        run_id: runId,
        merged_sha: state.merge?.mergedSha,
        ...values,
      };
      return Object.fromEntries(Object.keys(command.parameters).map((name) => {
        const value = available[name];
        if (!value) throw new ShipperError(`${command.id}: unsupported operational parameter ${name}`, 4);
        return [name, value];
      }));
    };
    const executeOperationalCommand = async (
      commandId: string,
      values: Record<string, string> = {},
      options: { privateStdout?: boolean } = {},
    ): Promise<OperationalCommandResult> => {
      const command = registry.get(commandId);
      const renderedValues = operationalCommandValues(commandId, values);
      const result = await postMergeAdapter.execute(commandId, renderedValues, operationalRoots(), {
        projectId: state.projectId, workRunId: runId, dataRoot: input.dataRoot,
      });
      const { stdoutBytes: _privateBytes, ...evidenceResult } = result;
      commandResults.push(options.privateStdout
        ? { ...evidenceResult, stdout: "[stored as private prior-state artifact]" }
        : evidenceResult);
      state.commandResults = commandResults;
      return result;
    };
    const delayForRetry = async (seconds: number): Promise<void> => {
      if (seconds === 0) return;
      const remaining = Date.parse(state.deadlineAt) - Date.now();
      const milliseconds = seconds * 1000;
      if (remaining <= milliseconds) throw new ShipperError("Work Run wall-clock budget exhausted during post-merge backoff", 4);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
    };
    const writePriorStateArtifact = (compensationId: string, source: Buffer): { path: string; digest: string } => {
      const root = join(input.dataRoot, "runs", runId, "prior-state");
      assertNoSymlinkAncestors(root, [input.dataRoot]);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      chmodSync(root, 0o700);
      const path = join(root, `${compensationId}.artifact`);
      const sourceDigest = createHash("sha256").update(source).digest("hex");
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || createHash("sha256").update(readFileSync(path)).digest("hex") !== sourceDigest) {
          throw new ShipperError(`${compensationId}: durable prior-state artifact is indeterminate`, 4, [path]);
        }
        return { path, digest: sourceDigest };
      }
      const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeFileSync(descriptor, source);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const directory = openSync(root, constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return { path, digest: sourceDigest };
    };
    type OperationalAttemptOutcome = {
      status: "succeeded" | "exhausted" | "ambiguous";
      attempts: number;
      diagnostics: string[];
      reconciliation?: "success_probe_observed_after_command_error";
    };
    const runOperationalAttempts = async (attemptInput: {
      kind: "post_merge_hook" | "compensating_hook";
      leaseHookId: string;
      effectTargetPrefix: string;
      commandRef: string;
      commandValues?: Record<string, string>;
      successCheckCommandRef: string;
      successCheckValues?: Record<string, string>;
      retry: { maximumAttempts: number; backoffSeconds: number };
      mergedSha: string;
      desiredDigest: () => string;
      intentMetadata: Record<string, unknown>;
      checkpointPayload: (attempt: number) => Record<string, unknown>;
      crashIdentity: string;
    }): Promise<OperationalAttemptOutcome> => {
      const diagnostics: string[] = [];
      const command = registry.get(attemptInput.commandRef);
      for (let attempt = 1; attempt <= attemptInput.retry.maximumAttempts; attempt += 1) {
        checkpoint(store, trace, state, attemptInput.kind, attemptInput.checkpointPayload(attempt));
        const successCheckValues = operationalCommandValues(
          attemptInput.successCheckCommandRef, attemptInput.successCheckValues,
        );
        const effect = await prepareEffect(
          store, state, authority, attemptInput.kind, `${attemptInput.effectTargetPrefix}:attempt:${attempt}`,
          attemptInput.desiredDigest(), {
            ...attemptInput.intentMetadata,
            hookId: attemptInput.leaseHookId,
            attempt,
            commandId: attemptInput.commandRef,
            successCheckCommandRef: attemptInput.successCheckCommandRef,
            successCheckValues,
            idempotence: command.idempotence,
            mergedSha: attemptInput.mergedSha,
          },
        );
        if (effect.alreadyCompleted) {
          diagnostics.push(`attempt ${attempt} has a durable ${effect.terminalState} receipt`);
          if (effect.terminalState === "applied" || effect.terminalState === "adopted") {
            return { status: "succeeded", attempts: attempt, diagnostics };
          }
          if (effect.terminalState === "indeterminate") {
            return { status: "ambiguous", attempts: attempt, diagnostics };
          }
          if (attempt < attemptInput.retry.maximumAttempts) await delayForRetry(attemptInput.retry.backoffSeconds);
          continue;
        }
        assertLease(state, effect.lease, attemptInput.kind, attemptInput.leaseHookId);

        let result: CommandResult;
        try {
          result = await executeOperationalCommand(attemptInput.commandRef, attemptInput.commandValues);
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : String(error);
          diagnostics.push(diagnostic);
          let probe: CommandResult | null = null;
          try {
            probe = await executeOperationalCommand(attemptInput.successCheckCommandRef, attemptInput.successCheckValues);
          } catch { /* deadline/transport ambiguity */ }
          if (probe?.exitCode === 0) {
            store.completeEffect(effect.effectId, "adopted", {
              ...attemptInput.intentMetadata,
              attempt,
              reconciliation: "success_probe_observed_after_command_error",
              successCheckCommandRef: attemptInput.successCheckCommandRef,
              mergedSha: attemptInput.mergedSha,
            }, new Date().toISOString());
            return { status: "succeeded", attempts: attempt, diagnostics, reconciliation: "success_probe_observed_after_command_error" };
          }
          if (command.idempotence !== "idempotent") {
            store.completeEffect(effect.effectId, "indeterminate", {
              ...attemptInput.intentMetadata,
              attempt,
              diagnostic,
              successCheckCommandRef: attemptInput.successCheckCommandRef,
              probeExitCode: probe?.exitCode ?? null,
              mergedSha: attemptInput.mergedSha,
            }, new Date().toISOString());
            return { status: "ambiguous", attempts: attempt, diagnostics };
          }
          store.completeEffect(effect.effectId, "failed", {
            ...attemptInput.intentMetadata,
            attempt,
            diagnostic,
            successCheckCommandRef: attemptInput.successCheckCommandRef,
            probeExitCode: probe?.exitCode ?? null,
            mergedSha: attemptInput.mergedSha,
          }, new Date().toISOString());
          if (attempt < attemptInput.retry.maximumAttempts) await delayForRetry(attemptInput.retry.backoffSeconds);
          continue;
        }

        diagnostics.push(result.stderr || result.stdout || `exit ${result.exitCode}`);
        if (input.crashAfterEffect === attemptInput.kind || input.crashAfterEffect === `${attemptInput.kind}:${attemptInput.crashIdentity}`) {
          throw new InjectedCrash(`${attemptInput.kind}:${attemptInput.crashIdentity}`);
        }
        let probe: CommandResult;
        try {
          probe = await executeOperationalCommand(attemptInput.successCheckCommandRef, attemptInput.successCheckValues);
        } catch (error) {
          const diagnostic = error instanceof Error ? error.message : String(error);
          diagnostics.push(diagnostic);
          store.completeEffect(effect.effectId, "indeterminate", {
            ...attemptInput.intentMetadata,
            attempt,
            commandId: result.commandId,
            argv: result.argv,
            exitCode: result.exitCode,
            successCheckCommandRef: attemptInput.successCheckCommandRef,
            probeError: diagnostic,
            mergedSha: attemptInput.mergedSha,
          }, new Date().toISOString());
          return { status: "ambiguous", attempts: attempt, diagnostics };
        }
        if (probe.exitCode === 0) {
          store.completeEffect(effect.effectId, "applied", {
            ...attemptInput.intentMetadata,
            attempt,
            commandId: result.commandId,
            argv: result.argv,
            exitCode: result.exitCode,
            successCheckCommandRef: attemptInput.successCheckCommandRef,
            mergedSha: attemptInput.mergedSha,
          }, new Date().toISOString());
          if (input.crashAfterReceipt === attemptInput.kind || input.crashAfterReceipt === `${attemptInput.kind}:${attemptInput.crashIdentity}`) {
            throw new InjectedNodeCrash(`${attemptInput.kind}:${attemptInput.crashIdentity} receipt`);
          }
          return { status: "succeeded", attempts: attempt, diagnostics };
        }
        store.completeEffect(effect.effectId, "failed", {
          ...attemptInput.intentMetadata,
          attempt,
          commandId: result.commandId,
          argv: result.argv,
          exitCode: result.exitCode,
          successCheckCommandRef: attemptInput.successCheckCommandRef,
          probeExitCode: probe.exitCode,
          mergedSha: attemptInput.mergedSha,
        }, new Date().toISOString());
        if (attempt < attemptInput.retry.maximumAttempts) await delayForRetry(attemptInput.retry.backoffSeconds);
      }
      return { status: "exhausted", attempts: attemptInput.retry.maximumAttempts, diagnostics };
    };
    const runPostMergeHooks = async (mergedSha: string, alreadySerialized = false): Promise<PostMergeState> => {
      const hooks = [...input.contract.postMergeHooks].sort((left, right) => left.order - right.order);
      const postMerge: PostMergeState = state.postMerge ?? {
        status: "running", mergedSha, hooks: [], priorState: {}, compensation: null,
      };
      if (postMerge.mergedSha !== mergedSha) throw new ShipperError("post-merge state is bound to a different merged SHA", 4);
      state.postMerge = postMerge;
      if (hooks.length === 0) {
        postMerge.status = "succeeded";
        checkpoint(store, trace, state, "post_merge_complete", { mergedSha, hookCount: 0 });
        return postMerge;
      }
      const operationToken = alreadySerialized ? null : randomUUID();
      if (operationToken) store.claimProjectOperation(state.projectId, runId, "post_merge", operationToken);
      try {
        for (const hook of hooks) {
          const existing = postMerge.hooks.find((candidate) => candidate.id === hook.id && candidate.status === "succeeded");
          if (existing) continue;
          const compensation = hook.compensatingHookRef
            ? input.contract.compensatingHooks.find((candidate) => candidate.id === hook.compensatingHookRef)
            : undefined;
          if (compensation && !postMerge.priorState[compensation.id]) {
            checkpoint(store, trace, state, "post_merge_prior_state", { hookId: hook.id, compensationId: compensation.id, mergedSha });
            const capture = await executeOperationalCommand(compensation.priorStateCaptureCommandRef, {}, { privateStdout: true });
            if (capture.exitCode !== 0 || !capture.stdoutBytes || capture.stdoutBytes.length === 0) {
              throw new ShipperError(`${hook.id}: prior-state capture failed`, 4, [capture.stderr || capture.stdout]);
            }
            const priorState = writePriorStateArtifact(compensation.id, capture.stdoutBytes);
            postMerge.priorState[compensation.id] = priorState;
            checkpoint(store, trace, state, "post_merge_prior_state_captured", {
              hookId: hook.id, compensationId: compensation.id, artifactDigest: priorState.digest,
            });
          }

          const alreadySatisfied = await executeOperationalCommand(hook.successCheckCommandRef);
          if (alreadySatisfied.exitCode === 0) {
            postMerge.hooks.push({ id: hook.id, order: hook.order, status: "succeeded", attempts: 0, reconciliation: "success_probe_observed" });
            checkpoint(store, trace, state, "post_merge_hook", { hookId: hook.id, reconciliation: "success_probe_observed" });
            continue;
          }

          const hookCommand = registry.get(hook.commandRef);
          const hookOutcome = await runOperationalAttempts({
            kind: "post_merge_hook",
            leaseHookId: hook.id,
            effectTargetPrefix: `hook:${hook.id}`,
            commandRef: hook.commandRef,
            successCheckCommandRef: hook.successCheckCommandRef,
            retry: hook.retry,
            mergedSha,
            desiredDigest: () => digest({ mergedSha, commandRef: hook.commandRef, argv: hookCommand.argv, cwd: hookCommand.cwd }),
            intentMetadata: { hookId: hook.id },
            checkpointPayload: (attempt) => ({ hookId: hook.id, order: hook.order, attempt, mergedSha }),
            crashIdentity: hook.id,
          });
          const diagnostics = hookOutcome.diagnostics;
          if (hookOutcome.status === "succeeded") {
            postMerge.hooks.push({
              id: hook.id,
              order: hook.order,
              status: "succeeded",
              attempts: hookOutcome.attempts,
              commandId: hook.commandRef,
              successCheckCommandRef: hook.successCheckCommandRef,
              ...(hookOutcome.reconciliation ? { reconciliation: hookOutcome.reconciliation } : {}),
            });
            checkpoint(store, trace, state, "post_merge_hook_succeeded", { hookId: hook.id, attempt: hookOutcome.attempts, mergedSha });
            continue;
          }
          if (hookOutcome.status === "ambiguous") {
            postMerge.hooks.push({ id: hook.id, order: hook.order, status: "ambiguous", attempts: hookOutcome.attempts, diagnostics });
            postMerge.status = "failed";
          }

          if (!postMerge.hooks.some((candidate) => candidate.id === hook.id)) {
            postMerge.hooks.push({ id: hook.id, order: hook.order, status: "failed", attempts: hook.retry.maximumAttempts, diagnostics });
          }
          postMerge.status = "failed";
          if (!compensation) {
            checkpoint(store, trace, state, "post_merge_failed", { hookId: hook.id, mergedSha, compensation: "not_declared" });
            throw new ShipperError(`${hook.id}: post-merge retries exhausted`, 4, diagnostics);
          }
          const priorState = postMerge.priorState[compensation.id];
          if (!priorState) throw new ShipperError(`${hook.id}: captured prior state is missing`, 4);
          const values = { prior_state_artifact: priorState.path };
          const priorAlreadyRestored = await executeOperationalCommand(compensation.successCheckCommandRef, values);
          if (priorAlreadyRestored.exitCode === 0) {
            postMerge.status = "compensated";
            postMerge.compensation = { id: compensation.id, status: "succeeded", attempts: 0, reconciliation: "success_probe_observed", priorStateDigest: priorState.digest };
          } else {
            const compensationCommand = registry.get(compensation.commandRef);
            const compensationOutcome = await runOperationalAttempts({
              kind: "compensating_hook",
              leaseHookId: compensation.id,
              effectTargetPrefix: `compensation:${compensation.id}`,
              commandRef: compensation.commandRef,
              commandValues: values,
              successCheckCommandRef: compensation.successCheckCommandRef,
              successCheckValues: values,
              retry: compensation.retry,
              mergedSha,
              desiredDigest: () => digest({
                mergedSha,
                commandRef: compensation.commandRef,
                argv: compensationCommand.argv,
                cwd: compensationCommand.cwd,
                priorStateDigest: priorState.digest,
              }),
              intentMetadata: {
                forPostMergeHookRef: hook.id,
                compensationId: compensation.id,
                priorStateDigest: priorState.digest,
              },
              checkpointPayload: (attempt) => ({ hookId: hook.id, compensationId: compensation.id, attempt, mergedSha }),
              crashIdentity: compensation.id,
            });
            if (compensationOutcome.status === "succeeded") {
              postMerge.status = "compensated";
              postMerge.compensation = {
                id: compensation.id,
                status: "succeeded",
                attempts: compensationOutcome.attempts,
                priorStateDigest: priorState.digest,
                ...(compensationOutcome.reconciliation ? { reconciliation: compensationOutcome.reconciliation } : {}),
              };
            } else if (compensationOutcome.status === "ambiguous") {
              postMerge.status = "compensation_ambiguous";
              postMerge.compensation = {
                id: compensation.id,
                status: "ambiguous",
                attempts: compensationOutcome.attempts,
                diagnostics: compensationOutcome.diagnostics,
                priorStateDigest: priorState.digest,
              };
            } else {
              postMerge.status = "compensation_exhausted";
              postMerge.compensation = {
                id: compensation.id,
                status: "exhausted",
                attempts: compensationOutcome.attempts,
                diagnostics: compensationOutcome.diagnostics,
                priorStateDigest: priorState.digest,
              };
            }
          }
          checkpoint(store, trace, state, "post_merge_escalation", { hookId: hook.id, mergedSha, status: postMerge.status, compensation: postMerge.compensation });
          throw new ShipperError(`${hook.id}: post-merge retries exhausted; compensation ${postMerge.status === "compensated" ? "succeeded" : "did not restore a proven state"}`, 4, diagnostics);
        }
        postMerge.status = "succeeded";
        checkpoint(store, trace, state, "post_merge_complete", { mergedSha, hookCount: hooks.length });
        return postMerge;
      } finally {
        if (operationToken) store.releaseProjectOperation(state.projectId, runId, operationToken);
      }
    };

    const publishReviewApproval = async (headSha: string, pullRequestNumber: number): Promise<ReviewPublicationReceipt> => {
      if (!githubAdapter || !state.reviewBundle || !state.reviewVerdict) {
        throw new ShipperError("review publication is missing exact-head review evidence", 4);
      }
      const reviewBundleDigest = digest(state.reviewBundle);
      checkpoint(store, trace, state, "publish_review_verdict", { headSha, reviewBundleDigest });
      const publicationEffect = await prepareEffect(
        store, state, authority, "publish_review_verdict", `pr:${pullRequestNumber}`,
        digest({ headSha, reviewProvider: review.provider, reviewBundleDigest }),
      );
      if (publicationEffect.alreadyCompleted) {
        if (publicationEffect.terminalState !== "applied" && publicationEffect.terminalState !== "adopted") {
          throw new ShipperError(`review publication effect is ${publicationEffect.terminalState ?? "unknown"}`, 4);
        }
        const publication = reviewPublicationFromReceipt(publicationEffect.receipt, {
          headSha, runId, reviewProvider: review.provider, reviewBundleDigest,
        });
        state.reviewPublication = publication;
        return publication;
      }
      assertLease(state, publicationEffect.lease, "publish_review_verdict");
      const publication = await githubAdapter.publishReviewVerdict({
        lease: publicationEffect.lease,
        number: pullRequestNumber,
        headSha,
        runId,
        reviewProvider: review.provider,
        reviewBundleDigest,
      });
      state.reviewPublication = publication;
      if (!publicationEffect.alreadyCompleted) {
        if (input.crashAfterEffect === "publish_review_verdict") throw new InjectedCrash("publish_review_verdict");
        store.completeEffect(
          publicationEffect.effectId,
          publication.disposition === "adopted" ? "adopted" : "applied",
          { ...publication },
          new Date().toISOString(),
        );
        if (input.crashAfterReceipt === "publish_review_verdict") throw new InjectedNodeCrash("publish_review_verdict receipt");
      }
      return publication;
    };

    const hostedApprovalSatisfied = (hosted: PullRequestObservation): boolean => input.request.autonomy === "open_pr"
      ? hosted.providerApprovalPublished || hosted.reviewApproved
      : hosted.reviewApproved;

    const deliverOpenPr = async (headSha: string): Promise<PullRequestObservation> => {
      if (!githubAdapter) throw new ShipperError("open_pr GitHub Adapter is unavailable", 3);
      const assertSourceCurrent = async (): Promise<void> => {
        if (input.request.workItem.source.kind !== "github_issue") return;
        const sourceRevision = await githubAdapter.observeIssueRevision({
          identity: input.request.workItem.source.identity,
          expectedRevision: input.request.workItem.source.revision,
        });
        state.sourceRevision = sourceRevision;
        if (sourceRevision.drifted) throw new ShipperError("Work Item source revision drifted after activation", 4, [
          `expected ${sourceRevision.expectedRevision}`,
          `observed ${sourceRevision.observedRevision}`,
        ]);
      };
      await assertSourceCurrent();
      const expectedRemoteHeadSha = state.pullRequest?.headSha ?? null;
      checkpoint(store, trace, state, "push_branch", { headSha, branch, expectedRemoteHeadSha });
      const pushEffect = await prepareEffect(store, state, authority, "push_branch", branch, headSha, { expectedRemoteHeadSha });
      if (!pushEffect.alreadyCompleted) {
        assertLease(state, pushEffect.lease, "push_branch");
        const pushReceipt = await githubAdapter.pushBranch({
          lease: pushEffect.lease,
          branch,
          headSha,
          expectedRemoteHeadSha,
          workspacePath,
          gitDirectory: boundWorkspace().gitDirectory,
        });
        if (input.crashAfterEffect === "push_branch") throw new InjectedCrash("push_branch");
        completeEffect(store, pushEffect.effectId, { ...pushReceipt });
        if (input.crashAfterReceipt === "push_branch") throw new InjectedNodeCrash("push_branch receipt");
      }

      const reference = input.contract.github.pullRequest.sourceReference;
      if (!reference) throw new ShipperError("open_pr source reference contract disappeared", 4);
      const pullRequestBody = `${input.request.workItem.body}\n\n${reference.prefix} ${input.request.workItem.source.identity}`;
      checkpoint(store, trace, state, "upsert_pull_request", { headSha, branch });
      const pullEffect = await prepareEffect(
        store, state, authority, "upsert_pull_request", branch,
        digest({ headSha, base: input.contract.github.pullRequest.baseBranch, title: input.request.workItem.title, body: pullRequestBody }),
      );
      let pullRequest = state.pullRequest;
      if (!pullEffect.alreadyCompleted || !pullRequest || pullRequest.headSha !== headSha) {
        pullRequest = {
          ...await githubAdapter.upsertPullRequest({
            lease: pullEffect.lease,
            branch,
            headSha,
            baseBranch: input.contract.github.pullRequest.baseBranch,
            title: input.request.workItem.title,
            body: pullRequestBody,
          }),
          draft: false,
        };
        state.pullRequest = pullRequest;
        if (!pullEffect.alreadyCompleted) {
          if (input.crashAfterEffect === "upsert_pull_request") throw new InjectedCrash("upsert_pull_request");
          store.completeEffect(
            pullEffect.effectId,
            pullRequest.disposition === "adopted" ? "adopted" : "applied",
            { ...pullRequest },
            new Date().toISOString(),
          );
          if (input.crashAfterReceipt === "upsert_pull_request") throw new InjectedNodeCrash("upsert_pull_request receipt");
        }
      }
      if (!pullRequest) throw new ShipperError("pull request reconciliation produced no receipt", 4);
      const reviewPublication = await publishReviewApproval(headSha, pullRequest.number);
      checkpoint(store, trace, state, "hosted_monitoring", { pullRequest });
      const observe = async (): Promise<PullRequestObservation> => await githubAdapter.observePullRequest({
        number: pullRequest.number,
        expectedHeadSha: headSha,
        requiredChecks: input.contract.github.requiredHostedChecks,
        ...(input.contract.github.requiredCheckSource
          ? { requiredCheckSource: input.contract.github.requiredCheckSource }
          : {}),
        trustedReviewerActors: input.contract.github.trustedFeedback.reviewerActors,
        trustedFeedbackActors: [
          ...input.contract.github.trustedFeedback.reviewerActors,
          ...input.contract.github.trustedFeedback.githubApps,
        ],
        trustedCheckProducers: input.contract.github.trustedFeedback.requiredCheckProducers,
        reviewPublication,
      });
      let hosted = await observe();
      state.hosted = hosted;
      let poll = 0;
      githubAdapter.resetObservationBackoff();
      while (Date.now() < Date.parse(state.deadlineAt)) {
        const completedFailure = hosted.requiredChecks.some((check) => check.status === "completed" && check.conclusion !== "success");
        if (hosted.headDrift || (hosted.hostedChecksGreen && hostedApprovalSatisfied(hosted))
          || hosted.trustedFeedback.length > 0 || completedFailure) break;
        poll += 1;
        checkpoint(store, trace, state, "hosted_monitoring", {
          pullRequest,
          poll,
          waitingFor: hosted.hostedChecksGreen ? "exact_head_approval" : "required_checks",
        });
        const readiness = await githubAdapter.waitForNextObservation(state.deadlineAt);
        if (readiness === "exhausted") throw new ShipperError("hosted observation budget exhausted before terminal evidence", 3);
        await assertSourceCurrent();
        hosted = await observe();
        state.hosted = hosted;
      }
      if (hosted.hostedChecksGreen && hostedApprovalSatisfied(hosted) && hosted.trustedFeedback.length === 0) {
        await assertSourceCurrent();
      }
      return hosted;
    };

    const advanceLocalBase = async (remoteBaseSha: string, localBaseSha: string): Promise<void> => {
      const unavailable = (...details: string[]): ShipperError => new ShipperError(
        "base branch advanced but the exact remote base is not available locally", 4,
        [`reviewed base ${baseSha}`, `remote base ${remoteBaseSha}`, `local base ${localBaseSha}`, ...details],
      );
      const observedBranch = git(input.projectRoot, ["branch", "--show-current"]);
      const dirty = git(input.projectRoot, ["status", "--porcelain", "--untracked-files=all"]);
      if (observedBranch !== input.contract.repository.defaultBranch || dirty) {
        throw unavailable("primary clone is not safe for exact base advancement", observedBranch, dirty);
      }
      // The local base was resolved by branch name, which git resolves against tags first
      // and only warns about. HEAD is unambiguous, so the two agreeing is what makes the
      // ancestor test below evidence about the commits the reset would actually discard.
      const observedHead = git(input.projectRoot, ["rev-parse", "HEAD"]);
      if (observedHead !== localBaseSha) {
        throw unavailable("primary clone head does not match the resolved local base", observedHead);
      }
      await githubAdapter?.fetchCommit({
        ref: input.contract.repository.defaultBranch, commitSha: remoteBaseSha, workspacePath: input.projectRoot,
      });
      try {
        git(input.projectRoot, ["cat-file", "-e", `${remoteBaseSha}^{commit}`]);
      } catch (error) {
        throw unavailable("the remote base could not be obtained", error instanceof Error ? error.message : String(error));
      }
      try {
        git(input.projectRoot, ["merge-base", "--is-ancestor", localBaseSha, remoteBaseSha]);
      } catch {
        throw unavailable("the remote base does not fast-forward the local base");
      }
      git(input.projectRoot, ["reset", "--hard", remoteBaseSha]);
      if (git(input.projectRoot, ["rev-parse", "HEAD"]) !== remoteBaseSha) {
        throw unavailable("base advancement postcondition failed");
      }
    };

    const synchronizeLocalMain = async (mergedSha: string, expectedBaseSha: string): Promise<void> => {
      checkpoint(store, trace, state, "sync_local_main", { mergedSha, expectedBaseSha });
      const effect = await prepareEffect(
        store, state, authority, "sync_local_main", input.contract.repository.defaultBranch,
        digest({ mergedSha, expectedBaseSha }), { mergedSha, expectedBaseSha },
      );
      const observedBranch = git(input.projectRoot, ["branch", "--show-current"]);
      const observedHead = git(input.projectRoot, ["rev-parse", "HEAD"]);
      const dirty = git(input.projectRoot, ["status", "--porcelain", "--untracked-files=all"]);
      if (observedBranch !== input.contract.repository.defaultBranch || dirty) {
        throw new ShipperError("primary clone is not safe for exact local-main synchronization", 4, [observedBranch, dirty]);
      }
      if (observedHead === mergedSha) {
        if (!effect.alreadyCompleted) store.completeEffect(effect.effectId, "adopted", { mergedSha, observedHead }, new Date().toISOString());
        return;
      }
      if (observedHead !== expectedBaseSha) {
        throw new ShipperError("local main advanced outside the serialized merge guard", 4, [
          `expected ${expectedBaseSha}`, `observed ${observedHead}`,
        ]);
      }
      assertLease(state, effect.lease, "sync_local_main");
      await githubAdapter?.fetchCommit({
        ref: input.contract.repository.defaultBranch, commitSha: mergedSha, workspacePath: input.projectRoot,
      });
      git(input.projectRoot, ["cat-file", "-e", `${mergedSha}^{commit}`]);
      git(input.projectRoot, ["reset", "--hard", mergedSha]);
      if (git(input.projectRoot, ["rev-parse", "HEAD"]) !== mergedSha) throw new ShipperError("local-main synchronization postcondition failed", 4);
      if (input.crashAfterEffect === "sync_local_main") throw new InjectedCrash("sync_local_main");
      if (!effect.alreadyCompleted) completeEffect(store, effect.effectId, { mergedSha, previousHeadSha: expectedBaseSha });
      if (input.crashAfterReceipt === "sync_local_main") throw new InjectedNodeCrash("sync_local_main receipt");
    };

    const proveTerminalAndClose = async (headSha: string, mergedSha: string, alreadySerialized = false): Promise<void> => {
      await synchronizeLocalMain(mergedSha, baseSha);
      await runPostMergeHooks(mergedSha, alreadySerialized);
      checkpoint(store, trace, state, "terminal_predicate", { mergedSha, strategy: input.contract.delivery.strategy });
      if (git(input.projectRoot, ["rev-parse", input.contract.repository.defaultBranch]) !== mergedSha) {
        throw new ShipperError("delivery terminal predicate lacks synchronized local main", 4);
      }
      state.terminal = {
        satisfied: true,
        strategy: input.contract.delivery.strategy,
        predicate: input.contract.delivery.strategy === "github_direct"
          ? input.contract.delivery.terminalPredicate
          : input.contract.delivery.terminalPredicateCommandRef,
        headSha,
        mergedSha,
        postMergeHooksSatisfied: state.postMerge?.status === "succeeded",
      };
      if (input.request.workItem.source.kind === "github_issue") {
        checkpoint(store, trace, state, "close_source", { identity: input.request.workItem.source.identity, mergedSha });
        const closeEffect = await prepareEffect(
          store, state, authority, "close_source", input.request.workItem.source.identity,
          digest({ headSha, mergedSha }), { mergedSha },
        );
        const closure = await githubAdapter!.closeIssue({
          lease: closeEffect.lease,
          identity: input.request.workItem.source.identity,
          terminalSha: mergedSha,
        });
        state.sourceClosure = closure;
        if (!closeEffect.alreadyCompleted) {
          if (input.crashAfterEffect === "close_source") throw new InjectedCrash("close_source");
          store.completeEffect(closeEffect.effectId, closure.disposition === "adopted" ? "adopted" : "applied", { ...closure }, new Date().toISOString());
        }
      }
    };

    const deliverMergeTerminal = async (headSha: string): Promise<{ refreshed: boolean }> => {
      if (!githubAdapter || !state.pullRequest || !state.hosted || !state.reviewBundle || !state.reviewVerdict) {
        throw new ShipperError("merge delivery is missing exact-head PR, hosted, or review evidence", 4);
      }
      if (state.reviewVerdict.headSha !== headSha || state.reviewVerdict.baseSha !== baseSha
        || state.hosted.headSha !== headSha || !state.hosted.hostedChecksGreen || !state.hosted.reviewApproved) {
        throw new ShipperError("merge delivery evidence is stale", 4);
      }
      if (reconcilePreparedMerge && input.contract.delivery.strategy === "github_direct" && state.pullRequest) {
        const mergeEffect = await prepareEffect(
          store, state, authority, "merge_exact_head", `pr:${state.pullRequest.number}`, headSha,
          { expectedBaseSha: baseSha, pullRequestNumber: state.pullRequest.number, method: input.contract.github.mergeMethod },
        );
        const receipt = await githubAdapter.mergeExactHead({
          lease: mergeEffect.lease,
          number: state.pullRequest.number,
          headSha,
          baseSha,
          method: input.contract.github.mergeMethod,
        });
        state.merge = receipt;
        if (!mergeEffect.alreadyCompleted) {
          store.completeEffect(mergeEffect.effectId, "adopted", { ...receipt }, new Date().toISOString());
        }
        reconcilePreparedMerge = false;
        await proveTerminalAndClose(headSha, receipt.mergedSha);
        return { refreshed: false };
      }
      if (state.merge?.headSha === headSha) {
        await proveTerminalAndClose(headSha, state.merge.mergedSha);
        return { refreshed: false };
      }
      const mergeClaimToken = randomUUID();
      store.claimProjectOperation(state.projectId, runId, "merge", mergeClaimToken);
      try {
        checkpoint(store, trace, state, "merge_guard", { headSha, baseSha, strategy: input.contract.delivery.strategy });
        const guard = await githubAdapter.observeMergeGuard({
          number: state.pullRequest.number,
          expectedHeadSha: headSha,
          expectedBaseSha: baseSha,
          baseBranch: input.contract.repository.defaultBranch,
          requiredChecks: input.contract.github.requiredHostedChecks,
          ...(input.contract.github.requiredCheckSource
            ? { requiredCheckSource: input.contract.github.requiredCheckSource }
            : {}),
          trustedReviewerActors: input.contract.github.trustedFeedback.reviewerActors,
          trustedCheckProducers: input.contract.github.trustedFeedback.requiredCheckProducers,
        });
        state.mergeGuard = guard;
        const localBaseSha = git(input.projectRoot, ["rev-parse", input.contract.repository.defaultBranch]);
        if (guard.baseDrift || localBaseSha !== baseSha) {
          if (!/^[0-9a-f]{40,64}$/.test(guard.baseSha)) {
            throw new ShipperError("base branch advanced but the exact remote base is not available locally", 4, [
              `reviewed base ${baseSha}`, `remote base ${guard.baseSha}`, `local base ${localBaseSha}`,
            ]);
          }
          checkpoint(store, trace, state, "refresh_base", { previousBaseSha: baseSha, nextBaseSha: guard.baseSha });
          const refresh = await prepareEffect(
            store, state, authority, "refresh_base", branch,
            digest({ headSha, nextBaseSha: guard.baseSha, attempt: state.refreshAttempt }),
            { previousHeadSha: headSha, nextBaseSha: guard.baseSha },
          );
          assertLease(state, refresh.lease, "refresh_base");
          if (guard.baseSha !== localBaseSha) await advanceLocalBase(guard.baseSha, localBaseSha);
          try {
            ownedWorkspaceGit(boundWorkspace(), [
              ...gitCommitIdentityArgs(input.contract.delivery.commitIdentity),
              "rebase", guard.baseSha,
            ]);
          } catch (error) {
            try { ownedWorkspaceGit(boundWorkspace(), ["rebase", "--abort"]); } catch { /* preserve the original failure */ }
            throw error;
          }
          const refreshedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          if (input.crashAfterEffect === "refresh_base") throw new InjectedCrash("refresh_base");
          state.baseSha = guard.baseSha;
          baseSha = guard.baseSha;
          state.headSha = refreshedHead;
          state.changedFiles = changedFiles(boundWorkspace(), baseSha);
          state.verification = null;
          state.documentation = null;
          state.reviewVerdict = null;
          state.reviewBundle = null;
          state.hosted = null;
          state.reviewPublication = null;
          state.mergeGuard = null;
          completeEffect(store, refresh.effectId, { previousHeadSha: headSha, headSha: refreshedHead, baseSha });
          checkpoint(store, trace, state, "verify", { invalidatedBy: "base_advancement", headSha: refreshedHead, baseSha });
          return { refreshed: true };
        }
        if (!guard.eligible) {
          throw new ShipperError("merge dispatch revalidation failed", 4, [
            `branchProtected=${guard.branchProtected}`, `mergeable=${guard.mergeable}`,
            `hostedChecksGreen=${guard.hostedChecksGreen}`, `reviewApproved=${guard.reviewApproved}`,
          ]);
        }

        let mergedSha: string;
        if (input.contract.delivery.strategy === "github_direct") {
          checkpoint(store, trace, state, "merge_exact_head", { headSha, method: input.contract.github.mergeMethod });
          const mergeEffect = await prepareEffect(
            store, state, authority, "merge_exact_head", `pr:${state.pullRequest.number}`, headSha,
            { expectedBaseSha: baseSha, pullRequestNumber: state.pullRequest.number, method: input.contract.github.mergeMethod },
          );
          const receipt = await githubAdapter.mergeExactHead({
            lease: mergeEffect.lease,
            number: state.pullRequest.number,
            headSha,
            baseSha,
            method: input.contract.github.mergeMethod,
          });
          state.merge = receipt;
          mergedSha = receipt.mergedSha;
          if (!mergeEffect.alreadyCompleted) {
            if (input.crashAfterEffect === "merge_exact_head") throw new InjectedCrash("merge_exact_head");
            store.completeEffect(mergeEffect.effectId, receipt.disposition === "adopted" ? "adopted" : "applied", { ...receipt }, new Date().toISOString());
            if (input.crashAfterReceipt === "merge_exact_head") throw new InjectedNodeCrash("merge_exact_head receipt");
          }
        } else {
          const delivery = input.contract.delivery;
          checkpoint(store, trace, state, "enqueue_delivery", { headSha, commandId: delivery.enqueueCommandRef });
          const enqueueEffect = await prepareEffect(
            store, state, authority, "enqueue_delivery", `pr:${state.pullRequest.number}`, headSha,
            { commandId: delivery.enqueueCommandRef, pullRequestNumber: state.pullRequest.number },
          );
          if (!enqueueEffect.alreadyCompleted) {
            assertLease(state, enqueueEffect.lease, "enqueue_delivery");
            const enqueue = await registry.execute(
              delivery.enqueueCommandRef,
              deliveryCommandValues(registry.get(delivery.enqueueCommandRef), {
                pullRequestNumber: state.pullRequest.number, expectedHeadSha: headSha, runId,
              }),
              roots,
            );
            commandResults.push(enqueue);
            if (enqueue.exitCode !== 0) throw new ShipperError("project coordinator enqueue failed", 4, [enqueue.stderr || enqueue.stdout]);
            if (input.crashAfterEffect === "enqueue_delivery") throw new InjectedCrash("enqueue_delivery");
            completeEffect(store, enqueueEffect.effectId, { commandId: enqueue.commandId, exitCode: enqueue.exitCode, stdout: enqueue.stdout });
          }
          checkpoint(store, trace, state, "terminal_predicate", { commandId: delivery.terminalPredicateCommandRef });
          let terminalBody: Record<string, unknown> = {};
          let terminalDiagnostic = "";
          let terminalPoll = 0;
          let terminalSatisfied = false;
          while (Date.now() < Date.parse(state.deadlineAt)) {
            const terminal = await registry.execute(
              delivery.terminalPredicateCommandRef,
              deliveryCommandValues(registry.get(delivery.terminalPredicateCommandRef), {
                pullRequestNumber: state.pullRequest.number, expectedHeadSha: headSha, runId,
              }),
              roots,
            );
            commandResults.push(terminal);
            terminalDiagnostic = terminal.stderr || terminal.stdout;
            try { terminalBody = JSON.parse(terminal.stdout) as Record<string, unknown>; } catch { terminalBody = {}; }
            if (terminal.exitCode === 0 && terminalBody.terminal === true
              && /^[0-9a-f]{40,64}$/.test(String(terminalBody.mergedSha ?? ""))) {
              terminalSatisfied = true;
              break;
            }
            if (terminalPoll === 0) githubAdapter.resetObservationBackoff();
            terminalPoll += 1;
            checkpoint(store, trace, state, "terminal_predicate", {
              commandId: delivery.terminalPredicateCommandRef, poll: terminalPoll, waitingFor: "project_coordinator_terminal",
            });
            const readiness = await githubAdapter.waitForNextObservation(state.deadlineAt);
            if (readiness === "exhausted") break;
            if (input.request.workItem.source.kind === "github_issue") {
              const source = await githubAdapter.observeIssueRevision({
                identity: input.request.workItem.source.identity,
                expectedRevision: input.request.workItem.source.revision,
              });
              state.sourceRevision = source;
              if (source.drifted) throw new ShipperError("Work Item source revision drifted during coordinator delivery", 4);
            }
          }
          if (!terminalSatisfied) {
            throw new ShipperError("project coordinator terminal predicate is not satisfied", 4, [terminalDiagnostic]);
          }
          mergedSha = String(terminalBody.mergedSha);
          state.merge = { disposition: "adopted", headSha, baseSha, mergedSha, method: input.contract.github.mergeMethod };
        }

        await proveTerminalAndClose(headSha, mergedSha, true);
        return { refreshed: false };
      } finally {
        store.releaseProjectOperation(state.projectId, runId, mergeClaimToken);
      }
    };

    repairLoop: while (
      !finalizeOnly
      && (state.iteration < input.contract.budgets.maximumIterations || reuseCommittedHead || reusePlannedActions)
    ) {
      if (Date.now() >= Date.parse(state.deadlineAt)) throw new ShipperError("Work Run wall-clock budget exhausted", 3);
      let iterationCommitted = reuseCommittedHead;
      const returnToPlanner = (feedback: Record<string, unknown>): void => {
        const feedbackDigest = digest(feedback);
        if (!iterationCommitted && state.repairFeedbackDigest === feedbackDigest) {
          throw new ShipperError(
            `${build.provider} plan changed nothing and earned the same ${String(feedback.repairReason)} result`, 3,
            ["the previous iteration was returned to the planner with this exact feedback"],
          );
        }
        state.repairFeedbackDigest = feedbackDigest;
        checkpoint(store, trace, state, "plan", feedback);
      };
      let response: Plan;
      if (reuseCommittedHead || reusePlannedActions) {
        if (!state.plan) throw new ShipperError("durable node is missing its schema-valid plan", 3);
        response = state.plan;
      } else {
        state.iteration += 1;
        assertModelSafeContent("Work Item", JSON.stringify(input.request.workItem));
        const plannerInput = {
            workItem: input.request.workItem,
            contractRules: {
              autonomy: input.request.autonomy,
              commands: input.contract.commands.map((command) => ({ id: command.id, argv: command.argv, parameters: command.parameters, sideEffect: command.sideEffect })),
              documentation: input.contract.documentation,
              approvalPolicy: input.contract.approvalPolicy,
            },
            repositoryEvidence: collectRepositoryEvidence(
              input.contract,
              boundWorkspace(),
              input.request.workItem.repositoryContextManifest,
            ),
            feedback: { failures: state.errors, priorFindings },
          };
        const nextResponse = await invokePlanner(plannerInput, state.iteration);
        if (nextResponse.kind !== "plan") throw new ShipperError(`${build.provider} Build Provider returned ${nextResponse.kind}`, 3);
        if (Date.now() >= Date.parse(state.deadlineAt)) throw new ShipperError("Work Run wall-clock budget exhausted during planning", 3);
        response = nextResponse;
        state.preparedFileActions = preparePlanFileActions(response, input.contract, registry, boundWorkspace());
        state.plan = response;
        state.verification = null;
        state.documentation = null;
        state.reviewVerdict = null;
        state.hosted = null;
        state.reviewPublication = null;
        checkpoint(store, trace, state, "act", { summary: response.summary, iteration: state.iteration });
        if (input.crashAtNode === "act" || input.crashAtNode === `act:${state.iteration}`) throw new InjectedNodeCrash(`act:${state.iteration}`);
        drainAtBoundary();
      }
      if (!reuseCommittedHead) {
        reusePlannedActions = false;
        if (!state.preparedFileActions) {
          state.preparedFileActions = preparePlanFileActions(response, input.contract, registry, boundWorkspace());
        }
        for (const [actionIndex, action] of response.actions.entries()) {
          if (action.kind === "write_file" || action.kind === "edit_file") {
            const prepared = state.preparedFileActions.find((candidate) => candidate.actionIndex === actionIndex);
            if (!prepared) throw new ShipperError(`prepared file action is missing: ${action.path}`, 4);
            await writeWorkspaceFile(
              store, state, authority, workspacePath, prepared.path, prepared.content, prepared.precondition,
              input.crashAfterIntent, input.crashAfterEffect,
            );
          } else {
            const command = registry.get(action.commandId);
            assertModelActionAuthorized(input.contract, `run_command:${command.id}`);
            if (command.cwd !== "worktree" || command.sideEffect !== "none" || command.idempotence !== "pure") {
              throw new ShipperError(`${command.id}: model-selected commands must be pure observations in the owned worktree`, 3);
            }
            commandResults.push(await executeGateCommand(registry, action.commandId, roots, boundWorkspace(),
              Object.fromEntries(action.parameters.map((parameter) => [parameter.name, parameter.value])), commandDiagnosticsRoot));
            state.commandResults = commandResults;
          }
        }
        const worktreeOutput = undeclaredWorktreeOutput(boundWorkspace());
        const unattributableOutput = findUnattributableWorktreeOutput(state.preparedFileActions, worktreeOutput);
        if (unattributableOutput.length > 0) {
          throw new ShipperError(
            "act left unattributable worktree output",
            4,
            unattributableOutput.map((finding) => finding.detail),
          );
        }
        const hiddenPlannedPaths = worktreeOutput
          .filter((finding) => finding.kind === "unsafe_ignored")
          .map((finding) => finding.path);
        const mutatedPaths = [...new Set(worktreeOutput.map((finding) => finding.path))];
        if (mutatedPaths.length === 0) {
          if (!state.gatedPlan || digest({ ...state.gatedPlan, actions: [] }) === digest({ ...response, actions: [] })) {
            throw new ShipperError(`${build.provider} plan produced no repository change`, 3);
          }
        } else {
          for (const path of mutatedPaths) {
            registry.assertMutablePath(path);
            safeWorkspaceFile(workspacePath, path);
          }
          const parentSha = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          const desiredCommit = digest({ parentSha, response, mutatedPaths });
          const commitEffect = await prepareEffect(store, state, authority, "commit_create", branch, desiredCommit, { parentSha, branch });
          assertLease(state, commitEffect.lease, "commit_create");
          ownedWorkspaceGit(boundWorkspace(), ["add", "-A", "--"]);
          if (hiddenPlannedPaths.length > 0) {
            ownedWorkspaceGit(boundWorkspace(), ["--literal-pathspecs", "add", "-f", "--", ...hiddenPlannedPaths]);
          }
          ownedWorkspaceGit(boundWorkspace(), [
            ...gitCommitIdentityArgs(input.contract.delivery.commitIdentity),
            "commit", "-m", response.commitMessage, "-m", `Graph-Shipper-Run: ${runId}`,
          ]);
          const committedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
          const trailer = ownedWorkspaceGit(boundWorkspace(), ["log", "-1", "--format=%B"]);
          if (!trailer.includes(`Graph-Shipper-Run: ${runId}`)) throw new ShipperError("commit effect is not attributable to this Work Run", 3);
          if (input.crashAfterEffect === "commit_create") throw new InjectedCrash("commit_create");
          state.headSha = committedHead;
          completeEffect(store, commitEffect.effectId, { headSha: state.headSha, parentSha, branch });
          if (input.crashAfterReceipt === "commit_create") throw new InjectedNodeCrash("commit receipt");
          state.changedFiles = changedFiles(boundWorkspace(), baseSha);
          iterationCommitted = true;
        }
        state.preparedFileActions = null;
        checkpoint(store, trace, state, "verify", { headSha: state.headSha, changedFiles: state.changedFiles });
        if (input.crashAtNode === "verify") throw new InjectedNodeCrash("verify");
        drainAtBoundary();
      }
      reuseCommittedHead = false;
      state.gatedPlan = response;
      if (!state.headSha) throw new ShipperError("verification node has no committed head", 3);

      const checks: Array<Record<string, unknown>> = [];
      for (const check of input.contract.verification.checks) {
        const triggeredByDiff = state.changedFiles.some((file) => check.triggerGlobs.some((glob) => globMatches(glob, file)));
        if (check.cadence !== "every_cycle" && !triggeredByDiff) continue;
        if (check.executor.kind !== "command") throw new ShipperError(`${check.id}: unsupported builtin verifier`, 3);
        const result = await executeGateCommand(registry, check.executor.commandRef, roots, boundWorkspace(), {}, commandDiagnosticsRoot);
        drainAtBoundary();
        const resultEvidence = { id: check.id, commandId: result.commandId, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        checks.push(resultEvidence);
        if (result.exitCode !== 0) {
          if (check.failureClass !== "planner_feedback") throw new ShipperError(`deterministic verification failed: ${check.id}`, 3, [result.stderr || result.stdout]);
          state.errors.push(`verification:${check.id}:${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
          returnToPlanner({ repairReason: "deterministic_verification", failingHeadSha: state.headSha, check: resultEvidence });
          continue repairLoop;
        }
      }
      verificationEvidence = { headSha: state.headSha, checks, evidenceDigest: digest({ headSha: state.headSha, checks }) };
      state.verification = verificationEvidence;
      checkpoint(store, trace, state, "documentation", { headSha: state.headSha });
      try {
        documentationEvidence = await documentationGate(
          input.contract, input.contractDigest, input.request.workItem.source.revision, input.request.workItem.documentationAuthority,
          response, boundWorkspace(), baseSha, state.headSha, state.changedFiles, registry, roots, verificationEvidence,
        );
        drainAtBoundary();
      } catch (error) {
        if (!(error instanceof ShipperError) || error.message !== "Documentation Freshness Gate failed") throw error;
        state.errors.push(...error.details.map((detail) => `documentation:${detail}`));
        returnToPlanner({ repairReason: "documentation", failingHeadSha: state.headSha, details: error.details });
        continue;
      }
      state.documentation = documentationEvidence;

      if (!reusePreparedReviewAttempt) state.reviewAttempt += 1;
      reusePreparedReviewAttempt = false;
      assertModelSafeContent("Work Item", JSON.stringify(input.request.workItem));
      const unauthorizedReviewPaths = state.changedFiles.filter((path) => !modelContextPathAllowed(input.contract, path));
      if (unauthorizedReviewPaths.length > 0) {
        throw new ShipperError("changed files fall outside the approved model context", 4, unauthorizedReviewPaths);
      }
      const trackedReviewPaths = ownedWorkspaceGitRaw(boundWorkspace(), ["ls-files", "-z", "--"])
        .split("\0")
        .filter(Boolean);
      const canonicalDocumentationPaths = trackedReviewPaths.filter((path) => (
        modelContextPathAllowed(input.contract, path)
        && input.contract.documentation.rules.some((rule) => rule.class === "living" && globMatches(rule.glob, path))
      ));
      const reviewContextPaths = [...new Set([
        ...state.changedFiles.filter((path) => trackedReviewPaths.includes(path)),
        ...canonicalDocumentationPaths,
      ])];
      const repositoryContext = collectRepositoryEvidence(
        input.contract,
        boundWorkspace(),
        { paths: reviewContextPaths },
      );
      const changedFileContext = state.changedFiles.map((path) => ({
        path,
        content: repositoryContext.entries.find((entry) => entry.path === path)?.content ?? null,
      }));
      const documentationContext = repositoryContext.entries.filter((entry) => input.contract.documentation.rules.some(
        (rule) => rule.class === "living" && globMatches(rule.glob, entry.path),
      ));
      const findingDispositions = state.findingDispositions.map((disposition) => ({ ...disposition, repairHeadSha: state.headSha }));
      const reviewDiff = ownedWorkspaceGit(boundWorkspace(), ["diff", "--no-ext-diff", `${baseSha}..${state.headSha}`, "--", ...state.changedFiles]);
      assertModelSafeContent("review diff", reviewDiff);
      const reviewBundle = {
        workItem: input.request.workItem,
        contractDigest: input.contractDigest,
        relevantContractRules: {
          autonomy: input.contract.autonomy,
          approvalPolicy: input.contract.approvalPolicy,
          verification: input.contract.verification,
          documentation: input.contract.documentation,
          workspace: input.contract.workspace,
        },
        baseSha,
        headSha: state.headSha,
        diff: reviewDiff,
        changedFiles: state.changedFiles,
        fileActions: response.actions.flatMap((action) => (action.kind === "run_command" ? [] : [{ kind: action.kind, path: action.path }])),
        changedFileContext,
        impactedCanonicalDocumentation: documentationContext,
        contextCollection: {
          truncated: repositoryContext.truncated,
          byteLimit: repositoryContext.byteLimit,
          omittedPaths: repositoryContext.omittedPaths,
        },
        verification: verificationEvidence,
        documentation: documentationEvidence,
        priorFindings,
        findingDispositions,
      };
      state.reviewBundle = reviewBundle;
      checkpoint(store, trace, state, "independent_review", { headSha: state.headSha, reviewBundleDigest: digest(reviewBundle) });
      if (input.crashAtNode === "independent_review") throw new InjectedNodeCrash("independent_review");
      let reviewResponse: ReviewResponse;
      if (Date.now() >= Date.parse(state.deadlineAt)) throw new ShipperError("Work Run wall-clock budget exhausted before independent review", 3);
      reviewResponse = await invokeReviewer({ reviewBundle }, state.reviewAttempt);
      if (Date.now() >= Date.parse(state.deadlineAt)) throw new ShipperError("Work Run wall-clock budget exhausted during independent review", 3);
      const reviewBundleDigest = digest(reviewBundle);
      reviewVerdict = {
        ...reviewResponse,
        provider: review.provider,
        buildProvider: build.provider,
        workItemRevision: input.request.workItem.source.revision,
        contractDigest: input.contractDigest,
        baseSha,
        headSha: state.headSha,
        verificationEvidenceDigest: verificationEvidence.evidenceDigest,
        documentationEvidenceDigest: documentationEvidence.evidenceDigest,
        reviewBundleDigest,
        modelRuntimeIdentity: currentModelRuntimeIdentity(),
      };
      if (reviewResponse.verdict === "approve") {
        state.reviewVerdict = reviewVerdict;
        if (input.request.autonomy !== "local_only") {
          const hosted = await deliverOpenPr(state.headSha);
          if (hosted.headDrift) throw new ShipperError("pull request head drifted from Work Run authority", 4);
          if (hosted.hostedChecksGreen && hostedApprovalSatisfied(hosted) && hosted.trustedFeedback.length === 0) {
            if (input.request.autonomy === "merge_when_green") {
              const delivery = await deliverMergeTerminal(state.headSha);
              if (delivery.refreshed) {
                verificationEvidence = null;
                documentationEvidence = null;
                reviewVerdict = null;
                reuseCommittedHead = true;
                continue repairLoop;
              }
            }
            break;
          }
          const failedChecks = hosted.requiredChecks.filter((check) => check.status !== "completed" || check.conclusion !== "success");
          state.errors.push(...failedChecks.map((check) => `hosted_check:${check.name}:${check.status}:${check.conclusion ?? "pending"}`));
          state.errors.push(...hosted.trustedFeedback.map((feedback) => `hosted_feedback:${feedback.actor}:${feedback.body}`));
          if (hosted.trustedFeedback.length === 0 && failedChecks.length === 0) {
            throw new ShipperError("hosted evidence lacks an exact-head trusted approval", 3);
          }
          state.verification = null;
          state.documentation = null;
          state.reviewVerdict = null;
          returnToPlanner({
            repairReason: "hosted_feedback",
            failingHeadSha: state.headSha,
            failedChecks: failedChecks.map((check) => check.name),
            trustedFeedbackIds: hosted.trustedFeedback.map((feedback) => feedback.id),
          });
          continue repairLoop;
        }
        break;
      }
      const blocking = reviewResponse.findings.filter((finding) => finding.severity === "blocking");
      if (reviewResponse.verdict === "blocked" || blocking.some((finding) => finding.scopeRelation === "scope_changing")) {
        throw new ShipperError(`independent review returned ${reviewResponse.verdict}`, 3, reviewResponse.findings.map((finding) => `${finding.id}: ${finding.requiredAction}`));
      }
      priorFindings.splice(0, priorFindings.length, ...blocking);
      state.priorFindings = priorFindings;
      state.findingDispositions = blocking.map((finding) => ({
        findingId: finding.id,
        failingHeadSha: state.headSha,
        disposition: `returned_to_${build.provider}_builder_for_in_scope_repair`,
      }));
      returnToPlanner({ repairReason: "independent_review", failingHeadSha: state.headSha, findings: blocking });
    }
    if (!state.headSha || !verificationEvidence || !documentationEvidence || !reviewVerdict || reviewVerdict.verdict !== "approve") {
      throw new ShipperError(`Work Run iteration budget exhausted after ${state.iteration} attempt(s)`, 3);
    }
    const finalHeadSha = state.headSha;
    state.reviewVerdict = reviewVerdict;
    checkpoint(store, trace, state, "finalize", { headSha: state.headSha, verdict: "approve" });
    if (input.request.autonomy !== "local_only"
      && (!state.hosted || state.hosted.headSha !== finalHeadSha
        || !state.hosted.hostedChecksGreen || !hostedApprovalSatisfied(state.hosted))) {
      const hosted = await deliverOpenPr(finalHeadSha);
      if (hosted.headDrift) throw new ShipperError("pull request head drifted from Work Run authority", 4);
      if (!hosted.hostedChecksGreen || !hostedApprovalSatisfied(hosted)) {
        throw new ShipperError("hosted evidence is not yet green and exactly reviewed", 3);
      }
    }
    if (input.request.autonomy === "merge_when_green" && !state.terminal) {
      const delivery = await deliverMergeTerminal(finalHeadSha);
      if (delivery.refreshed) throw new ShipperError("base advancement invalidated final evidence; resume from verification", 3);
    }
    if (input.request.autonomy === "merge_when_green") {
      if (!state.terminal || state.terminal.satisfied !== true) throw new ShipperError("delivery terminal predicate is not satisfied", 4);
      checkpoint(store, trace, state, "cleanup", { branch, workspacePath });
      const ownedTempPath = join(input.dataRoot, "tmp", runId);
      const workspaceExists = existsSync(workspacePath);
      let cleanupUndeclaredOutput = { findings: [] as string[], totalCount: 0 };
      if (workspaceExists) {
        if (!isRegisteredOwnedWorktree(input.projectRoot, boundWorkspace())) {
          throw new ShipperError("cleanup refused an unowned or unregistered worktree", 4, [workspacePath]);
        }
        const observedBranch = ownedWorkspaceGit(boundWorkspace(), ["branch", "--show-current"]);
        const observedHead = ownedWorkspaceGit(boundWorkspace(), ["rev-parse", "HEAD"]);
        const worktreeOutput = undeclaredWorktreeOutput(boundWorkspace());
        const visibleOutput = worktreeOutput.filter((finding) => finding.kind === "visible");
        cleanupUndeclaredOutput = boundWorktreeOutputFindings(
          worktreeOutput
            .filter((finding) => finding.kind === "unsafe_ignored")
            .map((finding) => finding.detail),
        );
        if (observedBranch !== branch || observedHead !== finalHeadSha || visibleOutput.length > 0) {
          throw new ShipperError("cleanup refused a drifted owned worktree", 4, [
            observedBranch,
            observedHead,
            ...worktreeOutput.map((finding) => finding.detail),
          ]);
        }
      }
      const cleanupEffect = await prepareEffect(
        store, state, authority, "cleanup_owned_resources", runId,
        digest({ branch, workspacePath, ownedTempPath, policy: input.contract.cleanup, ...cleanupUndeclaredOutput }),
        {
          undeclaredWorktreeOutput: cleanupUndeclaredOutput.findings,
          undeclaredWorktreeOutputCount: cleanupUndeclaredOutput.totalCount,
        },
      );
      if (input.crashAfterIntent === "cleanup_owned_resources") throw new InjectedIntentCrash("cleanup_owned_resources");
      if (!cleanupEffect.alreadyCompleted) {
        assertLease(state, cleanupEffect.lease, "cleanup_owned_resources");
        if (workspaceExists && input.contract.cleanup.removeOwnedWorktreeAfterDeliveryTerminalSuccess) {
          git(input.projectRoot, ["worktree", "remove", workspacePath]);
        }
        if (input.contract.cleanup.removeOwnedBranchAfterDeliveryTerminalSuccess) {
          const branchHead = git(input.projectRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
          if (branchHead !== finalHeadSha) throw new ShipperError("cleanup refused a branch whose exact head is no longer owned", 4);
          git(input.projectRoot, ["branch", "-D", branch]);
        }
        reclaimOwnedTempRoot(ownedTempPath, input.dataRoot);
        if (input.crashAfterEffect === "cleanup_owned_resources") throw new InjectedCrash("cleanup_owned_resources");
        state.cleanup = {
          worktreeRemoved: input.contract.cleanup.removeOwnedWorktreeAfterDeliveryTerminalSuccess,
          branchRemoved: input.contract.cleanup.removeOwnedBranchAfterDeliveryTerminalSuccess,
          temporaryArtifactsRemoved: [ownedTempPath],
          workspacePath,
          branch,
          undeclaredWorktreeOutput: cleanupUndeclaredOutput.findings,
          undeclaredWorktreeOutputCount: cleanupUndeclaredOutput.totalCount,
        };
        completeEffect(store, cleanupEffect.effectId, { ...state.cleanup });
      }
    } else {
      const ownedTempPath = join(input.dataRoot, "tmp", runId);
      reclaimOwnedTempRoot(ownedTempPath, input.dataRoot);
      state.cleanup = {
        worktreeRemoved: false, branchRemoved: false,
        temporaryArtifactsRemoved: [ownedTempPath], workspacePath, branch,
      };
    }
    const evidence = {
      evidenceVersion: 1,
      runId,
      projectId: state.projectId,
      autonomy,
      buildProvider: build.provider,
      reviewProvider: review.provider,
      modelRuntimeIdentity: currentModelRuntimeIdentity(),
      modelFailures: normalizedModelFailures(),
      adapterBinding: state.adapterBinding,
      baseSha,
      headSha: finalHeadSha,
      branch,
      workspacePath,
      workItem: input.request.workItem,
      changedFiles: state.changedFiles,
      commandResults,
      verification: verificationEvidence,
      documentation: documentationEvidence,
      reviewVerdict,
      ...(state.pullRequest ? { pullRequest: state.pullRequest } : {}),
      ...(state.hosted ? { hosted: state.hosted } : {}),
      ...(state.sourceRevision ? { sourceRevision: state.sourceRevision } : {}),
      ...(state.reviewPublication ? { reviewPublication: state.reviewPublication } : {}),
      ...(state.mergeGuard ? { mergeGuard: state.mergeGuard } : {}),
      ...(state.merge ? { merge: state.merge } : {}),
      ...(state.postMerge ? { postMerge: state.postMerge } : {}),
      ...(state.terminal ? { terminal: state.terminal } : {}),
      ...(state.sourceClosure ? { sourceClosure: state.sourceClosure } : {}),
      ...(state.cleanup ? { cleanup: state.cleanup } : {}),
      reviewBundle: state.reviewBundle,
      cleanupDisposition: input.request.autonomy === "local_only"
        ? input.contract.cleanup.onLocalOnlyHandoff
        : input.request.autonomy === "open_pr"
          ? "preserve_until_delivery_terminal"
          : "delivery_terminal_cleanup_complete",
      cleanupPolicy: input.contract.cleanup,
    };
    const evidencePath = writeEvidence(input.dataRoot, runId, evidence, redactor);
    if (input.crashAfterEffect === "evidence_publish") throw new InjectedCrash("evidence_publish");
    state.status = "completed";
    checkpoint(store, trace, state, "completed", { headSha: state.headSha, verdict: "approve", evidencePath });
    return {
      ok: true,
      runId,
      projectId: state.projectId,
      status: state.status,
      phase: state.phase,
      autonomy,
      buildProvider: build.provider,
      reviewProvider: review.provider,
      baseSha,
      headSha: finalHeadSha,
      branch,
      workspacePath,
      verification: verificationEvidence,
      documentation: documentationEvidence,
      reviewVerdict,
      modelRuntimeIdentity: currentModelRuntimeIdentity(),
      modelFailures: normalizedModelFailures(),
      evidencePath,
      iterations: state.iteration,
      reviewAttempts: state.reviewAttempt,
      ...(state.pullRequest ? { pullRequest: state.pullRequest } : {}),
      ...(state.hosted ? { hosted: state.hosted } : {}),
      ...(state.reviewPublication ? { reviewPublication: state.reviewPublication } : {}),
      ...(input.request.autonomy === "merge_when_green" ? {
        delivery: {
          strategy: input.contract.delivery.strategy,
          reviewPublication: state.reviewPublication,
          mergeGuard: state.mergeGuard,
          merge: state.merge,
          postMerge: state.postMerge,
          terminal: state.terminal,
          sourceClosure: state.sourceClosure,
          cleanup: state.cleanup,
        },
      } : {}),
    };
  } catch (error) {
    if (error instanceof InjectedCrash || error instanceof InjectedIntentCrash || error instanceof InjectedNodeCrash) throw error;
    if (!resumeAccepted) throw error;
    if (error instanceof DrainAtBoundary) {
      state.status = "paused";
      checkpoint(store, trace, state, state.phase, { reason: "graceful_drain" });
      return {
        ok: true,
        runId,
        projectId: state.projectId,
        status: "paused",
        phase: state.phase,
        autonomy,
        baseSha,
        headSha: state.headSha,
        branch,
        workspacePath: state.workspacePath,
        reason: "graceful_drain",
      };
    }
    state.status = "escalated";
    const durableError = error instanceof ModelAdapterError
      ? `model:${error.kind}`
      : error instanceof Error ? error.message : String(error);
    state.errors.push(durableError);
    if (error instanceof ModelAdapterError) {
      state.errors.push(...error.durableDetails.map((detail) => `model:${detail}`));
    }
    if (store.workRun(runId)) {
      checkpoint(store, trace, state, "escalated", {
        error: durableError,
        ...(error instanceof ModelAdapterError && error.durableDetails.length > 0
          ? { details: error.durableDetails }
          : {}),
      });
    }
    throw error;
  } finally {
    process.off("SIGINT", requestDrain);
    process.off("SIGTERM", requestDrain);
    store.releaseWorkRunClaim(runId, claimToken);
    store.close();
  }
}
