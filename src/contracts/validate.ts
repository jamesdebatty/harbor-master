import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { isSensitiveKey } from "../security/sensitive-key.js";
import { sameRealPath } from "../runtime/paths.js";
import {
  admittedExecutableErrors, authorizationSourceClosureErrors, authorizationSourceErrors,
  authorizationSourceCommitEligibilityErrors, authorizationSourcePresenceErrors, canonicalAuthorizationSource, environmentPasslistErrors,
  localOnlyCommandShapeErrors,
} from "./command-shape.js";
import { globMatchesEveryProjectPath } from "./globs.js";
import { ProjectContractSchema, type ProjectContract } from "./schema.js";

const autonomyRank = { local_only: 0, open_pr: 1, merge_when_green: 2 } as const;
export interface ContractValidation {
  ok: boolean;
  canonicalPath: string;
  contractDigest: string;
  projectId: string | null;
  schemaVersion: string | null;
  contract?: ProjectContract;
  errors: string[];
}

function duplicateIds(items: ReadonlyArray<{ id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    seen.add(item.id);
  }
  return [...duplicates];
}

function secretBearingKeys(value: unknown, path = "contract"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => secretBearingKeys(item, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(isSensitiveKey(key) ? [`${path}.${key}`] : []),
    ...secretBearingKeys(item, `${path}.${key}`),
  ]);
}

function referencedPlaceholders(argv: string[]): string[] {
  return argv.flatMap((argument) => argument.match(/\{[a-z_]+\}/g) ?? []);
}

