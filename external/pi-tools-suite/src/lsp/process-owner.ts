import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Duplex } from "node:stream";
import type { ResolvedCommand } from "./_shared/types";

const serverPids = new WeakMap<ChildProcessWithoutNullStreams, number>();

// The supervisor is outside the Desktop adapter group. Its input pipe closes
// even when that adapter and Pi are SIGKILLed, unlike JS exit hooks. Servers and
// wrappers stay inside the supervisor's group, swept on owner loss/server exit.
const supervisor = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const sweep = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
process.on('uncaughtException', sweep);
process.stdin.on('end', sweep);
process.stdin.on('error', sweep);
process.stderr.on('error', sweep);
const [bin, args] = JSON.parse(process.argv[1]);
const child = spawn(bin, args, { shell: false, stdio: ['pipe', 1, 2] });
child.stdin.on('error', sweep);
process.stdin.pipe(child.stdin);
child.on('error', error => { process.stderr.write(String(error) + '\n', sweep); });
child.on('exit', sweep);
if (child.pid) { try { fs.writeSync(3, String(child.pid) + '\n'); } catch { sweep(); } }
`;

export function spawnOwnedLsp(command: ResolvedCommand): ChildProcessWithoutNullStreams {
  const options = { cwd: command.cwd, env: command.env ? { ...process.env, ...command.env } : process.env, shell: false };
  if (process.platform === "win32") return spawn(command.bin, command.args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  // Pix runs on Node; use the same supervisor in Bun's development tests.
  const node = process.versions.bun ? "node" : process.execPath;
  const child = spawn(node, ["-e", supervisor, "--", JSON.stringify([command.bin, command.args])], {
    ...options, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const lifetime = child.stdio[3] as Duplex;
  let buffer = "";
  lifetime.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const pid = Number(buffer.slice(0, newline));
    if (Number.isSafeInteger(pid) && pid > 0) serverPids.set(child, pid);
    buffer = "";
  });
  lifetime.on("error", () => { /* LspClient reports process exit. */ });
  child.once("exit", () => lifetime.destroy());
  return child;
}

export function ownedLspPid(child: ChildProcessWithoutNullStreams): number | undefined {
  return process.platform === "win32" ? child.pid : serverPids.get(child);
}
