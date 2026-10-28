import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const checker = join(root, "scripts/check-wiki.ts");

function check(files: Record<string, string>) {
  const artifacts = join(root, ".pi/artifacts");
  mkdirSync(artifacts, { recursive: true });
  const workspace = mkdtempSync(join(artifacts, "wiki-check-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(workspace, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return spawnSync(process.execPath, ["--import", "tsx", checker, workspace], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("Wiki checker handles adjacent links, Desktop slugs and local resources", () => {
  const result = check({
    "wiki/index.md": "# Home\n[A](a.md#заголовок-code) · [B](b.md#same-1)\n![Picture](assets/picture.svg)\n",
    "wiki/a.md": "# Заголовок: `code`\n[Home](index.md)\n",
    "wiki/b.md": "# Same\n# Same\n",
    "wiki/assets/picture.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 pages; 4 local links; 1 images; 0 errors/);
});

test("Wiki checker reports missing pages, anchors, media and orphan pages", () => {
  const result = check({
    "wiki/index.md": "# Home\n[Missing](missing.md) [Anchor](a.md#absent) ![Media](absent.png)\n",
    "wiki/a.md": "# Present\n",
    "wiki/orphan.md": "# Orphan\n",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing\.md — missing target/);
  assert.match(result.stderr, /missing heading #absent/);
  assert.match(result.stderr, /absent\.png — missing target/);
  assert.match(result.stderr, /orphan\.md: not reachable/);
});

test("Wiki checker resolves reference and HTML links but ignores examples", () => {
  const result = check({
    "wiki/index.md": '# Home\n[Page][p]\n[p]: a.md\n<img src="picture.svg">\n`[example](missing.md)`\n~~~md\n[example](also-missing.md)\n~~~\n',
    "wiki/a.md": '# Page\n<a href="index.md#home">Home</a>\n',
    "wiki/picture.svg": "<svg/>",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 pages; 3 local links; 1 images; 0 errors/);
});
