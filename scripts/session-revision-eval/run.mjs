import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidates, effectiveRelation, hash, pairState, positive, rankQuery, scoreRelations, spans, targetText, validateCorpus } from './core.mjs';
import { gate, relation, VERSION } from './prompts.mjs';
import { openRuntime, save } from './runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const artifacts = join(root, '.pi/artifacts');

function options(args) {
  const result = { corpus: join(here, 'fixtures.json'), live: false, replay: false, maxCalls: 0, topK: 3 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') result.live = true;
    else if (arg === '--replay') result.replay = true;
    else if (['--corpus', '--cache', '--max-calls', '--top-k'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if (arg === '--corpus') result.corpus = resolve(value);
      if (arg === '--cache') result.cacheDir = resolve(value);
      if (arg === '--max-calls') result.maxCalls = Number(value);
      if (arg === '--top-k') result.topK = Number(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (result.live && result.replay) throw new Error('Choose live or replay');
  if (!Number.isInteger(result.maxCalls) || result.maxCalls < 0 || (result.live && !result.maxCalls)) throw new Error('Live requires explicit positive --max-calls');
  if (!Number.isInteger(result.topK) || result.topK < 1 || result.topK > 10) throw new Error('top-k must be 1..10');
  if (result.cacheDir) {
    const child = relative(artifacts, result.cacheDir);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Cache must be inside project .pi/artifacts/');
  }
  if (result.replay && !result.cacheDir) throw new Error('Replay requires --cache');
  return result;
}

async function main() {
  const opts = options(process.argv.slice(2));
  const corpus = JSON.parse(await readFile(opts.corpus, 'utf8'));
  validateCorpus(corpus);
  const units = corpus.map(c => spans(c.messages));
  if (!opts.live && !opts.replay) {
    console.log(JSON.stringify({ mode: 'fixture-validation-only', cases: corpus.length, spans: units.reduce((s, u) => s + u.length, 0), modelQualityMeasured: false }));
    return 0;
  }
  await mkdir(artifacts, { recursive: true });
  const output = await mkdtemp(join(artifacts, 'session-revision-eval-'));
  opts.cacheDir ??= join(output, 'cache');
  const sources = {};
  for (const file of ['core.mjs', 'prompts.mjs', 'runtime.mjs', 'run.mjs']) sources[file] = hash(await readFile(join(here, file), 'utf8'));
  const plan = { version: VERSION, sources, corpusHash: hash(corpus), corpus, prompts: { relation, gate }, opts, node: process.version, icu: process.versions.icu, startedAt: new Date().toISOString() };
  await save(join(output, 'plan.json'), plan);
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const results = [];
  let runtime, failure;
  try {
    runtime = await openRuntime({ ...opts, output, signal: stop.signal });
    await runtime.embedInputs(corpus.flatMap((c, i) => [...units[i].map(s => s.text), ...c.messages.map((_, n) => targetText(c.messages, n))]));
    await runtime.embedInputs(corpus.flatMap(c => (c.queries ?? []).map(q => q.text)), 'query');
    for (let i = 0; i < corpus.length; i++) {
      const item = corpus[i];
      const pairs = candidates(item.messages, units[i], text => runtime.vector(text), opts.topK);
      const outputs = {};
      const result = { id: item.id, split: item.split, pairs, outputs };
      results.push(result);
      for (const pair of pairs) {
        const state = pairState(item.messages, pair);
        const first = await runtime.choose('relation', relation, state, hash(item.messages));
        const second = positive(first) ? await runtime.choose('changed_value', gate, state, hash(item.messages)) : null;
        outputs[pair.id] = { first, gate: second, effective: effectiveRelation(first, second) };
        await save(join(output, 'results.json'), results);
      }
      result.relations = scoreRelations(item.expected ?? [], pairs, outputs);
      result.queries = (item.queries ?? []).map(query => ({ query, ...rankQuery(query, item.messages, units[i], pairs, outputs, runtime.vector(query.text, 'query'), text => runtime.vector(text)) }));
      await save(join(output, 'results.json'), results);
    }
  } catch (error) {
    // Errors from provider transports are deliberately sanitized (never persist URLs/keys).
    failure = stop.signal.aborted ? 'Interrupted' : 'Incomplete: provider, budget, input or replay failure';
    console.error(failure);
  } finally {
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
  const usage = runtime?.requests ?? [];
  const complete = !failure && results.length === corpus.length && results.every(r => r.relations);
  const groups = [...new Set(corpus.map(c => c.split ?? 'unspecified'))].map(split => {
    const group = results.filter(r => (r.split ?? 'unspecified') === split && r.relations);
    const sum = selector => group.reduce((s, r) => s + selector(r), 0);
    return { split, cases: group.length, annotated: sum(r => r.relations.annotated), correct: sum(r => r.relations.correct),
      candidateRecall: [sum(r => r.relations.candidateRecall.found), sum(r => r.relations.candidateRecall.total)],
      classification: [sum(r => r.relations.classified.correct), sum(r => r.relations.classified.total)],
      falseReplacements: [sum(r => r.relations.falseReplacements.count), sum(r => r.relations.falseReplacements.evaluated)],
      unevaluatedNegatives: sum(r => r.relations.falseReplacements.total - r.relations.falseReplacements.evaluated),
      unannotatedAccepted: sum(r => r.relations.unannotatedAccepted.length),
      retrieval: { queries: sum(r => r.queries.length), rawHit1: sum(r => r.queries.filter(q => q.rawHit1).length), decisionHit1: sum(r => r.queries.filter(q => q.decisionHit1).length), reportedHit1: sum(r => r.queries.filter(q => q.reportedHit1).length) } };
  });
  const summary = { complete, failure, groups, calls: runtime?.cache.calls ?? 0, cacheHits: runtime?.cache.hits ?? 0,
    reportedCost: usage.reduce((s, r) => s + (r.usage?.cost ?? 0), 0), costMissing: usage.filter(r => typeof r.usage?.cost !== 'number').length,
    model: runtime?.model, embedding: runtime?.config, corpusHash: plan.corpusHash, sources, cache: relative(root, opts.cacheDir) };
  await save(join(output, 'summary.json'), summary);
  console.log(JSON.stringify({ output: relative(root, output), ...summary }, null, 2));
  if (!complete) return 2;
  return groups.every(g => g.correct === g.annotated && g.retrieval.decisionHit1 === g.retrieval.queries && g.retrieval.reportedHit1 === g.retrieval.queries) ? 0 : 1;
}

main().then(code => { process.exitCode = code; }, () => { console.error('Invalid eval setup; check arguments and corpus. No score produced.'); process.exitCode = 2; });
