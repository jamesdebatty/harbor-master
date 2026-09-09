import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CredentialBroker, CredentialRequest } from "../src/brokers/ports.js";
import { GitHubTransportError, LiveGitHubTransport, type GitPushInvocation } from "../src/adapters/github-live.js";
import { GitHubAdapter } from "../src/adapters/github.js";
import { OpaqueCredential } from "../src/security/opaque-credential.js";
import { PersistenceRedactor } from "../src/security/redact.js";

const SECRET = "github-operator-secret-value";

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

class TestCredentialBroker implements CredentialBroker {
  readonly redactor = new PersistenceRedactor();
  readonly requests: CredentialRequest[] = [];
  readonly acquired: OpaqueCredential[] = [];

  async probe(request: CredentialRequest) {
    this.requests.push(request);
    return { referenceId: request.referenceId, identity: "offline-test", capabilityClasses: [request.purpose] };
  }

  async acquire(request: CredentialRequest) {
    this.requests.push(request);
    const credential = OpaqueCredential.create(request.referenceId, SECRET, this.redactor);
    this.acquired.push(credential);
    return credential;
  }
}

function transport(options: {
  broker?: TestCredentialBroker;
  fetchImplementation?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  gitPush?: (invocation: GitPushInvocation) => { status: number; stderr: string };
  sleep?: (milliseconds: number) => Promise<void>;
  pollIntervalMilliseconds?: number;
  maximumPollIntervalMilliseconds?: number;
  timeoutMilliseconds?: number;
  deadlineAt?: () => string;
} = {}) {
  const broker = options.broker ?? new TestCredentialBroker();
  return {
    broker,
    live: new LiveGitHubTransport({
      repository: "fixture/project",
      credentialRef: "github-operator",
      projectId: "fixture-project",
      workRunId: "run-live-1",
      broker,
      fetchImplementation: options.fetchImplementation ?? (async () => new Response("{}", { status: 200 })),
      ...(options.gitPush ? { gitPush: options.gitPush } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.pollIntervalMilliseconds === undefined ? {} : { pollIntervalMilliseconds: options.pollIntervalMilliseconds }),
      ...(options.maximumPollIntervalMilliseconds === undefined ? {} : { maximumPollIntervalMilliseconds: options.maximumPollIntervalMilliseconds }),
      ...(options.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.timeoutMilliseconds }),
      ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
    }),
  };
}

