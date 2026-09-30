import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { migrateProviderSettings } from "../scripts/migrate-claude-provider.mjs";
import { PI_TOOLS_SUITE_MODULE_CATALOG } from "../external/pi-tools-suite/src/module-catalog.ts";

const exec = promisify(execFile);
const suite = resolve("external/pi-tools-suite");

test("SDK discovery loads exactly one local suite provider after migration (personal + project)", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-provider-registration-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await symlink(suite, join(agentDir, "extensions/pi-tools-suite"));
    for (const base of [agentDir, join(cwd, ".pi")]) {
      const legacy = join(base, "npm/node_modules/pi-claude-code-provider");
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "package.json"), JSON.stringify({ name: "pi-claude-code-provider", version: "0.5.0", pi: { extensions: ["./index.ts"] } }));
      await writeFile(join(legacy, "index.ts"), 'export default () => { throw new Error("LEGACY_FACTORY_MUST_NOT_RUN"); };');
      await writeFile(join(base, "settings.json"), migrateProviderSettings(JSON.stringify({ packages: ["npm:pi-claude-code-provider@0.5.0"] })));
    }
    const runner = join(root, "probe.mjs");
    await writeFile(runner, `
      import assert from 'node:assert/strict';
      const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))});
      const settingsManager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: true });
      const loader = new DefaultResourceLoader({ cwd: ${JSON.stringify(cwd)}, agentDir: ${JSON.stringify(agentDir)}, settingsManager,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      const result = loader.getExtensions();
      assert.deepEqual(result.errors, []);
      const providers = result.runtime.pendingProviderRegistrations.filter(p => p.name === 'pi-claude-code-provider');
      assert.equal(providers.length, 1);
      assert.equal(providers[0].config.api, 'pi-claude-code-provider-headless');
      assert.ok(providers[0].config.models.some(m => m.id === 'sonnet'));
      assert.ok(!result.extensions.some(e => e.path.includes('npm/node_modules/pi-claude-code-provider')));
      console.log('LOCAL_PROVIDER_REGISTERED_ONCE');
    `);
    const { stdout } = await exec(process.execPath, ["--import", import.meta.resolve("tsx"), runner], {
      cwd,
      env: {
        HOME: root, TMPDIR: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PI_CLAUDE_CODE_PROVIDER_PATH: resolve("external/pi-tools-suite/test/async-subagents/fixtures/provider-offline-cli.mjs"),
        PI_TOOLS_SUITE_DISABLED_MODULES: PI_TOOLS_SUITE_MODULE_CATALOG.filter(m => m.name !== "claude-code-provider").map(m => m.name).join(","),
      },
      timeout: 40_000, maxBuffer: 256 * 1024,
    });
    assert.match(stdout, /LOCAL_PROVIDER_REGISTERED_ONCE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
