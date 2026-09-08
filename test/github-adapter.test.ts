import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubAdapter,
  type GitHubTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from "../src/adapters/github.js";
import type { AuthorityLease } from "../src/brokers/ports.js";

function lease(operation: AuthorityLease["operation"], expectedHeadSha: string, expectedBaseSha?: string): AuthorityLease {
  const now = new Date();
  return {
    leaseId: "lease-a",
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    contractDigest: "contract-a",
    projectId: "project-a",
    repository: "fixture/project",
    workRunId: "run-a",
    workItemRevision: "revision-a",
    autonomy: operation === "push_branch" || operation === "upsert_pull_request" ? "open_pr" : "merge_when_green",
    expectedHeadSha,
    ...(expectedBaseSha ? { expectedBaseSha } : {}),
    operation,
    budget: {
      iteration: 1,
      maximumIterations: 2,
      deadlineAt: new Date(now.getTime() + 120_000).toISOString(),
    },
  };
}

test("typed GitHub Adapter publishes and then adopts an exact-head opposite-provider verdict stamp", async () => {
  const headSha = "2".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  let published: Record<string, unknown> | null = null;
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      if (request.method === "GET" && request.path === "/user") {
        return { status: 200, body: { login: "operator" } };
      }
      if (request.method === "GET") return { status: 200, body: published ? [published] : [] };
      published = { id: 31, body: request.body?.body, user: { login: "operator" } };
      return { status: 201, body: published };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });
  const input = {
    lease: lease("publish_review_verdict", headSha), number: 24, headSha,
    runId: "run-merge", reviewProvider: "openai" as const, reviewBundleDigest: "bundle-a",
  };

  assert.deepEqual(await adapter.publishReviewVerdict(input), {
    disposition: "published", commentId: 31, headSha, reviewProvider: "openai",
    runId: "run-merge", reviewBundleDigest: "bundle-a",
  });
  assert.deepEqual(await adapter.publishReviewVerdict(input), {
    disposition: "adopted", commentId: 31, headSha, reviewProvider: "openai",
    runId: "run-merge", reviewBundleDigest: "bundle-a",
  });
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("typed GitHub Adapter does not adopt a foreign exact provider verdict stamp", async () => {
  const headSha = "3".repeat(40);
  const body = [
    "## VERDICT: APPROVE",
    "",
    "Graph-Shipper-Run: run-foreign",
    `Head: ${headSha}`,
    "Review-Provider: openai",
    "Review-Bundle-Digest: bundle-foreign",
  ].join("\n");
  const requests: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      const path = request.path.split("?")[0]!;
      if (path === "/user") return { status: 200, body: { login: "operator" } };
      if (request.method === "GET") return { status: 200, body: [
        { id: 30, body, user: { login: "stranger" } },
      ] };
      return { status: 201, body: { id: 31, body: request.body?.body, user: { login: "operator" } } };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const result = await adapter.publishReviewVerdict({
    lease: lease("publish_review_verdict", headSha), number: 24, headSha,
    runId: "run-foreign", reviewProvider: "openai", reviewBundleDigest: "bundle-foreign",
  });

  assert.equal(result.disposition, "published");
  assert.equal(result.commentId, 31);
  assert.equal(requests.filter((request) => request.method === "POST").length, 1);
});

test("typed GitHub Adapter refuses malformed authenticated actor evidence before publication", async () => {
  const headSha = "4".repeat(40);
  let posted = false;
  const adapter = new GitHubAdapter({
    repository: "fixture/project",
    transport: {
      async request(request) {
        if (request.path === "/user") return { status: 200, body: { login: "" } };
        if (request.method === "POST") posted = true;
        return { status: 200, body: [] };
      },
    },
  });

  await assert.rejects(() => adapter.publishReviewVerdict({
    lease: lease("publish_review_verdict", headSha), number: 24, headSha,
    runId: "run-malformed-actor", reviewProvider: "openai", reviewBundleDigest: "bundle-malformed-actor",
  }), /invalid authenticated actor/);
  assert.equal(posted, false);
});

test("typed GitHub Adapter refuses a publication response authored by another actor", async () => {
  const headSha = "5".repeat(40);
  const adapter = new GitHubAdapter({
    repository: "fixture/project",
    transport: {
      async request(request) {
        if (request.path === "/user") return { status: 200, body: { login: "operator" } };
        if (request.method === "GET") return { status: 200, body: [] };
        return { status: 201, body: {
          id: 31, body: request.body?.body, user: { login: "stranger" },
        } };
      },
    },
  });

  await assert.rejects(() => adapter.publishReviewVerdict({
    lease: lease("publish_review_verdict", headSha), number: 24, headSha,
    runId: "run-wrong-post-actor", reviewProvider: "openai", reviewBundleDigest: "bundle-wrong-post-actor",
  }), /postcondition failed/);
});

