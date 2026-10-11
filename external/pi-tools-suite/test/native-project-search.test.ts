import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, symlink, link, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { searchNative } from "../src/project-search/native-engine.mjs";
import { scanProject, SCAN_LIMITS, validateMissingSources } from "../src/project-search/native-scan.mjs";
import { openStore, snapshot, publish, queryStore } from "../src/project-search/native-store.mjs";
import { indexNativeProject, searchNativeProject } from "../src/project-search/native.ts";

const artifactRoot = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
const roots: string[] = [];
const cli = fileURLToPath(new URL("../src/project-search/native-cli.mjs", import.meta.url));
const storeModule = new URL("../src/project-search/native-store.mjs", import.meta.url).href;
const scanModule = new URL("../src/project-search/native-scan.mjs", import.meta.url).href;
const request = (query: string, extra = {}) => ({ query, sources: ["code", "knowledge"], mode: "lexical", ...extra });
async function fixture() {
  await mkdir(artifactRoot, { recursive: true });
  const root = await mkdtemp(path.join(artifactRoot, "native-search-fixture-"));
  roots.push(root); return root;
}
async function put(root: string, name: string, value: string | Uint8Array) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), value);
}
const digest = (buffer: Uint8Array) => createHash("sha256").update(buffer).digest("hex");
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }); });

function childCli(executable: string, root: string, query: string) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(executable, [cli, root], { stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OPENROUTER_API_KEY: "", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "" } });
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(Buffer.concat(errors).toString()));
      else { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } }
    });
    child.stdin.end(JSON.stringify(request(query)));
  });
}

