import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ActivatedCommandRegistry } from "../src/actions/commands.js";
import type { ProjectContract } from "../src/contracts/schema.js";
import { validContract } from "./helpers.js";

function commandFixture(
  source: string,
  timeoutSeconds: number,
  cwd: "worktree" | "project_root" = "worktree",
  sideEffect: "none" | "workspace" = "none",
): {
  root: string;
  registry: ActivatedCommandRegistry;
} {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "probe.mjs"), source);
  const contract = validContract(root) as ProjectContract;
  contract.commands.push({
    id: "probe",
    argv: ["node", "scripts/probe.mjs"],
    authorizationSources: ["scripts/probe.mjs"],
    cwd,
    timeoutSeconds,
    credentialRefs: [],
    environmentPasslist: [],
    sideEffect,
    idempotence: sideEffect === "none" ? "pure" : "idempotent",
    parameters: {},
  });
  return { root, registry: new ActivatedCommandRegistry(contract, root) };
}

function roots(root: string) {
  return { runtime: root, project_root: root, worktree: root, worktreeGitDirectory: join(root, ".git"), synced_main: root };
}

test("pure worktree commands get Git safe defaults but never the GIT_DIR/GIT_WORK_TREE pins", async () => {
  const source = 'process.stdout.write(JSON.stringify({ gitDirectory: process.env.GIT_DIR ?? null, worktree: process.env.GIT_WORK_TREE ?? null, globalConfig: process.env.GIT_CONFIG_GLOBAL ?? null }));\n';
  const worktree = commandFixture(source, 5);
  const project = commandFixture(source, 5, "project_root");
  const mutation = commandFixture(source, 5, "worktree", "workspace");
  try {
    // A gate is an arbitrary program; exporting the pins would redirect any `git init` or
    // `git config` it runs in its own temporary repositories onto the owned worktree's Git
    // directory, whose config is shared with the primary clone.
    const pure = JSON.parse((await worktree.registry.execute("probe", {}, roots(worktree.root))).stdout) as Record<string, string | null>;
    assert.equal(pure.gitDirectory, null);
    assert.equal(pure.worktree, null);
    assert.notEqual(pure.globalConfig, null);

    const unbound = JSON.parse((await project.registry.execute("probe", {}, roots(project.root))).stdout) as Record<string, string | null>;
    assert.equal(unbound.gitDirectory, null);
    assert.equal(unbound.worktree, null);
    assert.equal(unbound.globalConfig, null);

    const mutationEnvironment = JSON.parse(
      (await mutation.registry.execute("probe", {}, roots(mutation.root))).stdout,
    ) as Record<string, string | null>;
    assert.equal(mutationEnvironment.gitDirectory, null);
    assert.equal(mutationEnvironment.worktree, null);
  } finally {
    rmSync(worktree.root, { recursive: true, force: true });
    rmSync(project.root, { recursive: true, force: true });
    rmSync(mutation.root, { recursive: true, force: true });
  }
});

