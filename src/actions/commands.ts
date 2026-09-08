import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProjectContract } from "../contracts/schema.js";
import {
  authorizationSourceClosureErrors, authorizationSourceErrors, canonicalAuthorizationSource,
  ENDPOINT_VALUED_ENVIRONMENT, environmentPasslistErrors, LOCAL_ONLY_BUILTIN_MODULES,
  localOnlyCommandShapeErrors,
} from "../contracts/command-shape.js";
import { ShipperError } from "../errors.js";
import { safeGitEnvironment } from "../runtime/git-safety.js";
import { monitorIsolatedCommand, type IsolatedCommandInvocation } from "./isolated-process.js";

export type Command = ProjectContract["commands"][number];

export interface CommandResult {
  commandId: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRoots = {
  runtime: string;
  project_root: string;
  worktree: string;
  worktreeGitDirectory: string;
  synced_main: string;
  deadlineAt?: string;
};

function validateParameter(value: string, policy: Command["parameters"][string], runtimeDataRoot?: string): string | null {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return "contains NUL or newline";
  if (value.startsWith("-")) return "dynamic argv value may not begin with '-'";
  if (value.split(/[\\/]/).includes("..")) return "path traversal is forbidden";
  switch (policy.type) {
    case "positive_integer":
      return /^[1-9][0-9]*$/.test(value) ? null : "must be a positive integer";
    case "git_sha":
      return /^[0-9a-f]{40}$/.test(value) ? null : "must be a full lowercase Git SHA";
    case "absolute_path": {
      if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return "must be an absolute path";
      const normalized = resolve(value);
      if (value.split(/[\\/]/).includes("..")) return "path traversal is forbidden";
      if (policy.pathRoot) {
        const root = resolve(policy.pathRoot === "runtime_data" && runtimeDataRoot ? runtimeDataRoot : policy.pathRoot);
        if (normalized !== root && !normalized.startsWith(`${root}/`)) return `must remain under ${root}`;
      }
      return null;
    }
    case "opaque_id":
      return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? null : "contains characters outside the opaque-id grammar";
  }
}

export function commandIsolationBootstrap(command: Command, worktree: string): string {
  const allowedFiles = command.authorizationSources.map((path) => realpathSync(resolve(worktree, canonicalAuthorizationSource(path))));
  const policy = Buffer.from(JSON.stringify({ allowedFiles, allowedBuiltins: LOCAL_ONLY_BUILTIN_MODULES }), "utf8").toString("base64");
  const source = [
    `const policy=JSON.parse(Buffer.from(${JSON.stringify(policy)},"base64").toString("utf8"));`,
    'const moduleApi=process.getBuiltinModule("node:module");',
    'const urlApi=process.getBuiltinModule("node:url");',
    'const fsApi=process.getBuiltinModule("node:fs");',
    "const allowedFiles=new Set(policy.allowedFiles);",
    "const allowedBuiltins=new Set(policy.allowedBuiltins);",
    "moduleApi.registerHooks({resolve(specifier,context,nextResolve){",
    "const result=nextResolve(specifier,context);",
    'if(result.url.startsWith("node:")){if(!allowedBuiltins.has(result.url))throw new Error(`Graph Shipper denied built-in module ${result.url}`);return result;}',
    'if(result.url.startsWith("file:")){const path=fsApi.realpathSync(urlApi.fileURLToPath(result.url));if(!allowedFiles.has(path))throw new Error(`Graph Shipper denied undeclared command source ${path}`);return result;}',
    'throw new Error(`Graph Shipper denied command module URL ${result.url}`);',
    "}});",
    'for(const key of ["fetch","WebSocket","EventSource"]){Reflect.deleteProperty(globalThis,key);}',
    'for(const key of ["getBuiltinModule","binding","_linkedBinding","dlopen","execve","kill","_kill","_debugProcess","_debugEnd","setuid","seteuid","setgid","setegid","setgroups","initgroups"]){Reflect.deleteProperty(process,key);}',
  ].join("\n");
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

export function renderCommand(command: Command, values: Record<string, string>, runtimeDataRoot?: string): string[] {
  const rendered: string[] = [];
  const used = new Set<string>();
  const errors: string[] = [];
  for (const argument of command.argv) {
    const placeholders = argument.match(/\{[a-z_]+\}/g) ?? [];
    if (placeholders.length === 0) {
      rendered.push(argument);
      continue;
    }
    if (placeholders.length !== 1 || argument !== placeholders[0]) {
      errors.push(`${command.id}: placeholders must occupy a whole argv element: ${argument}`);
      continue;
    }
    const name = placeholders[0].slice(1, -1);
    const policy = command.parameters[name];
    const value = values[name];
    used.add(name);
    if (!policy) errors.push(`${command.id}: undeclared placeholder ${name}`);
    else if (value === undefined) errors.push(`${command.id}: missing value for ${name}`);
    else {
      const invalid = validateParameter(value, policy, runtimeDataRoot);
      if (invalid) errors.push(`${command.id}: ${name} ${invalid}`);
      else rendered.push(value);
    }
  }
  for (const supplied of Object.keys(values)) {
    if (!used.has(supplied)) errors.push(`${command.id}: unused supplied value ${supplied}`);
  }
  if (errors.length > 0) throw new ShipperError("typed command substitution failed", 3, errors);
  return rendered;
}

export function prepareIsolatedCommand(
  command: Command,
  values: Record<string, string>,
  roots: CommandRoots,
  runtimeDataRoot?: string,
): IsolatedCommandInvocation & { authorizationRoot: string } {
  const authorizationRoot = roots[command.cwd];
  const argv = renderCommand(command, values, runtimeDataRoot);
  const [executable, ...args] = argv;
  if (!executable) throw new ShipperError(`${command.id}: executable is missing`, 3);
  return {
    commandId: command.id,
    argv,
    executable,
    args: executable === "node" ? ["--import", commandIsolationBootstrap(command, authorizationRoot), ...args] : args,
    cwd: roots[command.cwd],
    timeoutSeconds: command.timeoutSeconds,
    ...(roots.deadlineAt ? { deadlineAt: roots.deadlineAt } : {}),
    authorizationRoot,
  };
}

function carriesUserinfo(value: string): boolean {
  for (const token of value.split(/[,\s]+/)) {
    if (!token) continue;
    const scheme = token.indexOf("://");
    const rest = scheme === -1 ? token : token.slice(scheme + 3);
    const end = rest.search(/[/?#]/);
    if ((end === -1 ? rest : rest.slice(0, end)).includes("@")) return true;
  }
  return false;
}

/**
 * Endpoint-valued passlist entries whose ambient value carries userinfo. Reported rather than
 * thrown so the same reading serves both callers: the sweep at Work Run construction, which
 * fails closed before any outward mutation, and the execution-time check, which is the one
 * that is authoritative because the environment can change mid-run.
 */
export function environmentValueErrors(command: { id: string; environmentPasslist: string[] }): string[] {
  return command.environmentPasslist.flatMap((name) => {
    const value = process.env[name];
    return value !== undefined && ENDPOINT_VALUED_ENVIRONMENT.has(name) && carriesUserinfo(value)
      ? [`${command.id}: ${name} carries userinfo in an endpoint; credentials reach commands only through the Credential Broker`]
      : [];
  });
}

/**
 * Where a declared command's ambient toolchain state lives. The home is per project so a
 * package-manager cache survives between Work Runs; the temporary directory is per run so
 * nothing leaks across them. Both sit under the private data root, never in a target repository.
 */
export interface CommandEnvironmentContext {
  dataRoot: string;
  projectId: string;
  runId: string;
}

export class ActivatedCommandRegistry {
  readonly commands: ReadonlyMap<string, Command>;
  readonly protectedProjectPaths: ReadonlySet<string>;
  readonly authorizationSourceDigests: ReadonlyMap<string, string>;

  readonly #environment: CommandEnvironmentContext | undefined;

  constructor(contract: ProjectContract, projectRoot?: string, environment?: CommandEnvironmentContext) {
    this.#environment = environment;
    this.commands = new Map(contract.commands.map((command) => [command.id, command]));
    const protectedProjectPaths = new Set<string>();
    const errors: string[] = [];
    for (const command of contract.commands) {
      errors.push(...localOnlyCommandShapeErrors(command, contract.executableAllowlist));
      errors.push(...environmentPasslistErrors(command));
      errors.push(...authorizationSourceErrors(command));
      if (projectRoot) errors.push(...authorizationSourceClosureErrors(command, projectRoot));
      for (const source of command.authorizationSources) protectedProjectPaths.add(canonicalAuthorizationSource(source));
    }
    if (errors.length > 0) throw new ShipperError("activated command allowlist is unsafe", 3, errors);
    this.protectedProjectPaths = protectedProjectPaths;
    const sourceDigests = new Map<string, string>();
    if (projectRoot) {
      for (const path of protectedProjectPaths) {
        const absolute = resolve(projectRoot, path);
        if (!existsSync(absolute)) {
          if (/^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(path)) continue;
          throw new ShipperError(`command authorization source is missing: ${path}`, 3);
        }
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ShipperError(`command authorization source must be a regular file: ${path}`, 3);
        sourceDigests.set(path, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
      }
    }
    this.authorizationSourceDigests = sourceDigests;
  }

  assertMutablePath(path: string): void {
    if (this.protectedProjectPaths.has(path.replace(/^\.\//, ""))) {
      throw new ShipperError(`command authorization source is protected: ${path}`, 3);
    }
  }

  get(commandId: string): Command {
    const command = this.commands.get(commandId);
    if (!command) throw new ShipperError(`command ${commandId} is not in the activated allowlist`, 3);
    return command;
  }

  assertAuthorizationSourcesUnchanged(worktree: string): void {
    for (const [path, expectedDigest] of this.authorizationSourceDigests) {
      const absolute = resolve(worktree, path);
      if (!existsSync(absolute)) throw new ShipperError(`command authorization source disappeared: ${path}`, 4);
      const stat = lstatSync(absolute);
      const observedDigest = !stat.isFile() || stat.isSymbolicLink()
        ? "invalid"
        : createHash("sha256").update(readFileSync(absolute)).digest("hex");
      if (observedDigest !== expectedDigest) throw new ShipperError(`command authorization source changed after activation: ${path}`, 4);
    }
  }

  async execute(
    commandId: string,
    values: Record<string, string>,
    roots: CommandRoots,
  ): Promise<CommandResult> {
    const command = this.get(commandId);
    if (command.credentialRefs.length > 0) throw new ShipperError(`${command.id}: local-only commands cannot acquire credentials`, 3);
    return await this.executeIsolated(command, values, roots, this.childEnvironment(command, roots));
  }

  /**
   * The whole ambient surface a declared command gets: PATH, a runtime-owned home and
   * temporary directory, and the variable names its contract declares. Nothing else from
   * the operator environment crosses, and no value here is ever persisted.
   */
  childEnvironment(command: Command, roots: CommandRoots): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "" };
    if (command.cwd === "worktree" && command.sideEffect === "none") {
      // Give pure gates Git's safe defaults (no global/system config, no prompts) but never
      // export GIT_DIR/GIT_WORK_TREE to them: a gate is an arbitrary program, and a test suite
      // that runs `git init`/`git config` in its own temporary repositories would be redirected
      // onto the owned worktree's Git directory, whose config is shared with the primary clone.
      // Observed 2026-08-31: a pytest gate wrote core.worktree and a test identity into the
      // primary clone's .git/config. The runtime's own probes keep their pins.
      Object.assign(environment, safeGitEnvironment(null));
    }
    if (this.#environment) {
      const home = join(resolve(this.#environment.dataRoot), "tool-home", this.#environment.projectId);
      const temporary = join(resolve(this.#environment.dataRoot), "tmp", this.#environment.runId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mkdirSync(temporary, { recursive: true, mode: 0o700 });
      environment.HOME = home;
      environment.USERPROFILE = home;
      environment.TMPDIR = temporary;
      environment.TMP = temporary;
      environment.TEMP = temporary;
    }
    const refused = environmentValueErrors(command);
    if (refused.length > 0) throw new ShipperError(refused[0]!, 3);
    for (const name of command.environmentPasslist) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    return environment;
  }

  private async executeIsolated(
    command: Command,
    values: Record<string, string>,
    roots: CommandRoots,
    environment: NodeJS.ProcessEnv,
    runtimeDataRoot?: string,
  ): Promise<CommandResult> {
    const invocation = prepareIsolatedCommand(command, values, roots, runtimeDataRoot);
    this.assertAuthorizationSourcesUnchanged(invocation.authorizationRoot);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return await monitorIsolatedCommand(
      child,
      invocation,
      () => this.assertAuthorizationSourcesUnchanged(invocation.authorizationRoot),
    );
  }
}
