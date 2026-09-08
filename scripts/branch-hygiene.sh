#!/bin/sh
set -u
cd "$(git rev-parse --show-toplevel)"
git fetch --prune --quiet origin
findings=0
report() { printf 'branch-hygiene: %s\n' "$1" >&2; findings=1; }

settings=$(gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,deleteBranchOnMerge \
  --jq '"merge=\(.mergeCommitAllowed) squash=\(.squashMergeAllowed) rebase=\(.rebaseMergeAllowed) deleteOnMerge=\(.deleteBranchOnMerge)"')
case "$settings" in
  *squash=true*|*rebase=true*) report "repository allows squash or rebase merges, which replace pinned commits with forge-authored ones: $settings" ;;
esac
case "$settings" in
  *deleteOnMerge=false*) report "repository keeps merged head branches: $settings" ;;
esac

pulls=$(gh pr list --state all --limit 200 --json headRefName,state,number,headRefOid \
  --jq '.[] | "\(.headRefName) \(.state) \(.number) \(.headRefOid)"')

worktree_of() {
  git worktree list --porcelain | awk -v ref="refs/heads/$1" '/^worktree /{path=$2} $0=="branch " ref {print path}'
}

for branch in $(git for-each-ref --format='%(refname:short)' refs/heads/ | grep -vx main | grep -v '^release/'); do
  line=$(printf '%s\n' "$pulls" | awk -v b="$branch" '$1==b {print; exit}')
  [ -n "$line" ] || continue
  set -- $line
  state=$2; number=$3; merged_sha=$4
  where="branch $branch"
  wt=$(worktree_of "$branch"); [ -n "$wt" ] && where="$where (worktree $wt)"
  case "$state" in
    MERGED)
      if [ "$(git rev-parse "$branch")" != "$merged_sha" ]; then
        if git merge-base --is-ancestor "$merged_sha" "$branch" 2>/dev/null; then
          report "$where has $(git rev-list --count "$merged_sha..$branch") commit(s) that #$number merged without; replay them onto a branch cut from origin/main"
        else
          report "$where tip differs from the head #$number merged ($(printf %s "$merged_sha" | cut -c1-7)); compare before removing it"
        fi
      fi
      report "$where was merged in #$number; remove it"
      ;;
    CLOSED) report "$where belongs to closed, unmerged #$number; reopen or remove it" ;;
    OPEN)
      if ! upstream=$(git rev-parse --abbrev-ref "$branch@{upstream}" 2>/dev/null); then
        report "$where has open #$number and no upstream; git push -u origin $branch"
      elif [ "$(git rev-list --count "$upstream..$branch")" -gt 0 ]; then
        report "$where is ahead of $upstream by $(git rev-list --count "$upstream..$branch") commit(s); push before asking for a merge"
      fi
      ;;
  esac
done
exit $findings
