import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { ShipperError } from "../errors.js";

export interface IsolatedCommandInvocation {
  commandId: string;
  argv: string[];
  executable: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
  deadlineAt?: string;
}

export interface IsolatedCommandResult {
  commandId: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes?: Buffer;
}

export interface CapturedIsolatedCommandResult extends IsolatedCommandResult {
  stdoutBytes: Buffer;
}

type MonitoredChild = ChildProcessByStdio<null, Readable, Readable>;

/** Credential-blind process supervision shared by local and typed operational callers. */
export function monitorIsolatedCommand(
  child: MonitoredChild,
  invocation: IsolatedCommandInvocation,
  verifyAuthorizationSources: () => void,
  captureStdoutBytes: true,
): Promise<CapturedIsolatedCommandResult>;
export function monitorIsolatedCommand(
  child: MonitoredChild,
  invocation: IsolatedCommandInvocation,
  verifyAuthorizationSources: () => void,
  captureStdoutBytes?: false,
): Promise<IsolatedCommandResult>;
export async function monitorIsolatedCommand(
  child: MonitoredChild,
  invocation: IsolatedCommandInvocation,
  verifyAuthorizationSources: () => void,
  captureStdoutBytes = false,
): Promise<IsolatedCommandResult> {
  return await new Promise<IsolatedCommandResult>((resolveResult, reject) => {
    let stdout = "";
    let stdoutByteLength = 0;
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    let stderrByteLength = 0;
    let exceededBuffer = false;
    let exceededTimeout = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const killTree = (signal: NodeJS.Signals): void => {
      if (!child.pid || child.exitCode !== null) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch { child.kill(signal); }
    };
    const terminate = (): void => {
      killTree("SIGTERM");
      forceKill ??= setTimeout(() => killTree("SIGKILL"), 2_000);
    };
    const append = (current: string, currentBytes: number, chunk: Buffer): string => {
      if (currentBytes + chunk.byteLength > 4 * 1024 * 1024) {
        exceededBuffer = true;
        terminate();
        return current;
      }
      return current + chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, stdoutByteLength, chunk);
      stdoutByteLength += chunk.byteLength;
      if (captureStdoutBytes && stdoutByteLength <= 4 * 1024 * 1024) stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, stderrByteLength, chunk);
      stderrByteLength += chunk.byteLength;
    });
    const remaining = invocation.deadlineAt
      ? Date.parse(invocation.deadlineAt) - Date.now()
      : Number.POSITIVE_INFINITY;
    if (remaining <= 0) {
      terminate();
      reject(new ShipperError(`${invocation.commandId}: Work Run wall-clock budget exhausted`, 3));
      return;
    }
    const timeout = setTimeout(() => {
      exceededTimeout = true;
      terminate();
    }, Math.min(invocation.timeoutSeconds * 1000, remaining));
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(new ShipperError(`${invocation.commandId}: execution failed`, 3, [error.message]));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (exceededBuffer) {
        reject(new ShipperError(`${invocation.commandId}: output exceeded the 4 MiB evidence limit`, 3));
        return;
      }
      if (exceededTimeout) {
        reject(new ShipperError(`${invocation.commandId}: execution exceeded its timeout`, 3));
        return;
      }
      try { verifyAuthorizationSources(); } catch (error) { reject(error); return; }
      resolveResult({
        commandId: invocation.commandId,
        argv: invocation.argv,
        exitCode: code ?? 1,
        stdout,
        stderr: signal ? `${stderr}${stderr ? "\n" : ""}terminated by ${signal}` : stderr,
        ...(captureStdoutBytes ? { stdoutBytes: Buffer.concat(stdoutChunks) } : {}),
      });
    });
  });
}
