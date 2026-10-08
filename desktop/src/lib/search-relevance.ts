import type { SearchSetting } from "../../../acp/src/search/contract";
import type { SearchHit } from "./universal-search";
import { scoreBm25 } from "./search-bm25";
import { normalizeSearchConcepts } from "./search-query";

const STOP_WORDS = new Set("a an the to of in on and for is в во на по с со и или ли как что для это работает".split(" "));

function tokens(text: string): string[] {
  return normalizeSearchConcepts(text.replace(/([a-z])([A-Z])/gu, "$1 $2")).toLowerCase().replace(/ё/gu, "е").match(/[\p{L}\p{N}]+/gu) ?? [];
}

// A small inflection heuristic, not a semantic model or general Russian stemmer.
function stem(word: string): string {
  if (/^[а-я]{6,}$/u.test(word)) {
    const root = word.replace(/(?:ления|ление|лений|илась|ились|ился|ениями|ение|ения|ений|ить|ется|ются|ами|ями|ого|ему|ые|ый|ая|ой|ов|ам|ах|ях|ы|а|я|и|е|у)$/u, "");
    if (root.length >= 4) return root;
  }
  if (/^[a-z]{5,}s$/u.test(word) && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function normalized(text: string): string[] {
  return tokens(text).map(stem);
}

function coverage(words: readonly string[], text: readonly string[]): number {
  const found = new Set(text);
  return words.filter(word => found.has(word)).length / words.length;
}

/** BM25 uses indexed result content when supplied, but no extra file reads. */
export function rankSearchHits(
  hits: readonly SearchHit[], query: string, settings: readonly SearchSetting[], semanticSettings: boolean,
): SearchHit[] {
  const rawWords = tokens(query);
  const meaningful = rawWords.filter(word => !STOP_WORDS.has(word));
  const words = [...new Set((meaningful.length ? meaningful : rawWords).map(stem))];
  if (!words.length) return [];
  const unique = new Map<string, SearchHit>();
  for (const hit of hits) if (!unique.has(`${hit.kind}:${hit.id}`)) unique.set(`${hit.kind}:${hit.id}`, hit);
  const candidates = [...unique.values()];
  const fields = new Map(settings.map(field => [field.id, field]));
  const sourceRanks = new Map<string, number>();
  const kinds = ["settings", "sessions", "tasks", "commits", "code", "knowledge"];
  for (const kind of kinds) {
    candidates.filter(hit => hit.kind === kind).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .forEach((hit, rank) => sourceRanks.set(`${hit.kind}:${hit.id}`, rank));
  }
  const documents = candidates.flatMap(hit => {
    const key = `${hit.kind}:${hit.id}`;
    let metadata = hit.snippet;
    if (hit.kind === "settings") {
      const field = fields.get(hit.fieldId);
      if (field) metadata = `${field.description} ${field.synonyms.join(" ")}`;
    } else if (hit.kind === "tasks") metadata += ` ${hit.taskId}`;
    else if (hit.kind === "commits") metadata += ` ${hit.hash} ${hit.commit.author}`;
    else if (hit.kind === "code" || hit.kind === "knowledge") metadata = hit.content ?? metadata;
    const title = normalized(hit.title);
    const metadataWords = normalized(metadata);
    if (hit.kind === "commits" && rawWords.length === 1 && /^[a-f0-9]{7,64}$/u.test(rawWords[0]!) && hit.hash.startsWith(rawWords[0]!)) metadataWords.push(words[0]!);
    const totalCoverage = coverage(words, [...title, ...metadataWords]);
    // IDX exposes paths/ranges, not matching content. Do not reject body-only hits.
    const opaque = hit.kind === "code" || hit.kind === "knowledge" || (hit.kind === "settings" && semanticSettings)
      || (hit.kind === "commits" && (("semantic" in hit && hit.semantic === true)
        || ("contentMatch" in hit && hit.contentMatch === true)));
    const exact = tokens(hit.title).join(" ") === rawWords.join(" ");
    return [{ hit, title, metadata: metadataWords, eligible: totalCoverage >= 0.5 || opaque, exact, rank: sourceRanks.get(key) ?? 0 }];
  });
  const scores = scoreBm25(documents, words);
  const ranked = documents.map((document, index) => ({ ...document, bm25: scores[index]! })).filter(document => document.eligible);
  ranked.sort((a, b) => b.bm25 - a.bm25 || Number(b.exact) - Number(a.exact)
    || a.rank - b.rank || kinds.indexOf(a.hit.kind) - kinds.indexOf(b.hit.kind) || a.hit.id.localeCompare(b.hit.id));
  return ranked.slice(0, 60).map(({ hit }) => hit);
}
