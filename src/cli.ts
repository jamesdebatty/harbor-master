#!/usr/bin/env node

import { resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { collectAdmissionCandidate } from "./contracts/admission.js";
import { validateProjectContract } from "./contracts/validate.js";
import { ShipperError } from "./errors.js";
import { collectRuntimeDiagnostics } from "./runtime/diagnostics.js";
import { assertExternalDataRoot, resolveDataRoot, sameRealPath } from "./runtime/paths.js";
import { readExistingActivation, readExistingWorkRunStatus, StateStore } from "./state/store.js";
import { VERSION } from "./version.js";
import { executeLocalWorkRun } from "./work-runs/engine.js";
import { RunRequestSchema, loadRunRequest } from "./work-runs/schema.js";

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string | true>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (["json", "version", "help", "allow-credentialed-model-calls", "allow-disposable-fixture-reconciliation", "allow-disposable-fixture-operations", "allow-live-github-mutations", "allow-live-merge", "allow-live-operational-hooks"].includes(name)) {
      options.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    options.set(name, value);
    index += 1;
  }
  return { positionals, options };
}

function requiredString(options: Map<string, string | true>, name: string): string {
  const value = options.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function workRunAdapterOptions(options: Map<string, string | true>): {
  adapterFixturePath?: string;
  githubFixturePath?: string;
  allowCredentialedModelCalls?: true;
  allowDisposableFixtureReconciliation?: true;
  allowDisposableFixtureOperations?: true;
  allowLiveGitHubMutations?: true;
  allowLiveMerge?: true;
  allowLiveOperationalHooks?: true;
} {
  const adapterFixture = options.get("adapter-fixture");
  const githubFixture = options.get("github-fixture");
  const allowCredentialed = options.has("allow-credentialed-model-calls");
  if ((typeof adapterFixture === "string") === allowCredentialed) {
    throw new ShipperError("choose exactly one of --adapter-fixture or --allow-credentialed-model-calls", 3);
  }
  return {
    ...(typeof adapterFixture === "string" ? { adapterFixturePath: adapterFixture } : {}),
    ...(typeof githubFixture === "string" ? { githubFixturePath: githubFixture } : {}),
    ...(allowCredentialed ? { allowCredentialedModelCalls: true as const } : {}),
    ...(options.has("allow-disposable-fixture-reconciliation") ? { allowDisposableFixtureReconciliation: true as const } : {}),
    ...(options.has("allow-disposable-fixture-operations") ? { allowDisposableFixtureOperations: true as const } : {}),
    ...(options.has("allow-live-github-mutations") ? { allowLiveGitHubMutations: true as const } : {}),
    ...(options.has("allow-live-merge") ? { allowLiveMerge: true as const } : {}),
    ...(options.has("allow-live-operational-hooks") ? { allowLiveOperationalHooks: true as const } : {}),
  };
}

function write(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

function usage(): string {
  return [
    "graph-shipper contract validate --project <path> [--json]",
    "graph-shipper contract onboard --project <path> [--data-root <path>] [--json]",
    "graph-shipper contract activate --project <path> --contract-digest <sha256> --admission-evidence-digest <sha256> --confirm-project <project-id> [--data-root <path>] [--json]",
    "graph-shipper status (--project <path> | --run-id <id>) [--data-root <path>] [--json]",
    "graph-shipper run --project <path> --request <path> (--adapter-fixture <path> | --allow-credentialed-model-calls) [--github-fixture <path> | --allow-live-github-mutations] [--allow-disposable-fixture-reconciliation] [--allow-live-merge] [--allow-live-operational-hooks] [--allow-disposable-fixture-operations] [--run-id <id>] [--data-root <path>] [--json]",
    "graph-shipper resume --run-id <id> --project <path> (--adapter-fixture <path> | --allow-credentialed-model-calls) [--github-fixture <path> | --allow-live-github-mutations] [--allow-disposable-fixture-reconciliation] [--allow-live-merge] [--allow-live-operational-hooks] [--allow-disposable-fixture-operations] [--data-root <path>] [--json]",
    "graph-shipper diagnostics [--data-root <path>] [--json]",
    "graph-shipper --version",
    "Fault-injection options for offline recovery tests: --crash-after-intent <effect> --crash-after-effect <effect> --crash-after-receipt <effect> --crash-at-node <phase>",
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.options.has("version") || parsed.positionals[0] === "version") {
      write(VERSION, parsed.options.has("json"));
      return;
    }
    if (parsed.options.has("help") || parsed.positionals.length === 0) {
      write(usage(), false);
      return;
    }
    if (parsed.positionals[0] === "contract" && parsed.positionals[1] === "validate") {
      const projectRoot = resolve(requiredString(parsed.options, "project"));
      const validation = validateProjectContract(projectRoot);
      const output = {
        ok: validation.ok,
        projectId: validation.projectId,
        schemaVersion: validation.schemaVersion,
        contractDigest: validation.contractDigest,
        canonicalPath: validation.canonicalPath,
        errors: validation.errors,
      };
      write(output, parsed.options.has("json"));
      if (!validation.ok) process.exitCode = 3;
      return;
    }
    if (parsed.positionals[0] === "contract" && parsed.positionals[1] === "onboard") {
      const candidate = collectAdmissionCandidate(requiredString(parsed.options, "project"));
      const dataRoot = resolveDataRoot(typeof parsed.options.get("data-root") === "string" ? parsed.options.get("data-root") as string : undefined);
      assertExternalDataRoot(candidate.projectRoot, dataRoot);
      const store = new StateStore(dataRoot);
      try {
        const validatedAt = new Date().toISOString();
        store.onboard({
          projectId: candidate.contract.metadata.projectId,
          projectRoot: candidate.projectRoot,
          githubRepository: candidate.contract.repository.github,
          contractDigest: candidate.contractDigest,
          contractBlobSha: candidate.contractBlobSha,
          admissionEvidenceDigest: candidate.admissionEvidenceDigest,
          schemaVersion: candidate.contract.metadata.schemaVersion,
          contractSnapshot: candidate.contract,
          admissionEvidence: candidate.admissionEvidence,
          validatedAt,
        });
        write({
          ok: true,
          status: "pending",
          projectId: candidate.contract.metadata.projectId,
          contractDigest: candidate.contractDigest,
          contractBlobSha: candidate.contractBlobSha,
          admissionEvidenceDigest: candidate.admissionEvidenceDigest,
          validatedAt,
        }, parsed.options.has("json"));
      } finally {
        store.close();
      }
      return;
    }
    if (parsed.positionals[0] === "contract" && parsed.positionals[1] === "activate") {
      const candidate = collectAdmissionCandidate(requiredString(parsed.options, "project"));
      const requestedContractDigest = requiredString(parsed.options, "contract-digest");
      const requestedEvidenceDigest = requiredString(parsed.options, "admission-evidence-digest");
      const confirmedProject = requiredString(parsed.options, "confirm-project");
      if (confirmedProject !== candidate.contract.metadata.projectId) {
        throw new ShipperError("human confirmation does not match the Project Contract identity", 4);
      }
      const approvedBy = userInfo().username;
      if (candidate.contractDigest !== requestedContractDigest) throw new ShipperError("current contract digest does not match the approved digest", 4);
      if (candidate.admissionEvidenceDigest !== requestedEvidenceDigest) throw new ShipperError("current admission evidence does not match the approved digest", 4);
      const dataRoot = resolveDataRoot(typeof parsed.options.get("data-root") === "string" ? parsed.options.get("data-root") as string : undefined);
      assertExternalDataRoot(candidate.projectRoot, dataRoot);
      const store = new StateStore(dataRoot);
      try {
        const pending = store.findCandidate(candidate.contract.metadata.projectId, requestedContractDigest, requestedEvidenceDigest);
        if (!pending || pending.contract_blob_sha !== candidate.contractBlobSha) {
          throw new ShipperError("no matching pending admission candidate; run contract onboard after the latest committed contract change", 4);
        }
        const approvedAt = new Date().toISOString();
        store.activate({
          projectId: candidate.contract.metadata.projectId,
          projectRoot: candidate.projectRoot,
          contractDigest: candidate.contractDigest,
          contractBlobSha: candidate.contractBlobSha,
          admissionEvidenceDigest: candidate.admissionEvidenceDigest,
          approvedBy,
          approvedAt,
        });
        write({ ok: true, status: "active", projectId: candidate.contract.metadata.projectId, contractDigest: candidate.contractDigest, approvedBy, approvedAt }, parsed.options.has("json"));
      } finally {
        store.close();
      }
      return;
    }
    if (parsed.positionals[0] === "run") {
      const projectRoot = resolve(requiredString(parsed.options, "project"));
      const request = loadRunRequest(requiredString(parsed.options, "request"));
      const candidate = collectAdmissionCandidate(projectRoot, { requireClean: false });
      const dataRoot = resolveDataRoot(typeof parsed.options.get("data-root") === "string" ? parsed.options.get("data-root") as string : undefined);
      assertExternalDataRoot(projectRoot, dataRoot);
      const activation = readExistingActivation(dataRoot, candidate.contract.metadata.projectId, candidate.projectRoot);
      const current = activation?.status === "active"
        && activation.contractDigest === candidate.contractDigest
        && activation.contractBlobSha === candidate.contractBlobSha
        && activation.admissionEvidenceDigest === candidate.admissionEvidenceDigest;
      if (!current) throw new ShipperError("Project Contract activation is missing or stale", 4);
      if (request.workItem.projectId !== candidate.contract.metadata.projectId) {
        throw new ShipperError("Work Item project does not match the activated Project Contract", 3);
      }
      const result = await executeLocalWorkRun({
        projectRoot,
        dataRoot,
        contract: candidate.contract,
        contractDigest: candidate.contractDigest,
        request,
        ...workRunAdapterOptions(parsed.options),
        runtimeRoot: fileURLToPath(new URL("..", import.meta.url)),
        ...(typeof parsed.options.get("run-id") === "string" ? { runId: parsed.options.get("run-id") as string } : {}),
        ...(typeof parsed.options.get("crash-after-intent") === "string" ? { crashAfterIntent: parsed.options.get("crash-after-intent") as string } : {}),
        ...(typeof parsed.options.get("crash-after-effect") === "string" ? { crashAfterEffect: parsed.options.get("crash-after-effect") as string } : {}),
        ...(typeof parsed.options.get("crash-after-receipt") === "string" ? { crashAfterReceipt: parsed.options.get("crash-after-receipt") as string } : {}),
        ...(typeof parsed.options.get("crash-at-node") === "string" ? { crashAtNode: parsed.options.get("crash-at-node") as string } : {}),
      });
      write(result, parsed.options.has("json"));
      return;
    }
    if (parsed.positionals[0] === "resume") {
      const runId = requiredString(parsed.options, "run-id");
      const projectRoot = resolve(requiredString(parsed.options, "project"));
      const dataRoot = resolveDataRoot(typeof parsed.options.get("data-root") === "string" ? parsed.options.get("data-root") as string : undefined);
      assertExternalDataRoot(projectRoot, dataRoot);
      const store = new StateStore(dataRoot);
      let saved;
      try {
        saved = store.workRun(runId);
      } finally {
        store.close();
      }
      if (!saved) throw new ShipperError(`unknown Work Run: ${runId}`, 3);
      const parsedRequest = RunRequestSchema.safeParse(saved.state.request);
      if (!parsedRequest.success) throw new ShipperError("persisted Run Request is invalid", 3);
      const candidate = collectAdmissionCandidate(projectRoot, { requireClean: false });
      const activation = readExistingActivation(dataRoot, candidate.contract.metadata.projectId, candidate.projectRoot);
      const current = activation?.status === "active"
        && activation.contractDigest === candidate.contractDigest
        && activation.contractBlobSha === candidate.contractBlobSha
        && activation.admissionEvidenceDigest === candidate.admissionEvidenceDigest;
      if (!current || candidate.contractDigest !== saved.contractDigest) throw new ShipperError("Project Contract activation is missing, stale, or changed since the Work Run", 4);
      const result = await executeLocalWorkRun({
        projectRoot, dataRoot, contract: candidate.contract, contractDigest: candidate.contractDigest,
        request: parsedRequest.data,
        ...workRunAdapterOptions(parsed.options),
        runtimeRoot: fileURLToPath(new URL("..", import.meta.url)),
        runId,
        resume: true,
      });
      write(result, parsed.options.has("json"));
      return;
    }
    if (parsed.positionals[0] === "status") {
      const requestedRunId = parsed.options.get("run-id");
      if (typeof requestedRunId === "string") {
        const dataRoot = resolveDataRoot(typeof parsed.options.get("data-root") === "string" ? parsed.options.get("data-root") as string : undefined);
        const { run, pendingEffect } = readExistingWorkRunStatus(dataRoot, requestedRunId);
        if (!run) throw new ShipperError(`unknown Work Run: ${requestedRunId}`, 3);
        const request = run.state.request as { autonomy?: unknown } | undefined;
        const delivery = request?.autonomy === "open_pr" || request?.autonomy === "merge_when_green" ? {
          autonomy: request.autonomy,
          headSha: run.state.headSha ?? null,
          pullRequest: run.state.pullRequest ?? null,
          hosted: run.state.hosted ?? null,
          sourceRevision: run.state.sourceRevision ?? null,
          ...(request.autonomy === "merge_when_green" ? {
            reviewPublication: run.state.reviewPublication ?? null,
            mergeGuard: run.state.mergeGuard ?? null,
            merge: run.state.merge ?? null,
            postMerge: run.state.postMerge ?? null,
            terminal: run.state.terminal ?? null,
            sourceClosure: run.state.sourceClosure ?? null,
            cleanup: run.state.cleanup ?? null,
          } : {}),
        } : null;
        const errors = Array.isArray(run.state.errors)
          ? run.state.errors.filter((error): error is string => typeof error === "string")
          : [];
        const repair = {
          active: ["running", "paused"].includes(run.status) && errors.length > 0,
          iteration: typeof run.state.iteration === "number" ? run.state.iteration : null,
          reviewAttempt: typeof run.state.reviewAttempt === "number" ? run.state.reviewAttempt : null,
          reasons: errors,
        };
        write({
          ok: true,
          runId: run.runId,
          projectId: run.projectId,
          phase: run.phase,
          status: run.status,
          delivery,
          repair,
          escalationReason: run.status === "escalated" ? errors.at(-1) ?? "unknown escalation" : null,
          state: run.state,
          pendingEffect: pendingEffect ?? null,
        }, parsed.options.has("json"));
        return;
      }
      const projectRoot = resolve(requiredString(parsed.options, "project"));
      const validation = validateProjectContract(projectRoot);
      const bound = validation.contract !== undefined
        && sameRealPath(validation.contract.repository.primaryCloneRealpath, projectRoot);
      if (!validation.projectId || (!validation.ok && !bound)) throw new ShipperError("Project Contract validation failed", 3, validation.errors);
      const dataRoot = resolveDataRoot(typeof parsed.options.get("data-root") === "string" ? parsed.options.get("data-root") as string : undefined);
      assertExternalDataRoot(projectRoot, dataRoot);
      const activation = readExistingActivation(dataRoot, validation.projectId, projectRoot);
      const candidate = validation.ok ? collectAdmissionCandidate(projectRoot, { requireClean: false, requireRepositoryIdentity: false }) : null;
      const current = candidate !== null
        && activation?.status === "active"
        && activation.contractDigest === validation.contractDigest
        && activation.contractBlobSha === candidate.contractBlobSha
        && activation.admissionEvidenceDigest === candidate.admissionEvidenceDigest;
      const report = {
        projectId: validation.projectId,
        contractDigest: validation.contractDigest,
        activation: !activation ? "inactive" : current ? "active" : "stale",
        activationContractDigest: activation?.contractDigest ?? null,
        admissionEvidence: !activation
          ? "inactive"
          : candidate !== null && activation.admissionEvidenceDigest === candidate.admissionEvidenceDigest ? "current" : "stale",
        current,
      };
      if (!validation.ok) {
        const json = parsed.options.has("json");
        if (!json) process.stderr.write(`Project Contract validation failed\n${validation.errors.join("\n")}\n`);
        write({ ok: false, error: "Project Contract validation failed", details: validation.errors, ...report }, json);
        process.exitCode = 3;
        return;
      }
      write({ ok: true, ...report }, parsed.options.has("json"));
      return;
    }
    if (parsed.positionals[0] === "diagnostics") {
      const explicitDataRoot = parsed.options.get("data-root");
      const dataRoot = resolveDataRoot(typeof explicitDataRoot === "string" ? explicitDataRoot : undefined);
      write(collectRuntimeDiagnostics(dataRoot), parsed.options.has("json"));
      return;
    }
    throw new Error(`unknown command: ${parsed.positionals.join(" ")}`);
  } catch (error) {
    if (error instanceof ShipperError) {
      const payload = { ok: false, error: error.message, details: error.details };
      if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stderr.write(`${error.message}${error.details.length ? `\n${error.details.join("\n")}` : ""}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
      process.exitCode = 2;
    }
  }
}

await main();