function semanticErrors(contract: ProjectContract, projectRoot: string): string[] {
  const errors: string[] = [];
  const commands = new Map(contract.commands.map((command) => [command.id, command]));
  const workspacePreparationCommandRefs = new Set(contract.workspace.strategy === "managed_git_worktree"
    ? contract.workspace.preparationCommandRefs
    : []);
  const credentials = new Set(contract.credentials.references.map((reference) => reference.id));
  const credentialPurposes = new Map(contract.credentials.references.map((reference) => [reference.id, reference.purpose]));
  const operationalEnvironmentNames = new Map<string, string[]>();
  for (const reference of contract.credentials.references.filter((candidate) => candidate.purpose === "post_merge_operation")) {
    const name = reference.id.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
    operationalEnvironmentNames.set(name, [...operationalEnvironmentNames.get(name) ?? [], reference.id]);
  }
  for (const ids of operationalEnvironmentNames.values()) {
    if (ids.length > 1) errors.push(`post-merge credential references ${ids.join(" and ")} map to the same isolated environment name`);
  }
  const hookCommandIds = new Set([
    ...contract.postMergeHooks.flatMap((hook) => [hook.commandRef, hook.successCheckCommandRef]),
    ...contract.compensatingHooks.flatMap((hook) => [
      hook.commandRef,
      hook.priorStateCaptureCommandRef,
      hook.successCheckCommandRef,
    ]),
  ]);

  const groups: Array<[string, ReadonlyArray<{ id: string }>]> = [
    ["credential", contract.credentials.references],
    ["executable", contract.executableAllowlist],
    ["command", contract.commands],
    ["build assignment", contract.models.buildAssignments],
    ["review assignment", contract.models.reviewAssignments],
    ["policy rule", contract.approvalPolicy.rules],
    ["verification check", contract.verification.checks],
    ["documentation rule", contract.documentation.rules],
    ["post-merge hook", contract.postMergeHooks],
    ["compensating hook", contract.compensatingHooks],
  ];
  for (const [label, items] of groups) {
    for (const id of duplicateIds(items)) errors.push(`duplicate ${label} id: ${id}`);
  }

  for (const entry of contract.executableAllowlist) {
    errors.push(...admittedExecutableErrors(entry));
  }

  if (!sameRealPath(contract.repository.primaryCloneRealpath, projectRoot)) {
    errors.push(`repository.primaryCloneRealpath ${contract.repository.primaryCloneRealpath} does not name this project`);
  }

  for (const command of contract.commands) {
    errors.push(...localOnlyCommandShapeErrors(command, contract.executableAllowlist));
    errors.push(...authorizationSourceErrors(command));
    errors.push(...authorizationSourceClosureErrors(command, projectRoot));
    errors.push(...authorizationSourcePresenceErrors(command, projectRoot));
    errors.push(...authorizationSourceCommitEligibilityErrors(command, projectRoot));
    errors.push(...environmentPasslistErrors(command));
    for (const placeholder of referencedPlaceholders(command.argv)) {
      const name = placeholder.slice(1, -1);
      if (!(name in command.parameters)) errors.push(`${command.id}: undeclared placeholder ${placeholder}`);
    }
    for (const argument of command.argv) {
      const placeholders = argument.match(/\{[a-z_]+\}/g) ?? [];
      if (placeholders.length > 0 && (placeholders.length !== 1 || argument !== placeholders[0])) {
        errors.push(`${command.id}: placeholders must occupy a whole argv element: ${argument}`);
      }
    }
    for (const credentialRef of command.credentialRefs) {
      if (!credentials.has(credentialRef)) errors.push(`${command.id}: unknown credential reference ${credentialRef}`);
      else if (credentialPurposes.get(credentialRef) === "github_operator") {
        errors.push(`${command.id}: GitHub operator credentials require the typed GitHub Adapter`);
      } else if (credentialPurposes.get(credentialRef) !== "post_merge_operation" || !hookCommandIds.has(command.id)) {
        errors.push(`${command.id}: generic commands may receive only declared Post-Merge Hook credentials`);
      }
    }
  }

  for (const assignment of [...contract.models.buildAssignments, ...contract.models.reviewAssignments]) {
    if (assignment.transport === "api") {
      if (!credentials.has(assignment.credentialRef)) errors.push(`${assignment.id}: unknown credential reference ${assignment.credentialRef}`);
      const requiredPurpose = assignment.provider === "anthropic" ? "anthropic_model" : "openai_model";
      if (credentials.has(assignment.credentialRef) && credentialPurposes.get(assignment.credentialRef) !== requiredPurpose) {
        errors.push(`${assignment.id}: ${assignment.provider} assignment requires a ${requiredPurpose} credential reference`);
      }
    }
  }
  for (const [role, assignments] of [
    ["build", contract.models.buildAssignments],
    ["review", contract.models.reviewAssignments],
    ] as const) {
    const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
    for (const assignment of assignments) {
      const seen = new Set<string>();
      for (const fallbackId of assignment.fallbackAssignmentIds) {
        const fallback = byId.get(fallbackId);
        if (!fallback) {
          const otherRole = role === "build" ? contract.models.reviewAssignments : contract.models.buildAssignments;
          errors.push(otherRole.some((candidate) => candidate.id === fallbackId)
            ? `${assignment.id}: fallback ${fallbackId} is not a ${role} assignment`
            : `${assignment.id}: unknown fallback assignment ${fallbackId}`);
          continue;
        }
        if (seen.has(fallbackId)) errors.push(`${assignment.id}: duplicate fallback assignment ${fallbackId}`);
        seen.add(fallbackId);
        if (fallback.provider !== assignment.provider) {
          errors.push(`${assignment.id}: fallback ${fallbackId} must remain on ${assignment.provider}`);
        }
        if (fallback.transport !== assignment.transport) {
          errors.push(`${assignment.id}: fallback ${fallbackId} must retain ${assignment.transport} transport`);
        }
      }
    }
    const reportedCycles = new Set<string>();
    const visit = (assignmentId: string, path: string[]): void => {
      const cycleAt = path.indexOf(assignmentId);
      if (cycleAt >= 0) {
        const cycle = [...path.slice(cycleAt), assignmentId].join(" -> ");
        if (!reportedCycles.has(cycle)) errors.push(`cyclic ${role} fallback assignments: ${cycle}`);
        reportedCycles.add(cycle);
        return;
      }
      const assignment = byId.get(assignmentId);
      if (!assignment) return;
      for (const fallbackId of assignment.fallbackAssignmentIds) visit(fallbackId, [...path, assignmentId]);
    };
    for (const assignment of assignments) visit(assignment.id, []);
  }
  for (const build of contract.models.buildAssignments) {
    if (!contract.models.reviewAssignments.some((review) => review.provider !== build.provider)) {
      errors.push(`${build.id}: no opposite-provider reviewer exists`);
    }
  }

  if (autonomyRank[contract.autonomy.default] > autonomyRank[contract.autonomy.maximum]) {
    errors.push("default autonomy exceeds maximum autonomy");
  }
  if (contract.github.pullRequest.baseBranch !== contract.repository.defaultBranch) {
    errors.push("pull-request base must equal the repository default branch");
  }
  if (autonomyRank[contract.autonomy.maximum] >= autonomyRank.open_pr) {
    const sourceReference = contract.github.pullRequest.sourceReference;
    if (!sourceReference) errors.push("open_pr requires a contract-declared neutral source reference");
    else if (/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/i.test(sourceReference.prefix)) {
      errors.push("pull-request source reference must not contain an auto-close keyword");
    }
    const githubOperators = contract.credentials.references.filter((reference) => reference.purpose === "github_operator");
    if (githubOperators.length !== 1) errors.push("open_pr requires exactly one GitHub operator credential reference");
  }
  if (contract.autonomy.maximum === "merge_when_green" && contract.github.requiredHostedChecks.length === 0) {
    errors.push("merge_when_green requires at least one hosted check");
  }
  if (contract.concurrency.defaultWorkRuns > contract.concurrency.maximumWorkRuns) {
    errors.push("default concurrency exceeds maximum concurrency");
  }

  if (contract.workspace.strategy === "managed_git_worktree") {
    const seen = new Set<string>();
    for (const commandRef of contract.workspace.preparationCommandRefs) {
      if (seen.has(commandRef)) errors.push(`${commandRef}: duplicate workspace preparation command`);
      seen.add(commandRef);
      const command = commands.get(commandRef);
      if (!command) {
        errors.push(`${commandRef}: workspace preparation command is missing`);
        continue;
      }
      if (command.cwd !== "worktree" || command.sideEffect !== "workspace"
        || command.idempotence !== "idempotent" || command.credentialRefs.length > 0) {
        errors.push(`${commandRef}: workspace preparation command must be credential-free, idempotent, declare the workspace side effect, and run in the worktree`);
      }
      if (Object.keys(command.parameters).length > 0) {
        errors.push(`${commandRef}: workspace preparation commands take no parameters`);
      }
      if (!command.dependencySources) {
        errors.push(`${commandRef}: workspace preparation command must declare dependency manifest and lockfile sources`);
      } else {
        const authorizationSources = new Set(command.authorizationSources.map(canonicalAuthorizationSource));
        const manifest = canonicalAuthorizationSource(command.dependencySources.manifest);
        const lockfile = canonicalAuthorizationSource(command.dependencySources.lockfile);
        if (manifest === lockfile) {
          errors.push(`${commandRef}: dependency manifest and lockfile must name different files`);
        }
        for (const [label, path] of [["manifest", manifest], ["lockfile", lockfile]] as const) {
          if (!authorizationSources.has(path)) {
            errors.push(`${commandRef}: dependency ${label} ${path} must appear in authorizationSources`);
            continue;
          }
          const absolute = resolve(projectRoot, path);
          const relation = relative(resolve(projectRoot), absolute);
          if (relation.startsWith("..") || isAbsolute(relation)) continue;
          if (relation === "" || !existsSync(absolute)) {
            errors.push(`${commandRef}: dependency ${label} ${path} must be a regular file`);
            continue;
          }
          const stat = lstatSync(absolute);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            errors.push(`${commandRef}: dependency ${label} ${path} must be a regular file`);
          }
        }
      }
    }
  }
  for (const command of contract.commands) {
    if (command.dependencySources && !workspacePreparationCommandRefs.has(command.id)) {
      errors.push(`${command.id}: dependencySources are reserved for workspace preparation commands`);
    }
  }

  if (contract.workspace.strategy === "project_helper") {
    const probe = commands.get(contract.workspace.collisionProbeCommandRef);
    const create = commands.get(contract.workspace.createCommandRef);
    const close = commands.get(contract.workspace.closeCommandRef);
    if (!probe) errors.push("workspace collision-probe command is missing");
    if (!create) errors.push("workspace create command is missing");
    if (!close) errors.push("workspace close command is missing");
    if (probe && probe.idempotence !== "probe") errors.push("workspace collision command must be a probe");
    if (create && create.idempotence !== "non_idempotent") errors.push("project-helper workspace create must declare non-idempotence");
  }

  for (const check of contract.verification.checks) {
    if (check.executor.kind !== "command") {
      errors.push(`${check.id}: verification executor ${check.executor.kind} is not executable; declare kind: command`);
    } else if (!commands.has(check.executor.commandRef)) {
      errors.push(`${check.id}: verification command is missing`);
    } else {
      const command = commands.get(check.executor.commandRef)!;
      if (command.cwd !== "worktree" || command.sideEffect !== "none" || command.idempotence !== "pure" || command.credentialRefs.length > 0) {
        errors.push(`${check.id}: verification command must be credential-free, pure, side-effect-free, and run in the worktree`);
      }
    }
  }
  const coversWrite = (rule: ProjectContract["approvalPolicy"]["rules"][number]): boolean =>
    rule.actionKinds.includes("write_file") || rule.actionKinds.includes("*");
  const grantsSomeWrite = (rule: ProjectContract["approvalPolicy"]["rules"][number]): boolean =>
    rule.effect === "pre_approved" && coversWrite(rule) && rule.pathGlobs?.length !== 0;
  const supportedActionKinds = new Set([
    "*",
    "write_file",
    ...contract.commands.map((command) => `run_command:${command.id}`),
  ]);
  if (!contract.approvalPolicy.rules.some(grantsSomeWrite)) {
    errors.push("approval policy pre-approves no write_file action, so no Work Run could write a file");
  }
  for (const rule of contract.approvalPolicy.rules) {
    for (const actionKind of rule.actionKinds) {
      if (!supportedActionKinds.has(actionKind)) errors.push(`${rule.id}: unsupported action kind ${actionKind}`);
    }
    if (rule.argvPrefix) {
      errors.push(`${rule.id}: argvPrefix is not enforced; select an exact run_command action kind instead`);
    }
    if (rule.pathGlobs && rule.actionKinds.some((actionKind) => actionKind !== "write_file")) {
      errors.push(`${rule.id}: pathGlobs are enforced only for write_file actions`);
    }
    if (rule.effect === "forbidden" && coversWrite(rule)
      && (!rule.pathGlobs || rule.pathGlobs.some(globMatchesEveryProjectPath))) {
      errors.push(`${rule.id}: forbids write_file on every path, so no Work Run could write a file`);
    }
    switch (rule.effect) {
      case "read_only":
        if (rule.actionKinds.includes("write_file")) {
          errors.push(`${rule.id}: effect read_only can authorize only run_command actions`);
        }
        break;
      case "consequential":
        errors.push(`${rule.id}: effect consequential is not executable; declare pre_approved, read_only, or forbidden`);
        break;
      case "pre_approved":
      case "forbidden":
        break;
    }
  }
  if (contract.delivery.strategy === "project_coordinator") {
    const enqueue = commands.get(contract.delivery.enqueueCommandRef);
    const terminal = commands.get(contract.delivery.terminalPredicateCommandRef);
    if (!enqueue) errors.push("delivery enqueue command is missing");
    if (!terminal) errors.push("delivery terminal-predicate command is missing");
    if (enqueue && (!["worktree", "project_root"].includes(enqueue.cwd)
      || !["local_operation", "github"].includes(enqueue.sideEffect)
      || enqueue.idempotence !== "idempotent" || enqueue.credentialRefs.length > 0)) {
      errors.push("delivery enqueue command must be credential-free, idempotent, and run in the worktree or project root");
    }
    if (terminal && (!["worktree", "project_root"].includes(terminal.cwd)
      || terminal.sideEffect !== "none" || terminal.idempotence !== "probe" || terminal.credentialRefs.length > 0)) {
      errors.push("delivery terminal-predicate command must be a credential-free, side-effect-free probe in the worktree or project root");
    }
    for (const command of [enqueue, terminal]) {
      if (!command) continue;
      const parameters = Object.keys(command.parameters);
      if (!parameters.includes("expected_head_sha") || parameters.some((name) => !["expected_head_sha", "pr_number", "run_id"].includes(name))) {
        errors.push(`${command.id}: Delivery Strategy commands require expected_head_sha and may use only pr_number and run_id in addition`);
      }
    }
  }

  const hookOrders = contract.postMergeHooks.map((hook) => hook.order);
  if (new Set(hookOrders).size !== hookOrders.length) errors.push("post-merge hook orders must be unique");
  const compensatingHooks = new Map(contract.compensatingHooks.map((hook) => [hook.id, hook]));
  for (const commandId of hookCommandIds) {
    const command = commands.get(commandId);
    if (command && command.credentialRefs.length > 1) {
      errors.push(`${command.id}: each operational invocation may expose at most one exact credential reference`);
    }
  }
  for (const hook of contract.postMergeHooks) {
    const hookCommand = commands.get(hook.commandRef);
    const successCheck = commands.get(hook.successCheckCommandRef);
    if (!hookCommand) errors.push(`${hook.id}: hook command is missing`);
    if (!successCheck) errors.push(`${hook.id}: hook success-check command is missing`);
    if (hookCommand && (hookCommand.cwd !== "synced_main" || hookCommand.sideEffect !== "local_operation"
      || !["idempotent", "non_idempotent"].includes(hookCommand.idempotence))) {
      errors.push(`${hook.id}: hook command must be an idempotent or non-idempotent local operation run from synchronized main`);
    }
    if (successCheck && (successCheck.cwd !== "synced_main"
      || successCheck.sideEffect !== "none" || successCheck.idempotence !== "probe")) {
      errors.push(`${hook.id}: success check must be an observable probe`);
    }
    if (hook.compensatingHookRef) {
      const compensation = compensatingHooks.get(hook.compensatingHookRef);
      if (!compensation) errors.push(`${hook.id}: compensating hook is missing`);
      else if (compensation.forPostMergeHookRef !== hook.id) {
        errors.push(`${hook.id}: compensating hook must bind back to this post-merge hook`);
      }
    }
  }
  for (const compensation of contract.compensatingHooks) {
    const parent = contract.postMergeHooks.find((hook) => hook.id === compensation.forPostMergeHookRef);
    if (!parent) errors.push(`${compensation.id}: referenced post-merge hook is missing`);
    else if (parent.compensatingHookRef !== compensation.id) {
      errors.push(`${compensation.id}: post-merge hook must explicitly approve this compensation`);
    }

    const command = commands.get(compensation.commandRef);
    const capture = commands.get(compensation.priorStateCaptureCommandRef);
    const successCheck = commands.get(compensation.successCheckCommandRef);
    if (!command) errors.push(`${compensation.id}: compensation command is missing`);
    if (!capture) errors.push(`${compensation.id}: prior-state capture command is missing`);
    if (!successCheck) errors.push(`${compensation.id}: compensation success-check command is missing`);
    if (command) {
      if (command.cwd !== "synced_main" || command.sideEffect !== "local_operation" || command.idempotence !== "non_idempotent") {
        errors.push(`${compensation.id}: compensation command must be a non-idempotent local operation run from synchronized main`);
      }
      if (command.timeoutSeconds !== compensation.timeoutSeconds) {
        errors.push(`${compensation.id}: compensation timeout must exactly match its command timeout`);
      }
      const parameters = Object.keys(command.parameters);
      if (parameters.some((parameter) => parameter !== "prior_state_artifact")
        || command.parameters.prior_state_artifact?.type !== "absolute_path"
        || command.parameters.prior_state_artifact.pathRoot !== "runtime_data") {
        errors.push(`${compensation.id}: compensation may parameterize only a runtime-data prior-state artifact`);
      }
      if (!command.argv.includes(compensation.ownershipBoundary.exactTarget)) {
        errors.push(`${compensation.id}: compensation target must be a literal exact argv value`);
      }
      const gitToken = command.argv.findIndex((argument) => /(?:^|[\\/])git(?:\.exe)?$/i.test(argument));
      if (gitToken >= 0 && command.argv.slice(gitToken + 1).includes("revert")) {
        errors.push(`${compensation.id}: compensation must not revert Git history`);
      }
    }
    if (successCheck) {
      const parameters = Object.keys(successCheck.parameters);
      if (parameters.some((parameter) => parameter !== "prior_state_artifact")
        || successCheck.parameters.prior_state_artifact?.type !== "absolute_path"
        || successCheck.parameters.prior_state_artifact.pathRoot !== "runtime_data") {
        errors.push(`${compensation.id}: compensation success check must prove the runtime-data prior-state artifact`);
      }
    }
    for (const [label, probe] of [["prior-state capture", capture], ["success check", successCheck]] as const) {
      if (probe && (probe.cwd !== "synced_main" || probe.sideEffect !== "none" || probe.idempotence !== "probe")) {
        errors.push(`${compensation.id}: ${label} must be a side-effect-free synchronized-main probe`);
      }
    }
    const projectRelativeTarget = relative(resolve(projectRoot), resolve(compensation.ownershipBoundary.exactTarget));
    if (!isAbsolute(compensation.ownershipBoundary.exactTarget)
      || projectRelativeTarget === ""
      || (!projectRelativeTarget.startsWith("..") && !isAbsolute(projectRelativeTarget))) {
      errors.push(`${compensation.id}: compensation target must be outside the project repository`);
    }
  }
  for (const rule of contract.documentation.rules) {
    if (rule.class === "generated") {
      if (!rule.sourceGlobs?.length) errors.push(`${rule.id}: generated documentation requires declared source globs`);
      if (!rule.regenerateCommandRef || !commands.has(rule.regenerateCommandRef)) {
        errors.push(`${rule.id}: generated documentation requires a valid regeneration command`);
      }
      if (!rule.driftCheckCommandRef || !commands.has(rule.driftCheckCommandRef)) {
        errors.push(`${rule.id}: generated documentation requires a valid drift-check command`);
      } else {
        const drift = commands.get(rule.driftCheckCommandRef);
        if (drift && (drift.cwd !== "worktree" || drift.sideEffect !== "none" || drift.idempotence !== "pure" || drift.credentialRefs.length > 0)) {
          errors.push(`${rule.id}: generated documentation drift check must be credential-free, pure, side-effect-free, and run in the worktree`);
        }
      }
    } else if (rule.sourceGlobs || rule.regenerateCommandRef || rule.driftCheckCommandRef) {
      errors.push(`${rule.id}: only generated documentation may declare generation metadata`);
    }
  }
  for (const commandRef of [...contract.documentation.formatCommandRefs, ...contract.documentation.inventoryCommandRefs]) {
    const command = commands.get(commandRef);
    if (!command) errors.push(`documentation check command is missing: ${commandRef}`);
    else if (command.cwd !== "worktree" || command.sideEffect !== "none" || command.idempotence !== "pure" || command.credentialRefs.length > 0) {
      errors.push(`${commandRef}: documentation checks must be credential-free, pure, side-effect-free, and run in the worktree`);
    }
  }
  for (const diagram of contract.documentation.diagramChecks) {
    const command = commands.get(diagram.commandRef);
    if (!command) errors.push(`${diagram.id}: diagram drift-check command is missing`);
    else if (command.cwd !== "worktree" || command.sideEffect !== "none" || command.idempotence !== "pure" || command.credentialRefs.length > 0) {
      errors.push(`${diagram.id}: diagram drift checks must be credential-free, pure, side-effect-free, and run in the worktree`);
    }
  }

  return errors;
}