test("typed GitHub Adapter refuses duplicate owned exact provider verdict stamps", async () => {
  const headSha = "6".repeat(40);
  const body = [
    "## VERDICT: APPROVE",
    "",
    "Graph-Shipper-Run: run-duplicate",
    `Head: ${headSha}`,
    "Review-Provider: openai",
    "Review-Bundle-Digest: bundle-duplicate",
  ].join("\n");
  const adapter = new GitHubAdapter({
    repository: "fixture/project",
    transport: {
      async request(request) {
        if (request.path === "/user") return { status: 200, body: { login: "operator" } };
        return { status: 200, body: [
          { id: 31, body, user: { login: "operator" } },
          { id: 32, body, user: { login: "operator" } },
        ] };
      },
    },
  });

  await assert.rejects(() => adapter.publishReviewVerdict({
    lease: lease("publish_review_verdict", headSha), number: 24, headSha,
    runId: "run-duplicate", reviewProvider: "openai", reviewBundleDigest: "bundle-duplicate",
  }), /duplicate owned review publications/);
});

test("typed GitHub Adapter recognizes its exact published provider approval without a native review", async () => {
  const headSha = "1".repeat(40);
  const body = [
    "## VERDICT: APPROVE",
    "",
    "Graph-Shipper-Run: run-open-pr",
    `Head: ${headSha}`,
    "Review-Provider: openai",
    "Review-Bundle-Digest: bundle-open-pr",
  ].join("\n");
  let commentBody = body;
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (/\/pulls\/24$/.test(path)) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24",
        draft: false, state: "open", head: { ref: "graph-shipper/run-open-pr", sha: headSha },
        base: { ref: "main" }, title: "Delivery", body: "## VERDICT: APPROVE",
      } };
      if (path.endsWith("/reviews")) return { status: 200, body: [] };
      if (path.endsWith("/issues/24/comments")) return { status: 200, body: [
        { id: 31, body: commentBody, user: { login: "operator" } },
      ] };
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observationInput: Parameters<GitHubAdapter["observePullRequest"]>[0] = {
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: [],
    reviewPublication: {
      disposition: "published", commentId: 31, headSha, reviewProvider: "openai",
      runId: "run-open-pr", reviewBundleDigest: "bundle-open-pr",
    },
  };
  const observation = await adapter.observePullRequest(observationInput);

  assert.equal(observation.reviewApproved, false);
  assert.equal(observation.providerApprovalPublished, true);
  commentBody = `${body}\nedited`;
  assert.equal((await adapter.observePullRequest(observationInput)).providerApprovalPublished, false);
});

test("typed GitHub Adapter does not recognize PR body text or an unreceipted verdict comment", async () => {
  const headSha = "2".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (/\/pulls\/24$/.test(path)) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24",
        draft: false, state: "open", head: { ref: "graph-shipper/run-unreceipted", sha: headSha },
        base: { ref: "main" }, title: "Delivery", body: "## VERDICT: APPROVE",
      } };
      if (path.endsWith("/issues/24/comments")) return { status: 200, body: [{
        id: 32, body: `## VERDICT: APPROVE\n\nHead: ${headSha}`, user: { login: "operator" },
      }] };
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: [],
  });

  assert.equal(observation.reviewApproved, false);
  assert.equal(observation.providerApprovalPublished, false);
});

test("typed GitHub Adapter revalidates protected base and exact-head merge conditions", async () => {
  const headSha = "3".repeat(40);
  const baseSha = "4".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.endsWith("/pulls/24")) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24", draft: false, state: "open",
        head: { ref: "graph-shipper/run-merge", sha: headSha }, base: { ref: "main", sha: baseSha },
        title: "Delivery", body: "Source issue: #24", mergeable: true,
      } };
      if (path.endsWith("/branches/main/protection")) return { status: 200, body: {
        required_status_checks: { strict: true, contexts: ["verify-status"], checks: [{ context: "verify-status", app_id: null }] },
        required_pull_request_reviews: { required_approving_review_count: 1 },
      } };
      if (path.endsWith(`/commits/${headSha}/statuses`)) return { status: 200, body: [{
        context: "verify-status", state: "success", sha: headSha, creator: { login: "github-actions[bot]" },
      }] };
      if (path.endsWith("/reviews")) return { status: 200, body: [{
        id: 1, state: "APPROVED", commit_id: headSha, body: "## VERDICT: APPROVE", user: { login: "review-bot" },
      }] };
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observeMergeGuard({
    number: 24, expectedHeadSha: headSha, expectedBaseSha: baseSha, baseBranch: "main",
    requiredChecks: ["verify-status"], requiredCheckSource: "commit_statuses",
    trustedReviewerActors: ["review-bot"], trustedCheckProducers: ["github-actions[bot]"],
  });

  assert.equal(observation.eligible, true);
  assert.equal(observation.branchProtected, true);
  assert.equal(observation.strictStatusChecks, true);
  assert.equal(observation.baseDrift, false);
  assert.equal(observation.headDrift, false);
});

