import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, posix, resolve, sep } from "node:path";
import { SAFE_GIT_CONFIG, safeGitEnvironment } from "../runtime/git-safety.js";
import type { ProjectContract } from "./schema.js";

type Command = ProjectContract["commands"][number];

export const LOCAL_ONLY_BUILTIN_MODULES = [
  "node:assert", "node:assert/strict", "node:buffer", "node:crypto", "node:events",
  "node:fs", "node:fs/promises", "node:os", "node:path", "node:process",
  "node:querystring", "node:stream", "node:string_decoder", "node:url", "node:util", "node:zlib",
] as const;
const localOnlyBuiltinModules = new Set<string>(LOCAL_ONLY_BUILTIN_MODULES);

export function canonicalAuthorizationSource(path: string): string {
  return path.replace(/^\.\//, "");
}

export function authorizationSourceErrors(command: Command): string[] {
  const errors: string[] = [];
  const sources = command.authorizationSources.map(canonicalAuthorizationSource);
  const seen = new Set<string>();
  for (let index = 0; index < command.authorizationSources.length; index += 1) {
    const source = command.authorizationSources[index] ?? "";
    const canonical = sources[index] ?? "";
    const unsafe = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(source)
      || source.includes("\\")
      || /[\0\r\n]/.test(source)
      || source.split("/").includes("..")
      || canonical !== posix.normalize(canonical)
      || canonical === ".git"
      || canonical.startsWith(".git/")
      || canonical === ".graph-shipper/project.yaml";
    if (unsafe) errors.push(`${command.id}: unsafe authorization source ${source}`);
    if (seen.has(canonical)) errors.push(`${command.id}: duplicate authorization source ${canonical}`);
    seen.add(canonical);
  }
  const entryScript = canonicalAuthorizationSource(command.argv[1] ?? "");
  if (command.argv[0] === "node" && entryScript && !sources.includes(entryScript)) {
    errors.push(`${command.id}: direct Node script ${entryScript} must appear in authorizationSources`);
  }
  return errors;
}

function localDependencyPath(projectRoot: string, sourcePath: string, specifier: string): string | null {
  const base = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (base === ".." || base.startsWith("../") || isAbsolute(base)) return null;
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.cjs`];
  return candidates.find((candidate) => {
    const absolute = resolve(projectRoot, candidate);
    return existsSync(absolute) && lstatSync(absolute).isFile() && !lstatSync(absolute).isSymbolicLink();
  }) ?? base;
}

interface JavaScriptToken {
  kind: "identifier" | "string" | "punctuation";
  value: string;
}

function tokenizeCommandSource(source: string): { tokens: JavaScriptToken[]; errors: string[] } {
  const tokens: JavaScriptToken[] = [];
  const errors: string[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        errors.push("unterminated block comment");
        break;
      }
      index = end + 2;
      continue;
    }
    if (character === "`") {
      errors.push("template literals are outside the statically inspectable command-source boundary");
      break;
    }
    if (character === "\\") {
      errors.push("escape outside a string or comment is outside the statically inspectable command-source boundary");
      break;
    }
    if (character === "\"" || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      let terminated = false;
      while (index < source.length) {
        const item = source[index] ?? "";
        if (item === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) break;
          value += `\\${escaped}`;
          index += 2;
          continue;
        }
        if (item === quote) {
          terminated = true;
          index += 1;
          break;
        }
        value += item;
        index += 1;
      }
      if (!terminated) errors.push("unterminated string literal");
      tokens.push({ kind: "string", value });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? "")) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", value: character });
    index += 1;
  }
  return { tokens, errors };
}