test("an allowlisted command that exceeds its timeout is terminated and reported as failed evidence", async () => {
  const fixture = commandFixture("setInterval(() => undefined, 1_000);\n", 0.05);
  try {
    await assert.rejects(
      () => fixture.registry.execute("probe", {}, roots(fixture.root)),
      /exceeded its timeout/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a timed-out command cannot convert SIGTERM into a successful result", async () => {
  const fixture = commandFixture([
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => undefined, 1_000);",
  ].join("\n"), 0.05);
  try {
    await assert.rejects(
      () => fixture.registry.execute("probe", {}, roots(fixture.root)),
      /exceeded its timeout/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an allowlisted command cannot persist more than the bounded evidence output", async () => {
  const fixture = commandFixture('process.stdout.write("x".repeat(4 * 1024 * 1024 + 1));\n', 5);
  try {
    await assert.rejects(
      () => fixture.registry.execute("probe", {}, roots(fixture.root)),
      /output exceeded the 4 MiB evidence limit/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an allowlisted command reports process startup failure without invoking a shell", async () => {
  const fixture = commandFixture("process.exit(0);\n", 5);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = join(fixture.root, "missing-path");
    const contract = validContract(fixture.root) as ProjectContract;
    contract.commands.push({
      id: "probe",
      argv: ["node", "scripts/probe.mjs"],
      authorizationSources: ["scripts/probe.mjs"],
      cwd: "worktree",
      timeoutSeconds: 5,
      credentialRefs: [],
      environmentPasslist: [],
      sideEffect: "none",
      idempotence: "pure",
      parameters: {},
    });
    const registry = new ActivatedCommandRegistry(contract);

    await assert.rejects(
      () => registry.execute("probe", {}, roots(fixture.root)),
      /execution failed/,
    );
  } finally {
    process.env.PATH = originalPath;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runtime command isolation removes ambient loader and network capabilities", async () => {
  const loaderFixture = commandFixture([
    'const { createRequire } = process.getBuiltinModule("node:module");',
    'createRequire(import.meta.url)("./undeclared-helper.cjs");',
  ].join("\n"), 5);
  const marker = join(loaderFixture.root, "ambient-loader-ran.txt");
  writeFileSync(join(loaderFixture.root, "scripts", "undeclared-helper.cjs"), [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(marker)}, "ran\\n");`,
  ].join("\n"));
  try {
    const result = await loaderFixture.registry.execute("probe", {}, roots(loaderFixture.root));
    assert.notEqual(result.exitCode, 0);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(loaderFixture.root, { recursive: true, force: true });
  }

  const networkFixture = commandFixture([
    'if (typeof fetch !== "undefined" || typeof WebSocket !== "undefined" || typeof process.execve !== "undefined") process.exit(7);',
  ].join("\n"), 5);
  try {
    const result = await networkFixture.registry.execute("probe", {}, roots(networkFixture.root));
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    rmSync(networkFixture.root, { recursive: true, force: true });
  }
});

function passlistFixture(passlist: string[]): { root: string; dataRoot: string; registry: ActivatedCommandRegistry } {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-command-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "graph-shipper-data-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "probe.mjs"), [
    'process.stdout.write(JSON.stringify({',
    "  HOME: process.env.HOME ?? null,",
    "  TMPDIR: process.env.TMPDIR ?? null,",
    "  PATH: process.env.PATH ? true : false,",
    "  NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY ?? null,",
    "  HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,",
    "  NO_PROXY: process.env.NO_PROXY ?? null,",
    "  SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? null,",
    "  SSL_CERT_DIR: process.env.SSL_CERT_DIR ?? null,",
    "  LANG: process.env.LANG ?? null,",
    "  UNDECLARED_OPERATOR_VALUE: process.env.UNDECLARED_OPERATOR_VALUE ?? null,",
    "}));",
  ].join("\n"));
  const contract = validContract(root) as ProjectContract;
  contract.commands.push({
    id: "probe",
    argv: ["node", "scripts/probe.mjs"],
    authorizationSources: ["scripts/probe.mjs"],
    cwd: "worktree",
    timeoutSeconds: 30,
    credentialRefs: [],
    sideEffect: "none",
    idempotence: "pure",
    parameters: {},
    environmentPasslist: passlist,
  } as ProjectContract["commands"][number]);
  return {
    root,
    dataRoot,
    registry: new ActivatedCommandRegistry(contract, root, { dataRoot, projectId: "fixture-project", runId: "run-env-1" }),
  };
}

test("a declared command runs under a runtime-owned home and temporary directory, not the operator's", async () => {
  const fixture = passlistFixture([]);
  const previous = { ...process.env };
  process.env.UNDECLARED_OPERATOR_VALUE = "operator-only";
  try {
    const result = await fixture.registry.execute("probe", {}, roots(fixture.root));
    const observed = JSON.parse(result.stdout) as Record<string, string | boolean | null>;

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(observed.PATH, true);
    assert.equal(observed.UNDECLARED_OPERATOR_VALUE, null);
    assert.equal(String(observed.HOME).startsWith(fixture.dataRoot), true, `home was ${observed.HOME}`);
    assert.notEqual(observed.HOME, process.env.HOME);
    assert.equal(observed.TMPDIR, join(fixture.dataRoot, "tmp", "run-env-1"));
    assert.equal(observed.HOME, join(fixture.dataRoot, "tool-home", "fixture-project"));
    assert.equal(existsSync(String(observed.HOME)), true);
  } finally {
    process.env = previous;
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("the runtime-owned home persists across runs of the same project so a toolchain cache survives", async () => {
  const first = passlistFixture([]);
  try {
    const result = await first.registry.execute("probe", {}, roots(first.root));
    const home = String((JSON.parse(result.stdout) as Record<string, string>).HOME);
    writeFileSync(join(home, "cache-marker"), "warm\n");

    const contract = validContract(first.root) as ProjectContract;
    contract.commands.push({
      id: "probe", argv: ["node", "scripts/probe.mjs"], authorizationSources: ["scripts/probe.mjs"],
      cwd: "worktree", timeoutSeconds: 30, credentialRefs: [], sideEffect: "none", idempotence: "pure",
      parameters: {}, environmentPasslist: [],
    } as ProjectContract["commands"][number]);
    const later = new ActivatedCommandRegistry(contract, first.root, {
      dataRoot: first.dataRoot, projectId: "fixture-project", runId: "run-env-2",
    });
    const second = await later.execute("probe", {}, roots(first.root));
    const observed = JSON.parse(second.stdout) as Record<string, string>;

    assert.equal(observed.HOME, home);
    assert.equal(existsSync(join(home, "cache-marker")), true);
    assert.notEqual(observed.TMPDIR, JSON.parse(result.stdout).TMPDIR);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(first.dataRoot, { recursive: true, force: true });
  }
});

test("only contract-declared variable names cross into a declared command", async () => {
  const fixture = passlistFixture(["NPM_CONFIG_REGISTRY"]);
  const previous = { ...process.env };
  process.env.NPM_CONFIG_REGISTRY = "https://registry.example.invalid";
  process.env.UNDECLARED_OPERATOR_VALUE = "operator-only";
  try {
    const result = await fixture.registry.execute("probe", {}, roots(fixture.root));
    const observed = JSON.parse(result.stdout) as Record<string, string | null>;

    assert.equal(observed.NPM_CONFIG_REGISTRY, "https://registry.example.invalid");
    assert.equal(observed.UNDECLARED_OPERATOR_VALUE, null);
  } finally {
    process.env = previous;
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("a declared name absent from the operator environment is simply absent, never empty", async () => {
  const fixture = passlistFixture(["NPM_CONFIG_REGISTRY"]);
  const previous = { ...process.env };
  delete process.env.NPM_CONFIG_REGISTRY;
  try {
    const result = await fixture.registry.execute("probe", {}, roots(fixture.root));
    assert.equal((JSON.parse(result.stdout) as Record<string, string | null>).NPM_CONFIG_REGISTRY, null);
  } finally {
    process.env = previous;
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
});

test("an admitted passlist value carrying userinfo is refused rather than handed to the command", async () => {
  const refused = [
    ["HTTPS_PROXY", "https://operator:ghp_secret@proxy.internal:8443"],
    ["HTTPS_PROXY", "operator:ghp_secret@proxy.internal:8443"],
    ["HTTPS_PROXY", "http://a.invalid, https://operator:tok@b.invalid"],
    ["HTTPS_PROXY", "operator:ghp_secret@localhost:8443"],
    ["HTTPS_PROXY", "operator:ghp_secret@LOCALHOST:8443"],
    ["HTTPS_PROXY", "http://us\\er:ghp_secret@proxy.internal"],
    ["HTTPS_PROXY", "CORP\\jdoe:ghp_secret@proxy.corp.example:8080"],
    ["HTTPS_PROXY", "operator:ghp_secret@squid:3128"],
    ["HTTPS_PROXY", "operator:ghp_secret@my_proxy.internal:3128"],
    ["HTTPS_PROXY", "operator:ghp_secret@squid"],
    ["HTTPS_PROXY", "operator:ghp_secret@proxy%2Einternal"],
    ["NPM_CONFIG_REGISTRY", "https://operator:ghp_secret@registry.internal/"],
    ["HTTPS_PROXY", "operator:ghp_secret@proxy.internal.:8443"],
    ["ALL_PROXY", "socks5://operator:ghp_secret@proxy.internal:1080"],
  ];
  const admitted = [
    ["HTTPS_PROXY", "https://proxy.internal:8443"],
    ["HTTPS_PROXY", "http://[::1]:8080"],
    ["NPM_CONFIG_REGISTRY", "https://registry.npmjs.org/"],
    ["HTTPS_PROXY", "http://a.invalid,https://b.invalid"],
    ["NO_PROXY", "localhost,127.0.0.1,.internal"],
    ["SSL_CERT_FILE", "certs@2024/ca.pem"],
    ["SSL_CERT_FILE", "ca@2024.pem"],
    ["SSL_CERT_FILE", "C:\\ssl\\ca@2024.pem"],
    ["SSL_CERT_DIR", "bundle@v1.crt"],
    ["SSL_CERT_FILE", "/opt/homebrew/etc/openssl@3/cert.pem"],
    ["SSL_CERT_FILE", "C:\\certs@2024\\ca.pem"],
    ["SSL_CERT_DIR", "certs@2024"],
    ["LANG", "en_US.UTF-8"],
  ];
  const previous = { ...process.env };
  try {
    for (const [name, value] of refused) {
      const fixture = passlistFixture([name!]);
      process.env[name!] = value!;
      try {
        await assert.rejects(
          () => fixture.registry.execute("probe", {}, roots(fixture.root)),
          (error: unknown) => {
            assert.match((error as Error).message, new RegExp(name!));
            assert.doesNotMatch((error as Error).message, /ghp_secret/);
            return true;
          },
          `${name}=${value}`,
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
        rmSync(fixture.dataRoot, { recursive: true, force: true });
      }
    }
    for (const [name, value] of admitted) {
      const fixture = passlistFixture([name!]);
      process.env[name!] = value!;
      try {
        const result = await fixture.registry.execute("probe", {}, roots(fixture.root));
        assert.equal(result.exitCode, 0, `${name}=${value}: ${result.stderr}`);
        assert.equal((JSON.parse(result.stdout) as Record<string, string>)[name!], value, `${name}=${value}`);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
        rmSync(fixture.dataRoot, { recursive: true, force: true });
      }
    }
  } finally {
    process.env = previous;
  }
});
