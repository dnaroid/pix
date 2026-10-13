/** Give every selected source a candidate budget, preserving local order within
 * each source. Pure module shared with Desktop; no native/Node imports. */
import { preferDistinctFiles } from "./native-ranking.mjs";
export function selectFederatedCandidates(hits, limit = 100) {
  const groups = new Map();
  for (const hit of preferDistinctFiles(hits)) {
    if (hit.kind === "settings") continue;
    if (!groups.has(hit.kind)) groups.set(hit.kind, []);
    groups.get(hit.kind).push(hit);
  }
  const selected = new Set();
  for (let index = 0; selected.size < limit; index++) {
    let added = false;
    for (const group of groups.values()) {
      if (group[index] && selected.size < limit) { selected.add(group[index]); added = true; }
    }
    if (!added) break;
  }
  return preferDistinctFiles(hits).filter(hit => selected.has(hit));
}

/** Reuse original metadata, reject incomplete/malformed permutations. */
export function applyFederatedOrder(candidates, order) {
  if (!Array.isArray(order) || order.length !== candidates.length) return;
  const byId = new Map(candidates.map(hit => [`${hit.kind}:${hit.id}`, hit]));
  const ranked = [];
  for (const entry of order) {
    const key = `${entry.kind}:${entry.id}`, hit = byId.get(key);
    if (!hit || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) return;
    byId.delete(key);
    ranked.push({ ...hit, score: entry.score });
  }
  return ranked;
}