function dependencySpecifiers(source: string): { specifiers: string[]; errors: string[] } {
  const parsed = tokenizeCommandSource(source);
  const specifiers: string[] = [];
  const errors = [...parsed.errors];
  const { tokens } = parsed;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "identifier" || !["import", "export", "require"].includes(token.value)) continue;
    const next = tokens[index + 1];
    if (token.value === "import" && next?.value === "." && tokens[index + 2]?.value === "meta") {
      index += 2;
      continue;
    }
    if (token.value === "require" || next?.value === "(") {
      const argument = next?.value === "(" ? tokens[index + 2] : next;
      const close = next?.value === "(" ? tokens[index + 3] : undefined;
      if (argument?.kind !== "string" || (next?.value === "(" && close?.value !== ")")) {
        errors.push(`${token.value} must use exactly one string-literal module specifier`);
      } else specifiers.push(argument.value);
      continue;
    }
    if (next?.kind === "string") {
      specifiers.push(next.value);
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor]?.value !== ";" && tokens[cursor]?.value !== "from") cursor += 1;
    if (tokens[cursor]?.value === "from") {
      const specifier = tokens[cursor + 1];
      if (specifier?.kind !== "string") errors.push(`${token.value} from must use a string-literal module specifier`);
      else specifiers.push(specifier.value);
    } else if (token.value === "import") errors.push("unsupported import syntax");
  }
  return { specifiers, errors };
}

/**
 * The closure walk skips a source it cannot read, so without this a command naming a script
 * nobody has written yet validates cleanly and fails at onboarding instead. That is the shape the
 * template hands a human, so it is refused where they are authoring.
 */
export function authorizationSourcePresenceErrors(command: Command, projectRoot: string): string[] {
  const errors: string[] = [];
  for (const source of new Set(command.authorizationSources.map(canonicalAuthorizationSource))) {
    if (source === "" || source === ".." || source.startsWith("../") || isAbsolute(source)) continue;
    let contained = false;
    try {
      const absolute = resolve(projectRoot, source);
      const stat = lstatSync(absolute);
      const real = realpathSync(absolute);
      const root = realpathSync(projectRoot);
      let cursor = resolve(projectRoot);
      const traversesSymlink = source.split("/").some((segment) => {
        cursor = resolve(cursor, segment);
        return lstatSync(cursor).isSymbolicLink();
      });
      contained = stat.isFile() && !traversesSymlink && real.startsWith(`${root}${sep}`);
    } catch {
      contained = false;
    }
    if (!contained) errors.push(`${command.id}: authorization source ${source} is not a regular file in the project`);
  }
  return errors;
}

/**
 * Within a Git repository, a source must belong to that repository and be either tracked or
 * eligible for `git add` under repository-owned ignore rules. Operator-global Git configuration
 * is scrubbed. Outside a repository there is no committed base to compare against.
 */
