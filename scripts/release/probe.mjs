// This file is copied into each payload. It must use only bundled files and Node built-ins.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
assert.equal(process.env.PIX_RELEASE_SMOKE, "1", "Use the release smoke harness with an isolated user profile");
assert.equal(process.env.PI_OFFLINE, "1", "Release smoke must not contact model providers");
const app = join(root, "app");
const manifest = JSON.parse(readFileSync(join(root, "release.json"), "utf8"));
const dependencyInventory = JSON.parse(readFileSync(join(root, "DEPENDENCIES.json"), "utf8"));
assert.ok(["tui", "desktop"].includes(manifest.variant), "The payload must declare its variant");
assert.equal(process.versions.node, manifest.node.version, "The pinned bundled Node must execute this probe");
assert.equal(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version, manifest.version);
for (const path of ["bin/pix.mjs", "dist/main.js",
  "external/pi-tools-suite/index.ts", "schemas/pix.json", "skills/context7/SKILL.md"]) {
  assert.ok(existsSync(join(app, path)), `Missing payload file: ${path}`);
}
assert.equal(existsSync(join(app, "acp")), manifest.variant === "desktop", "Only Desktop includes ACP");
for (const name of ["question", "session-title", "workspace-undo"]) {
  const path = join(app, `dist/bundled-extensions/${name}/index.js`);
  assert.equal(typeof (await import(pathToFileURL(path).href)).default, "function");
  process.env[`PIX_ACP_${name.replaceAll("-", "_").toUpperCase()}_EXTENSION`] = path;
}

const require = createRequire(join(app, "package.json"));
require("@mariozechner/clipboard");
const pty = require("@lydell/node-pty");
await new Promise((resolvePromise, reject) => {
  const terminal = pty.spawn(process.execPath, ["-e", "process.stdout.write('PIX_NATIVE_PTY_OK')"], {
    name: "xterm", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
  let output = "";
  const timer = setTimeout(() => { terminal.kill(); reject(new Error("PTY probe timed out")); }, 30_000);
  const data = terminal.onData((chunk) => { output += chunk; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer); data.dispose();
    try { assert.equal(exitCode, 0); assert.match(output, /PIX_NATIVE_PTY_OK/u); resolvePromise(); }
    catch (error) { reject(error); }
  });
});

// Load the real TypeScript extension payload without contacting a model or mutating user settings.
const sdkRequire = createRequire(join(app, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { createJiti } = sdkRequire("jiti");
const jiti = createJiti(join(app, "package.json"), { interopDefault: true, fsCache: false });
assert.equal(typeof await jiti.import(join(app, "external/pi-tools-suite/index.ts"), { default: true }), "function");

// Exercise every retained esbuild host/binary pair, including versions nested by
// the SDK. Use the package inventory generated during release preparation instead
// of recursively walking tens of thousands of node_modules entries on Windows.
function verifyEsbuildInventory() {
  const appRoot = resolve(app);
  const directories = new Set();
  for (const entry of dependencyInventory) {
    if (entry?.name !== "esbuild" || typeof entry.path !== "string") continue;
    const packageJson = resolve(app, entry.path);
    assert.ok(packageJson.startsWith(`${appRoot}${sep}`), `Unsafe dependency inventory path: ${entry.path}`);
    directories.add(dirname(packageJson));
  }
  assert.ok(directories.size > 0, "Release payload must retain at least one esbuild package");
  for (const directory of directories) {
    const esbuild = require(directory);
    const result = esbuild.transformSync("const value: number = 42", { loader: "ts" });
    assert.match(result.code, /42/u);
    esbuild.stop();
  }
}
verifyEsbuildInventory();

if (manifest.variant === "desktop") {
for (const path of ["acp/dist/main.js", "acp/dist/pi/pix-rpc-entry.js"]) {
  assert.ok(existsSync(join(app, path)), `Missing Desktop payload file: ${path}`);
}
const child = spawn(process.execPath, [join(app, "acp/dist/main.js")], {
  cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-16000); });
const lines = createInterface({ input: child.stdout });
const messages = new Map();
const waiters = new Map();
let failure;
child.on("error", fail);
const exited = new Promise((resolveExit) => child.once("close", (code) => {
  fail(new Error(`ACP exited (${code}): ${stderr}`)); resolveExit(code);
}));
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.id !== undefined) { messages.set(message.id, message); waiters.get(message.id)?.resolve(message); }
  } catch (error) { fail(error); }
});

function fail(error) {
  failure = error;
  for (const waiter of waiters.values()) waiter.reject(error);
}

async function rpc(id, method, params) {
  if (failure) throw failure;
  let timer;
  try {
    const pending = new Promise((resolveRpc, reject) => {
      waiters.set(id, { resolve: resolveRpc, reject });
      timer = setTimeout(() => reject(new Error(`ACP ${method} timed out: ${stderr}`)), 60_000);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = messages.get(id) ?? await pending;
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  } finally { clearTimeout(timer); waiters.delete(id); }
}

try {
  const acpRequire = createRequire(join(app, "acp/package.json"));
  const { PROTOCOL_VERSION } = await import(pathToFileURL(acpRequire.resolve("@agentclientprotocol/sdk")).href);
  const initialized = await rpc(1, "initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "pix-release-smoke", version: "1" } });
  assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
  const session = await rpc(2, "session/new", { cwd: resolve(process.cwd()), mcpServers: [] });
  assert.equal(typeof session.sessionId, "string");
  await rpc(3, "session/close", { sessionId: session.sessionId });
} finally {
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 10_000);
  const code = await exited;
  clearTimeout(timer); lines.close();
  assert.equal(code, 0, stderr);
}
}
console.log(`PIX_RELEASE_RUNTIME_OK: ${manifest.variant}, pinned Node, native PTY, extensions, esbuild${manifest.variant === "desktop" ? ", ACP initialize/new/close" : ""}`);
