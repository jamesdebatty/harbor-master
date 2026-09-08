import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistenceRedactor } from "../security/redact.js";

const RunId = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface TraceEvent {
  eventType: string;
  payload: unknown;
  at?: string;
}

export class JsonlTraceWriter {
  constructor(
    readonly traceRoot: string,
    readonly redactor: PersistenceRedactor,
  ) {}

  append(runId: string, event: TraceEvent): string {
    if (!RunId.test(runId)) throw new Error("run ID contains unsafe characters");
    mkdirSync(this.traceRoot, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(this.traceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("trace root must be a real directory");
    chmodSync(this.traceRoot, 0o700);
    const path = join(this.traceRoot, `${runId}.jsonl`);
    const record = this.redactor.redact({
      at: event.at ?? new Date().toISOString(),
      runId,
      eventType: event.eventType,
      payload: event.payload,
    });
    const descriptor = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, `${this.redactor.serialize(record)}\n`, { encoding: "utf8" });
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return path;
  }
}
