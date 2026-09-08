# Graph Shipper

> Repository renamed from `graph-shipper` to `harbormaster` on 2026-09-01. The product, CLI, and `.graph-shipper/` contract paths still carry the old name.

Graph Shipper is a standalone, provider-portable runtime for human-onboarded
agentic build flows. Version 0.3.0 runs the recoverable `local_only` graph with
either Anthropic build → OpenAI review or OpenAI build → Anthropic review. The
unreleased work widens that same graph through offline-verifiable `open_pr` and
`merge_when_green` envelopes behind typed GitHub and Delivery Strategy ports.
Earned deterministic and documentation gates run on every committed head, and
the opposite provider independently reviews a fresh immutable evidence bundle.

The runtime can plan and edit locally; the GitHub Adapter can push an exact
branch and create, update, or adopt a normal PR under typed authority. Merge
authority and ordered operational Post-Merge Hooks are available to an activated
`merge_when_green` contract and remain fixture-only until a live canary is
separately authorized. `diagnostics` reports the earned hook capability; it does
not claim that a real project lifecycle has been observed.

## Requirements and local installation

- Node.js 24 or newer (the durable store uses stable `node:sqlite`)
- Git

```bash
npm install
npm run verify
npm link
graph-shipper --version
```

`npm link` is optional; every command can instead be run as
`node dist/cli.js ...` after `npm run build`.

`npm install` also pins this clone's commit identity and wires the hooks in
`.githooks/` (see `.agents/skills/commit-identity/SKILL.md`).

## Onboard a project

1. Copy [`examples/project-contract.template.yaml`](examples/project-contract.template.yaml)
   to `<project>/.graph-shipper/project.yaml`.
2. Replace the project identity, absolute primary-clone path, repository-facts
   SHA, provider references, verification evidence, and documentation catalog.
   Replace the placeholder gate command with the project's real one: a check
   names a command, there is no builtin verifier, and validation refuses a
   command whose authorization sources the project does not hold. Declare at
   least one `pre_approved` rule for `write_file` naming the paths a Work Run
   may edit without a human approving each write; the default effect is
   forbidden, and validation refuses a policy under which no run could write.
3. Commit the contract, every command's authorization sources, and all
   cataloged Markdown. Validation reads the working tree with operator-global
   Git configuration scrubbed, refuses a source the repository ignores, and
   fails if the directory is not a Git repository; admission reads the
   committed base, so an untracked source is not there.
   Admission requires a clean
   repository and refuses contract symlinks, untracked policy, unknown schema
   majors, secrets, unearned verification, and missing/overlapping Markdown
   classifications.
4. Validate without writing runtime state:

```bash
graph-shipper contract validate --project /absolute/path/to/project --json
```

5. Create a pending admission candidate. This inspects Git and writes only to
   Graph Shipper's external application-data directory:

```bash
graph-shipper contract onboard --project /absolute/path/to/project --json
```

6. Review the returned `contractDigest`, `contractBlobSha`, and
   `admissionEvidenceDigest`. From the authenticated local operator account,
   activate those exact values and explicitly confirm the project ID as the
   one-time human onboarding approval:

```bash
graph-shipper contract activate \
  --project /absolute/path/to/project \
  --contract-digest <sha256-from-onboard> \
  --admission-evidence-digest <sha256-from-onboard> \
  --confirm-project <project-id-from-onboard> \
  --json
```

7. Inspect the binding and runtime:

```bash
graph-shipper status --project /absolute/path/to/project --json
graph-shipper diagnostics --json
```

