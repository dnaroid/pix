import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Listener = () => void;
type Scan = (cwd: string, signal: AbortSignal) => Promise<void>;
type Revision = (cwd: string) => Promise<string>;

type InFlight = {
  readonly controller: AbortController;
  readonly listeners: Set<Listener>;
  readonly promise: Promise<boolean>;
};

/** Avoid repeated full JSONL scans on every Desktop session/list request. */
export class NativeSessionCatalog {
  private readonly inFlight = new Map<string, InFlight>();
  private readonly completedRevisions = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly scan: Scan,
    private readonly onFailure: (error: unknown) => void,
    private readonly revision: Revision = sessionDirectoryRevision,
  ) {}

  /** Schedule/coalesce discovery; true means reconciled, false means failed or aborted. */
  refresh(cwd: string, onChanged: Listener): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const current = this.inFlight.get(cwd);
    if (current) {
      current.listeners.add(onChanged);
      return current.promise;
    }
    const controller = new AbortController();
    const listeners = new Set([onChanged]);
    const promise = (async () => {
      try {
        const revision = await this.revision(cwd);
        controller.signal.throwIfAborted();
        if (this.completedRevisions.get(cwd) === revision) return true;
        await this.scan(cwd, controller.signal);
        controller.signal.throwIfAborted();
        // Only acknowledge the state we started reading. A later append may
        // not have been consumed; the per-file cache makes its retry cheap.
        this.completedRevisions.set(cwd, revision);
        if (this.inFlight.get(cwd)?.controller === controller) this.inFlight.delete(cwd);
        if (!this.disposed) {
          for (const listener of [...listeners]) listener();
        }
        return true;
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) this.onFailure(error);
        return false;
      } finally {
        if (this.inFlight.get(cwd)?.controller === controller) this.inFlight.delete(cwd);
        listeners.clear();
      }
    })();
    this.inFlight.set(cwd, { controller, listeners, promise });
    return promise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const run of this.inFlight.values()) run.controller.abort();
    await Promise.allSettled([...this.inFlight.values()].map((run) => run.promise));
    this.inFlight.clear();
    this.completedRevisions.clear();
  }
}

/** Only names and filesystem metadata; no prompt/session contents are read. */
export async function sessionDirectoryRevision(cwd: string, agentDir = getAgentDir()): Promise<string> {
  // Match the Pi SDK's getDefaultSessionDirPath encoding without creating a directory.
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const directory = join(agentDir, "sessions", safePath);
  const filenames = (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter((name) => name.endsWith(".jsonl")).sort();
  const details = await Promise.all(filenames.map(async (name) => {
    try {
      const info = await stat(join(directory, name));
      return [name, info.size, info.mtimeMs, info.ctimeMs, info.dev, info.ino];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, "missing"];
      throw error;
    }
  }));
  return createHash("sha256").update(JSON.stringify(details)).digest("hex");
}
