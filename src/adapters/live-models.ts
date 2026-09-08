import { toJSONSchema } from "zod";
import type { CredentialBroker, CredentialRequest } from "../brokers/ports.js";
import { ShipperError } from "../errors.js";
import { OpaqueCredential, consumeOpaqueCredential } from "../security/opaque-credential.js";
import {
  PlanResponseSchema, ReviewResponseSchema,
  type PlanResponse, type ReviewResponse,
} from "./model-fixture.js";

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PlannerInput {
  workItem: unknown;
  contractRules: unknown;
  repositoryEvidence: unknown;
  feedback: unknown;
}

export interface ReviewerInput {
  reviewBundle: unknown;
}

export type ModelProvider = "anthropic" | "openai";

export interface PlannerAdapter {
  readonly provider: ModelProvider;
  plan(input: PlannerInput): Promise<PlanResponse>;
}

export interface ReviewerAdapter {
  readonly provider: ModelProvider;
  review(input: ReviewerInput): Promise<ReviewResponse>;
}

export type ModelFailureKind = "refusal" | "truncated" | "malformed_output" | "timeout" | "rate_limit" | "auth" | "transport";

export class ModelAdapterError extends ShipperError {
  constructor(
    readonly kind: ModelFailureKind,
    message: string,
    details: string[] = [],
    readonly durableDetails: string[] = [],
  ) {
    super(message, 3, details);
    this.name = "ModelAdapterError";
  }
}

export interface ModelAdapterOptions {
  modelRef: string;
  credentialRef: string;
  projectId: string;
  workRunId: string;
  broker: CredentialBroker;
  fetchImplementation?: FetchImplementation;
  timeoutMilliseconds?: number;
  deadlineAt?: () => string;
}

export function portableJsonSchema(schema: unknown): Record<string, unknown> {
  const unsupported = new Set([
    "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "pattern", "format", "$schema",
  ]);
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !unsupported.has(key))
      .map(([key, item]) => [key, sanitize(item)]));
  };
  return sanitize(schema) as Record<string, unknown>;
}

/**
 * Both providers require a single object at the root of a structured-output schema, so a root
 * discriminated union has to collapse into one object. Where two variants declare the same
 * property the last one wins, and the collapsed object only requires the fields every variant
 * shares. A collision between two different types is therefore not merely loose: the surviving
 * type is the only one a provider will emit, so the losing variant becomes unstatable. No
 * response schema collides today except on the discriminator, which is collapsed to an enum.
 */
export function flattenRootUnion(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return schema;
  const record = schema as Record<string, unknown>;
  const variants = Array.isArray(record.oneOf) ? record.oneOf : Array.isArray(record.anyOf) ? record.anyOf : undefined;
  if (!variants || variants.some((variant) => typeof variant !== "object" || variant === null || Array.isArray(variant))) {
    return record;
  }
  const objects = variants as Array<Record<string, unknown>>;
  if (objects.some((variant) => variant.type !== "object" || typeof variant.properties !== "object" || variant.properties === null)) {
    return record;
  }
  const properties = Object.assign({}, ...objects.map((variant) => variant.properties));
  const discriminatorValues = objects.flatMap((variant) => {
    const kind = (variant.properties as Record<string, unknown>).kind;
    if (typeof kind !== "object" || kind === null || Array.isArray(kind)) return [];
    return typeof (kind as Record<string, unknown>).const === "string"
      ? [(kind as Record<string, unknown>).const as string]
      : [];
  });
  if (discriminatorValues.length === objects.length) {
    (properties as Record<string, unknown>).kind = { type: "string", enum: discriminatorValues };
  }
  const requiredLists = objects.map((variant) => Array.isArray(variant.required) ? variant.required : []);
  const required = requiredLists[0]?.filter((field) => requiredLists.every((fields) => fields.includes(field))) ?? [];
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * OpenAI refuses an object whose required list omits a property, so a property a variant may
 * leave out has to be stated as nullable and required instead, and the response carries a null
 * where the value is absent. It also refuses an open object, so an object that declares
 * properties is closed here; no schema this rewrites declares one open.
 */
function requireEveryProperty(schema: Record<string, unknown>): Record<string, unknown> {
  if (typeof schema.properties !== "object" || schema.properties === null) return schema;
  const stated = Array.isArray(schema.required) ? schema.required : [];
  const properties = Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>)
    .map(([name, property]) => [name, stated.includes(name) ? property : { anyOf: [property, { type: "null" }] }]));
  return { ...schema, properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * OpenAI structured outputs accept a narrower schema than Anthropic: the root must be one
 * object, `oneOf` is refused at any depth, every object must require each of its properties,
 * and a validation keyword or a free-form map is refused outright. Rewrite the portable schema
 * into that subset. Loosening costs nothing, because parseStructured still checks the real
 * schema after the call. A free-form map has no expression in the subset at all, so it is
 * refused here rather than at dispatch, where only a provider error would name it.
 */
export function openAiJsonSchema(schema: unknown): Record<string, unknown> {
  const refused = new Set(["propertyNames", "default", "minItems", "maxItems"]);
  const narrow = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(narrow);
    if (value === null || typeof value !== "object") return value;
    const record = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !refused.has(key))
      .map(([key, item]) => [key === "oneOf" ? "anyOf" : key, narrow(item)]));
    if (typeof record.additionalProperties === "object" && record.additionalProperties !== null) {
      throw new ShipperError("a free-form map cannot be stated in the OpenAI structured-output subset", 3);
    }
    return requireEveryProperty(record);
  };
  return requireEveryProperty(flattenRootUnion(narrow(schema)) as Record<string, unknown>);
}

