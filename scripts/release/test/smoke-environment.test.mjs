import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { smokeEnvironment, systemEnvironment } from "../smoke-environment.mjs";

test("smoke keeps OS plumbing but never inherits credentials or runtime overrides", () => {
  assert.deepEqual(systemEnvironment({ SystemRoot: "C:\\Windows", LANG: "en_US.UTF-8", DISPLAY: ":99",
    OPENAI_API_KEY: "secret", GH_TOKEN: "secret", APPLE_PASSWORD: "secret", CUSTOM_PROVIDER_TOKEN: "secret",
    NODE_OPTIONS: "--import injection.mjs", PIX_ACP_ENTRY: "other.js", PATH: "/developer/node", HOME: "/real/home" }),
  { SystemRoot: "C:\\Windows", LANG: "en_US.UTF-8", DISPLAY: ":99" });
});

test("smoke has isolated paths and a failing system-Node sentinel ahead of OS tools", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pix-smoke-env-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const { cwd, env } = await smokeEnvironment(scratch);
  assert.equal(env.HOME, join(scratch, "home"));
  assert.equal(cwd, join(scratch, "workspace with spaces"));
  assert.equal(env.PI_OFFLINE, "1");
  assert.equal(env.PIX_RELEASE_SMOKE, "1");
  const poison = env.PATH.split(delimiter)[0];
  assert.equal(poison, join(scratch, "no-system-node"));
  assert.match(await readFile(join(poison, process.platform === "win32" ? "node.cmd" : "node"), "utf8"), /86/u);
});

test("release probe uses the generated dependency inventory instead of recursively scanning node_modules", async () => {
  const probe = await readFile(join(process.cwd(), "scripts/release/probe.mjs"), "utf8");
  assert.match(probe, /DEPENDENCIES\.json/u);
  assert.match(probe, /entry\?\.name !== "esbuild"/u);
  assert.doesNotMatch(probe, /readdirSync/u);
});

test("Linux AppImage smoke delegates resource lookup to the native Tauri host", async () => {
  const smoke = await readFile(join(process.cwd(), "scripts/release/smoke-desktop.mjs"), "utf8");
  assert.match(smoke, /APPDIR: appdir/u);
  assert.match(smoke, /join\(appdir, "AppRun"\)/u);
  assert.doesNotMatch(smoke, /join\(appdir, "usr\/bin\/pix-desktop"\)/u);
  assert.doesNotMatch(smoke, /squashfs-root\/usr\/lib\/pix-desktop\/pix-runtime/u);
  assert.match(smoke, /findInstalledPayload\(extracted\)/u);
  assert.doesNotMatch(smoke, /join\(extracted, "usr\/lib\/pix-desktop\/pix-runtime"\)/u);
});

test("release probe exits explicitly after the success marker", async () => {
  const probe = await readFile(join(process.cwd(), "scripts/release/probe.mjs"), "utf8");
  const marker = probe.lastIndexOf("PIX_RELEASE_RUNTIME_OK");
  const exit = probe.lastIndexOf("process.exit(0)");
  assert.ok(marker >= 0 && exit > marker, "The one-shot probe must exit only after all verification succeeds");
});
