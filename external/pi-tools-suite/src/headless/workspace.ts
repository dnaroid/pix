import { realpath } from "node:fs/promises";
import path from "node:path";
import { parseApplyPatch } from "../model-tools/apply-patch.js";

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Canonicalize even new paths via their nearest existing parent. */
async function canonicalDestination(absolute: string, mustExist: boolean): Promise<string> {
  const suffix: string[] = [];
  let existing = absolute;
  while (true) {
    try {
      const canonical = await realpath(existing);
      if (mustExist && suffix.length > 0) throw new Error(`Workspace path does not exist: ${absolute}`);
      return path.resolve(canonical, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (mustExist) throw new Error(`Workspace path does not exist: ${absolute}`);
      const parent = path.dirname(existing);
      if (existing === parent) throw error;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * The selected cwd is the file tool's default base. Canonical containment also
 * supports macOS /var -> /private/var aliases and detects external symlinks.
 */
export async function assertWorkspacePath(root: string, requested: string, mustExist = true): Promise<string> {
  if (!requested || requested.includes("\0")) throw new Error("Invalid workspace path");
  const absolute = path.resolve(root, requested);
  const canonical = await canonicalDestination(absolute, mustExist);
  if (!inside(root, canonical)) throw new Error(`Path escapes selected workspace: ${requested}`);
  return absolute;
}

/** Restrict Pix patch execution without replacing Pix's parser or executor. */
export async function assertPatchWorkspace(root: string, input: string): Promise<void> {
  const trimmed = input.trimStart();
  const beginPatch = trimmed.startsWith("*** Begin Patch") ||
    trimmed.startsWith("<<EOF") || trimmed.startsWith("<<'EOF'") || trimmed.startsWith('<<"EOF"');
  const paths: string[] = [];
  if (beginPatch) {
    for (const operation of parseApplyPatch(input)) {
      paths.push(operation.path);
      if (operation.kind === "update" && operation.moveTo) paths.push(operation.moveTo);
    }
  } else {
    for (const line of input.split(/\r?\n/u)) {
      if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
      let name = line.slice(4).split("\t")[0]!.trim();
      if (name === "/dev/null") continue;
      if (name.startsWith("a/") || name.startsWith("b/")) name = name.slice(2);
      paths.push(name);
    }
    if (paths.length === 0) throw new Error("Invalid patch: no file headers");
  }
  for (const name of paths) await assertWorkspacePath(root, name, false);
}
