/** Pure query evidence and file diversity, shared by lexical/hybrid retrieval. */
export function searchTokens(text) {
  return text.normalize("NFKC").replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}])([\p{Lu}][\p{Ll}])/gu, "$1 $2").toLowerCase().replace(/ё/g, "е")
    .match(/[\p{L}\p{N}]+/gu) || [];
}

const STOPWORDS = new Set("a an the and or for from to of in on is are does do what how where why which this that with как где почему что какие какой для это или при из на не и в во по с со ли".split(" "));
export function queryTerms(query) {
  return [...new Set(searchTokens(query).filter(term => !STOPWORDS.has(term)))].slice(0, 12);
}

export function queryIdentifiers(query) {
  return (query.match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) || [])
    .filter(word => /[\p{Ll}\d][\p{Lu}]|[\p{L}]_[\p{L}]|[\p{Lu}]{2}[\p{Ll}]/u.test(word));
}

/** Prefer distinct documents without discarding useful alternate chunks. */
export function preferDistinctFiles(hits) {
  const seen = new Set(), first = [], remaining = [];
  for (const hit of hits) {
    const key = hit.path ? `${hit.kind}:${hit.path}` : `${hit.kind}:${hit.id}`;
    (seen.has(key) ? remaining : first).push(hit);
    seen.add(key);
  }
  return [...first, ...remaining];
}

/** Literal identifiers are stronger evidence than an incidental partial token. */
export function prioritizeIdentifiers(hits, query) {
  const identifiers = queryIdentifiers(query).map(word => word.toLowerCase());
  if (!identifiers.length) return hits;
  const strength = hit => {
    const text = `${hit.path}\n${hit.title}\n${hit.content ?? hit.snippet}`.toLowerCase();
    return identifiers.filter(word => text.includes(word)).length;
  };
  return hits.map((hit, index) => ({ hit, index, strength: strength(hit) }))
    .sort((a, b) => b.strength - a.strength || a.index - b.index).map(item => item.hit);
}
