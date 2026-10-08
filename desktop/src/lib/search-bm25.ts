export interface SearchTerms {
  title: readonly string[];
  metadata: readonly string[];
}

const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 3;

/** Field-weighted BM25 over the retrieved, deduplicated candidate corpus. */
export function scoreBm25(documents: readonly SearchTerms[], query: readonly string[]): number[] {
  if (!documents.length) return [];
  const terms = [...new Set(query)];
  const frequencies = documents.map(document => {
    const count = (words: readonly string[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
      return counts;
    };
    return { title: count(document.title), metadata: count(document.metadata) };
  });
  const average = (field: keyof SearchTerms): number =>
    documents.reduce((sum, document) => sum + document[field].length, 0) / documents.length || 1;
  const averages = { title: average("title"), metadata: average("metadata") };
  const idf = new Map(terms.map(term => {
    const df = frequencies.filter(document => document.title.has(term) || document.metadata.has(term)).length;
    return [term, Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))];
  }));
  return documents.map((document, index) => {
    const fieldScore = (field: keyof SearchTerms): number => terms.reduce((sum, term) => {
      const tf = frequencies[index]![field].get(term) ?? 0;
      const norm = K1 * (1 - B + B * document[field].length / averages[field]);
      return sum + idf.get(term)! * (tf * (K1 + 1)) / (tf + norm);
    }, 0);
    return TITLE_WEIGHT * fieldScore("title") + fieldScore("metadata");
  });
}
