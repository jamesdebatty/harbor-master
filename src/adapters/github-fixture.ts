import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ShipperError } from "../errors.js";
import { SAFE_GIT_CONFIG, safeGitEnvironment } from "../runtime/git-safety.js";
import type {
  GitHubPushReceipt,
  GitHubTransport,
  GitHubTransportRequest,
  GitHubTransportResponse,
} from "./github.js";

const ShaOrHead = z.string().refine((value) => value === "$HEAD" || /^[0-9a-f]{40,64}$/.test(value));
const FixtureSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  pullRequestNumber: z.number().int().positive(),
  remoteBranchHead: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  baseBranchHead: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  branchProtected: z.boolean().default(true),
  protectionRequiredChecks: z.array(z.string().min(1)).default([]),
  requiredApprovalCount: z.number().int().nonnegative().default(1),
  observationDelayMilliseconds: z.number().int().nonnegative().max(5_000).default(0),
  mergedCommitSource: z.string().min(1).optional(),
  mergedSha: ShaOrHead.optional(),
  issue: z.union([
    z.object({ number: z.number().int().positive(), revision: z.string().min(1) }).strict(),
    z.object({ number: z.number().int().positive(), revisions: z.array(z.string().min(1)).min(1) }).strict(),
  ]).optional(),
  observations: z.array(z.object({
    pullRequestHeadSha: ShaOrHead.optional(),
    checks: z.array(z.object({
      name: z.string().min(1), status: z.string().min(1), conclusion: z.string().nullable(),
      headSha: ShaOrHead, producer: z.string(), statusActor: z.string().min(1).optional(),
    }).strict()),
    reviews: z.array(z.object({
      id: z.number().int().positive(), state: z.string(), commitId: ShaOrHead,
      body: z.string(), actor: z.string(),
    }).strict()),
    reviewComments: z.array(z.object({
      id: z.number().int().positive(), commitId: ShaOrHead, body: z.string(), actor: z.string(),
    }).strict()).default([]),
    comments: z.array(z.object({
      id: z.number().int().positive(), body: z.string(), actor: z.string(),
    }).strict()),
  }).strict()).min(1),
}).strict();

type Fixture = z.infer<typeof FixtureSchema>;
const FIXTURE_OPERATOR_ACTOR = "operator";
interface FixtureState {
  remoteBranchHead: string | null;
  pullRequest: Record<string, unknown> | null;
  observationIndex: number;
  issueObservationIndex: number;
  publishedComments: Array<Record<string, unknown>>;
  mergedSha: string | null;
  issueClosed: boolean;
  events: Array<Record<string, unknown>>;
}

export class RecordedGitHubTransport implements GitHubTransport {
  readonly fixtureDigest: string;
  readonly #fixture: Fixture;
  readonly #statePath: string;
  readonly #fixtureDirectory: string;

