import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("runtime revision Git probe inherits only PATH", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "graph-shipper-version-git-"));
  try {
    const gitPath = join(fakeBin, "git");
    writeFileSync(gitPath, [
      "#!/bin/sh",
      'if [ -n "$GRAPH_SHIPPER_TEST_AMBIENT_SECRET" ]; then printf leaked; else printf isolated; fi',
    ].join("\n"));
    chmodSync(gitPath, 0o755);
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      'import { RUNTIME_REVISION } from "./src/version.ts"; process.stdout.write(String(RUNTIME_REVISION));',
    ], {
      cwd: process.cwd(), encoding: "utf8",
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, GRAPH_SHIPPER_TEST_AMBIENT_SECRET: "must-not-cross" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "isolated");
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
