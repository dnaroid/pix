import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** @typedef {{ id: string, command: string, args: string[], isolatedHome?: boolean }} Step */
// Shared by the local gate and check.yml; no installs, release builds or live-model evals.
/** @returns {Step[]} */
export function ciPlan(platform = process.platform) {
  if (!["linux", "darwin", "win32"].includes(platform)) throw new Error(`Unsupported CI host: ${platform}`);
  const npm = (id, args, extra = {}) => ({ id, command: "npm", args, ...extra });
  const cargo = (id, args) => ({ id, command: "cargo", args: [...args, "--manifest-path", "desktop/src-tauri/Cargo.toml"] });
  return [
    npm("root", ["run", "check"]),
    npm("acp", ["run", "check:acp"]),
    ...(platform === "darwin" ? [
      npm("desktop-check", ["run", "check:desktop"]),
      npm("desktop-test", ["--prefix", "desktop", "test"]),
      cargo("rust-fmt", ["fmt", "--check"]),
      cargo("rust-check", ["check"]),
      cargo("rust-test", ["test", "--locked", "--lib", "backend_runtime"]),
    ] : []),
    npm("tools-suite", ["run", "test:tools-suite"], { isolatedHome: true }),
    ...(platform === "linux" ? [npm("browser-e2e", ["run", "test:browser-qa-e2e"])] : []),
  ];
}

export function resolveCommand(step, env, platform = process.platform) {
  if (step.command !== "npm") return [step.command, step.args];
  // npm scripts provide the selected npm CLI: no npm.cmd spawn or shell quoting needed.
  if (env.npm_execpath) return [process.execPath, [env.npm_execpath, ...step.args]];
  if (platform === "win32") return [env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...step.args]];
  return ["npm", step.args];
}

function stopOwnedChild(child, platform, signal) {
  if (!child.pid) return;
  if (platform === "win32") {
    // Only this gate's child tree, never process-name/global discovery.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== "ESRCH") child.kill(signal);
    }
  }
}

async function runStep(step, options, logPath) {
  const { env, cwd, platform, launch, signals, stopChild } = options;
  const [command, args] = resolveCommand(step, env, platform);
  const fd = openSync(logPath, "w");
  let child;
  try {
    child = launch(command, args, { cwd, env, stdio: ["ignore", fd, fd], windowsHide: true, detached: platform !== "win32" });
  } catch (error) {
    closeSync(fd);
    return { status: "failed", exitCode: 1, error: error.message };
  }
  return new Promise((resolveResult) => {
    let error;
    let interrupted;
    let escalation;
    const interrupt = (signal) => {
      if (interrupted) return;
      interrupted = signal;
      stopChild(child, platform, signal);
      escalation = setTimeout(() => stopChild(child, platform, "SIGKILL"), 5_000);
      escalation.unref();
    };
    const onInt = () => interrupt("SIGINT");
    const onTerm = () => interrupt("SIGTERM");
    signals.on("SIGINT", onInt);
    signals.on("SIGTERM", onTerm);
    child.on("error", (failure) => { error = failure.message; });
    child.once("close", (code, signal) => {
      clearTimeout(escalation);
      signals.removeListener("SIGINT", onInt);
      signals.removeListener("SIGTERM", onTerm);
      closeSync(fd);
      const incomplete = Boolean(interrupted || signal);
      let status = "failed";
      if (incomplete) status = "incomplete";
      else if (code === 0 && !error) status = "passed";
      let exitCode = code ?? 1;
      if (interrupted === "SIGINT") exitCode = 130;
      else if (interrupted === "SIGTERM") exitCode = 143;
      resolveResult({
        status,
        exitCode,
        signal: signal || interrupted || null,
        ...(error ? { error } : {}),
      });
    });
  });
}

/**
 * @param {{ platform?: NodeJS.Platform, cwd?: string, env?: NodeJS.ProcessEnv,
 *   plan?: Step[], artifactParent?: string,
 *   launch?: (command: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess,
 *   signals?: import('node:events').EventEmitter,
 *   stopChild?: typeof stopOwnedChild, report?: (message: string) => void }} [options]
 */
export async function runGate({
  platform = process.platform, cwd = repoRoot, env = process.env,
  plan = ciPlan(platform), artifactParent = join(cwd, ".pi/artifacts"),
  launch = spawn, signals = process, stopChild = stopOwnedChild, report = console.log,
} = {}) {
  mkdirSync(artifactParent, { recursive: true });
  const runDir = mkdtempSync(join(artifactParent, "check-ci-"));
  const home = join(runDir, "home");
  mkdirSync(home);
  const results = [];
  let exitCode = 0;
  for (const step of plan) {
    const logPath = join(runDir, `${step.id}.log`);
    const childEnv = { ...env, CI: "true", ...(step.isolatedHome ? {
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"),
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
    } : {}) };
    // Desktop profile/council capabilities must not redirect fixtures or reach the live host.
    delete childEnv.PIX_CONFIG_PROFILE;
    delete childEnv.PIX_BRAINSTORM_HOST_URL;
    delete childEnv.PIX_BRAINSTORM_HOST_TOKEN;
    report(`[check:ci] ${step.id}: ${step.command} ${step.args.join(" ")} (log: ${logPath})`);
    const result = await runStep(step, { env: childEnv, cwd, platform, launch, signals, stopChild }, logPath);
    results.push({ id: step.id, command: [step.command, ...step.args], logPath, ...result });
    report(`[check:ci] ${step.id}: ${result.status} (exit ${result.exitCode})`);
    if (result.status !== "passed") { exitCode = result.exitCode || 1; break; }
  }
  let status = exitCode ? "failed" : "passed";
  if (results.some((r) => r.status === "incomplete")) status = "incomplete";
  const summary = { status, platform, exitCode, results, notRun: plan.slice(results.length).map((s) => s.id) };
  const summaryPath = join(runDir, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  report(`[check:ci] ${status}; summary: ${summaryPath}`);
  return { ...summary, summaryPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--list") console.log(JSON.stringify(ciPlan(), null, 2));
  else if (args.length) { console.error("Usage: npm run check:ci [-- --list]"); process.exitCode = 1; }
  else {
    try { process.exitCode = (await runGate()).exitCode; }
    catch (error) { console.error(`[check:ci] ${error.message}`); process.exitCode = 1; }
  }
}
