import { existsSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ShipperError } from "../errors.js";

export function resolveDataRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.GRAPH_SHIPPER_DATA_ROOT) return resolve(process.env.GRAPH_SHIPPER_DATA_ROOT);
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "graph-shipper");
  if (platform() === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "graph-shipper");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "graph-shipper");
}

export function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(resolve(left)) === realpathSync(resolve(right));
  } catch {
    return false;
  }
}

function canonicalPotentialPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalPotentialPath(parent), absolute.slice(parent.length + 1));
}

export function assertExternalDataRoot(projectRoot: string, dataRoot: string): void {
  const canonicalProject = realpathSync(resolve(projectRoot));
  const canonicalData = canonicalPotentialPath(dataRoot);
  const fromProject = relative(canonicalProject, canonicalData);
  if (fromProject === "" || (!fromProject.startsWith("..") && !isAbsolute(fromProject))) {
    throw new ShipperError("runtime data root must remain outside the target repository", 3);
  }
}