test("live transport authenticates each request at the adapter boundary without leaking credential material", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const { broker, live } = transport({
    fetchImplementation: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ number: 24 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await live.request({ method: "POST", path: "/repos/fixture/project/pulls", body: { title: "T" } });

  assert.deepEqual(response, { status: 200, body: { number: 24 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/fixture/project/pulls");
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${SECRET}`);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.doesNotMatch(String(calls[0]?.init.body), new RegExp(SECRET));
  assert.equal(broker.acquired.length, 1);
  assert.throws(() => broker.acquired[0]?.toJSON(), /cannot be serialized/);
  assert.equal(JSON.stringify(response).includes(SECRET), false);
});

test("live transport normalizes forge failures into provider-neutral classes and persists no response body", async () => {
  const cases: Array<{ status: number; headers?: Record<string, string>; kind: string }> = [
    { status: 401, kind: "auth" },
    { status: 403, headers: { "x-ratelimit-remaining": "0" }, kind: "rate_limit" },
    { status: 429, kind: "rate_limit" },
    { status: 500, kind: "transport" },
    { status: 502, kind: "transport" },
  ];
  for (const expected of cases) {
    const { live } = transport({
      fetchImplementation: async () => new Response(
        JSON.stringify({ message: "Bad credentials for user secret-owner", documentation_url: "x" }),
        { status: expected.status, headers: { "content-type": "application/json", ...expected.headers } },
      ),
    });
    const error = await live.request({ method: "GET", path: "/repos/fixture/project/pulls/1" })
      .then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof GitHubTransportError, `status ${expected.status} was not normalized`);
    assert.equal(error.kind, expected.kind);
    assert.equal(error.exitCode, 4);
    assert.equal(`${error.message} ${error.details.join(" ")}`.includes("Bad credentials"), false);
    assert.match(error.message, new RegExp(`HTTP ${expected.status}`));
  }
});

test("live transport passes ordinary non-success statuses through to the typed adapter", async () => {
  const { live } = transport({
    fetchImplementation: async () => new Response("", { status: 404 }),
  });
  assert.deepEqual(await live.request({ method: "GET", path: "/repos/fixture/project/pulls/1" }), { status: 404, body: null });
});

test("live commit-status observation binds GitHub's null sha response to the requested exact head", async () => {
  const headSha = "a".repeat(40);
  const { live } = transport({
    fetchImplementation: async (input) => {
      const path = new URL(String(input)).pathname;
      const body = path.endsWith("/pulls/24")
        ? {
            number: 24,
            html_url: "https://github.com/fixture/project/pull/24",
            draft: false,
            state: "open",
            title: "Exact-head status canary",
            body: "Observe a live-shaped commit status response.",
            head: { ref: "graph-shipper/run", sha: headSha },
            base: { ref: "main", sha: "b".repeat(40) },
          }
        : path.endsWith(`/commits/${headSha}/statuses`)
          ? [{ context: "verify-status", state: "success", sha: null, creator: { login: "github-actions[bot]" } }]
          : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport: live });

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
  assert.equal(observation.requiredChecks[0]?.headSha, headSha);
});

test("live transport classifies network failure as transport and abort as timeout", async () => {
  const failing = transport({ fetchImplementation: async () => { throw new Error("ECONNRESET on api.github.com"); } }).live;
  const networkError = await failing.request({ method: "GET", path: "/rate_limit" }).then(() => null, (error: unknown) => error);
  assert.ok(networkError instanceof GitHubTransportError);
  assert.equal(networkError.kind, "transport");

  const aborting = transport({
    fetchImplementation: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  }).live;
  const timeoutError = await aborting.request({ method: "GET", path: "/rate_limit" }).then(() => null, (error: unknown) => error);
  assert.ok(timeoutError instanceof GitHubTransportError);
  assert.equal(timeoutError.kind, "timeout");
});

test("live push creates an absent branch under an empty lease and reads the exact head back", async () => {
  const invocations: GitPushInvocation[] = [];
  const headSha = "b".repeat(40);
  let remoteHead: string | null = null;
  const { live } = transport({
    fetchImplementation: async () => (remoteHead === null
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify({ ref: "refs/heads/graph-shipper/run", object: { sha: remoteHead, type: "commit" } }), {
        status: 200, headers: { "content-type": "application/json" },
      })),
    gitPush: (invocation) => {
      invocations.push(invocation);
      remoteHead = headSha;
      return { status: 0, stderr: "" };
    },
  });

  const receipt = await live.pushBranch({
    repository: "fixture/project",
    branch: "graph-shipper/run",
    headSha,
    expectedRemoteHeadSha: null,
    workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  });

  assert.deepEqual(receipt, { remoteHeadBefore: null, remoteHeadAfter: headSha });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0]!;
  assert.equal(invocation.workspacePath, "/tmp/workspace");
  assert.deepEqual(invocation.args.slice(-3), [
    "--force-with-lease=refs/heads/graph-shipper/run:",
    "https://github.com/fixture/project.git",
    `${headSha}:refs/heads/graph-shipper/run`,
  ]);
  assert.equal(invocation.args.join(" ").includes(SECRET), false);
  assert.equal(JSON.stringify(invocation.args).includes(SECRET), false);
});

test("live push retries an initially missing exact-head read-back without repeating the mutation", async () => {
  const headSha = "1".repeat(40);
  const slept: number[] = [];
  let pushed = false;
  let pushCount = 0;
  let postPushReads = 0;
  const { live } = transport({
    fetchImplementation: async () => {
      if (!pushed) return new Response("", { status: 404 });
      postPushReads += 1;
      return postPushReads === 1
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ object: { sha: headSha, type: "commit" } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
    },
    gitPush: () => {
      pushed = true;
      pushCount += 1;
      return { status: 0, stderr: "" };
    },
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    deadlineAt: () => new Date(Date.now() + 10_000).toISOString(),
  });

  const receipt = await live.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  });

  assert.deepEqual(receipt, { remoteHeadBefore: null, remoteHeadAfter: headSha });
  assert.equal(pushCount, 1);
  assert.equal(postPushReads, 2);
  assert.equal(slept.length, 1);
  assert.ok(slept[0]! > 0 && slept[0]! <= 10_000);
});

test("live push carries the operator credential in the environment, never in argv or the remote URL", async () => {
  const invocations: GitPushInvocation[] = [];
  const headSha = "c".repeat(40);
  const previous = "d".repeat(40);
  let remoteHead: string | null = previous;
  const { live } = transport({
    fetchImplementation: async () => new Response(JSON.stringify({ object: { sha: remoteHead, type: "commit" } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
    gitPush: (invocation) => {
      invocations.push(invocation);
      remoteHead = headSha;
      return { status: 0, stderr: "" };
    },
  });

  const receipt = await live.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: previous, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  });

  assert.deepEqual(receipt, { remoteHeadBefore: previous, remoteHeadAfter: headSha });
  const invocation = invocations[0]!;
  assert.equal(invocation.args.includes(`--force-with-lease=refs/heads/graph-shipper/run:${previous}`), true);
  assert.equal(invocation.args.some((argument) => argument.includes(SECRET)), false);
  assert.equal(invocation.args.some((argument) => argument.includes("@github.com")), false);
  const authorizationValues = Object.entries(invocation.environment)
    .filter(([key]) => key.startsWith("GIT_CONFIG_VALUE_"))
    .map(([, value]) => value ?? "");
  assert.equal(authorizationValues.some((value) => value.startsWith("Authorization: Basic ")), true);
  const encoded = authorizationValues.find((value) => value.startsWith("Authorization: Basic "))!.slice("Authorization: Basic ".length);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), `x-access-token:${SECRET}`);
  assert.equal(invocation.environment.GIT_TERMINAL_PROMPT, "0");
});

test("Git directory binding reaches the live push child process", async () => {
  const invocations: GitPushInvocation[] = [];
  const headSha = "6".repeat(40);
  let remoteHead: string | null = null;
  const { live } = transport({
    fetchImplementation: async () => (remoteHead === null
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify({ object: { sha: remoteHead, type: "commit" } }), {
        status: 200, headers: { "content-type": "application/json" },
      })),
    gitPush: (invocation) => {
      invocations.push(invocation);
      remoteHead = headSha;
      return { status: 0, stderr: "" };
    },
  });

  await live.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace",
    gitDirectory: "/tmp/runtime-owned-git-directory",
  });

  assert.equal(invocations[0]!.environment.GIT_DIR, "/tmp/runtime-owned-git-directory");
});

test("live push adopts an already-exact remote head and refuses a drifted one without invoking git", async () => {
  const headSha = "e".repeat(40);
  let invoked = 0;
  const adopting = transport({
    fetchImplementation: async () => new Response(JSON.stringify({ object: { sha: headSha, type: "commit" } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
    gitPush: () => { invoked += 1; return { status: 0, stderr: "" }; },
  }).live;
  assert.deepEqual(await adopting.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }), { remoteHeadBefore: headSha, remoteHeadAfter: headSha });
  assert.equal(invoked, 0);

  const drifting = transport({
    fetchImplementation: async () => new Response(JSON.stringify({ object: { sha: "f".repeat(40), type: "commit" } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
    gitPush: () => { invoked += 1; return { status: 0, stderr: "" }; },
  }).live;
  await assert.rejects(() => drifting.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: "a".repeat(40), workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }), /drifted before push/);
  assert.equal(invoked, 0);
});

test("live push reports a rejected lease as drift and never claims exact-head authority it did not get", async () => {
  const headSha = "1".repeat(40);
  const previous = "2".repeat(40);
  const rejecting = transport({
    fetchImplementation: async () => new Response(JSON.stringify({ object: { sha: previous, type: "commit" } }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
    gitPush: () => ({ status: 1, stderr: "! [rejected] (stale info)" }),
  }).live;

  await assert.rejects(() => rejecting.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: previous, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }), /exact-head branch push was rejected/);
});

test("live push verifies the read-back head, so the typed adapter never records unearned exact-head authority", async () => {
  const headSha = "3".repeat(40);
  const previous = "4".repeat(40);
  let fetchReads = 0;
  let pushCount = 0;
  const slept: number[] = [];
  let observed = previous;
  const live = transport({
    fetchImplementation: async () => {
      fetchReads += 1;
      return new Response(JSON.stringify({ object: { sha: observed, type: "commit" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
    gitPush: () => {
      pushCount += 1;
      observed = "5".repeat(40);
      return { status: 0, stderr: "" };
    },
    sleep: async (milliseconds) => { slept.push(milliseconds); },
  }).live;
  const adapter = new GitHubAdapter({ repository: "fixture/project", transport: live });
  const now = Date.now();

  await assert.rejects(() => adapter.pushBranch({
    lease: {
      leaseId: "lease-live", issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      contractDigest: "contract-a", projectId: "fixture-project", repository: "fixture/project",
      workRunId: "run-live-1", workItemRevision: "revision-1", autonomy: "open_pr",
      expectedHeadSha: headSha, operation: "push_branch",
      budget: { iteration: 1, maximumIterations: 2, deadlineAt: new Date(now + 120_000).toISOString() },
    },
    branch: "graph-shipper/run", headSha, expectedRemoteHeadSha: previous, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }), /did not reach the leased exact head/);
  assert.equal(pushCount, 1);
  assert.equal(fetchReads, 4);
  assert.deepEqual(slept, [250, 500]);
});

test("live push read-back stops waiting when the Work Run deadline is exhausted", async () => {
  const headSha = "6".repeat(40);
  let expired = false;
  let pushed = false;
  let pushCount = 0;
  let fetchReads = 0;
  const slept: number[] = [];
  const { live } = transport({
    fetchImplementation: async () => {
      fetchReads += 1;
      return new Response("", { status: 404 });
    },
    gitPush: () => {
      pushed = true;
      pushCount += 1;
      return { status: 0, stderr: "" };
    },
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      expired = true;
    },
    deadlineAt: () => new Date(Date.now() + (expired ? -1 : 50)).toISOString(),
  });

  await assert.rejects(() => live.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }), /did not reach the leased exact head/);
  assert.equal(pushed, true);
  assert.equal(pushCount, 1);
  assert.equal(fetchReads, 2);
  assert.equal(slept.length, 1);
  assert.ok(slept[0]! > 0 && slept[0]! <= 50);
});

test("live observation waiting backs off within bounds and stops at the Work Run deadline", async () => {
  const slept: number[] = [];
  const { live } = transport({
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    pollIntervalMilliseconds: 1_000,
    maximumPollIntervalMilliseconds: 4_000,
  });
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(await live.waitForNextObservation(deadlineAt), "ready");
  }
  assert.deepEqual(slept, [1_000, 2_000, 4_000, 4_000]);

  assert.equal(await live.waitForNextObservation(new Date(Date.now() - 1_000).toISOString()), "exhausted");
  assert.equal(slept.length, 4);
});

test("live observation waiting never sleeps past the remaining Work Run budget", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const slept: number[] = [];
  const { live } = transport({
    sleep: async (milliseconds) => { slept.push(milliseconds); now += milliseconds; },
    pollIntervalMilliseconds: 60_000,
  });

  assert.equal(await live.waitForNextObservation(new Date(Date.now() + 50).toISOString()), "exhausted");
  assert.equal(slept.length, 1);
  assert.ok(slept[0]! <= 50, `slept ${slept[0]} beyond the remaining budget`);
});

test("a permission-limited read probe passes through so the typed adapter can fail closed on its own terms", async () => {
  const { live } = transport({
    fetchImplementation: async () => new Response(JSON.stringify({ message: "Upgrade to GitHub Pro" }), {
      status: 403, headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(
    await live.request({ method: "GET", path: "/repos/fixture/project/branches/main/protection" }),
    { status: 403, body: { message: "Upgrade to GitHub Pro" } },
  );
});

test("a forbidden mutation is still a fatal authentication failure", async () => {
  const { live } = transport({
    fetchImplementation: async () => new Response("{}", { status: 403, headers: { "content-type": "application/json" } }),
  });

  const error = await live.request({ method: "POST", path: "/repos/fixture/project/pulls", body: { title: "T" } })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GitHubTransportError);
  assert.equal(error.kind, "auth");
});

test("the request deadline covers the response body, not only its headers", async () => {
  const { live } = transport({
    timeoutMilliseconds: 25,
    fetchImplementation: async () => new Response(new ReadableStream({ start() {} }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  });

  const error = await live.request({ method: "GET", path: "/repos/fixture/project/pulls/1" })
    .then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GitHubTransportError);
  assert.equal(error.kind, "timeout");
});

test("a normalized failure releases the response body instead of pinning the connection", async () => {
  let cancelled = false;
  const { live } = transport({
    fetchImplementation: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
      cancel() { cancelled = true; },
    }), { status: 429, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(() => live.request({ method: "GET", path: "/rate_limit" }), /HTTP 429/);
  assert.equal(cancelled, true);
});

test("transport failures scrub credential material out of the error they surface", async () => {
  const { live } = transport({
    fetchImplementation: async () => { throw new Error(`proxy rejected authorization Bearer ${SECRET}`); },
  });

  const error = await live.request({ method: "GET", path: "/rate_limit" }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GitHubTransportError);
  assert.equal(error.kind, "transport");
  assert.equal(`${error.message} ${error.details.join(" ")}`.includes(SECRET), false);
  assert.match(error.details.join(" "), /\[REDACTED\]/);
});

test("the exact-head push is bounded so a stalled forge cannot outlive the Work Run", async () => {
  const invocations: GitPushInvocation[] = [];
  const headSha = "7".repeat(40);
  let remoteHead: string | null = null;
  const { live } = transport({
    fetchImplementation: async () => (remoteHead === null
      ? new Response("", { status: 404 })
      : new Response(JSON.stringify({ object: { sha: remoteHead, type: "commit" } }), {
        status: 200, headers: { "content-type": "application/json" },
      })),
    gitPush: (invocation) => {
      invocations.push(invocation);
      remoteHead = headSha;
      return { status: 0, stderr: "" };
    },
  });

  await live.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  });

  assert.ok(invocations[0]!.timeoutMilliseconds > 0, "the push carried no timeout");
});

test("an idempotent read retries a transient forge failure within the Work Run deadline", async () => {
  const slept: number[] = [];
  let attempts = 0;
  const { live } = transport({
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    fetchImplementation: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("", { status: 502 })
        : new Response(JSON.stringify({ number: 24 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(await live.request({ method: "GET", path: "/repos/fixture/project/pulls/24" }), { status: 200, body: { number: 24 } });
  assert.equal(attempts, 2);
  assert.equal(slept.length, 1);
});

test("a rate-limited read waits the interval the forge asked for", async () => {
  const slept: number[] = [];
  let attempts = 0;
  const { live } = transport({
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    fetchImplementation: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await live.request({ method: "GET", path: "/rate_limit" });
  assert.deepEqual(slept, [2_000]);
});

test("a mutation is never retried, so no forge write can be duplicated by the transport", async () => {
  const slept: number[] = [];
  let attempts = 0;
  const { live } = transport({
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    fetchImplementation: async () => { attempts += 1; return new Response("", { status: 502 }); },
  });

  await assert.rejects(() => live.request({ method: "POST", path: "/repos/fixture/project/pulls", body: { title: "T" } }), /HTTP 502/);
  assert.equal(attempts, 1);
  assert.equal(slept.length, 0);
});

test("a retry exhausted against the deadline surfaces the underlying failure class", async () => {
  const { live } = transport({
    sleep: async () => undefined,
    deadlineAt: () => new Date(Date.now() + 40).toISOString(),
    fetchImplementation: async () => new Response("", { status: 503 }),
  });

  const error = await live.request({ method: "GET", path: "/rate_limit" }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GitHubTransportError);
  assert.equal(error.kind, "transport");
});

test("an exhausted Work Run budget refuses to dispatch to the forge at all", async () => {
  let called = 0;
  const { live } = transport({
    deadlineAt: () => new Date(Date.now() - 1_000).toISOString(),
    fetchImplementation: async () => { called += 1; return new Response("{}", { status: 200 }); },
  });

  const error = await live.request({ method: "GET", path: "/rate_limit" }).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GitHubTransportError);
  assert.equal(error.kind, "timeout");
  assert.equal(called, 0);
});

test("observation backoff resets when the caller reports progress", async () => {
  const slept: number[] = [];
  const { live } = transport({
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    pollIntervalMilliseconds: 1_000,
    maximumPollIntervalMilliseconds: 8_000,
  });
  const deadlineAt = new Date(Date.now() + 3_600_000).toISOString();

  await live.waitForNextObservation(deadlineAt);
  await live.waitForNextObservation(deadlineAt);
  live.resetObservationBackoff();
  await live.waitForNextObservation(deadlineAt);

  assert.deepEqual(slept, [1_000, 2_000, 1_000]);
});

test("a push that could not run at all is reported as such, not as a lease rejection", async () => {
  const headSha = "8".repeat(40);
  const { live } = transport({
    fetchImplementation: async () => new Response("", { status: 404 }),
    gitPush: () => ({ status: 1, stderr: "", signal: "SIGKILL", failure: "spawnSync git ETIMEDOUT" }),
  });

  const error = await live.pushBranch({
    repository: "fixture/project", branch: "graph-shipper/run", headSha,
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }).then(() => null, (caught: unknown) => caught);

  assert.ok(error instanceof Error);
  assert.match(error.message, /could not complete/);
  assert.doesNotMatch(error.message, /was rejected/);
});

test("the live push forwards egress configuration but no ambient credential channel", async () => {
  const previous = { ...process.env };
  process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
  process.env.GIT_ASKPASS = "/tmp/askpass";
  try {
    const invocations: GitPushInvocation[] = [];
    const headSha = "9".repeat(40);
    let remoteHead: string | null = null;
    const { live } = transport({
      fetchImplementation: async () => (remoteHead === null
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ object: { sha: remoteHead, type: "commit" } }), {
          status: 200, headers: { "content-type": "application/json" },
        })),
      gitPush: (invocation) => { invocations.push(invocation); remoteHead = headSha; return { status: 0, stderr: "" }; },
    });

    await live.pushBranch({
      repository: "fixture/project", branch: "graph-shipper/run", headSha,
      expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
    });

    assert.equal(invocations[0]!.environment.HTTPS_PROXY, "http://proxy.invalid:3128");
    assert.equal(invocations[0]!.environment.GIT_ASKPASS, undefined);
  } finally {
    process.env = previous;
  }
});

test("the live transport refuses to act on a repository other than the one it leases against", async () => {
  let invoked = 0;
  const { live } = transport({
    fetchImplementation: async () => new Response("", { status: 404 }),
    gitPush: () => { invoked += 1; return { status: 0, stderr: "" }; },
  });

  await assert.rejects(() => live.pushBranch({
    repository: "fixture/other", branch: "graph-shipper/run", headSha: "c".repeat(40),
    expectedRemoteHeadSha: null, workspacePath: "/tmp/workspace", gitDirectory: "/tmp/git-directory",
  }), /repository identity does not match/);
  await assert.rejects(() => live.fetchCommit({
    repository: "fixture/other", ref: "main", commitSha: "d".repeat(40), workspacePath: "/tmp/primary",
  }), /repository identity does not match/);
  assert.equal(invoked, 0);
});

test("the live transport fetches a merged commit into the primary clone under the operator credential", async () => {
  const invocations: GitPushInvocation[] = [];
  const { live } = transport({
    gitPush: (invocation) => { invocations.push(invocation); return { status: 0, stderr: "" }; },
  });

  await live.fetchCommit({
    repository: "fixture/project", ref: "main", commitSha: "a".repeat(40), workspacePath: "/tmp/primary",
  });

  const invocation = invocations[0]!;
  assert.equal(invocation.workspacePath, "/tmp/primary");
  assert.deepEqual(invocation.args.slice(-3), ["--no-tags", "https://github.com/fixture/project.git", "refs/heads/main"]);
  assert.equal(invocation.args.some((argument) => argument.includes(SECRET)), false);
  assert.equal(
    Object.entries(invocation.environment).some(([key, value]) => key.startsWith("GIT_CONFIG_VALUE_") && String(value).startsWith("Authorization: Basic ")),
    true,
  );
});

test("the default git runner really pushes the leased exact head to a remote", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-push-"));
  try {
    const remote = join(root, "fixture", "project.git");
    mkdirSync(join(root, "fixture"), { recursive: true });
    run("git", ["init", "-q", "--bare", remote], root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    run("git", ["init", "-q", "-b", "main", "."], workspace);
    writeFileSync(join(workspace, "file.txt"), "content\n");
    run("git", ["add", "file.txt"], workspace);
    run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "one"], workspace);
    const headSha = run("git", ["rev-parse", "HEAD"], workspace);

    let reads = 0;
    const fileTransport = new LiveGitHubTransport({
      repository: "fixture/project",
      credentialRef: "github-operator",
      projectId: "fixture-project",
      workRunId: "run-live-1",
      broker: new TestCredentialBroker(),
      remoteBaseUrl: `file://${root}`,
      fetchImplementation: async () => {
        reads += 1;
        return reads === 1
          ? new Response("", { status: 404 })
          : new Response(JSON.stringify({ object: { sha: run("git", ["rev-parse", "refs/heads/graph-shipper/run"], remote), type: "commit" } }), {
            status: 200, headers: { "content-type": "application/json" },
          });
      },
    });

    assert.deepEqual(await fileTransport.pushBranch({
      repository: "fixture/project", branch: "graph-shipper/run", headSha,
      expectedRemoteHeadSha: null, workspacePath: workspace, gitDirectory: join(workspace, ".git"),
    }), { remoteHeadBefore: null, remoteHeadAfter: headSha });
    assert.equal(run("git", ["rev-parse", "refs/heads/graph-shipper/run"], remote), headSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live transport surfaces the pagination link so the typed adapter can read a list to its end", async () => {
  const link = '<https://api.github.com/repos/fixture/project/issues/24/comments?per_page=100&page=2>; rel="next"';
  const { live } = transport({
    fetchImplementation: async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json", link, "x-ratelimit-remaining": "4999" },
    }),
  });

  const response = await live.request({ method: "GET", path: "/repos/fixture/project/issues/24/comments?per_page=100" });

  assert.deepEqual(response, { status: 200, body: [], headers: { link } });
});
