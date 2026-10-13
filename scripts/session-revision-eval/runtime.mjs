import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hash } from './core.mjs';
import { VERSION } from './prompts.mjs';

export async function save(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/** Serial, successful-response cache. Errors/missing replay data are never semantic negatives. */
export class ResponseCache {
  constructor(directory, { live = false, maxCalls = 0 } = {}) {
    this.directory = directory;
    this.live = live;
    this.maxCalls = maxCalls;
    this.calls = 0;
    this.hits = 0;
  }
  async get(kind, payload, invoke, valid) {
    const path = join(this.directory, `${hash([VERSION, kind, payload])}.json`);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (!valid(saved)) throw new Error('Invalid cached response');
      this.hits++;
      return saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!this.live) throw new Error(`Replay cache miss (${kind}); no request sent`);
    if (this.calls >= this.maxCalls) throw new Error('Call budget exhausted');
    this.calls++;
    const result = await invoke();
    if (!valid(result)) throw new Error(`Invalid provider response (${kind})`);
    await mkdir(this.directory, { recursive: true });
    await save(path, result);
    return result;
  }
}

export async function openRuntime({ cacheDir, live, maxCalls, output, signal }) {
  if (live && /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? '')) throw new Error('PI_OFFLINE forbids live requests');
  const cache = new ResponseCache(cacheDir, { live, maxCalls });
  await mkdir(cacheDir, { recursive: true });
  let config, model, apiKey, embed, decide;
  if (live) {
    const [settings, auth, embeddings, jev] = await Promise.all([
      import('../../acp/src/search/semantic-config.ts'), import('../../acp/src/search/config.ts'),
      import('../../external/pi-tools-suite/src/project-search/semantic-commit-provider.ts'), import('../../acp/src/acp/openrouter-jev.ts'),
    ]);
    config = await settings.loadSemanticEmbeddingConfig();
    if (!config || config.provider !== 'openrouter') throw new Error('This authorized pilot requires configured OpenRouter embeddings');
    apiKey = await auth.sharedSearchAuth().key(AbortSignal.any([signal, AbortSignal.timeout(5000)]));
    if (!apiKey) throw new Error('Configured credential unavailable');
    model = jev.OPENROUTER_JEV_MODEL;
    embed = embeddings.embedCommits;
    decide = jev.requestOpenRouterJevChoice;
    await save(join(cacheDir, 'runtime.json'), { config, model });
  } else ({ config, model } = JSON.parse(await readFile(join(cacheDir, 'runtime.json'), 'utf8')));

  const requests = [];
  const originalFetch = globalThis.fetch;
  async function trackedFetch(url, init) {
    const record = { status: null, usage: null, elapsedMs: null };
    const started = Date.now();
    try {
      const response = await originalFetch(url, init);
      record.status = response.status;
      if (response.ok) record.usage = (await response.clone().json()).usage ?? null;
      return response;
    } finally {
      record.elapsedMs = Date.now() - started;
      requests.push(record);
      await save(join(output, 'requests.json'), requests);
    }
  }
  const vectors = new Map();
  const validVector = v => Array.isArray(v) && v.length === config.dimension && v.every(Number.isFinite) && v.some(x => x !== 0);
  return {
    cache, config, model, requests,
    async embedInputs(texts, kind = 'document') {
      const prefix = kind === 'query' ? config.queryPrefix : config.documentPrefix;
      const unique = [...new Set(texts)];
      // Single-input cache keys preserve reuse when batching/corpus membership changes.
      const missing = [];
      for (const text of unique) {
        const payload = { config, input: prefix + text };
        const path = join(cacheDir, `${hash([VERSION, 'vector', payload])}.json`);
        try {
          const v = JSON.parse(await readFile(path, 'utf8'));
          if (!validVector(v)) throw new Error('Invalid cached vector');
          vectors.set(`${kind}\0${text}`, v); cache.hits++;
        } catch (error) { if (error.code !== 'ENOENT') throw error; missing.push({ text, payload, path }); }
      }
      if (missing.length && !live) throw new Error('Replay vector cache miss; no request sent');
      for (let i = 0; i < missing.length; i += 16) {
        signal.throwIfAborted();
        if (cache.calls >= maxCalls) throw new Error('Call budget exhausted');
        const batch = missing.slice(i, i + 16);
        if (batch.some(x => x.payload.input.length > 8192)) throw new Error('Oversized embedding input; no silent truncation');
        cache.calls++;
        let values;
        // Standalone serial CLI only; never installed into the application runtime.
        globalThis.fetch = trackedFetch;
        try { values = await embed(batch.map(x => x.payload.input), config, apiKey, signal); }
        finally { globalThis.fetch = originalFetch; }
        if (values.length !== batch.length || !values.every(validVector)) throw new Error('Invalid vector batch');
        for (let j = 0; j < batch.length; j++) {
          await save(batch[j].path, values[j]);
          vectors.set(`${kind}\0${batch[j].text}`, values[j]);
        }
      }
    },
    vector(text, kind = 'document') {
      const result = vectors.get(`${kind}\0${text}`);
      if (!result) throw new Error('Missing prepared vector');
      return result;
    },
    async choose(question, prompt, state, branchHash) {
      signal.throwIfAborted();
      const payload = { model, question, ...prompt, state, branchHash };
      return cache.get('choice', payload, () => decide({ model, apiKey, question, ...prompt, state,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), fetch: trackedFetch }),
      value => typeof value === 'string' && Object.hasOwn(prompt.criteria, value));
    },
  };
}
