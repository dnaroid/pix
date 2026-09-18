import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const version = () => readJson(join(root, "package.json")).version;
export const nodeVersion = () => readFileSync(join(root, ".node-version"), "utf8").trim();
export const targets = {
  "linux-x64": { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-gnu", bundles: "appimage,deb" },
  "macos-arm64": { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", bundles: "app,dmg" },
  "windows-x64": { platform: "win32", arch: "x64", triple: "x86_64-pc-windows-msvc", bundles: "nsis,msi" },
};

export function hostTarget() {
  const entry = Object.entries(targets).find(([, target]) => target.platform === process.platform && target.arch === process.arch);
  if (!entry) throw new Error(`Unsupported release host: ${process.platform}/${process.arch}`);
  return entry[0];
}

export function targetInfo(name = hostTarget()) {
  const target = targets[name];
  if (!target) throw new Error(`Unsupported target: ${name}`);
  // Native modules must be installed and tested on their actual target, not copied across OS/CPU boundaries.
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(`Build ${name} on its native runner; current host is ${process.platform}/${process.arch}`);
  }
  return target;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, stdio: "inherit", timeout: 20 * 60_000, windowsHide: true, ...options,
  });
  if (result.error) {
    const diagnostic = [result.stdout, result.stderr].filter(Boolean).map(String).join("\n").slice(-24000);
    const error = new Error(`${command} failed to run: ${result.error.message}${diagnostic ? `\n${diagnostic}` : ""}`);
    error.cause = result.error;
    throw error;
  }
  if (result.status !== 0) {
    const diagnostic = [result.stdout, result.stderr].filter(Boolean).map(String).join("\n").slice(-24000);
    throw new Error(`${command} failed (${result.signal ?? result.status})${diagnostic ? `\n${diagnostic}` : ""}`);
  }
  return result.stdout;
}

export function npm(args, options = {}) {
  const candidates = [process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  const cli = candidates.find((path) => path && existsSync(path));
  if (!cli) throw new Error("Cannot locate npm-cli.js. Run this command through npm run.");
  // execFile/spawn of npm.cmd is not portable on Windows.
  return run(process.execPath, [cli, ...args], options);
}

export function outputPaths(name = hostTarget()) {
  targetInfo(name);
  const work = join(root, ".artifacts/releases", name);
  return { work, payload: join(work, "pix"), desktopPayload: join(work, "desktop/pix"), assets: join(work, "assets") };
}

export function nodeExecutable(payload) {
  return join(payload, "runtime", process.platform === "win32" ? "node.exe" : "node");
}
