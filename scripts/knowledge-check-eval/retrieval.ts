import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROJECT_ARTIFACTS_DIR } from "../../external/pi-tools-suite/src/artifact-paths.js";
import { MAX_KNOWLEDGE_CHUNK_CHARS, type KnowledgeCheckRequest } from "../../acp/src/knowledge/contract.js";
import { collectKnowledgeEvidence, type KnowledgeSearchResult, type KnowledgeSnapshot } from "../../acp/src/knowledge/evidence.js";
import { createNativeKnowledgeSearch } from "../../acp/src/knowledge/native-search.js";
import type { KnowledgeEvalCase } from "./cases.js";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const normalized = (text: string) => text.replace(/\r\n?/gu, "\n");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
const inside = (root: string, path: string) => {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== ".." && !name.startsWith("../") && !name.startsWith("..\\");
};

export interface KnowledgeRetrievalCall {
  readonly query: string;
  readonly elapsedMs: number;
  readonly hits: readonly { readonly path: string; readonly startLine: number; readonly endLine: number }[];
  readonly notices: readonly string[];
  readonly status?: KnowledgeSearchResult["status"];
  readonly error?: string;
}

export interface KnowledgeRetrievalClaim {
  readonly sourcePath: string;
  readonly anchor: string;
  readonly candidate: boolean;
  readonly selected: boolean;
  readonly decisivePassage: boolean;
  readonly contextIncluded: boolean;
}

export interface KnowledgeRetrievalMetrics {
  readonly passed: boolean;
  readonly expectedSources: number;
  readonly candidateSourcesMatched: number;
  readonly selectedSourcesMatched: number;
  readonly expectedClaims: number;
  readonly decisiveClaimsMatched: number;
  readonly selectionComplete: boolean;
  readonly freshAtCollection: boolean;
  readonly semanticEnabled: boolean;
  readonly semanticComplete: boolean;
  readonly claims: readonly KnowledgeRetrievalClaim[];
}

export interface KnowledgeRetrievalFixture {
  readonly fixtureDirectory: string;
  readonly request: KnowledgeCheckRequest;
  readonly snapshot?: KnowledgeSnapshot;
  readonly metrics: KnowledgeRetrievalMetrics;
  readonly calls: readonly KnowledgeRetrievalCall[];
  readonly error?: string;
}

/** A candidate document is insufficient: the decisive original claim must reach the judge. */
export function scoreKnowledgeRetrieval(item: KnowledgeEvalCase, snapshot: KnowledgeSnapshot | undefined,
  calls: readonly KnowledgeRetrievalCall[], freshAtCollection: boolean): KnowledgeRetrievalMetrics {
  const external = item.expectedPairs.filter(pair => pair.sourcePath !== item.document.path);
  const required = external.length ? external.map(pair => ({ sourcePath: pair.sourcePath, anchor: pair.existingAnchor }))
    : item.evidence.map(source => ({ sourcePath: source.path, anchor: source.text.trim() }));
  const unique = [...new Map(required.map(claim => [JSON.stringify(claim), claim])).values()];
  const candidates = new Set(snapshot?.candidatePaths ?? []);
  const evidence = snapshot?.evidence ?? [];
  const claims = unique.map(({ sourcePath, anchor }): KnowledgeRetrievalClaim => {
    const passages = evidence.filter(source => source.path === sourcePath);
    const context = item.evidence.find(source => source.path === sourcePath)?.context;
    return { sourcePath, anchor, candidate: candidates.has(sourcePath), selected: passages.length > 0,
      decisivePassage: passages.some(source => normalized(source.text).includes(normalized(anchor))),
      contextIncluded: !context || passages.some(source => normalized(source.text).includes(normalized(context))
        || normalized(source.context ?? "").includes(normalized(context))) };
  });
  const semanticEnabled = calls.length > 0 && calls.every(call => !call.error
    && (call.status?.semanticEnabled === true || call.status?.semantic?.enabled === true));
  const semanticComplete = semanticEnabled && calls.every(call => call.status?.semantic?.enabled === true
    && call.status.semantic.complete === true && call.status.semantic.state === "ready");
  const selectionComplete = snapshot?.complete === true && calls.length > 0 && calls.every(call => !call.error
    && call.status?.stale === false && (call.status.completeForSelection ?? call.status.complete) === true);
  const expectedSources = new Set(claims.map(claim => claim.sourcePath)).size;
  const matchedSources = (key: "candidate" | "selected") => new Set(claims.filter(claim => claim[key]).map(claim => claim.sourcePath)).size;
  return { passed: expectedSources > 0 && selectionComplete && freshAtCollection && semanticComplete
      && claims.every(claim => claim.candidate && claim.selected && claim.decisivePassage && claim.contextIncluded),
    expectedSources, candidateSourcesMatched: matchedSources("candidate"), selectedSourcesMatched: matchedSources("selected"),
    expectedClaims: claims.length, decisiveClaimsMatched: claims.filter(claim => claim.decisivePassage).length,
    selectionComplete, freshAtCollection, semanticEnabled, semanticComplete, claims };
}

