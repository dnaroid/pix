import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { root } from "../common.mjs";

test("portable launcher preserves cwd, Unicode/spaced/empty args and exit status without system Node", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "pix launcher "));
  t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 5 }));
  const payload = join(temporary, "Pix & package");
  const cwd = join(temporary, "working directory");
  const poison = join(temporary, "poison");
  for (const directory of [join(payload, "runtime"), join(payload, "app/bin"), cwd, poison]) await mkdir(directory, { recursive: true });
  const isWindows = process.platform === "win32";
  const binary = join(payload, "runtime", isWindows ? "node.exe" : "node");
  if (isWindows) {
    await copyFile(process.execPath, binary);
    await chmod(binary, 0o755);
  } else {
    // The PATH-selected Node may itself depend on sibling shared libraries
    // (for example Homebrew's libnode.dylib). A symlink still proves that the
    // launcher selects runtime/node instead of PATH without assuming that an
    // arbitrary system Node binary is independently relocatable.
    await symlink(process.execPath, binary);
  }
  const launcher = join(payload, isWindows ? "pix.cmd" : "pix");
  await copyFile(join(root, "scripts/release/launchers", isWindows ? "pix.cmd" : "pix"), launcher);
  await chmod(launcher, 0o755);
  await writeFile(join(payload, "app/bin/pix.mjs"), "console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),node:process.execPath})); process.exitCode=17;\n");
  const decoy = join(poison, isWindows ? "node.cmd" : "node");
  await writeFile(decoy, isWindows ? "@exit /b 86\r\n" : "#!/bin/sh\nexit 86\n");
  await chmod(decoy, 0o755);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH" || key.startsWith("NODE_")) delete env[key];
  env.PATH = [poison, ...(isWindows ? [`${process.env.SystemRoot}\\System32`] : ["/usr/bin", "/bin"])].join(delimiter);
  const args = ["plain", "with spaces", "кириллица", ""];
  const invoke = (path) => isWindows
    ? spawnSync(process.env.ComSpec ?? `${process.env.SystemRoot}\\System32\\cmd.exe`,
      ["/d", "/s", "/c", `""${path}" ${args.map((arg) => `"${arg}"`).join(" ")}"`],
      { cwd, env, encoding: "utf8", timeout: 30_000, windowsVerbatimArguments: true })
    : spawnSync(path, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  async function verify(path) {
    const result = invoke(path);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 17, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.args, args);
    assert.equal(await realpath(data.cwd), await realpath(cwd));
    assert.equal(await realpath(data.node), await realpath(binary));
  }
  await verify(launcher);
  if (!isWindows) {
    const link = join(temporary, "pix-link");
    await symlink("Pix & package/pix", link);
    await verify(link);
  }
});
