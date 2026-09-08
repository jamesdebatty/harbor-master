import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AnthropicSubscriptionPlannerAdapter, ModelAdapterError,
  OpenAISubscriptionPlannerAdapter, OpenAISubscriptionReviewerAdapter, probeSubscriptionProvider,
  type SubscriptionCommandImplementation, type SubscriptionCommandRequest,
} from "../src/index.js";
import { assertOpenAiSchemaSubset } from "./helpers.js";

const PLAN = {
  kind: "plan" as const,
  fileActionSemantics: "base_bound_v1" as const,
  summary: "Implement one bounded change.",
  actions: [{ kind: "write_file" as const, path: "src/value.js", content: "export const value = 1;\n" }],
  documentation: {
    kind: "no_change_attestation" as const,
    changedSurfaces: ["internal module"], topicsExamined: ["overview"], documentsExamined: ["README.md"],
    rationale: "No public behavior changed.",
  },
  commitMessage: "Add internal value",
};

function capture(handler: (request: SubscriptionCommandRequest) => Promise<{ status: number; stdout: string; stderr: string }>) {
  const requests: SubscriptionCommandRequest[] = [];
  const implementation: SubscriptionCommandImplementation = async (request) => {
    requests.push(request);
    return handler(request);
  };
  return { requests, implementation };
}