Any byte change to the contract—including a comment—changes its digest and
makes the activation stale. So does a contract the validator now refuses at its
activated project root, even one whose bytes never changed: `status` exits `3`
as every command does on an invalid contract, and still reports the activation
as `stale` beside the refusals rather than failing to answer. A copied or moved
clone does not inherit that root-bound activation, and re-onboarding at the new
root does not move it; the human has to activate the new root explicitly.
Activations created before root binding was stored require the same reactivation.
Stable admission evidence also binds repository
identity, the committed contract blob, gate-evidence declarations, contract
schema, primary-clone path, runtime compatibility major, and every declared
command-authorization source at the default-branch base. Ordinary commits that
do not change one of those sources keep the activation current; changing an
entry script, imported helper, origin, or other binding fact makes it stale.
Commit an intended binding change, rerun onboarding, review the new evidence,
and explicitly activate it. An approval request with mismatched contract or
evidence digests fails closed.

Activation is an operator ceremony, not an agent command: later graph/action
executors will not receive this CLI capability. V1 authenticates the approval
to the local operating-system account and records that identity; it does not
attempt to defend against another malicious process already running with the
same OS account.

## Run a local-only Work Item

Create a revision-pinned Run Request using
[`examples/run-request.template.json`](examples/run-request.template.json).
The Work Item must name the activated project and base branch and include
observable behavior, acceptance evidence, constraints, and source provenance.
It may also declare `workItem.repositoryContextManifest.paths`: an ordered list
of exact tracked files for the Build Provider. The list can only narrow the
activated Project Contract's repository-context globs. Every selected path must
resolve to a regular, non-symlink UTF-8 file with no credential-like content;
explicit manifests fail rather than truncate at the 128 KiB per-file and 1 MiB
aggregate limits. Omitting the manifest preserves the contract-wide collection
behavior for existing requests and resumable runs. Independent review still
receives the complete exact-head diff and changed-file evidence.

Build Providers create new files with `write_file`. Existing files use
`edit_file`: the provider copies `contentSha256` from repository evidence and
supplies exact non-overlapping `oldText`/`newText` replacements. Both kinds are
authorized by the contract's `write_file` approval rules and path globs; a
contract never lists `edit_file`. The runtime
requires every plan to declare `fileActionSemantics: "base_bound_v1"`, so a
fixture or provider response using older overwrite semantics fails schema. The
runtime checks the whole-file digest, uniqueness, overlap, activated path authority,
protected paths, and every command before any effect; it then materializes and
screens all desired files for durable crash recovery. `write_file` refuses an
existing path. Humans provide intent, policy, and context—not file contents,
patches, or broad-rewrite repair work.

For an offline deterministic run, use a recorded adapter fixture. Fixtures are
for tests and reproducible demonstrations; their SHA-256 digest is bound into
the durable Work Run and they are not evidence that a live model was called.

```bash
graph-shipper run \
  --project /absolute/path/to/project \
  --request /absolute/path/to/run-request.json \
  --adapter-fixture /absolute/path/to/provider-fixture.json \
  --json
```

That full Work Run is also the credentialed provider smoke harness. After an
operator explicitly authorizes paid provider calls and builds the CLI, run the
same path as `npm run smoke:credentialed-providers -- --project ... --request
... --data-root ... --json`. Use one Run Request selecting each reciprocal
assignment from the activated contract. The deterministic completion gate
remains `npm run verify`; this smoke is intentionally excluded from that gate
and was not run for v0.3.0.

Live calls require a conspicuous opt-in. Each model assignment declares either
`transport: api` (the backward-compatible default) or
`transport: subscription_cli`.

API assignments use the two activated credential references. A reference
`anthropic-default` maps to
`GRAPH_SHIPPER_CREDENTIAL_ANTHROPIC_DEFAULT`; `openai-default` maps to
`GRAPH_SHIPPER_CREDENTIAL_OPENAI_DEFAULT`. Values are consumed only inside the
trusted HTTP adapters and are never placed in prompts, state, traces, errors,
generic commands, or child environments.

