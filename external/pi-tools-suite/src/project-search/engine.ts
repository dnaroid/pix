import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { commandAvailable, findProjectRoot } from "../lib/project.js";

const exec = promisify(execFile);
export const PROJECT_SEARCH_SOURCES = ["sessions", "tasks", "commits", "code", "knowledge"] as const;
export type ProjectSearchSource = typeof PROJECT_SEARCH_SOURCES[number];
export const INDEX_SEARCH_MODES = ["hybrid", "semantic", "lexical", "symbol"] as const;
export type IndexSearchMode = typeof INDEX_SEARCH_MODES[number];
export const INDEX_CHUNK_TYPES = ["types", "api", "impl", "tests", "imports"] as const;
export type IndexChunkType = typeof INDEX_CHUNK_TYPES[number];

export interface ProjectSearchParams {
  query: string;
  sources?: ProjectSearchSource[];
  limit?: number;
  projectPath?: string;
  indexMode?: IndexSearchMode;
  /** Options apply to indexed Code/Knowledge sources only. */
  pathPrefix?: string;
  maxFiles?: number;
  chunkTypes?: IndexChunkType[];
  minScore?: number;
  includeContent?: boolean;
  includeImports?: boolean;
  dedupeFile?: boolean;
  dedupeSymbol?: boolean;
  cluster?: boolean;
  excludeTests?: boolean;
  includeTests?: boolean;
}

export interface ProjectSearchHit {
  kind: ProjectSearchSource;
  id: string;
  title: string;
  snippet: string;
  score: number;
  /** Code/Knowledge: project-relative path and matching line range. */
  path?: string;
  startLine?: number;
  endLine?: number;
  /** Session: native Pi session ID; usable by session management tools. */
  sessionId?: string;
  /** Native Pi session file path, usable when opening a past session. */
  sessionPath?: string;
  /** Task: ID in .pi/tasks.jsonc. */
  taskId?: string;
  /** Commit: full HEAD-reachable Git hash. */
  hash?: string;
  /** Commit: project-relative changed paths. */
  changedPaths?: string[];
}

export interface ProjectSearchResponse {
  projectRoot: string;
  query: string;
  sources: ProjectSearchSource[];
  hits: ProjectSearchHit[];
  notices: string[];
}

export interface SessionRecord {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage: string;
}

export interface SessionBoundary {
  firstText: string;
  finalText: string;
}