test("typed GitHub Adapter merges and closes source only through exact leased postconditions", async () => {
  const headSha = "5".repeat(40);
  const baseSha = "7".repeat(40);
  const mergedSha = "6".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  let merged = false;
  let issueClosed = false;
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      if (request.path.endsWith("/merge") && request.method === "GET") {
        return merged ? { status: 204, body: null } : { status: 404, body: null };
      }
      if (request.path.endsWith("/merge") && request.method === "PUT") {
        merged = true;
        return { status: 200, body: { merged: true, sha: mergedSha } };
      }
      if (request.path.endsWith("/pulls/24") && request.method === "GET") {
        return { status: 200, body: {
          state: "closed", merged: true, merge_commit_sha: mergedSha,
          head: { sha: headSha }, base: { sha: baseSha },
        } };
      }
      if (request.path.endsWith("/issues/24") && request.method === "GET") {
        return { status: 200, body: { number: 24, state: issueClosed ? "closed" : "open" } };
      }
      if (request.path.endsWith("/issues/24") && request.method === "PATCH") {
        issueClosed = true;
        return { status: 200, body: { number: 24, state: "closed" } };
      }
      return { status: 404, body: null };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  assert.deepEqual(await adapter.mergeExactHead({
    lease: lease("merge_exact_head", headSha, baseSha), number: 24, headSha, baseSha, method: "squash",
  }), { disposition: "merged", headSha, baseSha, mergedSha, method: "squash" });
  assert.deepEqual(await adapter.closeIssue({
    lease: lease("close_source", headSha), identity: "#24", terminalSha: mergedSha,
  }), { disposition: "closed", identity: "#24", terminalSha: mergedSha });
  assert.equal(requests.some((request) => request.method === "PUT"), true);
});

test("typed GitHub Adapter refuses to adopt a merged PR whose observed head or base is not the leased pair", async () => {
  const headSha = "8".repeat(40);
  const baseSha = "9".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.endsWith("/merge")) return { status: 204, body: null };
      return { status: 200, body: {
        state: "closed", merged: true, merge_commit_sha: "a".repeat(40),
        head: { sha: "b".repeat(40) }, base: { sha: baseSha },
      } };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  await assert.rejects(adapter.mergeExactHead({
    lease: lease("merge_exact_head", headSha, baseSha), number: 24, headSha, baseSha, method: "merge",
  }), /not attributable to the leased exact head and base/);
});

test("merge guard requires strict protection, every protected check, and the configured approval count", async () => {
  const headSha = "c".repeat(40);
  const baseSha = "d".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.endsWith("/pulls/24")) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24", draft: false, state: "open",
        head: { ref: "graph-shipper/run", sha: headSha }, base: { ref: "main", sha: baseSha },
        title: "Delivery", body: "Source issue: #24", mergeable: true,
      } };
      if (path.endsWith("/branches/main/protection")) return { status: 200, body: {
        required_status_checks: { strict: false, contexts: ["verify", "security"], checks: [] },
        required_pull_request_reviews: { required_approving_review_count: 2 },
      } };
      if (path.includes("/check-runs")) return { status: 200, body: { check_runs: [
        { name: "verify", status: "completed", conclusion: "success", head_sha: headSha, app: { slug: "github-actions" } },
        { name: "security", status: "completed", conclusion: "success", head_sha: headSha, app: { slug: "github-actions" } },
      ] } };
      if (path.endsWith("/reviews")) return { status: 200, body: [{
        id: 1, state: "APPROVED", commit_id: headSha, body: "## VERDICT: APPROVE", user: { login: "review-bot" },
      }] };
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observeMergeGuard({
    number: 24, expectedHeadSha: headSha, expectedBaseSha: baseSha, baseBranch: "main",
    requiredChecks: ["verify"], trustedReviewerActors: ["review-bot"], trustedCheckProducers: ["github-actions"],
  });
  assert.equal(observation.eligible, false);
  assert.equal(observation.strictStatusChecks, false);
  assert.deepEqual(observation.protectionRequiredChecks, ["verify", "security"]);
  assert.equal(observation.requiredApprovalCount, 2);
});

test("typed GitHub Adapter adopts an existing exact-head normal PR without creating a duplicate", async () => {
  const headSha = "a".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      return {
        status: 200,
        body: [{
          number: 24,
          html_url: "https://github.example/fixture/project/pull/24",
          draft: false,
          state: "open",
          head: { ref: "graph-shipper/run-a", sha: headSha },
          base: { ref: "main" },
          title: "Implement exact-head delivery",
          body: "Source issue: #24",
        }],
      };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const result = await adapter.upsertPullRequest({
    lease: lease("upsert_pull_request", headSha),
    branch: "graph-shipper/run-a",
    headSha,
    baseBranch: "main",
    title: "Implement exact-head delivery",
    body: "Source issue: #24",
  });

  assert.deepEqual(result, {
    disposition: "adopted",
    number: 24,
    url: "https://github.example/fixture/project/pull/24",
    headSha,
    baseBranch: "main",
  });
  assert.deepEqual(requests.map(({ method, path }) => [method, path]), [[
    "GET",
    "/repos/fixture/project/pulls?state=open&head=fixture%3Agraph-shipper%2Frun-a&base=main&per_page=100",
  ]]);
});

test("typed GitHub Adapter creates one normal PR when the exact branch has none", async () => {
  const headSha = "b".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      if (request.method === "GET") return { status: 200, body: [] };
      return {
        status: 201,
        body: {
          number: 25,
          html_url: "https://github.example/fixture/project/pull/25",
          draft: false,
          state: "open",
          head: { ref: "graph-shipper/run-b", sha: headSha },
          base: { ref: "main" },
          title: "Bounded delivery",
          body: "Source issue: #25",
        },
      };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const result = await adapter.upsertPullRequest({
    lease: lease("upsert_pull_request", headSha),
    branch: "graph-shipper/run-b",
    headSha,
    baseBranch: "main",
    title: "Bounded delivery",
    body: "Source issue: #25",
  });

  assert.equal(result.disposition, "created");
  assert.deepEqual(requests[1], {
    method: "POST",
    path: "/repos/fixture/project/pulls",
    body: {
      head: "graph-shipper/run-b",
      base: "main",
      title: "Bounded delivery",
      body: "Source issue: #25",
      draft: false,
    },
  });
});

