import { randomUUID } from "node:crypto";
import type {
  AuthorityBroker, AuthorityDecision, AuthorityLeaseRequest, AuthorityOperation, AutonomyLevel,
} from "./ports.js";

export interface LocalAuthorityScope {
  contractDigest: string;
  projectId: string;
  repository: string;
  workRunId: string;
  workItemRevision: string;
  autonomy: AutonomyLevel;
  allowedOperations: ReadonlySet<AuthorityOperation>;
  maximumIterations: number;
  deadlineAt: string;
}

/** A deny-by-default broker for effects owned by one Work Run autonomy scope. */
export class LocalAuthorityBroker implements AuthorityBroker {
  readonly #scope: LocalAuthorityScope;

  constructor(scope: LocalAuthorityScope) {
    this.#scope = { ...scope, allowedOperations: new Set(scope.allowedOperations) };
  }

  async issueLease(request: AuthorityLeaseRequest): Promise<AuthorityDecision> {
    const denied = request.contractDigest !== this.#scope.contractDigest
      || request.projectId !== this.#scope.projectId
      || request.repository !== this.#scope.repository
      || request.workRunId !== this.#scope.workRunId
      || request.workItemRevision !== this.#scope.workItemRevision
      || request.autonomy !== this.#scope.autonomy
      || !this.#scope.allowedOperations.has(request.operation)
      || request.budget.maximumIterations !== this.#scope.maximumIterations
      || request.budget.deadlineAt !== this.#scope.deadlineAt
      || request.budget.iteration > this.#scope.maximumIterations
      || Date.parse(request.budget.deadlineAt) <= Date.now()
      || Date.parse(request.expiresAt) <= Date.now()
      || Date.parse(request.expiresAt) > Date.parse(request.budget.deadlineAt)
      || Date.parse(request.expiresAt) - Date.now() > 5 * 60_000;
    if (denied) return { allowed: false, reason: "request exceeds the activated local Work Run authority scope" };
    return {
      allowed: true,
      lease: { ...request, leaseId: randomUUID(), issuedAt: new Date().toISOString() },
    };
  }
}
