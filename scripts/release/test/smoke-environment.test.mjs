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
