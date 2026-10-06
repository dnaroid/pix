import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { findUp } from "./_shared/paths";

/** Config discovery is deliberately independent of permission to execute it. */
export function lspProjectIdentity(cwd: string): string {
  const canonical = fs.realpathSync(cwd);
  const config = findUp(canonical, ".pi/pi-tools-suite.jsonc");
  const git = config ? undefined : findUp(canonical, ".git");
  return fs.realpathSync(config ? path.dirname(path.dirname(config)) : git ? path.dirname(git) : canonical);
}

export function lspBrokerEndpoint(project: string): string {
  if (process.platform === "win32") throw new Error("Shared LSP IPC requires Unix domain sockets");
  const uid = process.getuid!();
  // Short enough for macOS sockaddr_un, not supplied by project configuration.
  const dir = path.join(fs.realpathSync("/tmp"), `pix-lsp-${uid}`);
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error("Unsafe LSP runtime directory");
  const key = createHash("sha256").update(`pix-lsp-v1\0${project}`).digest("hex").slice(0, 32);
  return path.join(dir, `${key}.sock`);
}

export function verifyLspSocket(endpoint: string): void {
  const stat = fs.lstatSync(endpoint);
  if (!stat.isSocket() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe LSP broker socket");
}