Subscription assignments use an already-authenticated local `claude` or
`codex` installation. Graph Shipper probes `claude auth status` or
`codex login status`, then runs the selected CLI non-interactively in a private
empty scratch directory. It scrubs the child environment, disables tools and
customizations, requests schema-bound output, bounds time and captured output,
does not persist the provider session, and removes invocation scratch data.
Codex runs ephemeral/read-only with its tool feature set disabled; Claude runs
safe-mode/tool-free. Subscription quota use is provider-account activity even
when it creates no incremental API invoice. Subscription assignments omit
`credentialRef`; that field is required only for `api` assignments. Every
fallback remains on its primary assignment's provider, role, and transport so
the admission-time authentication probe remains complete.

The runtime revision captured when a Work Run starts is durable evidence and a
resume invariant. A different Graph Shipper revision must start a new Work Run
rather than combining checkpoints produced by different runtime code.

```bash
graph-shipper run \
  --project /absolute/path/to/project \
  --request /absolute/path/to/run-request.json \
  --allow-credentialed-model-calls \
  --json
```

The successful result names the exact base/head SHAs, preserved owned
worktree and branch, deterministic/documentation evidence, opposite-provider
verdict, selected provider/model references, runtime version, normalized model
failures, and private `evidencePath`. `local_only` deliberately preserves this
reviewed work for human handoff; it performs no GitHub operation.

A project whose gates resolve installed dependencies declares its installs as
`workspace.preparationCommandRefs`. The owned worktree is a sibling of the
repository rather than a descendant, so nothing the primary clone installed is
reachable from it, and a gate is required to be pure, side-effect-free, and
credential-free — an install can be neither. The referenced commands run once,
in declared order, in the fresh worktree before any gate, each under its own
Effect Intent and Receipt, so a resume re-drives only the install with no
receipt. Each must be credential-free, idempotent, declare `sideEffect:
workspace`, run in the worktree, and take no parameters; a monorepo declares one
per dependency tree. Each command's `dependencySources` names its manifest and
lockfile. The two paths must be different regular files that also appear in
`authorizationSources`, and no other command may declare `dependencySources`.
Those digests are pinned at activation and checked before and after every command.
A lockfile is the usual trap: declare the command that installs from the lockfile
without rewriting it, such as `npm ci` rather than `npm install`.

After every command, the phase proves the worktree still has its pinned head and
branch. After the last command, it asks Git to render the pinned base's tracked
blobs through checkout filters in memory, then compares those expected bytes
and modes to the worktree without passing observed bytes through clean filters.
This catches a filter-normalized rewrite while accepting bytes that a correct
checkout legitimately materializes, and it writes no repository content into
runtime storage. The proof trusts neither worktree index flags, sparse state,
nor the stat cache. `assume-unchanged` and
`skip-worktree` are refused even when the current bytes still match: a fresh
owned worktree inherits neither bit, so either one is preparation-created state
that could blind later status checks. Repository-local configuration and the
shared `info/attributes` file are bound before preparation so a command cannot
redefine the checkout filters used by the comparison.
It separately proves that a tracked `.gitignore` is what ignored every untracked
file Git reports. A status probe alone cannot answer either question. The shared
`info/exclude`, a `core.excludesFile`, and a `.gitignore` the install wrote
without committing all hide files from it, and all three are writable by the
install being checked, so a postinstall script could append its own artifact's
path and earn a clean receipt for output nobody declared. The phase asks which
rule decided each leftover file and accepts only a tracked `.gitignore`, with
`core.excludesFile` neutralized on that probe so it cannot promote a tracked file
into a global exclude. An operator's personal ignores cost nothing unless one of
them is what hid an install's output, and a file covered by a committed pattern
is accepted wherever it lands, including under a directory the install created.
A path that opens with `:` is refused unprobed, because Git reads it as a
pathspec and would report a different path's rule, and an enumeration that warns
about a directory it could not read fails rather than proceeding on a short
list. Git skips a directory named `.git` at any depth, so the phase also walks
the worktree without following symlinks and refuses any nested `.git` entry that
is not a registered submodule. A refusal names the path and why it was rejected.
A failed install or any failed postcondition stops the run before planning and
retains the worktree with its diagnostics.

