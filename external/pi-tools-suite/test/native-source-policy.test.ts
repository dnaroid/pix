import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withSourcePolicyWriteLock } from "../src/project-search/source-policy-lock.mjs";
import { DEFAULT_SEARCH_SOURCES } from "../src/project-search/source-policy.mjs";
import { removeDirsWithRetry } from "./support/fs-retry.js";

const roots: string[] = [];
const artifacts = fileURLToPath(new URL("../../../.pi/artifacts/native-source-policy-tests/", import.meta.url));
const cli = fileURLToPath(new URL("../src/project-search/native-cli.mjs", import.meta.url));
afterEach(() => removeDirsWithRetry(roots));
async function fixture() {
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(join(artifacts, "run-")); roots.push(root);
  await mkdir(join(root, ".pi"));
  const file = join(root, ".pi/search-sources.json"), lock = file + ".lock";
  const original = JSON.stringify({ version: 1, enabled: DEFAULT_SEARCH_SOURCES });
  await writeFile(file, original);
  return { root, file, lock, original };
}
function run(root: string, executable: string, query: object, preload?: string) {
  const result = spawnSync(executable, [...(preload ? ["--import", pathToFileURL(preload).href] : []), cli, root], {
    input: JSON.stringify(query), encoding: "utf8", timeout: 10000,
    env: { ...process.env, HOME: root, OPENROUTER_API_KEY: "" },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
function failedPolicy(response: any) {
  expect(response.enabled).toEqual(Object.fromEntries(Object.keys(DEFAULT_SEARCH_SOURCES).map(source => [source, false])));
  expect(response.error).toEqual(expect.any(String));
  expect(response).not.toHaveProperty("hits");
}

for (const executable of ["node", "bun"]) {
  test(`${executable} CLI returns policy-shaped success and preserves legacy-lock diagnostics`, async () => {
    const f = await fixture();
    await writeFile(f.lock, "");
    const blocked = run(f.root, executable, { operation: "set-source-policy", source: "tasks", enabled: true });
    failedPolicy(blocked);
    expect(blocked.error).toMatch(/Legacy.*close/);
    expect(await readFile(f.file, "utf8")).toBe(f.original);
    await rm(f.lock); // Fixture-only offline legacy recovery, not production cleanup.
    const saved = run(f.root, executable, { operation: "set-source-policy", source: "tasks", enabled: true });
    expect(saved.enabled.tasks).toBe(true);
    expect(saved.error).toBeUndefined();
    expect(run(f.root, executable, { operation: "source-policy" })).toEqual(saved);
  });

  test(`${executable} CLI reports another host's held mutex as a safe policy error`, async () => {
    const f = await fixture();
    await withSourcePolicyWriteLock(f.root, async () => {
      const blocked = run(f.root, executable, { operation: "set-source-policy", source: "tasks", enabled: true });
      failedPolicy(blocked);
      expect(blocked.error).toMatch(/busy.*retry/i);
    });
    expect(await readFile(f.file, "utf8")).toBe(f.original);
  });

  test(`${executable} CLI malformed policy errors do not echo source bytes`, async () => {
    const f = await fixture();
    await writeFile(f.file, "SECRET-POLICY-CONTENT invalid JSON");
    for (const operation of ["source-policy", "set-source-policy"]) {
      const result = run(f.root, executable, { operation, source: "tasks", enabled: true });
      failedPolicy(result);
      expect(JSON.stringify(result)).not.toContain("SECRET-POLICY-CONTENT");
    }
  });
}

test("the policy watchdog uses the policy envelope instead of a search result", async () => {
  const f = await fixture(), preload = join(f.root, "timeout-preload.mjs");
  await writeFile(preload, `const schedule = globalThis.setTimeout;
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds === 40000) process.stdin.once('end', () => setImmediate(callback));
  return schedule(callback, milliseconds, ...args);
};`);
  const result = run(f.root, "node", { operation: "set-source-policy", source: "tasks", enabled: true }, preload);
  failedPolicy(result);
  expect(result.error).toContain("timed out");
});
