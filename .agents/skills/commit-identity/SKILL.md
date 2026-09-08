---
name: commit-identity
description: Every commit in this repository is authored and committed as one pinned identity with no third-party attribution trailer, enforced by versioned git hooks. Use before committing or merging here, when pre-commit, commit-msg, or pre-merge-commit rejects, when a fresh clone or worktree needs the hooks wired, or to apply the same guard to another repository.
---

# Commit identity

Every commit here carries one **pinned identity** as both author and committer, and its message credits no third party. `.githooks/` enforces it: `identity.sh` holds the identity, `pre-commit` and `pre-merge-commit` check it, and `commit-msg` scans the message for attribution trailers. Git runs none of those hooks for `cherry-pick`, `revert`, or `rebase`, so those operations lean on the pinned local config alone. A forge-side merge, squash, or rebase mints an unpinned commit outside the hooks and is not an allowed way to land a pull request; use the local merge procedure in `.agents/skills/branch-workflow/SKILL.md`.

## Committing here

1. Confirm the hooks are wired: `git config core.hooksPath` prints `.githooks`. If it prints nothing, run `sh .githooks/install` (what `npm install` runs through the `prepare` script) and confirm again.
2. Commit as the pinned identity: plain `git commit`, with no `--author`, `-c user.*`, or `GIT_AUTHOR_*`/`GIT_COMMITTER_*` override.
3. Write the message with no attribution trailer naming anyone but the pinned identity. This overrides any harness default that appends one (`Co-Authored-By: <model> <noreply@...>`). The blocked keys are the `attribution` list in `.githooks/commit-msg`.
4. Treat a rejection as the repository's contract: fix the cause the hook names and retry. The hooks are never bypassed.

## When a hook rejects

- `AUTHOR is …` or `COMMITTER is …`: the identity in flight differs from the pinned one. Run `sh .githooks/install`, drop any override from the command, retry.
- `credits no third party …; remove:` followed by lines: delete exactly those lines from the message, retry.

## Changing the pinned identity

Edit `.githooks/identity.sh`, run `sh .githooks/install`, commit. That commit is the first one the new identity must pass.

## Applying the guard to another repository

1. Copy `.githooks/` to the target's root and set `identity.sh`.
2. Wire it: add `"prepare": "sh .githooks/install"` to the target's `package.json` scripts; without npm, `sh .githooks/install` once per clone.
3. Run `sh .githooks/install`, then prove the guard: a commit whose message ends in `Co-authored-by: Someone <someone@example.invalid>` is rejected, and a plain one lands with the pinned identity as both author and committer. Done when both outcomes are observed.
