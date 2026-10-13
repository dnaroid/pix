import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { candidates, cosine, effectiveRelation, hash, matchesEvidence, pairState, rankQuery, scoreRelations, spans, targetText, validateCorpus, view } from './core.mjs';
import { ResponseCache } from './runtime.mjs';

const messages = [
  { id: 'old', role: 'assistant', text: 'The room is blue. The chairs are wooden.' },
  { id: 'distractor', role: 'user', text: 'What time is lunch?' },
  { id: 'request', role: 'user', text: 'Paint the room green.' },
  { id: 'done', role: 'assistant', text: 'The room is now green.' },
];
const units = spans(messages);
const vector = text => /room|green|blue/.test(text) ? [1, 0] : [0, 1];
const pairs = candidates(messages, units, vector);
const old = units[0];
const req = pairs.find(p => p.earlier.id === old.id && p.later.id === 'request');
const done = pairs.find(p => p.earlier.id === old.id && p.later.id === 'done');
const outputs = { [req.id]: { effective: 'requested' }, [done.id]: { effective: 'reported' } };

test('source spans round-trip exact offsets across languages and repeated text', () => {
  const rows = [{ id: 'm', role: 'user', text: '  Привет! Привет!\n日本語の文。次の文。\n' + 'x'.repeat(1300) }];
  const result = spans(rows);
  assert.ok(result.length >= 5);
  assert.equal(new Set(result.map(s => s.id)).size, result.length);
  for (const s of result) { assert.equal(rows[0].text.slice(s.start, s.end), s.text); assert.ok(s.text.length <= 600); }
  assert.equal(result.map(s => s.text).join('').replace(/\s/gu, ''), rows[0].text.replace(/\s/gu, ''));
});

test('candidate discovery is chronological, bounded and needs no relevance labels', () => {
  assert.ok(pairs.every(p => p.earlier.order < p.laterOrder));
  assert.ok(messages.every(m => pairs.filter(p => p.later.id === m.id).length <= 4));
  assert.ok(req && done);
  assert.ok(pairs.some(p => p.earlier.entryId === 'distractor' && p.later.id === 'request'));
});

test('later candidate discovery is independent of query top-k', () => {
  const result = rankQuery({ text: 'color' }, messages, units, pairs, outputs, [1, 0], vector);
  assert.ok(result.cards.some(c => c.span.id === old.id && c.reportedId === 'done'));
});

test('short targets carry bounded previous context without losing the target', () => {
  const text = targetText(messages, 2);
  assert.ok(text.includes('What time is lunch?'));
  assert.ok(text.endsWith('Target (user): Paint the room green.'));
  const state = pairState(messages, req);
  assert.ok(Object.values(state).every(v => typeof v === 'string'));
  assert.equal(state.earlier_assertion, 'The room is blue.');
});

test('positive replacement requires a successful changed-value gate', () => {
  assert.equal(effectiveRelation('reported', 'not_changed'), 'unchanged');
  assert.equal(effectiveRelation('requested', 'unclear'), 'uncertain');
  assert.equal(effectiveRelation('requested', 'changed'), 'requested');
  assert.throws(() => effectiveRelation('reported', undefined));
  assert.throws(() => effectiveRelation('bogus', null));
});

test('pending request does not become completion; completed request keeps user decision ID', () => {
  assert.deepEqual(view(old, pairs, outputs, { asOf: 2 }), { decisionId: 'request', reportedId: 'old', status: 'requested', history: ['old', 'request'] });
  assert.equal(view(old, pairs, outputs).reportedId, 'done');
  assert.equal(view(old, pairs, outputs).decisionId, 'request');
});

test('historical view and unrelated assertion remain untouched', () => {
  assert.equal(view(old, pairs, outputs, { historical: true }).decisionId, 'old');
  assert.equal(view(units[1], pairs, outputs).decisionId, 'old');
  assert.equal(view(units[1], pairs, outputs).status, 'source');
});

test('uncertainty is visible and does not replace sources', () => {
  const result = view(old, pairs, { [req.id]: { effective: 'uncertain' } });
  assert.equal(result.status, 'uncertain'); assert.equal(result.decisionId, 'old');
});

test('evidence must be in the target span, not another fact or context', () => {
  assert.ok(matchesEvidence(req, { earlierId: 'old', laterId: 'request', evidence: 'The room is blue.' }));
  assert.equal(matchesEvidence(req, { earlierId: 'old', laterId: 'request', evidence: 'The chairs are wooden.' }), false);
});

test('scoring separates missed candidates, false replacements and unannotated acceptances', () => {
  const labels = [
    { earlierId: 'old', laterId: 'request', evidence: 'The room is blue.', relation: 'unchanged' },
    { earlierId: 'absent', laterId: 'done', evidence: 'missing', relation: 'reported' },
  ];
  const score = scoreRelations(labels, pairs, outputs);
  assert.deepEqual(score.candidateRecall, { found: 0, total: 1 });
  assert.deepEqual(score.falseReplacements, { count: 1, evaluated: 1, total: 1 });
  assert.equal(score.unannotatedAccepted.length, 1);
  assert.equal(score.correct, 0);
});

test('branch/content changes invalidate classification identity; labels are not model input', () => {
  assert.notEqual(hash(messages), hash(messages.slice(0, -1)));
  assert.notEqual(hash(messages), hash(messages.map(m => ({ ...m, text: m.text + '!' }))));
  assert.equal('expected' in pairState(messages, req), false);
});

test('invalid vectors fail instead of silently ranking', () => {
  assert.throws(() => cosine([0, 0], [1, 0]));
  assert.throws(() => cosine([1], [1, 2]));
  assert.throws(() => cosine([NaN], [1]));
});

test('frozen fixtures validate, duplicate IDs and invalid evidence fail', async () => {
  const corpus = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
  validateCorpus(corpus);
  assert.throws(() => validateCorpus([corpus[0], corpus[0]]));
  const invalid = structuredClone(corpus);
  invalid[0].expected[0].evidence = 'not in the source';
  assert.throws(() => validateCorpus(invalid));
});

test('cache replays with no calls, changes invalidate, missing/failed responses stay incomplete', async () => {
  const root = fileURLToPath(new URL('../../.pi/artifacts/', import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'session-revision-cache-test-'));
  let calls = 0;
  const invoke = async () => { calls++; return 'requested'; };
  const valid = v => v === 'requested';
  try {
    const live = new ResponseCache(directory, { live: true, maxCalls: 1 });
    assert.equal(await live.get('choice', { branch: 'a' }, invoke, valid), 'requested');
    assert.equal(await live.get('choice', { branch: 'a' }, invoke, valid), 'requested');
    assert.equal(calls, 1);
    await assert.rejects(live.get('choice', { branch: 'b' }, invoke, valid), /budget/);
    const replay = new ResponseCache(directory);
    assert.equal(await replay.get('choice', { branch: 'a' }, invoke, valid), 'requested');
    await assert.rejects(replay.get('choice', { branch: 'b' }, invoke, valid), /cache miss/);
    assert.equal(calls, 1);
    const failing = new ResponseCache(directory, { live: true, maxCalls: 1 });
    await assert.rejects(failing.get('choice', { branch: 'c' }, async () => undefined, valid), /Invalid provider/);
    await assert.rejects(replay.get('choice', { branch: 'c' }, invoke, valid), /cache miss/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
