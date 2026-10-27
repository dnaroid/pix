import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { RateLimitNotice } from "./claude-protocol.ts";

export interface ClaudeAccount {
  name: string;
  configDir: string;
}

export interface ClaudeAccountRotationConfig {
  enabled: boolean;
  showRateLimitWarnings?: boolean;
  accounts: ClaudeAccount[];
  /** Explicit preferred profile; unlike rotation, works with autoRotate off. */
  selectedAccount?: string;
  /** Seconds to pause after a rejected request before a different profile is tried. */
  rotationDelaySeconds?: number;
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ACCOUNTS = 12;
export const DEFAULT_ROTATION_DELAY_SECONDS = 60;
export const MAX_ROTATION_DELAY_SECONDS = 300;
const UNKNOWN_RESET_COOLDOWN_MS = 2 * 60_000;
const MAX_RESET_WAIT_MS = 8 * 24 * 60 * 60_000;

function defaultUserConfigPath(): string {
  return join(process.env.HOME?.trim() || homedir(), ".config", "pi", "pi-tools-suite.jsonc");
}

/** Reads `claudeCodeProvider` from the user-owned file; undefined when the file is absent. */
function readUserProviderSection(filePath: string, label: string): unknown {
  let raw: string;
  try {
    if (statSync(filePath).size > MAX_CONFIG_BYTES) throw new Error("config exceeds 1 MiB");
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${label}: cannot read user config: ${String(error)}`);
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length !== 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}: invalid user JSONC configuration`);
  }
  return (parsed as Record<string, unknown>).claudeCodeProvider;
}

/** The provider reads only user-owned config. A workspace cannot insert OAuth profiles. */
export function loadClaudeAccountRotationConfig(
  filePath = defaultUserConfigPath(),
  home = process.env.HOME?.trim() || homedir(),
): ClaudeAccountRotationConfig {
  return parseClaudeAccountRotationConfig(readUserProviderSection(filePath, "Claude account rotation"), home);
}


