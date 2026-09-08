import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CredentialBroker } from "../brokers/ports.js";
import { ShipperError } from "../errors.js";
import { SAFE_GIT_CONFIG, safeGitEnvironment } from "../runtime/git-safety.js";
import { OpaqueCredential, consumeOpaqueCredential } from "../security/opaque-credential.js";
import type {
  GitHubPushReceipt,
  GitHubPushRequest,
  GitHubTransport,
  GitHubTransportRequest,
  GitHubTransportResponse,
} from "./github.js";

export type GitHubFailureKind = "auth" | "rate_limit" | "timeout" | "transport";

/** Provider-neutral forge failure. Carries a status class, never a response body. */
export class GitHubTransportError extends ShipperError {
  retryAfterMilliseconds?: number;

  constructor(readonly kind: GitHubFailureKind, message: string, details: string[] = []) {
    super(message, 4, details);
    this.name = "GitHubTransportError";
  }
}

export interface GitPushInvocation {
  workspacePath: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMilliseconds: number;
}

export interface GitPushResult {
  status: number;
  stderr: string;
  /** Set when git never produced an exit status of its own. */
  signal?: string | null;
  failure?: string;
}

/** Egress configuration a live push genuinely needs; never a credential channel. */
const FORWARDED_GIT_ENVIRONMENT = [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH",
];

const RETRYABLE_READ_ATTEMPTS = 3;
const PUSH_READ_BACK_ATTEMPTS = 3;
const PUSH_READ_BACK_MILLISECONDS = 250;

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LiveGitHubTransportOptions {
  repository: string;
  credentialRef: string;
  projectId: string;
  workRunId: string;
  broker: CredentialBroker;
  apiBaseUrl?: string;
  remoteBaseUrl?: string;
  fetchImplementation?: FetchImplementation;
  gitPush?: (invocation: GitPushInvocation) => GitPushResult;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMilliseconds?: number;
  pushTimeoutMilliseconds?: number;
  deadlineAt?: () => string;
  pollIntervalMilliseconds?: number;
  maximumPollIntervalMilliseconds?: number;
}

function defaultGitPush(invocation: GitPushInvocation): GitPushResult {
  const result = spawnSync("git", invocation.args, {
    cwd: invocation.workspacePath,
    encoding: "utf8",
    env: invocation.environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: invocation.timeoutMilliseconds,
    killSignal: "SIGKILL",
  });
  return {
    status: result.status ?? 1,
    stderr: (result.stderr ?? "").trim(),
    signal: result.signal,
    ...(result.error ? { failure: result.error.message } : {}),
  };
}

