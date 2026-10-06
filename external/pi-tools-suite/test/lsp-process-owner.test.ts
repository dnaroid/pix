import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

test("owned LSP group dies when its Pi owner is SIGKILLed (no exit hooks)", async () => {
  if (process.platform === "win32") return;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-owner-"));
  const pidsPath = path.join(cwd, "pids");
  const guardianPath = path.join(cwd, "guardian");
  const serverPath = path.join(cwd, "server.cjs");
  const ownerPath = path.join(cwd, "owner.ts");
  const worker = `process.on('SIGTERM',()=>{});require('node:fs').appendFileSync(${JSON.stringify(pidsPath)},process.pid+'\\n');setInterval(()=>{},1000);`;
  fs.writeFileSync(serverPath, `require('node:fs').appendFileSync(${JSON.stringify(pidsPath)},process.pid+'\\n');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  const modulePath = fileURLToPath(new URL("../src/lsp/process-owner.ts", import.meta.url));
  fs.writeFileSync(ownerPath, `import {spawnOwnedLsp} from ${JSON.stringify(modulePath)};import fs from 'node:fs';const c=spawnOwnedLsp({bin:'node',args:[${JSON.stringify(serverPath)}],cwd:${JSON.stringify(cwd)}});fs.writeFileSync(${JSON.stringify(guardianPath)},String(c.pid));setInterval(()=>{},1000);`);
  const owner = spawn(process.execPath, [ownerPath], { stdio: "ignore" });
  const readPids = () => fs.existsSync(pidsPath) ? fs.readFileSync(pidsPath, "utf8").trim().split("\n").map(Number) : [];
  let guardian = 0;
  let pids: number[] = [];
  try {
    expect(await waitFor(() => fs.existsSync(guardianPath) && readPids().length === 2)).toBe(true);
    guardian = Number(fs.readFileSync(guardianPath, "utf8"));
    pids = readPids();
    expect(pids.every(exists)).toBe(true);
    owner.kill("SIGKILL");
    expect(await waitFor(() => !exists(guardian) && pids.every((pid) => !exists(pid)))).toBe(true);
  } finally {
    owner.kill("SIGKILL");
    if (guardian) { try { process.kill(-guardian, "SIGKILL"); } catch {} }
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
