import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ShipperError } from "../errors.js";
import { sameRealPath } from "../runtime/paths.js";
import { VERSION } from "../version.js";
import { globMatches } from "./globs.js";
import { type ProjectContract } from "./schema.js";
import { validateProjectContract } from "./validate.js";

export interface AdmissionEvidence {
  evidenceVersion: 1;
  runtimeCompatibilityMajor: string;
  projectRoot: string;
  projectId: string;
  repository: string;
  repositoryOrigin: string;
  observedGitHeadSha: string;
  observedBaseSha: string;
  contractDigest: string;
  contractBlobSha: string;
  contractSchemaVersion: string;
  verificationEvidenceDigest: string;
  commandAuthorizationDigest: string;
  trackedMarkdownCount: number;
}

export interface AdmissionCandidate {
  contract: ProjectContract;
  contractDigest: string;
  contractBlobSha: string;
  admissionEvidence: AdmissionEvidence;
  admissionEvidenceDigest: string;
  projectRoot: string;
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function git(projectRoot: string, args: string[]): string {
  try {
    return execFileSync("git", [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.attributesFile=",
      "-c", "diff.external=",
      "-c", "credential.helper=",
      ...args,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: NULL_DEVICE,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_ATTR_NOSYSTEM: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr: unknown }).stderr).trim()
      : "";
    throw new ShipperError(`Git admission probe failed: ${stderr || (error instanceof Error ? error.message : String(error))}`, 4);
  }
}

function documentationErrors(contract: ProjectContract, trackedMarkdown: string[]): string[] {
  const errors: string[] = [];
  for (const path of trackedMarkdown) {
    const matches = contract.documentation.rules.filter((rule) => globMatches(rule.glob, path));
    if (matches.length === 0) errors.push(`unclassified tracked Markdown: ${path}`);
    if (matches.length > 1) errors.push(`overlapping Markdown classifications: ${path} -> ${matches.map((rule) => rule.id).join(", ")}`);
    if (matches[0]?.class === "ignored_transient") errors.push(`tracked Markdown cannot be ignored_transient: ${path}`);
  }
  for (const required of contract.documentation.requiredLivingEntryPoints) {
    const matches = contract.documentation.rules.filter((rule) => rule.class === "living" && rule.entryPoint && globMatches(rule.glob, required));
    if (matches.length !== 1 || !trackedMarkdown.includes(required)) errors.push(`required living entry point is not uniquely cataloged and tracked: ${required}`);
  }
  return errors;
}

function githubRepositoryFromOrigin(origin: string): string | null {
  const match = origin.match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/i);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

function stableAdmissionEvidence(evidence: AdmissionEvidence): Omit<AdmissionEvidence, "observedGitHeadSha" | "observedBaseSha" | "trackedMarkdownCount"> {
  const { observedGitHeadSha: _head, observedBaseSha: _base, trackedMarkdownCount: _markdownCount, ...stable } = evidence;
  return stable;
}

