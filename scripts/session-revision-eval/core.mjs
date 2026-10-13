import { createHash } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const positive = (value) => value === 'requested' || value === 'reported';

export function validateCorpus(corpus) {
  if (!Array.isArray(corpus) || !corpus.length) throw new Error('Empty corpus');
  const ids = new Set();
  for (const item of corpus) {
    if (!item.id || ids.has(item.id)) throw new Error('Duplicate/missing case ID');
    ids.add(item.id);
    if (!Array.isArray(item.messages) || !item.messages.length) throw new Error('Empty messages');
    const messages = new Map();
    item.messages.forEach((m, i) => {
      if (!m.id || messages.has(m.id) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !m.text.trim()) throw new Error('Invalid message');
      messages.set(m.id, { ...m, order: i });
    });
    for (const e of item.expected ?? []) {
      const a = messages.get(e.earlierId), b = messages.get(e.laterId);
      if (!a || !b || a.order >= b.order || !e.evidence || !a.text.includes(e.evidence) || !['requested', 'reported', 'unchanged', 'uncertain'].includes(e.relation)) throw new Error('Invalid evidence annotation');
    }
    for (const q of item.queries ?? []) {
      if (!q.text || !messages.has(q.decisionId) || !messages.has(q.reportedId) || (q.asOfId && !messages.has(q.asOfId))) throw new Error('Invalid query annotation');
    }
  }
}

/** Syntax-only extraction, not an assertion parser. Offsets are UTF-16 in original text. */
export function spans(messages) {
  const segmenter = new Intl.Segmenter('und', { granularity: 'sentence' });
  return messages.flatMap((m, order) => {
    const result = [];
    for (const line of m.text.matchAll(/[^\r\n]+/gu)) {
      for (const part of segmenter.segment(line[0])) {
        const left = part.segment.length - part.segment.trimStart().length;
        const text = part.segment.trim();
        if (!text) continue;
        const start = line.index + part.index + left;
        // Bound inputs without dropping any source text, even for unpunctuated text.
        for (let offset = 0; offset < text.length; offset += 600) {
          const begin = start + offset, end = Math.min(start + text.length, begin + 600);
          result.push({ id: `${m.id}:${begin}:${end}`, entryId: m.id, order, start: begin, end, text: m.text.slice(begin, end), role: m.role });
        }
      }
    }
    return result;
  });
}

export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) throw new Error('Invalid vectors');
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = Math.hypot(...a) * Math.hypot(...b);
  if (!norm) throw new Error('Zero vector');
  return dot / norm;
}

export function targetText(messages, order) {
  const m = messages[order];
  const context = m.text.length < 160 ? messages.slice(Math.max(0, order - 2), order).map(x => `Context (${x.role}): ${x.text.slice(-1200)}`) : [];
  return [...context, `Target (${m.role}): ${m.text}`].join('\n\n');
}

/** No labels or queries enter discovery. Searches all earlier spans, not query top-k. */
export function candidates(messages, units, vector, topK = 3) {
  if (!Number.isInteger(topK) || topK < 1) throw new Error('Invalid topK');
  return messages.flatMap((later, order) => {
    const ranked = units.filter(s => s.order < order).map(s => ({ ...s, score: cosine(vector(s.text), vector(targetText(messages, order))) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const chosen = ranked.slice(0, topK);
    // One chronological neighbour protects terse replies without language rules.
    const adjacent = ranked.find(s => s.order === order - 1);
    if (adjacent && !chosen.some(s => s.id === adjacent.id)) chosen.push(adjacent);
    return chosen.map(earlier => ({ id: `${earlier.id}->${later.id}`, earlier, later, laterOrder: order }));
  });
}

export function pairState(messages, pair) {
  return {
    earlier_assertion: pair.earlier.text,
    earlier_role: pair.earlier.role,
    earlier_context: messages[pair.earlier.order].text.slice(0, 2500),
    later_message: pair.later.text,
    later_role: pair.later.role,
    preceding_context: JSON.stringify(messages.slice(Math.max(0, pair.laterOrder - 2), pair.laterOrder).map(m => ({ role: m.role, text: m.text.slice(-1200) }))),
  };
}

export function effectiveRelation(first, second) {
  if (!['requested', 'reported', 'unchanged', 'uncertain'].includes(first)) throw new Error('Invalid relation');
  if (!positive(first)) return first;
  if (!['changed', 'not_changed', 'unclear'].includes(second)) throw new Error('Missing/invalid gate');
  if (second === 'changed') return first;
  return second === 'not_changed' ? 'unchanged' : 'uncertain';
}

export function matchesEvidence(pair, annotation) {
  return pair.earlier.entryId === annotation.earlierId && pair.later.id === annotation.laterId && pair.earlier.text.includes(annotation.evidence);
}

export function scoreRelations(expected, pairs, outputs) {
  const details = expected.map(e => {
    const matching = pairs.filter(p => matchesEvidence(p, e));
    const values = matching.map(p => outputs[p.id]?.effective).filter(Boolean);
    return { ...e, retrieved: matching.length > 0, matched: values.includes(e.relation), values };
  });
  const positives = details.filter(e => positive(e.relation));
  const negatives = details.filter(e => !positive(e.relation));
  const correct = details.filter(e => e.matched).length;
  return {
    annotated: details.length, correct,
    candidateRecall: { found: positives.filter(e => e.retrieved).length, total: positives.length },
    classified: { correct: details.filter(e => e.retrieved && e.matched).length, total: details.filter(e => e.retrieved).length },
    falseReplacements: { count: negatives.filter(e => e.values.some(positive)).length, evaluated: negatives.filter(e => e.retrieved).length, total: negatives.length },
    // Sparse annotations must not turn unreviewed accepted edges into 'true positives'.
    unannotatedAccepted: pairs.filter(p => positive(outputs[p.id]?.effective) && !expected.some(e => matchesEvidence(p, e))).map(p => p.id),
    details,
  };
}

/** Assertion-local overlay; never marks the whole multi-topic message obsolete. */
export function view(span, pairs, outputs, { asOf = Infinity, historical = false } = {}) {
  const result = { decisionId: span.entryId, reportedId: span.role === 'assistant' ? span.entryId : null, status: 'source', history: [span.entryId] };
  if (historical) return result;
  let hasRequest = false;
  for (const p of pairs.filter(p => p.earlier.id === span.id && p.laterOrder <= asOf).sort((a, b) => a.laterOrder - b.laterOrder)) {
    const r = outputs[p.id]?.effective;
    if (!r || r === 'unchanged') continue;
    result.history.push(p.later.id);
    result.status = r;
    if (!positive(r)) continue;
    if (r === 'requested') {
      result.decisionId = p.later.id;
      hasRequest = true;
    } else {
      result.reportedId = p.later.id;
      if (!hasRequest) result.decisionId = p.later.id;
    }
  }
  return result;
}

export function rankQuery(query, messages, units, pairs, outputs, queryVector, vector) {
  const asOf = query.asOfId ? messages.findIndex(m => m.id === query.asOfId) : Infinity;
  const ranked = units.filter(s => s.order <= asOf).map(s => ({ ...s, score: cosine(queryVector, vector(s.text)) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const cards = ranked.slice(0, 3).map(s => ({ span: s, ...view(s, pairs, outputs, { asOf, historical: query.historical }) }));
  return { rawTop3: ranked.slice(0, 3), cards, rawHit1: ranked[0]?.entryId === query.decisionId,
    decisionHit1: cards[0]?.decisionId === query.decisionId, reportedHit1: cards[0]?.reportedId === query.reportedId };
}
