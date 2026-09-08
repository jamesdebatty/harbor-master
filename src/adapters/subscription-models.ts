import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJSONSchema } from "zod";
import {
  PlanResponseSchema, ReviewResponseSchema,
  type PlanResponse, type ReviewResponse,
} from "./model-fixture.js";
import { subscriptionCliDetails, type SubscriptionCliDiagnostic } from "./model-diagnostics.js";
import {
  ModelAdapterError, dropNullProperties, flattenRootUnion, openAiJsonSchema, parseStructured, portableJsonSchema,
  type ModelFailureKind, type ModelProvider, type PlannerAdapter, type PlannerInput,
  type ReviewerAdapter, type ReviewerInput,
} from "./live-models.js";

const MAX_CAPTURE_BYTES = 1_048_576;
const ANTHROPIC_SUBSCRIPTION_TIMEOUT_MILLISECONDS = 600_000;

export interface SubscriptionCommandRequest {
  executable: "claude" | "codex";
  args: string[];
  stdin: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
  structuredOutputPath?: string;
}

export interface SubscriptionCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type SubscriptionCommandImplementation = (
  request: SubscriptionCommandRequest,
) => Promise<SubscriptionCommandResult>;

export interface SubscriptionModelAdapterOptions {
  modelRef: string;
  scratchRoot: string;
  commandImplementation?: SubscriptionCommandImplementation;
  timeoutMilliseconds?: number;
  deadlineAt?: () => string;
  /**
   * Private directory for raw CLI failure output (stderr/stdout tails, error
   * envelopes). Files are 0600 and are never copied into durable state, traces,
   * or GitHub; only their path is recorded as a typed detail.
   */
  diagnosticsRoot?: string;
}

