import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { replaceWorkspaceConfig } from "../search/source-policy.js";
import { projectArtifactLocalPath, pathExists } from "./paths.js";
import { hashProjectArtifactLocal } from "./task-bundle.js";

/** Atomic pull: a concurrent local edit must be reviewed, not overwritten. */
export async function replaceLocalWorkspace(root: string, remotePath: string, expectedHash: string | undefined): Promise<string> {
  const content = await readFile(remotePath, "utf8");
  const installed = await replaceWorkspaceConfig(root, content, async () => {
    const local = projectArtifactLocalPath(root, "workspace");
    const current = await pathExists(local) ? await hashProjectArtifactLocal(root, "workspace") : undefined;
    if (current !== expectedHash) throw new Error("Project workspace state changed while pulling. Review local changes and retry.");
  });
  // hashPath's single-file framing; hash the installed snapshot, never a later
  // local edit after the workspace mutex has been released.
  return createHash("sha256").update("file\0\0").update(installed).digest("hex");
}
