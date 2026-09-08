# Graph Shipper domain language

**Project Contract** — credential-free, Git-tracked maximum/default project
policy at `.graph-shipper/project.yaml`.

**Contract Activation Record** — external human approval bound to the exact
Project Contract digest and admission evidence.

**Stable Admission Evidence** — digest-bound repository identity, committed
contract blob, schema/runtime compatibility, primary-clone path, and declared
earned-gate evidence. The observed HEAD and Markdown count remain audit facts
but are excluded from the stable digest so ordinary feature commits do not
revoke onboarding.

**Onboarded Project** — a project with a current active Contract Activation
Record. Contract validity alone does not make a project runnable.

**Run Request** — per-run Work Item, provider assignment, concurrency, and
autonomy selection that may lower but never raise activated authority.

**Shipper Runtime** — this standalone CLI and its external state, adapters,
policy enforcement, and graph execution.

**Credential Broker** — trusted port that resolves a contract's opaque
credential reference into a non-serializable, disposable value at the narrow
adapter boundary.

**Authority Broker** — trusted port that may issue a time-bounded typed lease
for one project, Work Run, immutable revision, expected head, autonomy level,
outward operation, and remaining Work Run budget. Model nodes can propose but
cannot issue leases.

**Admission Candidate** — the pending, externally persisted result of checking
one clean committed contract, repository identity, gate evidence, and complete
tracked-Markdown catalog. It grants no runtime capability.

**Persistence Boundary** — private application data outside every target
repository. Values cross it only after redaction; opaque credentials cannot
cross it at all.

**Work Run** — one durable `local_only`, `open_pr`, or `merge_when_green` execution over an immutable
Work Item: isolated workspace, one selected Anthropic or OpenAI Build Provider,
deterministic and documentation evidence, and an exact-head verdict from the
opposite Review Provider. `open_pr` continues through exact branch push, normal
PR reconciliation, hosted evidence, and bounded repair without merge authority.
`merge_when_green` additionally publishes the opposite-provider verdict,
serializes merge per project, revalidates the exact base/head and protected
hosted gates at dispatch, executes the selected Delivery Strategy, proves local
main reconciliation, closes an applicable source, and cleans owned resources.

**Normal PR terminal** — the `open_pr` stopping condition: the current Work Run
head is pushed, the one owned non-draft PR binds that head and declared base,
every required hosted check is current and green, and a trusted exact-head
approval is present. The approval may be the runtime's durable publication of
its already-bound opposite-provider verdict or a trusted native GitHub review.
A contract may source required hosted evidence from check runs or commit
statuses; either source must bind the declared name, exact head, successful
terminal state, and trusted producer.
A missing-receipt publication is adoptable only when its canonical comment was
authored by the credential's authenticated GitHub actor; PR-body text, foreign
comments, and unreceipted comments never count. This is not the Delivery
Strategy's merge terminal predicate, and only native reviews participate in
merge eligibility.

**Merge terminal** — the `merge_when_green` stopping condition:
the selected GitHub-direct or project-coordinator strategy has delivered the
exact reviewed head, the primary clone's declared default branch is synchronized
to the observed merged SHA, and every ordered operational Post-Merge Hook has an
observable success probe satisfied within the Work Run deadline. Source closure
and owned cleanup occur only after this predicate is proven.

**Post-Merge outcome** — durable merged truth plus the ordered hook, retry,
prior-state, probe, and optional compensation receipts. Successful compensation
restores only its pre-approved owned target; it never makes the Work Run shipped.
Any exhausted or ambiguous hook/compensation leaves the merge explicit, keeps the
source non-terminal, preserves diagnostics and owned resources, and escalates.

**Trusted hosted feedback** — a review, inline comment, or issue comment from a
contract-declared actor with the structured `Scope: in_scope` and exact `Head:`
marker. Identity alone never grants repair scope.

**Delivery-terminal cleanup** — cleanup settings named `OnSuccess` apply only
after a later delivery vertical reaches its terminal predicate. A T-022
`local_only` completion intentionally preserves its owned branch and worktree
for human handoff. After terminal and exact ownership proof, cleanup records at
most twenty path/rule findings plus their exact total count for output hidden by
a writable ignore rule and still reclaims the owned worktree; malformed finding
metadata fails closed, and output bytes are never persisted.

**Workspace Preparation** — contract-declared commands run once, in order, in a
fresh owned worktree before any gate, so a project whose gates resolve installed
dependencies can earn a deterministic gate. Not pure by construction, which is
why it is its own phase and effect class rather than a gate. Its output must be
ignored by the project's own repository, and it inherits the worktree's existing
ownership and cleanup rules unchanged. Each command binds its dependency manifest
and lockfile as authorization sources. A successful command preserves the pinned
worktree head and branch before its Effect Receipt can be written. Its final
postcondition compares base-tracked expected checkout bytes and modes in memory
and refuses suppressing index state; repository content never enters runtime
persistence. Repository-local configuration and shared Git attributes
are bound before the first preparation command can redefine either one.

**Effect Intent / Effect Receipt** — the two durable checkpoints around a
local mutation. An intent plus short-lived local Authority Lease precedes the
effect; an observed postcondition precedes its receipt. Resume reconciles the
gap before replay.

**Documentation Disposition** — the part of a plan that states how the change is
documented: a coverage plan naming which living document carries each triggered
impact and topic, or a reviewed no-change attestation. It is judged apart from
the files the plan writes, so a plan whose tree is already correct can still be
refused for its disposition alone.

**Activated Command Registry** — the executable/subcommand allowlist derived
only from the active Project Contract. Model actions select an ID and typed
whole-argument values; they cannot submit raw shell text or rewrite the
program/manifests that define an activated command.