test("typed GitHub Adapter pushes only the leased exact head with remote compare-and-swap", async () => {
  const headSha = "c".repeat(40);
  const pushes: unknown[] = [];
  const transport: GitHubTransport = {
    async request() { return { status: 500, body: null }; },
    async pushBranch(request) {
      pushes.push(request);
      return { remoteHeadBefore: null, remoteHeadAfter: headSha };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const receipt = await adapter.pushBranch({
    lease: lease("push_branch", headSha),
    branch: "graph-shipper/run-c",
    headSha,
    expectedRemoteHeadSha: null,
    workspacePath: "/private/worktrees/run-c",
    gitDirectory: "/private/git/worktrees/run-c",
  });

  assert.deepEqual(receipt, { remoteHeadBefore: null, remoteHeadAfter: headSha });
  assert.deepEqual(pushes, [{
    repository: "fixture/project",
    branch: "graph-shipper/run-c",
    headSha,
    expectedRemoteHeadSha: null,
    workspacePath: "/private/worktrees/run-c",
    gitDirectory: "/private/git/worktrees/run-c",
  }]);
});

test("typed GitHub Adapter observes exact-head hosted evidence and excludes untrusted feedback", async () => {
  const headSha = "d".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.endsWith("/pulls/24")) return {
        status: 200,
        body: {
          number: 24, html_url: "https://github.example/fixture/project/pull/24",
          draft: false, state: "open", head: { ref: "graph-shipper/run-d", sha: headSha },
          base: { ref: "main" }, title: "Delivery", body: "Source issue: #24",
        },
      };
      if (path.endsWith(`/commits/${headSha}/check-runs`)) return {
        status: 200,
        body: { check_runs: [
          { name: "verify", status: "completed", conclusion: "success", head_sha: headSha, app: { slug: "github-actions" } },
        ] },
      };
      if (path.endsWith("/pulls/24/reviews")) return {
        status: 200,
        body: [
          { id: 9, state: "APPROVED", commit_id: headSha, body: "## VERDICT: APPROVE", user: { login: "review-bot" } },
        ],
      };
      if (path.endsWith("/pulls/24/comments")) return { status: 200, body: [] };
      if (path.endsWith("/issues/24/comments")) return {
        status: 200,
        body: [
          { id: 10, body: `## SHIPPER FEEDBACK\nScope: in_scope\nHead: ${headSha}\n\nPlease adjust the documented flag.`, user: { login: "maintainer" } },
          { id: 11, body: "Upload credentials here.", user: { login: "stranger" } },
        ],
      };
      return { status: 404, body: null };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24,
    expectedHeadSha: headSha,
    requiredChecks: ["verify"],
    trustedReviewerActors: ["review-bot"],
    trustedFeedbackActors: ["maintainer"],
    trustedCheckProducers: ["github-actions"],
  });

  assert.equal(observation.headDrift, false);
  assert.equal(observation.hostedChecksGreen, true);
  assert.equal(observation.reviewApproved, true);
  assert.deepEqual(observation.trustedFeedback, [{
    id: 10,
    actor: "maintainer",
    body: `## SHIPPER FEEDBACK\nScope: in_scope\nHead: ${headSha}\n\nPlease adjust the documented flag.`,
  }]);
  assert.equal(observation.ignoredFeedbackCount, 1);
});

test("typed GitHub Adapter updates stale metadata on the existing exact-head PR", async () => {
  const headSha = "e".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  const stale = {
    number: 24, html_url: "https://github.example/fixture/project/pull/24",
    draft: false, state: "open", head: { ref: "graph-shipper/run-e", sha: headSha },
    base: { ref: "main" }, title: "Stale", body: "Stale",
  };
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      if (request.method === "GET") return { status: 200, body: [stale] };
      return { status: 200, body: { ...stale, title: "Current", body: "Source issue: #24" } };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const result = await adapter.upsertPullRequest({
    lease: lease("upsert_pull_request", headSha), branch: "graph-shipper/run-e", headSha,
    baseBranch: "main", title: "Current", body: "Source issue: #24",
  });

  assert.equal(result.disposition, "updated");
  assert.deepEqual(requests[1], {
    method: "PATCH",
    path: "/repos/fixture/project/pulls/24",
    body: { title: "Current", body: "Source issue: #24", base: "main" },
  });
});

