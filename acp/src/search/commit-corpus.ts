import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CommitMetadata, CommitSearchHit } from "./commit-contract.js";

export interface CommitDocument { commit: CommitMetadata; message: string; contentHash: string }
/** Patch searches are explicit, never an implicit cost of a regular commit query. */
export function patchSearchTerm(query: string): string | undefined {
  return /^patch:\s*(.{1,256})\s*$/iu.exec(query.trim())?.[1]?.trim() || undefined;
}
/** Fixed arguments only. stderr is deliberately discarded, including Git diagnostics. */
async function git(cwd: string, args: string[], signal: AbortSignal, consume: (b: Buffer) => void): Promise<void> {
  signal.throwIfAborted();
  const env = { ...process.env };
  // Explicit project ownership must not inherit an unrelated Git repository override.
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  const child = spawn("git", ["--no-pager", "--no-replace-objects", ...args], {
    cwd, stdio: ["ignore", "pipe", "ignore"], env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  let failure: unknown;
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", () => { failure = new Error("Commit history unavailable."); });
    child.once("close", code => code === 0 && !failure ? resolve() : reject(failure ?? new Error("Commit history unavailable.")));
  });
  // Attach the rejection handler before consuming the stream.
  void closed.catch(() => {});
  const abort = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const b of child.stdout) { signal.throwIfAborted(); consume(b as Buffer); }
    await closed; signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed.catch(() => {});
  }
}
export async function commitProjectRoot(cwd: string, signal: AbortSignal): Promise<string> {
  const parts: Buffer[] = []; let size = 0;
  await git(cwd, ["rev-parse", "--show-toplevel"], signal, b => { size += b.length; if (size > 16384) throw new Error("Commit history unavailable."); parts.push(b); });
  return Buffer.concat(parts).toString("utf8").replace(/\r?\n$/, "");
}
/** Stream every HEAD ancestor, bounding individual fields but never the history count. */
export async function readCommitCorpus(cwd: string, signal: AbortSignal): Promise<CommitDocument[]> {
  const docs: CommitDocument[] = [];
  let fields: string[] = [], pieces: Buffer[] = [], bytes = 0;
  let paths: string[] = [], pathBytes = 0;
  const accept = (value: string): void => {
    if (/^PIX-COMMIT-START:[a-f0-9]{40,64}$/u.test(value)) {
      if (fields.length && fields.length < 6) throw new Error("Commit history unavailable.");
      fields = [value.slice("PIX-COMMIT-START:".length)];
      paths = []; pathBytes = 0;
      return;
    }
    if (!fields.length) return;
    if (fields.length < 6) {
      fields.push(value);
      if (fields.length === 6) {
        const [hash, shortHash, subject, author, date, message] = fields as [string, string, string, string, string, string];
        const base = { hash, shortHash, subject, author, date };
        const commit: CommitMetadata = { ...base, changedPaths: paths };
        // Paths must not invalidate previously purchased message embeddings.
        docs.push({ commit, message, contentHash: createHash("sha256").update(JSON.stringify([base, message])).digest("hex") });
      }
      return;
    }
    const path = value.startsWith("\n") ? value.slice(1) : value;
    const size = Buffer.byteLength(path);
    if (path && size <= 1024 && paths.length < 256 && pathBytes + size <= 32768) {
      paths.push(path); pathBytes += size;
    }
  };
  await git(cwd, ["log", "HEAD", "--no-decorate", "--no-show-signature", "--no-renames", "-z", "--format=PIX-COMMIT-START:%H%x00%h%x00%s%x00%an%x00%aI%x00%B%x00", "--name-only"], signal, b => {
    let start = 0;
    while (start < b.length) {
      const end = b.indexOf(0, start); const stop = end < 0 ? b.length : end;
      const take = Math.min(stop - start, Math.max(0, 65536 - bytes));
      if (take) pieces.push(b.subarray(start, start + take)); bytes += take;
      if (end < 0) break;
      accept(Buffer.concat(pieces).toString("utf8")); pieces = []; bytes = 0;
      start = end + 1;
    }
  });
  if ((fields.length > 0 && fields.length < 6) || pieces.length) throw new Error("Commit history unavailable.");
  return docs;
}
/** Literal pickaxe search is opt-in and reads patches only when explicitly requested. */
export async function readPatchMatches(cwd: string, term: string, signal: AbortSignal): Promise<string[]> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 8000);
  const owned = AbortSignal.any([signal, timeout.signal]);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  let output = "";
  try {
    await git(cwd, ["log", "HEAD", "--no-show-signature", "--no-ext-diff", "--no-textconv",
      "--root", "--max-count=50", "-z", "--format=PIX-PATCH:%H", "-G", escaped],
    owned, bytes => { output += bytes.toString("utf8").slice(0, Math.max(0, 8192 - output.length)); });
    return [...output.matchAll(/PIX-PATCH:([a-f0-9]{40,64})/gu)].map(match => match[1]!);
  } finally {
    clearTimeout(timer);
    signal.throwIfAborted();
  }
}
const tokens = (s: string): string[] => s.normalize("NFKC").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]!, y = b[i]!; dot += x * y; aa += x * x; bb += y * y; }
  const v = dot / Math.sqrt(aa * bb); return Number.isFinite(v) ? v : 0;
}
/** Full-corpus positive Robertson IDF BM25, fused with positive cosine candidates by RRF. */
export function rankCommits(docs: readonly CommitDocument[], query: string, limit: number, vectors: ReadonlyMap<string, number[]>, queryVector?: number[]): CommitSearchHit[] {
  const terms = [...new Set(tokens(query))];
  const corpus = docs.map(d => {
    const words = tokens(`${d.commit.subject} ${d.commit.author} ${d.commit.hash} ${d.message} ${d.commit.changedPaths?.join(" ") ?? ""}`);
    const frequencies = new Map<string, number>();
    for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    return { d, frequencies, length: words.length };
  });
  const avg = corpus.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map(terms.map(t => [t, corpus.filter(d => d.frequencies.has(t)).length]));
  const lexical = corpus.map(({ d, frequencies, length }) => {
    let score = 0;
    for (const term of terms) {
      const tf = frequencies.get(term) ?? 0;
      if (tf) score += Math.log(1 + (docs.length - df.get(term)! + 0.5) / (df.get(term)! + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / (avg || 1)));
      if (/^[a-f0-9]{7,64}$/.test(term) && d.commit.hash.startsWith(term)) score += 20;
    }
    return { d, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score || a.d.commit.hash.localeCompare(b.d.commit.hash));
  const semantic = queryVector ? docs.map(d => ({ d, score: vectors.has(d.contentHash) ? cosine(queryVector, vectors.get(d.contentHash)!) : 0 }))
    .filter(d => d.score > 0).sort((a, b) => b.score - a.score || a.d.commit.hash.localeCompare(b.d.commit.hash)).slice(0, Math.max(20, limit)) : [];
  const fused = new Map<string, { d: CommitDocument; score: number; semantic: boolean; contentMatch: boolean }>();
  for (const [list, isSemantic] of [[lexical, false], [semantic, true]] as const) {
    list.slice(0, Math.max(20, limit)).forEach(({ d }, i) => {
      const hit = fused.get(d.commit.hash) ?? { d, score: 0, semantic: false, contentMatch: false };
      hit.score += 1 / (60 + i + 1);
      hit.semantic ||= isSemantic;
      hit.contentMatch ||= !isSemantic;
      fused.set(d.commit.hash, hit);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.d.commit.hash.localeCompare(b.d.commit.hash)).slice(0, limit).map(({ d, score, semantic, contentMatch }) => ({
    kind: "commits", id: `commits:${d.commit.hash}`, hash: d.commit.hash, title: d.commit.subject,
    snippet: `${d.commit.author} · ${d.commit.date} · ${d.commit.hash}${d.commit.changedPaths?.length ? `\n${d.commit.changedPaths.slice(0, 3).join(" · ")}` : ""}`, score, commit: d.commit,
    ...(semantic ? { semantic: true } : {}), ...(contentMatch ? { contentMatch: true } : {}),
  }));
}