function isRateLimited(response: Response): boolean {
  return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

/** Authenticated HTTPS transport. Credential material is resolved here and nowhere else. */
export class LiveGitHubTransport implements GitHubTransport {
  readonly #options: LiveGitHubTransportOptions;
  readonly #apiBaseUrl: string;
  readonly #remoteBaseUrl: string;
  #pollIntervalMilliseconds: number;

  constructor(options: LiveGitHubTransportOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new ShipperError("GitHub repository identity is invalid", 3);
    }
    this.#options = options;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.#remoteBaseUrl = options.remoteBaseUrl ?? "https://github.com";
    this.#pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 15_000;
  }

  /**
   * Reads retry a transient forge failure inside the Work Run deadline; writes never do,
   * so no retry of this transport can duplicate a forge mutation.
   */
  async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#dispatch(request);
      } catch (error) {
        const retryable = error instanceof GitHubTransportError
          && request.method === "GET"
          && (error.kind === "rate_limit" || error.kind === "transport")
          && attempt < RETRYABLE_READ_ATTEMPTS;
        if (!retryable) throw error;
        const hint = (error as GitHubTransportError).retryAfterMilliseconds;
        const backoff = hint ?? Math.min(1_000 * 2 ** (attempt - 1), 8_000);
        if (backoff > this.#remainingBudget()) throw error;
        await (this.#options.sleep ?? delay)(backoff);
      }
    }
  }

  async #dispatch(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    const serializedBody = request.body === undefined ? undefined : JSON.stringify(request.body);
    return await this.#withCredential((secret, signal) => {
      if (serializedBody !== undefined && serializedBody.includes(secret)) {
        throw new GitHubTransportError("auth", "credential material appeared in the GitHub request body");
      }
      return (this.#options.fetchImplementation ?? fetch)(`${this.#apiBaseUrl}${request.path}`, {
        method: request.method,
        signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "graph-shipper",
          authorization: `Bearer ${secret}`,
          ...(serializedBody === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(serializedBody === undefined ? {} : { body: serializedBody }),
      }).then((response) => this.#normalize(request.method, response));
    });
  }

  /**
   * A forbidden read is the forge reporting what this token may observe, so the typed
   * adapter sees it and fails closed on its own terms; a forbidden write is fatal.
   */
  async #normalize(method: GitHubTransportRequest["method"], response: Response): Promise<GitHubTransportResponse> {
    const failure = response.status === 429 || (response.status === 403 && isRateLimited(response))
      ? "rate_limit" as const
      : response.status === 401 || (response.status === 403 && method !== "GET")
        ? "auth" as const
        : response.status >= 500 ? "transport" as const : null;
    if (failure) {
      await response.body?.cancel().catch(() => undefined);
      const error = new GitHubTransportError(failure, `GitHub returned HTTP ${response.status}`);
      const hint = retryAfterMilliseconds(response);
      if (hint !== undefined) error.retryAfterMilliseconds = hint;
      throw error;
    }
    // Only the pagination link crosses back; no other response header is part of the contract.
    const link = response.headers.get("link");
    const headers = link ? { headers: { link } } : {};
    const text = await response.text();
    if (text.length === 0) return { status: response.status, body: null, ...headers };
    try {
      return { status: response.status, body: JSON.parse(text) as unknown, ...headers };
    } catch {
      throw new GitHubTransportError("transport", `GitHub returned non-JSON output for HTTP ${response.status}`);
    }
  }

  async pushBranch(request: GitHubPushRequest): Promise<GitHubPushReceipt> {
    this.#assertOwnRepository(request.repository);
    const observed = await this.#branchHead(request.branch);
    if (observed === request.headSha) return { remoteHeadBefore: request.headSha, remoteHeadAfter: request.headSha };
    if (observed !== request.expectedRemoteHeadSha) {
      throw new ShipperError("live GitHub branch head drifted before push", 4);
    }
    await this.#push(request, observed);
    if (!await this.#branchReached(request.branch, request.headSha)) {
      throw new ShipperError("live GitHub branch push did not reach the leased exact head", 4);
    }
    return { remoteHeadBefore: observed, remoteHeadAfter: request.headSha };
  }

  async #branchReached(branch: string, expectedHeadSha: string): Promise<boolean> {
    for (let attempt = 1; attempt <= PUSH_READ_BACK_ATTEMPTS; attempt += 1) {
      if (this.#remainingBudget() <= 0) break;
      if (await this.#branchHead(branch) === expectedHeadSha) return true;
      if (attempt === PUSH_READ_BACK_ATTEMPTS) break;
      const remaining = this.#remainingBudget();
      if (remaining <= 0) break;
      const backoff = Math.min(PUSH_READ_BACK_MILLISECONDS * 2 ** (attempt - 1), remaining);
      await (this.#options.sleep ?? delay)(backoff);
    }
    return false;
  }

  /**
   * Brings a forge-side merge commit into the primary clone so local-main synchronization
   * has an object to reset onto. Inward only: it writes no ref the runtime does not own.
   */
  async fetchCommit(request: { repository: string; ref: string; commitSha: string; workspacePath: string }): Promise<void> {
    this.#assertOwnRepository(request.repository);
    await this.#git(
      ["fetch", "--no-tags", `${this.#remoteBaseUrl}/${request.repository}.git`, `refs/heads/${request.ref}`],
      request.workspacePath,
      "commit fetch",
    );
  }

  resetObservationBackoff(): void {
    this.#pollIntervalMilliseconds = this.#options.pollIntervalMilliseconds ?? 15_000;
  }

  async waitForNextObservation(deadlineAt: string): Promise<"ready" | "exhausted"> {
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (remaining <= 0) return "exhausted";
    const interval = this.#pollIntervalMilliseconds;
    this.#pollIntervalMilliseconds = Math.min(interval * 2, this.#options.maximumPollIntervalMilliseconds ?? 60_000);
    await (this.#options.sleep ?? delay)(Math.min(interval, remaining));
    return Date.now() < Date.parse(deadlineAt) ? "ready" : "exhausted";
  }

  async #branchHead(branch: string): Promise<string | null> {
    const response = await this.request({
      method: "GET",
      path: `/repos/${this.#options.repository}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
    });
    if (response.status === 404) return null;
    if (response.status !== 200) throw new ShipperError(`GitHub branch observation failed with status ${response.status}`, 4);
    const object = (response.body as { object?: { sha?: unknown } } | null)?.object;
    if (typeof object?.sha !== "string") throw new ShipperError("GitHub returned an invalid branch reference", 4);
    return object.sha;
  }

  async #push(request: GitHubPushRequest, expected: string | null): Promise<void> {
    await this.#git([
      "push", "--atomic",
      `--force-with-lease=refs/heads/${request.branch}:${expected ?? ""}`,
      `${this.#remoteBaseUrl}/${request.repository}.git`,
      `${request.headSha}:refs/heads/${request.branch}`,
    ], request.workspacePath, "exact-head branch push", request.gitDirectory);
  }

  /** The one place a credential reaches a child process, and it reaches it by environment only. */
  async #git(args: string[], workspacePath: string, label: string, gitDirectory: string | null = null): Promise<void> {
    const credential = await this.#acquire();
    let result: GitPushResult | undefined;
    try {
      consumeOpaqueCredential(credential, (secret) => {
        const authorization = Buffer.from(`x-access-token:${secret}`, "utf8").toString("base64");
        const invocation: GitPushInvocation = {
          workspacePath,
          args: [...SAFE_GIT_CONFIG, ...args],
          environment: {
            ...safeGitEnvironment(workspacePath, gitDirectory),
            ...Object.fromEntries(FORWARDED_GIT_ENVIRONMENT
              .filter((name) => process.env[name])
              .map((name) => [name, process.env[name]])),
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `http.${this.#remoteBaseUrl}/.extraheader`,
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
          },
          timeoutMilliseconds: this.#options.pushTimeoutMilliseconds ?? 120_000,
        };
        const invoked = (this.#options.gitPush ?? defaultGitPush)(invocation);
        const scrub = (text: string): string => text.replaceAll(secret, "[REDACTED]").replaceAll(authorization, "[REDACTED]");
        result = {
          status: invoked.status,
          stderr: scrub(invoked.stderr),
          signal: invoked.signal ?? null,
          ...(invoked.failure ? { failure: scrub(invoked.failure) } : {}),
        };
      });
    } finally {
      credential.dispose();
    }
    if (!result) throw new GitHubTransportError("auth", "credential material was unavailable at the trusted adapter boundary");
    if (result.signal || result.failure) {
      throw new ShipperError(`live GitHub ${label} could not complete`, 4, [
        result.failure ?? "", result.signal ?? "", result.stderr,
      ].filter(Boolean));
    }
    if (result.status !== 0) {
      throw new ShipperError(`live GitHub ${label} was rejected`, 4, [result.stderr]);
    }
  }

  /** The lease and the read-back are evaluated against one repository; nothing else may be mutated. */
  #assertOwnRepository(repository: string): void {
    if (repository !== this.#options.repository) {
      throw new ShipperError("live GitHub repository identity does not match the composed transport", 4);
    }
  }

  #remainingBudget(): number {
    return this.#options.deadlineAt
      ? Date.parse(this.#options.deadlineAt()) - Date.now()
      : Number.POSITIVE_INFINITY;
  }

  async #acquire(): Promise<OpaqueCredential> {
    const credential = await this.#options.broker.acquire({
      referenceId: this.#options.credentialRef,
      purpose: "github_operator",
      projectId: this.#options.projectId,
      workRunId: this.#options.workRunId,
    });
    if (!(credential instanceof OpaqueCredential)) {
      credential.dispose();
      throw new GitHubTransportError("auth", "Credential Broker returned an unsupported handle");
    }
    return credential;
  }

  /** The deadline spans the whole exchange, body included, and outlives no credential handle. */
  async #withCredential<T>(start: (secret: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const remainingBudget = this.#remainingBudget();
    if (remainingBudget <= 0) {
      throw new GitHubTransportError("timeout", "Work Run wall-clock budget exhausted before GitHub dispatch");
    }
    const credential = await this.#acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.#options.timeoutMilliseconds ?? 30_000, remainingBudget));
    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new GitHubTransportError("timeout", "GitHub request timed out"));
      }, { once: true });
    });
    let pending: Promise<T> | undefined;
    let scrub = (text: string): string => text;
    try {
      consumeOpaqueCredential(credential, (secret) => {
        scrub = (text) => text.replaceAll(secret, "[REDACTED]");
        pending = start(secret, controller.signal);
      });
      if (!pending) throw new GitHubTransportError("auth", "credential material was unavailable at the trusted adapter boundary");
      return await Promise.race([pending, deadline]);
    } catch (error) {
      if (error instanceof GitHubTransportError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new GitHubTransportError("timeout", "GitHub request timed out");
      throw new GitHubTransportError("transport", "GitHub transport failed", [scrub(error instanceof Error ? error.message : String(error))]);
    } finally {
      clearTimeout(timeout);
      credential.dispose();
    }
  }
}