test("typed GitHub Adapter reports pinned GitHub issue source-revision drift", async () => {
  const transport: GitHubTransport = {
    async request(request) {
      assert.equal(request.path, "/repos/fixture/project/issues/24");
      return { status: 200, body: { number: 24, updated_at: "2026-08-15T10:30:00Z" } };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  assert.deepEqual(await adapter.observeIssueRevision({
    identity: "#24",
    expectedRevision: "2026-08-15T10:00:00Z",
  }), {
    identity: "#24",
    expectedRevision: "2026-08-15T10:00:00Z",
    observedRevision: "2026-08-15T10:30:00Z",
    drifted: true,
  });
});

test("typed GitHub Adapter does not treat a generic approval as the exact review verdict", async () => {
  const headSha = "f".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (/\/pulls\/24$/.test(path)) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24",
        draft: false, state: "open", head: { ref: "graph-shipper/run-f", sha: headSha },
        base: { ref: "main" }, title: "Delivery", body: "Source issue: #24",
      } };
      if (path.includes("/check-runs")) return { status: 200, body: { check_runs: [] } };
      if (path.endsWith("/reviews")) return { status: 200, body: [
        { id: 12, state: "APPROVED", commit_id: headSha, body: "Looks good", user: { login: "review-bot" } },
      ] };
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: ["review-bot"], trustedFeedbackActors: [], trustedCheckProducers: [],
  });

  assert.equal(observation.reviewApproved, false);
});

test("exact-head observation with no required checks does not require Checks API access", async () => {
  const headSha = "0".repeat(40);
  const paths: string[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      paths.push(path);
      if (/\/pulls\/24$/.test(path)) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24",
        draft: false, state: "open", head: { ref: "graph-shipper/run-0", sha: headSha },
        base: { ref: "main" }, title: "Delivery", body: "Canary work item: canary-step-3",
      } };
      if (path.includes("/check-runs")) return { status: 403, body: null };
      if (path.endsWith("/reviews")) return { status: 200, body: [{
        id: 30, state: "APPROVED", commit_id: headSha,
        body: "## VERDICT: APPROVE", user: { login: "review-bot" },
      }] };
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: ["review-bot"], trustedFeedbackActors: [], trustedCheckProducers: [],
  });

  assert.equal(observation.hostedChecksGreen, true);
  assert.equal(observation.reviewApproved, true);
  assert.equal(paths.some((path) => path.includes("/check-runs")), false);
});

test("typed GitHub Adapter admits only structured in-scope exact-head review feedback", async () => {
  const headSha = "1".repeat(40);
  const marker = (scope: string, body: string) => `## SHIPPER FEEDBACK\nScope: ${scope}\nHead: ${headSha}\n\n${body}`;
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (/\/pulls\/24$/.test(path)) return { status: 200, body: {
        number: 24, html_url: "https://github.example/fixture/project/pull/24",
        draft: false, state: "open", head: { ref: "graph-shipper/run-1", sha: headSha },
        base: { ref: "main" }, title: "Delivery", body: "Source issue: #24",
      } };
      if (path.includes("/check-runs")) return { status: 200, body: { check_runs: [] } };
      if (path.endsWith("/reviews")) return { status: 200, body: [{
        id: 20, state: "CHANGES_REQUESTED", commit_id: headSha,
        body: marker("in_scope", "Correct the documented flag."), user: { login: "maintainer" },
      }] };
      if (path.endsWith("/pulls/24/comments")) return { status: 200, body: [{
        id: 21, commit_id: headSha, body: marker("in_scope", "Fix this line."), user: { login: "review-bot" },
      }] };
      if (path.endsWith("/issues/24/comments")) return { status: 200, body: [{
        id: 22, body: marker("scope_changing", "Also redesign an unrelated API."), user: { login: "maintainer" },
      }] };
      return { status: 404, body: null };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: ["maintainer", "review-bot"],
    trustedFeedbackActors: ["maintainer", "review-bot"], trustedCheckProducers: [],
  });

  assert.deepEqual(observation.trustedFeedback.map(({ id, actor }) => ({ id, actor })), [
    { id: 20, actor: "maintainer" },
    { id: 21, actor: "review-bot" },
  ]);
  assert.equal(observation.ignoredFeedbackCount, 1);
});

test("exact-head observation refuses a truncated hosted-evidence page instead of reporting missing checks", async () => {
  const headSha = "6".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      if (request.path.includes("/check-runs")) {
        return {
          status: 200,
          body: {
            total_count: 140,
            check_runs: Array.from({ length: 100 }, (_item, index) => ({
              name: `check-${index}`, status: "completed", conclusion: "success",
              head_sha: headSha, app: { slug: "github-actions" },
            })),
          },
        };
      }
      if (/\/pulls\/\d+$/.test(request.path)) {
        return {
          status: 200,
          body: {
            number: 24, html_url: "https://github.com/fixture/project/pull/24", draft: false, state: "open",
            head: { ref: "graph-shipper/run", sha: headSha }, base: { ref: "main", sha: "7".repeat(40) },
            title: "t", body: "b",
          },
        };
      }
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  await assert.rejects(() => adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: ["verify"],
    trustedReviewerActors: ["review-bot"], trustedFeedbackActors: ["review-bot"], trustedCheckProducers: ["github-actions"],
  }), /truncated/);
});