export interface ProjectSearchServices {
  exec(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<{
    stdout: string; stderr: string; code?: number | null;
  }>;
  listSessions?(cwd: string, signal: AbortSignal): Promise<SessionRecord[]>;
  readSession?(path: string, signal: AbortSignal): Promise<SessionBoundary | undefined>;
  git?(cwd: string, args: string[], signal: AbortSignal): Promise<string>;
  indexed?(cwd: string): boolean;
}

const MAX_OUTPUT = 12_000;
const MAX_SESSIONS = 100;
const MAX_COMMITS = 1000;
const MAX_TASK_FILE = 2 * 1024 * 1024;
const MAX_SESSION_FILE = 2 * 1024 * 1024;
const STOP_WORDS = new Set(["как", "почему", "когда", "где", "зачем", "что", "какие", "какой", "какая", "кто",
  "мы", "наш", "наша", "наши", "для", "это", "и", "или", "по", "в", "на", "из", "the", "why", "how", "when",
  "where", "what", "which", "who", "for", "with", "and", "from", "about", "did", "does", "our", "was"]);

function tokens(text: string): string[] {
  return text.normalize("NFKC").replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase()
    .replace(/ё/gu, "е").match(/[\p{L}\p{N}]+/gu) ?? [];
}
function terms(query: string): string[] {
  const words = [...new Set(tokens(query))].slice(0, 16);
  return words.filter(term => term.length > 1 && !STOP_WORDS.has(term)).slice(0, 8).length
    ? words.filter(term => term.length > 1 && !STOP_WORDS.has(term)).slice(0, 8)
    : words.slice(0, 8);
}
function scoreMatch(queryTerms: readonly string[], title: string, text: string): number {
  const label = tokens(title).join(" ");
  const body = tokens(text).join(" ");
  if (!queryTerms.length) return 0;
  let matched = 0, points = 0;
  for (const term of queryTerms) {
    if (label.includes(term)) { points += 3; matched++; }
    else if (body.includes(term)) { points += 1.2; matched++; }
  }
  if (!matched || (queryTerms.length >= 4 && matched < 2)) return 0;
  return points / (3 * queryTerms.length);
}
function preview(value: string, length = 380): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}
function boundedLimit(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 20;
}
function boundedIdxFiles(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 50;
}
export type ParsedProjectSearchParams = Required<Pick<ProjectSearchParams, "query" | "sources" | "limit" | "indexMode">> & Omit<ProjectSearchParams, "query" | "sources" | "limit" | "indexMode">;
export function parseProjectSearchParams(value: unknown): { params?: ParsedProjectSearchParams; error?: string } {
  const invalid = (message: string) => ({ error: `Invalid project_search request: ${message}` });
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("expected an object");
  const p = value as Record<string, unknown>;
  const flags = ["includeContent", "includeImports", "dedupeFile", "dedupeSymbol", "cluster", "excludeTests", "includeTests"] as const;
  if (Object.keys(p).some(key => !["query", "sources", "limit", "projectPath", "indexMode",
    "pathPrefix", "maxFiles", "chunkTypes", "minScore", ...flags].includes(key))) return invalid("unknown argument");
  if (typeof p.query !== "string" || !p.query.trim() || p.query.length > 2048 || p.query.includes("\0")) return invalid("query must be 1–2048 characters");
  if (p.query.trim().startsWith("-")) return invalid("query must not start with an option prefix");
  if (p.limit !== undefined && !boundedLimit(p.limit)) return invalid("limit must be an integer from 1 to 20");
  if (p.projectPath !== undefined && (typeof p.projectPath !== "string" || !p.projectPath.trim()
    || p.projectPath.includes("\0") || p.projectPath.length > 4096)) return invalid("invalid projectPath");
  if (p.indexMode !== undefined && !INDEX_SEARCH_MODES.includes(p.indexMode as IndexSearchMode)) return invalid("indexMode must be hybrid, semantic, lexical or symbol");
  if (p.pathPrefix !== undefined && (typeof p.pathPrefix !== "string" || !p.pathPrefix.trim()
    || p.pathPrefix.length > 1024 || p.pathPrefix.includes("\0")
    || p.pathPrefix.startsWith("/") || p.pathPrefix.startsWith("~") || p.pathPrefix.includes("\\")
    || p.pathPrefix.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("-")))) {
    return invalid("pathPrefix must be a safe project-relative path");
  }
  if (p.maxFiles !== undefined && !boundedIdxFiles(p.maxFiles)) return invalid("maxFiles must be an integer from 1 to 50");
  if (p.minScore !== undefined && (typeof p.minScore !== "number" || !Number.isFinite(p.minScore)
    || p.minScore < 0 || p.minScore > 1)) return invalid("minScore must be between 0 and 1");
  if (p.chunkTypes !== undefined && (!Array.isArray(p.chunkTypes) || !p.chunkTypes.length
    || p.chunkTypes.length > INDEX_CHUNK_TYPES.length || !p.chunkTypes.every(item => typeof item === "string"
      && INDEX_CHUNK_TYPES.includes(item as IndexChunkType))
    || new Set(p.chunkTypes).size !== p.chunkTypes.length)) return invalid("chunkTypes must be distinct known IDX chunk types");
  if (flags.some(flag => p[flag] !== undefined && typeof p[flag] !== "boolean")) return invalid("IDX flags must be booleans");
  if (p.includeTests === true && p.excludeTests === true) return invalid("includeTests and excludeTests are mutually exclusive");
  const sources = p.sources === undefined ? [...PROJECT_SEARCH_SOURCES] : p.sources;
  if (!Array.isArray(sources) || !sources.length || sources.length > PROJECT_SEARCH_SOURCES.length
    || !sources.every(source => typeof source === "string" && PROJECT_SEARCH_SOURCES.includes(source as ProjectSearchSource))
    || new Set(sources).size !== sources.length) return invalid("sources must be unique search categories");
  const selected = sources as ProjectSearchSource[];
  return { params: { query: p.query.trim(), sources: selected, limit: p.limit as number | undefined ?? 10,
    indexMode: p.indexMode as IndexSearchMode | undefined ?? "hybrid",
    ...(typeof p.projectPath === "string" ? { projectPath: p.projectPath } : {}),
    ...(typeof p.pathPrefix === "string" ? { pathPrefix: p.pathPrefix } : {}),
    ...(p.maxFiles !== undefined ? { maxFiles: p.maxFiles as number } : {}),
    ...(p.minScore !== undefined ? { minScore: p.minScore as number } : {}),
    ...(Array.isArray(p.chunkTypes) ? { chunkTypes: p.chunkTypes as IndexChunkType[] } : {}),
    ...Object.fromEntries(flags.filter(flag => p[flag] !== undefined).map(flag => [flag, p[flag]])),
  } };
}

