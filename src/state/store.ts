import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ShipperError } from "../errors.js";
import { PersistenceRedactor } from "../security/redact.js";

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL UNIQUE,
        github_repository TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE admission_candidates (
        project_id TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        contract_blob_sha TEXT NOT NULL,
        admission_evidence_digest TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        contract_snapshot_json TEXT NOT NULL,
        admission_evidence_json TEXT NOT NULL,
        validated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'superseded')),
        PRIMARY KEY (project_id, contract_digest),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE contract_activations (
        project_id TEXT PRIMARY KEY,
        contract_digest TEXT NOT NULL,
        contract_blob_sha TEXT NOT NULL,
        admission_evidence_digest TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        at_iso TEXT NOT NULL,
        project_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE work_runs (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        work_item_revision TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'draining', 'paused', 'completed', 'escalated')),
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      );

      CREATE TABLE effect_intents (
        effect_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        desired_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'applied', 'adopted', 'failed', 'indeterminate')),
        intent_json TEXT NOT NULL,
        receipt_json TEXT,
        prepared_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (run_id) REFERENCES work_runs(run_id)
      );

      CREATE TABLE work_run_checkpoints (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES work_runs(run_id)
      );

      CREATE INDEX work_runs_project_status ON work_runs(project_id, status);
      CREATE INDEX work_run_checkpoints_run ON work_run_checkpoints(run_id, sequence);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE work_run_claims (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      );

      CREATE INDEX work_run_claims_project ON work_run_claims(project_id);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE project_operation_claims (
        project_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(project_id),
        FOREIGN KEY (run_id) REFERENCES work_runs(run_id)
      );
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE contract_activations ADD COLUMN project_root TEXT;

      UPDATE contract_activations SET status = 'revoked' WHERE project_root IS NULL;

      CREATE TRIGGER active_activation_requires_root_insert
      BEFORE INSERT ON contract_activations
      WHEN NEW.status = 'active' AND NEW.project_root IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'active activation requires project_root');
      END;

      CREATE TRIGGER active_activation_requires_root_update
      BEFORE UPDATE ON contract_activations
      WHEN NEW.status = 'active' AND NEW.project_root IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'active activation requires project_root');
      END;
    `,
  },
] as const;

export interface AdmissionRecord {
  projectId: string;
  projectRoot: string;
  githubRepository: string;
  contractDigest: string;
  contractBlobSha: string;
  admissionEvidenceDigest: string;
  schemaVersion: string;
  contractSnapshot: unknown;
  admissionEvidence: unknown;
  validatedAt: string;
}

export interface ActivationApproval {
  projectId: string;
  projectRoot: string;
  contractDigest: string;
  contractBlobSha: string;
  admissionEvidenceDigest: string;
  approvedBy: string;
  approvedAt: string;
}

export interface ActivationRecord extends ActivationApproval {
  status: "active" | "revoked";
}

export interface PersistedWorkRun {
  runId: string;
  projectId: string;
  contractDigest: string;
  workItemRevision: string;
  phase: string;
  status: "running" | "draining" | "paused" | "completed" | "escalated";
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedEffectIntent {
  effectId: string;
  runId: string;
  kind: string;
  target: string;
  desiredDigest: string;
  state: "prepared" | "applied" | "adopted" | "failed" | "indeterminate";
  intent: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  preparedAt: string;
  completedAt?: string;
}

interface CandidateRow {
  project_id: string;
  contract_digest: string;
  contract_blob_sha: string;
  admission_evidence_digest: string;
}

interface ActivationRow extends CandidateRow {
  project_root: string | null;
  approved_by: string;
  approved_at: string;
  status: "active" | "revoked";
}

function activationFromRow(row: ActivationRow | undefined): ActivationRecord | undefined {
  if (!row?.project_root) return undefined;
  return {
    projectId: row.project_id,
    projectRoot: row.project_root,
    contractDigest: row.contract_digest,
    contractBlobSha: row.contract_blob_sha,
    admissionEvidenceDigest: row.admission_evidence_digest,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    status: row.status,
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export class StateStore {
  readonly databasePath: string;
  readonly database: DatabaseSync;

  constructor(readonly dataRoot: string, private readonly redactor = new PersistenceRedactor()) {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(dataRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ShipperError("runtime data root must be a regular non-symlink directory", 3);
    }
    chmodSync(dataRoot, 0o700);
    this.databasePath = join(dataRoot, "state.sqlite");
    for (const path of [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new ShipperError("state database must be a regular non-symlink file", 3);
      }
    }
    this.database = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const current = Number((this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(migration.sql);
        this.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  onboard(record: AdmissionRecord): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO projects(project_id, project_root, github_repository, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          project_root = excluded.project_root,
          github_repository = excluded.github_repository,
          updated_at = excluded.updated_at
      `).run(record.projectId, record.projectRoot, record.githubRepository, record.validatedAt, record.validatedAt);
      this.database.prepare("UPDATE admission_candidates SET status = 'superseded' WHERE project_id = ? AND contract_digest <> ?")
        .run(record.projectId, record.contractDigest);
      this.database.prepare(`
        INSERT INTO admission_candidates(
          project_id, contract_digest, contract_blob_sha, admission_evidence_digest,
          schema_version, contract_snapshot_json, admission_evidence_json,
          validated_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        ON CONFLICT(project_id, contract_digest) DO UPDATE SET
          contract_blob_sha = excluded.contract_blob_sha,
          admission_evidence_digest = excluded.admission_evidence_digest,
          schema_version = excluded.schema_version,
          contract_snapshot_json = excluded.contract_snapshot_json,
          admission_evidence_json = excluded.admission_evidence_json,
          validated_at = excluded.validated_at,
          status = 'pending'
      `).run(
        record.projectId,
        record.contractDigest,
        record.contractBlobSha,
        record.admissionEvidenceDigest,
        record.schemaVersion,
        this.redactor.serialize(record.contractSnapshot),
        this.redactor.serialize(record.admissionEvidence),
        record.validatedAt,
      );
      this.insertAudit(record.projectId, "contract_onboarded", {
        contractDigest: record.contractDigest,
        contractBlobSha: record.contractBlobSha,
        admissionEvidenceDigest: record.admissionEvidenceDigest,
      }, record.validatedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  findCandidate(projectId: string, contractDigest: string, admissionEvidenceDigest: string): CandidateRow | undefined {
    return this.database.prepare(`
      SELECT project_id, contract_digest, contract_blob_sha, admission_evidence_digest
      FROM admission_candidates
      WHERE project_id = ? AND contract_digest = ? AND admission_evidence_digest = ? AND status = 'pending'
    `).get(projectId, contractDigest, admissionEvidenceDigest) as CandidateRow | undefined;
  }

  activate(record: ActivationApproval): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO contract_activations(
          project_id, project_root, contract_digest, contract_blob_sha, admission_evidence_digest,
          approved_by, approved_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(project_id) DO UPDATE SET
          project_root = excluded.project_root,
          contract_digest = excluded.contract_digest,
          contract_blob_sha = excluded.contract_blob_sha,
          admission_evidence_digest = excluded.admission_evidence_digest,
          approved_by = excluded.approved_by,
          approved_at = excluded.approved_at,
          status = 'active'
      `).run(
        record.projectId,
        record.projectRoot,
        record.contractDigest,
        record.contractBlobSha,
        record.admissionEvidenceDigest,
        record.approvedBy,
        record.approvedAt,
      );
      this.insertAudit(record.projectId, "contract_activated", {
        contractDigest: record.contractDigest,
        admissionEvidenceDigest: record.admissionEvidenceDigest,
        approvedBy: record.approvedBy,
      }, record.approvedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimWorkRun(runId: string, projectId: string, ownerToken: string, maximumWorkRuns: number): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const claims = this.database.prepare(`
        SELECT run_id, owner_token, owner_pid FROM work_run_claims WHERE project_id = ?
      `).all(projectId) as Array<{ run_id: string; owner_token: string; owner_pid: number }>;
      for (const claim of claims) {
        if (!processIsAlive(claim.owner_pid)) {
          this.database.prepare("DELETE FROM work_run_claims WHERE run_id = ? AND owner_token = ?")
            .run(claim.run_id, claim.owner_token);
        }
      }
      const existing = this.database.prepare("SELECT owner_pid FROM work_run_claims WHERE run_id = ?")
        .get(runId) as { owner_pid: number } | undefined;
      if (existing) throw new ShipperError(`Work Run ${runId} is already executing in process ${existing.owner_pid}`, 3);
      const active = Number((this.database.prepare("SELECT COUNT(*) AS count FROM work_run_claims WHERE project_id = ?")
        .get(projectId) as { count: number }).count);
      if (active >= maximumWorkRuns) {
        throw new ShipperError(`project has reached its maximum concurrent Work Runs (${maximumWorkRuns})`, 3);
      }
      this.database.prepare(`
        INSERT INTO work_run_claims(run_id, project_id, owner_token, owner_pid, acquired_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, projectId, ownerToken, process.pid, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseWorkRunClaim(runId: string, ownerToken: string): void {
    this.database.prepare("DELETE FROM work_run_claims WHERE run_id = ? AND owner_token = ?").run(runId, ownerToken);
  }

  claimProjectOperation(projectId: string, runId: string, operation: "merge" | "post_merge", ownerToken: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT run_id, owner_pid FROM project_operation_claims WHERE project_id = ?
      `).get(projectId) as { run_id: string; owner_pid: number } | undefined;
      if (existing && !processIsAlive(existing.owner_pid)) {
        this.database.prepare("DELETE FROM project_operation_claims WHERE project_id = ?").run(projectId);
      } else if (existing) {
        throw new ShipperError(`project operation is already serialized by Work Run ${existing.run_id}`, 3);
      }
      this.database.prepare(`
        INSERT INTO project_operation_claims(project_id, run_id, operation, owner_token, owner_pid, acquired_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, runId, operation, ownerToken, process.pid, new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  releaseProjectOperation(projectId: string, runId: string, ownerToken: string): void {
    this.database.prepare(`
      DELETE FROM project_operation_claims WHERE project_id = ? AND run_id = ? AND owner_token = ?
    `).run(projectId, runId, ownerToken);
  }

  createWorkRun(run: PersistedWorkRun): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO work_runs(run_id, project_id, contract_digest, work_item_revision, phase, status, state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.runId, run.projectId, run.contractDigest, run.workItemRevision, run.phase, run.status,
        this.redactor.serialize(run.state), run.createdAt, run.updatedAt,
      );
      this.insertCheckpoint(run);
      this.insertAudit(run.projectId, "work_run_created", { runId: run.runId, workItemRevision: run.workItemRevision }, run.createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  checkpointWorkRun(run: PersistedWorkRun): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE work_runs SET phase = ?, status = ?, state_json = ?, updated_at = ? WHERE run_id = ?
      `).run(run.phase, run.status, this.redactor.serialize(run.state), run.updatedAt, run.runId);
      if (Number(result.changes) !== 1) throw new ShipperError(`unknown Work Run: ${run.runId}`, 3);
      this.insertCheckpoint(run);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  workRun(runId: string): PersistedWorkRun | undefined {
    const row = this.database.prepare(`
      SELECT run_id, project_id, contract_digest, work_item_revision, phase, status, state_json, created_at, updated_at
      FROM work_runs WHERE run_id = ?
    `).get(runId) as {
      run_id: string; project_id: string; contract_digest: string; work_item_revision: string;
      phase: string; status: PersistedWorkRun["status"]; state_json: string; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      runId: row.run_id,
      projectId: row.project_id,
      contractDigest: row.contract_digest,
      workItemRevision: row.work_item_revision,
      phase: row.phase,
      status: row.status,
      state: JSON.parse(row.state_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  prepareEffect(effect: PersistedEffectIntent): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        INSERT INTO effect_intents(effect_id, run_id, kind, target, desired_digest, state, intent_json, prepared_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)
        ON CONFLICT(effect_id) DO UPDATE SET
          intent_json = excluded.intent_json,
          prepared_at = excluded.prepared_at
        WHERE effect_intents.state = 'prepared'
      `).run(
        effect.effectId, effect.runId, effect.kind, effect.target, effect.desiredDigest,
        this.redactor.serialize(effect.intent), effect.preparedAt,
      );
      if (Number(result.changes) !== 1) throw new ShipperError(`effect ${effect.effectId} is already terminal`, 3);
      this.insertAudit(null, "effect_intent_prepared", { effectId: effect.effectId, runId: effect.runId, kind: effect.kind }, effect.preparedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  completeEffect(effectId: string, state: "applied" | "adopted" | "failed" | "indeterminate", receipt: Record<string, unknown>, completedAt: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE effect_intents SET state = ?, receipt_json = ?, completed_at = ? WHERE effect_id = ? AND state = 'prepared'
      `).run(state, this.redactor.serialize(receipt), completedAt, effectId);
      if (Number(result.changes) !== 1) throw new ShipperError(`effect ${effectId} is not prepared`, 3);
      this.insertAudit(null, "effect_receipt_recorded", { effectId, state }, completedAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  preparedEffect(runId: string): PersistedEffectIntent | undefined {
    const row = this.database.prepare(`
      SELECT effect_id, run_id, kind, target, desired_digest, state, intent_json, receipt_json, prepared_at, completed_at
      FROM effect_intents WHERE run_id = ? AND state = 'prepared' ORDER BY prepared_at DESC LIMIT 1
    `).get(runId) as {
      effect_id: string; run_id: string; kind: string; target: string; desired_digest: string;
      state: PersistedEffectIntent["state"]; intent_json: string; receipt_json: string | null;
      prepared_at: string; completed_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      effectId: row.effect_id, runId: row.run_id, kind: row.kind, target: row.target,
      desiredDigest: row.desired_digest, state: row.state,
      intent: JSON.parse(row.intent_json) as Record<string, unknown>,
      ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as Record<string, unknown> } : {}),
      preparedAt: row.prepared_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  effect(effectId: string): PersistedEffectIntent | undefined {
    const row = this.database.prepare(`
      SELECT effect_id, run_id, kind, target, desired_digest, state, intent_json, receipt_json, prepared_at, completed_at
      FROM effect_intents WHERE effect_id = ?
    `).get(effectId) as {
      effect_id: string; run_id: string; kind: string; target: string; desired_digest: string;
      state: PersistedEffectIntent["state"]; intent_json: string; receipt_json: string | null;
      prepared_at: string; completed_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      effectId: row.effect_id, runId: row.run_id, kind: row.kind, target: row.target,
      desiredDigest: row.desired_digest, state: row.state,
      intent: JSON.parse(row.intent_json) as Record<string, unknown>,
      ...(row.receipt_json ? { receipt: JSON.parse(row.receipt_json) as Record<string, unknown> } : {}),
      preparedAt: row.prepared_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    };
  }

  latestEffect(runId: string, kind: string): PersistedEffectIntent | undefined {
    const row = this.database.prepare(`
      SELECT effect_id FROM effect_intents
      WHERE run_id = ? AND kind = ? AND state IN ('applied', 'adopted')
      ORDER BY completed_at DESC LIMIT 1
    `).get(runId, kind) as { effect_id: string } | undefined;
    return row ? this.effect(row.effect_id) : undefined;
  }

  private insertCheckpoint(run: PersistedWorkRun): void {
    this.database.prepare("INSERT INTO work_run_checkpoints(run_id, phase, state_json, created_at) VALUES (?, ?, ?, ?)")
      .run(run.runId, run.phase, this.redactor.serialize(run.state), run.updatedAt);
  }

  private insertAudit(projectId: string | null, eventType: string, payload: unknown, atIso: string): void {
    this.database.prepare("INSERT INTO audit_events(at_iso, project_id, event_type, payload_json) VALUES (?, ?, ?, ?)")
      .run(atIso, projectId, eventType, this.redactor.serialize(payload));
  }
}

export function readExistingActivation(dataRoot: string, projectId: string, projectRoot: string): ActivationRecord | undefined {
  const databasePath = join(dataRoot, "state.sqlite");
  if (!existsSync(databasePath)) return undefined;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version < 5) return undefined;
    const row = database.prepare(`
      SELECT project_id, project_root, contract_digest, contract_blob_sha,
             admission_evidence_digest, approved_by, approved_at, status
      FROM contract_activations
      WHERE project_id = ? AND project_root = ?
    `).get(projectId, realpathSync(projectRoot)) as ActivationRow | undefined;
    return activationFromRow(row);
  } finally {
    database.close();
  }
}

export function readExistingWorkRunStatus(
  dataRoot: string,
  runId: string,
): { run?: PersistedWorkRun; pendingEffect?: PersistedEffectIntent } {
  const databasePath = join(dataRoot, "state.sqlite");
  if (!existsSync(databasePath)) return {};
  const stat = lstatSync(databasePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ShipperError("state database must be a regular non-symlink file", 3);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version < 2) return {};
    const row = database.prepare(`
      SELECT run_id, project_id, contract_digest, work_item_revision, phase, status, state_json, created_at, updated_at
      FROM work_runs WHERE run_id = ?
    `).get(runId) as {
      run_id: string; project_id: string; contract_digest: string; work_item_revision: string;
      phase: string; status: PersistedWorkRun["status"]; state_json: string; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return {};
    const effect = database.prepare(`
      SELECT effect_id, run_id, kind, target, desired_digest, state, intent_json, receipt_json, prepared_at, completed_at
      FROM effect_intents WHERE run_id = ? AND state = 'prepared' ORDER BY prepared_at DESC LIMIT 1
    `).get(runId) as {
      effect_id: string; run_id: string; kind: string; target: string; desired_digest: string;
      state: PersistedEffectIntent["state"]; intent_json: string; receipt_json: string | null;
      prepared_at: string; completed_at: string | null;
    } | undefined;
    return {
      run: {
        runId: row.run_id, projectId: row.project_id, contractDigest: row.contract_digest,
        workItemRevision: row.work_item_revision, phase: row.phase, status: row.status,
        state: JSON.parse(row.state_json) as Record<string, unknown>, createdAt: row.created_at, updatedAt: row.updated_at,
      },
      ...(effect ? { pendingEffect: {
        effectId: effect.effect_id, runId: effect.run_id, kind: effect.kind, target: effect.target,
        desiredDigest: effect.desired_digest, state: effect.state,
        intent: JSON.parse(effect.intent_json) as Record<string, unknown>,
        ...(effect.receipt_json ? { receipt: JSON.parse(effect.receipt_json) as Record<string, unknown> } : {}),
        preparedAt: effect.prepared_at,
        ...(effect.completed_at ? { completedAt: effect.completed_at } : {}),
      } } : {}),
    };
  } finally {
    database.close();
  }
}