/**
 * Requiring every property makes a variant report the ones it does not carry as null. Drop them
 * before the real schema runs, which is strict and would otherwise reject a plan for carrying a
 * clarification's question. The sweep reaches every depth, because an optional property anywhere
 * in a response schema would be stated this way. It is safe there only because no response schema
 * declares a default: dropping a null a variant should have filled leaves the property missing,
 * which the real schema refuses, rather than substituting a value the model never sent.
 */
export function dropNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNullProperties);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== null)
    .map(([key, item]) => [key, dropNullProperties(item)]));
}

async function authenticatedFetch(
  options: ModelAdapterOptions,
  purpose: CredentialRequest["purpose"],
  url: string,
  createInit: (secret: string, signal: AbortSignal) => RequestInit,
): Promise<Record<string, unknown>> {
  const credential = await options.broker.acquire({
    referenceId: options.credentialRef,
    purpose,
    projectId: options.projectId,
    workRunId: options.workRunId,
  });
  if (!(credential instanceof OpaqueCredential)) {
    credential.dispose();
    throw new ModelAdapterError("auth", "Credential Broker returned an unsupported handle");
  }
  const controller = new AbortController();
  const remainingBudget = options.deadlineAt ? Date.parse(options.deadlineAt()) - Date.now() : Number.POSITIVE_INFINITY;
  if (remainingBudget <= 0) {
    credential.dispose();
    throw new ModelAdapterError("timeout", "Work Run wall-clock budget exhausted before model dispatch");
  }
  const timeoutMilliseconds = Math.min(options.timeoutMilliseconds ?? 120_000, remainingBudget);
  let rejectDeadline: ((error: Error) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => {
    controller.abort();
    rejectDeadline?.(new ModelAdapterError("timeout", "model request timed out"));
  }, timeoutMilliseconds);
  let request: Promise<Response> | undefined;
  // Captured inside the credential scope: dispose() releases the redactor registration, so
  // by the time a failure is reported the redactor can no longer mask what the message quotes.
  let scrub = (text: string): string => text;
  try {
    consumeOpaqueCredential(credential, (secret) => {
      scrub = (text) => text.replaceAll(secret, "[REDACTED]");
      const init = createInit(secret, controller.signal);
      if (typeof init.body === "string" && init.body.includes(secret)) {
        throw new ModelAdapterError("auth", "credential material appeared in the model request body");
      }
      request = (options.fetchImplementation ?? fetch)(url, init);
    });
    if (!request) throw new ModelAdapterError("auth", "credential material was unavailable at the trusted adapter boundary");
    return await Promise.race([
      request.then((response) => checkedJson(response, purpose === "anthropic_model" ? "Anthropic" : "OpenAI")),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof ModelAdapterError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ModelAdapterError("timeout", "model request timed out");
    throw new ModelAdapterError("transport", "model transport failed", [scrub(error instanceof Error ? error.message : String(error))]);
  } finally {
    clearTimeout(timeout);
    credential.dispose();
  }
}

async function checkedJson(response: Response, provider: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const kind: ModelFailureKind = response.status === 401 || response.status === 403
      ? "auth"
      : response.status === 429 ? "rate_limit" : "transport";
    throw new ModelAdapterError(kind, `${provider} returned HTTP ${response.status}`);
  }
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ModelAdapterError("malformed_output", `${provider} returned non-JSON output`);
  }
}

