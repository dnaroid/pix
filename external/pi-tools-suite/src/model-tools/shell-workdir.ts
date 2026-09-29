import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isPathInside } from "./path-utils";

/** Grants live only in this extension runtime, never in the session transcript or config. */
export function registerShellWorkdir(
  pi: ExtensionAPI,
  filesystem: { realpath(path: string): Promise<string>; isDirectory(path: string): Promise<boolean> } = {
    realpath,
    isDirectory: async (path) => (await stat(path)).isDirectory(),
  },
): (ctx: ExtensionContext, workdir: string | undefined) => Promise<string | undefined> {
  const grants = new WeakMap<ExtensionContext["sessionManager"], Set<string>>();

  const forSession = (ctx: ExtensionContext): Set<string> => {
    let allowed = grants.get(ctx.sessionManager);
    if (!allowed) {
      allowed = new Set();
      grants.set(ctx.sessionManager, allowed);
    }
    return allowed;
  };

  // A replacement may reuse the same session manager. Clear only that session,
  // so a host sharing this extension instance cannot disturb other sessions.
  pi.on("session_start", (_event, ctx) => { grants.delete(ctx.sessionManager); });
  pi.on("session_shutdown", (_event, ctx) => { grants.delete(ctx.sessionManager); });

  pi.registerCommand("shell-workdir", {
    description: "Allow, list, or revoke extra shell working directories for this session only",
    handler: async (args, ctx) => {
      const match = /^(allow|list|revoke)(?:\s+(.+))?$/s.exec(args.trim());
      const action = match?.[1];
      const input = match?.[2]?.trim();
      if (!action || (action !== "list" && !input) || (action === "list" && input)) {
        ctx.ui.notify("Usage: /shell-workdir allow <path> | list | revoke <path>", "warning");
        return;
      }

      // Capture the original set before I/O: an in-flight allow must not grant
      // access to a replacement session after session_start resets the map.
      const allowed = forSession(ctx);
      if (action === "list") {
        ctx.ui.notify(allowed.size
          ? `Extra shell working directories (this session only; cleared on reload/exit):\n${[...allowed].sort().join("\n")}`
          : "No extra shell working directories allowed (this session only).", "info");
        return;
      }

      const absolute = resolve(ctx.cwd, input!);
      try {
        let canonical: string;
        try {
          canonical = await filesystem.realpath(absolute);
        } catch (error) {
          // The displayed canonical path can still be revoked after deletion.
          if (action !== "revoke") throw error;
          canonical = join(await filesystem.realpath(dirname(absolute)), basename(absolute));
        }
        if (action === "allow") {
          if (!(await filesystem.isDirectory(canonical))) throw new Error("Not a directory");
          if (grants.get(ctx.sessionManager) !== allowed) {
            ctx.ui.notify("Shell workdir not allowed: session changed during resolution.", "warning");
            return;
          }
          allowed.add(canonical);
          ctx.ui.notify(`Shell workdir allowed: ${canonical} (this session only; cleared on reload/exit).`, "info");
        } else if (grants.get(ctx.sessionManager) !== allowed) {
          ctx.ui.notify("Shell workdir not revoked: session changed during resolution.", "warning");
        } else if (allowed.delete(canonical)) {
          ctx.ui.notify(`Shell workdir revoked: ${canonical} (this session).`, "info");
        } else {
          ctx.ui.notify(`Shell workdir was not allowed: ${canonical} (this session).`, "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Shell workdir ${action} failed for ${absolute}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  return async (ctx, workdir) => {
    if (!workdir) return undefined;
    const allowed = forSession(ctx);
    const cwdRealPath = await filesystem.realpath(ctx.cwd);
    const workdirRealPath = await filesystem.realpath(resolve(ctx.cwd, workdir));
    if (isPathInside(cwdRealPath, workdirRealPath) ||
        (grants.get(ctx.sessionManager) === allowed && [...allowed].some((root) => isPathInside(root, workdirRealPath)))) {
      return workdirRealPath;
    }
    throw new Error(`Working directory escapes workspace: ${workdir}. Use /shell-workdir allow <path> for this session.`);
  };
}