## Exercise the open-PR envelope offline

An `open_pr` Project Contract must declare exactly one `github_operator`
credential reference, required hosted checks/producers and trusted review
identities, and a neutral source-reference prefix. Auto-close keywords are
rejected. The Run Request may select `open_pr` only when the activated
contract's maximum permits it.

`delivery.commitIdentity` sets the non-secret Git author and committer identity
for every commit and rebase the runtime creates. It defaults to
`Graph Shipper <graph-shipper@localhost.invalid>` when omitted. A project whose
hooks enforce a repository identity should declare that identity in its
credential-free contract before onboarding.

Use a recorded GitHub fixture alongside the model fixture:

```bash
graph-shipper run \
  --project /absolute/path/to/project \
  --request /absolute/path/to/open-pr-run-request.json \
  --adapter-fixture /absolute/path/to/provider-fixture.json \
  --github-fixture /absolute/path/to/github-fixture.json \
  --run-id stable-run-id \
  --json
```

Fixture state stays under the external data root, never beside the fixture or
inside the target repository. It proves exact-head push/PR effects, crash
adoption, hosted waiting, repair, drift, and escalation deterministically; it
is not evidence of a real GitHub mutation.

The live composition is the alternative to that fixture, never an addition to
it: `--allow-live-github-mutations` selects an authenticated HTTPS transport
that resolves the contract's single `github_operator` credential reference
through the Credential Broker at the adapter boundary. The credential reaches
no model, generic command, trace, error, or target-repository diff — API calls
carry it in an `Authorization` header built inside the adapter, and the
exact-head branch push carries it in a `git` child-process environment
variable, never in argv or a remote URL. Pushes are compare-and-swap against
the observed remote head (`--force-with-lease`) and the resulting head is read
back before any receipt is recorded. Hosted-evidence waiting polls with bounded
exponential backoff inside the Work Run deadline. Rate limit, authentication,
5xx, and network failures normalize to provider-neutral classes carrying a
status class only, never a response body.

When `github.requiredHostedChecks` is empty, `open_pr` treats the hosted-check
requirement as satisfied without calling a hosted-evidence API. With named
checks, the contract may set `github.requiredCheckSource: commit_statuses` to
read the repository's commit-status contexts instead of check runs. Omission
keeps the Checks API behavior of existing contracts. Either source still binds
the required name, exact head, successful terminal state, and contract-trusted
producer. This lets a private repository use a repository-scoped fine-grained
PAT with `Commit statuses: read`, because GitHub currently does not expose the
documented `Checks: read` permission in the fine-grained PAT UI.

Selecting `open_pr` or `merge_when_green` with neither `--github-fixture` nor
`--allow-live-github-mutations` still fails closed, and `local_only` accepts
neither. A live `merge_when_green` needs a second, separate
`--allow-live-merge`, and live Post-Merge Hooks need
`--allow-live-operational-hooks`, so the flag that reaches a real merge, a real
local-main reset, or real operational infrastructure is never the same one that
opens a PR — and never the fixture flag that authorizes a rehearsal. Either
live flag without `--allow-live-github-mutations` is refused rather than
silently ignored.

A forge-side merge mints a commit the primary clone has never seen, so
local-main synchronization fetches it under the same credentialed seam as the
push before proving it exists and resetting onto it. Every test and reproducible demonstration uses the fixture; no test
reaches GitHub.

Trusted repair feedback must come from a contract-declared actor and use this
exact head-bound header. Other, untrusted, stale-head, or scope-changing
feedback is observed but excluded from repair:

```text
## SHIPPER FEEDBACK
Scope: in_scope
Head: <40-or-64-character-head-sha>
```

