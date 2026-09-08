import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as publicApi from "../src/index.js";
import { OpaqueCredential, consumeOpaqueCredential } from "../src/security/opaque-credential.js";
import { PersistenceRedactor } from "../src/security/redact.js";
import { StateStore } from "../src/state/store.js";
import { JsonlTraceWriter } from "../src/trace/jsonl.js";

test("opaque credentials cannot serialize and trace persistence removes key- and value-shaped secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-trace-"));
  try {
    const redactor = new PersistenceRedactor();
    const credential = OpaqueCredential.create("fixture-ref", "credential-super-secret", redactor);
    assert.equal("OpaqueCredential" in publicApi, false);
    assert.throws(() => JSON.stringify({ credential }), /cannot be serialized/);
    let observedLength = 0;
    consumeOpaqueCredential(credential, (value) => { observedLength = value.length; });
    assert.equal(observedLength, "credential-super-secret".length);

    const trace = new JsonlTraceWriter(root, redactor);
    const path = trace.append("run-123", {
      eventType: "adapter_failure",
      payload: {
        authorization: "Bearer another-secret",
        accessToken: "camel-case-token",
        "set-cookie": "session=cookie-value",
        message: "provider rejected credential-super-secret",
        nested: credential,
      },
    });
    const persisted = readFileSync(path, "utf8");
    assert.doesNotMatch(persisted, /credential-super-secret|another-secret|camel-case-token|cookie-value/);
    assert.match(persisted, /\[REDACTED\]/);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    credential.dispose();
    assert.throws(() => consumeOpaqueCredential(credential, () => undefined), /disposed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trace persistence refuses a pre-existing symlink instead of writing outside its root", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-trace-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "graph-shipper-trace-external-"));
  try {
    const externalPath = join(externalRoot, "outside.jsonl");
    writeFileSync(externalPath, "untouched\n");
    symlinkSync(externalPath, join(root, "run-symlink.jsonl"));
    const trace = new JsonlTraceWriter(root, new PersistenceRedactor());

    assert.throws(() => trace.append("run-symlink", { eventType: "probe", payload: {} }));
    assert.equal(readFileSync(externalPath, "utf8"), "untouched\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("Work Run persistence removes values registered with its redactor", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-state-redaction-"));
  const registeredSecret = "registered-provider-secret-value";
  const redactor = new PersistenceRedactor();
  const release = redactor.registerSecret(registeredSecret);
  const store = new StateStore(root, redactor);
  try {
    const at = "2026-08-13T00:00:00.000Z";
    store.onboard({
      projectId: "redaction-fixture",
      projectRoot: join(root, "project"),
      githubRepository: "fixture/redaction",
      contractDigest: "contract-digest",
      contractBlobSha: "contract-blob",
      admissionEvidenceDigest: "admission-digest",
      schemaVersion: "1.0.0",
      contractSnapshot: {},
      admissionEvidence: {},
      validatedAt: at,
    });
    store.createWorkRun({
      runId: "redaction-run",
      projectId: "redaction-fixture",
      contractDigest: "contract-digest",
      workItemRevision: "revision-1",
      phase: "plan",
      status: "running",
      state: { message: `provider echoed ${registeredSecret}` },
      createdAt: at,
      updatedAt: at,
    });

    const persisted = JSON.stringify(store.workRun("redaction-run")?.state);
    assert.doesNotMatch(persisted, new RegExp(registeredSecret));
    assert.match(persisted, /\[REDACTED\]/);
  } finally {
    store.close();
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("effect persistence refuses to prepare an already-terminal intent", () => {
  const root = mkdtempSync(join(tmpdir(), "graph-shipper-effect-terminal-"));
  const store = new StateStore(root);
  try {
    const at = "2026-08-13T00:00:00.000Z";
    store.onboard({
      projectId: "effect-fixture",
      projectRoot: join(root, "project"),
      githubRepository: "fixture/effect",
      contractDigest: "contract-digest",
      contractBlobSha: "contract-blob",
      admissionEvidenceDigest: "admission-digest",
      schemaVersion: "1.0.0",
      contractSnapshot: {},
      admissionEvidence: {},
      validatedAt: at,
    });
    store.createWorkRun({
      runId: "effect-run",
      projectId: "effect-fixture",
      contractDigest: "contract-digest",
      workItemRevision: "revision-1",
      phase: "act",
      status: "running",
      state: {},
      createdAt: at,
      updatedAt: at,
    });
    const intent = {
      effectId: "effect-1",
      runId: "effect-run",
      kind: "file_write",
      target: "README.md",
      desiredDigest: "desired-digest",
      state: "prepared" as const,
      intent: { path: "README.md" },
      preparedAt: at,
    };
    store.prepareEffect(intent);
    store.completeEffect(intent.effectId, "applied", { path: "README.md" }, at);

    assert.throws(() => store.prepareEffect(intent), /already terminal|not prepared/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
