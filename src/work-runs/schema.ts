import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ShipperError } from "../errors.js";

const NonEmpty = z.string().trim().min(1);
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#@-]*$/);

const ExactRepositoryPath = z.string().min(1).max(4096).superRefine((path, context) => {
  const segments = path.split("/");
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const protectedPath = path.toLowerCase() === ".git"
    || path.toLowerCase().startsWith(".git/")
    || path === ".graph-shipper/project.yaml";
  if (absolute || path.includes("\\") || /[\0\r\n]/.test(path)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || protectedPath) {
    context.addIssue({ code: "custom", message: "must be a canonical project-relative repository path" });
  }
});

export const RepositoryContextManifestSchema = z.object({
  paths: z.array(ExactRepositoryPath),
}).strict().superRefine((manifest, context) => {
  const seen = new Set<string>();
  manifest.paths.forEach((path, index) => {
    if (seen.has(path)) {
      context.addIssue({ code: "custom", path: ["paths", index], message: "duplicate repository context path" });
    }
    seen.add(path);
  });
});

export const WorkItemSchema = z.object({
  id: Id,
  projectId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  source: z.object({
    kind: z.enum(["github_issue", "specification", "feature_request"]),
    identity: NonEmpty,
    revision: NonEmpty,
  }).strict(),
  baseBranch: NonEmpty,
  title: NonEmpty,
  body: NonEmpty,
  desiredBehavior: z.array(NonEmpty).min(1),
  acceptanceCriteria: z.array(z.object({
    criterion: NonEmpty,
    evidence: NonEmpty,
  }).strict()).min(1),
  constraints: z.array(NonEmpty),
  documentationAuthority: z.object({
    protectedPaths: z.array(NonEmpty).default([]),
    renameFromPaths: z.array(NonEmpty).default([]),
    broadRewritePaths: z.array(NonEmpty).default([]),
  }).strict().default({ protectedPaths: [], renameFromPaths: [], broadRewritePaths: [] }),
  repositoryContextManifest: RepositoryContextManifestSchema.optional(),
  provenance: z.array(NonEmpty).min(1),
}).strict();

export const RunRequestSchema = z.object({
  schemaVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
  workItem: WorkItemSchema,
  buildAssignmentId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  reviewAssignmentId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  autonomy: z.enum(["local_only", "open_pr", "merge_when_green"]),
}).strict();

export type WorkItem = z.infer<typeof WorkItemSchema>;
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RepositoryContextManifest = z.infer<typeof RepositoryContextManifestSchema>;

export function loadRunRequest(pathInput: string): RunRequest {
  const path = resolve(pathInput);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ShipperError(`cannot read Run Request: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
  const parsed = RunRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const location = issue.path.join(".") || "request";
      if (location === "workItem.desiredBehavior") return "desired observable behavior is required";
      if (location === "workItem.acceptanceCriteria") return "acceptance evidence is required";
      return `${location}: ${issue.message}`;
    });
    throw new ShipperError("Work Item intake is incomplete", 3, details);
  }
  return parsed.data;
}
