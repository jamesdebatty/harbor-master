import type { AuthorityLease } from "../brokers/ports.js";
import { ShipperError } from "../errors.js";
import { setTimeout as delay } from "node:timers/promises";

export interface GitHubTransportRequest {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body?: Record<string, unknown>;
  purpose?: "review_publication";
}

export interface GitHubTransportResponse {
  status: number;
  body: unknown;
  /**
   * The forge's pagination header. A transport that can serve a partial list must
   * populate it; one that answers every list completely in a single body may omit it,
   * because nothing else cross-checks a list read for completeness.
   */
  headers?: { link?: string };
}

export type RequiredCheckSource = "check_runs" | "commit_statuses";

export interface GitHubPushRequest {
  repository: string;
  branch: string;
  headSha: string;
  expectedRemoteHeadSha: string | null;
  workspacePath: string;
  gitDirectory: string;
}

export interface GitHubPushReceipt {
  remoteHeadBefore: string | null;
  remoteHeadAfter: string;
}

export interface GitHubFetchRequest {
  repository: string;
  ref: string;
  commitSha: string;
  workspacePath: string;
}

export interface GitHubTransport {
  request(request: GitHubTransportRequest): Promise<GitHubTransportResponse>;
  pushBranch?(request: GitHubPushRequest): Promise<GitHubPushReceipt>;
  waitForNextObservation?(deadlineAt: string): Promise<"ready" | "exhausted">;
  resetObservationBackoff?(): void;
  fetchCommit?(request: GitHubFetchRequest): Promise<void>;
}

export interface PullRequestReceipt {
  disposition: "created" | "updated" | "adopted";
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
}

export interface PullRequestObservation {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
  headDrift: boolean;
  hostedChecksGreen: boolean;
  reviewApproved: boolean;
  providerApprovalPublished: boolean;
  approvedReviewCount: number;
  requiredChecks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    producer: string;
    headSha: string;
  }>;
  trustedFeedback: Array<{ id: number; actor: string; body: string }>;
  ignoredFeedbackCount: number;
}

export interface IssueRevisionObservation {
  identity: string;
  expectedRevision: string;
  observedRevision: string;
  drifted: boolean;
}

export interface ReviewPublicationReceipt {
  disposition: "published" | "adopted";
  commentId: number;
  headSha: string;
  reviewProvider: "anthropic" | "openai";
  runId: string;
  reviewBundleDigest: string;
}

export interface MergeGuardObservation {
  eligible: boolean;
  branchProtected: boolean;
  strictStatusChecks: boolean;
  baseSha: string;
  baseDrift: boolean;
  headDrift: boolean;
  mergeable: boolean;
  hostedChecksGreen: boolean;
  reviewApproved: boolean;
  protectionRequiredChecks: string[];
  requiredApprovalCount: number;
}

export interface MergeReceipt {
  disposition: "merged" | "adopted";
  headSha: string;
  baseSha: string;
  mergedSha: string;
  method: "merge" | "squash" | "rebase";
}

export interface SourceClosureReceipt {
  disposition: "closed" | "adopted";
  identity: string;
  terminalSha: string;
}

interface PullRequestRecord {
  number: number;
  html_url: string;
  draft: boolean;
  state: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha?: string };
  title: string;
  body: string;
}

function pullRequestRecord(value: unknown): PullRequestRecord {
  if (typeof value !== "object" || value === null) throw new ShipperError("GitHub returned an invalid pull request", 4);
  const record = value as Partial<PullRequestRecord>;
  if (!Number.isSafeInteger(record.number)
    || typeof record.html_url !== "string"
    || record.draft !== false
    || record.state !== "open"
    || typeof record.head?.ref !== "string"
    || typeof record.head.sha !== "string"
    || typeof record.base?.ref !== "string"
    || typeof record.title !== "string"
    || typeof record.body !== "string") {
    throw new ShipperError("GitHub returned an invalid normal pull request", 4);
  }
  return record as PullRequestRecord;
}

