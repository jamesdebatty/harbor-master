import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { renderCommand } from "../src/actions/commands.js";
import type { ProjectContract } from "../src/contracts/schema.js";
import { StateStore } from "../src/state/store.js";
import { createTrackedProject, git, runCli } from "./helpers.js";

const operationalCredentialEnvironment = {
  GRAPH_SHIPPER_CREDENTIAL_DEPLOY_TOKEN: "fixture-deploy-secret",
  GRAPH_SHIPPER_CREDENTIAL_PROVIDER_SMOKE_TOKEN: "fixture-provider-secret",
};

function activate(root: string, dataRoot: string): void {
  const onboard = runCli(["contract", "onboard", "--project", root, "--data-root", dataRoot, "--json"]);
  assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
  const candidate = JSON.parse(onboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
  const activation = runCli([
    "contract", "activate", "--project", root, "--data-root", dataRoot,
    "--contract-digest", candidate.contractDigest,
    "--admission-evidence-digest", candidate.admissionEvidenceDigest,
    "--confirm-project", "fixture-project", "--json",
  ]);
  assert.equal(activation.status, 0, activation.stderr || activation.stdout);
}

function createRunnableFixture(): { root: string; dataRoot: string; requestPath: string; adapterFixturePath: string } {
  const fixture = createTrackedProject();
  mkdirSync(join(fixture.root, "scripts"), { recursive: true });
  writeFileSync(join(fixture.root, "scripts", "verify-helper.mjs"), [
    "export function containsExpectedBehavior(source, readme) {",
    '  return source.includes("return 42") && readme.includes("answerFeature");',
    "}",
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
    'import { readFileSync } from "node:fs";',
    'import { containsExpectedBehavior } from "./verify-helper.mjs";',
    'const source = readFileSync(new URL("../src/answer.js", import.meta.url), "utf8");',
    'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
    "if (!containsExpectedBehavior(source, readme)) process.exit(1);",
  ].join("\n"));
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.commands = [{
    id: "fixture-verify",
    argv: ["node", "scripts/verify.mjs"],
    authorizationSources: ["scripts/verify.mjs", "scripts/verify-helper.mjs"],
    cwd: "worktree",
    timeoutSeconds: 30,
    credentialRefs: [],
    sideEffect: "none",
    idempotence: "pure",
    parameters: {},
  }];
  contract.workSources.allowedKinds = ["feature_request"];
  contract.workspace.rootTemplate = `${fixture.dataRoot}/workspaces/<run-id>`;
  contract.approvalPolicy.rules = [{
    id: "local-workspace-edits",
    effect: "pre_approved",
    actionKinds: ["write_file"],
    pathGlobs: ["src/**", "README.md"],
    citation: "fixture local-only edit policy",
  }];
  contract.verification.checks = [{
    id: "fixture-test",
    cadence: "every_cycle",
    triggerGlobs: ["**"],
    executor: { kind: "command", commandRef: "fixture-verify" },
    failureClass: "planner_feedback",
    earnedEvidence: contract.verification.checks[0].earnedEvidence,
  }];
  contract.documentation.triggerMatrix = [{ pathGlobs: ["src/**"], impacts: ["reference"], topics: ["overview"] }];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/verify.mjs", "scripts/verify-helper.mjs"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "configure local work run"]);

  const requestPath = join(fixture.dataRoot, "run-request.json");
  writeFileSync(requestPath, JSON.stringify({
    schemaVersion: "1.0.0",
    workItem: {
      id: "fixture-request-1",
      projectId: "fixture-project",
      source: { kind: "feature_request", identity: "fixture-request-1", revision: "revision-1" },
      baseBranch: "main",
      title: "Add answerFeature",
      body: "Expose a local answerFeature function returning 42 and document it.",
      desiredBehavior: ["answerFeature returns 42"],
      acceptanceCriteria: [{ criterion: "the function and documentation exist", evidence: "fixture-verify exits zero" }],
      constraints: ["local-only; no GitHub writes"],
      provenance: ["request:title", "request:body", "request:acceptanceCriteria[0]"],
    },
    buildAssignmentId: "anthropic-build",
    reviewAssignmentId: "openai-review",
    autonomy: "local_only",
  }));
  const adapterFixturePath = join(fixture.dataRoot, "provider-fixture.json");
  const readmeSource = readFileSync(join(fixture.root, "README.md"), "utf8");
  writeFileSync(adapterFixturePath, JSON.stringify({
    schemaVersion: "1.0.0",
    planner: {
      provider: "anthropic",
      responses: [{
        kind: "plan",
        fileActionSemantics: "base_bound_v1",
        summary: "Implement and document answerFeature.",
        actions: [
          { kind: "write_file", path: "src/answer.js", content: "export function answerFeature() { return 42; }\n" },
          {
            kind: "edit_file",
            path: "README.md",
            baseContentSha256: createHash("sha256").update(readmeSource).digest("hex"),
            replacements: [{ oldText: "# Fixture Project\n", newText: "# Fixture Project\n\n`answerFeature()` returns 42.\n" }],
          },
        ],
        documentation: {
          kind: "coverage_plan",
          entries: [{ impact: "reference", topic: "overview", path: "README.md" }],
        },
        commitMessage: "Add answer feature",
      }],
    },
    reviewer: {
      provider: "openai",
      responses: [{ verdict: "approve", summary: "Behavior and documentation match the request.", findings: [] }],
    },
  }));
  return { ...fixture, requestPath, adapterFixturePath };
}

function selectReciprocalDirection(fixture: ReturnType<typeof createRunnableFixture>): void {
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.models.buildAssignments = [{
    id: "openai-build", provider: "openai", modelRef: "configured-openai-build", credentialRef: "openai-default",
  }];
  contract.models.reviewAssignments = [{
    id: "anthropic-review", provider: "anthropic", modelRef: "configured-anthropic-review", credentialRef: "anthropic-default",
  }];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "select reciprocal providers"]);
  const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
  request.buildAssignmentId = "openai-build";
  request.reviewAssignmentId = "anthropic-review";
  writeFileSync(fixture.requestPath, JSON.stringify(request));
  const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
  recorded.planner.provider = "openai";
  recorded.planner.modelRef = "recorded-openai-build";
  recorded.reviewer.provider = "anthropic";
  recorded.reviewer.modelRef = "recorded-anthropic-review";
  writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
}

function baseBindRecordedPlannerResponses(fixture: Record<string, any>): Record<string, any> {
  const files = new Map<string, string>([["README.md", "# Fixture Project\n"]]);
  const channels = [fixture.planner, ...(fixture.plannerFallbacks ?? [])];
  for (const channel of channels) {
    for (const slot of channel.responses ?? []) {
      const events = Array.isArray(slot) ? slot : [slot];
      for (const event of events) {
        if (event?.kind !== "plan") continue;
        event.fileActionSemantics = "base_bound_v1";
        event.actions = event.actions.map((action: Record<string, any>) => {
          if (action.kind === "write_file") {
            const source = files.get(action.path);
            files.set(action.path, action.content);
            if (source === undefined) return action;
            return {
              kind: "edit_file",
              path: action.path,
              baseContentSha256: createHash("sha256").update(source).digest("hex"),
              replacements: [{ oldText: source, newText: action.content }],
            };
          }
          if (action.kind === "edit_file") {
            const source = files.get(action.path);
            if (source !== undefined) {
              let content = source;
              for (const replacement of action.replacements) {
                if (content === replacement.newText) continue;
                if (content.includes(replacement.oldText)) content = content.replace(replacement.oldText, replacement.newText);
              }
              files.set(action.path, content);
              return {
                kind: "edit_file",
                path: action.path,
                baseContentSha256: createHash("sha256").update(source).digest("hex"),
                replacements: [{ oldText: source, newText: content }],
              };
            }
          }
          return action;
        });
      }
    }
  }
  return fixture;
}

function enableOpenPr(fixture: ReturnType<typeof createRunnableFixture>): string {
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.autonomy = { ...contract.autonomy, maximum: "open_pr", default: "open_pr" };
  contract.credentials.references.push({ id: "github-operator", purpose: "github_operator" });
  contract.github.pullRequest.sourceReference = { kind: "neutral", prefix: "Source issue:" };
  contract.github.requiredHostedChecks = ["verify"];
  contract.github.trustedFeedback = {
    reviewerActors: ["review-bot", "maintainer"],
    githubApps: [],
    requiredCheckProducers: ["github-actions"],
  };
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "enable open PR delivery"]);
  const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
  request.autonomy = "open_pr";
  request.workItem.constraints = ["open a normal PR; do not merge"];
  writeFileSync(fixture.requestPath, JSON.stringify(request));
  const githubFixturePath = join(fixture.dataRoot, "github-fixture.json");
  writeFileSync(githubFixturePath, JSON.stringify({
    schemaVersion: "1.0.0",
    pullRequestNumber: 24,
    remoteBranchHead: null,
    observations: [{
      checks: [{ name: "verify", status: "completed", conclusion: "success", headSha: "$HEAD", producer: "github-actions" }],
      reviews: [{ id: 9, state: "APPROVED", commitId: "$HEAD", body: "## VERDICT: APPROVE", actor: "review-bot" }],
      comments: [],
    }],
  }));
  return githubFixturePath;
}

function githubFixtureState(fixture: ReturnType<typeof createRunnableFixture>, runId: string): Record<string, any> {
  return JSON.parse(readFileSync(join(fixture.dataRoot, "github-fixtures", `${runId}.json`), "utf8")) as Record<string, any>;
}

function enableMergeWhenGreen(fixture: ReturnType<typeof createRunnableFixture>): string {
  const githubFixturePath = enableOpenPr(fixture);
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.autonomy = { ...contract.autonomy, maximum: "merge_when_green", default: "merge_when_green" };
  contract.workSources.allowedKinds = ["feature_request", "github_issue"];
  contract.github.mergeMethod = "squash";
  contract.cleanup.removeOwnedBranchAfterDeliveryTerminalSuccess = true;
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "enable autonomous merge"]);

  const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
  request.autonomy = "merge_when_green";
  request.workItem.source = { kind: "github_issue", identity: "#25", revision: "2026-08-15T12:00:00Z" };
  request.workItem.constraints = ["merge the exact reviewed head and close the source only after terminal proof"];
  writeFileSync(fixture.requestPath, JSON.stringify(request));

  const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
  githubFixture.baseBranchHead = git(fixture.root, ["rev-parse", "main"]);
  githubFixture.protectionRequiredChecks = ["verify"];
  githubFixture.requiredApprovalCount = 1;
  githubFixture.mergedSha = "$HEAD";
  githubFixture.issue = { number: 25, revision: "2026-08-15T12:00:00Z" };
  writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
  return githubFixturePath;
}

function enableHiddenCleanupOutput(
  fixture: ReturnType<typeof createRunnableFixture>,
  runId: string,
  outputCount: number,
  visibleOutput = false,
): string {
  const githubFixturePath = enableMergeWhenGreen(fixture);
  const workspaceRoot = join(fixture.dataRoot, "workspaces", runId);
  writeFileSync(join(fixture.root, "scripts", "leave-cleanup-output.mjs"), [
    'import { writeFileSync } from "node:fs";',
    `const root = ${JSON.stringify(workspaceRoot)};`,
    `for (let index = 0; index < ${outputCount}; index += 1) writeFileSync(root + "/cleanup-hidden-" + index + ".txt", "owned cleanup output\\n");`,
    ...(visibleOutput ? ['writeFileSync(root + "/cleanup-visible.txt", "visible cleanup output\\n");'] : []),
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "probe-cleanup-output.mjs"), [
    'import { existsSync } from "node:fs";',
    `const root = ${JSON.stringify(workspaceRoot)};`,
    `process.exit(existsSync(root + "/cleanup-hidden-0.txt") && existsSync(root + "/cleanup-hidden-${outputCount - 1}.txt")${visibleOutput ? ' && existsSync(root + "/cleanup-visible.txt")' : ""} ? 0 : 1);`,
  ].join("\n"));
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.commands.push(
    {
      id: "leave-cleanup-output", argv: ["node", "scripts/leave-cleanup-output.mjs"],
      authorizationSources: ["scripts/leave-cleanup-output.mjs"], cwd: "synced_main", timeoutSeconds: 30,
      credentialRefs: [], sideEffect: "local_operation", idempotence: "idempotent", parameters: {},
    },
    {
      id: "probe-cleanup-output", argv: ["node", "scripts/probe-cleanup-output.mjs"],
      authorizationSources: ["scripts/probe-cleanup-output.mjs"], cwd: "synced_main", timeoutSeconds: 30,
      credentialRefs: [], sideEffect: "none", idempotence: "probe", parameters: {},
    },
  );
  contract.postMergeHooks = [{
    id: "leave-cleanup-output", order: 0, commandRef: "leave-cleanup-output",
    successCheckCommandRef: "probe-cleanup-output", retry: { maximumAttempts: 1, backoffSeconds: 0 },
    onFailure: "escalate_preserve_state",
  }];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/leave-cleanup-output.mjs", "scripts/probe-cleanup-output.mjs"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "leave hidden output before cleanup"]);
  appendFileSync(join(fixture.root, ".git", "info", "exclude"), "\ncleanup-hidden-*.txt\n");
  const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
  githubFixture.baseBranchHead = git(fixture.root, ["rev-parse", "main"]);
  writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
  return githubFixturePath;
}

function enableOperationalHooks(
  fixture: ReturnType<typeof createRunnableFixture>,
  options: { failDeployAttempts?: number; compensationFails?: boolean; timeoutRebuildOnce?: boolean } = {},
): { githubFixturePath: string; targetPath: string; eventPath: string } {
  const githubFixturePath = enableMergeWhenGreen(fixture);
  const targetPath = join(fixture.dataRoot, "installed-artifact.txt");
  const rebuildMarkerPath = join(fixture.dataRoot, "rebuilt-artifact.txt");
  const providerMarkerPath = join(fixture.dataRoot, "provider-smoke.txt");
  const eventPath = join(fixture.dataRoot, "hook-events.jsonl");
  writeFileSync(targetPath, "known-good\n");
  writeFileSync(join(fixture.root, "scripts", "operational-hook.mjs"), [
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    "const [operation, target, events, failAttempts = '0'] = process.argv.slice(2);",
    "const history = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\\n').filter(Boolean) : [];",
    "const attempts = history.filter((line) => JSON.parse(line).operation === operation).length + 1;",
    "const credentialNames = Object.keys(process.env).filter((name) => name.startsWith('GRAPH_SHIPPER_CREDENTIAL_')).sort();",
    "appendFileSync(events, JSON.stringify({ operation, attempts, cwd: process.cwd(), credentialNames }) + '\\n');",
    "if (operation === 'rebuild-timeout' && attempts === 1) await new Promise((resolve) => setTimeout(resolve, 2000));",
    "if (attempts <= Number(failAttempts)) { if (operation === 'replace') writeFileSync(target, 'broken\\n'); process.exit(7); }",
    "if (operation === 'rebuild' || operation === 'rebuild-timeout') writeFileSync(target, 'rebuilt\\n');",
    "if (operation === 'replace') writeFileSync(target, 'installed\\n');",
    "if (operation === 'restart') writeFileSync(target, readFileSync(target, 'utf8').trim() + '+restarted\\n');",
    "if (operation === 'provider-smoke') writeFileSync(target, 'provider-ready\\n');",
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "operational-probe.mjs"), [
    'import { existsSync, readFileSync } from "node:fs";',
    "const [target, expected] = process.argv.slice(2);",
    "if (!existsSync(target) || !readFileSync(target, 'utf8').includes(expected)) process.exit(1);",
    "process.stdout.write(JSON.stringify({ satisfied: true, observed: expected }));",
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "capture-prior.mjs"), [
    'import { readFileSync } from "node:fs";',
    "process.stdout.write(readFileSync(process.argv[2]));",
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "restore-prior.mjs"), [
    'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
    "const [target, artifact, events, shouldFail] = process.argv.slice(2);",
    "appendFileSync(events, JSON.stringify({ operation: 'compensate', cwd: process.cwd() }) + '\\n');",
    "if (shouldFail === 'true') process.exit(9);",
    "writeFileSync(target, readFileSync(artifact));",
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "probe-prior.mjs"), [
    'import { readFileSync } from "node:fs";',
    "const [target, artifact] = process.argv.slice(2);",
    "process.exit(readFileSync(target).equals(readFileSync(artifact)) ? 0 : 1);",
  ].join("\n"));
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.credentials.references.push({ id: "deploy-token", purpose: "post_merge_operation" });
  contract.credentials.references.push({ id: "provider-smoke-token", purpose: "post_merge_operation" });
  const command = (id: string, script: string, argv: string[], sideEffect: string, idempotence: string, credentialRefs: string[] = []) => ({
    id, argv: ["node", `scripts/${script}`, ...argv], authorizationSources: [`scripts/${script}`],
    cwd: "synced_main", timeoutSeconds: 10, credentialRefs, sideEffect, idempotence, parameters: {},
  });
  contract.commands.push(
    command("rebuild-app", "operational-hook.mjs", [options.timeoutRebuildOnce ? "rebuild-timeout" : "rebuild", rebuildMarkerPath, eventPath, "0"], "local_operation", "idempotent"),
    command("probe-rebuild", "operational-probe.mjs", [rebuildMarkerPath, "rebuilt"], "none", "probe"),
    command("replace-app", "operational-hook.mjs", ["replace", targetPath, eventPath, String(options.failDeployAttempts ?? 0)], "local_operation", "non_idempotent", ["deploy-token"]),
    command("probe-install", "operational-probe.mjs", [targetPath, "installed"], "none", "probe"),
    command("restart-app", "operational-hook.mjs", ["restart", targetPath, eventPath, "0"], "local_operation", "idempotent"),
    command("probe-health", "operational-probe.mjs", [targetPath, "restarted"], "none", "probe"),
    command("provider-smoke-app", "operational-hook.mjs", ["provider-smoke", providerMarkerPath, eventPath, "0"], "local_operation", "idempotent", ["provider-smoke-token"]),
    command("probe-provider", "operational-probe.mjs", [providerMarkerPath, "provider-ready"], "none", "probe"),
    command("capture-known-good", "capture-prior.mjs", [targetPath], "none", "probe"),
    command("restore-known-good", "restore-prior.mjs", [targetPath, "{prior_state_artifact}", eventPath, String(options.compensationFails === true)], "local_operation", "non_idempotent"),
    command("probe-known-good", "probe-prior.mjs", [targetPath, "{prior_state_artifact}"], "none", "probe"),
  );
  contract.commands.find((candidate: Record<string, unknown>) => candidate.id === "restore-known-good").parameters = {
    prior_state_artifact: { type: "absolute_path", pathRoot: "runtime_data" },
  };
  contract.commands.find((candidate: Record<string, unknown>) => candidate.id === "probe-known-good").parameters = {
    prior_state_artifact: { type: "absolute_path", pathRoot: "runtime_data" },
  };
  if (options.timeoutRebuildOnce) contract.commands.find((candidate: Record<string, unknown>) => candidate.id === "rebuild-app").timeoutSeconds = 1;
  contract.postMergeHooks = [
    { id: "rebuild", order: 0, commandRef: "rebuild-app", successCheckCommandRef: "probe-rebuild", retry: { maximumAttempts: options.timeoutRebuildOnce ? 2 : 1, backoffSeconds: 0 }, onFailure: "escalate_preserve_state" },
    { id: "replace", order: 1, commandRef: "replace-app", successCheckCommandRef: "probe-install", retry: { maximumAttempts: 2, backoffSeconds: 0 }, onFailure: "escalate_preserve_state", compensatingHookRef: "restore-known-good" },
    { id: "restart-smoke", order: 2, commandRef: "restart-app", successCheckCommandRef: "probe-health", retry: { maximumAttempts: 1, backoffSeconds: 0 }, onFailure: "escalate_preserve_state" },
    { id: "provider-smoke", order: 3, commandRef: "provider-smoke-app", successCheckCommandRef: "probe-provider", retry: { maximumAttempts: 1, backoffSeconds: 0 }, onFailure: "escalate_preserve_state" },
  ];
  contract.compensatingHooks = [{
    id: "restore-known-good", forPostMergeHookRef: "replace", commandRef: "restore-known-good",
    priorStateCaptureCommandRef: "capture-known-good", successCheckCommandRef: "probe-known-good",
    timeoutSeconds: 10, retry: { maximumAttempts: 1, backoffSeconds: 0 },
    ownershipBoundary: { owner: "fixture-runtime", exactTarget: targetPath },
  }];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/operational-hook.mjs", "scripts/operational-probe.mjs", "scripts/capture-prior.mjs", "scripts/restore-prior.mjs", "scripts/probe-prior.mjs"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "enable operational hooks"]);
  const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
  githubFixture.baseBranchHead = git(fixture.root, ["rev-parse", "main"]);
  writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
  return { githubFixturePath, targetPath, eventPath };
}

