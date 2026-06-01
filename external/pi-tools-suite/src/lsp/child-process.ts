import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { SHUTDOWN_KILL_TIMEOUT_MS, SHUTDOWN_TERM_TIMEOUT_MS, SHUTDOWN_WRITE_TIMEOUT_MS } from "./constants";

export function isChildRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function canWriteToChild(child: ChildProcessWithoutNullStreams): boolean {
  return isChildRunning(child) && child.stdin.writable && !child.stdin.destroyed && !child.stdin.writableEnded;
}

export function killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (!isChildRunning(child)) return Promise.resolve(true);

  return new Promise((resolve) => {
    let done = false;
    const finish = (exited: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    child.once("exit", onExit);
    if (!isChildRunning(child)) finish(true);
  });
}

export async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!isChildRunning(child)) return;

  if (!killChild(child, "SIGTERM")) return;
  const exited = await waitForChildExit(child, SHUTDOWN_TERM_TIMEOUT_MS);
  if (exited || !isChildRunning(child)) return;

  killChild(child, "SIGKILL");
  await waitForChildExit(child, SHUTDOWN_KILL_TIMEOUT_MS);
}

export async function bestEffortWriteJsonRpc(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): Promise<void> {
  if (!canWriteToChild(child)) return;

  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, SHUTDOWN_WRITE_TIMEOUT_MS);
    timeout.unref();

    try {
      child.stdin.write(payload, "utf8", finish);
    } catch {
      finish();
    }
  });
}