  constructor(pathInput: string, statePathInput: string) {
    const path = resolve(pathInput);
    this.#fixtureDirectory = dirname(path);
    let source: string;
    try { source = readFileSync(path, "utf8"); } catch (error) {
      throw new ShipperError(`cannot read GitHub fixture: ${error instanceof Error ? error.message : String(error)}`, 3);
    }
    let raw: unknown;
    try { raw = JSON.parse(source); } catch {
      throw new ShipperError("GitHub fixture is not valid JSON", 3);
    }
    const parsed = FixtureSchema.safeParse(raw);
    if (!parsed.success) throw new ShipperError("GitHub fixture is invalid", 3, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    this.#fixture = parsed.data;
    this.fixtureDigest = createHash("sha256").update(source).digest("hex");
    this.#statePath = resolve(statePathInput);
    mkdirSync(dirname(this.#statePath), { recursive: true, mode: 0o700 });
    if (existsSync(this.#statePath)) {
      const stateStat = lstatSync(this.#statePath);
      if (!stateStat.isFile() || stateStat.isSymbolicLink()) {
        throw new ShipperError("GitHub fixture state must be a regular non-symlink file", 3);
      }
    }
    if (!existsSync(this.#statePath)) this.#writeState({
      remoteBranchHead: this.#fixture.remoteBranchHead,
      pullRequest: null,
      observationIndex: 0,
      issueObservationIndex: 0,
      publishedComments: [],
      mergedSha: null,
      issueClosed: false,
      events: [],
    });
  }

  async pushBranch(request: Parameters<NonNullable<GitHubTransport["pushBranch"]>>[0]): Promise<GitHubPushReceipt> {
    const state = this.#state();
    if (state.remoteBranchHead === request.headSha) {
      return { remoteHeadBefore: request.headSha, remoteHeadAfter: request.headSha };
    }
    if (state.remoteBranchHead !== request.expectedRemoteHeadSha) {
      throw new ShipperError("recorded GitHub branch head drifted before push", 4);
    }
    const receipt = { remoteHeadBefore: state.remoteBranchHead, remoteHeadAfter: request.headSha };
    state.remoteBranchHead = request.headSha;
    if (state.pullRequest) {
      const pullHead = state.pullRequest.head as Record<string, unknown>;
      if (pullHead.ref === request.branch) pullHead.sha = request.headSha;
    }
    state.events.push({ kind: "push_branch", ...request });
    this.#writeState(state);
    return receipt;
  }

  async fetchCommit(request: { ref: string; workspacePath: string }): Promise<void> {
    if (!this.#fixture.mergedCommitSource) return;
    const result = spawnSync("git", [
      ...SAFE_GIT_CONFIG, "fetch", "--no-tags", resolve(this.#fixtureDirectory, this.#fixture.mergedCommitSource), `refs/heads/${request.ref}`,
    ], { cwd: request.workspacePath, encoding: "utf8", env: safeGitEnvironment(request.workspacePath), stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new ShipperError("recorded GitHub commit fetch failed", 4, [(result.stderr ?? "").trim()]);
  }

  async waitForNextObservation(_deadlineAt: string): Promise<"ready" | "exhausted"> {
    const state = this.#state();
    const ready = state.observationIndex < this.#fixture.observations.length;
    state.events.push({ kind: "wait_for_observation", result: ready ? "ready" : "exhausted" });
    this.#writeState(state);
    if (ready && this.#fixture.observationDelayMilliseconds > 0) await delay(this.#fixture.observationDelayMilliseconds);
    return ready ? "ready" : "exhausted";
  }

  async request(rawRequest: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    const queryIndex = rawRequest.path.indexOf("?");
    const query = queryIndex === -1 ? "" : rawRequest.path.slice(queryIndex + 1);
    const request: GitHubTransportRequest = {
      ...rawRequest,
      path: queryIndex === -1 ? rawRequest.path : rawRequest.path.slice(0, queryIndex),
    };
    const state = this.#state();
    state.events.push({
      kind: "request", method: request.method, path: rawRequest.path, body: request.body ?? null,
      purpose: rawRequest.purpose ?? null,
    });
    if (request.method === "GET" && request.path.endsWith("/pulls") && query.includes("head=")) {
      this.#writeState(state);
      return { status: 200, body: state.pullRequest ? [state.pullRequest] : [] };
    }
    if (request.method === "GET" && /\/issues\/\d+$/.test(request.path) && this.#fixture.issue) {
      const revisions = "revisions" in this.#fixture.issue ? this.#fixture.issue.revisions : [this.#fixture.issue.revision];
      const revision = revisions[Math.min(state.issueObservationIndex ?? 0, revisions.length - 1)];
      state.issueObservationIndex = (state.issueObservationIndex ?? 0) + 1;
      this.#writeState(state);
      return {
        status: 200,
        body: { number: this.#fixture.issue.number, updated_at: revision, state: state.issueClosed ? "closed" : "open" },
      };
    }
    if (request.method === "PATCH" && /\/issues\/\d+$/.test(request.path) && this.#fixture.issue) {
      state.issueClosed = request.body?.state === "closed";
      this.#writeState(state);
      return { status: 200, body: { number: this.#fixture.issue.number, state: state.issueClosed ? "closed" : "open" } };
    }
    if (request.method === "GET" && request.path === "/user") {
      this.#writeState(state);
      return { status: 200, body: { login: FIXTURE_OPERATOR_ACTOR } };
    }
    if (request.method === "POST" && request.path.endsWith("/pulls")) {
      if (state.pullRequest) return { status: 422, body: { message: "already exists" } };
      const body = request.body ?? {};
      state.pullRequest = {
        number: this.#fixture.pullRequestNumber,
        html_url: `https://github.com/fixture/project/pull/${this.#fixture.pullRequestNumber}`,
        draft: false,
        state: "open",
        head: { ref: body.head, sha: state.remoteBranchHead },
        base: { ref: body.base },
        title: body.title,
        body: body.body,
      };
      this.#writeState(state);
      return { status: 201, body: state.pullRequest };
    }
    if (!state.pullRequest) return { status: 404, body: null };
    const observation = this.#fixture.observations[Math.min(state.observationIndex, this.#fixture.observations.length - 1)];
    const head = String((state.pullRequest.head as Record<string, unknown>).sha);
    const exact = (value: string): string => value === "$HEAD" ? head : value;
    if (request.method === "GET" && /\/pulls\/\d+$/.test(request.path)) {
      this.#writeState(state);
      const pull = structuredClone(state.pullRequest);
      (pull.base as Record<string, unknown>).sha = this.#fixture.baseBranchHead ?? head;
      pull.mergeable = true;
      if (observation?.pullRequestHeadSha) (pull.head as Record<string, unknown>).sha = exact(observation.pullRequestHeadSha);
      return { status: 200, body: pull };
    }
    if (request.method === "GET" && request.path.endsWith("/branches/main/protection")) {
      this.#writeState(state);
      if (!this.#fixture.branchProtected) return { status: 404, body: null };
      return { status: 200, body: {
        required_status_checks: {
          strict: true,
          contexts: this.#fixture.protectionRequiredChecks,
          checks: this.#fixture.protectionRequiredChecks.map((context) => ({ context, app_id: 1 })),
        },
        required_pull_request_reviews: { required_approving_review_count: this.#fixture.requiredApprovalCount },
      } };
    }
    if (request.path.endsWith("/merge") && request.method === "GET") {
      this.#writeState(state);
      return state.mergedSha ? { status: 204, body: null } : { status: 404, body: null };
    }
    if (request.path.endsWith("/merge") && request.method === "PUT") {
      if (request.body?.sha !== head) return { status: 409, body: { merged: false } };
      state.mergedSha = this.#fixture.mergedSha ? exact(this.#fixture.mergedSha) : head;
      state.pullRequest.state = "closed";
      state.pullRequest.merged = true;
      state.pullRequest.merge_commit_sha = state.mergedSha;
      this.#writeState(state);
      return { status: 200, body: { merged: true, sha: state.mergedSha } };
    }
    if (request.method === "GET" && request.path.includes("/check-runs")) {
      this.#writeState(state);
      return { status: 200, body: { check_runs: observation!.checks.map((check) => ({
        name: check.name, status: check.status, conclusion: check.conclusion,
        head_sha: exact(check.headSha), app: { slug: check.producer },
      })) } };
    }
    if (request.method === "GET" && /\/commits\/[^/]+\/statuses$/.test(request.path)) {
      this.#writeState(state);
      return { status: 200, body: observation!.checks.map((check) => ({
        context: check.name,
        state: check.status !== "completed"
          ? "pending"
          : check.conclusion === "success" ? "success" : check.conclusion === "failure" ? "failure" : "error",
        sha: exact(check.headSha),
        creator: { login: check.statusActor ?? check.producer },
      })) };
    }
    if (request.method === "GET" && request.path.endsWith("/reviews")) {
      this.#writeState(state);
      return { status: 200, body: observation!.reviews.map((review) => ({
        id: review.id, state: review.state, commit_id: exact(review.commitId), body: review.body,
        user: { login: review.actor },
      })) };
    }
    if (request.method === "GET" && /\/pulls\/\d+\/comments$/.test(request.path)) {
      this.#writeState(state);
      return { status: 200, body: observation!.reviewComments.map((comment) => ({
        id: comment.id, commit_id: exact(comment.commitId), body: comment.body.replaceAll("$HEAD", head),
        user: { login: comment.actor },
      })) };
    }
    if (request.method === "GET" && /\/issues\/\d+\/comments$/.test(request.path)) {
      if (rawRequest.purpose !== "review_publication") state.observationIndex += 1;
      this.#writeState(state);
      return { status: 200, body: [...observation!.comments.map((comment) => ({
        id: comment.id, body: comment.body.replaceAll("$HEAD", head), user: { login: comment.actor },
      })), ...state.publishedComments] };
    }
    if (request.method === "POST" && /\/issues\/\d+\/comments$/.test(request.path)) {
      const comment = {
        id: 10_000 + state.publishedComments.length,
        body: request.body?.body,
        user: { login: FIXTURE_OPERATOR_ACTOR },
      };
      state.publishedComments.push(comment);
      this.#writeState(state);
      return { status: 201, body: comment };
    }
    this.#writeState(state);
    return { status: 404, body: null };
  }

  #state(): FixtureState {
    try {
      const state = JSON.parse(readFileSync(this.#statePath, "utf8")) as FixtureState;
      state.publishedComments ??= [];
      state.mergedSha ??= null;
      state.issueClosed ??= false;
      return state;
    } catch {
      throw new ShipperError("recorded GitHub fixture state is unavailable", 3);
    }
  }

  #writeState(state: FixtureState): void {
    writeFileSync(this.#statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}
