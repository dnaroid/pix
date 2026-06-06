#!/usr/bin/env node
/**
 * pix-desktop — CLI launcher for the Tauri-based Pix Desktop UI.
 *
 * Behaves like the regular `pix` CLI: launch from any project folder and
 * Pix Desktop treats that folder as the workspace cwd, scoping sessions to
 * it just like the terminal pix does.
 *
 * Usage:
 *   cd /path/to/project
 *   pix-desktop
 *
 * Environment:
 *   PIX_DESKTOP_BIN    Path to a specific Tauri binary (overrides discovery).
 *   PIX_DESKTOP_DEBUG  Set to "1" to log resolved binary/cwd before launch.
 *
 * Build the binary first via one of:
 *   cd apps/desktop-tauri && npm run tauri:dev    # development (with hot reload)
 *   cd apps/desktop-tauri && npm run tauri:build  # production bundle
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tauriTarget = join(here, "..", "src-tauri", "target");

const exeSuffix = platform() === "win32" ? ".exe" : "";
const macBundle = join(
  tauriTarget,
  "release",
  "bundle",
  "macos",
  "Pix.app",
  "Contents",
  "MacOS",
  "pix-desktop",
);

// Discovery order: env override → debug → release raw → release macOS bundle.
const candidates = [
  join(tauriTarget, "debug", `pix-desktop${exeSuffix}`),
  join(tauriTarget, "release", `pix-desktop${exeSuffix}`),
  macBundle,
];

if (process.env.PIX_DESKTOP_BIN) candidates.unshift(process.env.PIX_DESKTOP_BIN);

const bin = candidates.find((p) => existsSync(p));

if (!bin) {
  console.error("pix-desktop: Tauri binary not found. Build it first:");
  console.error("");
  console.error("  cd apps/desktop-tauri && npm run tauri:dev   # development");
  console.error("  cd apps/desktop-tauri && npm run tauri:build  # production");
  console.error("");
  console.error("Or set PIX_DESKTOP_BIN=/path/to/pix-desktop to point at a custom binary.");
  process.exit(127);
}

if (process.env.PIX_DESKTOP_DEBUG) {
  console.error(`[pix-desktop] binary: ${bin}`);
  console.error(`[pix-desktop] cwd:    ${process.cwd()}`);
}

const child = spawn(bin, process.argv.slice(2), {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise the signal in the launcher so wrapping shells see it.
    try { process.kill(process.pid, signal); } catch { /* ignore */ }
    process.exit(128 + 15); // SIGTERM-ish
  }
  process.exit(code ?? 0);
});

// Forward common signals to the child so Ctrl-C cleans up the Tauri window.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
