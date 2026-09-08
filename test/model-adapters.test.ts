import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialBroker, CredentialRequest } from "../src/brokers/ports.js";
import {
  AnthropicPlannerAdapter, AnthropicReviewerAdapter, ModelAdapterError,
  OpenAIPlannerAdapter, OpenAIReviewerAdapter, PlanResponseSchema,
} from "../src/index.js";
import { OpaqueCredential } from "../src/security/opaque-credential.js";
import { PersistenceRedactor } from "../src/security/redact.js";
import { dropNullProperties, openAiJsonSchema } from "../src/adapters/live-models.js";
import { assertOpenAiSchemaSubset } from "./helpers.js";

class TestCredentialBroker implements CredentialBroker {
  readonly redactor = new PersistenceRedactor();
  readonly acquired: OpaqueCredential[] = [];

  async probe(request: CredentialRequest) {
    return { referenceId: request.referenceId, identity: "offline-test", capabilityClasses: [request.purpose] };
  }

  async acquire(request: CredentialRequest) {
    const credential = OpaqueCredential.create(request.referenceId, "provider-secret-value", this.redactor);
    this.acquired.push(credential);
    return credential;
  }
}

test("plan responses require the base-bound file-action semantics marker", () => {
  const parsed = PlanResponseSchema.safeParse({
    kind: "plan",
    summary: "Implement one bounded change.",
    actions: [{ kind: "write_file", path: "src/value.js", content: "export const value = 1;\n" }],
    documentation: {
      kind: "no_change_attestation",
      changedSurfaces: ["internal module"], topicsExamined: ["overview"], documentsExamined: ["README.md"],
      rationale: "No public behavior changed.",
    },
    commitMessage: "Add internal value",
  });

  assert.equal(parsed.success, false);
});

test("Anthropic planner uses current structured-output shape without putting credentials in the prompt", async () => {
  const broker = new TestCredentialBroker();
  let observedBody = "";
  let observedHeader = "";
  const adapter = new AnthropicPlannerAdapter({
    modelRef: "configured-anthropic-model",
    credentialRef: "anthropic-default",
    projectId: "fixture-project",
    workRunId: "run-1",
    broker,
    fetchImplementation: async (_input, init) => {
      observedBody = String(init?.body);
      observedHeader = new Headers(init?.headers).get("x-api-key") ?? "";
      return new Response(JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({
          kind: "plan",
          fileActionSemantics: "base_bound_v1",
          summary: "Implement one bounded change.",
          actions: [{ kind: "write_file", path: "src/value.js", content: "export const value = 1;\n" }],
          documentation: {
            kind: "no_change_attestation",
            changedSurfaces: ["internal module"],
            topicsExamined: ["overview"],
            documentsExamined: ["README.md"],
            rationale: "No public behavior changed.",
          },
          commitMessage: "Add internal value",
        }) }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await adapter.plan({ workItem: { id: "item-1" }, contractRules: { autonomy: "local_only" }, repositoryEvidence: [], feedback: [] });

  assert.equal(response.kind, "plan");
  assert.equal(observedHeader, "provider-secret-value");
  assert.doesNotMatch(observedBody, /provider-secret-value/);
  const body = JSON.parse(observedBody) as Record<string, any>;
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.model, "configured-anthropic-model");
  assert.throws(() => broker.acquired[0]?.toJSON(), /cannot be serialized/);
});

test("OpenAI reviewer uses Responses structured output with store disabled and normalizes exact JSON", async () => {
  const broker = new TestCredentialBroker();
  let observedBody = "";
  let observedAuthorization = "";
  const adapter = new OpenAIReviewerAdapter({
    modelRef: "configured-openai-model",
    credentialRef: "openai-default",
    projectId: "fixture-project",
    workRunId: "run-1",
    broker,
    fetchImplementation: async (_input, init) => {
      observedBody = String(init?.body);
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
          verdict: "approve",
          summary: "The exact-head bundle is consistent.",
          findings: [],
        }) }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await adapter.review({ reviewBundle: { baseSha: "a".repeat(40), headSha: "b".repeat(40) } });

  assert.equal(response.verdict, "approve");
  assert.equal(observedAuthorization, "Bearer provider-secret-value");
  assert.doesNotMatch(observedBody, /provider-secret-value/);
  const body = JSON.parse(observedBody) as Record<string, any>;
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
});

test("OpenAI planner compiles the portable plan schema and normalizes a plan", async () => {
  const broker = new TestCredentialBroker();
  let observedBody = "";
  const adapter = new OpenAIPlannerAdapter({
    modelRef: "configured-openai-build",
    credentialRef: "openai-default",
    projectId: "fixture-project",
    workRunId: "run-openai-plan",
    broker,
    fetchImplementation: async (_input, init) => {
      observedBody = String(init?.body);
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          kind: "plan",
          fileActionSemantics: "base_bound_v1",
          summary: "Implement the bounded change.",
          actions: [{ kind: "write_file", path: "src/value.js", content: "export const value = 1;\n" }],
          documentation: {
            kind: "no_change_attestation", changedSurfaces: ["internal module"], topicsExamined: ["overview"],
            documentsExamined: ["README.md"], rationale: "No public behavior changed.",
          },
          commitMessage: "Add internal value",
        }) }] }],
      }), { status: 200 });
    },
  });

  const response = await adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} });

  assert.equal(response.kind, "plan");
  const body = JSON.parse(observedBody) as Record<string, any>;
  assert.equal(body.store, false);
  assert.equal(body.text.format.name, "graph_shipper_plan");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.type, "object");
  assertOpenAiSchemaSubset(body.text.format.schema);
  assert.deepEqual(body.text.format.schema.properties.kind.enum, ["plan", "clarification", "refusal"]);
});

