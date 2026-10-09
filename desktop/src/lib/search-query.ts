/**
 * A deliberately small, project-specific technical vocabulary. These are the
 * same feature, not an expansion of the generic word "auto". Keep matching
 * bounded by word boundaries so Auto routing/compression are not conflated with
 * prompt autocomplete.
 */
const AUTOCOMPLETE_ALIASES = /(?<![\p{L}\p{N}])(?:авто[\s\u2010-\u2015-]*пополнени(?:е|я|ю|и|ем|ями|ях)|авто[\s\u2010-\u2015-]*дополнени(?:е|я|ю|и|ем|ями|ях)|автозавершени(?:е|я|ю|и|ем|ями|ях)|auto[\s\u2010-\u2015-]+complet(?:ion|e)|autocompletion)(?![\p{L}\p{N}])/giu;

export function normalizeSearchConcepts(text: string): string {
  return text.normalize("NFKC").replace(AUTOCOMPLETE_ALIASES, "autocomplete");
}

/** Only IDX retrieval is rewritten; session titles retain the user's original query. */
export function indexSearchQuery(query: string): string {
  const normalized = normalizeSearchConcepts(query);
  if (normalized === query.normalize("NFKC")) return query;
  // Remove a purely conversational prefix after resolving an authored term.
  // Do not remove negative/problem reports such as "почему не работает".
  const condensed = normalized.replace(/^\s*как\s+работает\s+/iu, "").trim().replace(/[?!。]+$/u, "").trim();
  return condensed || normalized.trim();
}

/** Explicit local Git patch pickaxe query; other search sources are not invoked. */
export function patchSearchTerm(query: string): string | undefined {
  return /^patch:\s*(.{1,256})\s*$/iu.exec(query.trim())?.[1]?.trim() || undefined;
}