test("every list read asks the forge for a full page rather than its default of thirty", async () => {
  const headSha = "8".repeat(40);
  const paths: string[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      paths.push(request.path);
      if (request.path.includes("/check-runs")) return { status: 200, body: { total_count: 0, check_runs: [] } };
      if (/\/pulls\/\d+$/.test(request.path)) {
        return {
          status: 200,
          body: {
            number: 24, html_url: "https://github.com/fixture/project/pull/24", draft: false, state: "open",
            head: { ref: "graph-shipper/run", sha: headSha }, base: { ref: "main", sha: "9".repeat(40) },
            title: "t", body: "b",
          },
        };
      }
      return { status: 200, body: [] };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: ["verify"],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: [],
  });

  const listPaths = paths.filter((path) => /\/(check-runs|reviews|comments)$|\/(check-runs|reviews|comments)\?/.test(path));
  assert.equal(listPaths.length, 4);
  for (const path of listPaths) assert.match(path, /[?&]per_page=100(&|$)/);
});

test("the adapter binds a commit fetch to its own repository and tolerates a transport without the seam", async () => {
  const fetched: Array<Record<string, unknown>> = [];
  const withoutSeam = new GitHubAdapter({
    repository: "fixture/project",
    transport: { async request() { return { status: 200, body: [] }; } },
  });
  await withoutSeam.fetchCommit({ ref: "main", commitSha: "a".repeat(40), workspacePath: "/tmp/primary" });

  const withSeam = new GitHubAdapter({
    repository: "fixture/project",
    transport: {
      async request() { return { status: 200, body: [] }; },
      async fetchCommit(request) { fetched.push(request as unknown as Record<string, unknown>); },
    },
  });
  await withSeam.fetchCommit({ ref: "main", commitSha: "a".repeat(40), workspacePath: "/tmp/primary" });
  assert.deepEqual(fetched, [{ repository: "fixture/project", ref: "main", commitSha: "a".repeat(40), workspacePath: "/tmp/primary" }]);
});

function requestedPage(path: string): number {
  const query = path.split("?")[1] ?? "";
  return Number(new URLSearchParams(query).get("page") ?? 1);
}

function page(body: unknown, options: { hasNext: boolean }): GitHubTransportResponse {
  return {
    status: 200,
    body,
    ...(options.hasNext
      ? { headers: { link: '<https://api.github.com/resource?per_page=100&page=2>; rel="next", <https://api.github.com/resource?per_page=100&page=9>; rel="last"' } }
      : {}),
  };
}

const OPEN_PULL_REQUEST = {
  number: 24, html_url: "https://github.com/fixture/project/pull/24", draft: false, state: "open",
  head: { ref: "graph-shipper/run", sha: "b".repeat(40) }, base: { ref: "main", sha: "c".repeat(40) },
  title: "t", body: "b",
};

test("exact-head evidence is assembled across a Link-advertised page boundary", async () => {
  const headSha = "b".repeat(40);
  const filler = Array.from({ length: 100 }, (_item, index) => ({
    name: `noise-${index}`, status: "completed", conclusion: "success", head_sha: headSha, app: { slug: "github-actions" },
  }));
  const required = {
    name: "verify", status: "completed", conclusion: "success", head_sha: headSha, app: { slug: "github-actions" },
  };
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.includes("/check-runs")) {
        return requestedPage(request.path) === 1
          ? page({ total_count: 101, check_runs: filler }, { hasNext: true })
          : page({ total_count: 101, check_runs: [required] }, { hasNext: false });
      }
      if (/\/pulls\/\d+$/.test(path)) return page(OPEN_PULL_REQUEST, { hasNext: false });
      return page([], { hasNext: false });
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: ["verify"],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: ["github-actions"],
  });

  assert.equal(observation.hostedChecksGreen, true);
  assert.equal(observation.requiredChecks[0]?.status, "completed");
});

test("commit-status evidence avoids the Checks API and accepts an exact trusted success", async () => {
  const headSha = "d".repeat(40);
  const paths: string[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      paths.push(path);
      if (/\/pulls\/\d+$/.test(path)) return page({
        ...OPEN_PULL_REQUEST,
        head: { ref: "graph-shipper/run", sha: headSha },
      }, { hasNext: false });
      if (path.endsWith(`/commits/${headSha}/statuses`)) return page([{
        id: 7,
        context: "verify-status",
        state: "success",
        sha: headSha,
        creator: { login: "github-actions[bot]" },
      }], { hasNext: false });
      return page([], { hasNext: false });
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24,
    expectedHeadSha: headSha,
    requiredChecks: ["verify-status"],
    requiredCheckSource: "commit_statuses",
    trustedReviewerActors: [],
    trustedFeedbackActors: [],
    trustedCheckProducers: ["github-actions[bot]"],
  });

  assert.equal(observation.hostedChecksGreen, true);
  assert.deepEqual(observation.requiredChecks, [{
    name: "verify-status",
    status: "completed",
    conclusion: "success",
    producer: "github-actions[bot]",
    headSha,
  }]);
  assert.equal(paths.some((path) => path.includes("/check-runs")), false);
});