test("OpenAI planner drops the null placeholders the collapsed root schema forces", async () => {
  const plannerFor = (text: string) => new OpenAIPlannerAdapter({
    modelRef: "configured-openai-build",
    credentialRef: "openai-default",
    projectId: "fixture-project",
    workRunId: "run-openai-null",
    broker: new TestCredentialBroker(),
    fetchImplementation: async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ content: [{ type: "output_text", text }] }],
    }), { status: 200 }),
  });

  const refusal = await plannerFor(JSON.stringify({
    kind: "refusal", reason: "The work item is out of scope.",
    summary: null, actions: null, documentation: null, commitMessage: null, question: null,
  })).plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} });
  assert.deepEqual(refusal, { kind: "refusal", reason: "The work item is out of scope." });

  await assert.rejects(
    () => plannerFor(JSON.stringify({
      kind: "plan", fileActionSemantics: "base_bound_v1",
      summary: null, actions: null, documentation: null, commitMessage: null,
    })).plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
    (error: unknown) => error instanceof ModelAdapterError && error.kind === "malformed_output",
  );

  await assert.rejects(
    () => plannerFor(JSON.stringify({
      kind: "plan",
      fileActionSemantics: "base_bound_v1",
      summary: "Run the declared observation.",
      actions: [{ kind: "run_command", commandId: "fixture-verify", parameters: null }],
      documentation: { kind: "coverage_plan", entries: [{ impact: "release_record", topic: "overview", path: "README.md" }] },
      commitMessage: "Observe the gate",
    })).plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
    (error: unknown) => error instanceof ModelAdapterError && error.kind === "malformed_output",
  );

  await assert.rejects(
    () => plannerFor(JSON.stringify({
      kind: "plan",
      fileActionSemantics: "base_bound_v1",
      summary: "Run the declared observation.",
      actions: [{ kind: "run_command", commandId: "fixture-verify", parameters: [
        { name: "target", value: "src" }, { name: "target", value: "docs" },
      ] }],
      documentation: { kind: "coverage_plan", entries: [{ impact: "release_record", topic: "overview", path: "README.md" }] },
      commitMessage: "Observe the gate",
    })).plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
    (error: unknown) => error instanceof ModelAdapterError && error.kind === "malformed_output",
  );

  await assert.rejects(
    () => plannerFor(JSON.stringify({
      kind: "plan",
      fileActionSemantics: "base_bound_v1",
      summary: "Run the declared observation.",
      actions: [{ kind: "run_command", commandId: "fixture-verify" }],
      documentation: { kind: "coverage_plan", entries: [{ impact: "release_record", topic: "overview", path: "README.md" }] },
      commitMessage: "Observe the gate",
    })).plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
    (error: unknown) => error instanceof ModelAdapterError && error.kind === "malformed_output",
  );
});

test("the null sweep reaches a placeholder wherever a required-everything object could force one", () => {
  assert.deepEqual(
    dropNullProperties({
      kind: "plan",
      question: null,
      actions: [{ kind: "write_file", path: "src/value.js", reason: null }],
      documentation: { kind: "coverage_plan", rationale: null, entries: [{ path: "README.md", topic: null }] },
    }),
    {
      kind: "plan",
      actions: [{ kind: "write_file", path: "src/value.js" }],
      documentation: { kind: "coverage_plan", entries: [{ path: "README.md" }] },
    },
  );
});

