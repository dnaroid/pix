import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { KnowledgeCheckService } from "../src/knowledge/service.js";
import { parseKnowledgeCheckRequest } from "../src/knowledge/request.js";
import { isKnowledgeCheckResult, MAX_KNOWLEDGE_DOCUMENT_CHARS, type KnowledgeCheckCoverage } from "../src/knowledge/contract.js";
import type { KnowledgeSnapshot, KnowledgeSearch } from "../src/knowledge/evidence.js";
import { KnowledgeReportError } from "../src/knowledge/report-language.js";

const request = { cwd: "/project", path: "wiki/draft.md", content: "Requests allow ten attempts." };
const snapshot = (): KnowledgeSnapshot => ({
  document: { path: request.path, text: request.content }, documentHash: "a".repeat(64), wikiPath: "wiki",
  evidence: [{ id: "one", path: "wiki/limits.md", text: "Requests allow five attempts.", startLine: 4 }],
  complete: true, notices: [], current: async () => true,
});
const signal = () => new AbortController().signal;
const search: KnowledgeSearch = async () => { throw new Error("Injected collector owns retrieval"); };
const conflict = JSON.stringify({ conflicts: [{ sourceId: "one", draftQuote: request.content,
  existingQuote: "Requests allow five attempts.", explanation: "The same operation has incompatible attempt limits." }], uncertainties: [] });
const clean = JSON.stringify({ conflicts: [], uncertainties: [] });
const coverage: KnowledgeCheckCoverage = { scope: "retrieved-passages", checkedPassages: 1,
  candidateSources: 24, excerptedSources: 1,
  limits: ["query-sampling", "candidate-limit", "source-limit", "passage-limit", "context-limit"] };

function runtime(text: string, dispose: () => void = () => {}, onCall?: (context: unknown, options: unknown) => void) {
  return {
    dispose,
    modelRuntime: {
      getModel: () => ({ provider: "test", id: "model", maxTokens: 9000, reasoning: true }),
      completeSimple: async (_model: unknown, context: unknown, options: unknown) => {
        onCall?.(context, options);
        return { stopReason: "stop", content: [{ type: "text", text }] };
      },
    } as unknown as ModelRuntime,
  };
}

function service(text = conflict, changes: Partial<ConstructorParameters<typeof KnowledgeCheckService>[0]> = {}) {
  return new KnowledgeCheckService({ search, collect: async () => snapshot(),
    loadReportLanguage: async () => "en",
    loadPreferences: async () => ({ modelRef: "test/model", thinking: "low" }),
    createRuntime: async () => runtime(text), ...changes });
}

