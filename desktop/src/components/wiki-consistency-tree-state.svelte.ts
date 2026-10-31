import { MAX_KNOWLEDGE_DOCUMENT_CHARS } from "../../../acp/src/knowledge/contract";
import { MAX_KNOWLEDGE_REPORT_BYTES, MAX_KNOWLEDGE_STAMP_BYTES } from "../../../acp/src/knowledge/stamp";
import {
  listWikiStatusDirectory, readWikiStatusDocument, releaseWikiCheckInventory,
  type WikiCheckDirectoryPage, type WikiCheckInventoryEntry,
} from "../lib/wiki-check-inventory";
import { mergeWikiFindings, type WikiFinding, type WikiPageFinding } from "../lib/wiki-conflicts-index";
import { classifyWikiConsistency, createWikiConsistencyIndex } from "../lib/wiki-consistency-tree";

export const WIKI_TREE_STATUS_SETTLE_MS = 750;
export const MAX_WIKI_TREE_STATUS_FILES = 50_000;
const MAX_RAW_BYTES = MAX_KNOWLEDGE_DOCUMENT_CHARS * 4 + MAX_KNOWLEDGE_REPORT_BYTES + MAX_KNOWLEDGE_STAMP_BYTES;
const SLICE_MS = 50;
const PAGES_PER_SLICE = 4;
const READS_PER_SLICE = 4;
const PRUNE_PER_SLICE = 2_048;

interface Options {
  readonly workspace: () => string;
  readonly wikiPath: () => string;
  readonly reportError: (error: unknown) => void;
  readonly listDirectory?: typeof listWikiStatusDirectory;
  readonly readFile?: typeof readWikiStatusDocument;
  readonly releaseInventory?: typeof releaseWikiCheckInventory;
  readonly classify?: typeof classifyWikiConsistency;
  /** Deterministic fixtures may lower, but never raise, the production inventory limit. */
  readonly inventoryLimit?: number;
}

interface ObservedFile {
  revision: string;
  size: number;
  seen: number;
  stableAt: number;
  retry?: boolean;
}

interface Scan {
  readonly id: number;
  readonly directories: string[];
  readonly directorySet: Set<string>;
  readonly completeDirectories: Set<string>;
  readonly incompleteDirectories: Set<string>;
  readonly failedDirectories: Set<string>;
  readonly reclaim: IterableIterator<[string, ObservedFile]>;
  index: number;
  files: number;
  cursor?: string;
  prune?: IterableIterator<[string, ObservedFile]>;
}

interface Owner {
  readonly workspace: string;
  readonly wikiPath: string;
  readonly controller: AbortController;
  readonly files: Map<string, ObservedFile>;
  readonly unread: Set<string>;
  readonly index: ReturnType<typeof createWikiConsistencyIndex>;
  /** Saved-report findings by project path; absent when a page has none. */
  readonly findings: Map<string, readonly WikiPageFinding[]>;
  readonly errors: Set<string>;
  directories: Set<string>;
  completeDirectories: Set<string>;
  blockedDirectories: Set<string>;
  scan?: Scan;
  timer?: ReturnType<typeof setTimeout>;
  sequence: number;
  dirty: boolean;
  busy: boolean;
}

export interface WikiFindingsSnapshot {
  readonly findings: readonly WikiFinding[];
  readonly truncated: boolean;
  /** Discovery finished without failed branches and every changed page was read. */
  readonly complete: boolean;
}

const safePath = (path: string) => !!path && !/[\\\u0000-\u001f\u007f:]/u.test(path)
  && path.split("/").every(part => !!part && part !== "." && part !== "..");