export async function resolveSearchRoot(cwd: string, projectPath?: string): Promise<string> {
  const selected = projectPath === "~" ? homedir()
    : projectPath?.startsWith("~/") ? path.join(homedir(), projectPath.slice(2))
    : projectPath ? path.resolve(cwd, projectPath) : findProjectRoot(cwd);
  const canonical = await realpath(selected);
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) throw new Error("Selected project is not a directory");
  return canonical;
}

async function defaultSessionList(cwd: string, signal: AbortSignal): Promise<SessionRecord[]> {
  return SessionManager.list(cwd, undefined, undefined, signal);
}
function messageText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 4096);
  if (!Array.isArray(content)) return "";
  return content.flatMap(block => block && typeof block === "object" && block.type === "text"
    && typeof block.text === "string" ? [block.text] : []).join(" ").slice(0, 4096);
}
/** Same first/last completed assistant boundaries as the Desktop search index. */
export async function readSessionBoundary(pathname: string, signal: AbortSignal): Promise<SessionBoundary | undefined> {
  signal.throwIfAborted();
  const info = await lstat(pathname).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_SESSION_FILE || !pathname.endsWith(".jsonl")) return undefined;
  signal.throwIfAborted();
  const entries = SessionManager.open(pathname).getBranch();
  signal.throwIfAborted();
  let firstText = "", finalText = "";
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user" && !firstText) firstText = messageText(message.content);
    if (message.role === "assistant" && message.stopReason === "stop") finalText = messageText(message.content);
  }
  return { firstText, finalText };
}

async function searchSessions(root: string, queryTerms: readonly string[], signal: AbortSignal, deps: ProjectSearchServices): Promise<{ hits: ProjectSearchHit[]; notices: string[] }> {
  const discovered = await (deps.listSessions ?? defaultSessionList)(root, signal);
  signal.throwIfAborted();
  const relevant: SessionRecord[] = [];
  for (const session of discovered) {
    signal.throwIfAborted();
    if (!session.cwd || path.resolve(session.cwd) === root
      || await realpath(session.cwd).catch(() => undefined) === root) relevant.push(session);
  }
  const items = relevant.slice(0, MAX_SESSIONS);
  const hits: ProjectSearchHit[] = [];
  let unreadable = 0;
  for (const session of items) {
    signal.throwIfAborted();
    const title = (session.name?.trim() || session.firstMessage.trim().slice(0, 140) || session.id).slice(0, 240);
    let content: SessionBoundary | undefined;
    try {
      content = await (deps.readSession ?? readSessionBoundary)(session.path, signal);
    } catch {
      signal.throwIfAborted();
      unreadable++;
    }
    const first = content?.firstText ?? session.firstMessage.slice(0, 4096);
    const last = content?.finalText ?? "";
    const score = scoreMatch(queryTerms, title, `${session.id} ${first} ${last}`);
    if (!score) continue;
    hits.push({
      kind: "sessions", id: `sessions:${session.id}`, sessionId: session.id,
      sessionPath: session.path, title, score,
      snippet: preview(`First: ${first.slice(0, 180)}\nFinal: ${last.slice(0, 180)}`),
    });
  }
  const notices: string[] = [];
  if (relevant.length > MAX_SESSIONS) notices.push(`Sessions: inspected the ${MAX_SESSIONS} most recent sessions; narrow the query if older history is needed.`);
  if (unreadable) notices.push(`Sessions: ${unreadable} session files could not be read.`);
  return { hits, notices };
}