describe("Wiki request and response contracts", () => {
  it("accepts bounded drafts and rejects paths outside a project", () => {
    assert.deepEqual(parseKnowledgeCheckRequest(request), request);
    for (const value of [null, {}, { ...request, cwd: "relative" }, { ...request, path: "../private.md" },
      { ...request, path: "/private.md" }, { ...request, path: "wiki/../private.md" }, { ...request, path: "wiki/secrets.json" },
      { ...request, content: "x".repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS + 1) }, { ...request, expectedContent: 3 }]) {
      assert.throws(() => parseKnowledgeCheckRequest(value));
    }
  });
  it("rejects invalid IPC results instead of accepting a clean verdict", async () => {
    const result = await service().check(request, signal());
    assert.equal(isKnowledgeCheckResult(result), true);
    assert.equal(isKnowledgeCheckResult({ ...result, status: "clear" }), false);
    assert.equal(isKnowledgeCheckResult({ ...result, conflicts: [{ explanation: "fake" }] }), false);
    assert.equal(isKnowledgeCheckResult({ ...result, checkedSources: -1 }), false);
    assert.equal(isKnowledgeCheckResult({ ...result, coverage }), true);
    assert.equal(isKnowledgeCheckResult({ ...result, reportLanguage: "ru" }), true);
    assert.equal(isKnowledgeCheckResult({ ...result, reportLanguage: undefined }), true);
    for (const reportLanguage of ["", "fr", 1, null]) {
      assert.equal(isKnowledgeCheckResult({ ...result, reportLanguage }), false);
    }
    for (const invalid of [{ ...coverage, scope: "entire-wiki" }, { ...coverage, checkedPassages: -1 },
      { ...coverage, limits: ["unknown"] }, { ...coverage, limits: ["source-limit", "source-limit"] }]) {
      assert.equal(isKnowledgeCheckResult({ ...result, coverage: invalid }), false);
    }
  });

  it("keeps legacy results readable while rejecting malformed or falsely clear uncertainty reports", async () => {
    const result = await service().check(request, signal());
    const uncertainty = { ...result.conflicts[0]!, explanation: "The environment of the source rule is not identified." };
    const uncertain = { ...result, status: "incomplete", conflicts: [], uncertainties: [uncertainty] };
    assert.equal(isKnowledgeCheckResult(uncertain), true);
    assert.equal(isKnowledgeCheckResult({ status: "clear", path: request.path, documentHash: result.documentHash,
      modelRef: result.modelRef, checkedSources: 1, conflicts: [], notices: [] }), true);
    assert.equal(isKnowledgeCheckResult({ ...uncertain, status: "clear" }), false);
    for (const uncertainties of [null, "prose", ["legacy prose belongs in notices"],
      Array.from({ length: 11 }, () => uncertainty), [{ ...uncertainty, explanation: " " }],
      [{ ...uncertainty, explanation: "x".repeat(1001) }], [{ ...uncertainty, draft: null }],
      [{ ...uncertainty, existing: { ...uncertainty.existing, quote: "x".repeat(4001) } }],
      [{ ...uncertainty, existing: { ...uncertainty.existing, startLine: 0 } }],
      [{ ...uncertainty, existing: { ...uncertainty.existing, endLine: 3 } }]]) {
      assert.equal(isKnowledgeCheckResult({ ...uncertain, uncertainties }), false);
    }
  });

  it("bounds the original source inventory independently from the shorter finding quotations", async () => {
    const result = await service(clean).check(request, signal());
    const passage = { path: "wiki/limits.md", quote: "x".repeat(4001), startLine: 4, endLine: 4 };
    assert.equal(isKnowledgeCheckResult({ ...result, reviewedSources: [passage] }), true);
    assert.equal(isKnowledgeCheckResult({ ...result, reviewedSources: [{ ...passage, quote: "x".repeat(48_000) }] }), true);
    for (const reviewedSources of [null, "source", Array.from({ length: 13 }, () => ({ ...passage, quote: "claim" })),
      [{ ...passage, quote: "x".repeat(48_001) }], [{ ...passage, quote: "x".repeat(24_001) }, { ...passage, quote: "x".repeat(24_000) }],
      [{ ...passage, quote: " " }], [{ ...passage, path: "" }], [{ ...passage, path: "x".repeat(4097) }],
      [{ ...passage, startLine: 0 }], [{ ...passage, endLine: 3 }], [{ ...passage, endLine: Number.MAX_SAFE_INTEGER + 1 }]]) {
      assert.equal(isKnowledgeCheckResult({ ...result, reviewedSources }), false);
    }
  });
});

