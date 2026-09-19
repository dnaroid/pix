import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bootstrap = fileURLToPath(new URL("../bootstrap.mjs", import.meta.url));

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "pix-bootstrap-test-"));
  const paths = {
    home,
    agent: join(home, "pi-agent"),
    codex: join(home, "codex"),
    opencodeData: join(home, "opencode-data"),
    opencodeConfig: join(home, "opencode-config"),
    tools: join(home, "tools"),
  };
  await Promise.all([
    mkdir(paths.agent, { recursive: true }),
    mkdir(paths.codex, { recursive: true }),
    mkdir(paths.opencodeData, { recursive: true }),
    mkdir(paths.opencodeConfig, { recursive: true }),
  ]);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: paths.agent,
    CODEX_HOME: paths.codex,
    OPENCODE_DATA_DIR: paths.opencodeData,
    OPENCODE_CONFIG_DIR: paths.opencodeConfig,
    PIX_DESKTOP_TOOLS_DIR: paths.tools,
  };
  return { paths, env, cleanup: () => rm(home, { recursive: true, force: true }) };
}

function run(action, env) {
  const result = spawnSync(process.execPath, [bootstrap, action], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return { json: JSON.parse(result.stdout), stdout: result.stdout };
}

test("bootstrap inspect reports credential metadata without leaking Codex OAuth tokens", async () => {
  const { paths, env, cleanup } = await fixture();
  try {
    await writeFile(join(paths.codex, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "fixture-access-secret",
        refresh_token: "fixture-refresh-secret",
      },
    }));
    const { json, stdout } = run("inspect", env);
    assert.equal(json.codex.oauthDetected, true);
    assert.equal(json.codex.apiKeyDetected, false);
    assert.equal(stdout.includes("fixture-access-secret"), false);
    assert.equal(stdout.includes("fixture-refresh-secret"), false);
    assert.deepEqual(json.pi.providers, []);
  } finally {
    await cleanup();
  }
});

test("Codex API-key import writes Pi auth once and preserves an existing credential", async () => {
  const { paths, env, cleanup } = await fixture();
  try {
    await writeFile(join(paths.codex, "auth.json"), JSON.stringify({
      OPENAI_API_KEY: "fixture-codex-key-one",
    }));
    const first = run("import-codex-api-key", env).json;
    assert.equal(first.status, "imported");
    const firstAuth = JSON.parse(await readFile(join(paths.agent, "auth.json"), "utf8"));
    assert.equal(firstAuth.openai.key, "fixture-codex-key-one");

    await writeFile(join(paths.codex, "auth.json"), JSON.stringify({
      OPENAI_API_KEY: "fixture-codex-key-two",
    }));
    const second = run("import-codex-api-key", env).json;
    assert.equal(second.status, "auth-exists");
    const secondAuth = JSON.parse(await readFile(join(paths.agent, "auth.json"), "utf8"));
    assert.equal(secondAuth.openai.key, "fixture-codex-key-one");
  } finally {
    await cleanup();
  }
});

test("OpenCode bootstrap uses the suite importer and never overwrites Pi auth implicitly", async () => {
  const { paths, env, cleanup } = await fixture();
  try {
    await writeFile(join(paths.opencodeData, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "fixture-opencode-key-one" },
    }));
    const first = run("import-opencode", env).json;
    assert.equal(first.wroteAuth, true);
    assert.ok(first.providers.some((entry) => entry.targetProvider === "openai" && entry.status === "imported"));
    const firstAuth = JSON.parse(await readFile(join(paths.agent, "auth.json"), "utf8"));
    assert.equal(firstAuth.openai.key, "fixture-opencode-key-one");

    await writeFile(join(paths.opencodeData, "auth.json"), JSON.stringify({
      openai: { type: "api", key: "fixture-opencode-key-two" },
    }));
    const second = run("import-opencode", env).json;
    assert.equal(second.wroteAuth, false);
    assert.ok(second.providers.some((entry) => entry.targetProvider === "openai" && entry.status === "auth-exists-use-force"));
    const secondAuth = JSON.parse(await readFile(join(paths.agent, "auth.json"), "utf8"));
    assert.equal(secondAuth.openai.key, "fixture-opencode-key-one");
  } finally {
    await cleanup();
  }
});
