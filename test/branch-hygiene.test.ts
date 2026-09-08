import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("scripts/branch-hygiene.sh");

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("branch hygiene accepts merge-commit-only repositories", () => {
  const fixture = mkdtempSync(join(tmpdir(), "graph-shipper-branch-hygiene-"));
  try {
    const remote = join(fixture, "origin.git");
    const repository = join(fixture, "repository");
    const bin = join(fixture, "bin");
    mkdirSync(bin);
    git(fixture, ["init", "--bare", "--initial-branch=main", remote]);
    git(fixture, ["clone", remote, repository]);
    git(repository, ["config", "user.name", "Fixture"]);
    git(repository, ["config", "user.email", "fixture@example.invalid"]);
    writeFileSync(join(repository, "README.md"), "fixture\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-m", "Initialize fixture"]);
    git(repository, ["push", "-u", "origin", "main"]);

    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      "#!/bin/sh\ncase \"$1 $2\" in\n  \"repo view\") printf \"%s\\n\" \"$GH_SETTINGS\" ;;\n  \"pr list\") exit 0 ;;\n  *) exit 2 ;;\nesac\n",
    );
    chmodSync(gh, 0o755);

    const result = spawnSync("sh", [script], {
      cwd: repository,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_SETTINGS: "merge=true squash=false rebase=false deleteOnMerge=true",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