export function collectAdmissionCandidate(
  projectRootInput: string,
  options: { requireClean?: boolean; requireRepositoryIdentity?: boolean } = {},
): AdmissionCandidate {
  const requireClean = options.requireClean ?? true;
  const requireRepositoryIdentity = options.requireRepositoryIdentity ?? true;
  const projectRoot = realpathSync(resolve(projectRootInput));
  const canonicalContractPath = join(projectRoot, ".graph-shipper", "project.yaml");
  try {
    const contractStat = lstatSync(canonicalContractPath);
    if (!contractStat.isFile() || contractStat.isSymbolicLink() || realpathSync(canonicalContractPath) !== canonicalContractPath) {
      throw new ShipperError("canonical Project Contract must be a regular file inside the repository", 3);
    }
  } catch (error) {
    if (error instanceof ShipperError) throw error;
    throw new ShipperError("canonical Project Contract must be a regular file inside the repository", 3);
  }
  const validation = validateProjectContract(projectRoot);
  if (!validation.ok || !validation.contract) {
    throw new ShipperError("Project Contract validation failed", 3, validation.errors);
  }
  const contract = validation.contract;
  if (!sameRealPath(contract.repository.primaryCloneRealpath, projectRoot)) {
    throw new ShipperError("repository.primaryCloneRealpath does not match the onboarded project root", 3);
  }
  if (!sameRealPath(git(projectRoot, ["rev-parse", "--show-toplevel"]), projectRoot)) {
    throw new ShipperError("--project must name the repository root", 3);
  }
  const status = git(projectRoot, ["status", "--porcelain"]);
  if (requireClean && status) throw new ShipperError("binding admission requires a clean Git working tree", 3, status.split("\n"));

  const contractRelativePath = relative(projectRoot, validation.canonicalPath);
  git(projectRoot, ["ls-files", "--error-unmatch", "--", contractRelativePath]);
  const gitHeadSha = git(projectRoot, ["rev-parse", "HEAD"]);
  const contractBlobSha = git(projectRoot, ["rev-parse", `HEAD:${contractRelativePath}`]);
  const baseSha = git(projectRoot, ["rev-parse", contract.repository.defaultBranch]);
  let baseContractBlobSha: string;
  try {
    baseContractBlobSha = git(projectRoot, ["rev-parse", `${baseSha}:${contractRelativePath}`]);
  } catch {
    throw new ShipperError("canonical Project Contract is absent from the declared default-branch base", 4);
  }
  if (baseContractBlobSha !== contractBlobSha) {
    throw new ShipperError("canonical Project Contract differs from the declared default-branch base", 4);
  }
  const origin = git(projectRoot, ["remote", "get-url", "origin"]);
  const originRepository = githubRepositoryFromOrigin(origin);
  if (!originRepository) throw new ShipperError("origin must be a recognizable GitHub repository URL", 3);
  if (requireRepositoryIdentity && originRepository.toLowerCase() !== contract.repository.github.toLowerCase()) {
    throw new ShipperError(`origin repository ${originRepository} does not match contract repository ${contract.repository.github}`, 3);
  }
  try {
    git(projectRoot, ["merge-base", "--is-ancestor", contract.repository.repoFacts.observedHeadSha, baseSha]);
  } catch {
    throw new ShipperError("repository facts are not an ancestor of the declared default-branch base", 4);
  }
  for (const check of contract.verification.checks) {
    try {
      git(projectRoot, ["merge-base", "--is-ancestor", check.earnedEvidence.againstHeadSha, baseSha]);
    } catch {
      throw new ShipperError(`${check.id}: earned verification evidence is not an ancestor of the declared default-branch base`, 4);
    }
  }
  const authorizationSources = [...new Set(contract.commands.flatMap((command) => command.authorizationSources))].sort();
  const authorizationEntries = authorizationSources.map((path) => {
    let baseBlobSha: string;
    let headBlobSha: string;
    try {
      baseBlobSha = git(projectRoot, ["rev-parse", `${baseSha}:${path}`]);
      headBlobSha = git(projectRoot, ["rev-parse", `HEAD:${path}`]);
    } catch {
      throw new ShipperError(`command authorization source is absent from the declared default-branch base: ${path}`, 4);
    }
    if (baseBlobSha !== headBlobSha) {
      throw new ShipperError(`command authorization source differs from the declared default-branch base: ${path}`, 4);
    }
    return { path, blobSha: baseBlobSha };
  });
  const commandAuthorizationDigest = createHash("sha256").update(JSON.stringify(authorizationEntries)).digest("hex");
  const trackedMarkdown = git(projectRoot, ["ls-tree", "-r", "--name-only", baseSha])
    .split("\n")
    .filter((path) => path.endsWith(".md"));
  const docsErrors = documentationErrors(contract, trackedMarkdown);
  if (docsErrors.length > 0) throw new ShipperError("Documentation Catalog admission failed", 3, docsErrors);

  const admissionEvidence: AdmissionEvidence = {
    evidenceVersion: 1,
    runtimeCompatibilityMajor: VERSION.split(".")[0] ?? VERSION,
    projectRoot,
    projectId: contract.metadata.projectId,
    repository: contract.repository.github,
    repositoryOrigin: originRepository,
    observedGitHeadSha: gitHeadSha,
    observedBaseSha: baseSha,
    contractDigest: validation.contractDigest,
    contractBlobSha,
    contractSchemaVersion: contract.metadata.schemaVersion,
    verificationEvidenceDigest: createHash("sha256").update(JSON.stringify(
      contract.verification.checks.map((check) => ({ id: check.id, evidence: check.earnedEvidence })),
    )).digest("hex"),
    commandAuthorizationDigest,
    trackedMarkdownCount: trackedMarkdown.length,
  };
  const admissionEvidenceDigest = createHash("sha256").update(JSON.stringify(stableAdmissionEvidence(admissionEvidence))).digest("hex");
  return {
    contract,
    contractDigest: validation.contractDigest,
    contractBlobSha,
    admissionEvidence,
    admissionEvidenceDigest,
    projectRoot,
  };
}