export function authorizationSourceCommitEligibilityErrors(command: Command, projectRoot: string): string[] {
  const errors: string[] = [];
  // Pinned, not a discovery probe despite the --show-toplevel: projectRoot is the operator's
  // declared primary clone (checked elsewhere against the activated contract), so this treats it
  // as the trusted repository boundary rather than asking Git to find one. The exposure a pin
  // would otherwise create in a true discovery probe does not apply here, and leaving this
  // unpinned would instead let a corrupted config.worktree substitute a decoy for
  // repositoryRoot, which every source below is then, incorrectly, checked against.
  const repository = spawnSync("git", [...SAFE_GIT_CONFIG, "rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: safeGitEnvironment(projectRoot),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (repository.error) {
    return [`${command.id}: Git is unavailable, so authorization source commit eligibility cannot be checked`];
  }
  if (repository.status !== 0) {
    return [`${command.id}: Git could not inspect the project repository while checking authorization sources`];
  }
  let repositoryRoot: string;
  try {
    repositoryRoot = realpathSync(repository.stdout.trim());
  } catch {
    return [`${command.id}: Git returned an invalid project repository root while checking authorization sources`];
  }
  for (const source of new Set(command.authorizationSources.map(canonicalAuthorizationSource))) {
    if (source === "" || source === ".." || source.startsWith("../") || isAbsolute(source)) continue;
    const absolute = resolve(projectRoot, source);
    if (!existsSync(absolute)) continue;
    // null on purpose: this walks upward from the source's own directory to discover whichever
    // repository owns it, which may legitimately be a nested one with its own toplevel above
    // `dirname(absolute)`. Pinning GIT_WORK_TREE here would tell Git that directory already is
    // the top, which answers a different question than the one being asked and flags every
    // source outside the project root's own directory as belonging to a nested repository.
    const owner = spawnSync("git", [...SAFE_GIT_CONFIG, "rev-parse", "--show-toplevel"], {
      cwd: dirname(absolute),
      encoding: "utf8",
      env: safeGitEnvironment(null),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (owner.error || owner.status !== 0) {
      errors.push(`${command.id}: Git could not determine the repository that owns authorization source ${source}`);
      continue;
    }
    let ownerRoot: string;
    try {
      ownerRoot = realpathSync(owner.stdout.trim());
    } catch {
      errors.push(`${command.id}: Git returned an invalid repository root for authorization source ${source}`);
      continue;
    }
    if (ownerRoot !== repositoryRoot) {
      errors.push(`${command.id}: authorization source ${source} belongs to a nested Git repository`);
      continue;
    }
    const tracked = spawnSync("git", [...SAFE_GIT_CONFIG, "ls-files", "--error-unmatch", "--", source], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: safeGitEnvironment(repositoryRoot),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (tracked.error || ![0, 1].includes(tracked.status ?? -1)) {
      errors.push(`${command.id}: Git failed while checking whether authorization source ${source} is tracked`);
      continue;
    }
    if (tracked.status === 0) continue;
    const ignored = spawnSync("git", [...SAFE_GIT_CONFIG, "check-ignore", "-q", "--", source], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: safeGitEnvironment(repositoryRoot),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (ignored.error || ![0, 1].includes(ignored.status ?? -1)) {
      errors.push(`${command.id}: Git failed while checking whether authorization source ${source} is ignored`);
    } else if (ignored.status === 0) {
      errors.push(`${command.id}: authorization source ${source} is ignored by git, so the committed base cannot carry it`);
    }
  }
  return errors;
}

export function authorizationSourceClosureErrors(command: Command, projectRoot: string): string[] {
  const errors: string[] = [];
  const declared = new Set(command.authorizationSources.map(canonicalAuthorizationSource));
  for (const sourcePath of declared) {
    if (!/\.(?:mjs|cjs|js)$/.test(sourcePath)) continue;
    const absolute = resolve(projectRoot, sourcePath);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) continue;
    const source = readFileSync(absolute, "utf8");
    const dependencies = dependencySpecifiers(source);
    errors.push(...dependencies.errors.map((error) => `${command.id}: ${sourcePath}: ${error}`));
    for (const specifier of dependencies.specifiers) {
      if (!specifier.startsWith(".")) {
        if (!specifier.startsWith("node:")) {
          errors.push(`${command.id}: bare package import ${specifier} is outside the local-only command authorization-source boundary`);
        } else if (!localOnlyBuiltinModules.has(specifier)) {
          errors.push(`${command.id}: built-in ${specifier} has no admitted local-only command capability`);
        }
        continue;
      }
      const dependency = localDependencyPath(projectRoot, sourcePath, specifier);
      if (!dependency || !declared.has(dependency)) {
        errors.push(`${command.id}: undeclared local command dependency ${dependency ?? specifier} imported by ${sourcePath}`);
      }
    }
  }
  return errors;
}

const WRAPPER_EXECUTABLES = new Set([
  "env", "sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh",
  "npx", "pnpx", "bunx", "dlx", "xargs", "sudo", "doas", "nohup", "time", "nice", "eval", "exec",
]);
// Interpreter modes that take a program on the command line. Deliberately
// excludes `-p`/`--print`: those mean eval only for node, whose commands are
// already constrained to a relative script as argv[1], while other tools use
// `-p` for unrelated things (`tsc -p tsconfig.json` selects a project).
const EVAL_ARGUMENTS = new Set(["-c", "--command", "-e", "--eval", "--exec"]);

function normalizedBase(executable: string): string {
  const base = executable.split(/[\\/]/).pop() ?? executable;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, "");
}

export function admittedExecutableErrors(entry: { id: string; argvPrefix: string[] }): string[] {
  const errors: string[] = [];
  const base = normalizedBase(entry.argvPrefix[0] ?? "");
  if (WRAPPER_EXECUTABLES.has(base)) {
    errors.push(`${entry.id}: ${base} is a wrapper and cannot be admitted as an executable`);
  }
  if (entry.argvPrefix.some((argument) => EVAL_ARGUMENTS.has(argument))) {
    errors.push(`${entry.id}: interpreter eval modes cannot be admitted`);
  }
  if (entry.argvPrefix.some((argument) => /\{[a-z_]+\}/.test(argument))) {
    errors.push(`${entry.id}: argvPrefix must be literal; placeholders defeat exact prefix pinning`);
  }
  return errors;
}

export function localOnlyCommandShapeErrors(
  command: Command,
  executableAllowlist: ReadonlyArray<{ id: string; argvPrefix: string[] }>,
): string[] {
  const errors: string[] = [];
  const executableArgument = command.argv[0] ?? "";
  if (executableArgument !== "node") {
    const admitted = executableAllowlist.find((entry) =>
      entry.argvPrefix.every((argument, index) => command.argv[index] === argument));
    if (!admitted) {
      errors.push(`${command.id}: ${executableArgument} is not admitted by the contract executable allowlist`);
    }
  }
  const nodeScript = command.argv[1] ?? "";
  if (executableArgument === "node" && (
    !/^(?!-)(?:\.\/)?[A-Za-z0-9_./-]+\.(?:mjs|cjs|js)$/.test(nodeScript)
    || isAbsolute(nodeScript)
    || nodeScript.split(/[\\/]/).includes("..")
  )) {
    errors.push(`${command.id}: Node commands must name one relative digest-bound script as argv[1]`);
  }
  if (executableArgument !== "node" && command.argv.some((argument) => EVAL_ARGUMENTS.has(argument))) {
    errors.push(`${command.id}: interpreter eval modes cannot be invoked by an admitted command`);
  }
  if (command.argv.some((argument) => argument.includes("\0") || argument.includes("\n") || argument.includes("\r"))) {
    errors.push(`${command.id}: argv contains a NUL or newline`);
  }
  return errors;
}

/**
 * Names whose value is a network endpoint. Split out because it is the only group where an
 * `@` can be userinfo: a path-valued name carrying one is a filename, and the execution-time
 * check needs to know which reading applies. Values are endpoints, not secrets; a proxy that
 * demands credentials in the URL is a credential and belongs to the broker.
 */
export const ENDPOINT_VALUED_ENVIRONMENT = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NPM_CONFIG_REGISTRY",
]);

const ADMITTED_ENVIRONMENT = new Set([
  "CI", "TZ", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "LC_NUMERIC", "LC_TIME", "COLUMNS", "LINES",
  ...ENDPOINT_VALUED_ENVIRONMENT,
  // TLS trust roots for a non-Node tool a package script shells out to. Node itself reads
  // NODE_EXTRA_CA_CERTS, which is refused, so these do not make npm trust an intercepting
  // proxy; that case still needs an .npmrc cafile.
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NPM_CONFIG_AUDIT", "NPM_CONFIG_FUND", "NPM_CONFIG_UPDATE_NOTIFIER",
  "NODE_ENV",
]);

/** Variables the runtime owns outright; a contract may not redirect or shadow them. */
export const RUNTIME_OWNED_ENVIRONMENT = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USERPROFILE"]);

export function environmentPasslistErrors(command: { id: string; environmentPasslist: string[] }): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const name of command.environmentPasslist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`${command.id}: ${name} is not a portable environment variable name`);
      continue;
    }
    // Windows folds environment names case-insensitively, so screen the folded name or a
    // contract could ship two spellings of a variable the runtime is meant to own.
    if (RUNTIME_OWNED_ENVIRONMENT.has(name.toUpperCase())) {
      errors.push(`${command.id}: ${name} is runtime-owned and cannot be passed from the operator environment`);
      continue;
    }
    if (!ADMITTED_ENVIRONMENT.has(name)) {
      errors.push(`${command.id}: ${name} is not admissible in an environment passlist; credentials, credential locations, and loader controls reach commands only through the Credential Broker or not at all`);
      continue;
    }
    if (seen.has(name)) errors.push(`${command.id}: duplicate environment passlist entry ${name}`);
    seen.add(name);
  }
  return errors;
}
