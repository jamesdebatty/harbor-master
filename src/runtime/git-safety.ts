export const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

export const SAFE_GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "core.attributesFile=",
  "-c", "diff.external=",
  "-c", "credential.helper=",
  "-c", "commit.gpgSign=false",
];

/**
 * `worktree` pins GIT_WORK_TREE to it. A per-worktree `config.worktree` can carry a
 * `core.worktree` override that a command-line `-c core.worktree=` does not outrank, so a probe
 * that only sets `cwd` can be answered about a directory it never named. GIT_WORK_TREE outranks
 * that per-worktree config and forces the probe back onto the directory the caller names here,
 * which is ordinarily the same directory it already passed as `cwd`.
 *
 * The worktree parameter takes no default, so every caller states its answer instead of one being
 * assumed for it, and `null` is itself a considered answer rather than an omission: it is reserved for a
 * probe whose job is to let Git *discover* an unknown work tree by walking upward from `cwd` (for
 * example to find whichever repository, possibly a nested one, owns a path). Pinning that probe
 * would tell Git the starting directory already is the top and answer with the input instead of
 * discovering anything, so a call site passing `null` must say in a comment why its probe is a
 * discovery rather than a confirmation. `gitDirectory` is the durable repository identity for an
 * owned worktree. Once captured, passing it prevents a replaced `.git` pointer from changing which
 * index, HEAD, or per-worktree configuration a later operation reads.
 */
export function safeGitEnvironment(worktree: string | null, gitDirectory: string | null = null): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    ...(worktree === null ? {} : { GIT_WORK_TREE: worktree }),
    ...(gitDirectory === null ? {} : { GIT_DIR: gitDirectory }),
  };
}
