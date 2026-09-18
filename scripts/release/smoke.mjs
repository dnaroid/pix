import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, nodeExecutable, outputPaths, readJson, run, targetInfo, version } from "./common.mjs";
import { smokeEnvironment } from "./smoke-environment.mjs";
import { auditPayload } from "./size-budget.mjs";

export async function smokePayload(payload, scratch, expectedVariant) {
  const manifest = readJson(join(payload, "release.json"));
  if (expectedVariant) assert.equal(manifest.variant, expectedVariant);
  await auditPayload(payload, targetInfo(manifest.target), manifest.variant);
  const { cwd, env } = await smokeEnvironment(scratch);
  const options = { cwd, env, timeout: 180_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const launch = (args) => process.platform === "win32"
    ? run(process.env.ComSpec ?? `${process.env.SystemRoot}\\System32\\cmd.exe`, ["/d", "/s", "/c", `""${join(payload, "pix.cmd")}" ${args.join(" ")}"`], { ...options, windowsVerbatimArguments: true })
    : run(join(payload, "pix"), args, options);
  for (const args of [["--help"], ["update", "--help"], ["install", "--help"], ["update", "--check"]]) {
    assert.ok(launch(args).length > 0, `Empty output: ${args.join(" ")}`);
  }
  const probeEnv = { ...env, PATH: [join(payload, "runtime"), env.PATH].join(delimiter) };
  const output = run(nodeExecutable(payload), [join(payload, "verify.mjs")], { ...options, env: probeEnv });
  assert.match(output, /PIX_RELEASE_RUNTIME_OK/u);
  console.log(output.trim());
  // The native GUI must find its own runtime; do not preload that runtime into the parent's PATH.
  return { cwd, env };
}

export async function smokeArchive(name = hostTarget()) {
  const { assets } = outputPaths(name);
  const extension = process.platform === "win32" ? "zip" : "tar.gz";
  const archive = join(assets, `pix-tui-${version()}-${name}.${extension}`);
  const scratch = await mkdtemp(join(tmpdir(), "pix release smoke "));
  try {
    run("tar", ["-xf", archive, "-C", scratch]);
    await smokePayload(join(scratch, "pix"), scratch, "tui");
  } finally { await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await smokeArchive(process.argv[2] ?? hostTarget());
