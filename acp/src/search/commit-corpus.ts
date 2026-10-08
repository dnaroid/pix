import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CommitMetadata, CommitSearchHit } from "./commit-contract.js";

export interface CommitDocument { commit: CommitMetadata; message: string; contentHash: string }
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
  await git(cwd, ["log", "HEAD", "--no-decorate", "--no-show-signature", "-z", "--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%B"], signal, b => {
    let start = 0;
    while (start < b.length) {
      const end = b.indexOf(0, start); const stop = end < 0 ? b.length : end;
      const take = Math.min(stop - start, Math.max(0, 65536 - bytes));
      if (take) pieces.push(b.subarray(start, start + take)); bytes += take;
      if (end < 0) break;
      fields.push(Buffer.concat(pieces).toString("utf8")); pieces = []; bytes = 0;
      if (fields.length === 6) {
        const [hash, shortHash, subject, author, date, message] = fields as [string, string, string, string, string, string];
        if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("Commit history unavailable.");
        const commit = { hash, shortHash, subject, author, date };
        docs.push({ commit, message, contentHash: createHash("sha256").update(JSON.stringify([commit, message])).digest("hex") });
        fields = [];
      }
      start = end + 1;
    }
  });
  if (fields.length || pieces.length) throw new Error("Commit history unavailable.");
  return docs;
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
    const words = tokens(`${d.commit.subject} ${d.commit.author} ${d.commit.hash} ${d.message}`);
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
    snippet: `${d.commit.author} · ${d.commit.date} · ${d.commit.hash}`, score, commit: d.commit,
    ...(semantic ? { semantic: true } : {}), ...(contentMatch ? { contentMatch: true } : {}),
  }));
}