Completion additionally requires a trusted exact-head approved review whose
body contains `## VERDICT: APPROVE`, or the runtime's own durable publication of
the opposite-provider verdict already bound to that exact head and Review
Bundle. `open_pr` publishes that verdict through its own typed Authority Lease,
records an Effect Receipt, and adopts a missing-receipt publication only when
the exact canonical comment was authored by the credential's authenticated
GitHub actor. The receipt counts only while its exact comment remains present.
PR-body text, foreign or generic comments, and an edited or deleted publication
do not count. Native GitHub
reviews remain separate and are still required by merge protection; an
`open_pr` publication grants no merge, synchronization, closure, or cleanup
authority. While hosted evidence is pending, the runtime waits for a new
observation and rechecks a GitHub issue's pinned source revision. `status
--run-id` reports `delivery`, `repair`, and `escalationReason` explicitly.

## Exercise autonomous merge and terminal reconciliation offline

Set both the activated contract maximum and Run Request autonomy to
`merge_when_green`. The contract must require hosted checks and branch
protection, serialize merge and any declared Post-Merge Hooks per project, and
select exactly one Delivery Strategy:

- `github_direct` performs a leased exact-head merge through the typed GitHub
  Adapter.
- `project_coordinator` invokes the declared credential-free, idempotent
  enqueue command and adopts delivery only when its separate side-effect-free
  terminal predicate reports the exact merged SHA. It never falls back to a
  direct GitHub merge.

Use the same `run` command shown above with both provider and GitHub fixtures,
plus `--allow-disposable-fixture-reconciliation`. That explicit flag authorizes
the test-only local-main update and owned cleanup only for a disposable fixture
project; do not point it at a real working repository.
If the fixture declares Post-Merge Hooks, also pass
`--allow-disposable-fixture-operations`. The separate opt-in keeps operational
commands disabled for existing merge fixtures and does not authorize a live
project canary.

Immediately before dispatch, the runtime publishes or adopts the exact-head
opposite-provider verdict stamp, acquires the durable per-project merge lock,
and re-observes the PR head, base SHA, branch protection, required checks,
approval, and mergeability. If the base advanced and that exact commit is
available locally, it rebases the owned branch and invalidates and regenerates
every downstream proof before attempting delivery again.

A run is not `completed` merely because merge was accepted. It must observe the
strategy's terminal result, synchronize the primary clone's declared default
branch to the merged SHA, run every declared Post-Merge Hook in unique ascending
order, and satisfy each hook's declared observable probe. Only then may it close
an applicable GitHub-issue source and remove contract-authorized owned resources.
Verdict publication, coordinator enqueue, merge, hooks, compensation, source
closure, local-main synchronization, and cleanup use durable Effect Intents and
Receipts. Fixture tests reconcile apply-before-receipt crashes without
duplicating attributable operations.

Each hook executes the contract's exact argv and `synced_main` working directory
through the activated command allowlist. A command is either a relative
digest-bound Node script, or an exact argv prefix the contract admits in
`executableAllowlist` — `npm run test` admits that script alone, never
`npm run <anything>`. Wrapper executables and interpreter eval modes are refused
even when a contract names them explicitly. Its child receives `PATH`, a
runtime-owned `HOME` and `TMPDIR` under the private data root, the operator
variables that exact command names in its `environmentPasslist`, and at most one
exact `post_merge_operation` credential reference. An endpoint-valued passlisted
variable whose value carries userinfo is refused at execution: the name may be
admissible, but credentials reach a command only through the Credential Broker. The command
timeout, retry count, and backoff remain bounded by the Work Run deadline; the
success/smoke command is a contract-declared observable probe, not long-term
monitoring. A compensable hook captures prior state into the private runtime data
root before its first attempt. Its separately onboarded Compensating Hook may
restore only the literal external target and must prove that state with its own
probe.

Compensation never converts a failed hook path into `completed`. Successful,
exhausted, or ambiguous compensation records the merged SHA, preserves the
source and diagnostics, skips terminal cleanup, and escalates for an operator.
The runtime neither invents rollback argv nor reverts merged Git history. Real
operational observation against a private application remains part of its
separately authorized canary; the deterministic fixtures use harmless temporary artifacts only.

The CLI intentionally refuses fixture-backed `merge_when_green` without both
`--github-fixture` and `--allow-disposable-fixture-reconciliation`; the live
composition requires `--allow-live-github-mutations` and `--allow-live-merge`
in their place, plus `--allow-live-operational-hooks` when the contract
declares Post-Merge Hooks.
Recorded fixtures are deterministic acceptance evidence only: no real merge,
issue closure, or target-repository reconciliation occurs without separately
authorized canary execution.

The Run Request selects one build and one opposite-provider review assignment
from the activated contract. Each assignment may declare ordered
`fallbackAssignmentIds`; validation requires every fallback to stay in the
same role and on the same provider. A malformed structured output gets exactly
one retry before fallback. Refusal, truncation, persistent schema failure,
authentication, rate limit, timeout, and transport failure can activate the
next configured assignment, but can never substitute the Build Provider for
independent review or manufacture approval.

Inspect or resume a durable run:

```bash
graph-shipper status --run-id <run-id> --json
graph-shipper resume \
  --run-id <run-id> \
  --project /absolute/path/to/project \
  --adapter-fixture /same/pinned/provider-fixture.json \
  --json
