import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { NativeSearchRequest, NativeSearchResponse } from "./native-contract.js";

const unavailable = (notice: string): NativeSearchResponse => ({ hits: [], notices: [notice],
  status: { backend: "native", complete: false, stale: true } });

/** Own the child until close (including abort); no inherited SDK or provider work. */
export function searchNativeProject(root: string, request: NativeSearchRequest, signal: AbortSignal): Promise<NativeSearchResponse> {
  if (signal.aborted) return Promise.resolve(unavailable("Native search cancelled; results are incomplete."));
  let payload: string;
  try { payload = JSON.stringify(request); if (Buffer.byteLength(payload) > 16_384) throw new Error("Large request"); }
  catch { return Promise.resolve(unavailable("Native search request invalid; results are incomplete.")); }
  return new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./native-cli.mjs", import.meta.url)), root],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let bytes = 0, failure = "";
    const output: Buffer[] = [];
    let cleanup = Promise.resolve();
    const stop = (notice: string) => {
      if (failure) return;
      failure = notice;
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* owned group already exited */ }
      } else {
        // Async: never block the agent's event loop while cleaning up the Git enumerator.
        cleanup = new Promise(done => {
          const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 1000 });
          killer.once("error", () => child.kill("SIGKILL"));
          killer.once("close", () => { child.kill("SIGKILL"); done(); });
        });
      }
    };
    const abort = () => stop("Native search cancelled; results are incomplete.");
    const timeout = setTimeout(() => stop("Native search timed out; results are incomplete."), 45_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 512 * 1024) stop("Native search output exceeded its limit; results are incomplete.");
      else output.push(data);
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.once("error", () => { failure ||= "Native search could not start; results are incomplete."; });
    child.once("close", async code => {
      clearTimeout(timeout); signal.removeEventListener("abort", abort);
      await cleanup;
      if (failure || code !== 0) return resolve(unavailable(failure || "Native search failed; results are incomplete."));
      try {
        const value = JSON.parse(Buffer.concat(output).toString("utf8")) as NativeSearchResponse;
        if (!Array.isArray(value.hits) || value.hits.length > 100 || !Array.isArray(value.notices)
          || value.status?.backend !== "native" || typeof value.status.complete !== "boolean"
          || typeof value.status.stale !== "boolean") throw new Error("Invalid response");
        resolve(value);
      } catch { resolve(unavailable("Native search returned an invalid response; results are incomplete.")); }
    });
    child.stdin.end(payload);
    if (signal.aborted) abort();
  });
}
