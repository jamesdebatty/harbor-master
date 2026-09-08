import assert from "node:assert/strict";
import test from "node:test";
import { LocalAuthorityBroker } from "../src/brokers/local-authority.js";
import type { AuthorityLeaseRequest } from "../src/brokers/ports.js";

test("local Authority Broker issues only contract/repository/run/operation/budget-scoped leases", async () => {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const broker = new LocalAuthorityBroker({
    contractDigest: "contract-a",
    projectId: "project-a",
    repository: "fixture/project",
    workRunId: "run-a",
    workItemRevision: "revision-a",
    autonomy: "local_only",
    allowedOperations: new Set(["file_write"]),
    maximumIterations: 2,
    deadlineAt,
  });
  const request = {
    contractDigest: "contract-a",
    projectId: "project-a",
    repository: "fixture/project",
    workRunId: "run-a",
    workItemRevision: "revision-a",
    autonomy: "local_only" as const,
    expectedHeadSha: "a".repeat(40),
    operation: "file_write" as const,
    budget: { iteration: 1, maximumIterations: 2, deadlineAt },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const allowed = await broker.issueLease(request);
  assert.equal(allowed.allowed, true);
  if (allowed.allowed) {
    assert.match(allowed.lease.leaseId, /^[0-9a-f-]{36}$/);
    assert.equal(allowed.lease.repository, "fixture/project");
  }

  assert.deepEqual(await broker.issueLease({ ...request, repository: "other/repository" }), {
    allowed: false,
    reason: "request exceeds the activated local Work Run authority scope",
  });
  assert.equal((await broker.issueLease({ ...request, operation: "push_branch" })).allowed, false);
  assert.equal((await broker.issueLease({ ...request, budget: { ...request.budget, iteration: 3 } })).allowed, false);
});

test("local Authority Broker rejects expired and scope-tampered lease requests", async () => {
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const broker = new LocalAuthorityBroker({
    contractDigest: "contract-a",
    projectId: "project-a",
    repository: "fixture/project",
    workRunId: "run-a",
    workItemRevision: "revision-a",
    autonomy: "local_only",
    allowedOperations: new Set(["file_write"]),
    maximumIterations: 2,
    deadlineAt,
  });
  const request: AuthorityLeaseRequest = {
    contractDigest: "contract-a",
    projectId: "project-a",
    repository: "fixture/project",
    workRunId: "run-a",
    workItemRevision: "revision-a",
    autonomy: "local_only",
    expectedHeadSha: "a".repeat(40),
    operation: "file_write",
    budget: { iteration: 1, maximumIterations: 2, deadlineAt },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const tampered: AuthorityLeaseRequest[] = [
    { ...request, contractDigest: "contract-b" },
    { ...request, projectId: "project-b" },
    { ...request, workRunId: "run-b" },
    { ...request, workItemRevision: "revision-b" },
    { ...request, autonomy: "open_pr" },
    { ...request, budget: { ...request.budget, maximumIterations: 3 } },
    { ...request, budget: { ...request.budget, deadlineAt: new Date(Date.now() - 1_000).toISOString() } },
    { ...request, expiresAt: new Date(Date.now() - 1_000).toISOString() },
  ];

  for (const candidate of tampered) {
    assert.deepEqual(await broker.issueLease(candidate), {
      allowed: false,
      reason: "request exceeds the activated local Work Run authority scope",
    });
  }
});
