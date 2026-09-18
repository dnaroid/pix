import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

// Carry only OS/session plumbing, never provider credentials, Node injection flags or signing secrets.
export function systemEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined &&
    /^(SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|LANG|LC_.*|TERM|COLORTERM|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|SHELL|USER|USERNAME|LOGNAME|ProgramFiles|ProgramW6432|ProgramFiles\(x86\))$/iu.test(key)));
}

export async function smokeEnvironment(scratch) {
  const home = join(scratch, "home");
  const cwd = join(scratch, "workspace with spaces");
  const poison = join(scratch, "no-system-node");
  for (const directory of [home, cwd, poison]) await mkdir(directory, { recursive: true });
  const isWindows = process.platform === "win32";
  const node = join(poison, isWindows ? "node.cmd" : "node");
  await writeFile(node, isWindows ? "@echo Unexpected system Node fallback 1>&2\r\n@exit /b 86\r\n"
    : "#!/bin/sh\necho 'Unexpected system Node fallback' >&2\nexit 86\n");
  await chmod(node, 0o755);
  let paths = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  if (isWindows) {
    const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!windows) throw new Error("Windows SystemRoot is required for package smoke tests");
    paths = [join(windows, "System32"), windows, join(windows, "System32/WindowsPowerShell/v1.0")];
    for (const base of [process.env.ProgramFiles, process.env.ProgramW6432]) {
      if (base) paths.push(join(base, "Git/cmd"), join(base, "Git/bin"), join(base, "PowerShell/7"));
    }
  }
  const env = { ...systemEnvironment(process.env), HOME: home, USERPROFILE: home,
    APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: join(home, ".pi/agent"), PI_OFFLINE: "1", PIX_RELEASE_SMOKE: "1",
    PIX_SKIP_VERSION_CHECK: "1", PIX_ACP_LOG: "error",
    PATH: [poison, ...new Set(paths.filter(existsSync))].join(delimiter),
  };
  return { cwd, env };
}
