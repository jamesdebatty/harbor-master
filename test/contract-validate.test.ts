import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createTrackedProject, git, runCli, validContract } from "./helpers.js";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("contract validate accepts a credential-free v1 project contract without writing runtime state", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-validate-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(validContract(root)));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.ok, true);
    assert.equal(output.projectId, "fixture-project");
    assert.match(String(output.contractDigest), /^[0-9a-f]{64}$/);
    assert.equal(output.canonicalPath, join(root, ".graph-shipper", "project.yaml"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate accepts an explicit commit-status evidence source", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-status-source-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.github.requiredCheckSource = "commit_statuses";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const accepted = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    contract.github.requiredCheckSource = "anything";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const refused = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(refused.status, 3, refused.stderr || refused.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate accepts a commit identity and refuses values Git cannot author with", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-commit-identity-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.delivery.commitIdentity = { name: "Fixture Shipper", email: "fixture-shipper@example.invalid" };
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const accepted = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
    for (const invalid of [
      { name: "Fixture\nShipper", email: "fixture-shipper@example.invalid" },
      { name: "Fixture Shipper", email: "not-an-email" },
    ]) {
      contract.delivery.commitIdentity = invalid;
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
      const refused = runCli(["contract", "validate", "--project", root, "--json"]);
      assert.equal(refused.status, 3, refused.stderr || refused.stdout);
      assert.match((JSON.parse(refused.stdout) as { errors: string[] }).errors.join("\n"), /delivery.*commitIdentity/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses a verification executor no Work Run can execute", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-builtin-executor-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.verification.checks[0].executor = { kind: "builtin", check: "some-future-check" };
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    const output = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
    assert.equal(output.ok, false);
    assert.match(output.errors.join("\n"), /fixture-test: verification executor builtin is not executable; declare kind: command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses a command whose authorization source the project does not hold", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-absent-source-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    rmSync(join(root, "scripts", "fixture-verify.mjs"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    const output = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
    assert.equal(output.ok, false);
    assert.match(output.errors.join("\n"), /fixture-verify: authorization source scripts\/fixture-verify\.mjs is not a regular file in the project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-merge admission requires observable probes for non-idempotent hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-hook-probe-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "hook.mjs"), "process.exit(0);\n");
    writeFileSync(join(root, "scripts", "probe.mjs"), "process.exit(0);\n");
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push(
      {
        id: "deploy-app", argv: ["node", "scripts/hook.mjs"], authorizationSources: ["scripts/hook.mjs"],
        cwd: "synced_main", timeoutSeconds: 60, credentialRefs: [], sideEffect: "local_operation",
        idempotence: "non_idempotent", parameters: {},
      },
      {
        id: "probe-app", argv: ["node", "scripts/probe.mjs"], authorizationSources: ["scripts/probe.mjs"],
        cwd: "synced_main", timeoutSeconds: 30, credentialRefs: [], sideEffect: "none",
        idempotence: "pure", parameters: {},
      },
    );
    contract.postMergeHooks = [{
      id: "deploy", order: 10, commandRef: "deploy-app", successCheckCommandRef: "probe-app",
      retry: { maximumAttempts: 2, backoffSeconds: 1 }, onFailure: "escalate_preserve_state",
    }];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), /deploy: success check must be an observable probe/);

    contract.commands.find((command: { id: string }) => command.id === "probe-app").idempotence = "probe";
    contract.commands.find((command: { id: string }) => command.id === "deploy-app").cwd = "runtime";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const wrongCwd = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(wrongCwd.status, 3, wrongCwd.stderr || wrongCwd.stdout);
    assert.match((JSON.parse(wrongCwd.stdout) as { errors: string[] }).errors.join("\n"), /run from synchronized main/);

    const deploy = contract.commands.find((command: { id: string }) => command.id === "deploy-app");
    deploy.cwd = "synced_main";
    contract.credentials.references.push(
      { id: "deploy-token", purpose: "post_merge_operation" },
      { id: "provider-token", purpose: "post_merge_operation" },
    );
    deploy.credentialRefs = ["deploy-token", "provider-token"];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const broadCredentials = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(broadCredentials.status, 3, broadCredentials.stderr || broadCredentials.stdout);
    assert.match((JSON.parse(broadCredentials.stdout) as { errors: string[] }).errors.join("\n"), /at most one exact credential reference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compensating hooks are separate exact-target entries bound to captured prior state", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-compensation-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    mkdirSync(join(root, "scripts"));
    for (const script of ["hook", "probe", "capture", "restore"]) {
      writeFileSync(join(root, "scripts", `${script}.mjs`), "process.exit(0);\n");
    }
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push(
      {
        id: "deploy-app", argv: ["node", "scripts/hook.mjs"], authorizationSources: ["scripts/hook.mjs"],
        cwd: "synced_main", timeoutSeconds: 60, credentialRefs: [], sideEffect: "local_operation",
        idempotence: "non_idempotent", parameters: {},
      },
      {
        id: "probe-app", argv: ["node", "scripts/probe.mjs"], authorizationSources: ["scripts/probe.mjs"],
        cwd: "synced_main", timeoutSeconds: 30, credentialRefs: [], sideEffect: "none",
        idempotence: "probe", parameters: {},
      },
      {
        id: "capture-app", argv: ["node", "scripts/capture.mjs", "/Applications/Fixture.app"], authorizationSources: ["scripts/capture.mjs"],
        cwd: "synced_main", timeoutSeconds: 30, credentialRefs: [], sideEffect: "none",
        idempotence: "probe", parameters: {},
      },
      {
        id: "probe-prior-app", argv: ["node", "scripts/probe.mjs", "/Applications/Fixture.app", "{prior_state_artifact}"], authorizationSources: ["scripts/probe.mjs"],
        cwd: "synced_main", timeoutSeconds: 30, credentialRefs: [], sideEffect: "none",
        idempotence: "probe", parameters: {
          prior_state_artifact: { type: "absolute_path", pathRoot: "runtime_data" },
        },
      },
      {
        id: "restore-app", argv: ["node", "scripts/restore.mjs", "/Applications/Fixture.app", "{prior_state_artifact}"], authorizationSources: ["scripts/restore.mjs"],
        cwd: "synced_main", timeoutSeconds: 60, credentialRefs: [], sideEffect: "local_operation",
        idempotence: "non_idempotent", parameters: {
          prior_state_artifact: { type: "absolute_path", pathRoot: "runtime_data" },
        },
      },
    );
    contract.postMergeHooks = [{
      id: "deploy", order: 0, commandRef: "deploy-app", successCheckCommandRef: "probe-app",
      retry: { maximumAttempts: 2, backoffSeconds: 1 }, onFailure: "escalate_preserve_state",
      compensatingHookRef: "restore-known-good",
    }];
    contract.compensatingHooks = [{
      id: "restore-known-good", forPostMergeHookRef: "deploy", commandRef: "restore-app",
      priorStateCaptureCommandRef: "capture-app", successCheckCommandRef: "probe-prior-app",
      timeoutSeconds: 60, retry: { maximumAttempts: 1, backoffSeconds: 0 },
      ownershipBoundary: { owner: "local-operator", exactTarget: "/Applications/Fixture.app" },
    }];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const accepted = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    for (const field of [
      "commandRef", "priorStateCaptureCommandRef", "successCheckCommandRef",
      "timeoutSeconds", "retry", "ownershipBoundary",
    ]) {
      const incomplete = structuredClone(contract);
      delete incomplete.compensatingHooks[0][field];
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(incomplete));
      const missingField = runCli(["contract", "validate", "--project", root, "--json"]);
      assert.equal(missingField.status, 3, `${field}: ${missingField.stderr || missingField.stdout}`);
      assert.match(
        (JSON.parse(missingField.stdout) as { errors: string[] }).errors.join("\n"),
        new RegExp(`compensatingHooks\\.0\\.${field}`),
      );
    }

    const restoreCommand = contract.commands.find((command: { id: string }) => command.id === "restore-app");
    restoreCommand.argv[2] = "{target}";
    restoreCommand.parameters.target = { type: "absolute_path" };
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const inventedTarget = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(inventedTarget.status, 3, inventedTarget.stderr || inventedTarget.stdout);
    assert.match((JSON.parse(inventedTarget.stdout) as { errors: string[] }).errors.join("\n"), /restore-known-good: compensation target must be a literal exact argv value/);

    restoreCommand.argv[2] = "/Applications/Fixture.app";
    delete restoreCommand.parameters.target;
    restoreCommand.argv = ["node", "scripts/restore.mjs", "git", "-C", "/Applications/Fixture.app", "revert", "deadbeef", "/Applications/Fixture.app"];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const gitRevert = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(gitRevert.status, 3, gitRevert.stderr || gitRevert.stdout);
    assert.match((JSON.parse(gitRevert.stdout) as { errors: string[] }).errors.join("\n"), /restore-known-good: compensation must not revert Git history/);

    restoreCommand.argv = ["node", "scripts/restore.mjs", "/Applications/Fixture.app", "{prior_state_artifact}"];
    contract.compensatingHooks[0].ownershipBoundary.exactTarget = join(root, ".git", "refs", "heads", "main");
    restoreCommand.argv[2] = contract.compensatingHooks[0].ownershipBoundary.exactTarget;
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const repositoryTarget = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(repositoryTarget.status, 3, repositoryTarget.stderr || repositoryTarget.stdout);
    assert.match((JSON.parse(repositoryTarget.stdout) as { errors: string[] }).errors.join("\n"), /restore-known-good: compensation target must be outside the project repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model fallback assignments are explicit, same-role, and same-provider", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-model-fallbacks-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.models.buildAssignments.push({
      id: "anthropic-build-fallback", provider: "anthropic", modelRef: "fallback-build", credentialRef: "anthropic-default",
    });
    contract.models.buildAssignments[0].fallbackAssignmentIds = ["anthropic-build-fallback"];
    contract.models.reviewAssignments.push({
      id: "openai-review-fallback", provider: "openai", modelRef: "fallback-review", credentialRef: "openai-default",
    });
    contract.models.reviewAssignments[0].fallbackAssignmentIds = ["openai-review-fallback"];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const accepted = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    contract.models.buildAssignments[1].transport = "subscription_cli";
    delete contract.models.buildAssignments[1].credentialRef;
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const mixedTransport = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(mixedTransport.status, 3, mixedTransport.stderr || mixedTransport.stdout);
    assert.match((JSON.parse(mixedTransport.stdout) as { errors: string[] }).errors.join("\n"), /fallback .* must retain api transport/);
    contract.models.buildAssignments[1].transport = "api";
    contract.models.buildAssignments[1].credentialRef = "anthropic-default";

    contract.models.buildAssignments[1].fallbackAssignmentIds = ["anthropic-build"];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const cyclic = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(cyclic.status, 3, cyclic.stderr || cyclic.stdout);
    assert.match((JSON.parse(cyclic.stdout) as { errors: string[] }).errors.join("\n"), /cyclic build fallback assignments/);
    contract.models.buildAssignments[1].fallbackAssignmentIds = [];

    contract.models.buildAssignments[0].fallbackAssignmentIds = ["openai-review-fallback", "missing-assignment"];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const rejected = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(rejected.status, 3, rejected.stderr || rejected.stdout);
    const errors = (JSON.parse(rejected.stdout) as { errors: string[] }).errors.join("\n");
    assert.match(errors, /fallback openai-review-fallback is not a build assignment/);
    assert.match(errors, /unknown fallback assignment missing-assignment/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model assignments explicitly select API or subscription CLI transport", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-model-transport-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.models.buildAssignments[0].transport = "subscription_cli";
    delete contract.models.buildAssignments[0].credentialRef;
    contract.models.reviewAssignments[0].transport = "api";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const accepted = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

    contract.models.buildAssignments[0].credentialRef = "anthropic-default";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const misleadingCredential = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(misleadingCredential.status, 3, misleadingCredential.stderr || misleadingCredential.stdout);
    assert.match((JSON.parse(misleadingCredential.stdout) as { errors: string[] }).errors.join("\n"), /credentialRef/);
    delete contract.models.buildAssignments[0].credentialRef;

    contract.models.buildAssignments[0].transport = "browser_session";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
    const rejected = runCli(["contract", "validate", "--project", root, "--json"]);
    assert.equal(rejected.status, 3, rejected.stderr || rejected.stdout);
    assert.match((JSON.parse(rejected.stdout) as { errors: string[] }).errors.join("\n"), /transport/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured CLI results remain inspectable without the JSON automation flag", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-readable-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(validContract(root)));

    const result = runCli(["contract", "validate", "--project", root]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { ok: boolean }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the documented Project Contract template remains validator-compatible after required substitutions", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-template-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    git(root, ["init", "-b", "main"]);
    const templatePath = join(repositoryRoot, "examples", "project-contract.template.yaml");
    const contract = parse(readFileSync(templatePath, "utf8")) as Record<string, any>;
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "replace-with-project-test.mjs"), "process.exit(0);\n");
    contract.metadata.projectId = "template-fixture";
    contract.repository.primaryCloneRealpath = root;
    contract.repository.repoFacts.observedHeadSha = "b".repeat(40);
    contract.verification.checks[0].earnedEvidence.againstHeadSha = "b".repeat(40);
    contract.approvalPolicy.rules = [{
      id: "local-workspace-edits", effect: "pre_approved", actionKinds: ["write_file"], pathGlobs: ["src/**", "README.md"], citation: "template test edit policy",
    }];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal((JSON.parse(result.stdout) as { ok: boolean }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated documentation declares sources plus separate regeneration and drift checks", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-generated-docs-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    writeFileSync(join(root, "scripts", "generate-docs.mjs"), "process.exit(0);\n");
    writeFileSync(join(root, "scripts", "check-docs.mjs"), "process.exit(0);\n");
    contract.commands.push(
      {
        id: "docs-generate",
        argv: ["node", "scripts/generate-docs.mjs"],
        authorizationSources: ["scripts/generate-docs.mjs"],
        cwd: "project_root",
        timeoutSeconds: 60,
        credentialRefs: [],
        sideEffect: "workspace",
        idempotence: "idempotent",
        parameters: {},
      },
      {
        id: "docs-drift-check",
        argv: ["node", "scripts/check-docs.mjs"],
        authorizationSources: ["scripts/check-docs.mjs"],
        cwd: "worktree",
        timeoutSeconds: 60,
        credentialRefs: [],
        sideEffect: "none",
        idempotence: "pure",
        parameters: {},
      },
    );
    contract.documentation.rules.push({
      id: "generated-reference",
      glob: "docs/generated/*.md",
      class: "generated",
      topics: ["reference"],
      entryPoint: false,
      protected: true,
      sourceGlobs: ["src/schema/**"],
      regenerateCommandRef: "docs-generate",
      driftCheckCommandRef: "docs-drift-check",
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validation rejects generic credential, forge, and wrapped-shell escape hatches", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-escape-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.credentials.references.push({ id: "github-operator", purpose: "github_operator" });
    contract.models.buildAssignments[0].credentialRef = "openai-default";
    contract.commands.push({
      id: "unsafe-delivery",
      argv: ["env", "bash", "-c", "gh pr merge"],
      authorizationSources: ["scripts/unused.mjs"],
      cwd: "project_root",
      timeoutSeconds: 60,
      credentialRefs: ["github-operator"],
      sideEffect: "github",
      idempotence: "non_idempotent",
      parameters: {},
    });
    contract.commands.push({
      id: "unsafe-package-wrapper",
      argv: ["npm", "exec", "--", "node", "-e", "process.exit(0)"],
      authorizationSources: ["scripts/unused.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    contract.commands.push({
      id: "unsafe-node-eval",
      argv: ["node", "--eval=process.exit(0)"],
      authorizationSources: ["scripts/unused.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    contract.commands.push({
      id: "unsafe-git-commit",
      argv: ["git", "commit", "-am", "unauthorized"],
      authorizationSources: ["scripts/unused.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    contract.commands.push({
      id: "unsafe-local-node-alias",
      argv: ["./node", "scripts/verify.mjs"],
      authorizationSources: ["scripts/verify.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    contract.commands.push({
      id: "unsafe-npx-wrapper",
      argv: ["npx", "node", "-e", "process.exit(0)"],
      authorizationSources: ["scripts/unused.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stderr);
    const errors = (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n");
    assert.match(errors, /GitHub operator credentials require the typed GitHub Adapter/);
    assert.match(errors, /anthropic assignment requires a anthropic_model credential reference/);
    assert.match(errors, /Node commands must name one relative digest-bound script/);
    assert.match(errors, /env is not admitted by the contract executable allowlist/);
    assert.match(errors, /npx is not admitted by the contract executable allowlist/);
    assert.match(errors, /git is not admitted by the contract executable allowlist/);
    assert.doesNotMatch(errors, /forbidden executable|package-runner wrappers|task-runner wrappers|blocklist/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validation requires an exact authorization-source manifest for every command", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-sources-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push({
      id: "fixture-check",
      argv: ["node", "scripts/check.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /authorizationSources/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validation requires the direct Node script in its authorization-source manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-entry-source-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push({
      id: "fixture-check",
      argv: ["node", "scripts/check.mjs"],
      authorizationSources: ["scripts/check-helper.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /direct Node script scripts\/check\.mjs must appear in authorizationSources/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validation requires every relative imported helper in the authorization-source manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-import-closure-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "check.mjs"), 'import "./check-helper.mjs";\n');
    writeFileSync(join(root, "scripts", "check-helper.mjs"), "export const ok = true;\n");
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push({
      id: "fixture-check",
      argv: ["node", "scripts/check.mjs"],
      authorizationSources: ["scripts/check.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), /undeclared local command dependency.*check-helper\.mjs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("command import closure handles comments and rejects mutable or lexically opaque loads", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-import-parser-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "check-helper.mjs"), "export const ok = true;\n");
    for (const [source, expected] of [
      ['import /* authorization bypass */ "./check-helper.mjs";\n', /undeclared local command dependency.*check-helper\.mjs/],
      ['import { parse } from "yaml";\nvoid parse;\n', /bare package import yaml is outside/],
      ['requ\\u0069re("./check-helper.mjs");\n', /escape outside a string or comment/],
      ['import { createRequire } from "node:module";\nvoid createRequire;\n', /built-in node:module has no admitted local-only command capability/],
    ] as const) {
      writeFileSync(join(root, "scripts", "check.mjs"), source);
      const contract = validContract(root) as Record<string, any>;
      contract.commands.push({
        id: "fixture-check",
        argv: ["node", "scripts/check.mjs"],
        authorizationSources: ["scripts/check.mjs"],
        cwd: "worktree",
        timeoutSeconds: 60,
        credentialRefs: [],
        sideEffect: "none",
        idempotence: "pure",
        parameters: {},
      });
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

      const result = runCli(["contract", "validate", "--project", root, "--json"]);

      assert.equal(result.status, 3, result.stderr || result.stdout);
      assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validation rejects unsafe authorization-source paths", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-source-path-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    for (const authorizationSource of ["/tmp/check.mjs", "scripts/../check.mjs", ".git/config", ".graph-shipper/project.yaml"]) {
      const contract = validContract(root) as Record<string, any>;
      contract.commands.push({
        id: "fixture-check",
        argv: ["node", "scripts/check.mjs"],
        authorizationSources: ["scripts/check.mjs", authorizationSource],
        cwd: "worktree",
        timeoutSeconds: 60,
        credentialRefs: [],
        sideEffect: "none",
        idempotence: "pure",
        parameters: {},
      });
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

      const result = runCli(["contract", "validate", "--project", root, "--json"]);

      assert.equal(result.status, 3, `${authorizationSource}: ${result.stderr || result.stdout}`);
      assert.match(
        (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
        /unsafe authorization source/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onboarding stays pending until a human activates the exact contract and evidence digests", () => {
  const fixture = createTrackedProject();
  try {
    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr);
    const candidate = JSON.parse(onboard.stdout) as Record<string, unknown>;
    assert.equal(candidate.status, "pending");
    assert.equal(candidate.projectId, "fixture-project");
    assert.match(String(candidate.contractDigest), /^[0-9a-f]{64}$/);
    assert.match(String(candidate.contractBlobSha), /^[0-9a-f]{40,64}$/);
    assert.match(String(candidate.admissionEvidenceDigest), /^[0-9a-f]{64}$/);

    const pending = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(pending.status, 0, pending.stderr);
    assert.deepEqual(JSON.parse(pending.stdout), {
      ok: true,
      projectId: "fixture-project",
      contractDigest: candidate.contractDigest,
      activation: "inactive",
      activationContractDigest: null,
      admissionEvidence: "inactive",
      current: false,
    });

    const mismatched = runCli([
      "contract", "activate",
      "--project", fixture.root,
      "--data-root", fixture.dataRoot,
      "--contract-digest", "0".repeat(64),
      "--admission-evidence-digest", String(candidate.admissionEvidenceDigest),
      "--confirm-project", "fixture-project",
      "--json",
    ]);
    assert.equal(mismatched.status, 4, mismatched.stderr);
    assert.match(String((JSON.parse(mismatched.stdout) as { error: string }).error), /approved digest/);

    const activate = runCli([
      "contract", "activate",
      "--project", fixture.root,
      "--data-root", fixture.dataRoot,
      "--contract-digest", String(candidate.contractDigest),
      "--admission-evidence-digest", String(candidate.admissionEvidenceDigest),
      "--confirm-project", "fixture-project",
      "--json",
    ]);
    assert.equal(activate.status, 0, activate.stderr);
    const activated = JSON.parse(activate.stdout) as Record<string, unknown>;
    assert.equal(activated.status, "active");
    assert.equal(activated.approvedBy, userInfo().username);

    appendFileSync(join(fixture.root, "README.md"), "\nNormal project work does not change onboarding.\n");
    git(fixture.root, ["add", "README.md"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "normal work"]);
    const afterNormalCommit = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(afterNormalCommit.status, 0, afterNormalCommit.stderr);
    assert.equal((JSON.parse(afterNormalCommit.stdout) as { activation: string }).activation, "active");

    git(fixture.root, ["remote", "set-url", "origin", "https://github.com/other/project.git"]);
    const evidenceDrift = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(evidenceDrift.status, 0, evidenceDrift.stderr);
    assert.equal((JSON.parse(evidenceDrift.stdout) as { activation: string }).activation, "stale");
    git(fixture.root, ["remote", "set-url", "origin", "https://github.com/fixture/project.git"]);

    appendFileSync(join(fixture.root, ".graph-shipper", "project.yaml"), "\n# policy changed\n");
    const stale = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(stale.status, 0, stale.stderr);
    const staleStatus = JSON.parse(stale.stdout) as Record<string, unknown>;
    assert.equal(staleStatus.activation, "stale");
    assert.equal(staleStatus.current, false);
    assert.notEqual(staleStatus.contractDigest, staleStatus.activationContractDigest);
    assert.equal(existsSync(join(fixture.root, ".graph-shipper", "state.sqlite")), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("onboarding binds repository and verification evidence to the declared default-branch base", () => {
  const fixture = createTrackedProject();
  try {
    const divergentBase = git(fixture.root, ["rev-parse", "main~1"]);
    git(fixture.root, ["switch", "-c", "divergent-admission", divergentBase]);
    writeFileSync(join(fixture.root, "feature-only.txt"), "feature evidence\n");
    git(fixture.root, ["add", "feature-only.txt"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "feature-only evidence"]);
    const featureEvidence = git(fixture.root, ["rev-parse", "HEAD"]);
    const contract = validContract(fixture.root, featureEvidence) as Record<string, any>;
    mkdirSync(join(fixture.root, ".graph-shipper"));
    writeFileSync(join(fixture.root, ".graph-shipper", "project.yaml"), stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "feature-only contract"]);

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.match((JSON.parse(result.stdout) as { error: string }).error, /default-branch base|declared default branch/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("onboarding rejects secret-bearing fields before runtime state exists and never echoes the value", () => {
  const fixture = createTrackedProject();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    appendFileSync(contractPath, "apiKey: do-not-persist-this-value\n");
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unsafe contract"]);
    rmSync(fixture.dataRoot, { recursive: true, force: true });

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr);
    const output = JSON.parse(result.stdout) as { details: string[] };
    assert.match(output.details.join("\n"), /secret-bearing field is forbidden: contract\.apiKey/);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-persist-this-value/);
    assert.equal(existsSync(fixture.dataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("onboarding rejects tracked Markdown omitted from the documentation catalog", () => {
  const fixture = createTrackedProject();
  try {
    writeFileSync(join(fixture.root, "STALE.md"), "# Undeclared documentation\n");
    git(fixture.root, ["add", "STALE.md"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "uncataloged docs"]);
    rmSync(fixture.dataRoot, { recursive: true, force: true });

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr);
    const output = JSON.parse(result.stdout) as { details: string[] };
    assert.match(output.details.join("\n"), /unclassified tracked Markdown: STALE\.md/);
    assert.equal(existsSync(fixture.dataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("documentation globstar rules classify Markdown directly beneath their directory", () => {
  const fixture = createTrackedProject();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.documentation.rules.push({
      id: "docs",
      glob: "docs/**/*.md",
      class: "living",
      topics: ["guides"],
      entryPoint: true,
      protected: false,
    });
    contract.documentation.requiredLivingEntryPoints.push("docs/guide.md");
    mkdirSync(join(fixture.root, "docs"));
    writeFileSync(join(fixture.root, "docs", "guide.md"), "# Guide\n");
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml", "docs/guide.md"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "catalog docs"]);

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("onboarding refuses to place mutable runtime state inside the target repository", () => {
  const fixture = createTrackedProject();
  const unsafeDataRoot = join(fixture.root, ".graph-shipper-runtime");
  try {
    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", unsafeDataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr);
    assert.match(String((JSON.parse(result.stdout) as { error: string }).error), /outside the target repository/);
    assert.equal(existsSync(unsafeDataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("onboarding refuses a canonical contract that is a symlink outside the repository", () => {
  const fixture = createTrackedProject();
  const externalRoot = mkdtempSync(join(tmpdir(), "graph-shipper-external-contract-"));
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const externalContract = join(externalRoot, "project.yaml");
    writeFileSync(externalContract, readFileSync(contractPath));
    rmSync(contractPath);
    symlinkSync(externalContract, contractPath);
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "symlink contract"]);
    rmSync(fixture.dataRoot, { recursive: true, force: true });

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr);
    assert.match(String((JSON.parse(result.stdout) as { error: string }).error), /regular file inside the repository/);
    assert.equal(existsSync(fixture.dataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("onboarding refuses a symlinked state database without touching its target", () => {
  const fixture = createTrackedProject();
  try {
    const protectedPath = join(fixture.root, "README.md");
    const before = readFileSync(protectedPath, "utf8");
    symlinkSync(protectedPath, join(fixture.dataRoot, "state.sqlite"));

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /state database must be a regular non-symlink file/);
    assert.equal(readFileSync(protectedPath, "utf8"), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("onboarding fails closed on an unknown contract schema major without creating runtime state", () => {
  const fixture = createTrackedProject();
  try {
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const source = readFileSync(contractPath, "utf8");
    writeFileSync(contractPath, source.replace('schemaVersion: 1.0.0', 'schemaVersion: 2.0.0'));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "unknown schema"]);
    rmSync(fixture.dataRoot, { recursive: true, force: true });

    const result = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr);
    const output = JSON.parse(result.stdout) as { ok: boolean; details: string[] };
    assert.equal(output.ok, false);
    assert.match(output.details.join("\n"), /schemaVersion/);
    assert.equal(existsSync(fixture.dataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("diagnostics is read-only and exposes the earned delivery capabilities", () => {
  const fixture = createTrackedProject();
  try {
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    const before = runCli(["diagnostics", "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(before.status, 0, before.stderr);
    assert.deepEqual(JSON.parse(before.stdout), {
      ok: true,
      version: "0.4.0",
      nodeVersion: process.version,
      dataRoot: fixture.dataRoot,
      state: { present: false, schemaVersion: null },
      security: {
        credentials: "opaque_references_only",
        authority: "typed_leases_only",
        persistenceRedaction: true,
      },
      capabilities: {
        plan: true,
        edit: true,
        push: true,
        pullRequest: true,
        merge: true,
        postMergeHooks: true,
      },
    });
    assert.equal(existsSync(fixture.dataRoot), false);

    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr);
    const after = runCli(["diagnostics", "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(after.status, 0, after.stderr);
    const output = JSON.parse(after.stdout) as { state: { present: boolean; schemaVersion: number } };
    assert.deepEqual(output.state, { present: true, schemaVersion: 5 });
    assert.equal(statSync(fixture.dataRoot).mode & 0o777, 0o700);
    assert.equal(statSync(join(fixture.dataRoot, "state.sqlite")).mode & 0o777, 0o600);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("status reports a valid but unonboarded project without creating runtime state", () => {
  const fixture = createTrackedProject();
  try {
    rmSync(fixture.dataRoot, { recursive: true, force: true });

    const result = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.activation, "inactive");
    assert.equal(output.current, false);
    assert.equal(existsSync(fixture.dataRoot), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("status reports an activation whose contract the validator now refuses, rather than throwing", () => {
  const fixture = createTrackedProject();
  try {
    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
    const candidate = JSON.parse(onboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const activate = runCli([
      "contract", "activate", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--contract-digest", candidate.contractDigest, "--admission-evidence-digest", candidate.admissionEvidenceDigest,
      "--confirm-project", "fixture-project", "--json",
    ]);
    assert.equal(activate.status, 0, activate.stderr || activate.stdout);

    git(fixture.root, ["rm", "-q", "scripts/fixture-verify.mjs"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "drop the gate script"]);

    const result = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 3, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.equal(output.error, "Project Contract validation failed");
    assert.match(output.details.join("\n"), /fixture-verify: authorization source scripts\/fixture-verify\.mjs is not a regular file/);
    assert.equal(output.activationContractDigest, candidate.contractDigest);
    assert.equal(output.activation, "stale");
    assert.equal(output.current, false);

    const plain = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot]);
    assert.equal(plain.status, 3, plain.stdout);
    assert.match(plain.stderr, /Project Contract validation failed/);
    assert.match(plain.stderr, /fixture-verify: authorization source/);
    const plainOutput = JSON.parse(plain.stdout) as Record<string, any>;
    assert.equal(plainOutput.ok, false);
    assert.equal(plainOutput.error, "Project Contract validation failed");
    assert.match(plainOutput.details.join("\n"), /fixture-verify: authorization source/);
    assert.equal(plainOutput.activation, "stale");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

const withAllowlist = (root: string) => {
  const contract = validContract(root) as Record<string, any>;
  writeFileSync(join(root, "package.json"), "{}\n");
  contract.executableAllowlist = [
    { id: "npm-test", argvPrefix: ["npm", "run", "test"], citation: "T-028 fixture: earned suite" },
    { id: "npm-install", argvPrefix: ["npm", "install"], citation: "T-028 fixture: dependency install" },
  ];
  return contract;
};

test("an admitted executable prefix accepts a non-node command", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-ok-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = withAllowlist(root);
    contract.commands.push({
      id: "earned-suite", argv: ["npm", "run", "test"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 600, credentialRefs: [], sideEffect: "none",
      idempotence: "pure", parameters: {},
    });
    contract.verification.checks[0].executor = { kind: "command", commandRef: "earned-suite" };
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);
    const output = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(output.ok, true, JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an executable outside the allowlist is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-miss-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = withAllowlist(root);
    contract.commands.push({
      id: "unadmitted", argv: ["gh", "pr", "merge"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none",
      idempotence: "probe", parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("unadmitted") && error.includes("allowlist")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a subcommand outside its admitted prefix is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-subcommand-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = withAllowlist(root);
    contract.commands.push({
      id: "wrong-script", argv: ["npm", "run", "deploy"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none",
      idempotence: "pure", parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("wrong-script") && error.includes("allowlist")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wrapper or interpreter-eval form stays refused even when allowlisted", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-wrapper-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.executableAllowlist = [
      { id: "wrapper", argvPrefix: ["env", "bash", "-c"], citation: "T-028 fixture: must be refused" },
    ];
    contract.commands.push({
      id: "wrapped", argv: ["env", "bash", "-c", "npm test"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none",
      idempotence: "pure", parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("wrapper")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the activated command registry admits the same allowlist the validator does", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-registry-allowlist-"));
  try {
    const { ActivatedCommandRegistry } = await import("../src/actions/commands.js");
    const { ProjectContractSchema } = await import("../src/contracts/schema.js");
    const contract = withAllowlist(root);
    contract.commands.push({
      id: "earned-suite", argv: ["npm", "run", "test"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 600, credentialRefs: [], sideEffect: "none",
      idempotence: "pure", parameters: {},
    });
    const parsed = ProjectContractSchema.parse(contract);

    assert.doesNotThrow(() => new ActivatedCommandRegistry(parsed));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the registry refuses a command whose executable the allowlist never admitted", async () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-registry-refusal-"));
  try {
    const { ActivatedCommandRegistry } = await import("../src/actions/commands.js");
    const { ProjectContractSchema } = await import("../src/contracts/schema.js");
    const contract = withAllowlist(root);
    contract.commands.push({
      id: "unadmitted", argv: ["gh", "pr", "merge"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none",
      idempotence: "pure", parameters: {},
    });
    const parsed = ProjectContractSchema.parse(contract);

    assert.throws(() => new ActivatedCommandRegistry(parsed), /allowlist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an admitted executable cannot be turned into an eval invocation by its own argv", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-eval-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.executableAllowlist = [
      { id: "python", argvPrefix: ["python3"], citation: "T-028 fixture: admitted interpreter" },
    ];
    contract.commands.push({
      id: "smuggled-eval", argv: ["python3", "-c", "import os"], authorizationSources: ["package.json"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none",
      idempotence: "pure", parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("eval")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a wrapper cannot be admitted through case or extension", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-basename-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.executableAllowlist = [
      { id: "disguised", argvPrefix: ["/usr/bin/BASH.exe"], citation: "T-028 fixture: must be refused" },
    ];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("wrapper")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a placeholder inside an admitted prefix is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-placeholder-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.executableAllowlist = [
      { id: "loose", argvPrefix: ["npm", "run", "{script}"], citation: "T-028 fixture: must be refused" },
    ];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("literal")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate allowlist ids are refused like every other id-bearing collection", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-allowlist-duplicate-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.executableAllowlist = [
      { id: "npm-test", argvPrefix: ["npm", "test"], citation: "first" },
      { id: "npm-test", argvPrefix: ["npm", "run", "test"], citation: "second" },
    ];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const output = JSON.parse(runCli(["contract", "validate", "--project", root, "--json"]).stdout) as Record<string, any>;
    assert.equal(output.ok, false);
    assert.ok(output.errors.some((error: string) => error.includes("duplicate executable id")), JSON.stringify(output.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a command environment passlist admits only ordinary, non-credential variable names", () => {
  const cases: Array<{ passlist: string[]; expected: RegExp | null }> = [
    { passlist: ["NPM_CONFIG_REGISTRY"], expected: null },
    { passlist: ["CI"], expected: null },
    { passlist: ["HTTPS_PROXY"], expected: null },
    { passlist: ["no_proxy"], expected: null },
    { passlist: ["TZ", "LANG"], expected: null },
    { passlist: ["NPM_TOKEN"], expected: /not admissible/ },
    { passlist: ["AWS_SECRET_ACCESS_KEY"], expected: /not admissible/ },
    { passlist: ["GH_PAT"], expected: /not admissible/ },
    { passlist: ["GITHUB_PAT"], expected: /not admissible/ },
    { passlist: ["GPG_PASSPHRASE"], expected: /not admissible/ },
    { passlist: ["CI_JOB_JWT"], expected: /not admissible/ },
    { passlist: ["GRAPH_SHIPPER_CREDENTIAL_DEPLOY_TOKEN"], expected: /not admissible/ },
    { passlist: ["NPM_CONFIG_USERCONFIG"], expected: /not admissible/ },
    { passlist: ["DOCKER_CONFIG"], expected: /not admissible/ },
    { passlist: ["KUBECONFIG"], expected: /not admissible/ },
    { passlist: ["DATABASE_URL"], expected: /not admissible/ },
    { passlist: ["AWS_SHARED_CREDENTIALS_FILE"], expected: /not admissible/ },
    { passlist: ["NODE_OPTIONS"], expected: /not admissible/ },
    { passlist: ["NODE_EXTRA_CA_CERTS"], expected: /not admissible/ },
    { passlist: ["LD_PRELOAD"], expected: /not admissible/ },
    { passlist: ["DYLD_INSERT_LIBRARIES"], expected: /not admissible/ },
    { passlist: ["HOME"], expected: /runtime-owned/ },
    { passlist: ["PATH"], expected: /runtime-owned/ },
    { passlist: ["TMPDIR"], expected: /runtime-owned/ },
    { passlist: ["home"], expected: /runtime-owned/ },
    { passlist: ["Path"], expected: /runtime-owned/ },
    { passlist: ["UserProfile"], expected: /runtime-owned/ },
    { passlist: ["npm-config"], expected: /not a portable environment variable name/ },
  ];
  for (const { passlist, expected } of cases) {
    const root = mkdtempSync(join(tmpdir(), "graph-shipper-passlist-"));
    try {
      mkdirSync(join(root, ".graph-shipper"));
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts", "probe.mjs"), "process.exit(0);\n");
      const contract = validContract(root) as Record<string, any>;
      contract.commands.push({
        id: "gate", argv: ["node", "scripts/probe.mjs"], authorizationSources: ["scripts/probe.mjs"],
        cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "none", idempotence: "pure",
        parameters: {}, environmentPasslist: passlist,
      });
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

      const result = runCli(["contract", "validate", "--project", root, "--json"]);
      const output = JSON.parse(result.stdout) as { ok: boolean; errors?: string[] };

      if (expected === null) {
        assert.equal(result.status, 0, `${passlist.join(",")} was rejected: ${result.stdout}`);
        assert.equal(output.ok, true);
      } else {
        assert.equal(result.status, 3, `${passlist.join(",")} was admitted: ${result.stdout}`);
        assert.match((output.errors ?? []).join("\n"), expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("workspace preparation commands bind dependency inputs and remain credential-free idempotent workspace mutations", () => {
  const cases: Array<{ label: string; mutate: (command: Record<string, any>, root: string) => void; expected: RegExp }> = [
    { label: "impure cwd", mutate: (command) => { command.cwd = "project_root"; }, expected: /install-dependencies: workspace preparation command must be credential-free, idempotent/ },
    { label: "wrong side effect", mutate: (command) => { command.sideEffect = "none"; }, expected: /declare the workspace side effect/ },
    { label: "non-idempotent", mutate: (command) => { command.idempotence = "non_idempotent"; }, expected: /must be credential-free, idempotent/ },
    { label: "credentialed", mutate: (command) => { command.credentialRefs = ["anthropic-default"]; }, expected: /must be credential-free/ },
    { label: "parameterized", mutate: (command) => { command.argv.push("{run_id}"); command.parameters = { run_id: { type: "opaque_id" } }; }, expected: /workspace preparation commands take no parameters/ },
    { label: "missing dependency sources", mutate: (command) => { delete command.dependencySources; }, expected: /must declare dependency manifest and lockfile sources/ },
    { label: "undeclared dependency manifest", mutate: (command) => { command.authorizationSources = command.authorizationSources.filter((source: string) => source !== "package.json"); }, expected: /dependency manifest package\.json must appear in authorizationSources/ },
    { label: "undeclared dependency lockfile", mutate: (command) => { command.authorizationSources = command.authorizationSources.filter((source: string) => source !== "package-lock.json"); }, expected: /dependency lockfile package-lock\.json must appear in authorizationSources/ },
    { label: "missing dependency lockfile", mutate: (_command, root) => { rmSync(join(root, "package-lock.json")); }, expected: /dependency lockfile package-lock\.json must be a regular file/ },
    { label: "same manifest and lockfile", mutate: (command) => { command.dependencySources.lockfile = "package.json"; }, expected: /dependency manifest and lockfile must name different files/ },
  ];
  for (const { label, mutate, expected } of cases) {
    const root = mkdtempSync(join(tmpdir(), "graph-shipper-prepare-"));
    try {
      mkdirSync(join(root, ".graph-shipper"));
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "scripts", "install.mjs"), "process.exit(0);\n");
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "package-lock.json"), "{}\n");
      const contract = validContract(root) as Record<string, any>;
      const command: Record<string, any> = {
        id: "install-dependencies", argv: ["node", "scripts/install.mjs"],
        authorizationSources: ["scripts/install.mjs", "package.json", "package-lock.json"],
        dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
        cwd: "worktree", timeoutSeconds: 600, credentialRefs: [], sideEffect: "workspace",
        idempotence: "idempotent", parameters: {},
      };
      contract.commands.push(command);
      contract.workspace.preparationCommandRefs = ["install-dependencies"];
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

      const accepted = runCli(["contract", "validate", "--project", root, "--json"]);
      assert.equal(accepted.status, 0, `well-formed preparation command was rejected: ${accepted.stdout}`);

      mutate(command, root);
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));
      const refused = runCli(["contract", "validate", "--project", root, "--json"]);

      assert.equal(refused.status, 3, `${label} was admitted: ${refused.stdout}`);
      assert.match((JSON.parse(refused.stdout) as { errors: string[] }).errors.join("\n"), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("workspace preparation refuses a missing or duplicated command reference", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-prepare-refs-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "install.mjs"), "process.exit(0);\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push({
      id: "install-dependencies", argv: ["node", "scripts/install.mjs"],
      authorizationSources: ["scripts/install.mjs", "package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree", timeoutSeconds: 600, credentialRefs: [], sideEffect: "workspace",
      idempotence: "idempotent", parameters: {},
    });
    contract.workspace.preparationCommandRefs = ["install-dependencies", "install-dependencies", "install-workspace-packages"];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    const errors = (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n");
    assert.match(errors, /install-dependencies: duplicate workspace preparation command/);
    assert.match(errors, /install-workspace-packages: workspace preparation command is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dependency sources belong only to declared workspace preparation commands", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-dependency-sources-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "verify.mjs"), "process.exit(0);\n");
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const contract = validContract(root) as Record<string, any>;
    contract.commands.push({
      id: "verify-dependencies",
      argv: ["node", "scripts/verify.mjs"],
      authorizationSources: ["scripts/verify.mjs", "package.json", "package-lock.json"],
      dependencySources: { manifest: "package.json", lockfile: "package-lock.json" },
      cwd: "worktree",
      timeoutSeconds: 30,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /verify-dependencies: dependencySources are reserved for workspace preparation commands/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses an approval policy under which no Work Run could write a file", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-unwritable-policy-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules = [];
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    const output = JSON.parse(result.stdout) as { ok: boolean; errors: string[] };
    assert.equal(output.ok, false);
    assert.match(output.errors.join("\n"), /approval policy pre-approves no write_file action, so no Work Run could write a file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses a primary-clone path that does not name this project", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-clone-path-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.repository.primaryCloneRealpath = "/absolute/path/to/project";
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), /repository\.primaryCloneRealpath \/absolute\/path\/to\/project does not name this project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses an approval policy that provably cannot authorize a write", () => {
  const cases: Array<[string, Array<Record<string, unknown>>, RegExp]> = [
    ["empty path globs", [
      { id: "edits", effect: "pre_approved", actionKinds: ["write_file"], pathGlobs: [], citation: "c" },
    ], /approval policy pre-approves no write_file action, so no Work Run could write a file/],
    ["blanket forbidden", [
      { id: "edits", effect: "pre_approved", actionKinds: ["write_file"], pathGlobs: ["src/**"], citation: "c" },
      { id: "lockdown", effect: "forbidden", actionKinds: ["*"], citation: "freeze" },
    ], /lockdown: forbids write_file on every path, so no Work Run could write a file/],
    ["blanket forbidden by compiled glob", [
      { id: "edits", effect: "pre_approved", actionKinds: ["write_file"], pathGlobs: ["src/**"], citation: "c" },
      { id: "lockdown", effect: "forbidden", actionKinds: ["write_file"], pathGlobs: ["**/*"], citation: "freeze" },
    ], /lockdown: forbids write_file on every path, so no Work Run could write a file/],
  ];
  for (const [label, rules, expected] of cases) {
    const root = mkdtempSync(join(tmpdir(), "graph-shipper-unwritable-"));
    try {
      mkdirSync(join(root, ".graph-shipper"));
      const contract = validContract(root) as Record<string, any>;
      contract.approvalPolicy.rules = rules;
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

      const result = runCli(["contract", "validate", "--project", root, "--json"]);

      assert.equal(result.status, 3, `${label}: ${result.stdout}`);
      assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), expected, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("contract validate accepts an inert write rule beside an effective grant", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-inert-policy-rule-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules.push({
      id: "reserved-edit-scope",
      effect: "pre_approved",
      actionKinds: ["write_file"],
      pathGlobs: [],
      citation: "reserved until the project names a path",
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 0, result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate does not mistake a directory-only glob for a blanket prohibition", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-directory-glob-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules.push({
      id: "directory-lockdown",
      effect: "forbidden",
      actionKinds: ["write_file"],
      pathGlobs: ["**/"],
      citation: "directory-only pattern",
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 0, result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses an authorization source git ignores, since the committed base cannot carry it", () => {
  const fixture = createTrackedProject();
  try {
    writeFileSync(join(fixture.root, ".gitignore"), "scripts/ignored.mjs\n");
    writeFileSync(join(fixture.root, "scripts", "ignored.mjs"), "process.exit(0);\n");
    git(fixture.root, ["add", ".gitignore"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "ignore a script"]);
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      id: "ignored-gate", argv: ["node", "scripts/ignored.mjs"], authorizationSources: ["scripts/ignored.mjs"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none", idempotence: "pure", parameters: {},
    });
    writeFileSync(contractPath, stringify(contract));

    const result = runCli(["contract", "validate", "--project", fixture.root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), /ignored-gate: authorization source scripts\/ignored\.mjs is ignored by git/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("contract validate refuses an authorization source owned by a nested repository", () => {
  const fixture = createTrackedProject();
  try {
    const nested = join(fixture.root, "nested");
    mkdirSync(nested);
    git(nested, ["init", "-b", "main"]);
    writeFileSync(join(nested, "verify.mjs"), "process.exit(0);\n");
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      id: "nested-gate",
      argv: ["node", "nested/verify.mjs"],
      authorizationSources: ["nested/verify.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(contractPath, stringify(contract));

    const result = runCli(["contract", "validate", "--project", fixture.root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /nested-gate: authorization source nested\/verify\.mjs belongs to a nested Git repository/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("contract validate reports that Git is unavailable instead of accepting every source", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-missing-git-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(validContract(root)));

    const result = runCli(["contract", "validate", "--project", root, "--json"], { PATH: "" });

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /fixture-verify: Git is unavailable, so authorization source commit eligibility cannot be checked/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses authorization sources outside a Git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-no-repository-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root);
    rmSync(join(root, ".git"), { recursive: true, force: true });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /fixture-verify: Git could not inspect the project repository while checking authorization sources/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate ignores operator-global excludes when checking source eligibility", () => {
  const fixture = createTrackedProject();
  const operatorRoot = mkdtempSync(join(tmpdir(), "graph-shipper-operator-git-"));
  try {
    const globalExcludes = join(operatorRoot, "global-excludes");
    const globalConfig = join(operatorRoot, "gitconfig");
    writeFileSync(globalExcludes, "scripts/global-only.mjs\n");
    writeFileSync(globalConfig, `[core]\n\texcludesFile = ${globalExcludes}\n`);
    writeFileSync(join(fixture.root, "scripts", "global-only.mjs"), "process.exit(0);\n");
    const contractPath = join(fixture.root, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.commands.push({
      id: "global-only-gate",
      argv: ["node", "scripts/global-only.mjs"],
      authorizationSources: ["scripts/global-only.mjs"],
      cwd: "worktree",
      timeoutSeconds: 60,
      credentialRefs: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    writeFileSync(contractPath, stringify(contract));
    git(fixture.root, ["add", ".graph-shipper/project.yaml"]);
    git(fixture.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "declare global-only source"]);

    const result = runCli(
      ["contract", "validate", "--project", fixture.root, "--json"],
      { HOME: operatorRoot, GIT_CONFIG_GLOBAL: globalConfig },
    );

    assert.equal(result.status, 0, result.stdout);
    const onboard = runCli(
      ["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"],
      { HOME: operatorRoot, GIT_CONFIG_GLOBAL: globalConfig },
    );
    assert.equal(onboard.status, 3, onboard.stdout);
    assert.match(onboard.stdout, /scripts\/global-only\.mjs/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    rmSync(operatorRoot, { recursive: true, force: true });
  }
});

test("contract validate refuses an authorization source reached through a symlink out of the project", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-symlinked-dir-"));
  const outside = mkdtempSync(join(tmpdir(), "graph-shipper-outside-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    rmSync(join(root, "scripts"), { recursive: true, force: true });
    writeFileSync(join(outside, "fixture-verify.mjs"), "process.exit(0);\n");
    symlinkSync(outside, join(root, "scripts"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), /fixture-verify: authorization source scripts\/fixture-verify\.mjs is not a regular file in the project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("contract validate refuses an authorization source reached through any symlinked parent", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-symlinked-parent-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    const realScripts = join(root, "real-scripts");
    renameSync(join(root, "scripts"), realScripts);
    symlinkSync(realScripts, join(root, "scripts"));
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /fixture-verify: authorization source scripts\/fixture-verify\.mjs is not a regular file in the project/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses a consequential policy effect no run can honour", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-consequential-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules.push({ id: "ask-first", effect: "consequential", actionKinds: ["write_file"], pathGlobs: ["docs/**"], citation: "c" });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), /ask-first: effect consequential is not executable; declare pre_approved, read_only, or forbidden/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses read_only for an action that cannot consume it", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-read-only-write-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules.push({
      id: "read-only-edit",
      effect: "read_only",
      actionKinds: ["write_file"],
      pathGlobs: ["docs/**"],
      citation: "read-only documentation",
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /read-only-edit: effect read_only can authorize only run_command actions/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate accepts read_only wildcard authority for observation commands", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-read-only-wildcard-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules.push({
      id: "all-observations",
      effect: "read_only",
      actionKinds: ["*"],
      citation: "all activated observations",
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 0, result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("contract validate refuses policy fields with no runtime consumer", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["unknown action", {
      id: "unknown-action",
      effect: "forbidden",
      actionKinds: ["delete_file"],
      citation: "unsupported action",
    }, /unknown-action: unsupported action kind delete_file/],
    ["unknown command", {
      id: "unknown-command",
      effect: "read_only",
      actionKinds: ["run_command:missing-command"],
      citation: "missing observation",
    }, /unknown-command: unsupported action kind run_command:missing-command/],
    ["command path constraint", {
      id: "command-path",
      effect: "read_only",
      actionKinds: ["run_command:fixture-verify"],
      pathGlobs: ["src/**"],
      citation: "unused command path",
    }, /command-path: pathGlobs are enforced only for write_file actions/],
  ];
  for (const [label, rule, expected] of cases) {
    const root = mkdtempSync(join(tmpdir(), "graph-shipper-dead-policy-field-"));
    try {
      mkdirSync(join(root, ".graph-shipper"));
      const contract = validContract(root) as Record<string, any>;
      contract.approvalPolicy.rules.push(rule);
      writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

      const result = runCli(["contract", "validate", "--project", root, "--json"]);

      assert.equal(result.status, 3, `${label}: ${result.stdout}`);
      assert.match((JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"), expected, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("contract validate refuses a policy argv prefix that no action authorization reads", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-policy-argv-"));
  try {
    mkdirSync(join(root, ".graph-shipper"));
    const contract = validContract(root) as Record<string, any>;
    contract.approvalPolicy.rules.push({
      id: "narrow-observation",
      effect: "read_only",
      actionKinds: ["run_command:fixture-verify"],
      argvPrefix: ["node", "scripts/fixture-verify.mjs"],
      citation: "exact observation command",
    });
    writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(contract));

    const result = runCli(["contract", "validate", "--project", root, "--json"]);

    assert.equal(result.status, 3, result.stdout);
    assert.match(
      (JSON.parse(result.stdout) as { errors: string[] }).errors.join("\n"),
      /narrow-observation: argvPrefix is not enforced; select an exact run_command action kind instead/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the template's commented approval rule uncomments into the policy it describes", () => {
  const template = readFileSync(join(repositoryRoot, "examples", "project-contract.template.yaml"), "utf8");
  const uncommented = template.split("\n")
    .filter((line) => line !== "  rules: []")
    .map((line) => line.replace(/^  # (?=rules:|  - id: |    (?:effect|actionKinds|pathGlobs|citation): )/, "  "))
    .join("\n");

  const contract = parse(uncommented) as Record<string, any>;

  assert.equal(contract.metadata.projectId, "replace-me");
  assert.equal(contract.approvalPolicy.rules.length, 1);
  assert.equal(contract.approvalPolicy.rules[0].effect, "pre_approved");
  assert.deepEqual(contract.approvalPolicy.rules[0].actionKinds, ["write_file"]);
});

test("status does not report a project's activation to a directory that merely names it", () => {
  const fixture = createTrackedProject();
  const stray = mkdtempSync(join(tmpdir(), "graph-shipper-stray-"));
  try {
    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
    const candidate = JSON.parse(onboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const activate = runCli([
      "contract", "activate", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--contract-digest", candidate.contractDigest, "--admission-evidence-digest", candidate.admissionEvidenceDigest,
      "--confirm-project", "fixture-project", "--json",
    ]);
    assert.equal(activate.status, 0, activate.stderr || activate.stdout);
    mkdirSync(join(stray, ".graph-shipper"));

    writeFileSync(join(stray, ".graph-shipper", "project.yaml"), "metadata:\n  projectId: fixture-project\n");
    const bare = runCli(["status", "--project", stray, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(bare.status, 3, bare.stdout);
    const bareOutput = JSON.parse(bare.stdout) as Record<string, unknown>;
    assert.equal(bareOutput.ok, false);
    assert.equal("activation" in bareOutput, false, bare.stdout);
    assert.equal("activationContractDigest" in bareOutput, false, bare.stdout);

    writeFileSync(join(stray, ".graph-shipper", "project.yaml"), readFileSync(join(fixture.root, ".graph-shipper", "project.yaml")));
    const copied = runCli(["status", "--project", stray, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(copied.status, 3, copied.stdout);
    const copiedOutput = JSON.parse(copied.stdout) as Record<string, unknown>;
    assert.equal("activation" in copiedOutput, false, copied.stdout);

    const reboundContract = parse(readFileSync(join(stray, ".graph-shipper", "project.yaml"), "utf8")) as Record<string, any>;
    reboundContract.repository.primaryCloneRealpath = stray;
    writeFileSync(join(stray, ".graph-shipper", "project.yaml"), stringify(reboundContract));
    const rebound = runCli(["status", "--project", stray, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(rebound.status, 3, rebound.stdout);
    const reboundOutput = JSON.parse(rebound.stdout) as Record<string, unknown>;
    assert.equal(reboundOutput.activation, "inactive");
    assert.equal(reboundOutput.activationContractDigest, null);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
    rmSync(stray, { recursive: true, force: true });
  }
});

test("status keeps a moved clone inactive after re-onboarding instead of moving its old activation", () => {
  const fixture = createTrackedProject();
  const movedParent = mkdtempSync(join(tmpdir(), "graph-shipper-moved-clone-"));
  const movedRoot = join(movedParent, "project");
  try {
    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
    const candidate = JSON.parse(onboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const activate = runCli([
      "contract", "activate", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--contract-digest", candidate.contractDigest, "--admission-evidence-digest", candidate.admissionEvidenceDigest,
      "--confirm-project", "fixture-project", "--json",
    ]);
    assert.equal(activate.status, 0, activate.stderr || activate.stdout);

    renameSync(fixture.root, movedRoot);
    const contractPath = join(movedRoot, ".graph-shipper", "project.yaml");
    const contract = parse(readFileSync(contractPath, "utf8")) as Record<string, any>;
    contract.repository.primaryCloneRealpath = movedRoot;
    writeFileSync(contractPath, stringify(contract));
    git(movedRoot, ["add", ".graph-shipper/project.yaml"]);
    git(movedRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "record moved clone"]);

    const result = runCli(["status", "--project", movedRoot, "--data-root", fixture.dataRoot, "--json"]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.activation, "inactive");
    assert.equal(output.activationContractDigest, null);
    assert.equal(output.current, false);

    const movedOnboard = runCli(["contract", "onboard", "--project", movedRoot, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(movedOnboard.status, 0, movedOnboard.stderr || movedOnboard.stdout);
    const afterOnboard = runCli(["status", "--project", movedRoot, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(afterOnboard.status, 0, afterOnboard.stderr || afterOnboard.stdout);
    const afterOnboardOutput = JSON.parse(afterOnboard.stdout) as Record<string, unknown>;
    assert.equal(afterOnboardOutput.activation, "inactive");
    assert.equal(afterOnboardOutput.activationContractDigest, null);

    const movedCandidate = JSON.parse(movedOnboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const movedActivate = runCli([
      "contract", "activate", "--project", movedRoot, "--data-root", fixture.dataRoot,
      "--contract-digest", movedCandidate.contractDigest, "--admission-evidence-digest", movedCandidate.admissionEvidenceDigest,
      "--confirm-project", "fixture-project", "--json",
    ]);
    assert.equal(movedActivate.status, 0, movedActivate.stderr || movedActivate.stdout);
    const afterActivation = runCli(["status", "--project", movedRoot, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(afterActivation.status, 0, afterActivation.stderr || afterActivation.stdout);
    assert.equal((JSON.parse(afterActivation.stdout) as Record<string, unknown>).activation, "active");
  } finally {
    rmSync(movedParent, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("legacy activations stay inactive until migration and explicit reactivation bind a root", () => {
  const fixture = createTrackedProject();
  try {
    const onboard = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(onboard.status, 0, onboard.stderr || onboard.stdout);
    const candidate = JSON.parse(onboard.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const activate = runCli([
      "contract", "activate", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--contract-digest", candidate.contractDigest, "--admission-evidence-digest", candidate.admissionEvidenceDigest,
      "--confirm-project", "fixture-project", "--json",
    ]);
    assert.equal(activate.status, 0, activate.stderr || activate.stdout);

    const databasePath = join(fixture.dataRoot, "state.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TRIGGER active_activation_requires_root_insert;
      DROP TRIGGER active_activation_requires_root_update;
      ALTER TABLE contract_activations DROP COLUMN project_root;
      DELETE FROM schema_migrations WHERE version = 5;
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const beforeMigration = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(beforeMigration.status, 0, beforeMigration.stderr || beforeMigration.stdout);
    assert.equal((JSON.parse(beforeMigration.stdout) as Record<string, unknown>).activation, "inactive");
    const legacyRead = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((legacyRead.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
    legacyRead.close();

    const migrate = runCli(["contract", "onboard", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
    const migratedActivation = migrated.prepare("SELECT status, project_root FROM contract_activations WHERE project_id = ?")
      .get("fixture-project") as { status: string; project_root: string | null };
    assert.equal(migratedActivation.status, "revoked");
    assert.equal(migratedActivation.project_root, null);
    migrated.close();

    const migratedCandidate = JSON.parse(migrate.stdout) as { contractDigest: string; admissionEvidenceDigest: string };
    const reactivate = runCli([
      "contract", "activate", "--project", fixture.root, "--data-root", fixture.dataRoot,
      "--contract-digest", migratedCandidate.contractDigest,
      "--admission-evidence-digest", migratedCandidate.admissionEvidenceDigest,
      "--confirm-project", "fixture-project", "--json",
    ]);
    assert.equal(reactivate.status, 0, reactivate.stderr || reactivate.stdout);
    const afterReactivation = runCli(["status", "--project", fixture.root, "--data-root", fixture.dataRoot, "--json"]);
    assert.equal(afterReactivation.status, 0, afterReactivation.stderr || afterReactivation.stdout);
    assert.equal((JSON.parse(afterReactivation.stdout) as Record<string, unknown>).activation, "active");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});
