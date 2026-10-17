/** Cheap logical Git history revision shared by the snapshot probe and the
 * commit writer: HEAD, replacement refs and shallow/graft file identities.
 * Mirrored verbatim into ACP so writer and observer cannot diverge. */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const identity = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function stamp(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || await realpath(filename) !== filename) throw new Error("Unsafe file");
    return identity(info);
  } catch (error) { if (error.code === "ENOENT") return "absent"; throw error; }
}
export async function commitStamp(root, signal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const git = async args => (await exec("git", ["-c", "core.fsmonitor=false", ...args],
    { cwd: root, env, signal, timeout: 2000, maxBuffer: 128 * 1024 })).stdout.trim();
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Invalid HEAD");
  const replacements = await git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace/"]);
  const shallow = path.resolve(root, await git(["rev-parse", "--git-path", "shallow"]));
  const grafts = path.resolve(root, await git(["rev-parse", "--git-path", "info/grafts"]));
  return [head, replacements, await stamp(shallow), await stamp(grafts)];
}