function assertLease(lease: AuthorityLease, repository: string, operation: AuthorityLease["operation"], expectedHeadSha: string): void {
  const autonomyAllowed = operation === "push_branch" || operation === "upsert_pull_request" || operation === "publish_review_verdict"
    ? lease.autonomy === "open_pr" || lease.autonomy === "merge_when_green"
    : lease.autonomy === "merge_when_green";
  if (lease.repository !== repository
    || lease.operation !== operation
    || !autonomyAllowed
    || lease.expectedHeadSha !== expectedHeadSha
    || Date.parse(lease.expiresAt) <= Date.now()) {
    throw new ShipperError(`GitHub Adapter rejected ${operation} authority`, 4);
  }
}

function reviewPublicationBody(input: {
  headSha: string;
  runId: string;
  reviewProvider: "anthropic" | "openai";
  reviewBundleDigest: string;
}): string {
  return [
    "## VERDICT: APPROVE",
    "",
    `Graph-Shipper-Run: ${input.runId}`,
    `Head: ${input.headSha}`,
    `Review-Provider: ${input.reviewProvider}`,
    `Review-Bundle-Digest: ${input.reviewBundleDigest}`,
  ].join("\n");
}

/** GitHub lists default to 30 entries; a silently truncated list is unusable as exact-head evidence. */
const PAGE_SIZE = 100;
const MAXIMUM_PAGES = 10;

