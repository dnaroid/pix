import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expectedDigest, nodeArchive } from "../node-runtime.mjs";
import { hostTarget, root, targetInfo, targets, version } from "../common.mjs";
import { checksums, expectedAssets } from "../checksums.mjs";
import { syncVersion, versionEdits } from "../sync-version.mjs";
import { assertDraft, findRelease } from "../publish-github.mjs";

test("release matrix names explicit OS/CPU pairs and rejects cross-host dependency copying", () => {
  assert.deepEqual(Object.keys(targets).sort(), ["linux-x64", "macos-arm64", "macos-x64", "windows-x64"]);
  const nativeTarget = Object.entries(targets).find(([, target]) => target.platform === process.platform && target.arch === process.arch)?.[0];
  if (nativeTarget) assert.equal(targetInfo(hostTarget()).arch, process.arch);
  else assert.throws(() => hostTarget(), /Unsupported release host/u);
  assert.throws(() => targetInfo("../../outside"), /Unsupported target/u);
  const other = Object.keys(targets).find((name) => name !== nativeTarget);
  assert.throws(() => targetInfo(other), /native runner/u);
});

test("Node downloads use exact, safe names for every supported target", () => {
  for (const { platform, arch } of Object.values(targets)) {
    const { filename } = nodeArchive("24.21.0", platform, arch);
    assert.match(filename, /^node-v24\.21\.0-(darwin|linux|win)-(arm64|x64)\.(tar\.gz|zip)$/u);
    assert.equal(filename.endsWith(".zip"), platform === "win32");
  }
  for (const version of ["latest", "../24.0.0", "24.0.0-rc.1", "24.0"]) {
    assert.throws(() => nodeArchive(version, "linux", "x64"), /exact stable/u);
  }
  assert.throws(() => nodeArchive("24.0.0", "linux", "ia32"), /Unsupported/u);
});

test("official checksums require an exact unique filename, not a substring", () => {
  const hash = "a".repeat(64);
  const sums = `${hash}  node.tar.gz\r\n${"b".repeat(64)} *node.tar.gz.sig\r\n`;
  assert.equal(expectedDigest(sums, "node.tar.gz"), hash);
  assert.throws(() => expectedDigest(sums, "node.tar"), /Missing/u);
  assert.throws(() => expectedDigest(`${sums}${hash}  node.tar.gz\n`, "node.tar.gz"), /ambiguous/u);
  assert.throws(() => expectedDigest("not-a-hash  node.tar.gz", "node.tar.gz"), /Missing/u);
});

test("checksums reject incomplete or unexpected releases and hash the complete set deterministically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pix-checksums-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = expectedAssets("1.2.3");
  assert.equal(files.length, 10);
  assert.equal(new Set(files).size, files.length);
  await assert.rejects(checksums(directory, "1.2.3"), /Incomplete/u);
  for (const file of files) await writeFile(join(directory, file), `fixture:${file}`);
  await checksums(directory, "1.2.3");
  const expected = files.map((file) => `${createHash("sha256").update(`fixture:${file}`).digest("hex")}  ${file}`).join("\n") + "\n";
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), expected);
  await checksums(directory, "1.2.3");
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), expected);
  await writeFile(join(directory, "unexpected.txt"), "not a release asset");
  await assert.rejects(checksums(directory, "1.2.3"), /unexpected release/u);
});

test("all shipped versions match the authoritative root version", () => {
  assert.equal(syncVersion({ check: true }), version());
  assert.throws(() => syncVersion({ check: true, tag: "v999.0.0" }), /does not match/u);
});

test("release reruns never replace already published assets", () => {
  assert.doesNotThrow(() => assertDraft({ tag_name: "v1.2.3", draft: true }, "v1.2.3"));
  assert.throws(() => assertDraft({ tag_name: "v1.2.3", draft: false }, "v1.2.3"), /Refusing/u);
  assert.throws(() => assertDraft({ tag_name: "v1.2.4", draft: true }, "v1.2.3"), /Refusing/u);
});

test("draft discovery paginates authenticated listings and fails closed on API errors", async () => {
  const calls = [];
  const draft = { tag_name: "v1.2.3", draft: true };
  const result = await findRelease("owner/repo", "v1.2.3", "test-token", async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return new Response(JSON.stringify(calls.length === 1 ? Array.from({ length: 100 }, () => ({ tag_name: "other" })) : [draft]));
  });
  assert.deepEqual(result, draft);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /page=2$/u);
  assert.equal(await findRelease("owner/repo", "missing", "token", async () => new Response("[]")), undefined);
  await assert.rejects(findRelease("owner/repo", "v1.2.3", "token", async () => new Response("", { status: 403 })), /no release was modified/u);
});

test("version synchronization changes only Pix's Cargo package and all app manifests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pix-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const prefix of ["", "acp/", "desktop/"]) {
    await mkdir(join(directory, prefix), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) {
      await copyFile(join(root, prefix, file), join(directory, prefix, file));
    }
  }
  await mkdir(join(directory, "desktop/src-tauri"), { recursive: true });
  for (const file of ["Cargo.toml", "Cargo.lock", "tauri.conf.json"]) {
    await copyFile(join(root, "desktop/src-tauri", file), join(directory, "desktop/src-tauri", file));
  }
  const before = await readFile(join(directory, "desktop/src-tauri/Cargo.lock"), "utf8");
  const edits = versionEdits(directory, "2.3.4");
  assert.equal(edits.size, 8);
  assert.equal(edits.get("desktop/src-tauri/Cargo.lock"), before.replace(/(name = "pix-desktop"\r?\nversion = ")[^"]+/u, "$12.3.4"));
  for (const [path, content] of edits) {
    if (path.endsWith(".json")) {
      const data = JSON.parse(content);
      assert.equal(data.version, "2.3.4", path);
      if (data.packages) assert.equal(data.packages[""].version, "2.3.4", path);
    }
    await writeFile(join(directory, path), content);
  }
  assert.deepEqual(versionEdits(directory, "2.3.4"), edits);
  for (const invalid of ["1.0.0-beta.1", "01.0.0", "256.0.0", "1.256.0", "1.2.65536", "../../oops"]) {
    assert.throws(() => versionEdits(directory, invalid), /version|Version/u);
  }
});

test("version synchronization preserves CRLF JSON files on Windows checkouts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pix-version-crlf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const prefix of ["", "acp/", "desktop/"]) {
    await mkdir(join(directory, prefix), { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) {
      const source = await readFile(join(root, prefix, file), "utf8");
      await writeFile(join(directory, prefix, file), source.replaceAll("\n", "\r\n"));
    }
  }
  await mkdir(join(directory, "desktop/src-tauri"), { recursive: true });
  for (const file of ["Cargo.toml", "Cargo.lock", "tauri.conf.json"]) {
    const source = await readFile(join(root, "desktop/src-tauri", file), "utf8");
    await writeFile(join(directory, "desktop/src-tauri", file), source.replaceAll("\n", "\r\n"));
  }

  const edits = versionEdits(directory, version());
  for (const [path, content] of edits) {
    assert.equal(content, await readFile(join(directory, path), "utf8"), path);
  }
});