test("the OpenAI subset rewrite reaches every depth and refuses what it cannot state", () => {
  const rewritten = openAiJsonSchema({
    type: "object",
    properties: {
      nested: { type: "object", properties: { always: { type: "string" }, sometimes: { type: "string" } }, required: ["always"] },
      choice: { oneOf: [{ type: "string" }, { type: "number" }] },
    },
    required: ["nested", "choice"],
  });

  assertOpenAiSchemaSubset(rewritten);
  const nested = (rewritten.properties as Record<string, any>).nested;
  assert.deepEqual(nested.required, ["always", "sometimes"]);
  assert.deepEqual(nested.properties.sometimes, { anyOf: [{ type: "string" }, { type: "null" }] });
  assert.deepEqual((rewritten.properties as Record<string, any>).choice.anyOf, [{ type: "string" }, { type: "number" }]);

  assert.throws(
    () => openAiJsonSchema({ type: "object", properties: { map: { type: "object", additionalProperties: { type: "string" } } }, required: ["map"] }),
    /free-form map/,
  );
});

test("Anthropic reviewer compiles the portable verdict schema and normalizes a verdict", async () => {
  const broker = new TestCredentialBroker();
  let observedBody = "";
  const adapter = new AnthropicReviewerAdapter({
    modelRef: "configured-anthropic-review",
    credentialRef: "anthropic-default",
    projectId: "fixture-project",
    workRunId: "run-anthropic-review",
    broker,
    fetchImplementation: async (_input, init) => {
      observedBody = String(init?.body);
      return new Response(JSON.stringify({
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify({ verdict: "approve", summary: "Exact-head evidence passes.", findings: [] }) }],
      }), { status: 200 });
    },
  });

  const response = await adapter.review({ reviewBundle: { headSha: "b".repeat(40) } });

  assert.equal(response.verdict, "approve");
  const body = JSON.parse(observedBody) as Record<string, any>;
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.system.includes("fresh, read-only Review Provider"), true);
});

test("model deadline remains active while a response body is being consumed", async () => {
  const broker = new TestCredentialBroker();
  const delayedBody = new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      }, 100);
    },
  });
  const adapter = new OpenAIReviewerAdapter({
    modelRef: "configured-openai-model",
    credentialRef: "openai-default",
    projectId: "fixture-project",
    workRunId: "run-body-timeout",
    broker,
    timeoutMilliseconds: 20,
    fetchImplementation: async () => new Response(delayedBody, { status: 200 }),
  });

  await assert.rejects(
    () => adapter.review({ reviewBundle: {} }),
    (error: unknown) => error instanceof ModelAdapterError && error.kind === "timeout",
  );
});

test("provider transport failures retain actionable auth, rate-limit, and malformed-output classifications", async () => {
  const cases = [
    { status: 401, body: "{}", kind: "auth" },
    { status: 429, body: "{}", kind: "rate_limit" },
    { status: 200, body: "not-json", kind: "malformed_output" },
  ] as const;
  for (const scenario of cases) {
    const adapter = new OpenAIReviewerAdapter({
      modelRef: "configured-openai-model",
      credentialRef: "openai-default",
      projectId: "fixture-project",
      workRunId: `run-${scenario.kind}`,
      broker: new TestCredentialBroker(),
      fetchImplementation: async () => new Response(scenario.body, { status: scenario.status }),
    });

    await assert.rejects(
      () => adapter.review({ reviewBundle: {} }),
      (error: unknown) => error instanceof ModelAdapterError && error.kind === scenario.kind,
    );
  }
});

