import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { KnowledgeSearch, KnowledgeSearchResult } from "./evidence.js";

/** Reuse the shipped native hybrid engine in its worker process, never on the UI thread. */
export function createNativeKnowledgeSearch(bundledExtensionPath?: string, agentDir = getAgentDir()): KnowledgeSearch {
  return async (cwd, request, signal) => {
    signal.throwIfAborted();
    const extension = bundledExtensionPath ?? join(agentDir, "extensions", "pi-tools-suite");
    const root = (await stat(extension)).isDirectory() ? extension : dirname(extension);
    const script = join(root, "src", "project-search", "native-cli.mjs");
    return new Promise<KnowledgeSearchResult>((resolve, reject) => {
      const child = spawn(process.execPath, [script, cwd], { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      let output = "", size = 0, settled = false;
      const timer = setTimeout(() => finish(new Error("Wiki hybrid search timed out")), 25_000);
      const abort = () => finish(signal.reason ?? new Error("Wiki check cancelled"));
      function finish(error?: unknown, response?: KnowledgeSearchResult): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error !== undefined) { child.kill(); reject(error); }
        else resolve(response!);
      }
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", finish);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 512 * 1024) finish(new Error("Wiki search exceeded its output budget"));
        else output += chunk;
      });
      child.once("close", code => {
        if (settled) return;
        if (code !== 0) { finish(new Error("Wiki hybrid search is unavailable")); return; }
        try {
          const value: unknown = JSON.parse(output);
          if (!value || typeof value !== "object" || !("hits" in value) || !Array.isArray(value.hits)
            || !("notices" in value) || !Array.isArray(value.notices)
            || value.notices.some(notice => typeof notice !== "string")
            || ("limitNotices" in value && (!Array.isArray(value.limitNotices) || value.limitNotices.some(notice => typeof notice !== "string")))
            || !("status" in value) || !value.status || typeof value.status !== "object"
            || !("complete" in value.status) || typeof value.status.complete !== "boolean"
            || !("stale" in value.status) || typeof value.status.stale !== "boolean"
            || ("completeForSelection" in value.status && typeof value.status.completeForSelection !== "boolean")) throw new Error("Invalid Wiki search response");
          finish(undefined, value as KnowledgeSearchResult);
        } catch (error) { finish(error); }
      });
      child.stdin.on("error", error => finish(error));
      if (signal.aborted) abort();
      else child.stdin.end(JSON.stringify(request));
    });
  };
}
