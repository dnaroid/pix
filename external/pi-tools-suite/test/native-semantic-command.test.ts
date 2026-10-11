import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { registerSemanticConsentCommand } from "../src/project-search/semantic-command.js";
import { repositoryEmbeddingSettings, repositoryEmbeddingKey, semanticConfigurationPath } from "../src/project-search/native-embedding-provider.mjs";

const roots: string[] = [];
const original = { HOME: process.env.HOME, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const embedding = { embeddingProvider: "ollama", embeddingModel: "fixture-only", vectorSize: 3 };
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "semantic-command-")); roots.push(root);
  process.env.HOME = root;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.PI_CODING_AGENT_DIR;
  await mkdir(join(root, ".config/pi"), { recursive: true });
  await writeFile(semanticConfigurationPath(), '{\n  // Keep suite-wide switches untouched.\n  "enabled": false,\n  "retained": 123,\n  "revision": "fixture"\n}\n');
  return root;
}
function command(root: string) {
  let handler: any;
  let refreshes = 0;
  const notices: string[] = [];
  registerSemanticConsentCommand({ registerCommand: (name: string, options: any) => {
    expect(name).toBe("search-semantic"); handler = options.handler;
  } } as never, () => { refreshes++; });
  return { notices, refreshes: () => refreshes, run: (args: string) => handler(args, { cwd: root, hasUI: false,
    ui: { confirm: () => { throw new Error("Configuration must not ask for another consent"); }, notify: (text: string) => notices.push(text) } }) };
}
afterEach(async () => {
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("ordinary Pi global semantic configuration", () => {
  test("history reset is a separate explicit command and rejects extra arguments", async () => {
    const root = await fixture(), cmd = command(root), path = semanticConfigurationPath();
    const before = await readFile(path, "utf8");
    await cmd.run("reset-history");
    expect(cmd.refreshes()).toBe(1);
    expect(cmd.notices.join("\n")).toContain("0");
    expect(await readFile(path, "utf8")).toBe(before);
    await cmd.run("reset-history other-project");
    expect(cmd.refreshes()).toBe(1);
    expect(cmd.notices[cmd.notices.length - 1]).toContain("Could not reset history vectors");
  });
  test("configuration itself enables every workspace without another consent; off retains unrelated fields", async () => {
    const root = await fixture(), path = semanticConfigurationPath(), cmd = command(root);
    const before = await readFile(path, "utf8");
    await cmd.run("status"); expect(await readFile(path, "utf8")).toBe(before);
    expect(cmd.refreshes()).toBe(0);
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    await cmd.run(`configure ${JSON.stringify(embedding)}`);
    expect(cmd.refreshes()).toBe(1);
    const first = await repositoryEmbeddingSettings(root);
    expect(first?.configs.code.model).toBe("fixture-only");
    expect(await repositoryEmbeddingSettings(join(root, "other-project"))).toEqual(first);
    expect(cmd.notices[cmd.notices.length - 1]).toContain("all projects and sources");
    const configuredText = await readFile(path, "utf8");
    const configured = parse(configuredText);
    expect(configured).toMatchObject({ search: { embedding }, retained: 123, enabled: false });
    expect(configuredText).toContain("// Keep suite-wide switches untouched.");
    await cmd.run("off");
    expect(cmd.refreshes()).toBe(2);
    const disabled = parse(await readFile(path, "utf8"));
    expect(disabled).toMatchObject({ retained: 123, enabled: false });
    expect(disabled.search?.embedding).toBeUndefined();
    expect(disabled.revision).toBe(configured.revision);
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
  });

  test("old project configuration, Desktop flags and existing credentials never imply configuration", async () => {
    const root = await fixture();
    await mkdir(join(root, ".pi/search"), { recursive: true });
    await writeFile(join(root, ".pi/search/semantic.json"), JSON.stringify({ enabled: true, embedding }));
    await writeFile(join(root, ".config/pi/pix-desktop.jsonc"), '{"search":{"tasksSemanticEnabled":true,"sessionTitlesEnabled":true}}');
    process.env.OPENROUTER_API_KEY = "fixture-key";
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
    await command(root).run("on");
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
  });

  test("malformed, linked, locked and invalid provider settings fail without replacement", async () => {
    const root = await fixture(), file = semanticConfigurationPath(), cmd = command(root);
    const before = await readFile(file, "utf8");
    await cmd.run('configure {"embeddingProvider":"ollama"}');
    expect(await readFile(file, "utf8")).toBe(before);
    await mkdir(`${file}.search.lock`);
    await cmd.run(`configure ${JSON.stringify(embedding)}`);
    expect(await readFile(file, "utf8")).toBe(before);
    await rm(`${file}.search.lock`, { recursive: true });
    await writeFile(file, '[]'); await cmd.run("off"); expect(await readFile(file, "utf8")).toBe('[]');
    const other = join(root, "target.json"); await writeFile(other, before);
    await rm(file); await symlink(other, file); await cmd.run("off");
    expect(await readFile(other, "utf8")).toBe(before);
  });

  test("credentials share environment precedence and saved Pi auth without reading legacy data", async () => {
    const root = await fixture();
    const agent = join(root, "agent"); process.env.PI_CODING_AGENT_DIR = agent;
    await mkdir(agent);
    await writeFile(join(agent, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "saved-fixture" } }));
    expect(await repositoryEmbeddingKey()).toBe("saved-fixture");
    process.env.OPENROUTER_API_KEY = "env-fixture";
    expect(await repositoryEmbeddingKey()).toBe("env-fixture");
    expect(await repositoryEmbeddingSettings(root)).toBeUndefined();
  });
});
