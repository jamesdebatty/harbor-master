import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  version: string;
}

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageMetadata;

export const VERSION = metadata.version;

function resolveRuntimeRevision(): string | null {
  const declared = process.env.GRAPH_SHIPPER_RUNTIME_REVISION?.trim();
  if (declared) return declared;
  try {
    return execFileSync("git", ["-C", fileURLToPath(new URL("..", import.meta.url)), "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "" },
    }).trim();
  } catch {
    return null;
  }
}

export const RUNTIME_REVISION = resolveRuntimeRevision();