test("model adapters distinguish structured refusal, truncation, and schema-invalid output", async () => {
  const cases = [
    { stopReason: "refusal", kind: "refusal" },
    { stopReason: "max_tokens", kind: "truncated" },
  ] as const;
  for (const scenario of cases) {
    const adapter = new AnthropicPlannerAdapter({
      modelRef: "configured-anthropic-model",
      credentialRef: "anthropic-default",
      projectId: "fixture-project",
      workRunId: `run-${scenario.kind}`,
      broker: new TestCredentialBroker(),
      fetchImplementation: async () => new Response(JSON.stringify({
        stop_reason: scenario.stopReason,
        content: [],
      }), { status: 200 }),
    });

    await assert.rejects(
      () => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
      (error: unknown) => error instanceof ModelAdapterError && error.kind === scenario.kind,
    );
  }

  const reviewerCases = [
    {
      body: { status: "completed", output: [{ content: [{ type: "refusal" }] }] },
      kind: "refusal",
    },
    { body: { status: "incomplete", output: [] }, kind: "truncated" },
    {
      body: { status: "completed", output: [{ content: [{ type: "output_text", text: "{}" }] }] },
      kind: "malformed_output",
    },
  ] as const;
  for (const scenario of reviewerCases) {
    const adapter = new OpenAIReviewerAdapter({
      modelRef: "configured-openai-model",
      credentialRef: "openai-default",
      projectId: "fixture-project",
      workRunId: `run-${scenario.kind}`,
      broker: new TestCredentialBroker(),
      fetchImplementation: async () => new Response(JSON.stringify(scenario.body), { status: 200 }),
    });

    await assert.rejects(
      () => adapter.review({ reviewBundle: {} }),
      (error: unknown) => error instanceof ModelAdapterError && error.kind === scenario.kind,
    );
  }
});

test("all providers normalize common Planner and Reviewer fixtures byte-semantically", async () => {
  const expectedPlan = {
    kind: "plan" as const,
    fileActionSemantics: "base_bound_v1" as const,
    summary: "Implement the shared fixture.",
    actions: [{ kind: "write_file" as const, path: "src/shared.js", content: "export const shared = true;\n" }],
    documentation: {
      kind: "no_change_attestation" as const,
      changedSurfaces: ["internal module"], topicsExamined: ["overview"], documentsExamined: ["README.md"],
      rationale: "No public documentation surface changed.",
    },
    commitMessage: "Add shared fixture",
  };
  const expectedReview = {
    verdict: "approve" as const,
    summary: "The shared exact-head fixture passes.",
    findings: [],
  };
  const anthropicResponse = (value: unknown) => new Response(JSON.stringify({
    stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(value) }],
  }), { status: 200 });
  const openAIResponse = (value: unknown) => new Response(JSON.stringify({
    status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(value) }] }],
  }), { status: 200 });

  const planners = [
    new AnthropicPlannerAdapter({
      modelRef: "anthropic-build", credentialRef: "anthropic-default", projectId: "fixture-project", workRunId: "shared-plan",
      broker: new TestCredentialBroker(), fetchImplementation: async () => anthropicResponse(expectedPlan),
    }),
    new OpenAIPlannerAdapter({
      modelRef: "openai-build", credentialRef: "openai-default", projectId: "fixture-project", workRunId: "shared-plan",
      broker: new TestCredentialBroker(), fetchImplementation: async () => openAIResponse(expectedPlan),
    }),
  ];
  for (const planner of planners) {
    const actual = await planner.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} });
    assert.deepEqual(actual, expectedPlan);
    assert.equal(JSON.stringify(actual), JSON.stringify(expectedPlan));
  }

  const reviewers = [
    new AnthropicReviewerAdapter({
      modelRef: "anthropic-review", credentialRef: "anthropic-default", projectId: "fixture-project", workRunId: "shared-review",
      broker: new TestCredentialBroker(), fetchImplementation: async () => anthropicResponse(expectedReview),
    }),
    new OpenAIReviewerAdapter({
      modelRef: "openai-review", credentialRef: "openai-default", projectId: "fixture-project", workRunId: "shared-review",
      broker: new TestCredentialBroker(), fetchImplementation: async () => openAIResponse(expectedReview),
    }),
  ];
  for (const reviewer of reviewers) {
    const actual = await reviewer.review({ reviewBundle: {} });
    assert.deepEqual(actual, expectedReview);
    assert.equal(JSON.stringify(actual), JSON.stringify(expectedReview));
  }
});

