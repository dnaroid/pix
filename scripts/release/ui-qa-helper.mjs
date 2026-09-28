import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { root, run } from "./common.mjs";

export const MACOS_HELPER_IDENTIFIER = "org.pix.ui-qa.macos-accessibility";
export const MACOS_HELPER_NAME = "macos-accessibility";
// The helper must run wherever Pix Desktop installs: keep its deployment floor at the
// Desktop bundle minimumSystemVersion (13.5 today, above ScreenCaptureKit's 12.3 floor).
const MACOS_HELPER_DEPLOYMENT_TARGET = "13.5";
const MACOS_HELPER_SOURCE = join(root, "external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift");
const ARCHITECTURES = new Map([["arm64", "arm64"]]);

export function macosHelperPath(payload) {
  return join(payload, "helpers", MACOS_HELPER_NAME);
}

export function macosHelperTriple(target) {
  if (target.platform !== "darwin") throw new Error(`The UI-QA macOS helper can only be built for macOS targets, got ${target.platform}`);
  const architecture = ARCHITECTURES.get(target.arch);
  if (!architecture) throw new Error(`Unsupported macOS architecture for the UI-QA helper: ${target.arch}`);
  return `${architecture}-apple-macos${MACOS_HELPER_DEPLOYMENT_TARGET}`;
}

/**
 * Compile the prebuilt UI-QA accessibility helper into the payload so installed builds
 * never need swiftc. Must run before the TUI payload is copied for Desktop. Fails closed
 * when the source or the native Swift compiler is missing.
 */
export async function compileMacosHelper(payload, target, { source = MACOS_HELPER_SOURCE } = {}) {
  const triple = macosHelperTriple(target);
  let info;
  try { info = await lstat(source); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`UI-QA macOS accessibility helper source is missing: ${source}`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`UI-QA macOS accessibility helper source must be a regular file: ${source}`);
  }
  await mkdir(join(payload, "helpers"), { recursive: true });
  const binary = macosHelperPath(payload);
  run("xcrun", ["swiftc", "-O", "-target", triple, source, "-o", binary]);
  await chmod(binary, 0o755);
  return binary;
}

/** Fail closed unless the helper is an executable regular file; does not check signatures. */
export async function assertMacosHelperFile(payload) {
  const binary = macosHelperPath(payload);
  let info;
  try { info = await lstat(binary); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`UI-QA macOS accessibility helper is missing from the release payload: ${binary}`);
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
    throw new Error(`UI-QA macOS accessibility helper must be an executable regular file: ${binary}`);
  }
  return binary;
}

/** Release smoke check: the helper is present, executable, and strictly signed with the stable identifier. */
export async function assertMacosHelper(payload) {
  const binary = await assertMacosHelperFile(payload);
  run("codesign", ["--verify", "--strict", "--test-requirement", `=identifier "${MACOS_HELPER_IDENTIFIER}"`, binary]);
}
