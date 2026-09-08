# Graph Shipper

This repository owns the standalone Shipper Runtime. Target projects supply a
credential-free `.graph-shipper/project.yaml`; they do not vendor this runtime.

## Hard boundaries

- Project policy, gates, commands, hooks, and documentation classifications are
  human-authored contract data. Models never infer or expand them.
- Runtime state, activations, checkpoints, traces, and credentials stay outside
  target repositories and their primary clones.
- Never expose credentials to a model, generic action executor, trace, error,
  contract, or target-repository diff.
- Outward mutations require typed adapters and an Authority Lease. There is no
  raw shell, `gh`, REST, or GraphQL escape hatch.
- Contract edits invalidate activation and require human re-onboarding.
- Do not add a Git remote, publish a package, push, or run a live canary without
  the maintainer's explicit authorization.

## Development

Use public CLI seams for Work Run behavior and the exported adapter APIs for
injected transport conformance. Work test-first in small vertical slices. Run
`npm run verify` before reporting a slice complete.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `jamesdebatty/harbormaster`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` plus `docs/adr/`. See `docs/agents/domain.md`.

### Commit identity

Every commit is authored and committed as one pinned identity with no third-party attribution trailer; `.githooks/` enforces it. See `.agents/skills/commit-identity/SKILL.md`.

### Branch workflow

Cut from `origin/main`, push every branch commit before a merge, land approved heads with a local `--no-ff` merge and direct push to `main`, then remove the branch and worktree; `sh scripts/branch-hygiene.sh` prints nothing when local, origin, and GitHub agree. See `.agents/skills/branch-workflow/SKILL.md`.
