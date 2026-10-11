import { createHash } from "node:crypto";

export const sha256 = value => createHash("sha256").update(value).digest("hex");
export const tokens = text => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
export function overlaps(a, b) { return a.startLine <= b.endLine && b.startLine <= a.endLine; }
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
export function judge(hits, query, contents) {
  const relevant = hit => query.gold.some(g => g.path === hit.path && overlaps(hit, g));
  const recalls = Object.fromEntries([5, 10].map(k => {
    const paths = new Set(hits.slice(0, k).filter(relevant).map(h => h.path));
    return [`recallAt${k}`, paths.size / new Set(query.gold.map(g => g.path)).size];
  }));
  const first = hits.findIndex(relevant);
  const top = hits.slice(0, 10);
  const valid = top.filter(hit => {
    const lines = contents[hit.path]?.split(/\r?\n/u);
    return lines && Number.isInteger(hit.startLine) && Number.isInteger(hit.endLine)
      && hit.startLine > 0 && hit.endLine >= hit.startLine && hit.endLine <= lines.length;
  });
  const normalize = s => s.replace(/\s+/gu, " ").trim();
  const textAccurate = valid.filter(h => {
    const actual = normalize(contents[h.path].split(/\r?\n/u).slice(h.startLine - 1, h.endLine).join("\n"));
    // IDX's bridge adds a range label and truncation marker, not source text.
    const snippet = normalize((h.content ?? h.snippet ?? "").replace(/^Lines \d+–\d+ · /u, "").replace(/…$/u, ""));
    return snippet.length > 0 && actual.includes(snippet);
  });
  const pertinent = top.filter(relevant);
  const anchorVisible = pertinent.filter(h => query.gold.some(g => g.path === h.path && overlaps(h, g)
    && normalize(h.snippet ?? "").includes(normalize(g.anchor))));
  return { ...recalls, mrr: first < 0 ? 0 : 1 / (first + 1), precisionAt10: pertinent.length / 10,
    returned: top.length, validRanges: valid.length, textAccurate: textAccurate.length,
    relevant: pertinent.length, anchorVisible: anchorVisible.length };
}
export function summarize(rows) {
  const sum = field => rows.reduce((s, r) => s + r.quality[field], 0);
  const average = field => rows.length ? sum(field) / rows.length : null;
  return { n: rows.length, recallAt5: average("recallAt5"), recallAt10: average("recallAt10"),
    mrr: average("mrr"), precisionAt10: average("precisionAt10"),
    validRangeRate: sum("returned") ? sum("validRanges") / sum("returned") : null,
    textAccuracy: sum("returned") ? sum("textAccurate") / sum("returned") : null,
    anchorVisibility: sum("relevant") ? sum("anchorVisible") / sum("relevant") : null,
    medianMs: percentile(rows.map(r => r.measurement.wallMs), .5), p95Ms: percentile(rows.map(r => r.measurement.wallMs), .95),
    medianCpuMs: percentile(rows.map(r => r.measurement.cpuMs).filter(Number.isFinite), .5),
    peakRssBytes: Math.max(0, ...rows.map(r => r.measurement.peakRssBytes ?? 0)) };
}
export function parseTime(stderr, platform) {
  if (platform === "darwin") {
    const times = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/u.exec(stderr);
    const rss = /(\d+)\s+maximum resident set size/u.exec(stderr);
    return { cpuMs: times ? (Number(times[2]) + Number(times[3])) * 1000 : null, peakRssBytes: rss ? Number(rss[1]) : null };
  }
  const times = /BENCH_RESOURCE (\S+) (\S+) (\S+)/u.exec(stderr);
  return { cpuMs: times ? (Number(times[1]) + Number(times[2])) * 1000 : null,
    peakRssBytes: times ? Number(times[3]) * 1024 : null };
}