export function validateProjectContract(projectRoot: string): ContractValidation {
  const canonicalPath = resolve(projectRoot, ".graph-shipper", "project.yaml");
  let source: string;
  try {
    source = readFileSync(canonicalPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      canonicalPath,
      contractDigest: "",
      projectId: null,
      schemaVersion: null,
      errors: [`cannot read canonical Project Contract: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const contractDigest = createHash("sha256").update(source).digest("hex");
  const document = parseDocument(source, { logLevel: "silent", version: "1.2" });
  if (document.errors.length > 0) {
    return {
      ok: false,
      canonicalPath,
      contractDigest,
      projectId: null,
      schemaVersion: null,
      errors: document.errors.map((error) => `YAML: ${error.message}`),
    };
  }

  const raw = document.toJS();
  const secretKeys = secretBearingKeys(raw);
  const parsed = ProjectContractSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      canonicalPath,
      contractDigest,
      projectId: typeof raw?.metadata?.projectId === "string" ? raw.metadata.projectId : null,
      schemaVersion: typeof raw?.metadata?.schemaVersion === "string" ? raw.metadata.schemaVersion : null,
      errors: [
        ...secretKeys.map((path) => `secret-bearing field is forbidden: ${path}`),
        ...parsed.error.issues.map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`),
      ],
    };
  }

  const errors = [
    ...secretKeys.map((path) => `secret-bearing field is forbidden: ${path}`),
    ...semanticErrors(parsed.data, projectRoot),
  ];
  return {
    ok: errors.length === 0,
    canonicalPath,
    contractDigest,
    projectId: parsed.data.metadata.projectId,
    schemaVersion: parsed.data.metadata.schemaVersion,
    contract: parsed.data,
    errors,
  };
}
