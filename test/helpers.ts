import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export function writeFixtureCommandSources(projectRoot: string): void {
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });
  writeFileSync(join(projectRoot, "scripts", "fixture-verify.mjs"), "process.exit(0);\n");
}

export function validContract(projectRoot: string, observedHeadSha = "a".repeat(40)): Record<string, unknown> {
  if (!existsSync(join(projectRoot, ".git"))) git(projectRoot, ["init", "-b", "main"]);
  writeFixtureCommandSources(projectRoot);
  return {
    metadata: { schemaVersion: "1.0.0", projectId: "fixture-project", displayName: "Fixture Project", canonicalPath: ".graph-shipper/project.yaml" },
    repository: {
      github: "fixture/project",
      defaultBranch: "main",
      primaryCloneRealpath: projectRoot,
      repoFacts: {
        observedAt: "2026-08-13T00:00:00Z",
        observedHeadSha,
        evidenceRef: "fixture evidence",
        revalidateBefore: ["binding_admission", "work_run", "merge", "post_merge"],
      },
    },
    credentials: { references: [
      { id: "anthropic-default", purpose: "anthropic_model" },
      { id: "openai-default", purpose: "openai_model" },
    ] },
    commands: [{
      id: "fixture-verify", argv: ["node", "scripts/fixture-verify.mjs"], authorizationSources: ["scripts/fixture-verify.mjs"],
      cwd: "worktree", timeoutSeconds: 60, credentialRefs: [], sideEffect: "none", idempotence: "pure", parameters: {},
      environmentPasslist: [],
    }],
    models: {
      buildAssignments: [{ id: "anthropic-build", provider: "anthropic", modelRef: "configured-build", credentialRef: "anthropic-default" }],
      reviewAssignments: [{ id: "openai-review", provider: "openai", modelRef: "configured-review", credentialRef: "openai-default" }],
      requireOppositeProvider: true,
      repositoryContext: { includeGlobs: ["README.md", "src/**"], excludeGlobs: [] },
    },
    workSources: {
      allowedKinds: ["github_issue"], namedIssueQueries: [], maximumItemsPerQueueRun: 10,
      requireRevisionPin: true, requireAcceptanceCriteria: true,
    },
    workspace: { strategy: "managed_git_worktree", rootTemplate: "<repo-parent>/fixture-worktrees/<run-id>", retainOnFailure: true },
    autonomy: { maximum: "local_only", default: "local_only", forbidBranchProtectionBypass: true, allowStatusComments: false },
    approvalPolicy: {
      defaultEffect: "forbidden", noForbiddenOverride: true,
      rules: [{ id: "fixture-workspace-edits", effect: "pre_approved", actionKinds: ["write_file"], pathGlobs: ["src/**", "README.md"], citation: "fixture edit policy" }],
    },
    verification: {
      failFast: true,
      scrubGitLocalEnvironment: true,
      checks: [{
        id: "fixture-test", cadence: "every_cycle", triggerGlobs: ["**"],
        executor: { kind: "command", commandRef: "fixture-verify" }, failureClass: "planner_feedback",
        earnedEvidence: { observedAt: "2026-08-13", againstHeadSha: observedHeadSha, citation: "fixture evidence" },
      }],
    },
    github: {
      pullRequest: { draft: false, baseBranch: "main" }, requiredHostedChecks: [],
      trustedFeedback: { reviewerActors: [], githubApps: [], requiredCheckProducers: [] },
      requireBranchProtection: true, mergeMethod: "squash",
    },
    delivery: { strategy: "github_direct", terminalPredicate: "merged_and_reconciled" },
    concurrency: { defaultWorkRuns: 1, maximumWorkRuns: 1, serializeMergePerProject: true, serializePostMergePerProject: true },
    documentation: {
      rules: [{ id: "readme", glob: "README.md", class: "living", topics: ["overview"], entryPoint: true, protected: false }],
      requiredLivingEntryPoints: ["README.md"],
      triggerMatrix: [{ pathGlobs: ["**"], impacts: ["release_record"], topics: ["overview"] }],
      releaseRecord: { kind: "none" }, allowReviewedNoChangeAttestation: true, blockBroadRewriteWithoutWorkItemAuthority: true,
    },
    postMergeHooks: [],
    compensatingHooks: [],
    cleanup: {
      onLocalOnlyHandoff: "preserve_owned_branch_and_worktree",
      removeOwnedWorktreeAfterDeliveryTerminalSuccess: true,
      removeOwnedBranchAfterDeliveryTerminalSuccess: true,
      preserveDiagnosticsOnFailure: true,
      neverTouchUnownedPaths: true,
    },
    budgets: { maximumIterations: 6, wallClockMinutes: 60, malformedModelOutputRetries: 1 },
  };
}

export function runCli(args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...environment },
  });
}

export function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function createTrackedProject(): { root: string; dataRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-project-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "graph-shipper-data-"));
  mkdirSync(join(root, ".graph-shipper"));
  writeFileSync(join(root, "README.md"), "# Fixture Project\n");
  git(root, ["init", "-b", "main"]);
  git(root, ["remote", "add", "origin", "https://github.com/fixture/project.git"]);
  writeFixtureCommandSources(root);
  git(root, ["add", "README.md", "scripts/fixture-verify.mjs"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture base"]);
  const observedHeadSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, ".graph-shipper", "project.yaml"), stringify(validContract(root, observedHeadSha)));
  git(root, ["add", ".graph-shipper/project.yaml"]);
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add project contract"]);
  return { root, dataRoot };
}

export function assertOpenAiSchemaSubset(schema: unknown, path = "root"): void {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => assertOpenAiSchemaSubset(item, `${path}[${index}]`));
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  for (const keyword of ["oneOf", "propertyNames", "default", "minItems", "maxItems"]) {
    assert.equal(record[keyword], undefined, `${path}: ${keyword} is outside the subset`);
  }
  assert.notEqual(typeof record.additionalProperties, "object", `${path}: a free-form map is outside the subset`);
  if (typeof record.properties === "object" && record.properties !== null) {
    const properties = record.properties as Record<string, unknown>;
    assert.equal(record.additionalProperties, false, `${path}: additionalProperties must be closed`);
    assert.deepEqual(
      [...(Array.isArray(record.required) ? record.required as string[] : [])].sort(),
      Object.keys(properties).sort(),
      `${path}: required must name every property`,
    );
    for (const [name, property] of Object.entries(properties)) assertOpenAiSchemaSubset(property, `${path}.properties.${name}`);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key !== "properties") assertOpenAiSchemaSubset(value, `${path}.${key}`);
  }
}