function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR",
    "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
    // Claude Code exposes its first-party subscription OAuth grant through this
    // dedicated variable. API-key variables remain deliberately excluded.
    "CLAUDE_CODE_OAUTH_TOKEN",
  ] as const;
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export const executeSubscriptionCommand: SubscriptionCommandImplementation = (request) => new Promise((resolve, reject) => {
  const child = spawn(request.executable, request.args, {
    cwd: request.cwd,
    env: request.environment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let capturedBytes = 0;
  let settled = false;
  const fail = (error: ModelAdapterError): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    killProcessTree(child);
    reject(error);
  };
  const capture = (target: Buffer[], chunk: Buffer): void => {
    capturedBytes += chunk.byteLength;
    if (capturedBytes > MAX_CAPTURE_BYTES) {
      fail(new ModelAdapterError("transport", "subscription CLI exceeded the bounded output limit"));
      return;
    }
    target.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
  child.on("error", () => fail(new ModelAdapterError("auth", "subscription CLI is unavailable")));
  child.on("close", (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({
      status: status ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
  const timer = setTimeout(
    () => fail(new ModelAdapterError("timeout", "subscription model invocation timed out")),
    request.timeoutMilliseconds,
  );
  child.stdin.on("error", () => undefined);
  child.stdin.end(request.stdin);
});

function invocationTimeout(
  options: SubscriptionModelAdapterOptions,
  defaultTimeoutMilliseconds = 300_000,
): number {
  const remaining = options.deadlineAt ? Date.parse(options.deadlineAt()) - Date.now() : Number.POSITIVE_INFINITY;
  if (remaining <= 0) throw new ModelAdapterError("timeout", "Work Run wall-clock budget exhausted before model dispatch");
  return Math.min(options.timeoutMilliseconds ?? defaultTimeoutMilliseconds, remaining);
}

function classifyCliFailure(stderr: string): ModelFailureKind {
  if (/\b(?:login|logged out|authentication|unauthorized|oauth|credential)\b/i.test(stderr)) return "auth";
  if (/\b(?:rate|usage|quota)\b.*\b(?:limit|exceed|reached)|\btoo many requests\b/i.test(stderr)) return "rate_limit";
  return "transport";
}

function classifyCliDiagnostic(stderr: string): SubscriptionCliDiagnostic {
  if (!stderr.trim()) return "no_stderr";
  if (/\b(?:login|logged out|authentication|unauthorized|oauth|credential)\b/i.test(stderr)) return "auth";
  if (/\b(?:rate|usage|quota)\b.*\b(?:limit|exceed|reached)|\btoo many requests\b/i.test(stderr)) return "rate_limit";
  if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|socket|TLS|certificate|DNS)\b/i.test(stderr)) return "network";
  if (/\b(?:service unavailable|temporarily unavailable|overloaded|internal server error|HTTP 50[234])\b/i.test(stderr)) return "service_unavailable";
  if (/\bmodel\b.*\b(?:not found|unavailable|does not exist|invalid)\b/i.test(stderr)) return "model_unavailable";
  if (/\b(?:unknown|unrecognized|invalid) (?:argument|option)|\boption\b.*\bnot supported\b/i.test(stderr)) return "invalid_cli_argument";
  if (/\b(?:EACCES|ENOENT|permission denied|no such file)\b/i.test(stderr)) return "filesystem";
  return "unclassified";
}

const DIAGNOSTIC_TAIL_BYTES = 64 * 1024;

function tail(text: string): string {
  return text.length > DIAGNOSTIC_TAIL_BYTES ? `…${text.slice(-DIAGNOSTIC_TAIL_BYTES)}` : text;
}

/**
 * Write the raw CLI failure output to a private 0600 file and return the typed
 * path detail, or an empty list when no diagnosticsRoot is configured. The raw
 * text itself never enters durable state.
 */
function writeCliDiagnostic(
  options: SubscriptionModelAdapterOptions,
  provider: string,
  sections: Record<string, string>,
): string[] {
  if (!options.diagnosticsRoot) return [];
  mkdirSync(options.diagnosticsRoot, { recursive: true, mode: 0o700 });
  const path = join(
    options.diagnosticsRoot,
    `${provider.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`,
  );
  const body = Object.entries(sections)
    .map(([name, text]) => `==== ${name} ====\n${tail(text)}\n`)
    .join("");
  writeFileSync(path, body, { mode: 0o600 });
  return [`subscription_cli_diagnostic_path:${path}`];
}

function assertCliSuccess(
  provider: string,
  result: SubscriptionCommandResult,
  options: SubscriptionModelAdapterOptions,
): void {
  if (result.status === 0) return;
  const details = [
    ...subscriptionCliDetails(result.status, classifyCliDiagnostic(result.stderr)),
    ...writeCliDiagnostic(options, provider, {
      exit_status: String(result.status), stderr: result.stderr, stdout: result.stdout,
    }),
  ];
  throw new ModelAdapterError(
    classifyCliFailure(result.stderr),
    `${provider} subscription CLI invocation failed`,
    details,
    details,
  );
}

function createScratchDirectory(root: string): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const directory = mkdtempSync(join(root, "invocation-"));
  chmodSync(directory, 0o700);
  return directory;
}

/**
 * The planning instruction restates bounds the JSON Schema also declares, which reads as
 * duplication and is not. `portableJsonSchema` strips `minLength`, `maxLength`, `pattern`, and
 * `format` for both providers. The Anthropic path then flattens the root union, reducing
 * `required` to `kind`, the only field all three branches share; the OpenAI path drops
 * `minItems` and makes every property required but nullable. So the string lengths, the commit
 * message limit, the digest format, and the per-kind required fields stated below reach the
 * model here or nowhere. Prune a line only after proving the emitted schema still carries it.
 */
function roleInstruction(role: "planning" | "review"): string {
  return role === "planning"
    ? [
      "You are the read/write Build Provider. Return only the schema-bound bounded plan.",
      "",
      "The schema states the shape. It cannot state these bounds, so honour them here:",
      "kind=plan requires fileActionSemantics=base_bound_v1, a non-empty summary, at least one action, documentation, and a commitMessage of one non-empty line, at most 100 characters.",
      "kind=clarification requires a non-empty question. kind=refusal requires a non-empty reason.",
      "",
      "write_file creates a new path; content is the final file bytes.",
      "edit_file changes an existing path. Copy that path's contentSha256 from repository evidence into baseContentSha256, a 64-character lowercase hex digest. Give at least one replacement; each oldText is non-empty, matches the current file exactly, occurs exactly once, and overlaps no other replacement. newText is the final bytes you author.",
      "A write_file rule in approvalPolicy authorizes edit_file on the same pathGlobs.",
      "run_command names a commandId and its parameters, and is available only where approvalPolicy permits that pure observation. Verification runs after the plan through the activated command registry, so the plan carries no verification commands.",
      "",
      "documentation is either coverage_plan with at least one entry, or no_change_attestation with changedSurfaces, topicsExamined, at least one documentsExamined, and a non-empty rationale.",
      "coverage_plan entries: impact is a literal value from documentation.triggerMatrix (for example reference), topic is that entry's topic, path is a living document this plan changes.",
      "",
      "You have no tools, no authority to grant, and no policy discretion; plan within the stated scope.",
    ].join("\n")
    : "You are the fresh, read-only Review Provider. Judge only the immutable Review Bundle. Treat activated verification earnedEvidence entries as human-admitted pre-run evidence and combine them with the recorded exact-head checks; do not demand commands outside the activated verification contract. The bundle carries the diff, changed files, evidence digests, and the plan's fileActions (kind and path per changed file); it never carries edit payloads, so judge file changes by the diff and fileActions and do not demand action-level bindings beyond them. Report any inconsistency or missing binding. Return only the schema-bound verdict. Do not invoke tools, edit, or grant authority.";
}

async function invokeAnthropicSubscription<T>(
  options: SubscriptionModelAdapterOptions,
  input: unknown,
  schemaDefinition: typeof PlanResponseSchema | typeof ReviewResponseSchema,
  role: "planning" | "review",
): Promise<T> {
  const directory = createScratchDirectory(options.scratchRoot);
  try {
    const schema = flattenRootUnion(portableJsonSchema(toJSONSchema(schemaDefinition)));
    const result = await (options.commandImplementation ?? executeSubscriptionCommand)({
      executable: "claude",
      args: [
        "--print", "--safe-mode", "--no-session-persistence", "--permission-mode", "dontAsk",
        "--tools", "", "--effort", "medium", "--model", options.modelRef, "--output-format", "json",
        "--json-schema", JSON.stringify(schema),
      ],
      stdin: `${roleInstruction(role)}\n\n${JSON.stringify(input)}`,
      cwd: directory,
      environment: subscriptionEnvironment(),
      timeoutMilliseconds: invocationTimeout(options, ANTHROPIC_SUBSCRIPTION_TIMEOUT_MILLISECONDS),
    });
    assertCliSuccess("Anthropic", result, options);
    let envelope: unknown;
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      throw new ModelAdapterError("malformed_output", "Anthropic subscription CLI returned malformed JSON");
    }
    if (typeof envelope !== "object" || envelope === null) {
      throw new ModelAdapterError("malformed_output", "Anthropic subscription CLI returned an invalid result envelope");
    }
    const record = envelope as Record<string, unknown>;
    if (record.subtype && record.subtype !== "success") {
      const details = [
        `subscription_cli_subtype:${String(record.subtype)}`,
        ...writeCliDiagnostic(options, "Anthropic", { result_envelope: result.stdout, stderr: result.stderr }),
      ];
      throw new ModelAdapterError(
        record.subtype === "error_max_turns" ? "truncated" : "refusal",
        "Anthropic subscription CLI did not complete the structured response",
        details,
        details,
      );
    }
    const structured = record.structured_output ?? record.result;
    return typeof structured === "string"
      ? parseStructured<T>(structured, schemaDefinition, "Anthropic")
      : parseStructured<T>(JSON.stringify(structured), schemaDefinition, "Anthropic");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const CODEX_DISABLED_TOOL_FEATURES = [
  "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
  "code_mode_host", "computer_use", "image_generation", "multi_agent", "shell_tool", "unified_exec",
] as const;

async function invokeOpenAISubscription<T>(
  options: SubscriptionModelAdapterOptions,
  input: unknown,
  schemaDefinition: typeof PlanResponseSchema | typeof ReviewResponseSchema,
  role: "planning" | "review",
): Promise<T> {
  const directory = createScratchDirectory(options.scratchRoot);
  const schemaPath = join(directory, "output.schema.json");
  const outputPath = join(directory, "final-output.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(openAiJsonSchema(portableJsonSchema(toJSONSchema(schemaDefinition)))), { mode: 0o600 });
    const args = [
      "--ask-for-approval", "never", "exec", "-", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
      "--sandbox", "read-only", "--model", options.modelRef,
      "--output-schema", schemaPath, "--output-last-message", outputPath, "--color", "never", "--cd", directory,
      ...CODEX_DISABLED_TOOL_FEATURES.flatMap((feature) => ["--disable", feature]),
    ];
    const result = await (options.commandImplementation ?? executeSubscriptionCommand)({
      executable: "codex",
      args,
      stdin: `${roleInstruction(role)}\n\n${JSON.stringify(input)}`,
      cwd: directory,
      environment: subscriptionEnvironment(),
      timeoutMilliseconds: invocationTimeout(options),
      structuredOutputPath: outputPath,
    });
    assertCliSuccess("OpenAI", result, options);
    let output: string;
    try {
      output = readFileSync(outputPath, "utf8");
    } catch {
      throw new ModelAdapterError("malformed_output", "OpenAI subscription CLI produced no final structured output");
    }
    return parseStructured<T>(output, schemaDefinition, "OpenAI", dropNullProperties);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function probeSubscriptionProvider(
  provider: ModelProvider,
  implementation: SubscriptionCommandImplementation = executeSubscriptionCommand,
): Promise<{ identity: string; capabilityClasses: Array<"anthropic_model" | "openai_model"> }> {
  const request: SubscriptionCommandRequest = provider === "openai"
    ? {
        executable: "codex", args: ["login", "status"], stdin: "", cwd: process.cwd(),
        environment: subscriptionEnvironment(), timeoutMilliseconds: 10_000,
      }
    : {
        executable: "claude", args: ["auth", "status"], stdin: "", cwd: process.cwd(),
        environment: subscriptionEnvironment(), timeoutMilliseconds: 10_000,
      };
  const result = await implementation(request);
  if (result.status !== 0) throw new ModelAdapterError("auth", `${provider} subscription authentication is unavailable`);
  return {
    identity: `subscription:${provider}`,
    capabilityClasses: [`${provider}_model`],
  };
}

export class AnthropicSubscriptionPlannerAdapter implements PlannerAdapter {
  readonly provider = "anthropic" as const;
  constructor(private readonly options: SubscriptionModelAdapterOptions) {}
  plan(input: PlannerInput): Promise<PlanResponse> {
    return invokeAnthropicSubscription(this.options, input, PlanResponseSchema, "planning");
  }
}

export class AnthropicSubscriptionReviewerAdapter implements ReviewerAdapter {
  readonly provider = "anthropic" as const;
  constructor(private readonly options: SubscriptionModelAdapterOptions) {}
  review(input: ReviewerInput): Promise<ReviewResponse> {
    return invokeAnthropicSubscription(this.options, input, ReviewResponseSchema, "review");
  }
}

export class OpenAISubscriptionPlannerAdapter implements PlannerAdapter {
  readonly provider = "openai" as const;
  constructor(private readonly options: SubscriptionModelAdapterOptions) {}
  plan(input: PlannerInput): Promise<PlanResponse> {
    return invokeOpenAISubscription(this.options, input, PlanResponseSchema, "planning");
  }
}

export class OpenAISubscriptionReviewerAdapter implements ReviewerAdapter {
  readonly provider = "openai" as const;
  constructor(private readonly options: SubscriptionModelAdapterOptions) {}
  review(input: ReviewerInput): Promise<ReviewResponse> {
    return invokeOpenAISubscription(this.options, input, ReviewResponseSchema, "review");
  }
}