```

`SIGINT` and `SIGTERM` request a graceful drain. The active deterministic node
finishes, the run checkpoints as `paused`, and `resume` reconciles the owned
workspace and exact committed head before continuing. A missing receipt is
never treated as proof that an effect did not happen: attributable effects are
adopted, while ambiguous effects escalate and preserve their observed paths.
Workspace, file-write, commit, delivery, durable-node, and atomic-evidence crash
gaps are covered by offline fixtures. Local/open-PR resume retains the original
base; merge dispatch instead refreshes an advanced exact base and regenerates
all head-bound evidence.

The CLI also accepts an optional `--run-id` for deterministic local automation.
The `--crash-after-effect`, `--crash-after-receipt`, and `--crash-at-node`
options are fault-injection seams for offline recovery tests; they deliberately
interrupt a run and should not be used in normal operation.

## External state

Mutable state never belongs in the target project or its primary clone. The
default root is:

- macOS: `~/Library/Application Support/graph-shipper`
- Linux: `$XDG_DATA_HOME/graph-shipper`, otherwise
  `~/.local/share/graph-shipper`
- Windows: `%LOCALAPPDATA%/graph-shipper`

If `%LOCALAPPDATA%` is unavailable on Windows, the runtime uses the same
XDG-or-home fallback described for Linux rather than guessing another
Windows-specific directory.

For tests or isolated operators, use `--data-root <absolute-path>` or
`GRAPH_SHIPPER_DATA_ROOT`. A project-scoped data root is rejected. Directories,
SQLite files, and JSONL traces are restricted to the current user; trace writes
also refuse symlink targets.

SQLite migrations store project identity, pending admission evidence, the
active digest-bound approval, Work Runs, node checkpoints, effect intents and
receipts, and redacted audit events. `status` and `diagnostics` are read-only
and do not create an empty database. Per-run JSON evidence and redacted JSONL
traces are private files beneath the data root.

## Security boundary

- Contracts contain opaque credential references, never secret values.
- The internal `OpaqueCredential` cannot be JSON-serialized or imported from
  the public package API. Only a trusted adapter-internal consumer can access
  material before disposal; disposal also releases the redactor registration.
- `CredentialBroker` and `AuthorityBroker` are typed ports. No generic shell,
  network, REST, GraphQL, or `gh` escape receives credentials or authority.
- Contract-declared operational commands cross a dedicated typed Post-Merge
  Adapter. Its child environment contains `PATH`, a runtime-owned `HOME` and
  `TMPDIR` under the private data root, the operator variables that exact
  command declares in its `environmentPasslist`, and, when declared for that
  exact command, one reference-specific credential variable. Passlist entries
  are names only — values are read at execution time and never persisted — and
  the passlist admits by name from a small runtime-owned set rather than
  excluding a denylist, so a credential, a name that points at a credential
  file, or a loader control cannot bypass the Credential Broker.
- Local workspace, file, and commit effects require a broker-issued lease bound
  to contract, repository, Work Run, Work Item revision, exact head, operation,
  autonomy, and remaining iteration/wall-clock budget.
- Model actions select an activated command ID and typed whole-argument values;
  there is no raw shell action. Wrapper executables, interpreter eval modes,
  option/newline/NUL/traversal/embedded-placeholder injection, and changes to
  activated command sources fail closed.
- Every command declares an exact project-relative `authorizationSources`
  manifest containing its direct Node entry script and every imported or
  delegated local source. A conservative tokenizer validates relative
  import/require closure; non-literal loading, template literals, and mutable
  bare-package imports fail closed. Escapes outside string/comment tokens are
  also rejected instead of being ambiguously interpreted. A positive `node:`
  capability list admits local observation primitives; module loaders, process
  launch, VM/worker execution, and network built-ins fail before workspace
  creation. An immutable runtime preload independently enforces resolved module
  paths against that manifest and removes ambient loader/network/process-launch
  capabilities before the command entry point runs. Every manifest member is
  protected from model edits and digest-checked immediately before and after
  execution.
- The human-approved contract declares `models.repositoryContext` include and
  exclude globs. A Work Item may lower that maximum with an ordered exact-path
  `repositoryContextManifest`. Only admitted tracked text enters model input;
  sensitive paths and credential-like signatures fail closed before a provider
  call, command output receives the same screening before persistence or model
  feedback, and review diffs are limited to the same approved context.
- Documentation analysis never follows tracked Markdown symlinks. Their paths
  remain visible to catalog admission, but broken or external targets cannot be
  read through the owned worktree.
- Living and generated documentation receive deterministic content and local-link
  checks. Historical and vendored/reference files remain fully cataloged and
  protected from incidental edits, but their legacy examples and links do not
  create unrelated planner repair work.
- Persisted state and traces redact sensitive keys, opaque handles, and
  registered secret values; final evidence uses the same per-run redactor. Git
  probes run with a minimal `PATH`-only environment.
- This boundary contains model/action misuse; it does not claim to contain a
  compromised trusted runtime running as the operator.

This slice ships an explicit environment-backed Credential Broker for model and
operational boundaries plus both Anthropic/OpenAI cross-provider role
assignments. GitHub credentials still cannot enter generic commands.

Binding Admission validates the operational-hook policy. Every Post-Merge Hook
must name a side-effect-free observable probe.
Any compensation is a separate, explicitly referenced contract entry bound to
a prior-state capture probe, its own timeout/retry policy and success probe, an
operator-named owner, and one literal target outside the project repository.
Only the captured runtime-data artifact may be substituted at execution time;
the compensation probe receives that same artifact and must prove the restored
bytes against it. Capture preserves up to the command evidence limit of 4 MiB
as private binary data. The target cannot be model- or runtime-invented.
Execution is available only in the merge terminal path and remains bounded by
the Work Run deadline.

For `local_only`, the activated cleanup policy explicitly preserves the owned
branch and worktree as the handoff. Worktree/branch removal settings apply only
after a later delivery strategy reaches its terminal success predicate.

## Exit codes

- `0`: success
- `2`: CLI usage error
- `3`: invalid or inadmissible project/contract
- `4`: stale/mismatched activation, authority, or recovery evidence

## Development

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run verify
```

Public behavior is exercised through the CLI against disposable Git projects.
Provider transport conformance uses injected offline responses. No test calls a
model provider, GitHub, or a product repository.
