import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readJson, root, run, targets } from "../common.mjs";
import { signRuntime } from "../sign-runtime.mjs";
import { assertMacosHelper, assertMacosHelperFile, compileMacosHelper, MACOS_HELPER_IDENTIFIER, macosHelperPath, macosHelperTriple } from "../ui-qa-helper.mjs";

const nativeMacos = process.platform === "darwin" && process.arch === "arm64";

async function payload(t) {
  const path = await mkdtemp(join(tmpdir(), "pix-ui-qa-helper-"));
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 5 }));
  return path;
}

// One real compile is shared by the macOS pipeline tests; it never runs the helper
// and never touches TCC, it only exercises swiftc, codesign and the release checks.
let compiled;
before(async () => {
  if (!nativeMacos) return;
  const directory = await mkdtemp(join(tmpdir(), "pix-ui-qa-helper-compiled-"));
  compiled = { directory, binary: await compileMacosHelper(directory, targets["macos-arm64"]) };
});
after(async () => {
  if (compiled) await rm(compiled.directory, { recursive: true, force: true, maxRetries: 5 });
});

test("UI-QA helper builds only for the release macOS target at the Desktop deployment floor", () => {
  const config = readJson(join(root, "desktop/src-tauri/tauri.release.conf.json"));
  const floor = config.bundle.macOS.minimumSystemVersion;
  assert.equal(floor, "13.5");
  assert.equal(macosHelperTriple(targets["macos-arm64"]), `arm64-apple-macos${floor}`);
  assert.throws(() => macosHelperTriple(targets["linux-x64"]), /only be built for macOS targets/u);
  assert.throws(() => macosHelperTriple(targets["windows-x64"]), /only be built for macOS targets/u);
  assert.throws(() => macosHelperTriple({ platform: "darwin", arch: "x64" }), /Unsupported macOS architecture/u);
});

test("missing or non-regular helper sources fail closed before any compiler runs", async (t) => {
  const directory = await payload(t);
  await assert.rejects(compileMacosHelper(directory, targets["macos-arm64"], { source: join(directory, "missing.swift") }), /source is missing/u);
  const real = join(directory, "real.swift");
  await writeFile(real, "fixture");
  const link = join(directory, "link.swift");
  await symlink(real, link);
  await assert.rejects(compileMacosHelper(directory, targets["macos-arm64"], { source: link }), /must be a regular file/u);
});

test("payload verification fails closed on a missing or non-executable helper", async (t) => {
  const directory = await payload(t);
  await assert.rejects(assertMacosHelperFile(directory), /is missing from the release payload/u);
  await mkdir(join(directory, "helpers"), { recursive: true });
  await writeFile(macosHelperPath(directory), "fixture");
  await assert.rejects(assertMacosHelperFile(directory), /must be an executable regular file/u);
});

test("prepare bundles the helper before the Desktop copy and both smokes verify it", () => {
  const prepareSource = readFileSync(join(root, "scripts/release/prepare.mjs"), "utf8");
  const compileAt = prepareSource.indexOf("if (target.platform === \"darwin\") await compileMacosHelper(payload, target)");
  const desktopCopyAt = prepareSource.indexOf("await cp(payload, desktopPayload");
  assert.ok(compileAt !== -1, "prepare must compile the helper for darwin targets");
  assert.ok(desktopCopyAt !== -1 && compileAt < desktopCopyAt, "the helper must be compiled before the TUI payload is copied for Desktop");

  const smoke = readFileSync(join(root, "scripts/release/smoke.mjs"), "utf8");
  assert.match(smoke, /if \(manifest\.target === "macos-arm64"\) await assertMacosHelper\(payload\)/u);

  const sign = readFileSync(join(root, "scripts/release/sign-runtime.mjs"), "utf8");
  assert.match(sign, /"--identifier", MACOS_HELPER_IDENTIFIER/u);
  assert.match(sign, /"--test-requirement", `=identifier "\$\{MACOS_HELPER_IDENTIFIER\}"`/u);

  const desktop = readFileSync(join(root, "scripts/release/smoke-desktop.mjs"), "utf8");
  assert.match(desktop, /"--verify", "--deep", "--strict", app/u);
});

test("the release pipeline compiles, signs and verifies the bundled helper", { skip: nativeMacos ? false : "requires a native macOS arm64 host" }, async (t) => {
  const directory = await payload(t);
  const binary = macosHelperPath(directory);
  await mkdir(join(directory, "helpers"), { recursive: true });
  await copyFile(compiled.binary, binary);
  // Thin arm64 Mach-O: 64-bit reversed magic plus CPU_TYPE_ARM64.
  const header = (await readFile(binary)).subarray(0, 8).toString("hex");
  assert.equal(header.slice(0, 8), "cffaedfe");
  assert.equal(header.slice(8, 16), "0c000001");
  // swiftc's own linker signature carries no stable identifier, so an unsigned
  // payload must be rejected before sign-runtime runs.
  await assert.rejects(assertMacosHelper(directory), /codesign failed/u);
  // A Mach-O stand-in at runtime/node proves sign-runtime still applies the Node
  // entitlements to Node only, never to the helper.
  await mkdir(join(directory, "runtime"), { recursive: true });
  await copyFile(compiled.binary, join(directory, "runtime/node"));
  await signRuntime(directory, { identity: "-" });
  await assertMacosHelper(directory);
  const entitlements = (path) => run("codesign", ["-d", "--entitlements", "-", path], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  assert.match(entitlements(join(directory, "runtime/node")), /com\.apple\.security\.cs\.allow-jit/u);
  // Only Node carries entitlements; the helper must not.
  assert.equal(entitlements(binary).trim(), "");
});

test("smoke verification rejects tampered helpers", { skip: nativeMacos ? false : "requires a native macOS arm64 host" }, async (t) => {
  const script = await payload(t);
  await mkdir(join(script, "helpers"), { recursive: true });
  await writeFile(macosHelperPath(script), "#!/bin/sh\nexit 0\n");
  await chmod(macosHelperPath(script), 0o755);
  await assert.rejects(assertMacosHelper(script), /codesign failed/u);

  const rekeyed = await payload(t);
  const binary = macosHelperPath(rekeyed);
  await mkdir(join(rekeyed, "helpers"), { recursive: true });
  await copyFile(compiled.binary, binary);
  run("codesign", ["--force", "--sign", "-", "--identifier", "org.example.wrong", "--options", "runtime", "--timestamp=none", binary]);
  await assert.rejects(assertMacosHelper(rekeyed), /codesign failed/u);
  assert.equal(MACOS_HELPER_IDENTIFIER, "org.pix.ui-qa.macos-accessibility");
});
