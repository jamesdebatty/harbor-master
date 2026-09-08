import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git } from "./helpers.js";

const hooksSource = fileURLToPath(new URL("../.githooks", import.meta.url));

// Enforcement is asserted against an identity each fixture repository configures
// for itself, never against the maintainer's. The tracked template ships blank.
const fixtureName = "Fixture Maintainer";
const fixtureEmail = "fixture-maintainer@example.invalid";
const pinned = `${fixtureName} <${fixtureEmail}>`;

function tryGit(root: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...environment } });
}

function identityOf(root: string, revision: string): { author: string; committer: string } {
  const [author = "", committer = ""] = git(root, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>", revision]).split("\n");
  return { author, committer };
}

function runInstall(root: string, cwd: string = root) {
  return spawnSync("sh", [".githooks/install"], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
}

// A repository with the hooks copied in and, unless `identity` is false, a local
// override naming the fixture identity. Any override the maintainer keeps in
// their own checkout is dropped, so the fixture governs the copy.
function hooksRepository({ identity = true }: { identity?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-hooks-"));
  cpSync(hooksSource, join(root, ".githooks"), { recursive: true });
  rmSync(join(root, ".githooks", "identity.local.sh"), { force: true });
  if (identity) {
    writeFileSync(join(root, ".githooks", "identity.local.sh"), `GIT_IDENTITY_NAME="${fixtureName}"\nGIT_IDENTITY_EMAIL="${fixtureEmail}"\n`);
  }
  git(root, ["init", "-b", "main"]);
  return root;
}

function wiredRepository(): string {
  const root = hooksRepository();
  const install = runInstall(root);
  assert.equal(install.status, 0, install.stderr);
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "fixture base"]);
  return root;
}

function stage(root: string, name: string): void {
  writeFileSync(join(root, name), `${name}\n`);
  git(root, ["add", name]);
}

function assertRejected(root: string, result: ReturnType<typeof tryGit>, byHook: RegExp, headBefore: string): void {
  assert.notEqual(result.status, 0, "the commit was created");
  assert.match(result.stderr, byHook);
  assert.equal(git(root, ["rev-parse", "HEAD"]), headBefore);
}

test("the tracked identity template ships blank", () => {
  // `install` runs from package.json's `prepare`, so a filled-in template would
  // rewrite user.name and user.email in every clone, re-authoring a stranger's
  // commits as whoever is named here. It stays empty; real values belong in the
  // gitignored identity.local.sh.
  // Sourced rather than pattern-matched: a re-assignment further down the file,
  // or an appended line, would satisfy a regex on the declarations while still
  // pinning an identity into every clone.
  const probe = spawnSync(
    "sh",
    ["-c", '. "$1"; printf "%s|%s" "$GIT_IDENTITY_NAME" "$GIT_IDENTITY_EMAIL"', "_", join(hooksSource, "identity.sh")],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout, "|", "the tracked template resolves to a non-empty identity");
});

test("install pins the configured identity and wires the versioned hooks", () => {
  const root = wiredRepository();
  assert.equal(git(root, ["config", "core.hooksPath"]), ".githooks");
  assert.equal(git(root, ["config", "user.name"]), fixtureName);
  assert.equal(git(root, ["config", "user.email"]), fixtureEmail);
  for (const hook of ["pre-commit", "pre-merge-commit", "commit-msg", "check-identity", "install"]) {
    assert.ok(statSync(join(root, ".githooks", hook)).mode & 0o111, `${hook} is executable`);
  }
  const tracked = readdirSync(join(root, ".githooks")).filter((entry) => entry !== "identity.local.sh");
  assert.deepEqual(tracked.sort(), ["check-identity", "commit-msg", "identity.sh", "install", "pre-commit", "pre-merge-commit"]);
  assert.deepEqual(identityOf(root, "HEAD"), { author: pinned, committer: pinned });
});

test("with no identity configured, install leaves a contributor's git config alone", () => {
  const root = hooksRepository({ identity: false });
  git(root, ["config", "user.name", "Contributor"]);
  git(root, ["config", "user.email", "contributor@example.invalid"]);

  const install = runInstall(root);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(git(root, ["config", "core.hooksPath"]), ".githooks", "the hooks are still wired");
  assert.equal(git(root, ["config", "user.name"]), "Contributor");
  assert.equal(git(root, ["config", "user.email"]), "contributor@example.invalid");

  // Pinning is opt-in, so the contributor's own identity commits freely.
  stage(root, "one.txt");
  git(root, ["commit", "-m", "one"]);
  const own = "Contributor <contributor@example.invalid>";
  assert.deepEqual(identityOf(root, "HEAD"), { author: own, committer: own });

  // A contributor may still credit themselves: with nothing pinned, their own
  // address is the exemption, so `git commit -s` is not third-party credit.
  stage(root, "signed.txt");
  git(root, ["commit", "-s", "-m", "signed"]);
  assert.match(git(root, ["log", "-1", "--format=%B"]), /Signed-off-by: Contributor <contributor@example\.invalid>/);

  // The attribution rule is about the project, not the maintainer: still enforced.
  const head = git(root, ["rev-parse", "HEAD"]);
  stage(root, "two.txt");
  const credited = tryGit(root, ["commit", "-m", "two\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"]);
  assertRejected(root, credited, /commit-msg: this repository credits no third party in commit messages/, head);

  stage(root, "three.txt");
  const otherSignoff = tryGit(root, ["commit", "-m", "three\n\nSigned-off-by: Someone Else <someone@example.invalid>"]);
  assertRejected(root, otherSignoff, /commit-msg: this repository credits no third party in commit messages/, head);
});

test("install is a no-op outside the root of a checkout", () => {
  const root = wiredRepository();
  const nested = join(root, "nested");
  cpSync(hooksSource, join(nested, ".githooks"), { recursive: true });
  const install = runInstall(root, nested);
  assert.equal(install.status, 0, install.stderr);
  assert.equal(git(root, ["config", "core.hooksPath"]), ".githooks");
});

test("pre-commit rejects an author or committer other than the pinned identity", () => {
  const root = wiredRepository();
  const head = git(root, ["rev-parse", "HEAD"]);
  stage(root, "one.txt");

  const wrongConfig = tryGit(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "one"]);
  assertRejected(root, wrongConfig, new RegExp(`pre-commit: AUTHOR is Fixture <fixture@example.invalid>; this repository commits only as ${fixtureName}`), head);
  assert.match(wrongConfig.stderr, /pre-commit: COMMITTER is Fixture <fixture@example.invalid>/);
  assert.match(wrongConfig.stderr, /sh \.githooks\/install/);

  const wrongCommitter = tryGit(root, ["commit", "-m", "one"], { GIT_COMMITTER_NAME: "Bot", GIT_COMMITTER_EMAIL: "bot@example.invalid" });
  assertRejected(root, wrongCommitter, /pre-commit: COMMITTER is Bot <bot@example.invalid>/, head);
  assert.doesNotMatch(wrongCommitter.stderr, /pre-commit: AUTHOR/);

  const authorFlag = tryGit(root, ["commit", "--author=Fixture <fixture@example.invalid>", "-m", "one"]);
  assertRejected(root, authorFlag, /pre-commit: AUTHOR is Fixture <fixture@example.invalid>/, head);
  assert.doesNotMatch(authorFlag.stderr, /pre-commit: COMMITTER/);
});