test("merge_when_green runs ordered operational hooks before terminal source closure and cleanup", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture);
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-success-1";
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", operational.githubFixturePath, "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.delivery.terminal.satisfied, true);
    assert.equal(output.delivery.postMerge.status, "succeeded");
    assert.deepEqual(output.delivery.postMerge.hooks.map((hook: Record<string, unknown>) => hook.id), ["rebuild", "replace", "restart-smoke", "provider-smoke"]);
    assert.equal(output.delivery.sourceClosure.disposition, "closed");
    assert.equal(readFileSync(operational.targetPath, "utf8"), "installed+restarted\n");
    const events = readFileSync(operational.eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.operation), ["rebuild", "replace", "restart", "provider-smoke"]);
    assert.deepEqual(events.map((event) => event.cwd), Array(4).fill(realpathSync(fixture.root)));
    assert.deepEqual(events[0].credentialNames, []);
    assert.deepEqual(events[1].credentialNames, ["GRAPH_SHIPPER_CREDENTIAL_DEPLOY_TOKEN"]);
    assert.deepEqual(events[2].credentialNames, []);
    assert.deepEqual(events[3].credentialNames, ["GRAPH_SHIPPER_CREDENTIAL_PROVIDER_SMOKE_TOKEN"]);
    assert.equal(JSON.stringify(output).includes("fixture-deploy-secret"), false);
    assert.equal(JSON.stringify(output).includes("fixture-provider-secret"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("operational hooks refuse execution without the explicit disposable-fixture boundary", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture);
    activate(fixture.root, fixture.dataRoot);
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", operational.githubFixturePath, "--allow-disposable-fixture-reconciliation", "--run-id", "post-merge-boundary-1", "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /explicit disposable-fixture authorization/);
    assert.equal(existsSync(operational.eventPath), false);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", "post-merge-boundary-1")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("post-merge hooks retry transient failures within the Work Run deadline", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture, { failDeployAttempts: 1 });
    activate(fixture.root, fixture.dataRoot);
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", operational.githubFixturePath, "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", "post-merge-retry-1", "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const replace = output.delivery.postMerge.hooks.find((hook: Record<string, unknown>) => hook.id === "replace");
    assert.equal(replace.attempts, 2);
    assert.equal(readFileSync(operational.targetPath, "utf8"), "installed+restarted\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an idempotent post-merge hook retries after its declared timeout and re-probes", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture, { timeoutRebuildOnce: true });
    activate(fixture.root, fixture.dataRoot);
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", operational.githubFixturePath, "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", "post-merge-timeout-retry-1", "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const rebuild = output.delivery.postMerge.hooks.find((hook: Record<string, unknown>) => hook.id === "rebuild");
    assert.equal(rebuild.attempts, 2);
    const events = readFileSync(operational.eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.operation === "rebuild-timeout").length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("exhausted post-merge retries compensate but keep merged truth non-terminal and escalated", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture, { failDeployAttempts: 2 });
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-compensated-1";
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", operational.githubFixturePath, "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(status.delivery.merge.mergedSha, git(fixture.root, ["rev-parse", "main"]));
    assert.equal(status.delivery.postMerge.status, "compensated");
    assert.equal(status.delivery.terminal, null);
    assert.equal(status.delivery.sourceClosure, null);
    assert.equal(status.delivery.cleanup, null);
    assert.equal(readFileSync(operational.targetPath, "utf8"), "known-good\n");
    assert.equal(githubFixtureState(fixture, runId).issueClosed, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("exhausted compensation preserves diagnostics and escalates without inventing rollback", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture, { failDeployAttempts: 2, compensationFails: true });
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-compensation-exhausted-1";
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", operational.githubFixturePath, "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(status.delivery.postMerge.status, "compensation_exhausted");
    assert.equal(status.delivery.postMerge.compensation.status, "exhausted");
    assert.equal(status.delivery.terminal, null);
    assert.equal(readFileSync(operational.targetPath, "utf8"), "broken\n");
    assert.equal(githubFixtureState(fixture, runId).events.some((event: Record<string, unknown>) => String(event.path).includes("revert")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("post-merge effect reconciliation adopts an observable hook after process death without replay", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture);
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-crash-adopt-1";
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", operational.githubFixturePath,
      "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ];
    const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-effect", "post_merge_hook:replace"], operationalCredentialEnvironment);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);

    const resumed = runCli(["resume", ...common], operationalCredentialEnvironment);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.delivery.postMerge.status, "succeeded");
    const events = readFileSync(operational.eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.operation === "replace").length, 1);
    const store = new StateStore(fixture.dataRoot);
    try {
      const adopted = store.latestEffect(runId, "post_merge_hook");
      assert.ok(adopted);
    } finally {
      store.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an applied hook receipt prevents replay when its observable probe later drifts", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture);
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-applied-receipt-1";
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", operational.githubFixturePath,
      "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ];
    const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-receipt", "post_merge_hook:replace"], operationalCredentialEnvironment);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);
    writeFileSync(operational.targetPath, "drifted-after-proven-receipt\n");

    const resumed = runCli(["resume", ...common], operationalCredentialEnvironment);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const events = readFileSync(operational.eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.operation === "replace").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("ambiguous compensation after process death escalates with merged truth and no replay", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture, { failDeployAttempts: 2, compensationFails: true });
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-compensation-ambiguous-1";
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", operational.githubFixturePath,
      "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ];
    const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-effect", "compensating_hook:restore-known-good"], operationalCredentialEnvironment);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);

    const resumed = runCli(["resume", ...common], operationalCredentialEnvironment);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(status.delivery.postMerge.status, "compensation_ambiguous");
    assert.equal(status.delivery.postMerge.compensation.status, "ambiguous");
    assert.ok(status.delivery.merge.mergedSha);
    assert.equal(status.delivery.terminal, null);
    const events = readFileSync(operational.eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.operation === "compensate").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("compensation receipt crash resumes from the proven artifact without replay", () => {
  const fixture = createRunnableFixture();
  try {
    const operational = enableOperationalHooks(fixture, { failDeployAttempts: 2 });
    activate(fixture.root, fixture.dataRoot);
    const runId = "post-merge-compensation-receipt-1";
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", operational.githubFixturePath,
      "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ];
    const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-receipt", "compensating_hook:restore-known-good"], operationalCredentialEnvironment);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);

    const resumed = runCli(["resume", ...common], operationalCredentialEnvironment);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.delivery.postMerge.status, "compensated");
    assert.equal(status.delivery.postMerge.compensation.status, "succeeded");
    const events = readFileSync(operational.eventPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.operation === "compensate").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

function selectProjectCoordinator(fixture: ReturnType<typeof createRunnableFixture>, githubFixturePath: string): void {
  writeFileSync(join(fixture.root, "scripts", "coordinator-enqueue.mjs"), [
    "const [prNumber, expectedHead] = process.argv.slice(2);",
    "process.stdout.write(JSON.stringify({ enqueued: true, prNumber, expectedHead }));",
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "coordinator-terminal.mjs"), [
    "const expectedHead = process.argv[2];",
    "process.stdout.write(JSON.stringify({ terminal: true, mergedSha: expectedHead }));",
  ].join("\n"));
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.commands.push({
    id: "coordinator-enqueue", argv: ["node", "scripts/coordinator-enqueue.mjs", "{pr_number}", "{expected_head_sha}"],
    authorizationSources: ["scripts/coordinator-enqueue.mjs"], cwd: "worktree", timeoutSeconds: 30,
    credentialRefs: [], sideEffect: "local_operation", idempotence: "idempotent",
    parameters: { pr_number: { type: "positive_integer" }, expected_head_sha: { type: "git_sha" } },
  }, {
    id: "coordinator-terminal", argv: ["node", "scripts/coordinator-terminal.mjs", "{expected_head_sha}"],
    authorizationSources: ["scripts/coordinator-terminal.mjs"], cwd: "worktree", timeoutSeconds: 30,
    credentialRefs: [], sideEffect: "none", idempotence: "probe",
    parameters: { expected_head_sha: { type: "git_sha" } },
  });
  contract.delivery = {
    strategy: "project_coordinator", enqueueCommandRef: "coordinator-enqueue", terminalPredicateCommandRef: "coordinator-terminal",
  };
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/coordinator-enqueue.mjs", "scripts/coordinator-terminal.mjs"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "select project coordinator delivery"]);
  const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
  githubFixture.baseBranchHead = git(fixture.root, ["rev-parse", "main"]);
  writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
}

test("merge_when_green delivers an exact reviewed head through terminal proof before source closure and owned cleanup", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    activate(fixture.root, fixture.dataRoot);
    const runId = "merge-green-1";
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation", "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.autonomy, "merge_when_green");
    assert.equal(output.delivery.strategy, "github_direct");
    assert.equal(output.delivery.reviewPublication.headSha, output.headSha);
    assert.equal(output.delivery.merge.headSha, output.headSha);
    assert.equal(output.delivery.terminal.satisfied, true);
    assert.equal(output.delivery.sourceClosure.disposition, "closed");
    assert.equal(output.delivery.cleanup.worktreeRemoved, true);
    assert.equal(existsSync(output.workspacePath), false);
    assert.equal(git(fixture.root, ["branch", "--list", output.branch]), "");
    assert.equal(git(fixture.root, ["rev-parse", "main"]), output.delivery.merge.mergedSha);
    const fixtureState = githubFixtureState(fixture, runId);
    assert.equal(fixtureState.issueClosed, true);
    assert.equal(fixtureState.events.some((event: Record<string, unknown>) => event.kind === "request" && event.method === "PUT"), true);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.delivery.terminal.satisfied, true);
    assert.equal(status.delivery.cleanup.branchRemoved, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("delivery cleanup reports bounded hidden output and still reclaims its owned workspace", () => {
  const fixture = createRunnableFixture();
  try {
    const runId = "cleanup-hidden-output-1";
    const githubFixturePath = enableHiddenCleanupOutput(fixture, runId, 25);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation",
      "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.delivery.cleanup.undeclaredWorktreeOutput.length, 20);
    assert.equal(output.delivery.cleanup.undeclaredWorktreeOutputCount, 25);
    assert.match(output.delivery.cleanup.undeclaredWorktreeOutput.join("\n"), /cleanup-hidden-0\.txt: .*info\/exclude/);
    assert.equal(existsSync(output.workspacePath), false);
    const status = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    assert.deepEqual(status.delivery.cleanup.undeclaredWorktreeOutput, output.delivery.cleanup.undeclaredWorktreeOutput);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("delivery cleanup reports hidden output when visible drift preserves the workspace", () => {
  const fixture = createRunnableFixture();
  const runId = "cleanup-mixed-output";
  try {
    const githubFixturePath = enableHiddenCleanupOutput(fixture, runId, 1, true);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation",
      "--allow-disposable-fixture-operations", "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as { error: string; details: string[] };
    assert.match(output.error, /cleanup refused a drifted owned worktree/);
    assert.match(output.details.join("\n"), /cleanup-visible\.txt: untracked and not ignored by any rule/);
    assert.match(output.details.join("\n"), /cleanup-hidden-0\.txt: .*info\/exclude/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", runId, "cleanup-visible.txt")), true);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", runId, "cleanup-hidden-0.txt")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("delivery cleanup resume refuses malformed hidden-output intent evidence", () => {
  const fixture = createRunnableFixture();
  const runId = "cleanup-hidden-output-malformed-intent";
  try {
    const githubFixturePath = enableHiddenCleanupOutput(fixture, runId, 1);
    activate(fixture.root, fixture.dataRoot);
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", githubFixturePath,
      "--allow-disposable-fixture-reconciliation", "--allow-disposable-fixture-operations",
      "--run-id", runId, "--json",
    ];

    const crashed = runCli([
      "run", "--request", fixture.requestPath, ...common,
      "--crash-after-intent", "cleanup_owned_resources",
    ]);
    assert.notEqual(crashed.status, 0);
    const store = new StateStore(fixture.dataRoot);
    try {
      const pending = store.preparedEffect(runId);
      assert.equal(pending?.kind, "cleanup_owned_resources");
      assert.ok(pending);
      store.prepareEffect({
        ...pending,
        intent: { ...pending.intent, undeclaredWorktreeOutputCount: "not-a-count" },
      });
    } finally {
      store.close();
    }

    const resumed = runCli(["resume", ...common]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /cleanup intent carries invalid hidden-output evidence/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", runId, "cleanup-hidden-0.txt")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("merge_when_green preserves source and owned resources when branch-protection dispatch is indeterminate", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    githubFixture.branchProtected = false;
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);
    const runId = "merge-unprotected-1";
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation", "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    const durable = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(durable.status, "escalated");
    assert.equal(durable.delivery.terminal, null);
    assert.equal(durable.delivery.sourceClosure, null);
    assert.equal(existsSync(durable.state.workspacePath), true);
    assert.notEqual(git(fixture.root, ["branch", "--list", durable.state.branch]), "");
    assert.equal(githubFixtureState(fixture, runId).issueClosed, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("merge_when_green uses the selected project coordinator and never invents a direct GitHub merge", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    selectProjectCoordinator(fixture, githubFixturePath);
    activate(fixture.root, fixture.dataRoot);
    const runId = "merge-coordinator-1";
    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation", "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.delivery.strategy, "project_coordinator");
    assert.equal(output.delivery.terminal.predicate, "coordinator-terminal");
    const state = githubFixtureState(fixture, runId);
    assert.equal(state.events.some((event: Record<string, unknown>) => event.method === "PUT" && String(event.path).endsWith("/merge")), false);
    const evidence = JSON.parse(readFileSync(output.evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.commandResults.some((command: Record<string, unknown>) => command.commandId === "coordinator-enqueue"), true);
    assert.equal(evidence.commandResults.some((command: Record<string, unknown>) => command.commandId === "coordinator-terminal"), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

for (const effect of ["publish_review_verdict", "merge_exact_head"] as const) {
  test(`merge_when_green reconciles ${effect} after apply-before-receipt crash without duplication`, () => {
    const fixture = createRunnableFixture();
    try {
      const githubFixturePath = enableMergeWhenGreen(fixture);
      activate(fixture.root, fixture.dataRoot);
      const runId = `merge-crash-${effect}`;
      const common = [
        "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", githubFixturePath,
        "--allow-disposable-fixture-reconciliation",
        "--run-id", runId, "--json",
      ];
      const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-effect", effect]);
      assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);
      const resumed = runCli(["resume", ...common]);
      assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
      const output = JSON.parse(resumed.stdout) as Record<string, any>;
      assert.equal(output.delivery.terminal.satisfied, true);
      const state = githubFixtureState(fixture, runId);
      const requests = state.events.filter((event: Record<string, unknown>) => event.kind === "request");
      if (effect === "publish_review_verdict") {
        assert.equal(requests.filter((event: Record<string, unknown>) => event.method === "POST" && String(event.path).endsWith("/comments")).length, 1);
      } else {
        assert.equal(requests.filter((event: Record<string, unknown>) => event.method === "PUT" && String(event.path).endsWith("/merge")).length, 1);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  });
}

test("project coordinator enqueue crash adopts the terminal postcondition without enqueue replay", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    selectProjectCoordinator(fixture, githubFixturePath);
    activate(fixture.root, fixture.dataRoot);
    const runId = "merge-coordinator-crash";
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", githubFixturePath,
      "--allow-disposable-fixture-reconciliation",
      "--run-id", runId, "--json",
    ];
    const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-effect", "enqueue_delivery"]);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);
    const resumed = runCli(["resume", ...common]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const store = new StateStore(fixture.dataRoot);
    try {
      const enqueue = store.latestEffect(runId, "enqueue_delivery");
      assert.equal(enqueue?.state, "adopted");
      assert.equal(enqueue?.receipt?.reconciliation, "terminal_predicate_observed");
    } finally {
      store.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("base advancement refreshes the head and regenerates downstream proof before merge", async () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    const reviewedBase = git(fixture.root, ["rev-parse", "main"]);
    git(fixture.root, ["checkout", "-b", "fixture-future-base"]);
    writeFileSync(join(fixture.root, "BASE.txt"), "advanced base\n");
    git(fixture.root, ["add", "BASE.txt"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "advance base during merge guard"]);
    const advancedBase = git(fixture.root, ["rev-parse", "HEAD"]);
    git(fixture.root, ["checkout", "main"]);
    git(fixture.root, ["branch", "-D", "fixture-future-base"]);
    assert.equal(git(fixture.root, ["rev-parse", "main"]), reviewedBase);

    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    const green = githubFixture.observations[0];
    githubFixture.baseBranchHead = advancedBase;
    githubFixture.observationDelayMilliseconds = 1000;
    githubFixture.observations = [{
      checks: [{ name: "verify", status: "in_progress", conclusion: null, headSha: "$HEAD", producer: "github-actions" }],
      reviews: [], comments: [],
    }, green];
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    const providers = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providers.reviewer.responses.push(structuredClone(providers.reviewer.responses[0]));
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(providers));
    activate(fixture.root, fixture.dataRoot);

    const runId = "merge-base-refresh-1";
    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "run",
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation", "--run-id", runId, "--json",
    ], { cwd: repositoryRoot, env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const exited = new Promise<number | null>((resolveExit) => { child.once("close", resolveExit); });
    let waiting = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      const statePath = join(fixture.dataRoot, "github-fixtures", `${runId}.json`);
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
      waiting = state.events.some((event: Record<string, unknown>) => event.kind === "wait_for_observation");
      if (waiting) break;
    }
    assert.equal(waiting, true, stderr || stdout);
    git(fixture.root, ["reset", "--hard", advancedBase]);
    const exit = await exited;
    assert.equal(exit, 0, stderr || stdout);
    const output = JSON.parse(stdout) as Record<string, any>;
    assert.equal(output.baseSha, advancedBase);
    assert.equal(output.reviewAttempts, 2);
    assert.notEqual(output.headSha, reviewedBase);
    assert.equal(output.delivery.merge.headSha, output.headSha);
    assert.equal(output.delivery.mergeGuard.baseSha, advancedBase);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr run stops at a green exactly reviewed normal PR without merge authority", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-green-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.autonomy, "open_pr");
    assert.equal(output.status, "completed");
    assert.equal(output.pullRequest.number, 24);
    assert.equal(output.pullRequest.draft, false);
    assert.equal(output.pullRequest.headSha, output.headSha);
    assert.equal(output.hosted.hostedChecksGreen, true);
    assert.equal(output.hosted.reviewApproved, true);
    assert.equal(output.merge, undefined);
    const status = runCli(["status", "--run-id", "open-pr-green-1", "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const durable = JSON.parse(status.stdout) as Record<string, any>;
    assert.equal(durable.delivery.autonomy, "open_pr");
    assert.equal(durable.delivery.pullRequest.number, 24);
    assert.equal(durable.delivery.pullRequest.headSha, output.headSha);
    assert.equal(durable.delivery.hosted.hostedChecksGreen, true);
    assert.equal(durable.delivery.hosted.reviewApproved, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr publishes its opposite-provider approval and completes without a native review", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    githubFixture.observations[0].reviews = [];
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-provider-approval", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.hosted.hostedChecksGreen, true);
    assert.equal(output.hosted.reviewApproved, false);
    assert.equal(output.hosted.providerApprovalPublished, true);
    assert.equal(output.reviewPublication.headSha, output.headSha);
    assert.equal(output.merge, undefined);
    const state = githubFixtureState(fixture, "open-pr-provider-approval");
    const requests = state.events.filter((event: Record<string, unknown>) => event.kind === "request");
    assert.equal(
      requests.filter((event: Record<string, unknown>) => event.method === "POST" && String(event.path).endsWith("/comments")).length,
      1,
    );
    assert.equal(requests.some((event: Record<string, unknown>) => event.method === "PUT"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr completes from recorded commit-status evidence", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.github.requiredCheckSource = "commit_statuses";
    contract.github.trustedFeedback.requiredCheckProducers = ["github-actions[bot]"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "use commit status evidence"]);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    for (const observation of githubFixture.observations) {
      for (const check of observation.checks) check.statusActor = "github-actions[bot]";
    }
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-commit-status", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.hosted.hostedChecksGreen, true);
    const state = githubFixtureState(fixture, "open-pr-commit-status");
    const requests = state.events.filter((event: Record<string, unknown>) => event.kind === "request");
    assert.equal(requests.some((event: Record<string, unknown>) => String(event.path).includes("/statuses")), true);
    assert.equal(requests.some((event: Record<string, unknown>) => String(event.path).includes("/check-runs")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr adopts provider approval published before a missing effect receipt", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    githubFixture.observations[0].reviews = [];
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", githubFixturePath,
      "--run-id", "open-pr-provider-approval-crash", "--json",
    ];

    const crashed = runCli([
      "run", "--request", fixture.requestPath, ...common,
      "--crash-after-effect", "publish_review_verdict",
    ]);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);

    const resumed = runCli(["resume", ...common]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.hosted.providerApprovalPublished, true);
    assert.equal(output.hosted.reviewApproved, false);
    const state = githubFixtureState(fixture, "open-pr-provider-approval-crash");
    const requests = state.events.filter((event: Record<string, unknown>) => event.kind === "request");
    assert.equal(
      requests.filter((event: Record<string, unknown>) => event.method === "POST" && String(event.path).endsWith("/comments")).length,
      1,
    );
    assert.equal(requests.some((event: Record<string, unknown>) => event.method === "PUT"), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr resumes from a durable provider approval receipt without re-entering publication", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    githubFixture.observations[0].reviews = [];
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);
    const runId = "open-pr-provider-approval-receipt-crash";
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", githubFixturePath,
      "--run-id", runId, "--json",
    ];

    const crashed = runCli([
      "run", "--request", fixture.requestPath, ...common,
      "--crash-after-receipt", "publish_review_verdict",
    ]);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);
    const before = githubFixtureState(fixture, runId);
    assert.equal(before.events.filter((event: Record<string, unknown>) => event.purpose === "review_publication").length, 1);

    const resumed = runCli(["resume", ...common]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.hosted.providerApprovalPublished, true);
    const after = githubFixtureState(fixture, runId);
    assert.equal(after.events.filter((event: Record<string, unknown>) => event.purpose === "review_publication").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr resume adopts a PR created before a missing effect receipt", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    activate(fixture.root, fixture.dataRoot);
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-adopt-1", "--json",
    ];

    const crashed = runCli([
      "run", ...common, "--request", fixture.requestPath,
      "--crash-after-effect", "upsert_pull_request",
    ]);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);

    const resumed = runCli(["resume", ...common]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.pullRequest.disposition, "adopted");
    const fixtureState = githubFixtureState(fixture, "open-pr-adopt-1");
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.method === "POST").length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr resume reconciles an exact branch push before replay", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    activate(fixture.root, fixture.dataRoot);
    const common = [
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-push-adopt-1", "--json",
    ];
    const crashed = runCli([
      "run", ...common, "--request", fixture.requestPath,
      "--crash-after-effect", "push_branch",
    ]);
    assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);

    const resumed = runCli(["resume", ...common]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const fixtureState = githubFixtureState(fixture, "open-pr-push-adopt-1");
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.kind === "push_branch").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr repairs trusted hosted feedback and regenerates all exact-head evidence", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const provider = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const repaired = structuredClone(provider.planner.responses[0]);
    repaired.summary = "Apply trusted hosted feedback.";
    repaired.actions[0].content = "/** Hosted feedback addressed. */\nexport function answerFeature() { return 42; }\n";
    repaired.commitMessage = "Address hosted feedback";
    provider.planner.responses.push(repaired);
    provider.reviewer.responses.push({ verdict: "approve", summary: "The repaired exact head is approved.", findings: [] });
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(provider)));
    const github = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    github.observations = [
      {
        checks: [{ name: "verify", status: "completed", conclusion: "success", headSha: "$HEAD", producer: "github-actions" }],
        reviews: [{ id: 9, state: "APPROVED", commitId: "$HEAD", body: "## VERDICT: APPROVE", actor: "review-bot" }],
        comments: [{
          id: 10,
          actor: "maintainer",
          body: "## SHIPPER FEEDBACK\nScope: in_scope\nHead: $HEAD\n\nAdd the hosted-feedback documentation comment.",
        }],
      },
      {
        checks: [{ name: "verify", status: "completed", conclusion: "success", headSha: "$HEAD", producer: "github-actions" }],
        reviews: [{ id: 11, state: "APPROVED", commitId: "$HEAD", body: "## VERDICT: APPROVE", actor: "review-bot" }],
        comments: [],
      },
    ];
    writeFileSync(githubFixturePath, JSON.stringify(github));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-repair-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.iterations, 2);
    assert.equal(output.reviewAttempts, 2);
    assert.equal(output.pullRequest.number, 24);
    assert.equal(output.verification.headSha, output.headSha);
    assert.equal(output.documentation.headSha, output.headSha);
    assert.equal(output.reviewVerdict.headSha, output.headSha);
    assert.equal(output.hosted.headSha, output.headSha);
    const fixtureState = githubFixtureState(fixture, "open-pr-repair-1");
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.kind === "push_branch").length, 2);
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.method === "POST").length, 3);
    assert.equal(
      fixtureState.events.filter((event: Record<string, unknown>) => (
        event.method === "POST" && String(event.path).endsWith("/comments")
      )).length,
      2,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr escalates source-revision drift before any GitHub write", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.workSources.allowedKinds = ["github_issue"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "use issue source"]);
    const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
    request.workItem.source = { kind: "github_issue", identity: "#24", revision: "2026-08-15T10:00:00Z" };
    writeFileSync(fixture.requestPath, JSON.stringify(request));
    const github = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    github.issue = { number: 24, revision: "2026-08-15T10:30:00Z" };
    writeFileSync(githubFixturePath, JSON.stringify(github));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-source-drift-1", "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match(result.stdout, /source revision drifted/);
    const fixtureState = githubFixtureState(fixture, "open-pr-source-drift-1");
    assert.equal(fixtureState.events.some((event: Record<string, unknown>) => event.kind === "push_branch"), false);
    assert.equal(fixtureState.events.some((event: Record<string, unknown>) => event.method === "POST"), false);
    const status = runCli(["status", "--run-id", "open-pr-source-drift-1", "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const durable = JSON.parse(status.stdout) as Record<string, any>;
    assert.equal(durable.delivery.sourceRevision.drifted, true);
    assert.equal(durable.repair.active, false);
    assert.match(durable.escalationReason, /source revision drifted/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr monitors pending hosted evidence without inventing a repair", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const github = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    github.observations = [
      {
        checks: [{ name: "verify", status: "in_progress", conclusion: null, headSha: "$HEAD", producer: "github-actions" }],
        reviews: [], comments: [],
      },
      {
        checks: [{ name: "verify", status: "completed", conclusion: "success", headSha: "$HEAD", producer: "github-actions" }],
        reviews: [{ id: 12, state: "APPROVED", commitId: "$HEAD", body: "## VERDICT: APPROVE", actor: "review-bot" }],
        comments: [],
      },
    ];
    writeFileSync(githubFixturePath, JSON.stringify(github));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-monitor-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.iterations, 1);
    assert.equal(output.reviewAttempts, 1);
    assert.equal(output.hosted.hostedChecksGreen, true);
    const fixtureState = githubFixtureState(fixture, "open-pr-monitor-1");
    assert.equal(fixtureState.observationIndex, 2);
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.kind === "wait_for_observation").length, 1);
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.kind === "push_branch").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr rechecks source revision while hosted evidence is pending", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.workSources.allowedKinds = ["github_issue"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "monitor issue source"]);
    const expectedRevision = "2026-08-15T10:00:00Z";
    const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
    request.workItem.source = { kind: "github_issue", identity: "#24", revision: expectedRevision };
    writeFileSync(fixture.requestPath, JSON.stringify(request));
    const github = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    github.issue = { number: 24, revisions: [expectedRevision, "2026-08-15T10:30:00Z"] };
    github.observations = [
      {
        checks: [{ name: "verify", status: "in_progress", conclusion: null, headSha: "$HEAD", producer: "github-actions" }],
        reviews: [], comments: [],
      },
      {
        checks: [{ name: "verify", status: "completed", conclusion: "success", headSha: "$HEAD", producer: "github-actions" }],
        reviews: [{ id: 15, state: "APPROVED", commitId: "$HEAD", body: "## VERDICT: APPROVE", actor: "review-bot" }],
        comments: [],
      },
    ];
    writeFileSync(githubFixturePath, JSON.stringify(github));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-source-monitor-drift-1", "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match(result.stdout, /source revision drifted/);
    const fixtureState = githubFixtureState(fixture, "open-pr-source-monitor-drift-1");
    assert.equal(fixtureState.observationIndex, 1);
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.kind === "push_branch").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr rechecks source revision immediately before terminal acceptance", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.workSources.allowedKinds = ["github_issue"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "bind terminal issue source"]);
    const expectedRevision = "2026-08-15T10:00:00Z";
    const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
    request.workItem.source = { kind: "github_issue", identity: "#24", revision: expectedRevision };
    writeFileSync(fixture.requestPath, JSON.stringify(request));
    const github = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    github.issue = { number: 24, revisions: [expectedRevision, "2026-08-15T10:30:00Z"] };
    writeFileSync(githubFixturePath, JSON.stringify(github));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-terminal-source-drift-1", "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match(result.stdout, /source revision drifted/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr escalates PR-head drift without repairing an unauthorized revision", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    const github = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    github.observations[0].pullRequestHeadSha = "2".repeat(40);
    writeFileSync(githubFixturePath, JSON.stringify(github));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "open-pr-head-drift-1", "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match(result.stdout, /pull request head drifted/);
    const fixtureState = githubFixtureState(fixture, "open-pr-head-drift-1");
    assert.equal(fixtureState.events.filter((event: Record<string, unknown>) => event.kind === "push_branch").length, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("GitHub fixture state stays outside the target repository", () => {
  const fixture = createRunnableFixture();
  try {
    const externalFixturePath = enableOpenPr(fixture);
    const repositoryFixturePath = join(fixture.root, "github-fixture.json");
    writeFileSync(repositoryFixturePath, readFileSync(externalFixturePath));
    git(fixture.root, ["add", "github-fixture.json"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "track deterministic GitHub input"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", repositoryFixturePath, "--run-id", "open-pr-external-state-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(`${repositoryFixturePath}.state.json`), false);
    assert.equal(existsSync(join(fixture.dataRoot, "github-fixtures", "open-pr-external-state-1.json")), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("help documents run identity and fault-injection options", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /--run-id <id>/);
  assert.match(result.stdout, /--crash-after-intent <effect>/);
  assert.match(result.stdout, /--crash-after-effect <effect>/);
  assert.match(result.stdout, /fault-injection/i);
});

test("run rejects an incomplete Work Item before creating a workspace or invoking a provider", () => {
  const fixture = createTrackedProject();
  try {
    activate(fixture.root, fixture.dataRoot);
    const requestPath = join(fixture.dataRoot, "incomplete-run-request.json");
    writeFileSync(requestPath, JSON.stringify({
      schemaVersion: "1.0.0",
      workItem: {
        id: "fixture-request-1",
        projectId: "fixture-project",
        source: { kind: "feature_request", identity: "fixture-request-1", revision: "revision-1" },
        baseBranch: "main",
        title: "Add one fixture behavior",
        body: "The observable behavior was omitted.",
        desiredBehavior: [],
        acceptanceCriteria: [],
        constraints: [],
        provenance: ["request:title", "request:body"],
      },
      buildAssignmentId: "anthropic-build",
      reviewAssignmentId: "openai-review",
      autonomy: "local_only",
    }));

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", requestPath, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr);
    const output = JSON.parse(result.stdout) as { error: string; details: string[] };
    assert.match(output.error, /Work Item intake is incomplete/);
    assert.match(output.details.join("\n"), /desired observable behavior|acceptance evidence/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces")), false);
    assert.equal(existsSync(join(fixture.dataRoot, "traces")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run rejects credential-like tracked model context without exposing it", () => {
  const fixture = createRunnableFixture();
  const credentialLikeValue = `sk-ant-api03-${"x".repeat(32)}`;
  try {
    mkdirSync(join(fixture.root, "config"));
    writeFileSync(join(fixture.root, "config", "settings.txt"), `provider_key=${credentialLikeValue}\n`);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.models.repositoryContext.includeGlobs.push("config/**");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "config/settings.txt"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add unsafe model context fixture"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /credential-like material/);
    assert.doesNotMatch(output, new RegExp(credentialLikeValue));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an explicit Work Item context manifest narrows planner input without narrowing independent review", () => {
  const fixture = createRunnableFixture();
  const credentialLikeValue = `sk-ant-api03-${"m".repeat(32)}`;
  try {
    mkdirSync(join(fixture.root, "src"));
    writeFileSync(join(fixture.root, "src", "ambient-secret.ts"), `export const value = ${JSON.stringify(credentialLikeValue)};\n`);
    git(fixture.root, ["add", "src/ambient-secret.ts"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add contract-allowed ambient context"]);
    activate(fixture.root, fixture.dataRoot);

    const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
    request.workItem.repositoryContextManifest = { paths: ["README.md"] };
    writeFileSync(fixture.requestPath, JSON.stringify(request));

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "explicit-context-manifest-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as { evidencePath: string; reviewVerdict: { verdict: string } };
    assert.equal(output.reviewVerdict.verdict, "approve");
    const evidence = JSON.parse(readFileSync(output.evidencePath, "utf8")) as Record<string, any>;
    assert.deepEqual(evidence.workItem.repositoryContextManifest.paths, ["README.md"]);
    assert.deepEqual(evidence.changedFiles, ["README.md", "src/answer.js"]);
    assert.doesNotMatch(readFileSync(output.evidencePath, "utf8"), new RegExp(credentialLikeValue));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an explicit Work Item context manifest fails closed before provider dispatch", async (t) => {
  const credentialLikeValue = `sk-ant-api03-${"n".repeat(32)}`;
  const aggregatePaths = Array.from({ length: 9 }, (_, index) => `src/context-${index}.ts`);
  const scenarios: Array<{
    name: string;
    paths: string[];
    setup?: (fixture: ReturnType<typeof createRunnableFixture>) => void;
    error: RegExp;
    durable: boolean;
  }> = [
    {
      name: "path outside activated context authority",
      paths: ["scripts/verify.mjs"],
      error: /exceeds the activated Project Contract/,
      durable: false,
    },
    {
      name: "non-canonical traversal path",
      paths: ["../README.md"],
      error: /canonical project-relative repository path/,
      durable: false,
    },
    {
      name: "duplicate path",
      paths: ["README.md", "README.md"],
      error: /duplicate repository context path/,
      durable: false,
    },
    {
      name: "missing tracked path",
      paths: ["src/missing.ts"],
      error: /not tracked/,
      durable: true,
    },
    {
      name: "tracked symlink",
      paths: ["src/link.ts"],
      setup: (fixture) => {
        mkdirSync(join(fixture.root, "src"));
        symlinkSync("../README.md", join(fixture.root, "src", "link.ts"));
        git(fixture.root, ["add", "src/link.ts"]);
        git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add context symlink"]);
      },
      error: /symlink/,
      durable: true,
    },
    {
      name: "credential-like selected content",
      paths: ["src/credential.ts"],
      setup: (fixture) => {
        mkdirSync(join(fixture.root, "src"));
        writeFileSync(join(fixture.root, "src", "credential.ts"), `export const value = ${JSON.stringify(credentialLikeValue)};\n`);
        git(fixture.root, ["add", "src/credential.ts"]);
        git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add unsafe selected context"]);
      },
      error: /credential-like material/,
      durable: true,
    },
    {
      name: "oversized selected file",
      paths: ["src/oversized.ts"],
      setup: (fixture) => {
        mkdirSync(join(fixture.root, "src"));
        writeFileSync(join(fixture.root, "src", "oversized.ts"), "x".repeat(128 * 1024 + 1));
        git(fixture.root, ["add", "src/oversized.ts"]);
        git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add oversized selected context"]);
      },
      error: /exceeds 128 KiB/,
      durable: true,
    },
    {
      name: "aggregate context above the explicit limit",
      paths: aggregatePaths,
      setup: (fixture) => {
        mkdirSync(join(fixture.root, "src"));
        for (const path of aggregatePaths) writeFileSync(join(fixture.root, path), "x".repeat(120 * 1024));
        git(fixture.root, ["add", "src"]);
        git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add aggregate oversized context"]);
      },
      error: /exceeds the 1 MiB limit/,
      durable: true,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, () => {
      const fixture = createRunnableFixture();
      const runId = `invalid-context-manifest-${index}`;
      try {
        scenario.setup?.(fixture);
        activate(fixture.root, fixture.dataRoot);
        const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
        request.workItem.repositoryContextManifest = { paths: scenario.paths };
        writeFileSync(fixture.requestPath, JSON.stringify(request));

        const result = runCli([
          "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
          "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
          "--run-id", runId, "--json",
        ]);

        assert.notEqual(result.status, 0, result.stdout);
        const rendered = `${result.stdout}\n${result.stderr}`;
        assert.match(rendered, scenario.error);
        assert.doesNotMatch(rendered, new RegExp(credentialLikeValue));
        if (scenario.durable) {
          const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
          assert.equal(status.status, 0, status.stderr || status.stdout);
          const output = JSON.parse(status.stdout) as { state: { modelInvocations: unknown[] } };
          assert.deepEqual(output.state.modelInvocations, []);
        } else {
          assert.equal(existsSync(join(fixture.dataRoot, "workspaces")), false);
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
        rmSync(fixture.dataRoot, { recursive: true, force: true });
      }
    });
  }
});

test("existing-file write_file is refused before any action effect", () => {
  const fixture = createRunnableFixture();
  const runId = "existing-write-refused-1";
  try {
    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    recorded.planner.responses[0].actions = [
      { kind: "write_file", path: "src/partial.js", content: "export const partial = true;\n" },
      { kind: "write_file", path: "README.md", content: "Replace the overview narrowly." },
    ];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /write_file requires a new path/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(existsSync(join(status.state.workspacePath, "src", "partial.js")), false);
    const store = new StateStore(fixture.dataRoot);
    try {
      assert.equal(store.preparedEffect(runId), undefined);
    } finally {
      store.close();
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("base-bound edit_file refuses stale, ambiguous, overlapping, and duplicate edits atomically", async (t) => {
  const readme = "# Fixture Project\n";
  const digestValue = createHash("sha256").update(readme).digest("hex");
  const scenarios: Array<{ name: string; actions: Record<string, unknown>[]; error: RegExp }> = [
    {
      name: "stale base digest",
      actions: [{
        kind: "edit_file", path: "README.md", baseContentSha256: "0".repeat(64),
        replacements: [{ oldText: readme, newText: "# Changed\n" }],
      }],
      error: /base digest is stale/,
    },
    {
      name: "missing old text",
      actions: [{
        kind: "edit_file", path: "README.md", baseContentSha256: digestValue,
        replacements: [{ oldText: "not present", newText: "changed" }],
      }],
      error: /oldText was not found/,
    },
    {
      name: "ambiguous old text",
      actions: [{
        kind: "edit_file", path: "README.md", baseContentSha256: digestValue,
        replacements: [{ oldText: "e", newText: "E" }],
      }],
      error: /oldText is ambiguous/,
    },
    {
      name: "overlapping replacements",
      actions: [{
        kind: "edit_file", path: "README.md", baseContentSha256: digestValue,
        replacements: [
          { oldText: "# Fixture", newText: "# Runtime" },
          { oldText: "Fixture Project", newText: "Runtime Project" },
        ],
      }],
      error: /replacements overlap/,
    },
    {
      name: "duplicate target",
      actions: [
        {
          kind: "edit_file", path: "README.md", baseContentSha256: digestValue,
          replacements: [{ oldText: "# Fixture", newText: "# Runtime" }],
        },
        {
          kind: "edit_file", path: "README.md", baseContentSha256: digestValue,
          replacements: [{ oldText: "Project", newText: "Workspace" }],
        },
      ],
      error: /targets a file more than once/,
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, () => {
      const fixture = createRunnableFixture();
      const runId = `invalid-edit-file-${index}`;
      try {
        const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
        recorded.planner.responses[0].actions = [
          { kind: "write_file", path: "src/partial.js", content: "export const partial = true;\n" },
          ...scenario.actions,
        ];
        writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
        activate(fixture.root, fixture.dataRoot);

        const result = runCli([
          "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
          "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
          "--run-id", runId, "--json",
        ]);

        assert.equal(result.status, 3, result.stderr || result.stdout);
        assert.match(result.stdout, scenario.error);
        const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
        assert.equal(existsSync(join(status.state.workspacePath, "src", "partial.js")), false);
        assert.equal(readFileSync(join(status.state.workspacePath, "README.md"), "utf8"), readme);
        const store = new StateStore(fixture.dataRoot);
        try {
          assert.equal(store.preparedEffect(runId), undefined);
        } finally {
          store.close();
        }
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
        rmSync(fixture.dataRoot, { recursive: true, force: true });
      }
    });
  }
});

test("run rejects credential-like command output without exposing or forwarding it", () => {
  const fixture = createRunnableFixture();
  const credentialLikeValue = `sk-proj-${"y".repeat(32)}`;
  try {
    const verifierPath = join(fixture.root, "scripts", "verify.mjs");
    writeFileSync(verifierPath, `${readFileSync(verifierPath, "utf8")}\nprocess.stdout.write(${JSON.stringify(credentialLikeValue)});\n`);
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add unsafe gate output fixture"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /credential-like material/);
    assert.doesNotMatch(output, new RegExp(credentialLikeValue));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("final evidence publication refuses an ancestor symlink outside the private data root", () => {
  const fixture = createRunnableFixture();
  const externalRoot = mkdtempSync(join(tmpdir(), "graph-shipper-evidence-external-"));
  try {
    activate(fixture.root, fixture.dataRoot);
    symlinkSync(externalRoot, join(fixture.dataRoot, "runs"));

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-evidence-symlink-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /symlink/);
    assert.equal(existsSync(join(externalRoot, "fixture-evidence-symlink-1", "evidence.json")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("documentation verification skips symlink targets and living-only checks on historical Markdown", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.documentation.rules.push({
      id: "linked-reference", glob: "LINKED.md", class: "vendored_reference",
      audience: "reference", topics: ["external-reference"], entryPoint: false, protected: true,
    });
    contract.documentation.rules.push({
      id: "historical-reference", glob: "HISTORICAL.md", class: "historical",
      audience: "reference", topics: ["history"], entryPoint: false, protected: true,
    });
    writeFileSync(contractPath, stringify(contract));
    writeFileSync(join(fixture.root, "HISTORICAL.md"), "# Repeated\n# Repeated\n[historical placeholder](missing.md)\n");
    symlinkSync(join(fixture.root, "missing-external-reference.md"), join(fixture.root, "LINKED.md"));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "HISTORICAL.md", "LINKED.md"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add tracked markdown link"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-markdown-symlink-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((JSON.parse(result.stdout) as { status: string }).status, "completed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an unimplemented verifier variant is refused at onboarding, so no run can reach a workspace", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.verification.checks[0].executor = { kind: "builtin", check: "future-builtin" };
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare future builtin"]);

    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 3, onboard.stdout);
    assert.match(onboard.stdout + onboard.stderr, /verification executor .*builtin.* is not executable/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run rejects repository-local Git clean filters before workspace creation or staging", () => {
  const fixture = createRunnableFixture();
  try {
    const marker = join(fixture.dataRoot, "git-filter-ran.txt");
    writeFileSync(join(fixture.root, "scripts", "filter.mjs"), [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, "ran\\n");`,
      'process.stdout.write(readFileSync(0));',
    ].join("\n"));
    writeFileSync(join(fixture.root, ".gitattributes"), "*.js filter=shipper\n");
    git(fixture.root, ["config", "filter.shipper.clean", "node scripts/filter.mjs"]);
    git(fixture.root, ["add", ".gitattributes", "scripts/filter.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "configure repository filter"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /Git filter/i);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run rejects a prospective workspace whose existing ancestor traverses a symlink into the primary clone", () => {
  const fixture = createRunnableFixture();
  try {
    mkdirSync(join(fixture.root, "owned-workspaces"));
    symlinkSync(fixture.root, join(fixture.dataRoot, "linked-project"));
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.workspace.rootTemplate = `${fixture.dataRoot}/linked-project/owned-workspaces/<run-id>`;
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "configure nested linked workspace"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /symlink|outside the primary clone/i);
    assert.equal(existsSync(join(fixture.root, "owned-workspaces", "fixture-request-1")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run enforces the activated project Work Run concurrency ceiling", () => {
  const fixture = createRunnableFixture();
  let store: StateStore | undefined;
  try {
    activate(fixture.root, fixture.dataRoot);
    store = new StateStore(fixture.dataRoot);
    store.claimWorkRun("held-run", "fixture-project", "held-owner", 1);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--run-id", "blocked-by-concurrency", "--request", fixture.requestPath,
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /maximum concurrent Work Runs/i);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", "blocked-by-concurrency")), false);
  } finally {
    try { store?.releaseWorkRunClaim("held-run", "held-owner"); } catch { /* best effort */ }
    store?.close();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run produces an exact-head Anthropic-built OpenAI-reviewed local handoff", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.autonomy, "local_only");
    assert.equal(output.buildProvider, "anthropic");
    assert.equal(output.reviewProvider, "openai");
    assert.match(output.headSha, /^[0-9a-f]{40}$/);
    assert.equal(output.reviewVerdict.verdict, "approve");
    assert.equal(output.reviewVerdict.headSha, output.headSha);
    assert.equal(output.verification.headSha, output.headSha);
    assert.equal(output.documentation.headSha, output.headSha);
    assert.equal(readFileSync(join(output.workspacePath, "src", "answer.js"), "utf8"), "export function answerFeature() { return 42; }\n");
    assert.equal(git(output.workspacePath, ["status", "--porcelain"]), "");
    assert.equal(
      git(output.workspacePath, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"]),
      "Graph Shipper <graph-shipper@localhost.invalid>\nGraph Shipper <graph-shipper@localhost.invalid>",
    );
    assert.equal(git(fixture.root, ["rev-parse", "main"]), output.baseSha);
    assert.ok(existsSync(output.evidencePath));
    const evidence = JSON.parse(readFileSync(output.evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.reviewVerdict.verdict, "approve");
    assert.equal(evidence.cleanupDisposition, "preserve_owned_branch_and_worktree");
    assert.equal(evidence.cleanupPolicy.onLocalOnlyHandoff, evidence.cleanupDisposition);
    assert.equal(evidence.cleanupPolicy.removeOwnedWorktreeAfterDeliveryTerminalSuccess, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run authors its commit with the delivery commit identity", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.delivery.commitIdentity = { name: "Fixture Shipper", email: "fixture-shipper@example.invalid" };
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "configure shipper commit identity",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "configured-commit-identity", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(
      git(output.workspacePath, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"]),
      "Fixture Shipper <fixture-shipper@example.invalid>\nFixture Shipper <fixture-shipper@example.invalid>",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("the same Work Item completes with OpenAI build and fresh Anthropic review", () => {
  const fixture = createRunnableFixture();
  try {
    selectReciprocalDirection(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.buildProvider, "openai");
    assert.equal(output.reviewProvider, "anthropic");
    assert.equal(output.reviewVerdict.provider, "anthropic");
    assert.equal(output.reviewVerdict.buildProvider, "openai");
    assert.equal(output.reviewVerdict.headSha, output.headSha);
    assert.equal(output.modelRuntimeIdentity.runtimeVersion, "0.4.0");
    assert.equal(output.modelRuntimeIdentity.runtimeRevision, git(process.cwd(), ["rev-parse", "HEAD"]));
    assert.deepEqual(output.modelRuntimeIdentity.build, { provider: "openai", transport: "api", modelRef: "recorded-openai-build" });
    assert.deepEqual(output.modelRuntimeIdentity.review, { provider: "anthropic", transport: "api", modelRef: "recorded-anthropic-review" });
    assert.deepEqual(output.modelRuntimeIdentity.invocations.map((invocation: Record<string, unknown>) => ({
      role: invocation.role, assignmentId: invocation.assignmentId, provider: invocation.provider,
      modelRef: invocation.modelRef, outcome: invocation.outcome,
    })), [
      { role: "planner", assignmentId: "openai-build", provider: "openai", modelRef: "recorded-openai-build", outcome: "success" },
      { role: "reviewer", assignmentId: "anthropic-review", provider: "anthropic", modelRef: "recorded-anthropic-review", outcome: "success" },
    ]);
    assert.deepEqual(output.modelFailures, []);
    const evidence = JSON.parse(readFileSync(output.evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.buildProvider, "openai");
    assert.equal(evidence.reviewProvider, "anthropic");
    assert.deepEqual(evidence.modelRuntimeIdentity, output.modelRuntimeIdentity);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("one malformed-output retry precedes configured same-provider fallbacks without persisting provider payloads", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.models.buildAssignments[0].fallbackAssignmentIds = ["anthropic-build-fallback"];
    contract.models.buildAssignments.push({
      id: "anthropic-build-fallback", provider: "anthropic", modelRef: "fallback-anthropic-build",
      credentialRef: "anthropic-default",
    });
    contract.models.reviewAssignments[0].fallbackAssignmentIds = ["openai-review-fallback"];
    contract.models.reviewAssignments.push({
      id: "openai-review-fallback", provider: "openai", modelRef: "fallback-openai-review",
      credentialRef: "openai-default",
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "configure model fallbacks"]);

    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const plan = recorded.planner.responses[0];
    const verdict = recorded.reviewer.responses[0];
    recorded.planner.responses[0] = [
      { kind: "provider_failure", failure: "malformed_output", message: "raw malformed provider payload credential-super-secret" },
      { kind: "provider_failure", failure: "auth", message: "provider rejected credential-super-secret" },
    ];
    recorded.plannerFallbacks = [{
      assignmentId: "anthropic-build-fallback", provider: "anthropic", modelRef: "recorded-anthropic-fallback", responses: [plan],
    }];
    recorded.reviewer.responses[0] = [
      { kind: "provider_failure", failure: "malformed_output", message: "raw schema payload credential-super-secret" },
      { kind: "provider_failure", failure: "rate_limit", message: "provider quota payload credential-super-secret" },
    ];
    recorded.reviewerFallbacks = [{
      assignmentId: "openai-review-fallback", provider: "openai", modelRef: "recorded-openai-fallback", responses: [verdict],
    }];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const evidenceSource = readFileSync(output.evidencePath, "utf8");
    const evidence = JSON.parse(evidenceSource) as Record<string, any>;
    assert.deepEqual(evidence.modelFailures.map((failure: Record<string, unknown>) => failure.kind), [
      "malformed_output", "auth", "malformed_output", "rate_limit",
    ]);
    assert.deepEqual(evidence.modelRuntimeIdentity.build, { provider: "anthropic", transport: "api", modelRef: "recorded-anthropic-fallback" });
    assert.deepEqual(evidence.modelRuntimeIdentity.review, { provider: "openai", transport: "api", modelRef: "recorded-openai-fallback" });
    assert.deepEqual(evidence.modelRuntimeIdentity.invocations.map((invocation: Record<string, unknown>) => ({
      assignmentId: invocation.assignmentId, modelRef: invocation.modelRef, outcome: invocation.outcome,
    })), [
      { assignmentId: "anthropic-build", modelRef: "recorded-planner", outcome: "malformed_output" },
      { assignmentId: "anthropic-build", modelRef: "recorded-planner", outcome: "auth" },
      { assignmentId: "anthropic-build-fallback", modelRef: "recorded-anthropic-fallback", outcome: "success" },
      { assignmentId: "openai-review", modelRef: "recorded-reviewer", outcome: "malformed_output" },
      { assignmentId: "openai-review", modelRef: "recorded-reviewer", outcome: "rate_limit" },
      { assignmentId: "openai-review-fallback", modelRef: "recorded-openai-fallback", outcome: "success" },
    ]);
    assert.doesNotMatch(evidenceSource, /credential-super-secret|raw malformed provider payload|quota payload/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a planner schema refusal uses the configured same-provider fallback", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.models.buildAssignments[0].fallbackAssignmentIds = ["anthropic-build-fallback"];
    contract.models.buildAssignments.push({
      id: "anthropic-build-fallback", provider: "anthropic", modelRef: "fallback-anthropic-build",
      credentialRef: "anthropic-default",
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "configure planner fallback"]);

    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const plan = recorded.planner.responses[0];
    recorded.planner.responses[0] = { kind: "refusal", reason: "The provider declined this request." };
    recorded.plannerFallbacks = [{
      assignmentId: "anthropic-build-fallback", provider: "anthropic",
      modelRef: "recorded-anthropic-fallback", responses: [plan],
    }];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.deepEqual(output.modelFailures.map((failure: Record<string, unknown>) => failure.kind), ["refusal"]);
    assert.deepEqual(output.modelRuntimeIdentity.invocations.map((invocation: Record<string, unknown>) => ({
      assignmentId: invocation.assignmentId, modelRef: invocation.modelRef, outcome: invocation.outcome,
    })), [
      { assignmentId: "anthropic-build", modelRef: "recorded-planner", outcome: "refusal" },
      { assignmentId: "anthropic-build-fallback", modelRef: "recorded-anthropic-fallback", outcome: "success" },
      { assignmentId: "openai-review", modelRef: "recorded-reviewer", outcome: "success" },
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("exhausted planner schema refusals escalate without persisting refusal reasons", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.models.buildAssignments[0].fallbackAssignmentIds = ["anthropic-build-fallback"];
    contract.models.buildAssignments.push({
      id: "anthropic-build-fallback", provider: "anthropic", modelRef: "fallback-anthropic-build",
      credentialRef: "anthropic-default",
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "configure planner fallback"]);

    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    recorded.planner.responses[0] = { kind: "refusal", reason: "primary refusal credential-super-secret" };
    recorded.plannerFallbacks = [{
      assignmentId: "anthropic-build-fallback", provider: "anthropic",
      modelRef: "recorded-anthropic-fallback",
      responses: [{ kind: "refusal", reason: "fallback refusal credential-super-secret" }],
    }];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);
    const runId = "planner-schema-refusals-exhausted";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--run-id", runId, "--request", fixture.requestPath,
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const durable = JSON.parse(status.stdout) as Record<string, any>;
    assert.equal(durable.status, "escalated");
    assert.deepEqual(durable.state.errors, ["model:refusal"]);
    assert.deepEqual(durable.state.modelInvocations.map((invocation: Record<string, unknown>) => ({
      assignmentId: invocation.assignmentId, modelRef: invocation.modelRef, outcome: invocation.outcome,
    })), [
      { assignmentId: "anthropic-build", modelRef: "recorded-planner", outcome: "refusal" },
      { assignmentId: "anthropic-build-fallback", modelRef: "recorded-anthropic-fallback", outcome: "refusal" },
    ]);
    assert.doesNotMatch(`${result.stdout}\n${status.stdout}`, /credential-super-secret|primary refusal|fallback refusal/);
    const refusalPath = (JSON.parse(result.stdout) as { details: string[] }).details
      .find((detail) => detail.startsWith("planner_refusal_path:"))?.slice("planner_refusal_path:".length);
    assert.ok(refusalPath, result.stdout);
    assert.equal(readFileSync(refusalPath, "utf8"), "fallback refusal credential-super-secret\n");
    assert.equal(statSync(refusalPath).mode & 0o777, 0o600);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("subscription CLI diagnostics survive escalation without persisting provider output", () => {
  const fixture = createRunnableFixture();
  try {
    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    recorded.planner.responses[0] = {
      kind: "provider_failure",
      failure: "transport",
      message: "raw provider output opaque-super-secret private-account@example.com",
      subscriptionCliDiagnostic: { exitStatus: 1, category: "network" },
    };
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);
    const runId = "subscription-cli-diagnostic-escalation";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--run-id", runId, "--request", fixture.requestPath,
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const durable = JSON.parse(status.stdout) as Record<string, any>;
    assert.deepEqual(durable.state.errors, [
      "model:transport",
      "model:subscription_cli_exit_status:1",
      "model:subscription_cli_diagnostic:network",
    ]);
    const trace = readFileSync(join(fixture.dataRoot, "traces", `${runId}.jsonl`), "utf8");
    assert.match(trace, /"details":\["subscription_cli_exit_status:1","subscription_cli_diagnostic:network"\]/);
    assert.doesNotMatch(`${result.stdout}\n${status.stdout}\n${trace}`, /opaque-super-secret|private-account@example\.com|raw provider output/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("identical Work Items take deterministic, documentation, and review repair paths in both provider directions", () => {
  for (const direction of ["anthropic-build", "openai-build"] as const) {
    const fixture = createRunnableFixture();
    try {
      if (direction === "openai-build") selectReciprocalDirection(fixture);
      const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
      const complete = recorded.planner.responses[0];
      const answer41 = "export function answerFeature() { return 41; }\n";
      const answer42 = "export function answerFeature() { return 42; }\n";
      const reviewedAnswer = "/** Reviewed exact-head behavior. */\nexport function answerFeature() { return 42; }\n";
      const finalReadme = "# Fixture Project\n\n`answerFeature()` returns 42.\n";
      const draftReadme = "# Fixture Project\n\nDraft: `answerFeature()` returns 42.\n";
      recorded.planner.responses = [
        {
          ...complete,
          summary: "First attempt fails deterministic verification.",
          actions: [
            { kind: "write_file", path: "src/answer.js", content: answer41 },
            complete.actions[1],
          ],
          commitMessage: "Attempt answer behavior",
        },
        {
          ...complete,
          summary: "Repair behavior but induce documentation disposition failure.",
          actions: [
            {
              kind: "edit_file", path: "src/answer.js", baseContentSha256: createHash("sha256").update(answer41).digest("hex"),
              replacements: [{ oldText: answer41, newText: answer42 }],
            },
            {
              kind: "edit_file", path: "README.md", baseContentSha256: createHash("sha256").update(finalReadme).digest("hex"),
              replacements: [{ oldText: finalReadme, newText: draftReadme }],
            },
          ],
          documentation: {
            kind: "no_change_attestation", changedSurfaces: ["source only"], topicsExamined: ["overview"],
            documentsExamined: ["README.md"], rationale: "Incorrectly claims no documentation change.",
          },
          commitMessage: "Repair answer behavior",
        },
        {
          ...complete,
          summary: "Repair documentation disposition.",
          actions: [{
            kind: "edit_file", path: "README.md", baseContentSha256: createHash("sha256").update(draftReadme).digest("hex"),
            replacements: [{ oldText: "Draft: `answerFeature()` returns 42.", newText: "Draft: `answerFeature()` returns 42." }],
          }],
          commitMessage: "Repair documentation evidence",
        },
        {
          ...complete,
          summary: "Repair the independent review finding.",
          actions: [
            {
              kind: "edit_file", path: "src/answer.js", baseContentSha256: createHash("sha256").update(answer42).digest("hex"),
              replacements: [{ oldText: answer42, newText: reviewedAnswer }],
            },
            {
              kind: "edit_file", path: "README.md", baseContentSha256: createHash("sha256").update(draftReadme).digest("hex"),
              replacements: [{ oldText: draftReadme, newText: finalReadme }],
            },
          ],
          commitMessage: "Apply independent review repair",
        },
      ];
      recorded.reviewer.responses = [{
        verdict: "changes_requested",
        summary: "One in-scope repair is required.",
        findings: [{
          id: "matrix-review-1", severity: "blocking", category: "maintainability", location: "src/answer.js:1",
          evidence: "The exported behavior lacks its required comment.", requiredAction: "Add the comment.", scopeRelation: "in_scope",
        }],
      }, { verdict: "approve", summary: "The exact-head repair is complete.", findings: [] }];
      writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
      activate(fixture.root, fixture.dataRoot);

      const result = runCli([
        "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      ]);

      assert.equal(result.status, 0, `${direction}: ${result.stderr || result.stdout}`);
      const output = JSON.parse(result.stdout) as Record<string, any>;
      assert.equal(output.iterations, 4, direction);
      assert.equal(output.reviewAttempts, 2, direction);
      assert.equal(output.reviewVerdict.headSha, output.headSha, direction);
      assert.equal(output.verification.headSha, output.headSha, direction);
      assert.equal(output.documentation.headSha, output.headSha, direction);
      assert.equal(output.reviewVerdict.provider, direction === "anthropic-build" ? "openai" : "anthropic");
      assert.match(readFileSync(join(output.workspacePath, "src", "answer.js"), "utf8"), /Reviewed exact-head behavior/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  }
});

test("provider refusals escalate with only a provider-neutral durable failure in both directions", () => {
  for (const direction of ["anthropic-build", "openai-build"] as const) {
    const fixture = createRunnableFixture();
    try {
      if (direction === "openai-build") selectReciprocalDirection(fixture);
      const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
      recorded.reviewer.responses = [{
        kind: "provider_failure", failure: "refusal", message: "raw provider refusal credential-super-secret",
      }];
      writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
      activate(fixture.root, fixture.dataRoot);
      const runId = `${direction}-refusal`;

      const result = runCli([
        "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--run-id", runId, "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      ]);

      assert.equal(result.status, 3, `${direction}: ${result.stderr || result.stdout}`);
      assert.doesNotMatch(result.stdout, /credential-super-secret|raw provider refusal/);
      const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
      assert.equal(status.status, 0, status.stderr || status.stdout);
      const durable = JSON.parse(status.stdout) as Record<string, any>;
      assert.equal(durable.status, "escalated");
      assert.equal(durable.state.runtimeVersion, "0.4.0");
      assert.deepEqual(durable.state.errors, ["model:refusal"]);
      assert.deepEqual(durable.state.modelInvocations.map((invocation: Record<string, unknown>) => invocation.outcome), ["success", "refusal"]);
      assert.deepEqual(durable.state.reviewBundle.fileActions, [
        { kind: "write_file", path: "src/answer.js" },
        { kind: "edit_file", path: "README.md" },
      ], direction);
      assert.doesNotMatch(status.stdout, /credential-super-secret|raw provider refusal/);
      const traceSource = readFileSync(join(fixture.dataRoot, "traces", `${runId}.jsonl`), "utf8");
      assert.doesNotMatch(traceSource, /credential-super-secret|raw provider refusal/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  }
});

test("run executes every-cycle verification even when trigger globs do not match", () => {
  const fixture = createRunnableFixture();
  try {
    const marker = join(fixture.dataRoot, "every-cycle-ran.txt");
    const verifierPath = join(fixture.root, "scripts", "verify.mjs");
    writeFileSync(verifierPath, [
      'import { readFileSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, "ran\\n");`,
      'const source = readFileSync(new URL("../src/answer.js", import.meta.url), "utf8");',
      'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
      'if (!source.includes("return 42") || !readme.includes("answerFeature")) process.exit(1);',
    ].join("\n"));
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.verification.checks[0].triggerGlobs = ["config/**"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare every-cycle verifier"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(marker, "utf8"), "ran\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run attributes a planned file whose path requires Git quoting", () => {
  const fixture = createRunnableFixture();
  try {
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("../src/answer-é.js", import.meta.url), "utf8");',
      'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
      'if (!source.includes("return 42") || !readme.includes("answerFeature")) process.exit(1);',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "verify spaced path"]);
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providerFixture.planner.responses[0].actions[0].path = "src/answer-é.js";
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(readFileSync(join(output.workspacePath, "src", "answer-é.js"), "utf8"), "export function answerFeature() { return 42; }\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume of a completed Work Run preserves its completed terminal status", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-completed-resume-1";
    const completed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);
    assert.equal(completed.status, 0, completed.stderr || completed.stdout);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 3, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /already completed/);

    const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal((JSON.parse(status.stdout) as { status: string }).status, "completed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume with a mismatched adapter fixture preserves the interrupted Work Run", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-mismatched-resume-adapter-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    writeFileSync(fixture.adapterFixturePath, `${readFileSync(fixture.adapterFixturePath, "utf8")}\n`);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /adapter binding changed/);

    const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const durable = JSON.parse(status.stdout) as { status: string; phase: string };
    assert.equal(durable.status, "running");
    assert.equal(durable.phase, "verify");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume rejects a different Graph Shipper runtime revision", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-mismatched-runtime-revision-1";
    const startedRevision = "a".repeat(40);
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ], { GRAPH_SHIPPER_RUNTIME_REVISION: startedRevision });
    assert.notEqual(crashed.status, 0);

    const status = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal((JSON.parse(status.stdout) as Record<string, any>).state.runtimeRevision, startedRevision);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ], { GRAPH_SHIPPER_RUNTIME_REVISION: "b".repeat(40) });
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /runtime revision changed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("runtime-owned Git operations disable repository-configured hooks", () => {
  const fixture = createRunnableFixture();
  try {
    const hooks = join(fixture.dataRoot, "hostile-hooks");
    const marker = join(fixture.dataRoot, "hook-ran.txt");
    mkdirSync(hooks);
    for (const name of ["post-checkout", "post-commit"]) {
      const path = join(hooks, name);
      writeFileSync(path, `#!/bin/sh\nprintf ran >> '${marker}'\n`);
      chmodSync(path, 0o700);
    }
    git(fixture.root, ["config", "core.hooksPath", hooks]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume adopts a workspace created in the intent-receipt crash gap without duplicating it", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-workspace-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);

    const duringCrash = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(duringCrash.status, 0, duringCrash.stderr);
    const interrupted = JSON.parse(duringCrash.stdout) as Record<string, any>;
    assert.equal(interrupted.status, "running");
    assert.equal(interrupted.phase, "workspace_intent");
    assert.equal(interrupted.pendingEffect.kind, "workspace_create");
    const beforeResume = git(fixture.root, ["worktree", "list", "--porcelain"]);
    assert.equal(beforeResume.match(/worktree /g)?.length, 2);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.runId, runId);
    assert.equal(git(fixture.root, ["worktree", "list", "--porcelain"]).match(/worktree /g)?.length, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume escalates a prepared workspace when unrelated drift appears", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-workspace-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    writeFileSync(join(interrupted.pendingEffect.target, "rogue.txt"), "unattributed\n");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /workspace effect is indeterminate/);
    assert.equal(readFileSync(join(interrupted.pendingEffect.target, "rogue.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume does not adopt a created workspace whose output is hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-workspace-hidden-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.pendingEffect.target as string;
    const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(excludePath, "\nhidden-output.txt\n");
    writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /workspace effect is indeterminate/);
    assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume adopts a file write from the intent-receipt crash gap without repeating the plan", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-file-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "file_write", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(interrupted.pendingEffect.kind, "file_write");
    assert.equal(readFileSync(join(interrupted.state.workspacePath, interrupted.pendingEffect.target), "utf8"), "export function answerFeature() { return 42; }\n");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.iterations, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume refuses an edit target externally changed to the desired bytes after preflight", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-edit-precondition-drift-1";
  try {
    activate(fixture.root, fixture.dataRoot);
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "act", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    writeFileSync(
      join(interrupted.state.workspacePath, "README.md"),
      "# Fixture Project\n\n`answerFeature()` returns 42.\n",
    );

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /prepared edit target changed before file effect/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume refuses a new-file target externally created with the desired bytes after preflight", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-new-file-precondition-drift-1";
  try {
    activate(fixture.root, fixture.dataRoot);
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "act", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    mkdirSync(join(interrupted.state.workspacePath, "src"), { recursive: true });
    writeFileSync(
      join(interrupted.state.workspacePath, "src", "answer.js"),
      "export function answerFeature() { return 42; }\n",
    );

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /prepared new-file target is no longer absent/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume re-drives an edit whose prepared intent still has its exact base bytes", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-edit-intent-crash-1";
  try {
    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    recorded.planner.responses[0].actions.reverse();
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-intent", "file_write", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(interrupted.pendingEffect.kind, "file_write");
    assert.equal(interrupted.pendingEffect.target, "README.md");
    assert.equal(
      readFileSync(join(interrupted.state.workspacePath, "README.md"), "utf8"),
      "# Fixture Project\n",
    );

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(
      readFileSync(join(output.workspacePath, "README.md"), "utf8"),
      "# Fixture Project\n\n`answerFeature()` returns 42.\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume attributes a prepared file write whose path requires Git quoting", () => {
  const fixture = createRunnableFixture();
  try {
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("../src/answer-é.js", import.meta.url), "utf8");',
      'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
      'if (!source.includes("return 42") || !readme.includes("answerFeature")) process.exit(1);',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "verify quoted recovery path"]);
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providerFixture.planner.responses[0].actions[0].path = "src/answer-é.js";
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-quoted-file-recovery-1";

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "file_write", "--json",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(readFileSync(join(output.workspacePath, "src", "answer-é.js"), "utf8"), "export function answerFeature() { return 42; }\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume escalates a prepared file write when unrelated workspace drift appears", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-file-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "file_write", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    writeFileSync(join(interrupted.state.workspacePath, "rogue.txt"), "unattributed\n");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /prepared file-write workspace drifted/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume does not attribute prepared-file output hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-file-hidden-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "file_write", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(excludePath, "\nhidden-output.txt\n");
    writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
    const visibleStatus = git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]);
    assert.match(visibleStatus, /src\/answer\.js/);
    assert.doesNotMatch(visibleStatus, /hidden-output/);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /prepared file-write workspace drifted/);
    assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume adopts a planned file write hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    appendFileSync(join(fixture.root, ".git", "info", "exclude"), "\nsrc/answer.js\n");
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-planned-hidden-file-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "file_write", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(
      git(output.workspacePath, ["show", `${output.headSha}:src/answer.js`]),
      "export function answerFeature() { return 42; }",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume adopts an attributable commit from the intent-receipt crash gap", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-commit-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "commit_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(interrupted.pendingEffect.kind, "commit_create");
    const committedHead = git(interrupted.state.workspacePath, ["rev-parse", "HEAD"]);
    assert.match(git(interrupted.state.workspacePath, ["log", "-1", "--format=%B"]), new RegExp(`Graph-Shipper-Run: ${runId}`));

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.headSha, committedHead);
    assert.equal(git(output.workspacePath, ["rev-list", "--count", `${output.baseSha}..${output.headSha}`]), "1");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume does not adopt a prepared commit over output hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-commit-hidden-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "commit_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(excludePath, "\nhidden-output.txt\n");
    writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /prepared commit workspace drifted/);
    assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

for (const effect of ["workspace_create", "commit_create"] as const) {
  test(`resume reconciles a completed ${effect} receipt before its next node checkpoint`, () => {
    const fixture = createRunnableFixture();
    try {
      activate(fixture.root, fixture.dataRoot);
      const runId = `fixture-post-receipt-${effect}`;
      const crashed = runCli([
        "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
        "--run-id", runId, "--crash-after-receipt", effect, "--json",
      ]);
      assert.notEqual(crashed.status, 0);
      const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
      assert.equal(interrupted.pendingEffect, null);

      const resumed = runCli([
        "resume", "--run-id", runId, "--project", fixture.root,
        "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      ]);
      assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
      const output = JSON.parse(resumed.stdout) as Record<string, any>;
      assert.equal(output.status, "completed");
      assert.equal(git(output.workspacePath, ["rev-list", "--count", `${output.baseSha}..${output.headSha}`]), "1");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  });
}

test("resume rejects hidden output before stale commit-receipt reconciliation", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-post-receipt-commit-hidden-drift";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-receipt", "commit_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(excludePath, "\nhidden-output.txt\n");
    writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /repair workspace drifted before stale-receipt reconciliation/);
    assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume does not adopt a completed workspace receipt over hidden output", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-post-receipt-workspace-hidden-drift";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-receipt", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(excludePath, "\nhidden-output.txt\n");
    writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /workspace drifted from its durable checkpoint/);
    assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume retains the pinned base when the base branch advances", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-pinned-base-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    const pinnedBase = interrupted.state.baseSha as string;
    writeFileSync(join(fixture.root, "advance.txt"), "new main content\n");
    git(fixture.root, ["add", "advance.txt"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "advance main"]);
    assert.notEqual(git(fixture.root, ["rev-parse", "main"]), pinnedBase);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.baseSha, pinnedBase);
    assert.equal(existsSync(join(output.workspacePath, "advance.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume adopts an atomically published evidence artifact before marking the run complete", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-crash-evidence-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "evidence_publish", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const evidencePath = join(fixture.dataRoot, "runs", runId, "evidence.json");
    assert.ok(existsSync(evidencePath));
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(interrupted.status, "running");
    assert.equal(interrupted.phase, "finalize");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.evidencePath, evidencePath);
    assert.equal(output.reviewAttempts, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume restarts from a durable verification node without replanning or duplicating a commit", () => {
  const fixture = createRunnableFixture();
  try {
    const request = JSON.parse(readFileSync(fixture.requestPath, "utf8")) as Record<string, any>;
    request.workItem.repositoryContextManifest = { paths: ["README.md"] };
    writeFileSync(fixture.requestPath, JSON.stringify(request));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-node-restart-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(interrupted.status, "running");
    assert.equal(interrupted.phase, "verify");
    assert.deepEqual(interrupted.state.request.workItem.repositoryContextManifest.paths, ["README.md"]);
    const committedHead = interrupted.state.headSha as string;

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.headSha, committedHead);
    assert.equal(output.iterations, 1);
    assert.equal(git(output.workspacePath, ["rev-list", "--count", `${output.baseSha}..${output.headSha}`]), "1");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume completes gates for the already-paid final iteration", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.budgets.maximumIterations = 1;
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "limit work run to one iteration"]);
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-final-iteration-resume-1";

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.iterations, 1);
    assert.equal(git(output.workspacePath, ["rev-list", "--count", `${output.baseSha}..${output.headSha}`]), "1");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume reuses the prepared independent-review attempt", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const initial = providerFixture.planner.responses[0];
    providerFixture.planner.responses = [initial, {
      ...initial,
      summary: "Repair after restarted review.",
      actions: [
        { kind: "write_file", path: "src/answer.js", content: "/** Recovered review repair. */\nexport function answerFeature() { return 42; }\n" },
        initial.actions[1],
      ],
      commitMessage: "Repair restarted review",
    }];
    providerFixture.reviewer.responses = [{
      verdict: "changes_requested", summary: "One repair is required.",
      findings: [{
        id: "restart-repair", severity: "blocking", category: "maintainability", location: "src/answer.js:1",
        evidence: "Comment missing.", requiredAction: "Add comment.", scopeRelation: "in_scope",
      }],
    }, { verdict: "approve", summary: "Repair completed.", findings: [] }];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-review-restart-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "independent_review", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(interrupted.phase, "independent_review");
    assert.equal(interrupted.state.reviewAttempt, 1);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.reviewAttempts, 2);
    assert.equal(output.status, "completed");
    assert.match(readFileSync(join(output.workspacePath, "src", "answer.js"), "utf8"), /Recovered review repair/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a repair iteration that only corrects the documentation disposition reaches the documentation gate", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const correct = providerFixture.planner.responses[0];
    providerFixture.planner.responses = [{
      ...correct,
      summary: "Implement answerFeature and misfile its documentation coverage.",
      documentation: {
        kind: "coverage_plan",
        entries: [{ impact: "reference", topic: "not-a-declared-topic", path: "README.md" }],
      },
    }, correct];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-documentation-repair-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.iterations, 2);
    const state = JSON.parse(runCli([
      "status", "--run-id", "fixture-documentation-repair-1", "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.ok(
      state.state.errors.some((error: string) => error === "documentation:missing documentation coverage for reference:overview"),
      `expected the first iteration to fail the documentation gate, got ${JSON.stringify(state.state.errors)}`,
    );
    const evidence = JSON.parse(readFileSync(output.evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.documentation.headSha, output.headSha);
    assert.deepEqual(evidence.documentation.disposition, correct.documentation);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a repair iteration that corrects a refused no-change attestation reaches the documentation gate", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const correct = providerFixture.planner.responses[0];
    providerFixture.planner.responses = [{
      ...correct,
      summary: "Implement answerFeature and attest that nothing needs documenting.",
      documentation: {
        kind: "no_change_attestation",
        changedSurfaces: ["src/answer.js"],
        topicsExamined: ["overview"],
        documentsExamined: ["README.md"],
        rationale: "The behavior is self-evident from the source.",
      },
    }, correct];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-attestation-repair-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.iterations, 2);
    const state = JSON.parse(runCli([
      "status", "--run-id", "fixture-attestation-repair-1", "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.ok(
      state.state.errors.some((error: string) => error === "documentation:No-Change Attestation is invalid when Markdown changed"),
      `expected the attestation to be refused, got ${JSON.stringify(state.state.errors)}`,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a genuinely different disposition that earns the same refusal escalates on the answer, not the plan", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const misfiled = (topic: string) => ({
      ...structuredClone(providerFixture.planner.responses[0]),
      documentation: { kind: "coverage_plan", entries: [{ impact: "reference", topic, path: "README.md" }] },
    });
    providerFixture.planner.responses = [misfiled("not-a-declared-topic"), misfiled("also-not-declared")];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-same-refusal-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /changed nothing and earned the same documentation result/);
    const status = JSON.parse(runCli([
      "status", "--run-id", "fixture-same-refusal-1", "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(status.state.iteration, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a repair iteration that repeats a refused plan and changes nothing escalates", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const stuck = structuredClone(providerFixture.planner.responses[0]);
    stuck.actions[0].content = "export function answerFeature() { return 41; }\n";
    providerFixture.planner.responses = [stuck, structuredClone(stuck)];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-stuck-plan-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /plan produced no repository change/);
    const status = JSON.parse(runCli([
      "status", "--run-id", "fixture-stuck-plan-1", "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("rewording a plan around a repeated documentation disposition escalates rather than buying another iteration", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const refused = {
      ...providerFixture.planner.responses[0],
      documentation: {
        kind: "coverage_plan",
        entries: [{ impact: "reference", topic: "not-a-declared-topic", path: "README.md" }],
      },
    };
    const reworded = {
      ...structuredClone(refused),
      summary: "Reconsider the same change and describe it differently.",
      commitMessage: "Reword the same change",
    };
    providerFixture.planner.responses = [refused, reworded];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-reworded-plan-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /changed nothing and earned the same documentation result/);
    const status = JSON.parse(runCli([
      "status", "--run-id", "fixture-reworded-plan-1", "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(status.state.iteration, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("restart at a repair act checkpoint does not adopt the prior iteration commit", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const initial = providerFixture.planner.responses[0];
    providerFixture.planner.responses = [initial, {
      ...initial,
      summary: "Apply the required review repair.",
      actions: [
        { kind: "write_file", path: "src/answer.js", content: "/** Reviewed behavior. */\nexport function answerFeature() { return 42; }\n" },
        initial.actions[1],
      ],
      commitMessage: "Apply review repair",
    }];
    providerFixture.reviewer.responses = [{
      verdict: "changes_requested",
      summary: "Add a public comment.",
      findings: [{
        id: "repair-required", severity: "blocking", category: "maintainability", location: "src/answer.js:1",
        evidence: "Missing comment.", requiredAction: "Add the comment.", scopeRelation: "in_scope",
      }],
    }, { verdict: "approve", summary: "Repair is present.", findings: [] }];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-repair-act-restart-1";

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "act:2", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    const firstHead = interrupted.state.headSha as string;
    assert.equal(interrupted.phase, "act");
    assert.equal(interrupted.state.iteration, 2);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.notEqual(output.headSha, firstHead);
    assert.match(readFileSync(join(output.workspacePath, "src", "answer.js"), "utf8"), /Reviewed behavior/);
    assert.equal(output.reviewAttempts, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume fails closed and preserves a durable-node workspace with unattributed changes", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-node-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    writeFileSync(join(interrupted.state.workspacePath, "rogue.txt"), "unattributed\n");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /workspace drifted/);
    assert.equal(readFileSync(join(interrupted.state.workspacePath, "rogue.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume fails closed when durable-node output is hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-node-hidden-drift-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
    appendFileSync(excludePath, "\nhidden-output.txt\n");
    writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /workspace drifted/);
    assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run bounds verifier and opposite-provider repair while invalidating stale head evidence", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    const initial = providerFixture.planner.responses[0];
    providerFixture.planner.responses = [
      {
        ...initial,
        summary: "First attempt with a verifier-visible defect.",
        actions: [
          { kind: "write_file", path: "src/answer.js", content: "export function answerFeature() { return 41; }\n" },
          initial.actions[1],
        ],
        commitMessage: "Attempt answer feature",
      },
      { ...initial, summary: "Repair deterministic verification.", commitMessage: "Repair answer value" },
      {
        ...initial,
        summary: "Address the exact-head review finding.",
        actions: [
          { kind: "write_file", path: "src/answer.js", content: "/** Stable fixture behavior. */\nexport function answerFeature() { return 42; }\n" },
          initial.actions[1],
        ],
        commitMessage: "Document answer implementation",
      },
    ];
    providerFixture.reviewer.responses = [
      {
        verdict: "changes_requested",
        summary: "The exported behavior needs an implementation comment.",
        findings: [{
          id: "review-1",
          severity: "blocking",
          category: "maintainability",
          location: "src/answer.js:1",
          evidence: "The public fixture export is uncommented.",
          requiredAction: "Add a concise implementation comment.",
          scopeRelation: "in_scope",
        }],
      },
      { verdict: "approve", summary: "The exact-head repair is complete.", findings: [] },
    ];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.iterations, 3);
    assert.equal(output.reviewAttempts, 2);
    assert.equal(output.reviewVerdict.headSha, output.headSha);
    assert.equal(output.verification.headSha, output.headSha);
    assert.equal(output.documentation.headSha, output.headSha);
    assert.equal(git(output.workspacePath, ["rev-list", "--count", `${output.baseSha}..${output.headSha}`]), "3");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("typed whole-argument rendering rejects shell, option, newline, NUL, traversal, and embedded-placeholder injection", () => {
  const opaqueCommand = {
    id: "typed-opaque",
    argv: ["node", "scripts/probe.mjs", "{value}"],
    authorizationSources: ["scripts/probe.mjs"],
    cwd: "worktree",
    timeoutSeconds: 10,
    credentialRefs: [],
    environmentPasslist: [],
    sideEffect: "none",
    idempotence: "pure",
    parameters: { value: { type: "opaque_id" } },
  } as ProjectContract["commands"][number];
  for (const attack of ["$(touch owned)", "--eval", "line\nbreak", "nul\0byte", "safe/../escape"]) {
    assert.throws(() => renderCommand(opaqueCommand, { value: attack }), /typed command substitution failed/);
  }

  const pathCommand = {
    ...opaqueCommand,
    id: "typed-path",
    parameters: { value: { type: "absolute_path", pathRoot: "/approved" } },
  } as ProjectContract["commands"][number];
  assert.throws(() => renderCommand(pathCommand, { value: "/approved/../escape" }), /typed command substitution failed/);

  const embedded = { ...opaqueCommand, argv: ["node", "scripts/probe.mjs", "--id={value}"] } as ProjectContract["commands"][number];
  assert.throws(
    () => renderCommand(embedded, { value: "safe" }),
    (error: unknown) => error instanceof Error && "details" in error && String((error as { details: string[] }).details).includes("whole argv element"),
  );
});

test("resume escalates an indeterminate workspace effect and preserves the observed path", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-indeterminate-workspace-1";
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    const workspacePath = status.pendingEffect.target as string;
    git(fixture.root, ["worktree", "remove", "--force", workspacePath]);
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, "unattributed.txt"), "preserve me\n");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /indeterminate/);
    assert.equal(readFileSync(join(workspacePath, "unattributed.txt"), "utf8"), "preserve me\n");
    const finalStatus = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(finalStatus.status, "escalated");
    assert.equal(finalStatus.pendingEffect, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run cannot rewrite an activated command source before invoking that allowlisted command", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.approvalPolicy.rules[0].pathGlobs.push("scripts/verify.mjs");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "authorize verifier maintenance"]);
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providerFixture.planner.responses[0].actions.unshift({
      kind: "write_file",
      path: "scripts/verify.mjs",
      content: "process.exit(0);\n",
    });
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-command-source-guard-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /command authorization source is protected/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.match(readFileSync(join(status.state.workspacePath, "scripts", "verify.mjs"), "utf8"), /containsExpectedBehavior/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("run cannot rewrite a declared helper imported by an unchanged activated command entry script", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.approvalPolicy.rules[0].pathGlobs.push("scripts/verify-helper.mjs");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "authorize verifier helper maintenance"]);
    const originalEntrySource = readFileSync(join(fixture.root, "scripts", "verify.mjs"), "utf8");
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providerFixture.planner.responses[0].actions.unshift({
      kind: "write_file",
      path: "scripts/verify-helper.mjs",
      content: "export function containsExpectedBehavior() { return true; }\n",
    });
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-command-helper-guard-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /command authorization source is protected/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(readFileSync(join(status.state.workspacePath, "scripts", "verify.mjs"), "utf8"), originalEntrySource);
    assert.match(readFileSync(join(status.state.workspacePath, "scripts", "verify-helper.mjs"), "utf8"), /source\.includes/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("committing a command authorization source makes the human activation stale", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    writeFileSync(join(fixture.root, "scripts", "verify-helper.mjs"), [
      "export function containsExpectedBehavior(source, readme) {",
      '  return source.includes("return 42") && readme.includes("answerFeature") && true;',
      "}",
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify-helper.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "change authorized helper"]);

    const status = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal((JSON.parse(status.stdout) as { activation: string }).activation, "stale");

    const run = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(run.status, 4, run.stderr || run.stdout);
    assert.match((JSON.parse(run.stdout) as { error: string }).error, /activation is missing or stale/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("act attributes and commits planned output hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    appendFileSync(join(fixture.root, ".git", "info", "exclude"), "\nsrc/answer.js\n");
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-act-hidden-output-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    const workspacePath = output.workspacePath as string;
    assert.equal(readFileSync(join(workspacePath, "src", "answer.js"), "utf8"), "export function answerFeature() { return 42; }\n");
    assert.equal(git(workspacePath, ["show", `${output.headSha}:src/answer.js`]), "export function answerFeature() { return 42; }");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("act attributes planned output hidden by a planned uncommitted gitignore", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.approvalPolicy.rules[0].pathGlobs.push("sandbox/**");
    contract.models.repositoryContext.includeGlobs.push("sandbox/**");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "authorize planned ignored output",
    ]);
    const providers = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providers.planner.responses[0].actions.unshift(
      { kind: "write_file", path: "sandbox/.gitignore", content: "answer.js\n" },
      { kind: "write_file", path: "sandbox/answer.js", content: "export const sandboxAnswer = 42;\n" },
    );
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providers)));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-act-planned-gitignore-output", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(git(output.workspacePath, ["show", `${output.headSha}:sandbox/.gitignore`]), "answer.js");
    assert.equal(
      git(output.workspacePath, ["show", `${output.headSha}:sandbox/answer.js`]),
      "export const sandboxAnswer = 42;",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("act force-stages a literal planned path hidden by shared info/exclude", () => {
  const fixture = createRunnableFixture();
  try {
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { readFileSync } from "node:fs";',
      'const source = readFileSync(new URL("../:literal.js", import.meta.url), "utf8");',
      'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
      'if (!source.includes("return 42") || !readme.includes("answerFeature")) process.exit(1);',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "verify a literal act path",
    ]);
    const providers = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providers.planner.responses[0].actions[0].path = ":literal.js";
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.approvalPolicy.rules[0].pathGlobs.push(":literal.js");
    contract.models.repositoryContext.includeGlobs.push(":literal.js");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "authorize a literal act path",
    ]);
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providers)));
    appendFileSync(join(fixture.root, ".git", "info", "exclude"), "\n:literal.js\n");
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "fixture-act-literal-hidden-output-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(
      git(output.workspacePath, ["show", `${output.headSha}::literal.js`]),
      "export function answerFeature() { return 42; }",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("act refuses unplanned output newly hidden by a planned uncommitted .gitignore", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-act-unplanned-hidden-output-1";
  try {
    writeFileSync(join(fixture.root, ".gitignore"), "sandbox/unplanned.txt\n");
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.approvalPolicy.rules[0].pathGlobs.push("sandbox/**");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".gitignore", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "allow a nested ignore plan fixture",
    ]);
    const providers = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providers.planner.responses[0].actions.unshift({
      kind: "write_file", path: "sandbox/.gitignore", content: "unplanned.txt\n",
    });
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providers)));
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "act", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(
      runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
    ) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    mkdirSync(join(workspacePath, "sandbox"), { recursive: true });
    writeFileSync(join(workspacePath, "sandbox", "unplanned.txt"), "external\n");
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");

    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--adapter-fixture", fixture.adapterFixturePath, "--run-id", runId, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as { error: string; details: string[] };
    assert.match(output.error, /act left unattributable worktree output/);
    assert.match(output.details.join("\n"), /sandbox\/unplanned\.txt: sandbox\/\.gitignore/);
    assert.equal(readFileSync(join(workspacePath, "sandbox", "unplanned.txt"), "utf8"), "external\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a declared pure verification command cannot mutate the evidence workspace", () => {
  const fixture = createRunnableFixture();
  try {
    const verifierPath = join(fixture.root, "scripts", "verify.mjs");
    writeFileSync(verifierPath, [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("../gate-mutation.txt", import.meta.url), "mutated\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare mutating gate fixture"]);
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-mutating-gate-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);
    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /declared pure command mutated/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(readFileSync(join(status.state.workspacePath, "gate-mutation.txt"), "utf8"), "mutated\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a declared pure gate keeps Git status pinned when existing config redirects the work tree", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-gate-worktree-pin-1";
  try {
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("secret.txt", "undeclared secret\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "declare a mutating verification gate",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-at-node", "verify", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    const workspacePath = interrupted.state.workspacePath as string;
    const gitDirectory = interrupted.state.workspaceGitDirectory as string;
    const decoy = join(fixture.dataRoot, "gate-decoy");
    mkdirSync(decoy, { recursive: true });
    for (const entry of readdirSync(workspacePath)) {
      if (entry === ".git" || entry === "node_modules") continue;
      cpSync(join(workspacePath, entry), join(decoy, entry), { recursive: true });
    }
    const commonDirectory = resolve(gitDirectory, readFileSync(join(gitDirectory, "commondir"), "utf8").trim());
    appendFileSync(join(commonDirectory, "config"), "\n[extensions]\n\tworktreeConfig = true\n");
    writeFileSync(join(gitDirectory, "config.worktree"), `[core]\n\tworktree = ${decoy}\n`);

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /declared pure command mutated the evidence repository/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(readFileSync(join(workspacePath, "secret.txt"), "utf8"), "undeclared secret\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a gate cannot change the shared Git config when the contract declares no preparation commands", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-gate-local-config-drift-1";
  try {
    const excludesFile = join(fixture.dataRoot, "gate-excludes");
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      `writeFileSync(${JSON.stringify(excludesFile)}, "secret.txt\\n");`,
      `appendFileSync(join(commonDir, "config"), "\\n[core]\\n\\texcludesFile = ${excludesFile}\\n");`,
      'writeFileSync("secret.txt", "undeclared secret\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "hide gate output through shared Git config",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /declared pure command changed the repository-local Git configuration/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.ok(existsSync(join(status.state.workspacePath, "secret.txt")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a gate cannot hide output behind shared info/exclude", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-gate-info-exclude-1";
  try {
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'appendFileSync(join(commonDir, "info", "exclude"), "gate-artifact.txt\\n");',
      'writeFileSync("gate-artifact.txt", "undeclared gate output\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "hide gate output through info exclude",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /declared pure command mutated the evidence repository/);
    assert.match(result.stdout, /shared info\/exclude changed by declared pure command/);
    const status = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(
      readFileSync(join(status.state.workspacePath, "gate-artifact.txt"), "utf8"),
      "undeclared gate output\n",
    );
    assert.match(readFileSync(join(fixture.root, ".git", "info", "exclude"), "utf8"), /gate-artifact\.txt/);
    assert.equal(existsSync(join(fixture.root, ".graph-shipper", "state.sqlite")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a gate cannot hide output behind an uncommitted .gitignore", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-gate-uncommitted-gitignore-1";
  try {
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("gate-hidden", { recursive: true });',
      'writeFileSync("gate-hidden/.gitignore", "*\\n");',
      'writeFileSync("gate-hidden/artifact.bin", "undeclared gate output\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "hide gate output behind an uncommitted gitignore",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /declared pure command mutated the evidence repository/);
    const status = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(
      readFileSync(join(status.state.workspacePath, "gate-hidden", "artifact.bin"), "utf8"),
      "undeclared gate output\n",
    );
    assert.equal(existsSync(join(fixture.root, ".graph-shipper", "state.sqlite")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a gate cannot rewrite an existing ignored preparation artifact", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-gate-ignored-content-rewrite-1";
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("node_modules/fixture-dep/index.js", "export const ready = false;\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "rewrite an ignored preparation artifact from a pure gate",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /declared pure command mutated the evidence repository/);
    const status = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(status.status, "escalated");
    assert.equal(
      readFileSync(join(status.state.workspacePath, "node_modules", "fixture-dep", "index.js"), "utf8"),
      "export const ready = false;\n",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a planned run_command action hands its named parameters to the declared placeholder", () => {
  const fixture = createRunnableFixture();
  try {
    const observerPath = join(fixture.root, "scripts", "observe.mjs");
    writeFileSync(observerPath, 'console.log("observed:" + process.argv[2]);\n');
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      id: "fixture-observe", argv: ["node", "scripts/observe.mjs", "{observed_topic}"], cwd: "worktree",
      authorizationSources: ["scripts/observe.mjs"],
      timeoutSeconds: 30, credentialRefs: [], sideEffect: "none", idempotence: "pure",
      parameters: { observed_topic: { type: "opaque_id" } },
    });
    contract.approvalPolicy.rules.push({
      id: "observe-topic", effect: "read_only", actionKinds: ["run_command:fixture-observe"],
      citation: "fixture observation policy",
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/observe.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare parameterized observation"]);
    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    recorded.planner.responses[0].actions.unshift({
      kind: "run_command", commandId: "fixture-observe",
      parameters: [{ name: "observed_topic", value: "overview" }],
    });
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-parameterized-observation-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(status.status, "completed");
    const evidence = JSON.parse(readFileSync(join(fixture.dataRoot, "runs", runId, "evidence.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(evidence.commandResults.map((result: { stdout: string }) => result.stdout.trim()), ["observed:overview"]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an invalid planned command is refused before an earlier file action takes effect", () => {
  const fixture = createRunnableFixture();
  const runId = "invalid-planned-command-preflight-1";
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.approvalPolicy.rules.push({
      id: "observe-verification", effect: "read_only", actionKinds: ["run_command:fixture-verify"],
      citation: "fixture observation policy",
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "authorize verification observation",
    ]);
    const recorded = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    recorded.planner.responses[0].actions = [
      { kind: "write_file", path: "src/partial.js", content: "export const partial = true;\n" },
      {
        kind: "run_command", commandId: "fixture-verify",
        parameters: [{ name: "unexpected", value: "value" }],
      },
    ];
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(recorded));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /typed command substitution failed/);
    const status = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(existsSync(join(status.state.workspacePath, "src", "partial.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("command capability admission rejects process-launch mutation before workspace creation", () => {
  const fixture = createRunnableFixture();
  try {
    const mutatorPath = join(fixture.root, "scripts", "commit-mutator.mjs");
    writeFileSync(mutatorPath, [
      'import { execFileSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("hidden.txt", "hidden mutation\\n");',
      'execFileSync("git", ["add", "hidden.txt"]);',
      'execFileSync("git", ["-c", "user.name=Hostile", "-c", "user.email=hostile@example.invalid", "commit", "-m", "hidden mutation"]);',
    ].join("\n"));
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      id: "commit-mutator", argv: ["node", "scripts/commit-mutator.mjs"], cwd: "worktree",
      authorizationSources: ["scripts/commit-mutator.mjs"],
      timeoutSeconds: 30, credentialRefs: [], sideEffect: "none", idempotence: "pure", parameters: {},
    });
    contract.approvalPolicy.rules.push({
      id: "observe-mutator", effect: "read_only", actionKinds: ["run_command:commit-mutator"],
      citation: "fixture observation policy",
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "scripts/commit-mutator.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add pure command adversary"]);
    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { details: string[] }).details.join("\n"), /node:child_process has no admitted local-only command capability/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("SIGTERM drains at a durable node boundary and resume completes the same Work Run", async () => {
  const fixture = createRunnableFixture();
  try {
    const verifierPath = join(fixture.root, "scripts", "verify.mjs");
    writeFileSync(verifierPath, [
      'import { readFileSync } from "node:fs";',
      'await new Promise((resolve) => setTimeout(resolve, 1200));',
      'const source = readFileSync(new URL("../src/answer.js", import.meta.url), "utf8");',
      'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
      'if (!source.includes("return 42") || !readme.includes("answerFeature")) process.exit(1);',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "slow verifier for drain fixture"]);
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-graceful-drain-1";
    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "run",
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ], { cwd: repositoryRoot, env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const observed = runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]);
      if (observed.status === 0 && (JSON.parse(observed.stdout) as { phase: string }).phase === "verify") break;
    }
    child.kill("SIGTERM");
    const exit = await exited;
    assert.equal(exit.code, 0, stderr || stdout);
    const paused = JSON.parse(stdout) as Record<string, any>;
    assert.equal(paused.status, "paused");
    assert.equal(paused.phase, "verify");

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const completed = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(completed.status, "completed");
    assert.equal(completed.runId, runId);
    assert.equal(completed.iterations, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("status for an unknown Work Run is read-only and does not create runtime state", () => {
  const fixture = createTrackedProject();
  try {
    rmSync(fixture.dataRoot, { recursive: true, force: true });

    const result = runCli(["status", "--run-id", "missing-run", "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.equal(existsSync(fixture.dataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("credentialed providers require an explicit flag and available opaque references before workspace creation", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);
    const unapproved = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--json",
    ]);
    assert.equal(unapproved.status, 3);
    assert.match((JSON.parse(unapproved.stdout) as { error: string }).error, /choose exactly one/);

    const unavailable = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--allow-credentialed-model-calls", "--json",
    ]);
    assert.equal(unavailable.status, 3);
    assert.match((JSON.parse(unavailable.stdout) as { error: string }).error, /credential reference anthropic-default is unavailable/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("subscription CLI assignments complete the same local-only Work Run without API-key credentials", () => {
  const fixture = createRunnableFixture();
  const fakeBin = mkdtempSync(join(tmpdir(), "graph-shipper-subscription-bin-"));
  const previousPath = process.env.PATH;
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.models.buildAssignments[0].transport = "subscription_cli";
    contract.models.reviewAssignments[0].transport = "subscription_cli";
    delete contract.models.buildAssignments[0].credentialRef;
    delete contract.models.reviewAssignments[0].credentialRef;
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "select subscription transports"]);

    const plan = {
      kind: "plan", fileActionSemantics: "base_bound_v1", summary: "Implement and document answerFeature.",
      actions: [
        { kind: "write_file", path: "src/answer.js", content: "export function answerFeature() { return 42; }\n" },
        {
          kind: "edit_file", path: "README.md",
          baseContentSha256: createHash("sha256").update("# Fixture Project\n").digest("hex"),
          replacements: [{ oldText: "# Fixture Project\n", newText: "# Fixture Project\n\n`answerFeature()` returns 42.\n" }],
        },
      ],
      documentation: { kind: "coverage_plan", entries: [{ impact: "reference", topic: "overview", path: "README.md" }] },
      commitMessage: "Add answer feature",
    };
    const reviewer = { verdict: "approve", summary: "Behavior and documentation match the request.", findings: [] };
    const claudePath = join(fakeBin, "claude");
    writeFileSync(claudePath, [
      "#!/usr/bin/env node",
      "if (process.argv.includes('auth')) { process.stdout.write('authenticated'); process.exit(0); }",
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', structured_output: ${JSON.stringify(plan)} }));`,
    ].join("\n"));
    chmodSync(claudePath, 0o755);
    const codexPath = join(fakeBin, "codex");
    writeFileSync(codexPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "if (process.argv.includes('login')) { process.stdout.write('authenticated'); process.exit(0); }",
      "const outputFlag = process.argv.indexOf('--output-last-message');",
      "if (outputFlag < 0) process.exit(2);",
      `writeFileSync(process.argv[outputFlag + 1], JSON.stringify(${JSON.stringify(reviewer)}));`,
    ].join("\n"));
    chmodSync(codexPath, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--allow-credentialed-model-calls", "--run-id", "subscription-run", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.modelRuntimeIdentity.build.transport, "subscription_cli");
    assert.equal(output.modelRuntimeIdentity.review.transport, "subscription_cli");
    const evidence = JSON.parse(readFileSync(output.evidencePath, "utf8")) as Record<string, any>;
    assert.equal(evidence.adapterBinding.mode, "subscription");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("model-authored file actions cannot escape the activated approval-policy path allowlist", () => {
  const fixture = createRunnableFixture();
  try {
    const providerFixture = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providerFixture.planner.responses[0].actions.unshift({ kind: "write_file", path: "UNAUTHORIZED.txt", content: "not allowed\n" });
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(baseBindRecordedPlannerResponses(providerFixture)));
    activate(fixture.root, fixture.dataRoot);
    const runId = "fixture-policy-denial-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /activated approval policy denied/);
    const status = JSON.parse(runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout) as Record<string, any>;
    assert.equal(existsSync(join(status.state.workspacePath, "UNAUTHORIZED.txt")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("open_pr fails closed with neither a recorded GitHub fixture nor the live opt-in", () => {
  const fixture = createRunnableFixture();
  try {
    enableOpenPr(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "open-pr-no-transport-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /--github-fixture or explicit live GitHub authorization/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", "open-pr-no-transport-1")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a recorded GitHub fixture and the live opt-in cannot be composed together", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableOpenPr(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-live-github-mutations",
      "--run-id", "open-pr-both-transports-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /choose exactly one of --github-fixture or --allow-live-github-mutations/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("local_only refuses live GitHub authorization outright", () => {
  const fixture = createRunnableFixture();
  try {
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--allow-live-github-mutations", "--run-id", "local-only-live-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /local_only does not accept/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", "local-only-live-1")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("the live GitHub composition probes the operator credential before any Work Run effect", () => {
  const fixture = createRunnableFixture();
  try {
    enableOpenPr(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--allow-live-github-mutations", "--run-id", "open-pr-live-probe-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /credential reference github-operator is unavailable/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", "open-pr-live-probe-1")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("live merge_when_green demands its own authorization, not the fixture's reconciliation flag", () => {
  const fixture = createRunnableFixture();
  try {
    enableMergeWhenGreen(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--allow-live-github-mutations", "--run-id", "live-merge-boundary-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /live merge authorization/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", "live-merge-boundary-1")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("fixture merge_when_green still demands disposable target-reconciliation authorization", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--run-id", "fixture-merge-boundary-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /disposable target-reconciliation authorization/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("merge synchronization obtains a merge commit the primary clone has never seen", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    git(fixture.dataRoot, ["clone", "--quiet", fixture.root, "forge-clone"]);
    const forgeClone = join(fixture.dataRoot, "forge-clone");
    writeFileSync(join(forgeClone, "MERGED.md"), "# merged upstream\n");
    git(forgeClone, ["add", "MERGED.md"]);
    git(forgeClone, ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", "commit", "-m", "forge-side merge commit"]);
    const mergedSha = git(forgeClone, ["rev-parse", "HEAD"]);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    githubFixture.mergedSha = mergedSha;
    githubFixture.mergedCommitSource = "forge-clone";
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation",
      "--run-id", "merge-fetch-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.delivery.merge.mergedSha, mergedSha);
    assert.equal(git(fixture.root, ["rev-parse", "main"]), mergedSha);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("live operational hooks are not authorized by the disposable-fixture flag", () => {
  const fixture = createRunnableFixture();
  try {
    enableOperationalHooks(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--allow-live-github-mutations", "--allow-live-merge", "--allow-disposable-fixture-operations",
      "--run-id", "live-hooks-boundary-1", "--json",
    ], operationalCredentialEnvironment);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /live operational-hook authorization/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("live merge authorization is refused as inert without the live transport", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation", "--allow-live-merge",
      "--run-id", "inert-live-merge-1", "--json",
    ]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /require --allow-live-github-mutations/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an earned npm gate runs to a green deterministic verdict through the runtime", () => {
  const fixture = createRunnableFixture();
  try {
    writeFileSync(join(fixture.root, "package.json"), JSON.stringify({
      name: "fixture-target",
      version: "1.0.0",
      private: true,
      scripts: { test: "node scripts/verify.mjs" },
    }, null, 2));
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.executableAllowlist = [{
      id: "npm-test",
      argvPrefix: ["npm", "test"],
      citation: "fixture earned deterministic gate",
    }];
    contract.commands = [{
      id: "fixture-verify",
      argv: ["npm", "test"],
      authorizationSources: ["scripts/verify.mjs", "scripts/verify-helper.mjs", "package.json"],
      cwd: "worktree",
      timeoutSeconds: 120,
      credentialRefs: [],
      environmentPasslist: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    }];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "package.json"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "earn an npm gate"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "npm-gate-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    const gate = output.verification.checks.find((check: Record<string, unknown>) => check.id === "fixture-test");
    assert.equal(gate.exitCode, 0, JSON.stringify(gate));
    assert.equal(gate.commandId, "fixture-verify");
    assert.match(gate.stdout, /fixture-target@1\.0\.0 test/);
    assert.equal(existsSync(join(fixture.dataRoot, "tool-home", "fixture-project")), true);
    assert.equal(gate.stdout.includes(String(process.env.HOME)), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("base refresh obtains an advanced remote base the primary clone has never seen", () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.delivery.commitIdentity = { name: "Fixture Shipper", email: "fixture-shipper@example.invalid" };
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "configure rebase commit identity",
    ]);
    const forge = mkdtempSync(join(tmpdir(), "graph-shipper-base-"));
    git(forge, ["clone", "--quiet", fixture.root, "clone"]);
    const forgeClone = join(forge, "clone");
    writeFileSync(join(forgeClone, "UPSTREAM.txt"), "# advanced upstream\n");
    git(forgeClone, ["add", "UPSTREAM.txt"]);
    git(forgeClone, ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", "commit", "-m", "advance the base branch"]);
    const advancedBase = git(forgeClone, ["rev-parse", "HEAD"]);
    const reviewedBase = git(fixture.root, ["rev-parse", "main"]);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    githubFixture.baseBranchHead = advancedBase;
    githubFixture.mergedCommitSource = forgeClone;
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    const providers = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
    providers.reviewer.responses.push(structuredClone(providers.reviewer.responses[0]));
    writeFileSync(fixture.adapterFixturePath, JSON.stringify(providers));
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation",
      "--run-id", "base-refresh-1", "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.notEqual(output.delivery.merge.baseSha, reviewedBase);
    assert.equal(output.delivery.merge.baseSha, advancedBase);
    assert.equal(
      git(fixture.root, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>", output.headSha]),
      "Fixture Shipper <fixture-shipper@example.invalid>\nFixture Shipper <fixture-shipper@example.invalid>",
    );
    rmSync(forge, { recursive: true, force: true });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an advanced base that cannot be obtained, or that does not fast-forward, still fails closed", () => {
  const expectedReason = {
    unobtainable: "the remote base could not be obtained",
    diverged: "the remote base does not fast-forward the local base",
  };
  for (const scenario of ["unobtainable", "diverged"] as const) {
    const fixture = createRunnableFixture();
    try {
      const githubFixturePath = enableMergeWhenGreen(fixture);
      const forge = mkdtempSync(join(tmpdir(), "graph-shipper-base-"));
      git(forge, ["clone", "--quiet", fixture.root, "clone"]);
      const forgeClone = join(forge, "clone");
      writeFileSync(join(forgeClone, "UPSTREAM.txt"), "advanced upstream\n");
      git(forgeClone, ["add", "UPSTREAM.txt"]);
      git(forgeClone, ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", "commit", "-m", "advance the base branch"]);
      const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
      githubFixture.baseBranchHead = git(forgeClone, ["rev-parse", "HEAD"]);
      if (scenario !== "unobtainable") githubFixture.mergedCommitSource = forgeClone;
      if (scenario === "diverged") {
        writeFileSync(join(fixture.root, "LOCAL.txt"), "local-only work\n");
        git(fixture.root, ["add", "LOCAL.txt"]);
        git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "local divergence"]);
      }
      writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
      activate(fixture.root, fixture.dataRoot);

      const result = runCli([
        "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
        "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation",
        "--run-id", `base-refresh-${scenario}`, "--json",
      ]);

      assert.equal(result.status, 4, `${scenario}: ${result.stderr || result.stdout}`);
      const output = JSON.parse(result.stdout) as { error: string; details: string[] };
      assert.equal(output.error, "base branch advanced but the exact remote base is not available locally");
      assert.ok(output.details.includes(expectedReason[scenario]), `${scenario}: ${output.details.join("; ")}`);
      rmSync(forge, { recursive: true, force: true });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  }
});

test("base advancement refuses a default branch a tag has shadowed since the run began", async () => {
  const fixture = createRunnableFixture();
  try {
    const githubFixturePath = enableMergeWhenGreen(fixture);
    const forge = mkdtempSync(join(tmpdir(), "graph-shipper-base-"));
    git(forge, ["clone", "--quiet", fixture.root, "clone"]);
    const forgeClone = join(forge, "clone");
    writeFileSync(join(forgeClone, "UPSTREAM.txt"), "advanced upstream\n");
    git(forgeClone, ["add", "UPSTREAM.txt"]);
    git(forgeClone, ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", "commit", "-m", "advance the base branch"]);
    writeFileSync(join(fixture.root, "LOCAL.txt"), "local-only work\n");
    git(fixture.root, ["add", "LOCAL.txt"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "local-only work"]);
    const endangered = git(fixture.root, ["rev-parse", "HEAD"]);
    const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
    const green = githubFixture.observations[0];
    githubFixture.baseBranchHead = git(forgeClone, ["rev-parse", "HEAD"]);
    githubFixture.mergedCommitSource = forgeClone;
    githubFixture.observationDelayMilliseconds = 1500;
    githubFixture.observations = [{
      checks: [{ name: "verify", status: "in_progress", conclusion: null, headSha: "$HEAD", producer: "github-actions" }],
      reviews: [], comments: [],
    }, green];
    writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
    activate(fixture.root, fixture.dataRoot);

    const runId = "base-refresh-shadowed";
    const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "run",
      "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--github-fixture", githubFixturePath, "--allow-disposable-fixture-reconciliation", "--run-id", runId, "--json",
    ], { cwd: repositoryRoot, env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const exited = new Promise<number | null>((resolveExit) => { child.once("close", resolveExit); });
    let waiting = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      const statePath = join(fixture.dataRoot, "github-fixtures", `${runId}.json`);
      if (!existsSync(statePath)) continue;
      const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
      waiting = state.events.some((event: Record<string, unknown>) => event.kind === "wait_for_observation");
      if (waiting) break;
    }
    assert.equal(waiting, true, stderr || stdout);
    git(fixture.root, ["tag", "main", "HEAD~2"]);
    const exit = await exited;

    assert.equal(git(fixture.root, ["rev-parse", "refs/heads/main"]), endangered, stderr || stdout);
    assert.equal(exit, 4, stderr || stdout);
    const output = JSON.parse(stdout) as { error: string; details: string[] };
    assert.equal(output.error, "base branch advanced but the exact remote base is not available locally");
    assert.ok(output.details.includes("primary clone head does not match the resolved local base"), output.details.join("; "));
    rmSync(forge, { recursive: true, force: true });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a completed run reclaims its own temporary root whatever its autonomy; an unfinished one keeps it", () => {
  for (const autonomy of ["local_only", "open_pr"] as const) {
    const fixture = createRunnableFixture();
    try {
      const githubFixturePath = autonomy === "open_pr" ? enableOpenPr(fixture) : null;
      activate(fixture.root, fixture.dataRoot);
      const runId = `temp-reclaim-${autonomy}`;
      const common = [
        "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
        "--run-id", runId, "--json",
        ...(githubFixturePath ? ["--github-fixture", githubFixturePath] : []),
      ];
      const temporaryRoot = join(fixture.dataRoot, "tmp", runId);
      const toolHome = join(fixture.dataRoot, "tool-home", "fixture-project");

      const crashed = runCli([...common, "--crash-at-node", "independent_review"]);
      assert.notEqual(crashed.status, 0, crashed.stdout);
      assert.equal(existsSync(temporaryRoot), true, `${autonomy}: a run that has not finished keeps its temporary root`);

      const resumed = runCli([
        "resume", "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--adapter-fixture", fixture.adapterFixturePath, "--run-id", runId, "--json",
        ...(githubFixturePath ? ["--github-fixture", githubFixturePath] : []),
      ]);
      assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
      assert.equal((JSON.parse(resumed.stdout) as { status: string }).status, "completed");
      assert.equal(existsSync(temporaryRoot), false, `${autonomy}: a completed run leaves no temporary root`);
      const evidencePath = (JSON.parse(resumed.stdout) as { evidencePath: string }).evidencePath;
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { cleanup?: { temporaryArtifactsRemoved: string[] } };
      assert.deepEqual(
        evidence.cleanup?.temporaryArtifactsRemoved, [temporaryRoot],
        `${autonomy}: the reclaim is recorded in the run's own evidence`,
      );
      assert.equal(existsSync(toolHome), true, `${autonomy}: the project home survives`);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  }
});

for (const scenario of ["rebased", "untouched", "unattributable", "visible-output", "hidden-output", "mixed-output"] as const) {
  test(`a crash inside base refresh reconciles ${scenario}`, () => {
    const fixture = createRunnableFixture();
    try {
      const githubFixturePath = enableMergeWhenGreen(fixture);
      git(fixture.dataRoot, ["clone", "--quiet", fixture.root, "forge-clone"]);
      const forgeClone = join(fixture.dataRoot, "forge-clone");
      writeFileSync(join(forgeClone, "UPSTREAM.txt"), "advanced upstream\n");
      git(forgeClone, ["add", "UPSTREAM.txt"]);
      git(forgeClone, ["-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", "commit", "-m", "advance the base branch"]);
      const advancedBase = git(forgeClone, ["rev-parse", "HEAD"]);
      const githubFixture = JSON.parse(readFileSync(githubFixturePath, "utf8")) as Record<string, any>;
      githubFixture.baseBranchHead = advancedBase;
      githubFixture.mergedCommitSource = "forge-clone";
      writeFileSync(githubFixturePath, JSON.stringify(githubFixture));
      const providers = JSON.parse(readFileSync(fixture.adapterFixturePath, "utf8")) as Record<string, any>;
      providers.reviewer.responses.push(structuredClone(providers.reviewer.responses[0]));
      providers.reviewer.responses.push(structuredClone(providers.reviewer.responses[0]));
      writeFileSync(fixture.adapterFixturePath, JSON.stringify(providers));
      activate(fixture.root, fixture.dataRoot);

      const runId = `base-refresh-crash-${scenario}`;
      const common = [
        "--project", fixture.root, "--data-root", fixture.dataRoot,
        "--adapter-fixture", fixture.adapterFixturePath, "--github-fixture", githubFixturePath,
        "--allow-disposable-fixture-reconciliation", "--run-id", runId, "--json",
      ];
      const crashed = runCli(["run", "--request", fixture.requestPath, ...common, "--crash-after-effect", "refresh_base"]);
      assert.equal(crashed.status, 3, crashed.stderr || crashed.stdout);
      const workspacePath = join(fixture.dataRoot, "workspaces", runId);
      const previousHeadSha = (JSON.parse(
        runCli(["status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json"]).stdout,
      ) as { delivery: { headSha: string } }).delivery.headSha;
      if (scenario === "untouched") git(workspacePath, ["reset", "--hard", previousHeadSha]);
      if (scenario === "unattributable") {
        writeFileSync(join(workspacePath, "OPERATOR.txt"), "not this run's work\n");
        git(workspacePath, ["add", "OPERATOR.txt"]);
        git(workspacePath, ["-c", "user.name=Operator", "-c", "user.email=operator@example.invalid", "commit", "-m", "operator commit"]);
      }
      if (scenario === "visible-output") writeFileSync(join(workspacePath, "visible-output.txt"), "unattributed\n");
      if (scenario === "hidden-output") {
        const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
        appendFileSync(excludePath, "\nhidden-output.txt\n");
        writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
        assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");
      }
      if (scenario === "mixed-output") {
        const excludePath = resolve(workspacePath, git(workspacePath, ["rev-parse", "--git-path", "info/exclude"]));
        appendFileSync(excludePath, "\nhidden-output.txt\n");
        writeFileSync(join(workspacePath, "hidden-output.txt"), "unattributed\n");
        writeFileSync(join(workspacePath, "visible-output.txt"), "unattributed\n");
      }

      const resumed = runCli(["resume", ...common]);

      const reconciliations = readFileSync(join(fixture.dataRoot, "traces", `${runId}.jsonl`), "utf8")
        .split("\n").filter(Boolean)
        .map((line) => (JSON.parse(line) as { payload?: { reconciliation?: string } }).payload?.reconciliation)
        .filter(Boolean);
      if (scenario === "unattributable") {
        assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
        assert.equal(
          (JSON.parse(resumed.stdout) as { error: string }).error,
          "base refresh left the owned worktree on an unattributable head",
        );
        return;
      }
      if (scenario === "hidden-output") {
        assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
        assert.match((JSON.parse(resumed.stdout) as { error: string }).error, /base refresh left undeclared worktree output/);
        assert.equal(readFileSync(join(workspacePath, "hidden-output.txt"), "utf8"), "unattributed\n");
        return;
      }
      if (scenario === "visible-output") {
        assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
        const output = JSON.parse(resumed.stdout) as { error: string; details: string[] };
        assert.match(output.error, /base refresh left undeclared worktree output/);
        assert.match(output.details.join("\n"), /visible-output\.txt: untracked and not ignored by any rule/);
        assert.equal(readFileSync(join(workspacePath, "visible-output.txt"), "utf8"), "unattributed\n");
        return;
      }
      if (scenario === "mixed-output") {
        assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
        const output = JSON.parse(resumed.stdout) as { error: string; details: string[] };
        assert.match(output.error, /base refresh left undeclared worktree output/);
        assert.match(output.details.join("\n"), /visible-output\.txt: untracked and not ignored by any rule/);
        assert.match(output.details.join("\n"), /hidden-output\.txt: .*info\/exclude/);
        return;
      }
      assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
      assert.ok(
        reconciliations.includes(scenario === "rebased" ? "adopted_base_refresh_after_crash" : "base_refresh_not_observed"),
        `${scenario}: ${reconciliations.join(", ")}`,
      );
      const output = JSON.parse(resumed.stdout) as Record<string, any>;
      assert.equal(output.status, "completed");
      assert.equal(output.baseSha, advancedBase);
      assert.equal(output.delivery.merge.baseSha, advancedBase);
      assert.equal(output.delivery.terminal.satisfied, true);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(fixture.dataRoot, { recursive: true, force: true });
    }
  });
}

test("an operator environment that would hand a declared command userinfo fails the run before it starts", () => {
  const fixture = createRunnableFixture();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      ...contract.commands[0], id: "fixture-unreached", environmentPasslist: ["HTTPS_PROXY"],
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare a proxy passlist"]);
    activate(fixture.root, fixture.dataRoot);
    const runId = "preflight-passlist-1";

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ], { HTTPS_PROXY: "https://operator:ghp_secret@proxy.internal:8443" });

    assert.equal(result.status, 3, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as { error: string; details: string[] };
    assert.match(output.error, /operator environment/);
    assert.match(output.details.join("\n"), /^fixture-unreached: HTTPS_PROXY /m);
    assert.doesNotMatch([output.error, ...output.details].join("\n"), /ghp_secret/);
    assert.equal(existsSync(join(fixture.dataRoot, "workspaces", runId)), false);
    assert.equal(existsSync(join(fixture.dataRoot, "runs", runId)), false);

    const admitted = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", "preflight-passlist-2", "--json",
    ], { HTTPS_PROXY: "https://proxy.internal:8443" });
    assert.equal(admitted.status, 0, admitted.stderr || admitted.stdout);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

function declareRealNpmPreparedDependency(fixture: ReturnType<typeof createRunnableFixture>): void {
  mkdirSync(join(fixture.root, "vendor", "fixture-dep"), { recursive: true });
  writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(fixture.root, "vendor", "fixture-dep", "package.json"), JSON.stringify({
    name: "fixture-dep",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  }, null, 2));
  writeFileSync(join(fixture.root, "vendor", "fixture-dep", "index.js"), "export const ready = true;\n");
  writeFileSync(join(fixture.root, "package.json"), JSON.stringify({
    name: "fixture-target",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { test: "node --import fixture-dep scripts/verify.mjs" },
    dependencies: { "fixture-dep": "file:vendor/fixture-dep" },
  }, null, 2));
  writeFileSync(join(fixture.root, "package-lock.json"), JSON.stringify({
    name: "fixture-target",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "fixture-target",
        version: "1.0.0",
        dependencies: { "fixture-dep": "file:vendor/fixture-dep" },
      },
      "node_modules/fixture-dep": { resolved: "vendor/fixture-dep", link: true },
      "vendor/fixture-dep": { name: "fixture-dep", version: "1.0.0" },
    },
  }, null, 2));
  writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
    'import { readFileSync } from "node:fs";',
    'import { containsExpectedBehavior } from "./verify-helper.mjs";',
    'const source = readFileSync(new URL("../src/answer.js", import.meta.url), "utf8");',
    'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
    'if (!containsExpectedBehavior(source, readme)) process.exit(1);',
  ].join("\n"));

  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.executableAllowlist = [
    { id: "npm-ci", argvPrefix: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], citation: "fixture dependency preparation" },
    { id: "npm-test", argvPrefix: ["npm", "test"], citation: "fixture earned deterministic gate" },
  ];
  contract.commands = [
    {
      id: "install-dependencies",
      argv: ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      authorizationSources: ["package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree",
      timeoutSeconds: 120,
      credentialRefs: [],
      sideEffect: "workspace",
      idempotence: "idempotent",
      parameters: {},
    },
    {
      id: "fixture-verify",
      argv: ["npm", "test"],
      authorizationSources: [
        "scripts/verify.mjs", "scripts/verify-helper.mjs", "package.json", "package-lock.json",
        "vendor/fixture-dep/package.json", "vendor/fixture-dep/index.js",
      ],
      cwd: "worktree",
      timeoutSeconds: 120,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    },
  ];
  contract.workspace.preparationCommandRefs = ["install-dependencies"];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", "-A"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare real npm workspace preparation"]);
}

function declarePreparedDependencies(fixture: ReturnType<typeof createRunnableFixture>): void {
  mkdirSync(join(fixture.root, "apps", "ui"), { recursive: true });
  writeFileSync(join(fixture.root, "package.json"), "{}\n");
  writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
  writeFileSync(join(fixture.root, "apps", "ui", "package.json"), "{}\n");
  writeFileSync(join(fixture.root, "apps", "ui", "package-lock.json"), "{}\n");
  writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\n");
  const installScript = (target: string, marker: string, manifest: string, lockfile: string) => [
    'import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    `readFileSync(${JSON.stringify(manifest)});`,
    `readFileSync(${JSON.stringify(lockfile)});`,
    `mkdirSync(${JSON.stringify(target)}, { recursive: true });`,
    `writeFileSync(${JSON.stringify(`${target}/index.js`)}, "export const ready = true;\\n");`,
    `appendFileSync("node_modules/.install-log", ${JSON.stringify(`${marker}\n`)});`,
  ].join("\n");
  writeFileSync(join(fixture.root, "scripts", "install-root.mjs"),
    installScript("node_modules/fixture-dep", "root", "package.json", "package-lock.json"));
  writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"),
    installScript("apps/ui/node_modules/fixture-ui-dep", "ui", "apps/ui/package.json", "apps/ui/package-lock.json"));
  writeFileSync(join(fixture.root, "scripts", "verify.mjs"), [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { containsExpectedBehavior } from "./verify-helper.mjs";',
    'const source = readFileSync(new URL("../src/answer.js", import.meta.url), "utf8");',
    'const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");',
    'const installed = ["../node_modules/fixture-dep/index.js", "../apps/ui/node_modules/fixture-ui-dep/index.js"];',
    'if (installed.some((path) => !existsSync(new URL(path, import.meta.url)))) process.exit(2);',
    "if (!containsExpectedBehavior(source, readme)) process.exit(1);",
  ].join("\n"));

  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.commands.push(
    {
      id: "install-dependencies", argv: ["node", "scripts/install-root.mjs"],
      authorizationSources: ["scripts/install-root.mjs", "package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree", timeoutSeconds: 600, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    },
    {
      id: "install-workspace-packages", argv: ["node", "scripts/install-ui.mjs"],
      authorizationSources: ["scripts/install-ui.mjs", "apps/ui/package.json", "apps/ui/package-lock.json"],
      dependencySources: { manifest: "apps/ui/package.json", lockfile: "apps/ui/package-lock.json" },
      cwd: "worktree", timeoutSeconds: 600, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    },
  );
  contract.workspace.preparationCommandRefs = ["install-dependencies", "install-workspace-packages"];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", "-A"]);
  git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare workspace preparation"]);
}

function declareGitDirectorySwapPreparation(fixture: ReturnType<typeof createRunnableFixture>): void {
  writeFileSync(join(fixture.root, "package.json"), "{}\n");
  writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
  writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(fixture.root, "scripts", "seed-git-decoy.mjs"), [
    'import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join, resolve } from "node:path";',
    'const pointer = readFileSync(".git", "utf8").trim();',
    'const originalGitDirectory = resolve(pointer.slice("gitdir: ".length));',
    'const decoyGitDirectory = resolve("node_modules/.git-decoy");',
    'mkdirSync("node_modules", { recursive: true });',
    'cpSync(originalGitDirectory, decoyGitDirectory, { recursive: true });',
    'const commonDirectory = resolve(originalGitDirectory, readFileSync(join(originalGitDirectory, "commondir"), "utf8").trim());',
    'writeFileSync(join(decoyGitDirectory, "commondir"), commonDirectory + "\\n");',
    'writeFileSync("node_modules/original-git-directory", originalGitDirectory + "\\n");',
  ].join("\n"));
  writeFileSync(join(fixture.root, "scripts", "swap-git-pointer.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'import { resolve } from "node:path";',
    'writeFileSync(".git", "gitdir: " + resolve("node_modules/.git-decoy") + "\\n");',
  ].join("\n"));

  const dependencySources = { manifest: "package.json", lockfile: "package-lock.json" };
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.commands.push(
    {
      id: "seed-git-decoy", argv: ["node", "scripts/seed-git-decoy.mjs"],
      authorizationSources: ["scripts/seed-git-decoy.mjs", "package.json", "package-lock.json"],
      dependencySources, cwd: "worktree", timeoutSeconds: 30, credentialRefs: [],
      sideEffect: "workspace", idempotence: "idempotent", parameters: {},
    },
    {
      id: "swap-git-pointer", argv: ["node", "scripts/swap-git-pointer.mjs"],
      authorizationSources: ["scripts/swap-git-pointer.mjs", "package.json", "package-lock.json"],
      dependencySources, cwd: "worktree", timeoutSeconds: 30, credentialRefs: [],
      sideEffect: "workspace", idempotence: "idempotent", parameters: {},
    },
  );
  contract.workspace.preparationCommandRefs = ["seed-git-decoy", "swap-git-pointer"];
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, [
    "add", ".graph-shipper/project.yaml", ".gitignore", "package.json", "package-lock.json",
    "scripts/seed-git-decoy.mjs", "scripts/swap-git-pointer.mjs",
  ]);
  git(fixture.root, [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-m", "declare Git directory pointer swap preparation",
  ]);
}

test("Git directory binding keeps the registered workspace index authoritative after a pointer swap", () => {
  const fixture = createRunnableFixture();
  const runId = "preparation-git-directory-swap";
  const workspacePath = join(fixture.dataRoot, "workspaces", runId);
  try {
    declareGitDirectorySwapPreparation(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 0, result.stdout || result.stderr);
    const originalGitDirectory = readFileSync(join(workspacePath, "node_modules", "original-git-directory"), "utf8").trim();
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${originalGitDirectory}\n`);
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("Git directory binding reaches a declared gate process", () => {
  const fixture = createRunnableFixture();
  const runId = "gate-git-directory-swap";
  const workspacePath = join(fixture.dataRoot, "workspaces", runId);
  try {
    declareGitDirectorySwapPreparation(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const gateArgv = ["git", "rev-parse", "--absolute-git-dir"];
    contract.executableAllowlist = [{
      id: "git-directory-probe",
      argvPrefix: gateArgv,
      citation: "issue #56 declared gate binding regression",
    }];
    contract.commands.push({
      id: "git-directory-probe", argv: gateArgv,
      authorizationSources: ["package.json", "package-lock.json"],
      cwd: "worktree", timeoutSeconds: 30, credentialRefs: [],
      sideEffect: "none", idempotence: "pure", parameters: {},
    });
    contract.verification.checks[0].executor = { kind: "command", commandRef: "git-directory-probe" };
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "probe the declared gate Git directory",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 0, result.stdout || result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const originalGitDirectory = readFileSync(
      join(workspacePath, "node_modules", "original-git-directory"), "utf8",
    ).trim();
    // The gate runs without GIT_DIR/GIT_WORK_TREE pins; the engine restores the swapped
    // pointer before the gate discovers the repository from its cwd.
    assert.equal(output.verification.checks[0].stdout.trim(), realpathSync(originalGitDirectory));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("Git directory binding survives a crash after preparation swaps the pointer", () => {
  const fixture = createRunnableFixture();
  const runId = "resume-git-directory-swap";
  const workspacePath = join(fixture.dataRoot, "workspaces", runId);
  try {
    declareGitDirectorySwapPreparation(fixture);
    activate(fixture.root, fixture.dataRoot);
    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_prepare:swap-git-pointer", "--json",
    ]);
    assert.notEqual(crashed.status, 0);

    const interrupted = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    assert.equal(interrupted.pendingEffect.kind, "workspace_prepare");
    assert.equal(interrupted.pendingEffect.target, "swap-git-pointer");
    const originalGitDirectory = readFileSync(
      join(workspacePath, "node_modules", "original-git-directory"), "utf8",
    ).trim();
    assert.equal(interrupted.state.workspaceGitDirectory, realpathSync(originalGitDirectory));

    const resumed = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${originalGitDirectory}\n`);
    assert.equal(git(workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a real package-manager preparation makes a lockfile-pinned dependency resolvable to the gate", () => {
  const fixture = createRunnableFixture();
  try {
    declareRealNpmPreparedDependency(fixture);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(output.verification.headSha, output.headSha);
    const gate = output.verification.checks.find((check: Record<string, unknown>) => check.id === "fixture-test");
    assert.equal(gate.exitCode, 0, JSON.stringify(gate));
    assert.match(gate.stdout, /fixture-target@1\.0\.0 test/);
    assert.ok(existsSync(join(output.workspacePath, "node_modules", "fixture-dep", "index.js")));
    assert.equal(git(output.workspacePath, ["status", "--porcelain", "--untracked-files=all"]), "");
    assert.equal(existsSync(join(fixture.root, "node_modules", "fixture-dep")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a gate needing installed dependencies fails without a declared preparation command", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.workspace.preparationCommandRefs = [];
    for (const command of contract.commands.filter((candidate: Record<string, any>) => candidate.dependencySources)) {
      delete command.dependencySources;
    }
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "drop workspace preparation"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /planner response for attempt 2/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a contract declaring no preparation leaves the phase absent rather than present-and-empty", () => {
  const fixture = createRunnableFixture();
  const runId = "no-preparation";
  try {
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const phases = readFileSync(join(fixture.dataRoot, "traces", `${runId}.jsonl`), "utf8")
      .split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { eventType: string; payload?: { phase?: string } })
      .filter((event) => event.eventType === "checkpoint")
      .map((event) => event.payload?.phase);
    assert.deepEqual(phases.filter((phase) => phase === "plan").length, 1, JSON.stringify(phases));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation reports untracked output through the single status pass", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    rmSync(join(fixture.root, ".gitignore"));
    git(fixture.root, ["add", "-A"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "stop ignoring dependency trees"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /node_modules\/fixture-dep\/index\.js: untracked and not ignored by any rule/);
    assert.match(output, /install output must be ignored by a tracked \.gitignore/);
    assert.doesNotMatch(output, /workspace_drift/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation reports a tracked rewrite once", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    const installUiPath = join(fixture.root, "scripts", "install-ui.mjs");
    writeFileSync(installUiPath, `${readFileSync(installUiPath, "utf8")}\nwriteFileSync("README.md", "prepared rewrite\\n");\n`);
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "rewrite a tracked file during preparation"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.equal(output.match(/README\.md: tracked content differs from the pinned base/g)?.length, 1);
    assert.doesNotMatch(output, /README\.md: tracked change left in the owned worktree/);
    assert.doesNotMatch(output, /workspace_drift/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation names tracked drift before capping untracked details", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    const installUiPath = join(fixture.root, "scripts", "install-ui.mjs");
    writeFileSync(installUiPath, `${readFileSync(installUiPath, "utf8")}
writeFileSync("README.md", "prepared rewrite\\n");
for (let index = 0; index < 25; index += 1) writeFileSync("artifact-" + index + ".txt", "undeclared\\n");
`);
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "overflow preparation diagnostics",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /README\.md: tracked content differs from the pinned base/);
    assert.match(output, /and 6 more undeclared paths/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot hide its own output through the shared Git exclude file", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'writeFileSync("hidden-artifact.txt", "undeclared\\n");',
      'appendFileSync(join(commonDir, "info", "exclude"), "hidden-artifact.txt\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output through info/exclude"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /hidden-artifact\.txt: .*info\/exclude/);
    const workspacePath = /retained worktree: ([^"\s]+)/.exec(output)?.[1];
    assert.ok(workspacePath, output);
    assert.ok(existsSync(join(workspacePath, "hidden-artifact.txt")));
    assert.match(readFileSync(join(fixture.root, ".git", "info", "exclude"), "utf8"), /hidden-artifact\.txt/);
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot rewrite shared Git attributes used by its content proof", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'writeFileSync(join(commonDir, "info", "attributes"), "mutable/state.txt eol=crlf\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "rewrite shared Git attributes during preparation",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    assert.match(result.stdout + result.stderr, /workspace preparation changed the shared Git attributes/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot hide its own output through a repository-local excludesFile", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    mkdirSync(join(fixture.root, "logs"), { recursive: true });
    writeFileSync(join(fixture.root, "logs", ".gitignore"), "*\n!.gitignore\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'writeFileSync("hidden-by-config.txt", "undeclared\\n");',
      'appendFileSync(join(commonDir, "config"), "\\n[core]\\n\\texcludesFile = logs/.gitignore\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs", "logs/.gitignore"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output through core.excludesFile"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation changed the repository-local Git configuration/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot hide its own output behind a .gitignore it wrote itself", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("undeclared", { recursive: true });',
      'writeFileSync("undeclared/.gitignore", "*\\n");',
      'writeFileSync("undeclared/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output behind an uncommitted .gitignore"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /undeclared\/artifact\.bin: undeclared\/\.gitignore/);
    const workspacePath = /retained worktree: ([^"\s]+)/.exec(output)?.[1];
    assert.ok(workspacePath, output);
    assert.ok(existsSync(join(workspacePath, "undeclared", "artifact.bin")));
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot hide its own output behind a pathspec sigil", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync(":(top)node_modules", { recursive: true });',
      'writeFileSync(":(top)node_modules/.gitignore", "*\\n");',
      'writeFileSync(":(top)node_modules/undeclared.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output behind a pathspec sigil"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /opens with a pathspec sigil and cannot be attributed to a rule/);
    const workspacePath = /retained worktree: ([^"\s]+)/.exec(output)?.[1];
    assert.ok(workspacePath, output);
    assert.ok(existsSync(join(workspacePath, ":(top)node_modules", "undeclared.bin")));
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot borrow a nested tracked .gitignore through a glob directory name", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "apps", "ui", ".gitignore"), "dist/\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("*", { recursive: true });',
      'writeFileSync("*/.gitignore", "*\\n");',
      'writeFileSync("*/undeclared.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs", "apps/ui/.gitignore"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output behind a glob directory name"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /undeclared\.bin: \*\/\.gitignore/);
    assert.equal(git(fixture.root, ["ls-files", "--error-unmatch", "-z", "--", "apps/ui/.gitignore"]).length > 0, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("preparation output a committed pattern covers is accepted, and an empty directory costs nothing", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\n*.log\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'readFileSync("apps/ui/package.json");',
      'readFileSync("apps/ui/package-lock.json");',
      'mkdirSync("apps/ui/node_modules/fixture-ui-dep", { recursive: true });',
      'writeFileSync("apps/ui/node_modules/fixture-ui-dep/index.js", "export const ready = true;\\n");',
      'appendFileSync("node_modules/.install-log", "ui\\n");',
      'mkdirSync("logs", { recursive: true });',
      'writeFileSync("logs/install.log", "installed\\n");',
      'mkdirSync("cache", { recursive: true });',
    ].join("\n"));
    git(fixture.root, ["add", ".gitignore", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare a file-pattern ignore beside the directory one"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.ok(existsSync(join(output.workspacePath, "logs", "install.log")));
    assert.ok(existsSync(join(output.workspacePath, "cache")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot hide a subtree by making its directory unreadable", () => {
  const fixture = createRunnableFixture();
  const runId = "preparation-unreadable-directory";
  const workspacePath = join(fixture.dataRoot, "workspaces", runId);
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { chmodSync, mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("undeclared", { recursive: true });',
      'writeFileSync("undeclared/artifact.bin", "undeclared\\n");',
      'chmodSync("undeclared", 0o000);',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output behind an unreadable directory"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 3, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /owned worktree enumeration failed/);
    assert.match(output, /EACCES|permission denied/i);
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    if (existsSync(join(workspacePath, "undeclared"))) chmodSync(join(workspacePath, "undeclared"), 0o755);
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot leave an NFD-spelled artifact unreported behind its own ignore rule", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("cafe\\u0301", { recursive: true });',
      'writeFileSync("cafe\\u0301/.gitignore", "*\\n");',
      'writeFileSync("cafe\\u0301/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "leave an NFD-spelled undeclared artifact"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /artifact\.bin: .*\.gitignore/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("two tracked paths differing only by case never produce a false undeclared report", () => {
  const fixture = createRunnableFixture();
  try {
    writeFileSync(join(fixture.root, "notes.txt"), "case-duplicate fixture\n");
    git(fixture.root, ["add", "notes.txt"]);
    const blob = git(fixture.root, ["hash-object", "-w", "notes.txt"]).trim();
    git(fixture.root, ["update-index", "--add", "--cacheinfo", `100644,${blob},NOTES.TXT`]);
    writeFileSync(join(fixture.root, "NOTES.TXT"), "case-duplicate fixture\n");
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    writeFileSync(join(fixture.root, "scripts", "noop.mjs"), "export {};\n");
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      id: "noop", argv: ["node", "scripts/noop.mjs"],
      authorizationSources: ["scripts/noop.mjs", "package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    });
    contract.workspace.preparationCommandRefs = ["noop"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", "package.json", "package-lock.json", "scripts/noop.mjs", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "register a case-duplicate tracked path"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

function runIndexBitTrackedPreparation(
  bit: "assume-unchanged" | "skip-worktree",
  mutation: "rewrite" | "delete" | "unchanged",
): { status: number | null; output: string } {
  const fixture = createRunnableFixture();
  const runId = `fixture-preparation-${bit}-${mutation}-1`;
  try {
    mkdirSync(join(fixture.root, "mutable"), { recursive: true });
    writeFileSync(join(fixture.root, "mutable", "state.txt"), "original\n");
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const suppressArgv = ["git", "update-index", `--${bit}`, "mutable/state.txt"];
    contract.executableAllowlist = [
      { id: `git-${bit}`, argvPrefix: suppressArgv, citation: `fixture ${bit} registration` },
    ];
    contract.commands.push({
      id: `mark-${bit}`, argv: suppressArgv,
      authorizationSources: ["package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    });
    const preparationSource = mutation === "rewrite"
      ? [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync("mutable/state.txt", "undeclared rewrite\\n");',
        ].join("\n")
      : mutation === "delete" ? [
          'import { rmSync } from "node:fs";',
          'rmSync("mutable/state.txt");',
        ].join("\n") : 'export const unchanged = true;\n';
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), preparationSource);
    contract.commands.push({
      id: "prepare-mutable", argv: ["node", "scripts/install-ui.mjs"],
      authorizationSources: ["scripts/install-ui.mjs", "package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    });
    contract.workspace.preparationCommandRefs = [`mark-${bit}`, "prepare-mutable"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", "mutable/state.txt", "package.json", "package-lock.json", ".graph-shipper/project.yaml", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", `hide a tracked ${mutation} behind ${bit}`,
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    if (mutation === "rewrite") {
      const source = Buffer.from("undeclared rewrite\n", "utf8");
      const objectId = createHash("sha1").update(`blob ${source.byteLength}\0`).update(source).digest("hex");
      assert.equal(existsSync(join(fixture.root, ".git", "objects", objectId.slice(0, 2), objectId.slice(2))), false);
    }
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
}

test("workspace preparation cannot hide a tracked change behind an assume-unchanged bit", () => {
  const { status, output } = runIndexBitTrackedPreparation("assume-unchanged", "rewrite");
  assert.equal(status, 4, output);
  assert.match(output, /workspace preparation left output the project has not declared/);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
});

test("workspace preparation cannot hide a tracked change behind a skip-worktree bit", () => {
  const { status, output } = runIndexBitTrackedPreparation("skip-worktree", "rewrite");
  assert.equal(status, 4, output);
  assert.match(output, /workspace preparation left output the project has not declared/);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
});

test("workspace preparation cannot hide a tracked deletion behind an assume-unchanged bit", () => {
  const { status, output } = runIndexBitTrackedPreparation("assume-unchanged", "delete");
  assert.equal(status, 4, output);
  assert.match(output, /workspace preparation left output the project has not declared/);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
});

test("workspace preparation cannot hide a tracked deletion behind a skip-worktree bit", () => {
  const { status, output } = runIndexBitTrackedPreparation("skip-worktree", "delete");
  assert.equal(status, 4, output);
  assert.match(output, /workspace preparation left output the project has not declared/);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
});

test("workspace preparation refuses unchanged content marked assume-unchanged", () => {
  const { status, output } = runIndexBitTrackedPreparation("assume-unchanged", "unchanged");
  assert.equal(status, 4, output);
  assert.match(output, /mutable\/state\.txt: marked assume-unchanged/);
  assert.doesNotMatch(output, /install output must be ignored/);
});

test("workspace preparation refuses unchanged content marked skip-worktree", () => {
  const { status, output } = runIndexBitTrackedPreparation("skip-worktree", "unchanged");
  assert.equal(status, 4, output);
  assert.match(output, /mutable\/state\.txt: marked skip-worktree/);
  assert.doesNotMatch(output, /install output must be ignored/);
});

function runSuppressedTrackedMetadataPreparation(scenario: "mode" | "type"): {
  status: number | null;
  output: string;
} {
  const fixture = createRunnableFixture();
  try {
    mkdirSync(join(fixture.root, "mutable"), { recursive: true });
    if (scenario === "type") {
      writeFileSync(join(fixture.root, "mutable", "target.txt"), "target\n");
      symlinkSync("target.txt", join(fixture.root, "mutable", "state.txt"));
    } else {
      writeFileSync(join(fixture.root, "mutable", "state.txt"), "original\n", { mode: 0o644 });
    }
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    writeFileSync(join(fixture.root, "scripts", "mutate-metadata.mjs"), scenario === "type"
      ? [
          'import { rmSync, writeFileSync } from "node:fs";',
          'rmSync("mutable/state.txt");',
          'writeFileSync("mutable/state.txt", "target.txt");',
        ].join("\n")
      : [
          'import { chmodSync } from "node:fs";',
          'chmodSync("mutable/state.txt", 0o755);',
        ].join("\n"));
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const suppressArgv = ["git", "update-index", "--skip-worktree", "mutable/state.txt"];
    contract.executableAllowlist = [{
      id: "git-skip-worktree",
      argvPrefix: suppressArgv,
      citation: `fixture tracked ${scenario} suppression`,
    }];
    const dependencySources = { manifest: "package.json", lockfile: "package-lock.json" };
    contract.commands.push(
      {
        id: "mark-skip-worktree", argv: suppressArgv,
        authorizationSources: ["package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
      {
        id: "mutate-metadata", argv: ["node", "scripts/mutate-metadata.mjs"],
        authorizationSources: ["scripts/mutate-metadata.mjs", "package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
    );
    contract.workspace.preparationCommandRefs = ["mark-skip-worktree", "mutate-metadata"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", "mutable", "package.json", "package-lock.json", "scripts/mutate-metadata.mjs", ".graph-shipper/project.yaml"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", `hide tracked ${scenario} drift`,
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
}

for (const scenario of ["mode", "type"] as const) {
  test(`workspace preparation detects tracked ${scenario} drift hidden by skip-worktree`, () => {
    const { status, output } = runSuppressedTrackedMetadataPreparation(scenario);
    assert.equal(status, 4, output);
    assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
  });
}

function runSparseTrackedPreparation(
  scenario: "rewrite-during-preparation" | "omit-from-worktree" | "all-paths-included",
): { status: number | null; output: string } {
  const fixture = createRunnableFixture();
  const runId = `fixture-preparation-sparse-${scenario}-1`;
  try {
    mkdirSync(join(fixture.root, "mutable"), { recursive: true });
    writeFileSync(join(fixture.root, "mutable", "state.txt"), "original\n");
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), scenario === "rewrite-during-preparation"
      ? [
          'import { mkdirSync, writeFileSync } from "node:fs";',
          'mkdirSync("mutable", { recursive: true });',
          'writeFileSync("mutable/state.txt", "sparse rewrite\\n");',
        ].join("\n")
      : 'export const unchanged = true;\n');
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const dependencySources = { manifest: "package.json", lockfile: "package-lock.json" };
    const sparseArgs = scenario === "all-paths-included"
      ? ["sparse-checkout", "set", "--no-cone", "/*"]
      : ["sparse-checkout", "set", "--no-cone", "/*", "!/mutable/"];
    const sparseArgv = ["git", ...sparseArgs];
    contract.executableAllowlist = [{
      id: "git-apply-sparse-checkout",
      argvPrefix: sparseArgv,
      citation: "fixture sparse-checkout preparation channel",
    }];
    contract.commands.push(
      {
        id: "apply-sparse-checkout", argv: sparseArgv,
        authorizationSources: ["package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
      {
        id: "prepare-mutable", argv: ["node", "scripts/install-ui.mjs"],
        authorizationSources: ["scripts/install-ui.mjs", "package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
    );
    contract.workspace.preparationCommandRefs = ["apply-sparse-checkout", "prepare-mutable"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", "mutable/state.txt", "package.json", "package-lock.json", ".graph-shipper/project.yaml", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "hide tracked content behind sparse checkout",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--crash-after-effect", "workspace_create", "--json",
    ]);
    assert.notEqual(crashed.status, 0);
    const interrupted = JSON.parse(runCli([
      "status", "--run-id", runId, "--data-root", fixture.dataRoot, "--json",
    ]).stdout) as Record<string, any>;
    const workspacePath = interrupted.pendingEffect.target as string;
    git(workspacePath, sparseArgs);

    const result = runCli([
      "resume", "--run-id", runId, "--project", fixture.root,
      "--data-root", fixture.dataRoot, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
}

test("workspace preparation cannot hide a tracked change behind sparse checkout", () => {
  const { status, output } = runSparseTrackedPreparation("rewrite-during-preparation");
  assert.equal(status, 4, output);
  assert.match(output, /workspace preparation left output the project has not declared/);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
});

test("workspace preparation accepts unchanged content with sparse checkout enabled", () => {
  const { status, output } = runSparseTrackedPreparation("all-paths-included");
  assert.equal(status, 0, output);
});

test("workspace preparation cannot hide a tracked deletion behind sparse checkout", () => {
  const { status, output } = runSparseTrackedPreparation("omit-from-worktree");
  assert.equal(status, 4, output);
  assert.match(output, /workspace preparation left output the project has not declared/);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
});

function runLineEndingPreparation(scenario: "hidden-rewrite" | "checkout-normalized"): {
  status: number | null;
  output: string;
  retainedContent: string;
} {
  const fixture = createRunnableFixture();
  try {
    mkdirSync(join(fixture.root, "mutable"), { recursive: true });
    const checkoutEol = scenario === "hidden-rewrite" ? "lf" : "crlf";
    writeFileSync(join(fixture.root, ".gitattributes"), `mutable/*.txt text eol=${checkoutEol}\n`);
    writeFileSync(join(fixture.root, "mutable", "state.txt"), "original\n");
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    const commandId = scenario === "hidden-rewrite" ? "rewrite-line-endings" : "noop";
    writeFileSync(join(fixture.root, "scripts", `${commandId}.mjs`), scenario === "hidden-rewrite"
      ? [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync("mutable/state.txt", "original\\r\\n");',
        ].join("\n")
      : "export {};\n");
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const dependencySources = { manifest: "package.json", lockfile: "package-lock.json" };
    const command = {
      id: commandId,
      argv: ["node", `scripts/${commandId}.mjs`],
      authorizationSources: [`scripts/${commandId}.mjs`, "package.json", "package-lock.json"],
      dependencySources,
      cwd: "worktree",
      timeoutSeconds: 30,
      credentialRefs: [],
      sideEffect: "workspace",
      idempotence: "idempotent",
      parameters: {},
    };
    if (scenario === "hidden-rewrite") {
      const suppressArgv = ["git", "update-index", "--assume-unchanged", "mutable/state.txt"];
      contract.executableAllowlist = [{
        id: "git-assume-unchanged",
        argvPrefix: suppressArgv,
        citation: "fixture clean-filter suppression",
      }];
      contract.commands.push({
        ...command,
        id: "mark-assume-unchanged",
        argv: suppressArgv,
        authorizationSources: ["package.json", "package-lock.json"],
      }, command);
      contract.workspace.preparationCommandRefs = ["mark-assume-unchanged", commandId];
    } else {
      contract.commands.push(command);
      contract.workspace.preparationCommandRefs = [commandId];
    }
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, [
      "add", ".gitattributes", "mutable/state.txt", "package.json", "package-lock.json",
      `scripts/${commandId}.mjs`, ".graph-shipper/project.yaml",
    ]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", `exercise ${scenario} line endings`,
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    const output = JSON.parse(result.stdout) as Record<string, any>;
    const workspacePath = output.workspacePath ?? /retained worktree: ([^"\s]+)/.exec(result.stdout + result.stderr)?.[1];
    assert.ok(workspacePath, result.stdout || result.stderr);
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      retainedContent: readFileSync(join(workspacePath, "mutable", "state.txt"), "utf8"),
    };
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
}

test("workspace preparation compares tracked bytes before clean-filter normalization", () => {
  const { status, output, retainedContent } = runLineEndingPreparation("hidden-rewrite");
  assert.equal(status, 4, output);
  assert.match(output, /mutable\/state\.txt: tracked content differs from the pinned base/);
  assert.equal(retainedContent, "original\r\n");
});

test("workspace preparation accepts checkout-normalized tracked bytes", () => {
  const { status, output, retainedContent } = runLineEndingPreparation("checkout-normalized");
  assert.equal(status, 0, output);
  assert.equal(retainedContent, "original\r\n");
});

test("workspace preparation cannot hide a tracked change behind a forged stat cache", () => {
  const fixture = createRunnableFixture();
  const runId = "fixture-preparation-forged-stat-cache-1";
  try {
    mkdirSync(join(fixture.root, "mutable"), { recursive: true });
    writeFileSync(join(fixture.root, "mutable", "state.txt"), "original\n");
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    const originalBlob = git(fixture.root, ["hash-object", "mutable/state.txt"]);
    writeFileSync(join(fixture.root, "scripts", "rewrite-mutable.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'const racilyCleanWindowWaitMs = 1100;',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, racilyCleanWindowWaitMs);',
      'writeFileSync("mutable/state.txt", "forged!!\\n");',
    ].join("\n"));
    writeFileSync(join(fixture.root, "scripts", "forge-index-stat.mjs"), [
      'import { createHash } from "node:crypto";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'const racilyCleanWindowWaitMs = 1100;',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, racilyCleanWindowWaitMs);',
      'const gitDirectory = resolve(readFileSync(".git", "utf8").trim().slice("gitdir: ".length));',
      'const indexPath = resolve(gitDirectory, "index");',
      'const index = readFileSync(indexPath);',
      'const nameOffset = index.indexOf(Buffer.from("mutable/state.txt\\0"));',
      'const sha1TrailerBytes = 20;',
      'const indexEntryFixedHeaderBytes = 62;',
      'const indexEntryObjectIdOffsetBytes = 40;',
      'if (nameOffset < indexEntryFixedHeaderBytes) throw new Error("tracked fixture path is absent from the index");',
      `Buffer.from(${JSON.stringify(originalBlob)}, "hex").copy(index, nameOffset - indexEntryFixedHeaderBytes + indexEntryObjectIdOffsetBytes);`,
      'const body = index.subarray(0, index.length - sha1TrailerBytes);',
      'createHash("sha1").update(body).digest().copy(index, index.length - sha1TrailerBytes);',
      'writeFileSync(indexPath, index);',
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, racilyCleanWindowWaitMs);',
    ].join("\n"));
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const stageArgv = ["git", "add", "mutable/state.txt"];
    const assertHiddenArgv = ["git", "diff-index", "--quiet", "HEAD", "--"];
    contract.executableAllowlist = [
      { id: "git-stage-forged", argvPrefix: stageArgv, citation: "fixture stat-cache setup" },
      { id: "git-assert-forged-hidden", argvPrefix: assertHiddenArgv, citation: "fixture stat-cache assertion" },
    ];
    const dependencySources = { manifest: "package.json", lockfile: "package-lock.json" };
    contract.commands.push(
      {
        id: "rewrite-mutable", argv: ["node", "scripts/rewrite-mutable.mjs"],
        authorizationSources: ["scripts/rewrite-mutable.mjs", "package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
      {
        id: "stage-forged", argv: stageArgv,
        authorizationSources: ["package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
      {
        id: "forge-index-stat", argv: ["node", "scripts/forge-index-stat.mjs"],
        authorizationSources: ["scripts/forge-index-stat.mjs", "package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
      {
        id: "assert-forged-hidden", argv: assertHiddenArgv,
        authorizationSources: ["package.json", "package-lock.json"], dependencySources,
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      },
    );
    contract.workspace.preparationCommandRefs = [
      "rewrite-mutable", "stage-forged", "forge-index-stat", "assert-forged-hidden",
    ];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, [
      "add", "mutable/state.txt", "package.json", "package-lock.json", ".graph-shipper/project.yaml",
      "scripts/rewrite-mutable.mjs", "scripts/forge-index-stat.mjs",
    ]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "forge a clean index stat over changed tracked content",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    assert.match(result.stdout + result.stderr, /workspace preparation left output the project has not declared/);
    assert.match(result.stdout + result.stderr, /mutable\/state\.txt: tracked content differs from the pinned base/);
    assert.equal(existsSync(join(fixture.root, ".graph-shipper", "state.sqlite")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});


test("workspace preparation cannot hide a tree under a nested .git directory", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("undeclared/.git", { recursive: true });',
      'writeFileSync("undeclared/.git/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide preparation output under a nested .git directory"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /undeclared\/\.git: nested \.git entry is not a registered submodule/);
    const workspacePath = /retained worktree: ([^"\s]+)/.exec(output)?.[1];
    assert.ok(workspacePath, output);
    assert.ok(existsSync(join(workspacePath, "undeclared", ".git", "artifact.bin")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a case-varied nested .git under a pathspec-magic directory is refused as drift", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync(":(invalid-magic)undeclared/.GIT", { recursive: true });',
      'writeFileSync(":(invalid-magic)undeclared/.GIT/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide output under a pathspec-magic directory"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /:\(invalid-magic\)undeclared\/\.GIT: nested \.git entry is not a registered submodule/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a vendored gitfile under a committed ignore rule is still refused, because it is not a registered gitlink", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\nvendor/\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("vendor/dep", { recursive: true });',
      'writeFileSync("vendor/dep/.git", "gitdir: /tmp/rogue-repository\\n");',
      'writeFileSync("vendor/dep/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", ".gitignore", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "vendor a gitfile under a committed ignore rule"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /vendor\/dep\/\.git: nested \.git entry is not a registered submodule/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a nested .git symlink under a committed ignore rule is still refused", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\nvendor/\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";',
      'mkdirSync("vendor/dep", { recursive: true });',
      'symlinkSync("../../.git", "vendor/dep/.git");',
      'writeFileSync("vendor/dep/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    git(fixture.root, ["add", ".gitignore", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "hide output behind a nested .git symlink"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /vendor\/dep\/\.git: nested \.git entry is not a registered submodule/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

function declareRegisteredGitlinkPreparation(
  fixture: ReturnType<typeof createRunnableFixture>,
  submodule: ReturnType<typeof createTrackedProject>,
  dirty: boolean,
): void {
  declarePreparedDependencies(fixture);
  mkdirSync(join(fixture.root, "vendor"), { recursive: true });
  writeFileSync(join(fixture.root, "vendor", ".keep"), "registered submodules live here\n");
  const gitlinkHead = git(submodule.root, ["rev-parse", "HEAD"]).trim();
  git(fixture.root, ["clone", "--quiet", submodule.root, "vendor/registered"]);
  git(fixture.root, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkHead},vendor/registered`]);

  const cloneArgv = ["git", "clone", "--quiet", submodule.root, "vendor/registered"];
  const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
  const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
  contract.executableAllowlist = [{
    id: "git-clone-registered-submodule", argvPrefix: cloneArgv,
    citation: "fixture registered-submodule preparation",
  }];
  contract.commands.push({
    id: "clone-registered-submodule", argv: cloneArgv,
    authorizationSources: ["package.json", "package-lock.json"],
    dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
    cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
    idempotence: "idempotent", parameters: {},
  });
  contract.workspace.preparationCommandRefs.push("clone-registered-submodule");
  const sources = [".graph-shipper/project.yaml", "vendor/.keep"];
  if (dirty) {
    writeFileSync(join(fixture.root, "scripts", "dirty-submodule.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("vendor/registered/artifact.bin", "undeclared\\n");',
    ].join("\n"));
    contract.commands.push({
      id: "dirty-registered-submodule", argv: ["node", "scripts/dirty-submodule.mjs"],
      authorizationSources: ["scripts/dirty-submodule.mjs", "package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    });
    contract.workspace.preparationCommandRefs.push("dirty-registered-submodule");
    sources.push("scripts/dirty-submodule.mjs");
  }
  writeFileSync(contractPath, stringify(contract));
  git(fixture.root, ["add", ...sources]);
  git(fixture.root, [
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m",
    dirty ? "dirty a registered gitlink during preparation" : "register a clean gitlink",
  ]);
}

test("a clean registered gitlink with a .git directory remains declared", () => {
  const fixture = createRunnableFixture();
  const submodule = createTrackedProject();
  try {
    declareRegisteredGitlinkPreparation(fixture, submodule, false);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((JSON.parse(result.stdout) as Record<string, any>).status, "completed");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    rmSync(submodule.root, { recursive: true, force: true });
    rmSync(submodule.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation reports dirty content inside a registered gitlink through the single status pass", () => {
  const fixture = createRunnableFixture();
  const submodule = createTrackedProject();
  try {
    declareRegisteredGitlinkPreparation(fixture, submodule, true);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /vendor\/registered: tracked change left in the owned worktree/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    rmSync(submodule.root, { recursive: true, force: true });
    rmSync(submodule.dataRoot, { recursive: true, force: true });
  }
});

test("a symlink is a leaf, so the walk cannot be sent out of the worktree or around a loop", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, ".gitignore"), "node_modules/\n*.loop\n");
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";',
      'readFileSync("apps/ui/package.json");',
      'readFileSync("apps/ui/package-lock.json");',
      'mkdirSync("apps/ui/node_modules/fixture-ui-dep", { recursive: true });',
      'writeFileSync("apps/ui/node_modules/fixture-ui-dep/index.js", "export const ready = true;\\n");',
      'appendFileSync("node_modules/.install-log", "ui\\n");',
      'symlinkSync(".", "self.loop");',
    ].join("\n"));
    git(fixture.root, ["add", ".gitignore", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "leave a self-referential symlink"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((JSON.parse(result.stdout) as Record<string, any>).status, "completed");
    assert.doesNotMatch(result.stdout + result.stderr, /owned worktree enumeration failed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a preparation command cannot redirect Git's work tree to a decoy directory", () => {
  const fixture = createRunnableFixture();
  const runId = "preparation-worktree-redirect";
  const workspacePath = join(fixture.dataRoot, "workspaces", runId);
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'appendFileSync(join(commonDir, "config"), "\\n[extensions]\\n\\tworktreeConfig = true\\n");',
      'const decoy = resolve("decoy");',
      'mkdirSync(decoy, { recursive: true });',
      'const skip = new Set([".git", "decoy", "secret.txt", "node_modules"]);',
      'for (const entry of readdirSync(".")) {',
      '  if (skip.has(entry)) continue;',
      '  cpSync(entry, join(decoy, entry), { recursive: true });',
      '}',
      'writeFileSync(join(gitDir, "config.worktree"), "[core]\\n\\tworktree = " + decoy + "\\n");',
      'writeFileSync("secret.txt", "undeclared secret\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "redirect the owned worktree to a decoy directory",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation changed the repository-local Git configuration/);
    assert.ok(existsSync(join(workspacePath, "secret.txt")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a preparation command cannot rewrite the repository-local Git configuration to hide its output", () => {
  const fixture = createRunnableFixture();
  const runId = "preparation-local-config-drift";
  const workspacePath = join(fixture.dataRoot, "workspaces", runId);
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'import { tmpdir } from "node:os";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'const excludesFile = join(tmpdir(), "graph-shipper-issue-54-excludes");',
      'writeFileSync(excludesFile, "secret.txt\\n");',
      'appendFileSync(join(commonDir, "config"), "\\n[core]\\n\\texcludesFile = " + excludesFile + "\\n");',
      'writeFileSync("secret.txt", "undeclared secret\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "rewrite the shared Git config through core.excludesFile",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    assert.match(result.stdout + result.stderr, /workspace preparation changed the repository-local Git configuration/);
    assert.ok(existsSync(join(workspacePath, "secret.txt")));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot move the owned worktree off its pinned head", () => {
  const fixture = createRunnableFixture();
  const runId = "preparation-revision-drift";
  try {
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    git(fixture.root, ["add", "package.json", "package-lock.json"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add preparation inputs"]);
    const driftTarget = git(fixture.root, ["rev-parse", "HEAD"]);

    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const resetArgv = ["git", "reset", "--hard", driftTarget];
    contract.executableAllowlist = [{
      id: "reset-prepared-worktree",
      argvPrefix: resetArgv,
      citation: "fixture for the immutable workspace preparation head and branch postcondition",
    }];
    contract.commands.push({
      id: "reset-prepared-worktree",
      argv: resetArgv,
      authorizationSources: ["package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree",
      timeoutSeconds: 30,
      credentialRefs: [],
      sideEffect: "workspace",
      idempotence: "idempotent",
      parameters: {},
    });
    contract.workspace.preparationCommandRefs = ["reset-prepared-worktree"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare revision-changing preparation"]);
    const pinnedBase = git(fixture.root, ["rev-parse", "HEAD"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /workspace preparation changed the owned worktree head or branch/);
    const workspacePath = join(fixture.dataRoot, "workspaces", runId);
    assert.equal(git(workspacePath, ["rev-parse", "HEAD"]), driftTarget);
    assert.notEqual(driftTarget, pinnedBase);
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("workspace preparation cannot move the owned worktree off its pinned branch", () => {
  const fixture = createRunnableFixture();
  const runId = "preparation-branch-drift";
  try {
    writeFileSync(join(fixture.root, "package.json"), "{}\n");
    writeFileSync(join(fixture.root, "package-lock.json"), "{}\n");
    git(fixture.root, ["add", "package.json", "package-lock.json"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add preparation inputs"]);

    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    const detachArgv = ["git", "checkout", "--detach"];
    contract.executableAllowlist = [{
      id: "detach-prepared-worktree",
      argvPrefix: detachArgv,
      citation: "fixture for the immutable workspace preparation head and branch postcondition",
    }];
    contract.commands.push({
      id: "detach-prepared-worktree",
      argv: detachArgv,
      authorizationSources: ["package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree",
      timeoutSeconds: 30,
      credentialRefs: [],
      sideEffect: "workspace",
      idempotence: "idempotent",
      parameters: {},
    });
    contract.workspace.preparationCommandRefs = ["detach-prepared-worktree"];
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare branch-changing preparation"]);
    const pinnedBase = git(fixture.root, ["rev-parse", "HEAD"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath,
      "--run-id", runId, "--json",
    ]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /workspace preparation changed the owned worktree head or branch/);
    const workspacePath = join(fixture.dataRoot, "workspaces", runId);
    assert.equal(git(workspacePath, ["rev-parse", "HEAD"]), pinnedBase);
    assert.equal(git(workspacePath, ["branch", "--show-current"]), "");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a failed preparation command reports its exit code even when it also changes the branch", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const gitFile = readFileSync(".git", "utf8").trim();',
      'const gitDir = gitFile.slice("gitdir: ".length);',
      'writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/preparation-failed\\n");',
      'process.exit(7);',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "make preparation fail after branch drift"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    assert.match(result.stdout + result.stderr, /workspace preparation command failed: install-workspace-packages/);
    assert.match(result.stdout + result.stderr, /exit code 7/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a failed preparation command stops the run before planning and retains the worktree", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), "process.exit(7);\n");
    git(fixture.root, ["add", "-A"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "break the second install"]);
    activate(fixture.root, fixture.dataRoot);

    const result = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 4, result.stdout || result.stderr);
    const output = result.stdout + result.stderr;
    assert.match(output, /workspace preparation command failed: install-workspace-packages/);
    assert.match(output, /exit code 7/);
    const workspacePath = /retained worktree: ([^"\s]+)/.exec(output)?.[1];
    assert.ok(workspacePath, output);
    assert.ok(existsSync(join(workspacePath, "node_modules", "fixture-dep", "index.js")));
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume after a preparation crash re-drives only the command with no receipt", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", "prepare-crash",
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      "--crash-after-effect", "workspace_prepare:install-workspace-packages",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", "prepare-crash",
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(readFileSync(join(output.workspacePath, "node_modules", ".install-log"), "utf8"), "root\nui\nui\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume reports pending preparation drift through the single status pass", () => {
  const fixture = createRunnableFixture();
  const runId = "prepare-drift-crash";
  try {
    declarePreparedDependencies(fixture);
    const installUiPath = join(fixture.root, "scripts", "install-ui.mjs");
    writeFileSync(installUiPath, `${readFileSync(installUiPath, "utf8")}\nwriteFileSync("README.md", "prepared rewrite\\n");\n`);
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "rewrite a tracked file before a preparation crash"]);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      "--crash-after-effect", "workspace_prepare:install-workspace-packages",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    const output = resumed.stdout + resumed.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /README\.md: tracked content differs from the pinned base/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume reports preparation output hidden through shared info/exclude", () => {
  const fixture = createRunnableFixture();
  const runId = "prepare-hidden-output-crash";
  try {
    declarePreparedDependencies(fixture);
    writeFileSync(join(fixture.root, "scripts", "install-ui.mjs"), [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
      'import { join, resolve } from "node:path";',
      'const gitDir = readFileSync(".git", "utf8").trim().slice("gitdir: ".length);',
      'const commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());',
      'writeFileSync("hidden-artifact.txt", "undeclared\\n");',
      'appendFileSync(join(commonDir, "info", "exclude"), "hidden-artifact.txt\\n");',
    ].join("\n"));
    git(fixture.root, ["add", "scripts/install-ui.mjs"]);
    git(fixture.root, [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "-m", "hide preparation output before a crash",
    ]);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      "--crash-after-effect", "workspace_prepare:install-workspace-packages",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    const output = resumed.stdout + resumed.stderr;
    assert.match(output, /workspace preparation left output the project has not declared/);
    assert.match(output, /hidden-artifact\.txt: .*info\/exclude/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume after a preparation receipt crash adopts that command and continues in order", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", "prepare-receipt-crash",
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      "--crash-after-receipt", "workspace_prepare:install-dependencies",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", "prepare-receipt-crash",
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(readFileSync(join(output.workspacePath, "node_modules", ".install-log"), "utf8"), "root\nui\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("resume refuses an indeterminate workspace preparation receipt after drift is repaired", () => {
  const fixture = createRunnableFixture();
  const runId = "indeterminate-preparation";
  try {
    declarePreparedDependencies(fixture);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      "--crash-after-effect", "workspace_prepare:install-workspace-packages",
    ]);
    assert.notEqual(crashed.status, 0);

    const store = new StateStore(fixture.dataRoot);
    try {
      const pending = store.preparedEffect(runId);
      assert.equal(pending?.kind, "workspace_prepare");
      assert.ok(pending);
      store.completeEffect(pending.effectId, "indeterminate", { reason: "simulated crash before escalation" }, new Date().toISOString());
    } finally {
      store.close();
    }

    const workspacePath = join(fixture.dataRoot, "workspaces", runId);
    rmSync(join(workspacePath, "apps", "ui", "node_modules"), { recursive: true, force: true });
    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", runId,
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 4, resumed.stderr || resumed.stdout);
    assert.match(resumed.stdout + resumed.stderr, /workspace preparation receipt is indeterminate/);
    assert.equal(existsSync(join(workspacePath, "src", "answer.js")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a resume that adopts the workspace it crashed creating still runs the declared preparation", () => {
  const fixture = createRunnableFixture();
  try {
    declarePreparedDependencies(fixture);
    activate(fixture.root, fixture.dataRoot);

    const crashed = runCli([
      "run", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", "adopt-then-prepare",
      "--request", fixture.requestPath, "--adapter-fixture", fixture.adapterFixturePath, "--json",
      "--crash-after-effect", "workspace_create",
    ]);
    assert.notEqual(crashed.status, 0);

    const resumed = runCli([
      "resume", "--project", fixture.root, "--data-root", fixture.dataRoot, "--run-id", "adopt-then-prepare",
      "--adapter-fixture", fixture.adapterFixturePath, "--json",
    ]);

    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    const output = JSON.parse(resumed.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.equal(readFileSync(join(output.workspacePath, "node_modules", ".install-log"), "utf8"), "root\nui\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a contract authored from the template, placeholders filled, reaches a successful Work Run", () => {
  const parent = mkdtempSync(join(tmpdir(), "graph-shipper-template-run-"));
  const root = join(parent, "project");
  const dataRoot = mkdtempSync(join(tmpdir(), "graph-shipper-template-data-"));
  try {
    mkdirSync(join(root, ".graph-shipper"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "README.md"), "# Template Project\n");
    writeFileSync(join(root, "scripts", "replace-with-project-test.mjs"), "process.exit(0);\n");
    git(root, ["init", "-b", "main"]);
    git(root, ["remote", "add", "origin", "https://github.com/owner/repository.git"]);
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "project base"]);
    const observedHeadSha = git(root, ["rev-parse", "HEAD"]);

    const templatePath = join(fileURLToPath(new URL("..", import.meta.url)), "examples", "project-contract.template.yaml");
    const contract = readFileSync(templatePath, "utf8")
      .replace("projectId: replace-me", "projectId: template-fixture")
      .replace("primaryCloneRealpath: /absolute/path/to/project", `primaryCloneRealpath: ${root}`)
      .replaceAll("a".repeat(40), observedHeadSha)
      .replace("  rules: []\n", [
        "  rules:", "    - id: local-workspace-edits", "      effect: pre_approved", "      actionKinds: [write_file]",
        "      pathGlobs: [\"src/**\", README.md]", "      citation: template test edit policy", "",
      ].join("\n"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), contract);
    git(root, ["add", ".graph-shipper/project.yaml"]);
    git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add project contract"]);

    const onboard = runCli(["contract", "onboard", "--project", root, "--data-root", dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
    const candidate = JSON.parse(onboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const activation = runCli([
      "contract", "activate", "--project", root, "--data-root", dataRoot,
      "--contract-digest", candidate.contractDigest, "--admission-evidence-digest", candidate.admissionEvidenceDigest,
      "--confirm-project", "template-fixture", "--json",
    ]);
    assert.equal(activation.status, 0, activation.stderr || activation.stdout);

    const requestPath = join(dataRoot, "run-request.json");
    writeFileSync(requestPath, JSON.stringify({
      schemaVersion: "1.0.0",
      workItem: {
        id: "template-request-1", projectId: "template-fixture",
        source: { kind: "feature_request", identity: "template-request-1", revision: "revision-1" },
        baseBranch: "main", title: "Add answerFeature",
        body: "Expose a local answerFeature function returning 42 and document it.",
        desiredBehavior: ["answerFeature returns 42"],
        acceptanceCriteria: [{ criterion: "the function and documentation exist", evidence: "project-test exits zero" }],
        constraints: ["local-only; no GitHub writes"],
        provenance: ["request:title", "request:body", "request:acceptanceCriteria[0]"],
      },
      buildAssignmentId: "anthropic-build", reviewAssignmentId: "openai-review", autonomy: "local_only",
    }));
    const adapterFixturePath = join(dataRoot, "provider-fixture.json");
    writeFileSync(adapterFixturePath, JSON.stringify({
      schemaVersion: "1.0.0",
      planner: {
        provider: "anthropic",
        responses: [{
          kind: "plan", fileActionSemantics: "base_bound_v1", summary: "Implement and document answerFeature.",
          actions: [
            { kind: "write_file", path: "src/answer.js", content: "export function answerFeature() { return 42; }\n" },
            {
              kind: "edit_file", path: "README.md",
              baseContentSha256: createHash("sha256").update("# Template Project\n").digest("hex"),
              replacements: [{ oldText: "# Template Project\n", newText: "# Template Project\n\n`answerFeature()` returns 42.\n" }],
            },
          ],
          documentation: { kind: "coverage_plan", entries: [{ impact: "release_record", topic: "overview", path: "README.md" }] },
          commitMessage: "Add answer feature",
        }],
      },
      reviewer: { provider: "openai", responses: [{ verdict: "approve", summary: "Matches the request.", findings: [] }] },
    }));

    const result = runCli([
      "run", "--project", root, "--data-root", dataRoot,
      "--request", requestPath, "--adapter-fixture", adapterFixturePath, "--json",
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.status, "completed");
    assert.ok(String(output.workspacePath).startsWith(join(parent, "graph-shipper-worktrees")), output.workspacePath);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