function documentPath(path: string): void {
  if (!path.startsWith("wiki/") || !/\.(?:md|markdown)$/iu.test(path) || /[\\\u0000-\u001f\u007f:]/u.test(path)
    || path.split("/").some(part => !part || part.startsWith(".") || part === "node_modules")) {
    throw new Error("The retrieval fixture contains an unsafe Wiki document path.");
  }
}

/** Write only a newly allocated fixture, never the real project's Wiki or preferences. */
export async function materializeRetrievalFixture(item: KnowledgeEvalCase, output: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/u.test(item.id) || item.chunked || item.document.text.length > MAX_KNOWLEDGE_CHUNK_CHARS) {
    throw new Error("Native retrieval fixtures require a bounded single-part case.");
  }
  const files = new Map<string, string>();
  documentPath(item.document.path);
  files.set(item.document.path, item.document.text);
  for (const source of item.evidence) {
    documentPath(source.path);
    if (files.has(source.path) || !Number.isSafeInteger(source.startLine) || source.startLine < 1 || source.startLine > 10_000
      || source.text.length > MAX_KNOWLEDGE_CHUNK_CHARS || (source.context?.length ?? 0) > MAX_KNOWLEDGE_CHUNK_CHARS) {
      throw new Error("The retrieval fixture requires distinct source files and bounded original line numbers.");
    }
    const context = source.context ? normalized(source.context).replace(/\n?$/u, "\n") : "";
    const contextLines = (context.match(/\n/gu) ?? []).length;
    const prefix = context + "\n".repeat(Math.max(0, source.startLine - 1 - contextLines));
    files.set(source.path, prefix + source.text);
  }
  const artifacts = await realpath(join(repositoryRoot, PROJECT_ARTIFACTS_DIR));
  const requested = await realpath(output);
  if (!inside(artifacts, requested)) throw new Error("Retrieval fixtures must be inside this project's owned .pi/artifacts output.");
  const parent = join(requested, "fixtures");
  await mkdir(parent, { recursive: true });
  if (!inside(requested, await realpath(parent))) throw new Error("The retrieval fixture parent resolves outside its owned output.");
  const cwd = await mkdtemp(join(parent, `${item.id}-`));
  for (let index = 1; index <= 4; index++) {
    files.set(`wiki/retrieval-decoys/note-${index}.md`, `# Архив идентификаторов ${index}\nЭта справочная запись касается только названий полей журнала. Слова Classic, бойцы, перезарядка и эвакуация перечислены как поисковые термины; запись не устанавливает игровые правила.\n`);
  }
  for (const [path, content] of files) {
    signal.throwIfAborted();
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content, { flag: "wx", mode: 0o600 });
  }
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(cwd, ".pi", "workspace.jsonc"), JSON.stringify({ wiki: { path: "wiki", index: "index.md" },
    search: { sources: { code: false, knowledge: true, sessions: false, tasks: false, commits: false } } }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
  // The parent repository ignores .pi/artifacts. A real isolated Git root keeps
  // native enumeration scoped here without inheriting that parent's ignore list.
  await execute("git", ["-c", "init.defaultBranch=eval", "init", "--quiet", "--template=", cwd],
    { cwd, timeout: 10_000, signal, maxBuffer: 64 * 1024, windowsHide: true });
  signal.throwIfAborted();
  return await realpath(cwd);
}

/** Exercise the actual native worker and current semantic configuration, with no search mocks or warm-up retries. */
export async function collectRetrievalFixture(item: KnowledgeEvalCase, options: {
  readonly output: string;
  readonly bundledExtensionPath: string;
  readonly signal: AbortSignal;
}): Promise<KnowledgeRetrievalFixture> {
  const { signal } = options;
  const fixtureDirectory = await materializeRetrievalFixture(item, options.output, signal);
  const request: KnowledgeCheckRequest = { cwd: fixtureDirectory, path: item.document.path,
    content: item.document.text, expectedContent: item.document.text };
  const search = createNativeKnowledgeSearch(options.bundledExtensionPath);
  const calls: KnowledgeRetrievalCall[] = [];
  let snapshot: KnowledgeSnapshot | undefined;
  let fresh = false, error: string | undefined;
  try {
    snapshot = await collectKnowledgeEvidence(request, async (cwd, query, owned) => {
      const start = Date.now();
      try {
        const result = await search(cwd, query, owned);
        calls.push({ query: query.query, elapsedMs: Date.now() - start, hits: result.hits.map(hit => ({
          path: hit.path, startLine: hit.startLine, endLine: hit.endLine })), notices: [...result.notices], status: result.status });
        return result;
      } catch (cause) {
        calls.push({ query: query.query, elapsedMs: Date.now() - start, hits: [], notices: [], error: message(cause) });
        throw cause;
      }
    }, signal, "ru");
    signal.throwIfAborted();
    fresh = await snapshot.current(signal);
    signal.throwIfAborted();
  } catch (cause) { signal.throwIfAborted(); error = message(cause); }
  return { fixtureDirectory, request, calls, metrics: scoreKnowledgeRetrieval(item, snapshot, calls, fresh),
    ...(snapshot ? { snapshot } : {}), ...(error ? { error } : {}) };
}