export function parseClaudeAccountRotationConfig(raw: unknown, home = homedir()): ClaudeAccountRotationConfig {
  if (raw === undefined) return { enabled: false, accounts: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("claudeCodeProvider must be an object");
  const input = raw as Record<string, unknown>;
  if (input.showRateLimitWarnings !== undefined && typeof input.showRateLimitWarnings !== "boolean") {
    throw new Error("claudeCodeProvider.showRateLimitWarnings must be a boolean");
  }
  const warningPreference = input.showRateLimitWarnings === undefined ? {} : { showRateLimitWarnings: input.showRateLimitWarnings };
  const enabled = input.autoRotate === true;
  if (input.autoRotate !== undefined && typeof input.autoRotate !== "boolean") {
    throw new Error("claudeCodeProvider.autoRotate must be a boolean");
  }
  const selectedAccount = input.selectedAccount;
  if (selectedAccount !== undefined && (typeof selectedAccount !== "string" || !selectedAccount.trim()
    || selectedAccount.length > 64 || /[\r\n]/u.test(selectedAccount))) {
    throw new Error("claudeCodeProvider.selectedAccount must be a nonempty account name");
  }
  const rotationDelaySeconds = input.rotationDelaySeconds === undefined ? DEFAULT_ROTATION_DELAY_SECONDS : input.rotationDelaySeconds;
  if (typeof rotationDelaySeconds !== "number" || !Number.isInteger(rotationDelaySeconds) || rotationDelaySeconds < 0 || rotationDelaySeconds > MAX_ROTATION_DELAY_SECONDS) {
    throw new Error(`claudeCodeProvider.rotationDelaySeconds must be an integer from 0 to ${MAX_ROTATION_DELAY_SECONDS}`);
  }
  if (input.accounts === undefined) {
    if (enabled) throw new Error("claudeCodeProvider.accounts needs at least two OAuth profiles");
    return { enabled, accounts: [], rotationDelaySeconds, ...warningPreference };
  }
  if (!Array.isArray(input.accounts) || input.accounts.length > MAX_ACCOUNTS) {
    throw new Error(`claudeCodeProvider.accounts must be an array of at most ${MAX_ACCOUNTS} profiles`);
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  const accounts = input.accounts.map((value, index): ClaudeAccount => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Claude account ${index + 1} must be an object`);
    const account = value as Record<string, unknown>;
    const name = typeof account.name === "string" ? account.name.trim() : "";
    const directory = typeof account.configDir === "string" ? account.configDir.trim() : "";
    if (!name || name.length > 64 || /[\r\n]/.test(name)) throw new Error(`Claude account ${index + 1} needs a name (1–64 characters)`);
    if (!directory || /[\r\n\0]/.test(directory)) throw new Error(`Claude account ${name} needs a configuration directory`);
    const configDir = directory.startsWith("~/") ? join(home, directory.slice(2)) : directory;
    if (!isAbsolute(configDir)) throw new Error(`Claude account ${name} requires an absolute or ~/ configuration path`);
    const normalizedDir = resolve(configDir);
    if (names.has(name.toLowerCase()) || paths.has(normalizedDir)) throw new Error(`Claude account ${name} duplicates a name or directory`);
    names.add(name.toLowerCase());
    paths.add(normalizedDir);
    return { name, configDir: normalizedDir };
  });
  if (enabled && accounts.length < 2) throw new Error("claudeCodeProvider.autoRotate requires at least two OAuth profiles");
  // A profile may be removed or renamed through the settings editor. An old
  // preference then falls back to normal selection instead of disabling Claude.
  const preferred = typeof selectedAccount === "string"
    ? accounts.find((account) => account.name === selectedAccount.trim())?.name
    : undefined;
  return { enabled, accounts, rotationDelaySeconds, ...warningPreference, ...(preferred ? { selectedAccount: preferred } : {}) };
}

/** Process-wide quota state. A request visits each profile at most once; no recursive retries. */
export class ClaudeAccountRotationState {
  private readonly blockedUntil = new Map<string, number>();
  private nextAccount = 0;
  private lastSelectedAccount: string | undefined;

  /** An explicit change is a deliberate attempt to reselect the requested profile. */
  selectionChanged(accounts: readonly ClaudeAccount[], selected: string | undefined): void {
    if (selected === this.lastSelectedAccount) return;
    this.lastSelectedAccount = selected;
    const account = accounts.find((item) => item.name === selected);
    if (account) this.blockedUntil.delete(account.configDir);
  }

  choose(accounts: readonly ClaudeAccount[], tried: ReadonlySet<string> = new Set(), now = Date.now(), preferred?: string): ClaudeAccount | undefined {
    if (accounts.length === 0) return undefined;
    const selected = preferred === undefined ? undefined : accounts.find((account) => account.name === preferred);
    if (selected && !tried.has(selected.configDir) && (this.blockedUntil.get(selected.configDir) ?? 0) <= now) return selected;
    for (let offset = 0; offset < accounts.length; offset++) {
      const account = accounts[(this.nextAccount + offset) % accounts.length]!;
      if (!tried.has(account.configDir) && (this.blockedUntil.get(account.configDir) ?? 0) <= now) return account;
    }
    return undefined;
  }

  reject(accounts: readonly ClaudeAccount[], account: ClaudeAccount, notice: RateLimitNotice, now = Date.now()): void {
    if (notice.status !== "rejected" || (notice.rateLimitType !== "five_hour" && notice.rateLimitType !== "seven_day")) return;
    const reset = notice.resetsAt;
    const until = typeof reset === "number" && Number.isFinite(reset) && reset > now
      ? Math.min(reset + 1000, now + MAX_RESET_WAIT_MS)
      : now + UNKNOWN_RESET_COOLDOWN_MS;
    this.blockedUntil.set(account.configDir, Math.max(this.blockedUntil.get(account.configDir) ?? 0, until));
    const index = accounts.findIndex((candidate) => candidate.configDir === account.configDir);
    if (index >= 0) this.nextAccount = (index + 1) % accounts.length;
  }

  nextReset(accounts: readonly ClaudeAccount[], now = Date.now()): number | undefined {
    const times = accounts.map((account) => this.blockedUntil.get(account.configDir) ?? 0).filter((time) => time > now);
    return times.length === accounts.length && times.length > 0 ? Math.min(...times) : undefined;
  }
}

const STATE_KEY = Symbol.for("pi-claude-code-provider.account-rotation.v1");

export function accountRotationState(): ClaudeAccountRotationState {
  const host = globalThis as Record<symbol, unknown>;
  if (host[STATE_KEY] instanceof ClaudeAccountRotationState) return host[STATE_KEY];
  const state = new ClaudeAccountRotationState();
  host[STATE_KEY] = state;
  return state;
}
