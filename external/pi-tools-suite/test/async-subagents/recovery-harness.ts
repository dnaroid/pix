// Shared harness for the offline macOS recovery feasibility family
// (recovery-owner-loss-feasibility.test.ts and
// recovery-postkill-restart.test.ts), opt-in via PI_OFFLINE_COALITION_PROBE=1.
// Split out so the post-kill/pre-receipt experiment does not duplicate the
// launchd job lifecycle, strict ps observation, checkpoint/receipt parsing,
// and plist construction already proven by the baseline and restart cases.
//
// Invariants shared by every consumer:
// - launchctl actions address only exact UUID-labelled services;
// - ps observation is existence-only and treats errors/ambiguity as failure;
// - every wait is bounded with a deadline;
// - parser failures throw (fail closed) rather than guessing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const launchctl = (args: string[], timeout = 4000) => spawnSync("launchctl", args, { timeout, encoding: "utf8" });
export const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export const psOf = (pids: number[]) => spawnSync("ps", ["-p", pids.filter(p => p > 0).join(","), "-o", "pid="], { timeout: 4000, encoding: "utf8" });

export const leafIsAlive = (pid: number) => {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { timeout: 4000, encoding: "utf8" });
  if (result.error || result.signal || result.stderr.trim()) throw new Error(`ps failed: ${result.error?.message ?? result.signal ?? result.stderr}`);
  if (result.status === 1 && result.stdout.trim() === "") return false;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`ambiguous ps result: ${result.status} ${result.stderr}`);
  return !result.stdout.trim().startsWith("Z");
};

export const actorsAreAbsent = (pids: number[]) => {
  const result = psOf(pids);
  if (result.error || result.signal || result.stderr.trim()) throw new Error(`ps failed: ${result.error?.message ?? result.signal ?? result.stderr}`);
  if (result.status === 0 && result.stdout.trim()) return false;
  if (result.status === 1 && result.stdout.trim() === "") return true;
  throw new Error(`ambiguous ps result: ${result.status} ${result.stderr}`);
};

export async function waitFor(predicate: () => boolean, deadlineMs: number, what: string) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`deadline waiting for ${what}`);
}

export type Checkpoint = { role: string; pid: number; pidversion: number; start: number; deadline: number };
export const parseCp = (path: string): Checkpoint => {
  const text = readFileSync(path, "utf8");
  const m = text.match(/role=(\S+) pid=(\d+) pidversion=(\d+) token=[0-9a-f]{64} start=(\d+) deadline=(\d+)/);
  if (!m) throw new Error(`unparseable checkpoint ${path}: ${text}`);
  return { role: m[1], pid: Number(m[2]), pidversion: Number(m[3]), start: Number(m[4]), deadline: Number(m[5]) };
};

// The 64-hex audit token exactly as the actor's own checkpoint published it.
// Comparison of these strings is an identity comparison of authentic kernel
// records; callers never fabricate token values.
export const checkpointToken = (path: string) => {
  const m = readFileSync(path, "utf8").match(/token=([0-9a-f]{64})/);
  if (!m) throw new Error(`no token in checkpoint ${path}`);
  return m[1];
};

export type PostkillCheckpoint = {
  gen: string; pid: number; pidversion: number; token: string;
  killedAt: number; leafDeadline: number;
  killReturn: number; killErrno: number; gone: number; goneErrno: number;
};
export const parsePostkill = (path: string): PostkillCheckpoint => {
  const text = readFileSync(path, "utf8");
  const m = text.match(
    /role=postkill gen=(\S+) pid=(\d+) pidversion=(\d+) token=([0-9a-f]{64}) killed_at=(\d+) leaf_deadline=(\d+) kill_return=(-?\d+) kill_errno=(\d+) gone=(\d+) gone_errno=(\d+)/,
  );
  if (!m) throw new Error(`unparseable postkill checkpoint ${path}: ${text}`);
  return {
    gen: m[1], pid: Number(m[2]), pidversion: Number(m[3]), token: m[4],
    killedAt: Number(m[5]), leafDeadline: Number(m[6]),
    killReturn: Number(m[7]), killErrno: Number(m[8]), gone: Number(m[9]), goneErrno: Number(m[10]),
  };
};

export const parseReceipt = (path: string) =>
  Object.fromEntries([...readFileSync(path, "utf8").matchAll(/([a-z_]+)=(\S+)/g)].map(m => [m[1], m[2]]));

export const psInfo = (pid: number, keywords: string[]) =>
  spawnSync("ps", ["-p", String(pid), ...keywords.map(k => `-o ${k}=`)], { timeout: 4000, encoding: "utf8" });

export const fileExists = (path: string) => existsSync(path);

// The optional generation argument selects generation-suffixed supervisor
// artifacts; the trailing mode arguments select the explicit post-kill
// contracts ("kill-then-park" / "already-absent <kill-gen>").
export const supervisorPlist = (label: string, supervisorBin: string, dir: string, gen?: string, modeArgs?: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${escapeXml(label)}</string><key>ProgramArguments</key><array><string>${escapeXml(supervisorBin)}</string><string>${escapeXml(dir)}</string>${gen ? `<string>${escapeXml(gen)}</string>` : ""}${(modeArgs ?? []).map(a => `<string>${escapeXml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>${escapeXml(join(dir, "job.out"))}</string><key>StandardErrorPath</key><string>${escapeXml(join(dir, "job.err"))}</string></dict></plist>`;

export const compileFixture = (source: string, out: string) =>
  spawnSync("xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", join(import.meta.dir, "fixtures", source), "-lbsm", "-o", out], { timeout: 20_000, encoding: "utf8" });