test("Anthropic subscription planner is schema-bound, tool-free, and isolated from ambient secrets", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-anthropic-"));
  const previous = process.env.GRAPH_SHIPPER_TEST_AMBIENT_SECRET;
  const previousOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.GRAPH_SHIPPER_TEST_AMBIENT_SECRET = "must-not-cross-process-boundary";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "subscription-oauth-token";
  try {
    const observed = capture(async () => ({
      status: 0,
      stdout: JSON.stringify({ type: "result", subtype: "success", structured_output: PLAN }),
      stderr: "",
    }));
    const adapter = new AnthropicSubscriptionPlannerAdapter({
      modelRef: "sonnet", scratchRoot, commandImplementation: observed.implementation,
    });

    const response = await adapter.plan({ workItem: { id: "item-1" }, contractRules: {}, repositoryEvidence: [], feedback: [] });

    assert.deepEqual(response, PLAN);
    assert.equal(observed.requests.length, 1);
    const request = observed.requests[0];
    assert.ok(request);
    assert.equal(request.executable, "claude");
    assert.equal(request.args.includes("--print"), true);
    assert.equal(request.args.includes("--safe-mode"), true);
    assert.equal(request.args.includes("--no-session-persistence"), true);
    assert.equal(request.stdin.includes("A write_file rule in approvalPolicy authorizes edit_file"), true);
    assert.equal(request.stdin.includes("impact is a literal value from documentation.triggerMatrix"), true);
    assert.deepEqual(request.args.slice(request.args.indexOf("--effort"), request.args.indexOf("--effort") + 2), ["--effort", "medium"]);
    assert.deepEqual(request.args.slice(request.args.indexOf("--tools"), request.args.indexOf("--tools") + 2), ["--tools", ""]);
    assert.equal(request.args.includes("--json-schema"), true);
    const schemaFlag = request.args.indexOf("--json-schema");
    const schema = JSON.parse(request.args[schemaFlag + 1] ?? "{}") as Record<string, any>;
    assert.equal(schema.type, "object");
    assert.equal(schema.oneOf, undefined);
    assert.deepEqual(schema.properties.kind.enum, ["plan", "clarification", "refusal"]);
    assert.deepEqual(schema.required, ["kind"]);
    assert.equal(request.stdin.includes("item-1"), true);
    assert.equal(request.stdin.includes("kind=plan requires"), true);
    assert.equal(request.stdin.includes("fileActionSemantics"), true);
    assert.equal(request.stdin.includes("Verification runs after the plan"), true);
    assert.equal(request.stdin.includes("must-not-cross-process-boundary"), false);
    assert.equal(request.environment.GRAPH_SHIPPER_TEST_AMBIENT_SECRET, undefined);
    assert.equal(request.environment.CLAUDE_CODE_OAUTH_TOKEN, "subscription-oauth-token");
    assert.equal(request.environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(request.cwd.startsWith(scratchRoot), true);
    assert.equal(request.timeoutMilliseconds, 600_000);
  } finally {
    if (previous === undefined) delete process.env.GRAPH_SHIPPER_TEST_AMBIENT_SECRET;
    else process.env.GRAPH_SHIPPER_TEST_AMBIENT_SECRET = previous;
    if (previousOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauthToken;
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("the planning instruction carries every bound the emitted schema drops", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-bounds-"));
  try {
    const observed = capture(async () => ({
      status: 0,
      stdout: JSON.stringify({ type: "result", subtype: "success", structured_output: PLAN }),
      stderr: "",
    }));
    const adapter = new AnthropicSubscriptionPlannerAdapter({
      modelRef: "sonnet", scratchRoot, commandImplementation: observed.implementation,
    });

    await adapter.plan({ workItem: { id: "item-1" }, contractRules: {}, repositoryEvidence: [], feedback: [] });

    const request = observed.requests[0];
    assert.ok(request);
    const schemaFlag = request.args.indexOf("--json-schema");
    assert.notEqual(schemaFlag, -1);
    const emitted = request.args[schemaFlag + 1];
    assert.ok(emitted);
    // Portability strips every string bound and root flattening reduces `required` to the
    // shared discriminator, so the schema the model receives states none of the following.
    for (const dropped of ["minLength", "maxLength", "pattern", "format"]) {
      assert.equal(emitted.includes(dropped), false, `${dropped} still reaches the model`);
    }
    assert.deepEqual((JSON.parse(emitted) as { required: string[] }).required, ["kind"]);

    // The instruction is therefore the only carrier for them.
    assert.equal(request.stdin.includes("non-empty summary"), true);
    assert.equal(request.stdin.includes("at most 100 characters"), true);
    assert.equal(request.stdin.includes("kind=clarification requires a non-empty question"), true);
    assert.equal(request.stdin.includes("kind=refusal requires a non-empty reason"), true);
    assert.equal(request.stdin.includes("each oldText is non-empty"), true);
    assert.equal(request.stdin.includes("occurs exactly once"), true);
    assert.equal(request.stdin.includes("at least one documentsExamined"), true);
    assert.equal(request.stdin.includes("the plan carries no verification commands"), true);
    // Repository evidence exposes contentSha256; baseContentSha256 is the plan field it feeds.
    assert.equal(request.stdin.includes("Copy that path's contentSha256 from repository evidence into baseContentSha256"), true);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("OpenAI subscription reviewer uses ephemeral read-only Codex execution and reads only the final schema output", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-openai-"));
  try {
    let writtenOutput = "";
    const observed = capture(async (request) => {
      assert.ok(request.structuredOutputPath);
      writeFileSync(request.structuredOutputPath, JSON.stringify({
        verdict: "approve", summary: "The exact-head bundle is consistent.", findings: [],
      }));
      writtenOutput = readFileSync(request.structuredOutputPath, "utf8");
      return { status: 0, stdout: "untrusted progress output", stderr: "" };
    });
    const adapter = new OpenAISubscriptionReviewerAdapter({
      modelRef: "gpt-5.6-sol", scratchRoot, commandImplementation: observed.implementation,
    });

    const response = await adapter.review({ reviewBundle: { headSha: "b".repeat(40) } });

    assert.equal(response.verdict, "approve");
    const request = observed.requests[0];
    assert.ok(request);
    assert.equal(request.executable, "codex");
    assert.equal(request.timeoutMilliseconds, 300_000);
    assert.equal(request.stdin.includes("earnedEvidence"), true);
    assert.equal(request.stdin.includes("fileActions"), true);
    assert.deepEqual(request.args.slice(0, 4), ["--ask-for-approval", "never", "exec", "-"]);
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--output-schema", "--output-last-message"]) {
      assert.equal(request.args.includes(flag), true, flag);
    }
    assert.deepEqual(request.args.slice(request.args.indexOf("--sandbox"), request.args.indexOf("--sandbox") + 2), ["--sandbox", "read-only"]);
    assert.equal(writtenOutput.includes("exact-head"), true);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("OpenAI subscription planner emits a subset schema and drops the null placeholders it forces", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-openai-plan-"));
  try {
    let writtenSchema = "";
    const observed = capture(async (request) => {
      assert.ok(request.structuredOutputPath);
      const schemaFlag = request.args.indexOf("--output-schema");
      writtenSchema = readFileSync(request.args[schemaFlag + 1] ?? "", "utf8");
      writeFileSync(request.structuredOutputPath, JSON.stringify({
        ...PLAN, question: null, reason: null,
      }));
      return { status: 0, stdout: "untrusted progress output", stderr: "" };
    });
    const adapter = new OpenAISubscriptionPlannerAdapter({
      modelRef: "gpt-5.6-sol", scratchRoot, commandImplementation: observed.implementation,
    });

    const response = await adapter.plan({ workItem: { id: "item-1" }, contractRules: {}, repositoryEvidence: [], feedback: [] });

    assert.deepEqual(response, PLAN);
    const schema = JSON.parse(writtenSchema) as Record<string, any>;
    assert.equal(schema.type, "object");
    assertOpenAiSchemaSubset(schema);
    assert.deepEqual(schema.properties.kind.enum, ["plan", "clarification", "refusal"]);
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("subscription provider probes classify login and missing executable failures without exposing CLI output", async () => {
  const authenticated: SubscriptionCommandImplementation = async () => ({
    status: 0, stdout: "Logged in using ChatGPT", stderr: "",
  });
  assert.deepEqual(await probeSubscriptionProvider("openai", authenticated), {
    identity: "subscription:openai", capabilityClasses: ["openai_model"],
  });

  const unauthenticated: SubscriptionCommandImplementation = async () => ({
    status: 1, stdout: "", stderr: "Please login with private-account@example.com",
  });
  await assert.rejects(
    () => probeSubscriptionProvider("anthropic", unauthenticated),
    (error: unknown) => error instanceof ModelAdapterError
      && error.kind === "auth"
      && !error.message.includes("private-account@example.com"),
  );
});

test("subscription adapters normalize timeout, rate-limit, process, and malformed-output failures", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-errors-"));
  try {
    const cases = [
      { result: { status: 1, stdout: "", stderr: "usage limit reached" }, kind: "rate_limit" },
      { result: { status: 1, stdout: "", stderr: "unexpected process failure" }, kind: "transport" },
      { result: { status: 0, stdout: "not-json", stderr: "" }, kind: "malformed_output" },
    ] as const;
    for (const scenario of cases) {
      const adapter = new AnthropicSubscriptionPlannerAdapter({
        modelRef: "sonnet", scratchRoot, commandImplementation: async () => scenario.result,
      });
      await assert.rejects(
        () => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
        (error: unknown) => error instanceof ModelAdapterError && error.kind === scenario.kind,
      );
    }
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("subscription CLI failures expose only typed credential-free diagnostics", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-diagnostics-"));
  try {
    const adapter = new AnthropicSubscriptionPlannerAdapter({
      modelRef: "sonnet",
      scratchRoot,
      commandImplementation: async () => ({
        status: 1,
        stdout: "",
        stderr: "socket ECONNRESET while using bearer opaque-super-secret for private-account@example.com",
      }),
    });

    await assert.rejects(
      () => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
      (error: unknown) => {
        assert.ok(error instanceof ModelAdapterError);
        assert.equal(error.kind, "transport");
        assert.deepEqual(error.details, [
          "subscription_cli_exit_status:1",
          "subscription_cli_diagnostic:network",
        ]);
        assert.doesNotMatch(JSON.stringify(error), /opaque-super-secret|private-account@example\.com|ECONNRESET/);
        return true;
      },
    );
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("subscription CLI failures write raw output to a private diagnostics file and expose only its path", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-diagfile-"));
  const diagnosticsRoot = join(scratchRoot, "diagnostics", "run-1");
  try {
    const adapter = new AnthropicSubscriptionPlannerAdapter({
      modelRef: "sonnet",
      scratchRoot,
      diagnosticsRoot,
      commandImplementation: async () => ({
        status: 1,
        stdout: "",
        stderr: "socket ECONNRESET while using bearer opaque-super-secret for private-account@example.com",
      }),
    });

    await assert.rejects(
      () => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
      (error: unknown) => {
        assert.ok(error instanceof ModelAdapterError);
        assert.equal(error.kind, "transport");
        assert.equal(error.details.length, 3);
        assert.deepEqual(error.details.slice(0, 2), [
          "subscription_cli_exit_status:1",
          "subscription_cli_diagnostic:network",
        ]);
        const pathDetail = error.details[2] ?? "";
        assert.match(pathDetail, /^subscription_cli_diagnostic_path:/);
        assert.deepEqual(error.durableDetails, error.details);
        assert.doesNotMatch(JSON.stringify(error), /opaque-super-secret|private-account@example\.com|ECONNRESET/);
        const path = pathDetail.slice("subscription_cli_diagnostic_path:".length);
        assert.ok(path.startsWith(diagnosticsRoot));
        const body = readFileSync(path, "utf8");
        assert.match(body, /==== exit_status ====\n1\n/);
        assert.match(body, /socket ECONNRESET while using bearer opaque-super-secret/);
        if (process.platform !== "win32") {
          assert.equal(statSync(path).mode & 0o777, 0o600);
        }
        return true;
      },
    );
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test("Anthropic error envelopes record the subtype and preserve the envelope in the diagnostics file", async () => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-subtype-"));
  const diagnosticsRoot = join(scratchRoot, "diagnostics", "run-2");
  try {
    const adapter = new AnthropicSubscriptionPlannerAdapter({
      modelRef: "sonnet",
      scratchRoot,
      diagnosticsRoot,
      commandImplementation: async () => ({
        status: 0,
        stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in · Please run /login" }),
        stderr: "",
      }),
    });

    await assert.rejects(
      () => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
      (error: unknown) => {
        assert.ok(error instanceof ModelAdapterError);
        assert.equal(error.kind, "refusal");
        assert.equal(error.details[0], "subscription_cli_subtype:error_during_execution");
        const pathDetail = error.details[1] ?? "";
        assert.match(pathDetail, /^subscription_cli_diagnostic_path:/);
        assert.doesNotMatch(JSON.stringify(error), /Not logged in/);
        const body = readFileSync(pathDetail.slice("subscription_cli_diagnostic_path:".length), "utf8");
        assert.match(body, /Not logged in · Please run \/login/);
        return true;
      },
    );
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});