test("commit-status evidence treats the requested commit endpoint as the authoritative head", async () => {
  const headSha = "c".repeat(40);
  for (const responseSha of [null, "f".repeat(40)]) {
    const adapter = new GitHubAdapter({
      repository: "fixture/project",
      transport: {
        async request(request) {
          const path = request.path.split("?")[0]!;
          if (/\/pulls\/\d+$/.test(path)) return page({
            ...OPEN_PULL_REQUEST,
            head: { ref: "graph-shipper/run", sha: headSha },
          }, { hasNext: false });
          if (path.endsWith(`/commits/${headSha}/statuses`)) return page([{
            context: "verify-status",
            state: "success",
            sha: responseSha,
            creator: { login: "publisher" },
          }], { hasNext: false });
          return page([], { hasNext: false });
        },
      },
    });

    const observation = await adapter.observePullRequest({
      number: 24,
      expectedHeadSha: headSha,
      requiredChecks: ["verify-status"],
      requiredCheckSource: "commit_statuses",
      trustedReviewerActors: [],
      trustedFeedbackActors: [],
      trustedCheckProducers: ["publisher"],
    });

    assert.equal(observation.hostedChecksGreen, true, `response sha ${String(responseSha)}`);
    assert.equal(observation.requiredChecks[0]?.headSha, headSha);
  }
});

test("commit-status evidence keeps incomplete or untrusted states non-green", async () => {
  const headSha = "e".repeat(40);
  const cases = [
    { label: "pending", statuses: [{ context: "verify-status", state: "pending", sha: headSha, creator: { login: "publisher" } }] },
    { label: "failure", statuses: [{ context: "verify-status", state: "failure", sha: headSha, creator: { login: "publisher" } }] },
    { label: "untrusted", statuses: [{ context: "verify-status", state: "success", sha: headSha, creator: { login: "stranger" } }] },
    { label: "missing", statuses: [] },
    { label: "malformed", statuses: [{ context: null, state: null, sha: null, creator: null }] },
  ];
  for (const scenario of cases) {
    const adapter = new GitHubAdapter({
      repository: "fixture/project",
      transport: {
        async request(request) {
          const path = request.path.split("?")[0]!;
          if (/\/pulls\/\d+$/.test(path)) return page({
            ...OPEN_PULL_REQUEST,
            head: { ref: "graph-shipper/run", sha: headSha },
          }, { hasNext: false });
          if (path.endsWith(`/commits/${headSha}/statuses`)) return page(scenario.statuses, { hasNext: false });
          return page([], { hasNext: false });
        },
      },
    });

    const observation = await adapter.observePullRequest({
      number: 24,
      expectedHeadSha: headSha,
      requiredChecks: ["verify-status"],
      requiredCheckSource: "commit_statuses",
      trustedReviewerActors: [],
      trustedFeedbackActors: [],
      trustedCheckProducers: ["publisher"],
    });

    assert.equal(observation.hostedChecksGreen, false, scenario.label);
  }
});

test("a prior verdict past the first page of comments is adopted rather than published again", async () => {
  const headSha = "d".repeat(40);
  const body = [
    "## VERDICT: APPROVE",
    "",
    "Graph-Shipper-Run: run-paged",
    `Head: ${headSha}`,
    "Review-Provider: openai",
    "Review-Bundle-Digest: bundle-paged",
  ].join("\n");
  const requests: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      if (request.path === "/user") return { status: 200, body: { login: "operator" } };
      const filler = Array.from({ length: 100 }, (_item, index) => ({ id: index + 1, body: `chatter ${index}`, user: { login: "human" } }));
      return requestedPage(request.path) === 1
        ? page(filler, { hasNext: true })
        : page([{ id: 900, body, user: { login: "operator" } }], { hasNext: false });
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  assert.deepEqual(await adapter.publishReviewVerdict({
    lease: lease("publish_review_verdict", headSha), number: 24, headSha,
    runId: "run-paged", reviewProvider: "openai", reviewBundleDigest: "bundle-paged",
  }), {
    disposition: "adopted", commentId: 900, headSha, reviewProvider: "openai",
    runId: "run-paged", reviewBundleDigest: "bundle-paged",
  });
  assert.deepEqual(requests.filter((request) => request.method === "POST"), []);
});

test("a complete page of exactly one hundred entries is not mistaken for a truncated one", async () => {
  const headSha = "e".repeat(40);
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.includes("/check-runs")) return page({ total_count: 0, check_runs: [] }, { hasNext: false });
      if (/\/pulls\/\d+$/.test(path)) return page({ ...OPEN_PULL_REQUEST, head: { ref: "graph-shipper/run", sha: headSha } }, { hasNext: false });
      if (path.endsWith("/reviews")) {
        return page(Array.from({ length: 100 }, (_item, index) => ({
          id: index + 1, state: "APPROVED", commit_id: headSha, body: "## VERDICT: APPROVE", user: { login: `reviewer-${index}` },
        })), { hasNext: false });
      }
      return page([], { hasNext: false });
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: ["reviewer-0"], trustedFeedbackActors: [], trustedCheckProducers: [],
  });

  assert.equal(observation.approvedReviewCount, 1);
});

test("a list that never stops advertising a next page fails closed instead of paging without bound", async () => {
  const headSha = "f".repeat(40);
  let listReads = 0;
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.includes("/check-runs")) return page({ total_count: 0, check_runs: [] }, { hasNext: false });
      if (/\/pulls\/\d+$/.test(path)) return page({ ...OPEN_PULL_REQUEST, head: { ref: "graph-shipper/run", sha: headSha } }, { hasNext: false });
      listReads += 1;
      return page([], { hasNext: true });
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  await assert.rejects(() => adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: [],
  }), /exceeds/);
  assert.equal(listReads, 10);
});

