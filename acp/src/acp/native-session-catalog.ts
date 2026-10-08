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
  readonly promise: Promise<void>;
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

  /** Schedule a scan; callers can return their persisted map immediately. */
  refresh(cwd: string, onChanged: Listener): void {
    if (this.disposed) return;
    const current = this.inFlight.get(cwd);
    if (current) {
      current.listeners.add(onChanged);
      return;
    }
    const controller = new AbortController();
    const listeners = new Set([onChanged]);
    const promise = (async () => {
      try {
        const revision = await this.revision(cwd);
        controller.signal.throwIfAborted();
        if (this.completedRevisions.get(cwd) === revision) return;
        await this.scan(cwd, controller.signal);
        controller.signal.throwIfAborted();
        // Session files can grow while their JSONL bodies are being scanned.
        // Cache the *post-scan* filesystem state so the notification-driven
        // follow-up list does not immediately start the same expensive scan.
        const settledRevision = await this.revision(cwd).catch(() => revision);
        controller.signal.throwIfAborted();
        this.completedRevisions.set(cwd, settledRevision);
        if (this.inFlight.get(cwd)?.controller === controller) this.inFlight.delete(cwd);
        if (!this.disposed) {
          for (const listener of [...listeners]) listener();
        }
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) this.onFailure(error);
      } finally {
        if (this.inFlight.get(cwd)?.controller === controller) this.inFlight.delete(cwd);
        listeners.clear();
      }
    })();
    this.inFlight.set(cwd, { controller, listeners, promise });
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
      return [name, info.size, info.mtimeMs, info.ino];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, "missing"];
      throw error;
    }
  }));
  return createHash("sha256").update(JSON.stringify(details)).digest("hex");
}
