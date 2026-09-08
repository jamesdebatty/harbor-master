---
name: branch-workflow
description: How a branch travels from cut to cleanup in this repository so local, origin, and GitHub agree. Use when starting work on a branch or worktree, before asking for a pull request to be merged, after one merges, or when scripts/branch-hygiene.sh reports drift.
---

# Branch workflow

Every branch here is cut from `origin/main`, is reviewed through a pull request whose head is exactly the local tip, lands through a local `--no-ff` merge made by a wired clone, and is removed once merged. GitHub requires at least one pull-request merge method, so merge commits stay enabled as the least harmful fallback: they preserve the pinned branch commits, while squash or rebase would replace them. The merge button remains outside the allowed workflow because its merge commit is forge-authored. `sh scripts/branch-hygiene.sh` reports the ways this has drifted before (commits left unpushed when a pull request merged, squash or rebase left enabled, merged branches and worktrees left behind) and prints nothing when the repository is clean.

## Cut

`git fetch origin`, then `git switch -c <name> --no-track origin/main`; for a worktree, `git worktree add --no-track -b <name> ../graph-shipper-worktrees/<name> origin/main`. Local `main` is only ever fast-forwarded (`git pull --ff-only`); the base is always `origin/main`. Done when `git rev-parse HEAD` equals `git rev-parse origin/main`.

## Work

Push after every commit: `git push -u origin HEAD` the first time, `git push` after that. A commit that exists only locally is the commit the merge will lose. Done when `git status -sb` shows no `ahead`.

## Before asking for a merge

1. `git status -sb` shows neither `ahead` nor a dirty tree.
2. `gh pr view --json headRefOid --jq .headRefOid` equals `git rev-parse HEAD`.
3. `sh scripts/branch-hygiene.sh` prints nothing about this branch.

Do not use a GitHub merge button. Every forge-side method creates a commit whose author or committer is outside the pinned identity contract.

## Merge

Only proceed with fresh human authorization to merge and push. From the primary clone:

1. Run `sh .githooks/install`, then confirm `git config core.hooksPath` prints `.githooks`.
2. Run `git fetch origin`, `git switch main`, and `git pull --ff-only`.
3. Run `git merge --no-ff --no-edit <branch>`. The versioned `pre-merge-commit` and `commit-msg` hooks must pass; never bypass them.
4. Run `git show -s --format='%an <%ae>%n%cn <%ce>' HEAD` and confirm both lines equal the identity in `.githooks/identity.sh`.
5. Run `git push origin main`. Never force-push `main`; if the push is rejected, stop and reconcile the new remote tip before retrying the merge.

The pushed merge commit makes GitHub mark the pull request merged without asking the forge to mint a commit.

## After a merge

From the primary clone: `git switch main && git pull --ff-only`, then `git worktree remove ../graph-shipper-worktrees/<name>` if one exists, `git branch -d <name>`, and `git fetch --prune`. Done when `sh scripts/branch-hygiene.sh` prints nothing.

## When branch-hygiene reports

- `… commit(s) that #n merged without`: that work is not on `main`. Cut a branch from `origin/main`, `git cherry-pick` those commits onto it, push, open a pull request.
- `… was merged in #n; remove it`: run the after-merge steps. `git branch -D` is safe once the tip equals the merged head or its commits live on another pushed branch.
- `… tip differs from the head #n merged`: `git log <merged-head>..<branch>` and `git diff` before removing anything.
- `… ahead of … by N` / `no upstream`: push.
- `repository allows squash or rebase merges` / `keeps merged head branches`: `gh repo edit --enable-merge-commit --enable-squash-merge=false --enable-rebase-merge=false --delete-branch-on-merge`.