test("every Planner and Reviewer implementation shares the provider-neutral failure taxonomy", async () => {
  const implementations = [
    {
      name: "anthropic-planner",
      create: (fetchImplementation: typeof fetch, timeoutMilliseconds = 120_000) => new AnthropicPlannerAdapter({
        modelRef: "model", credentialRef: "anthropic-default", projectId: "fixture-project", workRunId: "conformance",
        broker: new TestCredentialBroker(), fetchImplementation, timeoutMilliseconds,
      }),
      invoke: (adapter: any) => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
      refusal: { stop_reason: "refusal", content: [] },
      truncated: { stop_reason: "max_tokens", content: [] },
      malformed: { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] },
    },
    {
      name: "anthropic-reviewer",
      create: (fetchImplementation: typeof fetch, timeoutMilliseconds = 120_000) => new AnthropicReviewerAdapter({
        modelRef: "model", credentialRef: "anthropic-default", projectId: "fixture-project", workRunId: "conformance",
        broker: new TestCredentialBroker(), fetchImplementation, timeoutMilliseconds,
      }),
      invoke: (adapter: any) => adapter.review({ reviewBundle: {} }),
      refusal: { stop_reason: "refusal", content: [] },
      truncated: { stop_reason: "max_tokens", content: [] },
      malformed: { stop_reason: "end_turn", content: [{ type: "text", text: "{}" }] },
    },
    {
      name: "openai-planner",
      create: (fetchImplementation: typeof fetch, timeoutMilliseconds = 120_000) => new OpenAIPlannerAdapter({
        modelRef: "model", credentialRef: "openai-default", projectId: "fixture-project", workRunId: "conformance",
        broker: new TestCredentialBroker(), fetchImplementation, timeoutMilliseconds,
      }),
      invoke: (adapter: any) => adapter.plan({ workItem: {}, contractRules: {}, repositoryEvidence: {}, feedback: {} }),
      refusal: { status: "completed", output: [{ content: [{ type: "refusal" }] }] },
      truncated: { status: "incomplete", output: [] },
      malformed: { status: "completed", output: [{ content: [{ type: "output_text", text: "{}" }] }] },
    },
    {
      name: "openai-reviewer",
      create: (fetchImplementation: typeof fetch, timeoutMilliseconds = 120_000) => new OpenAIReviewerAdapter({
        modelRef: "model", credentialRef: "openai-default", projectId: "fixture-project", workRunId: "conformance",
        broker: new TestCredentialBroker(), fetchImplementation, timeoutMilliseconds,
      }),
      invoke: (adapter: any) => adapter.review({ reviewBundle: {} }),
      refusal: { status: "completed", output: [{ content: [{ type: "refusal" }] }] },
      truncated: { status: "incomplete", output: [] },
      malformed: { status: "completed", output: [{ content: [{ type: "output_text", text: "{}" }] }] },
    },
  ];

  for (const implementation of implementations) {
    const responseFailureCases = [
      { kind: "refusal", body: implementation.refusal },
      { kind: "truncated", body: implementation.truncated },
      { kind: "malformed_output", body: implementation.malformed },
      { kind: "auth", status: 401, body: {} },
      { kind: "rate_limit", status: 429, body: {} },
    ] as const;
    for (const scenario of responseFailureCases) {
      const adapter = implementation.create(async () => new Response(JSON.stringify(scenario.body), {
        status: "status" in scenario ? scenario.status : 200,
      }));
      await assert.rejects(
        () => implementation.invoke(adapter),
        (error: unknown) => error instanceof ModelAdapterError && error.kind === scenario.kind,
        `${implementation.name}:${scenario.kind}`,
      );
    }
    const transportAdapter = implementation.create(async () => { throw new Error("offline transport failure"); });
    await assert.rejects(
      () => implementation.invoke(transportAdapter),
      (error: unknown) => error instanceof ModelAdapterError && error.kind === "transport",
      `${implementation.name}:transport`,
    );
    const timeoutAdapter = implementation.create(async () => await new Promise<Response>(() => undefined), 5);
    await assert.rejects(
      () => implementation.invoke(timeoutAdapter),
      (error: unknown) => error instanceof ModelAdapterError && error.kind === "timeout",
      `${implementation.name}:timeout`,
    );
  }
});

test("a transport failure whose message quotes the credential is scrubbed before it becomes a detail", async () => {
  const broker = new TestCredentialBroker();
  const adapter = new AnthropicPlannerAdapter({
    modelRef: "configured-anthropic-model",
    credentialRef: "anthropic-default",
    projectId: "fixture-project",
    workRunId: "run-scrub",
    broker,
    fetchImplementation: async () => {
      throw new Error("connect ECONNREFUSED while sending x-api-key: provider-secret-value");
    },
  });

  await assert.rejects(
    () => adapter.plan({ workItem: { id: "item-1" }, contractRules: { autonomy: "local_only" }, repositoryEvidence: [], feedback: [] }),
    (error: unknown) => {
      assert.ok(error instanceof ModelAdapterError);
      assert.equal(error.kind, "transport");
      assert.doesNotMatch(error.details.join("\n"), /provider-secret-value/);
      assert.match(error.details.join("\n"), /ECONNREFUSED/);
      return true;
    },
  );
});