describe("independent native Code/Knowledge search", () => {
  test("indexes Godot source, scene and resource formats but excludes generated .godot data", async () => {
    const root = await fixture();
    const names = ["player.gd", "level.tscn", "theme.tres", "project.godot", "water.gdshader", "shared.gdshaderinc"];
    for (const name of names) await put(root, name, "GodotSearchNeedle\n");
    await put(root, ".godot/imported/generated.gd", "GodotSearchNeedle\n");
    const result = await searchNative(root, request("GodotSearchNeedle", { limit: 20 }));
    expect(result.hits.map(hit => hit.path).sort()).toEqual(names.sort());
    expect(result.hits.every(hit => hit.kind === "code")).toBe(true);
  });
  test("overlong source lines are excluded without blocking healthy files or stale-row removal", async () => {
    const root = await fixture();
    await put(root, "healthy.ts", "export const healthyNeedle = true;");
    await put(root, "long.json", JSON.stringify({ data: "x".repeat(9000) }));
    const cold = await searchNative(root, request("healthyNeedle"));
    expect(cold.status.complete).toBe(true);
    expect(cold.hits.map(hit => hit.path)).toContain("healthy.ts");
    expect(cold.notices.join(" ")).toContain("Excluded 1");
    await put(root, "long.json", JSON.stringify({ data: "retiredNeedle" }));
    expect((await searchNative(root, request("retiredNeedle"))).hits.map(hit => hit.path)).toContain("long.json");
    await put(root, "long.json", JSON.stringify({ data: "retiredNeedle" + "x".repeat(9000) }));
    const warm = await searchNative(root, request("retiredNeedle"));
    expect(warm.status.complete).toBe(true);
    expect(warm.hits.map(hit => hit.path)).not.toContain("long.json");
    expect((await searchNative(root, request("healthyNeedle"))).hits.map(hit => hit.path)).toContain("healthy.ts");
  });

  test("a missing tracked source or ignore file recreated before validation invalidates freshness", async () => {
    const root = await fixture();
    const absent = ["tracked.ts", ".gitignore"];
    const deadline = Date.now() + 10000;
    expect(await validateMissingSources(root, absent, deadline)).toBe(true);
    await put(root, "tracked.ts", "recreatedNeedle");
    expect(await validateMissingSources(root, absent, deadline)).toBe(false);
    await rm(path.join(root, "tracked.ts"));
    await put(root, ".gitignore", "*.ts");
    expect(await validateMissingSources(root, absent, deadline)).toBe(false);
  });

  test("unchanged heading-dense files use exact chunk counts and preserve the prior snapshot at the cap", async () => {
    const root = await fixture();
    const headings = Array.from({ length: SCAN_LIMITS.chunks - 10 }, (_, i) => i ? `## heading-${i}` : "# retainedSentinel").join("\n");
    await put(root, "dense.md", headings);
    const initial = await searchNative(root, request("retainedSentinel", { sources: ["knowledge"] }));
    expect(initial.status.complete).toBe(true);
    await put(root, "new.md", Array.from({ length: 20 }, (_, i) => `## new-${i}`).join("\n"));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await searchNative(root, request("retainedSentinel", { sources: ["knowledge"] }));
      expect(result.status.generation).toBe(initial.status.generation);
      expect(result.status.stale).toBe(true);
      expect(result.hits).toEqual(initial.hits);
      expect(result.notices.join(" ")).toContain("previous snapshot retained");
      expect(result.notices.join(" ")).not.toContain("unavailable");
    }
  }, 30000);

  test("shared transport supports Desktop and agent candidate counts above twenty", async () => {
    const root = await fixture();
    for (let n = 0; n < 35; n++) await put(root, `src/file-${n}.ts`, "export const candidateCountNeedle = true;");
    const result = await searchNativeProject(root, { query: "candidateCountNeedle", sources: ["code"], limit: 100 }, new AbortController().signal);
    expect(result.status.complete).toBe(true);
    expect(result.hits.length).toBe(35);
  });

  test.skipIf(process.platform === "win32")("cancellation terminates the owned Git enumerator and descendant", async () => {
    const root = await fixture();
    const bin = path.join(root, "bin");
    const marker = path.join(root, "git-child.pid");
    await put(root, "bin/git", `#!/bin/sh\n/bin/sleep 30 &\necho $! > "$NATIVE_TEST_MARKER"\nwait\n`);
    await chmod(path.join(bin, "git"), 0o755);
    const previousPath = process.env.PATH, previousMarker = process.env.NATIVE_TEST_MARKER;
    const controller = new AbortController();
    let pid = 0;
    try {
      process.env.PATH = bin;
      process.env.NATIVE_TEST_MARKER = marker;
      const pending = searchNativeProject(root, { query: "irrelevant", sources: ["code"] }, controller.signal);
      for (let attempt = 0; attempt < 100; attempt++) {
        try { pid = Number((await readFile(marker, "utf8")).trim()); if (pid) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(pid).toBeGreaterThan(0);
      controller.abort();
      expect((await pending).notices.join(" ")).toContain("cancelled");
      let live = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { live = !execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
        catch { live = false; }
        if (!live) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(live).toBe(false);
    } finally {
      controller.abort();
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousMarker === undefined) delete process.env.NATIVE_TEST_MARKER; else process.env.NATIVE_TEST_MARKER = previousMarker;
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  });

  test("indexes without IDX or keys; path, camelCase and Markdown heading tokens have exact references", async () => {
    const root = await fixture();
    await put(root, "src/HTTPTransport.ts", Array.from({ length: 125 }, (_, i) => i === 71
      ? "export function deliverCamelCaseNeedle() {}" : `// source line ${i + 1}`).join("\n"));
    await put(root, "docs/design.md", "# Design\nIntro\n\n## Durable Refresh\nAtomic publication details\n");
    const code = await searchNative(root, request("camel case needle", { includeContent: true }));
    expect(code.status.complete).toBe(true);
    expect(code.status.scannedFiles).toBe(2);
    expect(code.hits.length).toBeGreaterThan(0);
    const original = (await readFile(path.join(root, "src/HTTPTransport.ts"), "utf8")).split("\n");
    for (const hit of code.hits) {
      expect(hit.path).toBe("src/HTTPTransport.ts");
      expect(hit.startLine).toBeLessThanOrEqual(72); expect(hit.endLine).toBeGreaterThanOrEqual(72);
      expect(hit.endLine - hit.startLine).toBeLessThan(60);
      expect(hit.content).toBe(original.slice(hit.startLine - 1, hit.endLine).join("\n"));
    }
    const heading = await searchNative(root, request("durable refresh", { sources: ["knowledge"], includeContent: true }));
    expect(heading.hits[0].title).toBe("Durable Refresh");
    expect(heading.hits[0].startLine).toBe(4); expect(heading.hits[0].endLine).toBe(5);
    const filename = await searchNative(root, request("http transport", { sources: ["code"], dedupeFile: true }));
    expect(filename.hits.map(hit => hit.path)).toEqual(["src/HTTPTransport.ts"]);
    expect((await searchNative(root, request("needle", { pathPrefix: "docs" }))).hits).toEqual([]);
  });

  test("incremental content hashes cover unchanged/edit/delete/rename and never touch semantic database", async () => {
    const root = await fixture();
    await put(root, "old.ts", "export const originalNeedle = 1;\n");
    await mkdir(path.join(root, ".pi/search"), { recursive: true });
    const vectors = new Database(path.join(root, ".pi/search/index.sqlite"), { create: true });
    vectors.exec("PRAGMA journal_mode=WAL; CREATE TABLE paid_vectors(value TEXT); INSERT INTO paid_vectors VALUES('keep'); BEGIN IMMEDIATE;");
    try {
    const vectorBefore = digest(await readFile(path.join(root, ".pi/search/index.sqlite")));
    const first = await searchNative(root, request("original needle"));
    expect(first.status.updatedFiles).toBe(1);
    const second = await searchNative(root, request("original needle"));
    expect(second.status.updatedFiles).toBe(0);
    expect(second.hits).toEqual(first.hits);
    await put(root, "old.ts", "export const replacementNeedle = 1;\n");
    expect((await searchNative(root, request("original"))).hits).toEqual([]);
    expect((await searchNative(root, request("replacement"))).hits[0].path).toBe("old.ts");
    await rename(path.join(root, "old.ts"), path.join(root, "renamed.ts"));
    expect((await searchNative(root, request("replacement"))).hits[0].path).toBe("renamed.ts");
    await rm(path.join(root, "renamed.ts"));
    const deleted = await searchNative(root, request("replacement"));
    expect(deleted.status.complete).toBe(true); expect(deleted.hits).toEqual([]);
    expect(digest(await readFile(path.join(root, ".pi/search/index.sqlite")))).toBe(vectorBefore);
    expect(vectors.query("SELECT value FROM paid_vectors").get()).toEqual({ value: "keep" });
    } finally { vectors.exec("ROLLBACK"); vectors.close(); }
  });

  test("non-Git nested ignores, negation, binary/UTF8/size and all linked/excluded sources", async () => {
    const root = await fixture();
    await put(root, ".gitignore", "*.ts\n!visible.ts\n!nested/\n");
    await put(root, "visible.ts", "visibleNeedle");
    await put(root, "ignored.ts", "secretNeedle");
    await put(root, "nested/.gitignore", "!kept.ts\nprivate.md\n");
    await put(root, "nested/kept.ts", "nestedNeedle");
    await put(root, "nested/private.md", "secretNeedle");
    await put(root, "binary.md", Buffer.from([0, 65]));
    await put(root, "controls.md", Buffer.from([1, 2, 65]));
    await put(root, "invalid.md", Buffer.from([0xff, 0xfe, 65]));
    await put(root, "huge.md", "z".repeat(SCAN_LIMITS.fileBytes + 1));
    await put(root, "hard.md", "hardLinkNeedle");
    await link(path.join(root, "hard.md"), path.join(root, "hard-alias.md"));
    const outside = await fixture();
    await put(outside, "outside.md", "secretNeedle");
    await symlink(path.join(outside, "outside.md"), path.join(root, "redirect.md"));
    await symlink(outside, path.join(root, "linked-directory"));
    for (const folder of [".pi", ".git", ".indexer-cli", "node_modules", "build", "dist", "target", "coverage", ".artifacts"]) {
      await put(root, `${folder}/excluded.md`, "secretNeedle");
    }
    const visible = await searchNative(root, request("needle", { dedupeFile: true }));
    expect(visible.status.complete).toBe(true);
    expect(visible.hits.map(hit => hit.path).sort()).toEqual(["nested/kept.ts", "visible.ts"]);
    expect(visible.notices.some(notice => notice.includes("Excluded"))).toBe(true);
    expect((await searchNative(root, request("secret"))).hits).toEqual([]);
    expect((await searchNative(root, request("hard"))).hits).toEqual([]);
  });

  test("Git enumeration honors ignored untracked files but includes ignored tracked files and working-tree deletions", async () => {
    const root = await fixture();
    execFileSync("git", ["init", "--quiet", root]);
    await put(root, "tracked.ts", "trackedNeedle");
    execFileSync("git", ["add", "tracked.ts"], { cwd: root });
    await put(root, ".gitignore", "*.ts\n!visible.ts\n");
    await put(root, "hidden.ts", "hiddenNeedle");
    await put(root, "visible.ts", "visibleNeedle");
    const result = await searchNative(root, request("needle", { dedupeFile: true }));
    expect(result.status.complete).toBe(true);
    expect(result.hits.map(hit => hit.path).sort()).toEqual(["tracked.ts", "visible.ts"]);
    await rm(path.join(root, "tracked.ts"));
    const deleted = await searchNative(root, request("tracked"));
    expect(deleted.status.complete).toBe(true); expect(deleted.hits).toEqual([]);
  });

  test("test exclusion, source scope, stable ties and non-authoritative bounded query", async () => {
    const root = await fixture();
    await put(root, "b.ts", "tieNeedle"); await put(root, "a.ts", "tieNeedle");
    await put(root, "a.test.ts", "tieNeedle"); await put(root, "docs.md", "tieNeedle");
    expect((await searchNative(root, request("tie needle", { sources: ["code"], excludeTests: true }))).hits.map(hit => hit.path)).toEqual(["a.ts", "b.ts"]);
    expect((await searchNative(root, request("tie needle", { sources: ["knowledge"] }))).hits.map(hit => hit.path)).toEqual(["docs.md"]);
    for (let i = 0; i < 205; i++) await put(root, `many/file-${i}.ts`, "broadTerm");
    const capped = await searchNative(root, request("broad term", { limit: 20 }));
    expect(capped.hits.length).toBe(20); expect(capped.status.complete).toBe(false);
    expect(capped.status.stale).toBe(false);
    expect(capped.notices.some(notice => notice.includes("candidate limit"))).toBe(true);
  });

  test("incomplete Knowledge scanning retains its snapshot while Code independently updates", async () => {
    const root = await fixture();
    await put(root, "valid.ts", "oldNeedle");
    await put(root, "retained.md", "retainedKnowledgeNeedle");
    await searchNative(root, request("old needle"));
    await put(root, "valid.ts", "newNeedle");
    await put(root, "overflow.md", Array.from({ length: SCAN_LIMITS.chunks }, (_, i) => `# section-${i}`).join("\n"));
    const result = await searchNative(root, request("needle"));
    expect(result.status.complete).toBe(false); expect(result.status.stale).toBe(true);
    expect(result.hits.map(hit => hit.path)).toContain("valid.ts");
    expect(result.hits.map(hit => hit.path)).toContain("retained.md");
    const code = await searchNative(root, request("new needle", { sources: ["code"] }));
    expect(code.status.complete).toBe(true);
    expect(code.hits[0].path).toBe("valid.ts");
    expect(result.notices.some(notice => notice.includes("previous snapshot retained"))).toBe(true);
    const store = await openStore(root);
    try {
      const expired = await scanProject(root, snapshot(store), Date.now() - 1);
      expect(expired.complete).toBe(false);
    } finally { store.close(); }
  });

  test("storage rejects directory/database/sidecar symlinks and hard links without overwriting targets", async () => {
    for (const destination of [".pi", ".pi/search", ".pi/search/code.sqlite", ".pi/search/code.sqlite-wal", ".pi/search/code.sqlite-shm", ".pi/search/code.sqlite-journal"]) {
      const root = await fixture(), outside = await fixture();
      const directory = destination === ".pi" || destination === ".pi/search";
      const target = directory ? outside : path.join(outside, "target");
      if (!directory) await writeFile(target, "DO NOT OVERWRITE");
      await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
      await symlink(target, path.join(root, destination));
      const result = await searchNative(root, request("anything"));
      expect(result.status.complete).toBe(false); expect(result.hits).toEqual([]);
      if (!directory) expect(await readFile(target, "utf8")).toBe("DO NOT OVERWRITE");
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const root = await fixture(), outside = await fixture();
      await put(outside, "target", "DO NOT OVERWRITE");
      await mkdir(path.join(root, ".pi/search"), { recursive: true });
      await link(path.join(outside, "target"), path.join(root, `.pi/search/code.sqlite${suffix}`));
      const result = await searchNative(root, request("anything"));
      expect(result.status.complete).toBe(false);
      expect(await readFile(path.join(outside, "target"), "utf8")).toBe("DO NOT OVERWRITE");
    }
  });

  test("root/source ancestor redirection and escape requests fail closed", async () => {
    const root = await fixture(), outside = await fixture();
    await put(outside, "a.ts", "outsideNeedle");
    execFileSync("git", ["init", "--quiet", root]);
    await put(root, "nested/a.ts", "trackedNeedle");
    execFileSync("git", ["add", "nested/a.ts"], { cwd: root });
    await rm(path.join(root, "nested"), { recursive: true });
    await symlink(outside, path.join(root, "nested"));
    const result = await searchNative(root, request("outside"));
    expect(result.status.complete).toBe(true); expect(result.hits).toEqual([]);
    const redirected = path.join(root, "root-link"); await symlink(outside, redirected);
    expect((await searchNative(redirected, request("outside"))).status.complete).toBe(false);
    for (const prefix of ["../", "../a.ts", "/absolute", "nested/../a.ts", "nested\\a.ts"]) {
      expect((await searchNative(root, request("outside", { pathPrefix: prefix }))).status.complete).toBe(false);
    }
    expect((await searchNative(root, request("outside", { sources: ["tasks"] }))).status.complete).toBe(false);
  });

  test("unknown schema/version fails closed; valid namespaced schema preserves unrelated rows", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".pi/search"), { recursive: true });
    const filename = path.join(root, ".pi/search/code.sqlite");
    const unknown = new Database(filename, { create: true });
    unknown.exec("CREATE TABLE paid_vectors(value TEXT); INSERT INTO paid_vectors VALUES('keep'); PRAGMA user_version=37;");
    unknown.close();
    const before = digest(await readFile(filename));
    expect((await searchNative(root, request("anything"))).status.complete).toBe(false);
    expect(digest(await readFile(filename))).toBe(before);
    const valid = await fixture(); await put(valid, "a.ts", "needle");
    await searchNative(valid, request("needle"));
    const db = new Database(path.join(valid, ".pi/search/code.sqlite"));
    db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep');");
    expect((await searchNative(valid, request("needle"))).status.complete).toBe(true);
    expect(db.query("SELECT value FROM unrelated").get()).toEqual({ value: "keep" });
    db.exec("UPDATE pix_native_meta SET version=99");
    expect((await searchNative(valid, request("needle"))).status.complete).toBe(false);
    expect(db.query("SELECT version FROM pix_native_meta").get()).toEqual({ version: 99 });
    db.close();
  });

  test("Node and Bun CLI each emit one JSON response with equivalent ranking", async () => {
    const root = await fixture(); await put(root, "a.ts", "runtimeParityNeedle");
    const node = await childCli("node", root, "runtime parity needle");
    const bun = await childCli(process.execPath, root, "runtime parity needle");
    expect(node.status.complete).toBe(true); expect(bun.status.complete).toBe(true);
    expect(node.hits).toEqual(bun.hits);
    expect(node.hits[0].path).toBe("a.ts");
    const wrapper = await searchNativeProject(root, { query: "runtime", sources: ["code"] }, new AbortController().signal);
    expect(wrapper.status.complete).toBe(true);
  });

  test("multibyte headings/content obey the serialized output budget without corrupting UTF8", async () => {
    const root = await fixture();
    const heading = "你".repeat(7600);
    for (let i = 0; i < 20; i++) await put(root, `doc-${i}.md`, `# ${heading}\nwideOutputNeedle\n`);
    const result = await searchNativeProject(root, { query: "wide output needle", sources: ["knowledge"],
      limit: 20, includeContent: true }, new AbortController().signal);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThan(20);
    expect(result.status.complete).toBe(false); expect(result.status.stale).toBe(false);
    expect(result.notices.some(notice => notice.includes("output limit"))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(480 * 1024);
    expect(result.hits[0].title).toBe(heading);
    expect(result.hits[0].content).toContain(heading);
  });

  test("cancelled transport reaps child and a following search remains usable", async () => {
    const root = await fixture(); await put(root, "a.ts", "cancelNeedle");
    const controller = new AbortController();
    const pending = searchNativeProject(root, { query: "cancel", sources: ["code"] }, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.status.complete).toBe(false); expect(result.notices[0]).toContain("cancelled");
    expect((await searchNative(root, request("cancel"))).status.complete).toBe(true);
  });

  test("manual index transport accepts document responses and cancellation without a query", async () => {
    const root = await fixture(); await put(root, "a.ts", "indexOnlyNeedle");
    const home = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await indexNativeProject(root, "code", new AbortController().signal);
      expect(result.source).toBe("code");
      expect(result.complete).toBe(false);
      expect(result.message).toContain("configuration is unavailable");
      const controller = new AbortController();
      const pending = indexNativeProject(root, "knowledge", controller.signal);
      controller.abort();
      expect(await pending).toMatchObject({ source: "knowledge", complete: false });
    } finally { process.env.HOME = home; }
  });

  test("a competing process's stale scan cannot overwrite a newer completed generation", async () => {
    const root = await fixture(); await put(root, "a.ts", "firstNeedle");
    await searchNative(root, request("first"));
    const script = `import {openStore,snapshot,publish} from ${JSON.stringify(storeModule)};
      import {scanProject} from ${JSON.stringify(scanModule)};
      const store=await openStore(process.argv[1]); const prior=snapshot(store);
      const scan=await scanProject(process.argv[1],prior);
      process.stdout.write('ready\\n');
      for await (const data of process.stdin) { process.stdout.write(JSON.stringify({published:publish(store,prior,scan)})); break; }
      store.close();`;
    const child = spawn("node", ["--input-type=module", "-e", script, root], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("ready\n")) resolve(); });
      child.on("error", reject); child.on("exit", code => { if (!output.includes("ready\n")) reject(new Error(`child exit ${code}`)); });
    });
    const closed = new Promise<number | null>(resolve => child.on("close", resolve));
    try {
      await ready;
      await put(root, "a.ts", "secondNeedle");
      expect((await searchNative(root, request("second"))).status.complete).toBe(true);
      child.stdin.end("publish\n");
      expect(await closed).toBe(0);
      expect(JSON.parse(output.split("\n")[1])).toEqual({ published: false });
      const store = await openStore(root);
      try { expect(queryStore(store, request("second")).hits[0].snippet).toContain("secondNeedle"); }
      finally { store.close(); }
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await closed; } }
  });

  test("atomic publish rolls back errors and killed SQLite writers without partial results", async () => {
    const root = await fixture(); await put(root, "a.ts", "beforeNeedle");
    await searchNative(root, request("before"));
    const store = await openStore(root);
    try {
      const prior = snapshot(store);
      const invalid = { files: new Map([["a.ts", { hash: "changed", chunks: [{ id: "bad", kind: "code", title: "bad",
        startLine: 1, endLine: 1, content: null, isTest: false }] }]]) };
      expect(() => publish(store, prior, invalid)).toThrow();
      expect(snapshot(store).generation).toBe(prior.generation);
      expect(queryStore(store, request("before")).hits[0].snippet).toBe("beforeNeedle");
    } finally { store.close(); }
    const reader = await openStore(root);
    const script = `import {openStore} from ${JSON.stringify(storeModule)};
      const store=await openStore(process.argv[1]); store.db.exec("BEGIN IMMEDIATE; DELETE FROM pix_native_fts; DELETE FROM pix_native_chunks;");
      process.stdout.write('ready'); for await (const data of process.stdin) {}`;
    const child = spawn("node", ["--input-type=module", "-e", script, root], { stdio: ["pipe", "pipe", "pipe"] });
    const closed = new Promise<number | null>(resolve => child.on("close", resolve));
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject);
        child.once("exit", code => { if (code !== null) reject(new Error(`child exit ${code}`)); }); });
      expect(queryStore(reader, request("before")).hits[0].snippet).toBe("beforeNeedle");
      child.kill("SIGKILL"); await closed;
      const reopened = await openStore(root);
      try { expect(queryStore(reopened, request("before")).hits[0].snippet).toBe("beforeNeedle"); }
      finally { reopened.close(); }
    } finally { reader.close(); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
  });
});
