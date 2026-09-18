import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, outputPaths, run, targetInfo, version } from "./common.mjs";
import { smokePayload } from "./smoke.mjs";

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
      payload = join(extracted, "usr/lib/pix-desktop/pix-runtime");
      executable = join(extracted, "usr/bin/pix-desktop");
      // Also check the portable GUI image, which has a separate resource layout.
      run(join(assets, `pix-desktop-${version()}-${name}.AppImage`), ["--appimage-extract"], { cwd: scratch });
      await smokePayload(join(scratch, "squashfs-root/usr/lib/pix-desktop/pix-runtime"), join(scratch, "appimage-home"), "desktop");
    } else {
      const installed = join(scratch, "installed");
      windowsInstall = installed;
      // /D must be last and must NOT be quoted by NSIS; use an environment-driven PowerShell call.
      run("powershell.exe", ["-NoProfile", "-Command",
        "$p = Start-Process -FilePath $env.PIX_SMOKE_INSTALLER -ArgumentList @('/S', ('/D=' + $env.PIX_SMOKE_DEST)) -Wait -PassThru; exit $p.ExitCode"], {
        env: { ...process.env, PIX_SMOKE_INSTALLER: join(assets, `pix-desktop-${version()}-${name}-setup.exe`), PIX_SMOKE_DEST: installed },
      });
      payload = join(installed, "pix-runtime");
      executable = join(installed, "pix-desktop.exe");
    }
    const context = await smokePayload(payload, join(scratch, "probe"), "desktop");
    const options = { ...context, timeout: 180_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
    let output;
    if (process.platform === "linux") {
      // Use the AppImage's AppDir so Tauri resolves resources inside the extracted image, not /usr.
      const appdir = join(scratch, "squashfs-root");
      output = run("xvfb-run", ["-a", join(appdir, "usr/bin/pix-desktop"), "--release-smoke-test"], {
        ...options, env: { ...context.env, APPDIR: appdir },
      });
    } else {
      // macOS Tauri intentionally rejects executable paths containing symlinks, including /var -> /private/var.
      output = run(await realpath(executable), ["--release-smoke-test"], options);
    }
    assert.match(output, /PIX_RELEASE_RUNTIME_OK/u, "The native host must complete its own backend verification, not merely exit");
    console.log(`Installed GUI native startup and runtime passed: ${name}`);
  } finally {
    if (windowsInstall) {
      const uninstaller = join(windowsInstall, "uninstall.exe");
      // CI owns this temporary installation; undo its registry/shortcut changes too.
      const { existsSync } = await import("node:fs");
      if (existsSync(uninstaller)) run("powershell.exe", ["-NoProfile", "-Command",
        "$p = Start-Process -FilePath $env.PIX_UNINSTALLER -ArgumentList @('/S', ('_?=' + $env.PIX_INSTALL_DIR)) -Wait -PassThru; exit $p.ExitCode"],
      { env: { ...process.env, PIX_UNINSTALLER: uninstaller, PIX_INSTALL_DIR: windowsInstall } });
    }
    await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await smokeDesktop(process.argv[2] ?? hostTarget());
