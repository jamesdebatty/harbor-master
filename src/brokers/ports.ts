export type AutonomyLevel = "local_only" | "open_pr" | "merge_when_green";
export type AuthorityOperation =
  | "workspace_create"
  | "workspace_prepare"
  | "file_write"
  | "commit_create"
  | "push_branch"
  | "upsert_pull_request"
  | "publish_review_verdict"
  | "enqueue_delivery"
  | "refresh_base"
  | "merge_exact_head"
  | "sync_local_main"
  | "close_source"
  | "cleanup_owned_resources"
  | "post_merge_hook"
  | "compensating_hook";

export interface CredentialRequest {
  referenceId: string;
  purpose: "anthropic_model" | "openai_model" | "github_operator" | "post_merge_operation";
  projectId: string;
  workRunId?: string;
}

export interface CredentialProbe {
  referenceId: string;
  identity: string;
  capabilityClasses: string[];
  expiresAt?: string;
}

export interface CredentialHandle {
  readonly referenceId: string;
  dispose(): void;
  toJSON(): never;
}

export interface CredentialBroker {
  probe(request: CredentialRequest): Promise<CredentialProbe>;
  acquire(request: CredentialRequest): Promise<CredentialHandle>;
}

export interface AuthorityLeaseRequest {
  contractDigest: string;
  projectId: string;
  repository: string;
  workRunId: string;
  workItemRevision: string;
  autonomy: AutonomyLevel;
  expectedHeadSha: string;
  expectedBaseSha?: string;
  operation: AuthorityOperation;
  budget: {
    iteration: number;
    maximumIterations: number;
    deadlineAt: string;
  };
  hookId?: string;
  expiresAt: string;
}

export interface AuthorityLease extends AuthorityLeaseRequest {
  leaseId: string;
  issuedAt: string;
}

export type AuthorityDecision =
  | { allowed: true; lease: AuthorityLease }
  | { allowed: false; reason: string };

export interface AuthorityBroker {
  issueLease(request: AuthorityLeaseRequest): Promise<AuthorityDecision>;
}