function paged(path: string, page: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}per_page=${PAGE_SIZE}${page > 1 ? `&page=${page}` : ""}`;
}

/**
 * True when the forge advertises a further page of the same list. The link target is
 * discarded before matching, since GitHub echoes the request query into it and a branch
 * name is not allowed to decide whether another page exists.
 */
function hasNextPage(response: GitHubTransportResponse): boolean {
  const link = response.headers?.link;
  if (!link) return false;
  return link.split(/,\s*(?=<)/).some((entry) => {
    const close = entry.indexOf(">");
    if (close === -1) return false;
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^";,\s]*))/i.exec(entry.slice(close + 1));
    // RFC 8288 makes the parameter name and the relation type case-insensitive and lets
    // rel carry a space-separated list, so match a token rather than the whole parameter.
    return rel !== null && (rel[1] ?? rel[2] ?? "").split(/\s+/).some((type) => type.toLowerCase() === "next");
  });
}

function records(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))) {
    throw new ShipperError(`GitHub returned invalid ${label}`, 4);
  }
  return value as Array<Record<string, unknown>>;
}

function responseBody(response: GitHubTransportResponse, label: string): Record<string, unknown> {
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null || Array.isArray(response.body)) {
    throw new ShipperError(`GitHub ${label} observation failed with status ${response.status}`, 4);
  }
  return response.body as Record<string, unknown>;
}

function actorLogin(record: Record<string, unknown>): string | null {
  const login = (record.user as Record<string, unknown> | null)?.login;
  return typeof login === "string" && login.length > 0 ? login : null;
}

function trustedFeedbackRecord(
  record: Record<string, unknown>,
  expectedHeadSha: string,
  trustedActors: string[],
  requireCommitBinding: boolean,
): { id: number; actor: string; body: string } | null {
  const actor = String((record.user as Record<string, unknown> | null)?.login ?? "");
  if (!trustedActors.includes(actor)
    || !Number.isSafeInteger(record.id)
    || typeof record.body !== "string"
    || (requireCommitBinding && record.commit_id !== expectedHeadSha)) return null;
  const lines = record.body.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "## SHIPPER FEEDBACK"
    || lines[1] !== "Scope: in_scope"
    || lines[2] !== `Head: ${expectedHeadSha}`) return null;
  return { id: record.id as number, actor, body: record.body };
}

export class GitHubAdapter {
  readonly #repository: string;
  readonly #transport: GitHubTransport;

  constructor(options: { repository: string; transport: GitHubTransport }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new ShipperError("GitHub repository identity is invalid", 3);
    }
    this.#repository = options.repository;
    this.#transport = options.transport;
  }

  /**
   * Reads a list to its end by following `Link: rel="next"`, so an observation is
   * evidence about the whole list rather than about its first page.
   */
  async #listPages(input: {
    path: string;
    label: string;
    statusMessage: string;
    field?: string;
    totalField?: string;
    purpose?: GitHubTransportRequest["purpose"];
  }): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let reportedTotal: unknown;
    for (let page = 1; ; page += 1) {
      const response = await this.#transport.request({
        method: "GET", path: paged(input.path, page),
        ...(input.purpose ? { purpose: input.purpose } : {}),
      });
      if (response.status !== 200) throw new ShipperError(`${input.statusMessage} failed with status ${response.status}`, 4);
      if (input.field) {
        const envelope = responseBody(response, input.label);
        if (page === 1 && input.totalField) reportedTotal = envelope[input.totalField];
        items.push(...records(envelope[input.field], input.label));
      } else {
        items.push(...records(response.body, input.label));
      }
      if (!hasNextPage(response)) break;
      if (page >= MAXIMUM_PAGES) {
        throw new ShipperError(`GitHub ${input.label} exceeds ${MAXIMUM_PAGES * PAGE_SIZE} entries; exact-head observation cannot be proven from it`, 4);
      }
    }
    // Only a shortfall is evidence of a lost page; an entry created mid-walk is growth.
    if (typeof reportedTotal === "number" && reportedTotal > items.length) {
      throw new ShipperError(`GitHub returned a truncated ${input.label} list; exact-head observation cannot be proven from it`, 4);
    }
    return items;
  }

  async pushBranch(input: {
    lease: AuthorityLease;
    branch: string;
    headSha: string;
    expectedRemoteHeadSha: string | null;
    workspacePath: string;
    gitDirectory: string;
  }): Promise<GitHubPushReceipt> {
    assertLease(input.lease, this.#repository, "push_branch", input.headSha);
    if (!this.#transport.pushBranch) throw new ShipperError("GitHub branch transport is unavailable", 4);
    const receipt = await this.#transport.pushBranch({
      repository: this.#repository,
      branch: input.branch,
      headSha: input.headSha,
      expectedRemoteHeadSha: input.expectedRemoteHeadSha,
      workspacePath: input.workspacePath,
      gitDirectory: input.gitDirectory,
    });
    if ((receipt.remoteHeadBefore !== input.expectedRemoteHeadSha && receipt.remoteHeadBefore !== input.headSha)
      || receipt.remoteHeadAfter !== input.headSha) {
      throw new ShipperError("GitHub branch push did not preserve exact-head authority", 4);
    }
    return receipt;
  }

  /** No-op when the composed transport has no commit fetch; the fetch is always bound to this repository. */
  async fetchCommit(input: { ref: string; commitSha: string; workspacePath: string }): Promise<void> {
    await this.#transport.fetchCommit?.({ repository: this.#repository, ...input });
  }

  resetObservationBackoff(): void {
    this.#transport.resetObservationBackoff?.();
  }

  async waitForNextObservation(deadlineAt: string): Promise<"ready" | "exhausted"> {
    if (this.#transport.waitForNextObservation) return await this.#transport.waitForNextObservation(deadlineAt);
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (remaining <= 0) return "exhausted";
    await delay(Math.min(30_000, remaining));
    return Date.now() < Date.parse(deadlineAt) ? "ready" : "exhausted";
  }

  async observePullRequest(input: {
    number: number;
    expectedHeadSha: string;
    requiredChecks: string[];
    requiredCheckSource?: RequiredCheckSource;
    trustedReviewerActors: string[];
    trustedFeedbackActors: string[];
    trustedCheckProducers: string[];
    reviewPublication?: ReviewPublicationReceipt;
  }): Promise<PullRequestObservation> {
    const pullResponse = await this.#transport.request({
      method: "GET",
      path: `/repos/${this.#repository}/pulls/${input.number}`,
    });
    if (pullResponse.status !== 200) throw new ShipperError(`GitHub pull request observation failed with status ${pullResponse.status}`, 4);
    const pull = pullRequestRecord(pullResponse.body);
    const checkSource = input.requiredCheckSource ?? "check_runs";
    const checks = input.requiredChecks.length === 0 ? [] : checkSource === "commit_statuses"
      ? (await this.#listPages({
          path: `/repos/${this.#repository}/commits/${input.expectedHeadSha}/statuses`,
          label: "commit statuses",
          statusMessage: "GitHub commit status observation",
        })).map((record) => {
          const state = String(record.state ?? "");
          return {
            name: String(record.context ?? ""),
            status: state === "pending" ? "in_progress" : "completed",
            conclusion: state === "pending" ? null : state === "success" ? "success" : state,
            producer: String((record.creator as Record<string, unknown> | null)?.login ?? ""),
            headSha: input.expectedHeadSha,
          };
        })
      : (await this.#listPages({
          path: `/repos/${this.#repository}/commits/${input.expectedHeadSha}/check-runs`,
          label: "hosted checks",
          statusMessage: "GitHub hosted checks observation",
          field: "check_runs",
          totalField: "total_count",
        })).map((record) => ({
          name: String(record.name ?? ""),
          status: String(record.status ?? ""),
          conclusion: record.conclusion === null ? null : String(record.conclusion ?? ""),
          producer: String((record.app as Record<string, unknown> | null)?.slug ?? ""),
          headSha: String(record.head_sha ?? ""),
        }));
    const requiredChecks = input.requiredChecks.map((name) => checks.find((check) => check.name === name) ?? {
      name, status: "missing", conclusion: null, producer: "", headSha: input.expectedHeadSha,
    });
    const hostedChecksGreen = requiredChecks.every((check) => check.status === "completed"
      && check.conclusion === "success"
      && check.headSha === input.expectedHeadSha
      && input.trustedCheckProducers.includes(check.producer));

    const reviews = await this.#listPages({
      path: `/repos/${this.#repository}/pulls/${input.number}/reviews`,
      label: "reviews",
      statusMessage: "GitHub review observation",
    });
    const approvedReviewActors = new Set(reviews.filter((review) => review.state === "APPROVED"
      && review.commit_id === input.expectedHeadSha
      && typeof review.body === "string"
      && /^## VERDICT: APPROVE\s*$/m.test(review.body)
      && input.trustedReviewerActors.includes(String((review.user as Record<string, unknown> | null)?.login ?? "")))
      .map((review) => String((review.user as Record<string, unknown> | null)?.login ?? "")));
    const approvedReviewCount = approvedReviewActors.size;
    const reviewApproved = approvedReviewCount > 0;

    const reviewComments = await this.#listPages({
      path: `/repos/${this.#repository}/pulls/${input.number}/comments`,
      label: "inline feedback",
      statusMessage: "GitHub inline feedback observation",
    });

    const comments = await this.#listPages({
      path: `/repos/${this.#repository}/issues/${input.number}/comments`,
      label: "feedback",
      statusMessage: "GitHub feedback observation",
    });
    const reviewPublication = input.reviewPublication;
    const providerApprovalPublished = reviewPublication !== undefined
      && reviewPublication.headSha === input.expectedHeadSha
      && comments.some((comment) => comment.id === reviewPublication.commentId
        && comment.body === reviewPublicationBody(reviewPublication));
    const reviewFeedback = reviews.filter((review) => review.state === "CHANGES_REQUESTED");
    const feedbackCandidates = [
      ...reviewFeedback.map((record) => ({ record, requireCommitBinding: true })),
      ...reviewComments.map((record) => ({ record, requireCommitBinding: true })),
      ...comments.filter((record) => input.reviewPublication === undefined
        || record.id !== input.reviewPublication.commentId)
        .map((record) => ({ record, requireCommitBinding: false })),
    ];
    const trustedFeedback = feedbackCandidates.flatMap(({ record, requireCommitBinding }) => {
      const feedback = trustedFeedbackRecord(record, input.expectedHeadSha, input.trustedFeedbackActors, requireCommitBinding);
      return feedback ? [feedback] : [];
    });
    return {
      number: pull.number,
      url: pull.html_url,
      headSha: pull.head.sha,
      baseBranch: pull.base.ref,
      headDrift: pull.head.sha !== input.expectedHeadSha,
      hostedChecksGreen,
      reviewApproved,
      providerApprovalPublished,
      approvedReviewCount,
      requiredChecks,
      trustedFeedback,
      ignoredFeedbackCount: feedbackCandidates.length - trustedFeedback.length,
    };
  }

  async observeIssueRevision(input: { identity: string; expectedRevision: string }): Promise<IssueRevisionObservation> {
    const match = /^#?(\d+)$/.exec(input.identity);
    if (!match) throw new ShipperError("GitHub issue source identity must be an issue number", 3);
    const response = await this.#transport.request({
      method: "GET",
      path: `/repos/${this.#repository}/issues/${match[1]}`,
    });
    const body = responseBody(response, "issue source revision");
    if (body.number !== Number(match[1]) || typeof body.updated_at !== "string") {
      throw new ShipperError("GitHub returned an invalid issue source revision", 4);
    }
    return {
      identity: input.identity,
      expectedRevision: input.expectedRevision,
      observedRevision: body.updated_at,
      drifted: body.updated_at !== input.expectedRevision,
    };
  }

  async publishReviewVerdict(input: {
    lease: AuthorityLease;
    number: number;
    headSha: string;
    runId: string;
    reviewProvider: "anthropic" | "openai";
    reviewBundleDigest: string;
  }): Promise<ReviewPublicationReceipt> {
    assertLease(input.lease, this.#repository, "publish_review_verdict", input.headSha);
    const body = reviewPublicationBody(input);
    const path = `/repos/${this.#repository}/issues/${input.number}/comments`;
    const actorResponse = await this.#transport.request({ method: "GET", path: "/user" });
    const actor = responseBody(actorResponse, "authenticated actor").login;
    if (typeof actor !== "string" || actor.length === 0) {
      throw new ShipperError("GitHub returned an invalid authenticated actor", 4);
    }
    const exactComments = (await this.#listPages({
      path,
      label: "review publication comments",
      statusMessage: "GitHub review publication observation",
      purpose: "review_publication",
    })).filter((record) => record.body === body);
    if (exactComments.some((record) => actorLogin(record) === null)) {
      throw new ShipperError("GitHub returned an invalid review publication author", 4);
    }
    const ownedComments = exactComments.filter((record) => actorLogin(record) === actor);
    if (ownedComments.length > 1) {
      throw new ShipperError("GitHub returned duplicate owned review publications", 4);
    }
    const existing = ownedComments[0];
    if (existing) {
      if (!Number.isSafeInteger(existing.id)) throw new ShipperError("GitHub returned an invalid review publication comment", 4);
      return {
        disposition: "adopted", commentId: existing.id as number, headSha: input.headSha,
        reviewProvider: input.reviewProvider, runId: input.runId, reviewBundleDigest: input.reviewBundleDigest,
      };
    }
    const response = await this.#transport.request({ method: "POST", path, body: { body } });
    if (response.status !== 201 || typeof response.body !== "object" || response.body === null || Array.isArray(response.body)) {
      throw new ShipperError(`GitHub review publication failed with status ${response.status}`, 4);
    }
    const comment = response.body as Record<string, unknown>;
    if (!Number.isSafeInteger(comment.id) || comment.body !== body || actorLogin(comment) !== actor) {
      throw new ShipperError("GitHub review publication postcondition failed", 4);
    }
    return {
      disposition: "published", commentId: comment.id as number, headSha: input.headSha,
      reviewProvider: input.reviewProvider, runId: input.runId, reviewBundleDigest: input.reviewBundleDigest,
    };
  }

  async observeMergeGuard(input: {
    number: number;
    expectedHeadSha: string;
    expectedBaseSha: string;
    baseBranch: string;
    requiredChecks: string[];
    requiredCheckSource?: RequiredCheckSource;
    trustedReviewerActors: string[];
    trustedCheckProducers: string[];
  }): Promise<MergeGuardObservation> {
    const pullResponse = await this.#transport.request({ method: "GET", path: `/repos/${this.#repository}/pulls/${input.number}` });
    if (pullResponse.status !== 200 || typeof pullResponse.body !== "object" || pullResponse.body === null || Array.isArray(pullResponse.body)) {
      throw new ShipperError(`GitHub merge-guard pull request observation failed with status ${pullResponse.status}`, 4);
    }
    const rawPull = pullResponse.body as Record<string, unknown>;
    const pull = pullRequestRecord(rawPull);
    const baseSha = String((rawPull.base as Record<string, unknown> | null)?.sha ?? "");
    const mergeable = rawPull.mergeable === true;
    const protectionResponse = await this.#transport.request({
      method: "GET", path: `/repos/${this.#repository}/branches/${encodeURIComponent(input.baseBranch)}/protection`,
    });
    const branchProtected = protectionResponse.status === 200;
    const protection = branchProtected && typeof protectionResponse.body === "object" && protectionResponse.body !== null
      ? protectionResponse.body as Record<string, unknown> : {};
    const statusPolicy = protection.required_status_checks as Record<string, unknown> | null;
    const strictStatusChecks = statusPolicy?.strict === true;
    const contextValues = Array.isArray(statusPolicy?.contexts) ? statusPolicy.contexts : [];
    const checkValues = Array.isArray(statusPolicy?.checks) ? statusPolicy.checks : [];
    const protectionRequiredChecks = [...new Set([
      ...contextValues.map(String),
      ...checkValues.map((entry) => String((entry as Record<string, unknown>).context ?? "")),
    ].filter(Boolean))];
    const reviewPolicy = protection.required_pull_request_reviews as Record<string, unknown> | null;
    const requiredApprovalCount = Number(reviewPolicy?.required_approving_review_count ?? 0);
    const allRequiredChecks = [...new Set([...input.requiredChecks, ...protectionRequiredChecks])];
    const hosted = await this.observePullRequest({
      number: input.number,
      expectedHeadSha: input.expectedHeadSha,
      requiredChecks: allRequiredChecks,
      ...(input.requiredCheckSource ? { requiredCheckSource: input.requiredCheckSource } : {}),
      trustedReviewerActors: input.trustedReviewerActors,
      trustedFeedbackActors: [],
      trustedCheckProducers: input.trustedCheckProducers,
    });
    const headDrift = pull.head.sha !== input.expectedHeadSha || hosted.headDrift;
    const baseDrift = pull.base.ref !== input.baseBranch || baseSha !== input.expectedBaseSha;
    const protectionMatches = protectionRequiredChecks.every((name) => input.requiredChecks.includes(name));
    const approvalsSatisfied = requiredApprovalCount > 0 && hosted.approvedReviewCount >= requiredApprovalCount;
    const eligible = branchProtected && strictStatusChecks && protectionMatches && approvalsSatisfied
      && !headDrift && !baseDrift && mergeable && hosted.hostedChecksGreen;
    return {
      eligible, branchProtected, strictStatusChecks, baseSha, baseDrift, headDrift, mergeable,
      hostedChecksGreen: hosted.hostedChecksGreen, reviewApproved: hosted.reviewApproved,
      protectionRequiredChecks, requiredApprovalCount,
    };
  }

  async mergeExactHead(input: {
    lease: AuthorityLease;
    number: number;
    headSha: string;
    baseSha: string;
    method: "merge" | "squash" | "rebase";
  }): Promise<MergeReceipt> {
    assertLease(input.lease, this.#repository, "merge_exact_head", input.headSha);
    if (input.lease.expectedBaseSha !== input.baseSha) throw new ShipperError("GitHub Adapter rejected exact-base merge authority", 4);
    const path = `/repos/${this.#repository}/pulls/${input.number}/merge`;
    const observed = await this.#transport.request({ method: "GET", path });
    if (observed.status === 204) {
      const pull = responseBody(await this.#transport.request({
        method: "GET", path: `/repos/${this.#repository}/pulls/${input.number}`,
      }), "merged pull request");
      const observedHead = String((pull.head as Record<string, unknown> | null)?.sha ?? "");
      const observedBase = String((pull.base as Record<string, unknown> | null)?.sha ?? "");
      const mergedSha = String(pull.merge_commit_sha ?? "");
      if (pull.merged !== true || pull.state !== "closed" || observedHead !== input.headSha
        || observedBase !== input.baseSha || !/^[0-9a-f]{40,64}$/.test(mergedSha)) {
        throw new ShipperError("GitHub merged-state reconciliation is not attributable to the leased exact head and base", 4);
      }
      return { disposition: "adopted", headSha: input.headSha, baseSha: input.baseSha, mergedSha, method: input.method };
    }
    if (observed.status !== 404) throw new ShipperError(`GitHub merge observation failed with status ${observed.status}`, 4);
    const response = await this.#transport.request({
      method: "PUT", path, body: { sha: input.headSha, merge_method: input.method },
    });
    if (response.status !== 200 || typeof response.body !== "object" || response.body === null || Array.isArray(response.body)) {
      throw new ShipperError(`GitHub merge failed with status ${response.status}`, 4);
    }
    const body = response.body as Record<string, unknown>;
    if (body.merged !== true || !/^[0-9a-f]{40,64}$/.test(String(body.sha ?? ""))) {
      throw new ShipperError("GitHub merge postcondition was not observed", 4);
    }
    const pull = responseBody(await this.#transport.request({
      method: "GET", path: `/repos/${this.#repository}/pulls/${input.number}`,
    }), "merged pull request");
    const observedHead = String((pull.head as Record<string, unknown> | null)?.sha ?? "");
    const observedBase = String((pull.base as Record<string, unknown> | null)?.sha ?? "");
    if (pull.merged !== true || pull.state !== "closed" || observedHead !== input.headSha
      || observedBase !== input.baseSha || pull.merge_commit_sha !== body.sha) {
      throw new ShipperError("GitHub merge postcondition is not attributable to the leased exact head and base", 4);
    }
    return { disposition: "merged", headSha: input.headSha, baseSha: input.baseSha, mergedSha: String(body.sha), method: input.method };
  }

  async closeIssue(input: {
    lease: AuthorityLease;
    identity: string;
    terminalSha: string;
  }): Promise<SourceClosureReceipt> {
    assertLease(input.lease, this.#repository, "close_source", input.lease.expectedHeadSha);
    const match = /^#?(\d+)$/.exec(input.identity);
    if (!match) throw new ShipperError("GitHub issue source identity must be an issue number", 3);
    const path = `/repos/${this.#repository}/issues/${match[1]}`;
    const observed = responseBody(await this.#transport.request({ method: "GET", path }), "issue source closure");
    if (observed.number !== Number(match[1]) || !["open", "closed"].includes(String(observed.state))) {
      throw new ShipperError("GitHub returned an invalid issue source closure observation", 4);
    }
    if (observed.state === "closed") return { disposition: "adopted", identity: input.identity, terminalSha: input.terminalSha };
    const response = await this.#transport.request({ method: "PATCH", path, body: { state: "closed" } });
    const closed = responseBody(response, "issue source closure");
    if (closed.number !== Number(match[1]) || closed.state !== "closed") throw new ShipperError("GitHub issue closure postcondition failed", 4);
    return { disposition: "closed", identity: input.identity, terminalSha: input.terminalSha };
  }

  async upsertPullRequest(input: {
    lease: AuthorityLease;
    branch: string;
    headSha: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestReceipt> {
    assertLease(input.lease, this.#repository, "upsert_pull_request", input.headSha);
    const owner = this.#repository.split("/", 1)[0];
    const query = new URLSearchParams({ state: "open", head: `${owner}:${input.branch}`, base: input.baseBranch });
    const candidates = (await this.#listPages({
      path: `/repos/${this.#repository}/pulls?${query.toString()}`,
      label: "open pull requests",
      statusMessage: "GitHub pull request lookup",
    })).map(pullRequestRecord);
    // Adopt on branch identity: the branch may carry only one open pull request, so a second
    // POST is a 422 rather than a recovery. Head exactness is asserted separately, against the
    // single-object read, because the list can lag the ref it describes.
    const listed = candidates.find((candidate) => candidate.head.ref === input.branch
      && candidate.base.ref === input.baseBranch);
    let existing = listed;
    if (listed && listed.head.sha !== input.headSha) {
      const reread = await this.#transport.request({
        method: "GET", path: `/repos/${this.#repository}/pulls/${listed.number}`,
      });
      if (reread.status !== 200) throw new ShipperError(`GitHub pull request re-read failed with status ${reread.status}`, 4);
      existing = pullRequestRecord(reread.body);
      if (existing.head.ref !== input.branch || existing.head.sha !== input.headSha || existing.base.ref !== input.baseBranch) {
        throw new ShipperError("existing pull request does not bind the leased exact head", 4, [
          `expected ${input.branch}@${input.headSha} onto ${input.baseBranch}`,
          `observed ${existing.head.ref}@${existing.head.sha} onto ${existing.base.ref}`,
        ]);
      }
    }
    if (existing) {
      if (existing.title !== input.title || existing.body !== input.body) {
        const updatedResponse = await this.#transport.request({
          method: "PATCH",
          path: `/repos/${this.#repository}/pulls/${existing.number}`,
          body: { title: input.title, body: input.body, base: input.baseBranch },
        });
        if (updatedResponse.status !== 200) {
          throw new ShipperError(`GitHub pull request update failed with status ${updatedResponse.status}`, 4);
        }
        const updated = pullRequestRecord(updatedResponse.body);
        if (updated.number !== existing.number || updated.head.sha !== input.headSha || updated.base.ref !== input.baseBranch) {
          throw new ShipperError("updated pull request does not bind the expected identity, head, and base", 4);
        }
        return {
          disposition: "updated",
          number: updated.number,
          url: updated.html_url,
          headSha: updated.head.sha,
          baseBranch: updated.base.ref,
        };
      }
      return {
        disposition: "adopted",
        number: existing.number,
        url: existing.html_url,
        headSha: existing.head.sha,
        baseBranch: existing.base.ref,
      };
    }
    const createdResponse = await this.#transport.request({
      method: "POST",
      path: `/repos/${this.#repository}/pulls`,
      body: {
        head: input.branch,
        base: input.baseBranch,
        title: input.title,
        body: input.body,
        draft: false,
      },
    });
    if (createdResponse.status !== 201) {
      throw new ShipperError(`GitHub pull request creation failed with status ${createdResponse.status}`, 4);
    }
    const created = pullRequestRecord(createdResponse.body);
    if (created.head.ref !== input.branch
      || created.head.sha !== input.headSha
      || created.base.ref !== input.baseBranch) {
      throw new ShipperError("created pull request does not bind the expected head and base", 4);
    }
    return {
      disposition: "created",
      number: created.number,
      url: created.html_url,
      headSha: created.head.sha,
      baseBranch: created.base.ref,
    };
  }
}