/** Mounted Wiki status discovery: no models, writes, document retention, or per-row traversal. */
export function createWikiConsistencyTreeState(options: Options) {
  const listDirectory = options.listDirectory ?? listWikiStatusDirectory;
  const readFile = options.readFile ?? readWikiStatusDocument;
  const releaseInventory = options.releaseInventory ?? releaseWikiCheckInventory;
  const classify = options.classify ?? classifyWikiConsistency;
  const limit = Number.isSafeInteger(options.inventoryLimit) && options.inventoryLimit! > 0
    ? Math.min(options.inventoryLimit!, MAX_WIKI_TREE_STATUS_FILES) : MAX_WIKI_TREE_STATUS_FILES;
  const empty = createWikiConsistencyIndex();
  let owner: Owner | undefined;
  let disposed = false;
  let version = $state(0);
  let snapshot: { owner?: Owner; version: number; value: WikiFindingsSnapshot } | undefined;

  function current(scope: Owner): boolean {
    return !disposed && owner === scope && !scope.controller.signal.aborted
      && options.workspace() === scope.workspace && options.wikiPath() === scope.wikiPath;
  }

  function report(scope: Owner, error: unknown): void {
    if (!current(scope)) return;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 600);
    if (scope.errors.has(message)) return;
    if (scope.errors.size >= 32) scope.errors.delete(scope.errors.values().next().value!);
    scope.errors.add(message);
    options.reportError(error);
  }

  function release(scope: Owner, cursor?: string): void {
    if (!cursor) return;
    void releaseInventory(scope.workspace, cursor).catch(error => report(scope, error));
  }

  function publish(scope: Owner): void {
    if (current(scope) && scope.dirty) { scope.dirty = false; version++; }
  }

  function ancestors(scope: Owner, path: string, visit: (path: string) => void): void {
    for (let current = path; current.length >= scope.wikiPath.length;) {
      visit(current);
      if (current === scope.wikiPath) break;
      current = current.slice(0, current.lastIndexOf("/"));
    }
  }

  function within(scope: Owner, paths: Set<string>, path: string): boolean {
    let found = false;
    ancestors(scope, path, ancestor => { if (paths.has(ancestor)) found = true; });
    return found;
  }

  function invalidate(scope: Owner, directory: string, descendants = false): void {
    ancestors(scope, directory, ancestor => {
      if (scope.completeDirectories.delete(ancestor)) scope.dirty = true;
    });
    if (descendants && !scope.blockedDirectories.has(directory)) {
      scope.blockedDirectories.add(directory);
      scope.dirty = true;
    }
  }

  const relative = (scope: Owner, path: string) => path.slice(scope.wikiPath.length + 1);

  function forget(scope: Owner, path: string): void {
    scope.files.delete(path);
    scope.unread.delete(path);
    if (scope.index.delete(relative(scope, path))) scope.dirty = true;
    if (scope.findings.delete(path)) scope.dirty = true;
  }

  function reclaim(scope: Owner, scan: Scan): boolean {
    for (let next = scan.reclaim.next(); !next.done; next = scan.reclaim.next()) {
      const [path, file] = next.value;
      if (scope.files.get(path) !== file || file.seen === scan.id) continue;
      // An unvisited branch may later fail: lack of space is not evidence that
      // a previously known conflict disappeared. Retain red until discovery
      // authoritatively removes it, even if that conservatively hits the cap.
      if (scope.index.summary(relative(scope, path), true).status === "conflicts") continue;
      // Coverage must be re-established before an evicted child can permit green.
      invalidate(scope, path.slice(0, path.lastIndexOf("/")));
      forget(scope, path);
      return true;
    }
    return false;
  }

  function observe(scope: Owner, scan: Scan, entry: Extract<WikiCheckInventoryEntry, { kind: "file" }>): void {
    const old = scope.files.get(entry.path);
    if ((!old || old.seen !== scan.id) && ++scan.files > limit) {
      throw new Error(`Сводка Wiki достигла ограничения в ${limit} документов; обход неполный.`);
    }
    if (old && old.revision === entry.revision) {
      old.seen = scan.id;
      if (old.retry) {
        old.retry = false; old.stableAt = Date.now();
        scope.unread.add(entry.path);
      }
      return;
    }
    if (!old && scope.files.size >= limit && !reclaim(scope, scan)) {
      // Continue metadata discovery so the authoritative prune can free old
      // paths. This avoids dropping red from a failed branch or getting stuck
      // forever after replacing a full inventory of conflicting documents.
      const directory = entry.path.slice(0, entry.path.lastIndexOf("/"));
      ancestors(scope, directory, ancestor => {
        scan.incompleteDirectories.add(ancestor);
        scan.completeDirectories.delete(ancestor);
      });
      invalidate(scope, directory);
      report(scope, new Error(`Сводка Wiki достигла ограничения в ${limit} документов; новые чтения отложены до следующего обхода.`));
      return;
    }
    scope.files.set(entry.path, { revision: entry.revision, size: entry.size, seen: scan.id,
      stableAt: Date.now() + WIKI_TREE_STATUS_SETTLE_MS });
    scope.unread.delete(entry.path); scope.unread.add(entry.path);
    if (scope.index.set(relative(scope, entry.path), "unknown")) scope.dirty = true;
    // The saved report belongs to the previous body; the next read re-projects it.
    if (scope.findings.delete(entry.path)) scope.dirty = true;
  }

  function beginScan(scope: Owner): void {
    scope.scan = { id: ++scope.sequence, directories: [scope.wikiPath], directorySet: new Set([scope.wikiPath]),
      completeDirectories: new Set(), incompleteDirectories: new Set(), failedDirectories: new Set(),
      reclaim: scope.files.entries(), index: 0, files: 0 };
  }

  function failScan(scope: Owner, error: unknown): void {
    release(scope, scope.scan?.cursor);
    scope.scan = undefined;
    invalidate(scope, scope.wikiPath, true);
    report(scope, error);
  }

  function finishDirectory(scope: Owner, scan: Scan, directory: string, failure?: { cause: unknown }): void {
    if (failure) {
      release(scope, scan.cursor);
      scan.cursor = undefined;
      scan.failedDirectories.add(directory);
      ancestors(scope, directory, ancestor => {
        scan.incompleteDirectories.add(ancestor);
        scan.completeDirectories.delete(ancestor);
      });
      invalidate(scope, directory, true);
      report(scope, failure.cause);
    } else {
      if (!scan.incompleteDirectories.has(directory)) scan.completeDirectories.add(directory);
      if (scope.blockedDirectories.delete(directory)) scope.dirty = true;
    }
    scan.index++;
    if (scan.index >= scan.directories.length) scan.prune = scope.files.entries();
  }

  async function discover(scope: Owner): Promise<void> {
    for (let count = 0; count < PAGES_PER_SLICE && current(scope) && scope.scan && !scope.scan.prune; count++) {
      const scan = scope.scan, directory = scan.directories[scan.index]!;
      const cursor = scan.cursor;
      scan.cursor = undefined;
      let page: WikiCheckDirectoryPage;
      try {
        page = await listDirectory({ workspace: scope.workspace, wikiPath: scope.wikiPath, path: directory,
          ...(cursor ? { cursor } : {}) }, scope.controller.signal);
      } catch (error) {
        if (!current(scope)) return;
        finishDirectory(scope, scan, directory, { cause: error });
        continue;
      }
      if (!current(scope)) { release(scope, page.nextCursor); return; }
      scan.cursor = page.nextCursor;
      try {
        if (page.entries.length > 128) throw new Error("Сводка Wiki получила слишком большую страницу каталога.");
        for (const entry of page.entries) {
          if (!safePath(entry.path) || !entry.path.startsWith(scope.wikiPath + "/")
            || entry.path.slice(0, entry.path.lastIndexOf("/")) !== directory) {
            throw new Error("Сводка Wiki получила путь вне запрошенного каталога.");
          }
          // Keep status eligibility aligned with the visible tree even if an
          // older/native fixture inventory still returns hidden entries.
          if (relative(scope, entry.path).split("/").some(part => part.startsWith("."))) continue;
          if (entry.kind === "directory") {
            if (scan.directorySet.has(entry.path)) continue;
            if (scan.directories.length >= MAX_WIKI_TREE_STATUS_FILES) throw new Error("Сводка Wiki достигла ограничения количества папок; обход неполный.");
            scan.directories.push(entry.path); scan.directorySet.add(entry.path);
            if (!scope.directories.has(entry.path)) invalidate(scope, entry.path);
          } else {
            if (!/\.(?:md|markdown)$/iu.test(entry.path) || !entry.revision || entry.revision.length > 256
              || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Сводка Wiki получила некорректные метаданные документа.");
            observe(scope, scan, entry);
          }
        }
        if (!page.nextCursor) finishDirectory(scope, scan, directory);
      } catch (error) { failScan(scope, error); return; }
    }
  }

  function prune(scope: Owner): void {
    const scan = scope.scan;
    if (!scan?.prune) return;
    for (let count = 0; count < PRUNE_PER_SLICE; count++) {
      const next = scan.prune.next();
      if (next.done) {
        scope.directories = scan.directorySet;
        scope.completeDirectories = scan.completeDirectories;
        scope.blockedDirectories = scan.failedDirectories;
        scope.scan = undefined;
        scope.dirty = true;
        return;
      }
      const [path, file] = next.value;
      // A failed directory is not an authoritative statement that its cached
      // descendants disappeared. Retain their statuses, including known red.
      if (file.seen !== scan.id && !within(scope, scan.failedDirectories, path)) forget(scope, path);
    }
  }

  async function inspect(scope: Owner): Promise<void> {
    for (let count = 0; count < READS_PER_SLICE && current(scope) && scope.unread.size; count++) {
      const path = scope.unread.values().next().value!;
      const observed = scope.files.get(path);
      if (!observed) { scope.unread.delete(path); continue; }
      if (observed.stableAt > Date.now()) return;
      scope.unread.delete(path);
      if (observed.size > MAX_RAW_BYTES) continue;
      try {
        const file = await readFile(scope.workspace, scope.wikiPath, path, scope.controller.signal);
        if (!current(scope) || scope.files.get(path) !== observed) return;
        if (file.path !== path || new TextEncoder().encode(file.content).byteLength > MAX_RAW_BYTES) {
          throw new Error("Сводка Wiki получила другой документ или слишком большой файл.");
        }
        const { status, findings, accepted } = await classify(file.content, path);
        if (!current(scope) || scope.files.get(path) !== observed) return;
        if (scope.index.set(relative(scope, path), status, accepted === true)) scope.dirty = true;
        if (findings.length) { scope.findings.set(path, findings); scope.dirty = true; }
        else if (scope.findings.delete(path)) scope.dirty = true;
      } catch (error) {
        if (current(scope) && scope.files.get(path) === observed) observed.retry = true;
        report(scope, error);
      }
    }
  }

  function schedule(scope: Owner, delay = 0): void {
    if (!current(scope) || scope.timer !== undefined || scope.busy) return;
    scope.timer = setTimeout(() => { scope.timer = undefined; void tick(scope); }, delay);
  }

  async function tick(scope: Owner): Promise<void> {
    if (!current(scope) || scope.busy) return;
    scope.busy = true;
    try {
      await discover(scope);
      if (!current(scope)) return;
      prune(scope);
      publish(scope);
      await inspect(scope);
    } catch (error) {
      if (current(scope)) failScan(scope, error);
    } finally {
      scope.busy = false;
      if (current(scope)) {
        publish(scope);
        if (scope.scan || scope.unread.size) {
          const path = scope.unread.values().next().value;
          const stableAt = path ? scope.files.get(path)?.stableAt ?? 0 : 0;
          schedule(scope, scope.scan ? SLICE_MS : Math.max(SLICE_MS, stableAt - Date.now()));
        }
      }
    }
  }

  function abandon(scope: Owner): void {
    scope.controller.abort();
    clearTimeout(scope.timer);
    release(scope, scope.scan?.cursor);
    scope.files.clear(); scope.unread.clear(); scope.index.clear(); scope.findings.clear(); scope.directories.clear();
    scope.completeDirectories.clear(); scope.blockedDirectories.clear(); scope.errors.clear();
    scope.scan = undefined;
  }

  return {
    summary(path: string) {
      version;
      const active = owner && current(owner) ? owner : undefined;
      const absolute = active && (path ? `${active.wikiPath}/${path}` : active.wikiPath);
      const complete = !!active && !!absolute && active.completeDirectories.has(absolute)
        && !within(active, active.blockedDirectories, absolute);
      return (active?.index ?? empty).summary(path, complete);
    },
    /** Merged findings of the active Wiki; recomputed only after a published change. */
    findings(): WikiFindingsSnapshot {
      const seen = version;
      const active = owner && current(owner) ? owner : undefined;
      if (snapshot && snapshot.owner === active && snapshot.version === seen) return snapshot.value;
      const merged = active ? mergeWikiFindings(active.findings.values()) : { findings: [], truncated: false };
      const value: WikiFindingsSnapshot = { ...merged,
        complete: !!active && !active.scan && active.completeDirectories.has(active.wikiPath)
          && !active.blockedDirectories.size && !active.unread.size };
      snapshot = { owner: active, version: seen, value };
      return value;
    },
    refresh(): void {
      if (disposed) return;
      const workspace = options.workspace(), wikiPath = options.wikiPath();
      if (owner && (owner.workspace !== workspace || owner.wikiPath !== wikiPath)) {
        const old = owner; owner = undefined; abandon(old); version++;
      }
      if (!workspace || !safePath(wikiPath)) return;
      if (!owner) {
        owner = { workspace, wikiPath, controller: new AbortController(), files: new Map(), unread: new Set(),
          index: createWikiConsistencyIndex(), findings: new Map(), errors: new Set(), directories: new Set(), sequence: 0,
          completeDirectories: new Set(), blockedDirectories: new Set(), dirty: true, busy: false };
      }
      if (!owner.scan && !owner.busy && !owner.unread.size) beginScan(owner);
      schedule(owner);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const old = owner; owner = undefined;
      if (old) abandon(old);
      snapshot = undefined;
      version++;
    },
  };
}