test("commit-msg rejects a third-party attribution trailer anywhere in the message", () => {
  const root = wiredRepository();
  const head = git(root, ["rev-parse", "HEAD"]);
  stage(root, "one.txt");

  const trailerBlock = tryGit(root, ["commit", "-m", "one\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"]);
  assertRejected(root, trailerBlock, /commit-msg: this repository credits no third party in commit messages; remove:\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>/, head);

  const midBody = tryGit(root, ["commit", "-m", "one\n\n  co-authored-by : Codex <codex@example.invalid>\n\nMore prose after the credit."]);
  assertRejected(root, midBody, /remove:\n {2}co-authored-by : Codex <codex@example.invalid>/, head);

  const otherKeys = tryGit(root, ["commit", "-m", "one\n\nReviewed-by: Someone <someone@example.invalid>\nGenerated-with: A Tool"]);
  assertRejected(root, otherKeys, /remove:\nReviewed-by: Someone <someone@example.invalid>\nGenerated-with: A Tool/, head);
});

test("commit-msg keeps a trailer that names the pinned identity and ignores comment lines", () => {
  const root = wiredRepository();
  stage(root, "one.txt");
  git(root, ["commit", "--cleanup=verbatim", "-m", `one\n\n# Co-authored-by: Commented <commented@example.invalid>\nSigned-off-by: ${pinned}`]);
  assert.match(git(root, ["log", "-1", "--format=%B"]), new RegExp(`Signed-off-by: ${fixtureName} <${fixtureEmail.replace(".", "\\.")}>`));
});

test("pre-merge-commit and commit-msg guard merge commits", () => {
  const root = wiredRepository();
  git(root, ["switch", "-c", "topic"]);
  stage(root, "topic.txt");
  git(root, ["commit", "-m", "topic work"]);
  git(root, ["switch", "main"]);
  stage(root, "main.txt");
  git(root, ["commit", "-m", "main work"]);
  const head = git(root, ["rev-parse", "HEAD"]);

  const wrongIdentity = tryGit(root, ["-c", "user.email=fixture@example.invalid", "merge", "--no-ff", "topic"]);
  assertRejected(root, wrongIdentity, new RegExp(`pre-merge-commit: AUTHOR is ${fixtureName} <fixture@example.invalid>`), head);
  git(root, ["merge", "--abort"]);

  const credited = tryGit(root, ["merge", "--no-ff", "-m", "Merge topic\n\nCo-authored-by: Bot <bot@example.invalid>", "topic"]);
  assertRejected(root, credited, /commit-msg: .*\nCo-authored-by: Bot <bot@example.invalid>/, head);
  git(root, ["merge", "--abort"]);

  git(root, ["merge", "--no-ff", "topic"]);
  assert.equal(git(root, ["rev-list", "--parents", "-1", "HEAD"]).split(" ").length, 3);
  assert.deepEqual(identityOf(root, "HEAD"), { author: pinned, committer: pinned });
});
