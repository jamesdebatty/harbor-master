import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VERSION } from "../version.js";

export interface RuntimeDiagnostics {
  ok: true;
  version: string;
  nodeVersion: string;
  dataRoot: string;
  state: { present: boolean; schemaVersion: number | null };
  security: {
    credentials: "opaque_references_only";
    authority: "typed_leases_only";
    persistenceRedaction: true;
  };
  capabilities: {
    plan: true;
    edit: true;
    push: true;
    pullRequest: true;
    merge: true;
    postMergeHooks: true;
  };
}

function inspectState(dataRoot: string): RuntimeDiagnostics["state"] {
  const databasePath = join(dataRoot, "state.sqlite");
  if (!existsSync(databasePath)) return { present: false, schemaVersion: null };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = database.prepare("PRAGMA user_version").get() as { user_version: number };
    return { present: true, schemaVersion: Number(result.user_version) };
  } finally {
    database.close();
  }
}

export function collectRuntimeDiagnostics(dataRoot: string): RuntimeDiagnostics {
  return {
    ok: true,
    version: VERSION,
    nodeVersion: process.version,
    dataRoot,
    state: inspectState(dataRoot),
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
  };
}