describe("retrieval plus actual model invocation", () => {
  it("fails before retrieval or runtime creation when the dedicated judge is not configured", async () => {
    let collected = 0, created = 0;
    const checker = service(clean, {
      loadReportLanguage: async () => "ru",
      loadPreferences: async () => { throw new KnowledgeReportError("selectModel"); },
      collect: async () => { collected++; return snapshot(); },
      createRuntime: async () => { created++; return runtime(clean); },
    });
    await assert.rejects(checker.check(request, signal()), /knowledgeCheck\.modelRef/u);
    assert.equal(collected, 0);
    assert.equal(created, 0);
  });
  it("uses the judge model and reasoning captured at the start of the check", async () => {
    let loads = 0;
    const handle = runtime(clean, () => {}, (_context, options) => {
      assert.equal((options as { reasoning: string }).reasoning, "high");
    });
    handle.modelRuntime.getModel = (provider, modelId) => {
      assert.equal(provider, "judge"); assert.equal(modelId, "selected");
      return { provider, id: modelId, maxTokens: 8192, reasoning: true } as ReturnType<ModelRuntime["getModel"]>;
    };
    const result = await service(clean, {
      loadPreferences: async () => { loads++; return { modelRef: "judge/selected", thinking: "high" }; },
      collect: async () => { assert.equal(loads, 1); return snapshot(); },
      createRuntime: async () => handle,
    }).check(request, signal());
    assert.equal(result.modelRef, "judge/selected");
    assert.equal(loads, 1);
  });
  it("does not send an explicit reasoning level when the judge is configured off", async () => {
    const result = await service(clean, {
      loadPreferences: async () => ({ modelRef: "test/model", thinking: "off" }),
      createRuntime: async () => runtime(clean, () => {}, (_context, options) => {
        assert.equal(Object.hasOwn(options as object, "reasoning"), false);
      }),
    }).check(request, signal());
    assert.equal(result.status, "clear");
  });
  it("calls the selected model and verifies both original quotations before returning a conflict", async () => {
    let disposed = 0, calls = 0;
    const checker = service(conflict, { createRuntime: async () => runtime(conflict, () => { disposed++; }, (context, options) => {
      calls++;
      assert.match(JSON.stringify(context), /Requests allow five attempts/);
      assert.match(JSON.stringify(context), /Requests allow ten attempts/);
      assert.equal((options as { cacheRetention: string }).cacheRetention, "none");
    }) });
    const result = await checker.check(request, signal());
    assert.equal(result.status, "conflicts");
    assert.equal(result.conflicts[0]!.existing.startLine, 4);
    assert.equal(result.modelRef, "test/model");
    assert.equal(result.documentHash, snapshot().documentHash);
    assert.equal(calls, 1);
    assert.equal(disposed, 1);
  });
  it("returns a clear bounded verdict only after complete retrieval and a valid model answer", async () => {
    assert.equal((await service(clean).check(request, signal())).status, "clear");
  });
  it("returns paired source evidence for material uncertainty without inventing a conflict or plain notice", async () => {
    const uncertainty = { sourceId: "one", draftQuote: request.content, existingQuote: snapshot().evidence[0]!.text,
      explanation: "The source does not name the deployment; the limits conflict only if the environments coincide." };
    const result = await service(JSON.stringify({ conflicts: [], uncertainties: [uncertainty] })).check(request, signal());
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.notices, []);
    assert.deepEqual(result.uncertainties, [{
      draft: { path: request.path, quote: request.content, startLine: 1, endLine: 1 },
      existing: { path: "wiki/limits.md", quote: uncertainty.existingQuote, startLine: 4, endLine: 4 },
      explanation: uncertainty.explanation,
    }]);
    assert.equal(isKnowledgeCheckResult(result), true);
  });
  it("keeps independent established conflicts visible alongside an uncertain pair", async () => {
    const initial = snapshot();
    const first = JSON.parse(conflict).conflicts[0];
    const second = { ...first, sourceId: "two", existingQuote: "This deployment allows two attempts.",
      explanation: "The second source does not identify which deployment it describes." };
    const result = await service(JSON.stringify({ conflicts: [first], uncertainties: [second] }), {
      collect: async () => ({ ...initial, evidence: [...initial.evidence,
        { id: "two", path: "wiki/deployment.md", text: second.existingQuote, startLine: 8 }] }),
    }).check(request, signal());
    assert.equal(result.status, "conflicts");
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.uncertainties?.length, 1);
    assert.equal(isKnowledgeCheckResult(result), true);
  });
  it("returns exact normalized checked passages and line spans without background context", async () => {
    const result = await service(clean, { collect: async () => ({ ...snapshot(), evidence: [{
      id: "one", path: "wiki/limits.md", text: "# Limit\r\nRequests allow five attempts.\r\n", startLine: 4,
      context: "Background-only prose, not a checked passage.",
    }] }) }).check(request, signal());
    assert.equal(result.status, "clear");
    assert.deepEqual(result.reviewedSources, [{ path: "wiki/limits.md",
      quote: "# Limit\nRequests allow five attempts.\n", startLine: 4, endLine: 5 }]);
    assert.equal(isKnowledgeCheckResult(result), true);
  });
  it("cannot report clear when the reviewed original passages exceed report bounds", async () => {
    for (const evidence of [Array.from({ length: 13 }, (_, index) => ({ id: `source-${index}`,
      path: `wiki/source-${index}.md`, text: "A rule.", startLine: 1 })),
      [{ id: "one", path: "wiki/limits.md", text: "x".repeat(48_001), startLine: 1 }]]) {
      const result = await service(clean, { loadReportLanguage: async () => "ru",
        collect: async () => ({ ...snapshot(), evidence }),
      }).check(request, signal());
      assert.equal(result.status, "incomplete");
      assert.deepEqual(result.reviewedSources, []);
      assert.match(result.notices.join(" "), /Не удалось представить проверенные фрагменты источников/u);
      assert.equal(isKnowledgeCheckResult(result), true);
    }
  });
  it("reports ordinary selection limits without invalidating a completed comparison", async () => {
    const warnings: string[] = [];
    const result = await service(clean, { collect: async () => ({ ...snapshot(), coverage }),
      warn: message => { warnings.push(message); },
    }).check(request, signal());
    assert.equal(result.status, "clear");
    assert.deepEqual(result.coverage, coverage);
    assert.deepEqual(result.notices, []);
    assert.deepEqual(warnings, []);
  });
  it("does not let ordinary coverage limits hide a failed retrieval or uncertain model response", async () => {
    const partial = await service(clean, { collect: async () => ({ ...snapshot(), coverage,
      complete: false, notices: ["Search failed"] }),
    }).check(request, signal());
    assert.equal(partial.status, "incomplete");
    assert.deepEqual(partial.notices, ["Search failed"]);
    const uncertain = await service(JSON.stringify({ conflicts: [], uncertainties: ["The scope of the rule is unspecified."] }), {
      collect: async () => ({ ...snapshot(), coverage }),
    }).check(request, signal());
    assert.equal(uncertain.status, "incomplete");
    assert.deepEqual(uncertain.coverage, coverage);
  });
  it("counts unique files separately from evidence passages", async () => {
    const initial = snapshot();
    const result = await service(clean, { collect: async () => ({ ...initial,
      evidence: [...initial.evidence, { id: "two", path: "wiki/limits.md", text: "Retries use a fixed interval.", startLine: 12 }],
    }) }).check(request, signal());
    assert.equal(result.checkedSources, 1);
    assert.equal(result.coverage?.checkedPassages, 2);
    assert.deepEqual(result.reviewedSources?.map(source => [source.path, source.startLine]),
      [["wiki/limits.md", 4], ["wiki/limits.md", 12]]);
  });
  it("keeps retrieval degradation and invalid model output incomplete", async () => {
    const partial = service(clean, { collect: async () => ({ ...snapshot(), complete: false, notices: ["Semantic search unavailable"] }) });
    const result = await partial.check(request, signal());
    assert.equal(result.status, "incomplete");
    assert.match(result.notices.join(" "), /Semantic/);
    assert.equal((await service("invalid JSON").check(request, signal())).status, "incomplete");
  });
  it("preserves grounded conflicts alongside notices from partial retrieval", async () => {
    const result = await service(conflict, { collect: async () => ({ ...snapshot(), complete: false, notices: ["Search partial"] }) }).check(request, signal());
    assert.equal(result.status, "conflicts");
    assert.deepEqual(result.notices, ["Search partial"]);
  });
  it("checks the draft internally without claiming cross-document success when retrieval found no sources", async () => {
    let created = false;
    const result = await service(clean, { collect: async () => ({ ...snapshot(), evidence: [] }),
      createRuntime: async () => { created = true; return runtime(clean); },
    }).check(request, signal());
    assert.equal(result.status, "incomplete");
    assert.equal(created, true);
    assert.match(result.notices.join(" "), /only contradictions within this draft/);
  });
  it("can find an internal contradiction in the first Wiki page", async () => {
    const content = "Retries are required.\nRetries are forbidden.";
    const text = JSON.stringify({ conflicts: [{ sourceId: "draft", draftQuote: "Retries are required.",
      existingQuote: "Retries are forbidden.", explanation: "The draft both requires and forbids retries in the same scope." }], uncertainties: [] });
    const result = await service(text, { collect: async () => ({ ...snapshot(),
      document: { path: request.path, text: content }, evidence: [], complete: false,
    }) }).check({ ...request, content }, signal());
    assert.equal(result.status, "conflicts");
    assert.equal(result.checkedSources, 0);
    assert.equal(result.conflicts[0]!.existing.path, request.path);
    assert.equal(result.conflicts[0]!.existing.startLine, 2);
  });
  it("discards findings when a source changes during generation", async () => {
    const result = await service(conflict, { collect: async () => ({ ...snapshot(), current: async () => false }) }).check(request, signal());
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.uncertainties, []);
    assert.deepEqual(result.reviewedSources, []);
    assert.match(result.notices.join(" "), /changed during the check/);
  });
  it("disposes the model runtime on invalid output and provider errors", async () => {
    let disposed = 0;
    await service("bad", { createRuntime: async () => runtime("bad", () => { disposed++; }) }).check(request, signal());
    assert.equal(disposed, 1);
    const handle = runtime(clean, () => { disposed++; });
    handle.modelRuntime.completeSimple = async () => { throw new Error("Provider unavailable"); };
    await assert.rejects(service(clean, { createRuntime: async () => handle }).check(request, signal()), /Provider unavailable/);
    assert.equal(disposed, 2);
  });
});

