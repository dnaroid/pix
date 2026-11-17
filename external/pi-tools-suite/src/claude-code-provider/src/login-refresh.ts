import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildClaudeEnvironment, claudeLaunch } from "./auth.ts";
import { CLAUDE_TERMINATION_GRACE_MS, terminateProcessGroup } from "./process-utils.ts";

const execFileAsync = promisify(execFile);

/**
 * Claude Code refreshes its OAuth access token only when it expires within
 * five minutes (`now + 300000 >= expiresAt` in Claude Code 2.1.x). A refresh
 * launch earlier than that is a no-op, so the preflight uses the same window.
 */
export const CLAUDE_REFRESH_WINDOW_MS = 300_000;
/** Upper bound for the dedicated refresh launch; Claude's own refresh POST is bounded at 30 s. */
export const LOGIN_REFRESH_TIMEOUT_MS = 45_000;
/**
 * Minimum spacing between refresh launches. A launch that fails or does not
 * move the expiry (for example a revoked login) would otherwise add a ~3 s
 * Claude run to every request until the user signs in again.
 */
export const LOGIN_REFRESH_RETRY_MS = 60_000;

export type LoginRefresh = (signal?: AbortSignal) => Promise<void>;

export interface LoginRefresherOptions {
  /** Access-token expiry (epoch ms) of the stored Claude login, or undefined when unknown. */
  readExpiry?: () => Promise<number | undefined>;
  /** Run Claude once so it refreshes its own login under its cross-process lock. */
  runRefresh?: () => Promise<void>;
  now?: () => number;
  windowMs?: number;
  /** Refresh failures never fail a request; they are reported here. */
  onFailure?: (error: unknown) => void;
  retryMs?: number;
  /** Shared single-flight and retry state; defaults to one per Pi process. */
  state?: LoginRefreshState;
}

/** Keyed by executable, shared by every session's refresher in a process. */
export interface LoginRefreshState {
  readonly flights: Map<string, Promise<void>>;
  /** Start time (epoch ms) of the latest refresh launch. */
  readonly lastLaunchAt: Map<string, number>;
}

export function createLoginRefreshState(): LoginRefreshState {
  return { flights: new Map(), lastLaunchAt: new Map() };
}

const processState = createLoginRefreshState();

/**
 * Preflight for Claude launches: when the stored login is about to expire,
 * refresh it once through a dedicated Claude process that is never cut short
 * by a request's tool handoff or cancellation. Concurrent requests in this
 * process share one refresh; Claude Code's own lock serializes other processes.
 * A caller's abort stops only its wait, never the shared refresh.
 */
export function createLoginRefresher(executable: string, options: LoginRefresherOptions = {}): LoginRefresh {
  const readExpiry = options.readExpiry ?? readClaudeLoginExpiry;
  const runRefresh = options.runRefresh ?? (() => runClaudeRefresh(executable));
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? CLAUDE_REFRESH_WINDOW_MS;
  const retryMs = options.retryMs ?? LOGIN_REFRESH_RETRY_MS;
  const { flights, lastLaunchAt } = options.state ?? processState;
  // A stored expiry only moves later (refresh or new login), so an expiry
  // already known to be outside the window spares a credential read per request.
  let knownExpiry: number | undefined;
  // Within the retry spacing a request launches as before the preflight
  // existed; Claude then refreshes in-process if it still can.
  const coolingDown = (): boolean => {
    const launchedAt = lastLaunchAt.get(executable);
    return launchedAt !== undefined && now() < launchedAt + retryMs;
  };

  const refreshOnce = async (): Promise<void> => {
    try {
      const expiresAt = await readExpiry();
      knownExpiry = expiresAt;
      if (expiresAt === undefined || now() + windowMs < expiresAt) return;
      knownExpiry = undefined;
      // Another session of this process may have launched while this one read.
      if (coolingDown()) return;
      lastLaunchAt.set(executable, now());
      await runRefresh();
    } catch (error) {
      knownExpiry = undefined;
      options.onFailure?.(error);
    }
  };

  return async (signal) => {
    if (signal?.aborted) return;
    if (knownExpiry !== undefined && now() + windowMs < knownExpiry) return;
    if (coolingDown()) return;
    let flight = flights.get(executable);
    if (!flight) {
      flight = refreshOnce().finally(() => {
        if (flights.get(executable) === flight) flights.delete(executable);
      });
      flights.set(executable, flight);
    }
    await waitUnlessAborted(flight, signal);
  };
}

function waitUnlessAborted(flight: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return flight;
  return new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void flight.finally(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/** Claude Code's macOS Keychain service for a configuration directory. */
export function claudeKeychainService(configDir: string | undefined): string {
  if (!configDir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(configDir.replace(/\/+$/u, "")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Only the expiry is extracted; tokens are never retained or returned. */
export function loginExpiryFromCredential(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  try {
    const expiresAt = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
  } catch {
    return undefined;
  }
}

/** Read the stored login's expiry with Claude Code's precedence: Keychain on macOS, then the credentials file. */
export async function readClaudeLoginExpiry(): Promise<number | undefined> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || undefined;
  if (process.platform === "darwin") {
    const keychain = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", claudeKeychainService(configDir), "-w"],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
    ).then(({ stdout }) => stdout, () => undefined);
    const expiresAt = loginExpiryFromCredential(keychain);
    if (expiresAt !== undefined) return expiresAt;
  }
  const file = await readFile(join(configDir ?? join(homedir(), ".claude"), ".credentials.json"), "utf8").catch(() => undefined);
  return loginExpiryFromCredential(file);
}

/**
 * A cheap headless Claude command that needs a valid login, so Claude Code
 * refreshes it first. Output is ignored; no session is persisted.
 */
export const LOGIN_REFRESH_ARGS = ["-p", "/usage", "--no-session-persistence"] as const;

export async function runClaudeRefresh(executable: string, timeoutMs = LOGIN_REFRESH_TIMEOUT_MS): Promise<void> {
  const launch = claudeLaunch(executable, LOGIN_REFRESH_ARGS);
  const child = spawn(launch.command, launch.args, {
    // A neutral directory: no project settings, hooks or trust prompts.
    cwd: tmpdir(),
    env: buildClaudeEnvironment(launch.env),
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    stdio: "ignore",
  });
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
  try {
    const result = await Promise.race([exited, timedOut]);
    if (result === "timeout") {
      await terminateProcessGroup(child, CLAUDE_TERMINATION_GRACE_MS);
      throw new Error(`Claude login refresh did not finish within ${timeoutMs} ms`);
    }
    if (result.error) throw result.error;
    if (result.code !== 0) throw new Error(`Claude login refresh exited with code ${String(result.code)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
