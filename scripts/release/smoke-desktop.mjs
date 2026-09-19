import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, outputPaths, run, targetInfo, version } from "./common.mjs";
import { smokePayload } from "./smoke.mjs";

const RELEASE_SMOKE_SUCCESS_EXIT_CODE = 86;

function powershellEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powershellPath(path) {
  const encoded = Buffer.from(path, "utf16le").toString("base64");
  return `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))`;
}

export function nsisPowerShellCommand(executable, destination, uninstall = false) {
  const argument = uninstall ? "('_?=' + $destination)" : "('/D=' + $destination)";
  return powershellEncoded([
    `$executable = ${powershellPath(executable)}`,
    `$destination = ${powershellPath(destination)}`,
    `$process = Start-Process -FilePath $executable -ArgumentList @('/S', ${argument}) -Wait -PassThru`,
    "exit $process.ExitCode",
  ].join("; "));
}

async function findInstalledPayload(root) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "release.json" && directory.endsWith("pix-runtime")) matches.push(directory);
    }
  }
  await visit(root);
  assert.equal(matches.length, 1, `Expected exactly one installed pix-runtime, found ${matches.length}: ${matches.join(", ")}`);
  return matches[0];
}

export async function smokeDesktop(name = hostTarget()) {
  targetInfo(name);
  const { assets } = outputPaths(name);
  const scratch = await mkdtemp(join(tmpdir(), "pix installed smoke "));
  let windowsInstall;
  try {
    let payload;
    let executable;
    if (process.platform === "darwin") {
      const app = join(scratch, "Pix Desktop.app");
      const mount = join(scratch, "mounted-image");
      await mkdir(mount);
      run("hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount,
        join(assets, `pix-desktop-${version()}-${name}.dmg`)]);
      try {
        await cp(join(mount, "Pix Desktop.app"), app, { recursive: true, verbatimSymlinks: true });
      } finally {
        run("hdiutil", ["detach", mount]);
      }
      run("codesign", ["--verify", "--deep", "--strict", app]);
      payload = join(app, "Contents/Resources/pix-runtime");
      const binary = run("/usr/libexec/PlistBuddy", ["-c", "Print CFBundleExecutable", join(app, "Contents/Info.plist")], {
        encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
      }).trim();
      executable = join(app, "Contents/MacOS", binary);
    } else if (process.platform === "linux") {
      const extracted = join(scratch, "deb");
      await mkdir(extracted);
      run("dpkg-deb", ["-x", join(assets, `pix-desktop-${version()}-${name}.deb`), extracted]);
      payload = await findInstalledPayload(extracted);
      executable = join(extracted, "usr/bin/pix-desktop");
      // Also extract the portable GUI image. Do not hardcode its internal resource
      // directory: the native Tauri smoke below resolves resource_dir() from the
      // extracted AppDir and verifies the bundled backend through that real path.
      run(join(assets, `pix-desktop-${version()}-${name}.AppImage`), ["--appimage-extract"], { cwd: scratch });
    } else {
      const installed = join(scratch, "installed");
      windowsInstall = installed;
      // /D must be last and unquoted for NSIS. Encode the PowerShell command so
      // installer/destination paths never depend on inherited env or shell quoting.
      const installer = join(assets, `pix-desktop-${version()}-${name}-setup.exe`);
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        nsisPowerShellCommand(installer, installed)]);
      payload = join(installed, "pix-runtime");
      executable = join(installed, "pix-desktop.exe");
    }
    const context = await smokePayload(payload, join(scratch, "probe"), "desktop");
    const options = { ...context, timeout: 180_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    let output;
    let command;
    let args;
    let nativeOptions = options;
    if (process.platform === "linux") {
      // Launch through AppRun so linuxdeploy's library paths and WebKit helper
      // process environment are preserved. APPDIR also keeps Tauri resource
      // resolution inside the extracted image rather than host /usr.
      const appdir = join(scratch, "squashfs-root");
      command = "xvfb-run";
      args = ["-a", join(appdir, "AppRun"), "--release-smoke-test"];
      nativeOptions = { ...options, env: { ...context.env, APPDIR: appdir } };
    } else {
      // macOS Tauri intentionally rejects executable paths containing symlinks, including /var -> /private/var.
      command = await realpath(executable);
      args = ["--release-smoke-test"];
    }
    const result = spawnSync(command, args, { windowsHide: true, ...nativeOptions });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, RELEASE_SMOKE_SUCCESS_EXIT_CODE,
      `The native host must complete its own backend verification (stdout: ${result.stdout}; stderr: ${result.stderr})`);
    output = result.stdout;
    if (output) assert.match(output, /PIX_RELEASE_RUNTIME_OK/u);
    console.log(`Installed GUI native startup and runtime passed: ${name}`);
  } finally {
    if (windowsInstall) {
      const uninstaller = join(windowsInstall, "uninstall.exe");
      // CI owns this temporary installation; undo its registry/shortcut changes too.
      const { existsSync } = await import("node:fs");
      if (existsSync(uninstaller)) run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        nsisPowerShellCommand(uninstaller, windowsInstall, true)]);
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await smokeDesktop(process.argv[2] ?? hostTarget());