describe("Wiki check ownership and cancellation", () => {
  it("cancels a pending language read before starting retrieval", async () => {
    let release!: (language: "ru") => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const language = new Promise<"ru">(resolve => { release = resolve; });
    let collected = false;
    const controller = new AbortController();
    const pending = service(clean, { loadReportLanguage: () => { entered(); return language; },
      collect: async () => { collected = true; return snapshot(); },
    }).check(request, controller.signal);
    await ready;
    controller.abort(new Error("Project changed"));
    await assert.rejects(pending, /Project changed/);
    release("ru");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(collected, false);
  });
  it("cancels even a non-cooperative provider and releases its runtime", async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let disposed = 0;
    const handle = runtime(clean, () => { disposed++; });
    handle.modelRuntime.completeSimple = () => { started(); return new Promise(() => {}); };
    const controller = new AbortController();
    const pending = service(clean, { createRuntime: async () => handle }).check(request, controller.signal);
    await ready;
    controller.abort(new Error("Stopped by user"));
    await assert.rejects(pending, /Stopped by user/);
    assert.equal(disposed, 1);
  });
  it("disposes a runtime acquired after cancellation without invoking the model", async () => {
    let acquire!: (value: ReturnType<typeof runtime>) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const acquisition = new Promise<ReturnType<typeof runtime>>(resolve => { acquire = resolve; });
    let disposed = 0, called = 0;
    const controller = new AbortController();
    const pending = service(clean, { createRuntime: () => { entered(); return acquisition; } }).check(request, controller.signal);
    await ready;
    controller.abort(new Error("Project changed"));
    await assert.rejects(pending, /Project changed/);
    acquire(runtime(clean, () => { disposed++; }, () => { called++; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, 1);
    assert.equal(called, 0);
  });
});

describe("Wiki report language", () => {
  it("snapshots the preference once and passes it to retrieval, model and result", async () => {
    let reads = 0, collections = 0;
    const explanation = "Для одной операции установлены несовместимые ограничения числа попыток.";
    const answer = JSON.stringify({ conflicts: [{ sourceId: "one", draftQuote: request.content,
      existingQuote: "Requests allow five attempts.", explanation }], uncertainties: [] });
    const checker = service(answer, {
      loadReportLanguage: async () => { reads++; return reads === 1 ? "ru" : "en"; },
      collect: async (_request, _search, _signal, language) => {
        assert.equal(language, ++collections === 1 ? "ru" : "en");
        return snapshot();
      },
      createRuntime: async () => runtime(answer, () => {}, context => {
        assert.match((context as { systemPrompt: string }).systemPrompt,
          reads === 1 ? /Report language: Russian \(ru\)/u : /Report language: English \(en\)/u);
      }),
    });
    const russian = await checker.check(request, signal());
    assert.equal(reads, 1);
    assert.equal(russian.reportLanguage, "ru");
    assert.equal(russian.status, "conflicts");
    assert.equal(russian.conflicts[0]!.draft.quote, request.content);
    assert.equal(russian.conflicts[0]!.explanation, explanation);
    assert.equal((await checker.check(request, signal())).reportLanguage, "en");
    assert.equal(reads, 2);
  });

  it("localizes no-evidence and stale-result notices without dropping native or model notices", async () => {
    const native = "Native search diagnostic: snapshot unavailable.";
    const uncertainty = "Не указано окружение, к которому относится правило.";
    const noSources = await service(JSON.stringify({ conflicts: [], uncertainties: [uncertainty] }), {
      loadReportLanguage: async () => "ru",
      collect: async () => ({ ...snapshot(), evidence: [], notices: [native] }),
    }).check(request, signal());
    assert.equal(noSources.status, "incomplete");
    assert.equal(noSources.reportLanguage, "ru");
    assert.deepEqual(noSources.notices, [native,
      "Связанные фрагменты Wiki недоступны; проверены только противоречия внутри этого черновика.", uncertainty]);
    const stale = await service(conflict, { loadReportLanguage: async () => "ru",
      collect: async () => ({ ...snapshot(), current: async () => false }),
    }).check(request, signal());
    assert.equal(stale.reportLanguage, "ru");
    assert.equal(stale.status, "incomplete");
    assert.deepEqual(stale.conflicts, []);
    assert.deepEqual(stale.notices, ["Документ, настройки или содержимое Wiki изменились во время проверки. Повторите её."]);
  });

  it("localizes typed source validation failures without rewriting arbitrary errors", async () => {
    await assert.rejects(service(clean, { loadReportLanguage: async () => "ru",
      collect: async () => { throw new KnowledgeReportError("documentChanged"); },
    }).check(request, signal()), /Документ изменился на диске/u);
    await assert.rejects(service(clean, { loadReportLanguage: async () => "ru",
      collect: async () => { throw new Error("Unrecognized native diagnostic"); },
    }).check(request, signal()), /Unrecognized native diagnostic/u);
  });
});