async function searchTasks(root: string, queryTerms: readonly string[], signal: AbortSignal): Promise<{ hits: ProjectSearchHit[]; notices: string[] }> {
  const folder = await lstat(path.join(root, ".pi")).catch(() => undefined);
  if (!folder?.isDirectory() || folder.isSymbolicLink()) return { hits: [], notices: [] };
  const filename = path.join(root, ".pi", "tasks.jsonc");
  const info = await lstat(filename).catch(() => undefined);
  if (!info) return { hits: [], notices: [] };
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_TASK_FILE) return { hits: [], notices: ["Tasks: storage is unsafe or too large."] };
  const errors: ParseError[] = [];
  const content = await readFile(filename, { encoding: "utf8", signal });
  const parsed: unknown = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !("version" in parsed) || parsed.version !== 1 || !("tasks" in parsed)
    || !Array.isArray(parsed.tasks)) return { hits: [], notices: ["Tasks: invalid project task storage."] };
  const seen = new Set<string>();
  const hits: ProjectSearchHit[] = [];
  for (const raw of parsed.tasks.slice(0, 10_000) as unknown[]) {
    signal.throwIfAborted();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const task = raw as Record<string, unknown>;
    if (typeof task.id !== "string" || !task.id || task.id.length > 128 || seen.has(task.id)) continue;
    seen.add(task.id);
    const description = typeof task.description === "string" ? task.description.slice(0, 10000) : "";
    const title = (typeof task.title === "string" && task.title.trim()
      ? task.title : description.split("\n").find(s => s.trim()) ?? "Untitled task").trim().slice(0, 200);
    const metadata = `${task.id} ${task.type ?? ""} ${task.status ?? ""} ${task.priority ?? ""} ${description}`;
    const score = scoreMatch(queryTerms, title, metadata);
    if (!score) continue;
    hits.push({ kind: "tasks", id: `tasks:${task.id}`, taskId: task.id, title,
      snippet: preview(`${task.status ?? ""} · ${task.type ?? ""} · ${task.priority ?? ""} · ${description}`), score });
  }
  return { hits, notices: parsed.tasks.length > 10_000 ? ["Tasks: truncated to 10,000 saved tasks."] : [] };
}

/** Git-owned, HEAD-only history; never reads or retains patches except on explicit patch:<literal>. */
async function safeGit(root: string, args: string[], signal: AbortSignal): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const { stdout } = await exec("git", ["--no-pager", "--no-replace-objects", ...args], {
    cwd: root,
    env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: 8_000,
    maxBuffer: 3 * 1024 * 1024,
    signal,
  });
  return stdout;
}

interface CommitRecord {
  hash: string;
  shortHash: string;
  title: string;
  author: string;
  date: string;
  message: string;
  paths: string[];
}

export function parseGitHistory(output: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  let fields: string[] = [];
  let paths: string[] = [];
  for (const piece of output.split("\0")) {
    if (/^PIX-PROJECT-COMMIT:[a-f0-9]{40,64}$/u.test(piece)) {
      fields = [piece.slice("PIX-PROJECT-COMMIT:".length)];
      paths = [];
      continue;
    }
    if (!fields.length) continue;
    if (fields.length < 6) {
      fields.push(piece);
      if (fields.length === 6) {
        const [hash, shortHash, title, author, date, message] = fields;
        commits.push({ hash: hash!, shortHash: shortHash!, title: title!, author: author!, date: date!, message: message!, paths });
      }
      continue;
    }
    const filename = piece.replace(/^\n/u, "");
    if (filename && paths.length < 256 && filename.length <= 1024) paths.push(filename);
  }
  return commits;
}