export function parseStructured<T>(source: string, schema: { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, provider: string, normalize: (value: unknown) => unknown = (value) => value): T {
  let raw: unknown;
  try {
    raw = normalize(JSON.parse(source));
  } catch {
    throw new ModelAdapterError("malformed_output", `${provider} returned malformed structured JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelAdapterError("malformed_output", `${provider} output failed the portable schema`, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  return parsed.data as T;
}

async function invokeAnthropic<T>(
  options: ModelAdapterOptions,
  input: unknown,
  schemaDefinition: typeof PlanResponseSchema | typeof ReviewResponseSchema,
  role: "planning" | "review",
): Promise<T> {
    const schema = portableJsonSchema(toJSONSchema(schemaDefinition));
    const body = await authenticatedFetch(options, "anthropic_model", "https://api.anthropic.com/v1/messages", (secret, signal) => ({
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: options.modelRef,
        max_tokens: 16_384,
        system: role === "planning"
          ? "You are the read/write Build Provider. Return only the schema-bound bounded plan. You cannot grant authority, infer policy, invoke tools, or expand product scope."
          : "You are the fresh, read-only Review Provider. Judge only the immutable Review Bundle. Never edit, grant authority, or treat schema validity as approval.",
        messages: [{ role: "user", content: JSON.stringify(input) }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    }));
    if (body.stop_reason === "refusal") throw new ModelAdapterError("refusal", `Anthropic refused the ${role} request`);
    if (body.stop_reason === "max_tokens") throw new ModelAdapterError("truncated", `Anthropic ${role} output was truncated`);
    const content = Array.isArray(body.content) ? body.content : [];
    const text = content.find((item): item is { type: string; text: string } => (
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"
    ))?.text;
    if (!text) throw new ModelAdapterError("malformed_output", "Anthropic response contained no structured text block");
    return parseStructured(text, schemaDefinition, "Anthropic") as T;
}

async function invokeOpenAI<T>(
  options: ModelAdapterOptions,
  input: unknown,
  schemaDefinition: typeof PlanResponseSchema | typeof ReviewResponseSchema,
  role: "planning" | "review",
): Promise<T> {
    const schema = openAiJsonSchema(portableJsonSchema(toJSONSchema(schemaDefinition)));
    const body = await authenticatedFetch(options, "openai_model", "https://api.openai.com/v1/responses", (secret, signal) => ({
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: options.modelRef,
        store: false,
        instructions: role === "planning"
          ? "You are the read/write Build Provider. Return only the schema-bound bounded plan. You cannot grant authority, infer policy, invoke tools, or expand product scope."
          : "You are the fresh, read-only Review Provider. Judge only the immutable Review Bundle. Never edit, grant authority, or treat schema validity as approval.",
        input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(input) }] }],
        text: { format: { type: "json_schema", name: role === "planning" ? "graph_shipper_plan" : "graph_shipper_review_verdict", strict: true, schema } },
      }),
    }));
    if (body.status === "incomplete") throw new ModelAdapterError("truncated", `OpenAI ${role} output was incomplete`);
    const output = Array.isArray(body.output) ? body.output : [];
    for (const item of output) {
      if (typeof item !== "object" || item === null || !Array.isArray((item as { content?: unknown }).content)) continue;
      for (const content of (item as { content: unknown[] }).content) {
        if (typeof content !== "object" || content === null) continue;
        if ((content as { type?: unknown }).type === "refusal") throw new ModelAdapterError("refusal", "OpenAI refused the review request");
        if ((content as { type?: unknown }).type === "output_text" && typeof (content as { text?: unknown }).text === "string") {
          return parseStructured((content as { text: string }).text, schemaDefinition, "OpenAI", dropNullProperties) as T;
        }
      }
    }
    throw new ModelAdapterError("malformed_output", "OpenAI response contained no structured output text");
}

export class AnthropicPlannerAdapter implements PlannerAdapter {
  readonly provider = "anthropic" as const;
  constructor(private readonly options: ModelAdapterOptions) {}
  plan(input: PlannerInput): Promise<PlanResponse> {
    return invokeAnthropic<PlanResponse>(this.options, input, PlanResponseSchema, "planning");
  }
}

export class AnthropicReviewerAdapter implements ReviewerAdapter {
  readonly provider = "anthropic" as const;
  constructor(private readonly options: ModelAdapterOptions) {}
  review(input: ReviewerInput): Promise<ReviewResponse> {
    return invokeAnthropic<ReviewResponse>(this.options, input, ReviewResponseSchema, "review");
  }
}

export class OpenAIPlannerAdapter implements PlannerAdapter {
  readonly provider = "openai" as const;
  constructor(private readonly options: ModelAdapterOptions) {}
  plan(input: PlannerInput): Promise<PlanResponse> {
    return invokeOpenAI<PlanResponse>(this.options, input, PlanResponseSchema, "planning");
  }
}

export class OpenAIReviewerAdapter implements ReviewerAdapter {
  readonly provider = "openai" as const;
  constructor(private readonly options: ModelAdapterOptions) {}
  review(input: ReviewerInput): Promise<ReviewResponse> {
    return invokeOpenAI<ReviewResponse>(this.options, input, ReviewResponseSchema, "review");
  }
}
