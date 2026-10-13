import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const template = fileURLToPath(new URL("../fixtures/qa/pix-project/", import.meta.url));
const run = promisify(execFile);

async function initializeGit(workspace) {
  // A workspace below the checkout must not inherit its parent's Git identity.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  await run("git", ["init", "--quiet", "--template=", "--initial-branch=main", workspace], {
    cwd: workspace, env, timeout: 10000, maxBuffer: 65536,
  });
}

/** Seed only a newly created empty workspace; never overwrite existing data. */
export async function seedQaWorkspace(workspace) {
  const stat = await lstat(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(workspace)).length) {
    throw new Error("QA workspace must be an empty, non-symlink directory");
  }
  for (const entry of await readdir(template)) {
    await cp(join(template, entry), join(workspace, entry), { recursive: true, force: false, errorOnExist: true });
  }
  await initializeGit(workspace);
  return { kind: "pix-qa-sandbox", version: 1, workspace };
}

/** Standalone disposable project for TUI/manual use; Desktop uses its owned run. */
export async function createQaWorkspace(checkout) {
  const root = await realpath(checkout);
  const artifacts = join(root, ".pi", "artifacts");
  // Reject redirected scratch storage rather than writing outside this checkout.
  for (const directory of [join(root, ".pi"), artifacts]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (await realpath(directory) !== directory) throw new Error("QA artifact directory must not be redirected");
  }
  const runDir = await mkdtemp(join(artifacts, "pix-qa-sandbox-"));
  try {
    const workspace = join(runDir, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    return { runDir, ...await seedQaWorkspace(workspace) };
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}