test("a check run created between two pages is growth, not evidence that the list was truncated", async () => {
  const headSha = "1".repeat(40);
  const run = (name: string) => ({
    name, status: "completed", conclusion: "success", head_sha: headSha, app: { slug: "github-actions" },
  });
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.includes("/check-runs")) {
        return requestedPage(request.path) === 1
          ? page({ total_count: 101, check_runs: Array.from({ length: 100 }, (_item, index) => run(`noise-${index}`)) }, { hasNext: true })
          : page({ total_count: 102, check_runs: [run("verify"), run("late-arrival")] }, { hasNext: false });
      }
      if (/\/pulls\/\d+$/.test(path)) return page({ ...OPEN_PULL_REQUEST, head: { ref: "graph-shipper/run", sha: headSha } }, { hasNext: false });
      return page([], { hasNext: false });
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  const observation = await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: ["verify"],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: ["github-actions"],
  });

  assert.equal(observation.hostedChecksGreen, true);
});

test("a rel=next spelled inside a link target is not mistaken for a further page", async () => {
  const headSha = "a".repeat(40);
  let listReads = 0;
  const transport: GitHubTransport = {
    async request(request) {
      const path = request.path.split("?")[0]!;
      if (path.includes("/check-runs")) return page({ total_count: 0, check_runs: [] }, { hasNext: false });
      if (/\/pulls\/\d+$/.test(path)) return page({ ...OPEN_PULL_REQUEST, head: { ref: "graph-shipper/run", sha: headSha } }, { hasNext: false });
      listReads += 1;
      return {
        status: 200,
        body: [],
        headers: { link: '<https://api.github.com/repos/fixture/project/pulls?head=owner%3Afeat;rel=next&page=1>; rel="prev"' },
      };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  await adapter.observePullRequest({
    number: 24, expectedHeadSha: headSha, requiredChecks: [],
    trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: [],
  });

  assert.equal(listReads, 3);
});

test("a multi-valued or differently cased rel still advertises a further page", async () => {
  const headSha = "3".repeat(40);
  const links = [
    '<https://api.github.com/resource?page=2>; rel="next last"',
    '<https://api.github.com/resource?page=2>; REL="Next"',
    '<https://api.github.com/resource?page=2>; rel=next',
  ];
  for (const link of links) {
    let reads = 0;
    const transport: GitHubTransport = {
      async request(request) {
        const path = request.path.split("?")[0]!;
        if (path.includes("/check-runs")) return page({ total_count: 0, check_runs: [] }, { hasNext: false });
        if (/\/pulls\/\d+$/.test(path)) return page({ ...OPEN_PULL_REQUEST, head: { ref: "graph-shipper/run", sha: headSha } }, { hasNext: false });
        reads += 1;
        return requestedPage(request.path) === 1 ? { status: 200, body: [], headers: { link } } : { status: 200, body: [] };
      },
    };
    const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

    await adapter.observePullRequest({
      number: 24, expectedHeadSha: headSha, requiredChecks: [],
      trustedReviewerActors: [], trustedFeedbackActors: [], trustedCheckProducers: [],
    });

    assert.equal(reads, 6, `two pages per list for ${link}`);
  }
});

test("a listed pull request whose head lags the pushed ref is adopted, not created a second time", async () => {
  const headSha = "4".repeat(40);
  const stale = "5".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  const record = (sha: string) => ({
    number: 24, html_url: "https://github.com/fixture/project/pull/24", draft: false, state: "open",
    head: { ref: "graph-shipper/run-a", sha }, base: { ref: "main" }, title: "Delivery", body: "Source issue: #24",
  });
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      const path = request.path.split("?")[0]!;
      if (path.endsWith("/pulls")) return { status: 200, body: [record(stale)] };
      return { status: 200, body: record(headSha) };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  assert.deepEqual(await adapter.upsertPullRequest({
    lease: lease("upsert_pull_request", headSha), branch: "graph-shipper/run-a", headSha,
    baseBranch: "main", title: "Delivery", body: "Source issue: #24",
  }), { disposition: "adopted", number: 24, url: "https://github.com/fixture/project/pull/24", headSha, baseBranch: "main" });
  assert.deepEqual(requests.filter((request) => request.method === "POST"), []);
});

test("a pull request that still does not carry the leased head is refused rather than duplicated", async () => {
  const headSha = "6".repeat(40);
  const requests: GitHubTransportRequest[] = [];
  const transport: GitHubTransport = {
    async request(request) {
      requests.push(request);
      return { status: 200, body: (() => {
        const stale = {
          number: 24, html_url: "https://github.com/fixture/project/pull/24", draft: false, state: "open",
          head: { ref: "graph-shipper/run-a", sha: "7".repeat(40) }, base: { ref: "main" }, title: "Delivery", body: "b",
        };
        return request.path.split("?")[0]!.endsWith("/pulls") ? [stale] : stale;
      })() };
    },
  };
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport });

  await assert.rejects(() => adapter.upsertPullRequest({
    lease: lease("upsert_pull_request", headSha), branch: "graph-shipper/run-a", headSha,
    baseBranch: "main", title: "Delivery", body: "b",
  }), /leased exact head/);
  assert.deepEqual(requests.filter((request) => request.method === "POST"), []);
});