async function searchCommits(root: string, query: string, queryTerms: readonly string[], signal: AbortSignal, deps: ProjectSearchServices): Promise<{ hits: ProjectSearchHit[]; notices: string[] }> {
  const pickaxe = /^patch:\s*(.{1,256})$/iu.exec(query)?.[1]?.trim();
  const args = [
    "log", "HEAD", "--no-decorate", "--no-show-signature", "--no-renames",
    "--no-ext-diff", "--no-textconv", "-z",
    `--max-count=${pickaxe ? 50 : MAX_COMMITS}`,
    "--format=PIX-PROJECT-COMMIT:%H%x00%h%x00%s%x00%an%x00%aI%x00%B%x00",
    "--name-only",
    ...(pickaxe ? ["-G", pickaxe.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")] : []),
  ];
  const output = await (deps.git ?? safeGit)(root, args, signal);
  signal.throwIfAborted();
  const commits = parseGitHistory(output);
  const hits: ProjectSearchHit[] = [];
  for (const commit of commits) {
    const score = pickaxe ? 1 : scoreMatch(queryTerms, commit.title,
      `${commit.hash} ${commit.shortHash} ${commit.author} ${commit.message} ${commit.paths.join(" ")}`);
    if (!score) continue;
    hits.push({
      kind: "commits", id: `commits:${commit.hash}`, hash: commit.hash,
      title: commit.title.slice(0, 240), score, changedPaths: commit.paths.slice(0, 64),
      snippet: preview(`${commit.shortHash} · ${commit.author} · ${commit.date} · ${commit.message.slice(0, 240)}\nChanged: ${commit.paths.slice(0, 5).join(", ")}`),
    });
  }
  const notices = commits.length >= (pickaxe ? 50 : MAX_COMMITS)
    ? [`Commits: scanned at most ${pickaxe ? 50 : MAX_COMMITS} HEAD ancestors/matches; older history may need a narrower query.`] : [];
  return { hits, notices };
}

/** Parse IDX's length-delimited body sections; never reinterpret a body line as a result header. */
export function parseIdxHits(output: string, kind: "code" | "knowledge"): ProjectSearchHit[] {
  const hits: ProjectSearchHit[] = [];
  const seen = new Set<string>();
  const lines = output.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+?):(\d+)-(\d+) \(score: ([0-9.]+), rank=[^,]+, domain=(code|document)(?:,.*)?\)$/u.exec(lines[i]!.trim());
    if (!match) continue;
    let content = "";
    let marker = i + 1;
    if (/^\s+kind=/u.test(lines[marker] ?? "")) marker++;
    const count = /^Content: (\d+) lines$/u.exec(lines[marker] ?? "");
    if (count) {
      const length = Number(count[1]);
      if (!Number.isSafeInteger(length) || length > 10_000 || marker + length >= lines.length) break;
      if (length) content = lines.slice(marker + 1, marker + 1 + length).join("\n").slice(0, 700);
      i = marker + length;
    }
    if (match[5] !== (kind === "code" ? "code" : "document")) continue;
    const filename = match[1]!;
    const startLine = Number(match[2]), endLine = Number(match[3]);
    const score = Number(match[4]);
    if (!filename || filename.startsWith("/") || filename.includes("\\") || filename.startsWith("~")
      || filename.split("/").some(part => !part || part === "." || part === "..")
      || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine
      || !Number.isFinite(score)) continue;
    const id = `${kind}:${filename}:${startLine}-${endLine}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({ kind, id, path: filename, startLine, endLine, title: filename,
      snippet: `Lines ${startLine}–${endLine}${content ? ` · ${preview(content)}` : ""}`, score: Math.max(0, Math.min(score, 1)) });
  }
  return hits;
}

async function indexedAvailable(root: string, deps: ProjectSearchServices): Promise<boolean> {
  if (deps.indexed) return deps.indexed(root);
  const info = await lstat(path.join(root, ".indexer-cli")).catch(() => undefined);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink() && commandAvailable("idx"));
}

/** Strongly typed IDX argument adapter; never accept arbitrary user argv. */
export function indexSearchArgs(query: string, kind: "code" | "knowledge", params: Omit<ProjectSearchParams, "query">): string[] {
  const args = ["search", query,
    "--domain", kind === "code" ? "code" : "document",
    "--mode", params.indexMode ?? "hybrid",
    "--max-files", String(params.maxFiles ?? (params.includeContent ? 1 : 3))];
  if (params.pathPrefix) args.push("--path-prefix", params.pathPrefix);
  if (params.chunkTypes?.length) args.push("--chunk-types", params.chunkTypes.join(","));
  if (params.minScore !== undefined) args.push("--min-score", String(params.minScore));
  for (const [option, name] of [
    ["includeContent", "--include-content"],
    ["includeImports", "--include-imports"],
    ["dedupeFile", "--dedupe-file"],
    ["dedupeSymbol", "--dedupe-symbol"],
    ["cluster", "--cluster"],
    ["excludeTests", "--exclude-tests"],
    ["includeTests", "--include-tests"],
  ] as const) if (params[option]) args.push(name);
  return args;
}

async function searchIdx(root: string, query: string, kinds: readonly ("code" | "knowledge")[], params: ProjectSearchParams,
  signal: AbortSignal, deps: ProjectSearchServices): Promise<{ hits: ProjectSearchHit[]; notices: string[] }> {
  if (!kinds.length) return { hits: [], notices: [] };
  if (!await indexedAvailable(root, deps)) return { hits: [], notices: [
    "Code/Knowledge skipped: this project needs an existing .indexer-cli index and idx executable. No initialization was performed.",
  ] };
  const hits: ProjectSearchHit[] = [], notices: string[] = [];
  for (const kind of kinds) {
    signal.throwIfAborted();
    try {
      const response = await deps.exec("idx", indexSearchArgs(query, kind, params), { cwd: root, signal, timeout: 12_000 });
      signal.throwIfAborted();
      if ((response.code ?? 0) !== 0) {
        notices.push(`${kind}: IDX query unavailable; existing local results remain available.`);
        continue;
      }
      hits.push(...parseIdxHits(response.stdout.slice(0, 256 * 1024), kind));
      if (response.stdout.length > 256 * 1024) notices.push(`${kind}: IDX response was truncated.`);
    } catch {
      signal.throwIfAborted();
      notices.push(`${kind}: IDX query unavailable or timed out; existing local results remain available.`);
    }
  }
  return { hits, notices };
}

/** Stateless federated retrieval. Uses the same session/tasks/Git stores and IDX index as Desktop. */
export async function searchProject(
  cwd: string, params: ProjectSearchParams, deps: ProjectSearchServices,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProjectSearchResponse> {
  const parsed = parseProjectSearchParams(params);
  if (!parsed.params) throw new Error(parsed.error ?? "Invalid project_search request");
  const { query, sources, limit, projectPath } = parsed.params;
  signal.throwIfAborted();
  const root = await resolveSearchRoot(cwd, projectPath);
  signal.throwIfAborted();
  const all: ProjectSearchHit[] = [], notices: string[] = [];
  const wanted = /^patch:/iu.test(query) ? sources.filter(source => source === "commits") : sources;
  const queryTerms = terms(query);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 18_000);
  const deadline = AbortSignal.any([signal, timeout.signal]);
  let wake!: () => void;
  const deadlineReached = new Promise<void>(resolve => { wake = resolve; });
  const onAbort = () => wake();
  deadline.addEventListener("abort", onAbort, { once: true });
  const jobs: Array<Promise<void>> = [];
  const collect = (label: string, run: () => Promise<{ hits: ProjectSearchHit[]; notices: string[] }>): void => {
    jobs.push((async () => {
      try {
        const response = await run();
        if (!deadline.aborted) {
          all.push(...response.hits);
          notices.push(...response.notices);
        }
      } catch {
        if (signal.aborted) return;
        notices.push(`${label}: source unavailable or timed out; other results remain available.`);
      }
    })());
  };
  if (wanted.includes("tasks")) collect("Tasks", () => searchTasks(root, queryTerms, deadline));
  if (wanted.includes("sessions")) collect("Sessions", () => searchSessions(root, queryTerms, deadline, deps));
  if (wanted.includes("commits")) collect("Commits", () => searchCommits(root, query, queryTerms, deadline, deps));
  const idxKinds = wanted.filter((source): source is "code" | "knowledge" => source === "code" || source === "knowledge");
  if (idxKinds.length) collect("IDX", () => searchIdx(root, query, idxKinds, parsed.params!, deadline, deps));
  try {
    await Promise.race([
      Promise.allSettled(jobs),
      deadlineReached,
    ]);
    signal.throwIfAborted();
    if (timeout.signal.aborted) notices.push("Some sources exceeded the 18-second search deadline.");
  } finally {
    deadline.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  }
  if (wanted.length !== sources.length) notices.push("patch: only searches changed Git lines; other sources were skipped.");
  const sorted = all.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const unique = new Map<string, ProjectSearchHit>();
  for (const hit of sorted) if (!unique.has(hit.id)) unique.set(hit.id, hit);
  return { projectRoot: root, query, sources: wanted, hits: [...unique.values()].slice(0, limit),
    notices: [...new Set(notices)] };
}

/** Short human-readable result and machine-readable structured details. */
export function formatProjectSearch(response: ProjectSearchResponse): string {
  const lines = [`Project search: ${response.query}`, `Project: ${response.projectRoot}`,
    `Sources: ${response.sources.join(", ")}`];
  if (!response.hits.length) lines.push("No matching results found in the searched sources.");
  response.hits.forEach((hit, index) => {
    const target = hit.path ? `${hit.path}:${hit.startLine}-${hit.endLine}`
      : hit.hash ? `commit ${hit.hash}`
      : hit.taskId ? `task ${hit.taskId}`
      : hit.sessionId ? `session ${hit.sessionId}` : hit.id;
    lines.push(`\n${index + 1}. [${hit.kind}] ${hit.title} (${target})`,
      `   Source ID: ${hit.id}`,
      `   ${hit.snippet}`);
  });
  if (response.notices.length) lines.push("\nNotices:", ...response.notices.map(n => `- ${n}`));
  let result = lines.join("\n");
  if (result.length > MAX_OUTPUT) result = result.slice(0, MAX_OUTPUT - 80) + "\n[Output truncated; narrow sources/query.]";
  return result;
}
