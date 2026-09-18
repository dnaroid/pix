import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { root, targets } from "../common.mjs";

// The locked Pi SDK already depends on yaml; resolve it from that package without adding a build dependency.
const require = createRequire(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"));
const { parse } = require("yaml");
const workflow = parse(readFileSync(join(root, ".github/workflows/publish.yml"), "utf8"));

test("release matrix covers every supported native OS/CPU and follows correctness gates", () => {
  const build = workflow.jobs["build-release"];
  assert.equal(build.needs, "package-smoke-test");
  assert.deepEqual(build.strategy.matrix.include.map((row) => row.target).sort(), Object.keys(targets).sort());
  assert.deepEqual(build.strategy.matrix.include.map((row) => [row.target, row.os]), [
    ["linux-x64", "ubuntu-22.04"], ["macos-arm64", "macos-15"],
    ["macos-x64", "macos-15-intel"], ["windows-x64", "windows-2022"],
  ]);
  const upload = build.steps.find((step) => step.with?.name === "release-${{ matrix.target }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with.path, ".artifacts/releases/${{ matrix.target }}/assets/*");
  assert.ok(build.steps.some((step) => step.with?.name === "size-${{ matrix.target }}"));
});

test("manual builds cannot publish and only the final release job has contents-write permission", () => {
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.equal(workflow.permissions.contents, "read");
  const publisher = workflow.jobs["github-release"];
  assert.deepEqual(publisher.needs, ["build-release", "publish"]);
  for (const name of ["publish", "github-release"]) {
    assert.match(workflow.jobs[name].if, /github\.event_name == 'push'/u);
    assert.match(workflow.jobs[name].if, /refs\/tags\/v/u);
  }
  assert.deepEqual(Object.entries(workflow.jobs).filter(([, job]) => job.permissions?.contents === "write").map(([name]) => name), ["github-release"]);
  assert.ok(publisher.steps.some((step) => step.run?.includes("checksums.mjs")));
  assert.ok(publisher.steps.some((step) => step.run?.includes("publish-github.mjs")));
});

test("release configuration includes a self-contained runtime and the bundled Node macOS floor", () => {
  const config = JSON.parse(readFileSync(join(root, "desktop/src-tauri/tauri.release.conf.json"), "utf8"));
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.resources, { "resources/pix-runtime/": "pix-runtime/" });
  assert.equal(config.bundle.macOS.minimumSystemVersion, "13.5");
  const build = readFileSync(join(root, "scripts/release/build-desktop.mjs"), "utf8");
  assert.match(build, /env\.CI = "true"/u);
  assert.match(build, /"bundled-runtime"/u);
});
