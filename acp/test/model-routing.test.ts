import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MODEL_ROUTING,
  defaultRoutingDecision,
  modelRoutingConfigFromParsed,
  parseRoutingTier,
  routeModelWithRuntime,
} from "../src/acp/model-routing.js";

describe("Desktop model routing config", () => {
  it("is disabled by default and uses OpenRouter Jev Latest as the router", () => {
    assert.equal(DEFAULT_MODEL_ROUTING.enabled, false);
    assert.equal(DEFAULT_MODEL_ROUTING.modelRef, "openrouter/~typesafe/jev-latest");
    assert.equal(DEFAULT_MODEL_ROUTING.defaultTier, "standard");
    assert.deepEqual(DEFAULT_MODEL_ROUTING.tiers.map((tier) => [tier.id, tier.thinking]), [
      ["simple", "minimal"],
      ["standard", "medium"],
      ["complex", "high"],
      ["expert", "xhigh"],
    ]);
    assert.deepEqual(DEFAULT_MODEL_ROUTING.tiers.map((tier) => tier.modelRef), [
      "openrouter/~openai/gpt-luna-latest",
      "openrouter/~openai/gpt-terra-latest",
      "openrouter/~openai/gpt-sol-latest",
      "openrouter/~openai/gpt-astra-latest",
    ]);
  });

  it("merges partial profile config without losing semantic tiers", () => {
    const parsed = modelRoutingConfigFromParsed({
      modelRouting: {
        enabled: true,
        fallbackModels: ["router/fallback", "router/fallback"],
        defaultTier: "complex",
      },
    }, DEFAULT_MODEL_ROUTING);
    assert.equal(parsed.enabled, true);
    assert.equal(parsed.modelRef, "openrouter/~typesafe/jev-latest");
    assert.deepEqual(parsed.fallbackModels, ["router/fallback"]);
    assert.equal(parsed.defaultTier, "complex");
    assert.equal(parsed.tiers.length, 4);
  });

  it("parses router choices and falls back deterministically", () => {
    assert.equal(parseRoutingTier('{"tier":"complex"}', DEFAULT_MODEL_ROUTING), "complex");
    assert.equal(parseRoutingTier('```json\n{"choice":"simple"}\n```', DEFAULT_MODEL_ROUTING), "simple");
    assert.equal(parseRoutingTier("expert", DEFAULT_MODEL_ROUTING), "expert");
    assert.equal(parseRoutingTier('{"tier":"missing"}', DEFAULT_MODEL_ROUTING), undefined);
    const fallback = defaultRoutingDecision(DEFAULT_MODEL_ROUTING);
    assert.equal(fallback.tierId, "standard");
    assert.equal(fallback.thinkingLevel, "medium");
    assert.equal(fallback.fallback, true);
  });

  it("uses OpenRouter Decisions API for Jev and returns the selected semantic tier", async () => {
    let requestUrl = "";
    let streamed = false;
    const runtime = {
      getAuth: async (provider: string) => provider === "openrouter"
        ? { auth: { apiKey: "or-test-key" } }
        : undefined,
      streamSimple: () => {
        streamed = true;
        throw new Error("Jev must not use chat completions");
      },
    } as never;
    const decision = await routeModelWithRuntime(
      runtime,
      { ...DEFAULT_MODEL_ROUTING, enabled: true },
      "Refactor the session architecture",
      1,
      undefined,
      {
        fetch: async (input, init) => {
          requestUrl = String(input);
          const body = JSON.parse(String(init?.body)) as {
            model?: string;
            questions?: { tier?: { criteria?: Record<string, string> } };
          };
          assert.equal(body.model, "~typesafe/jev-latest");
          assert.deepEqual(Object.keys(body.questions?.tier?.criteria ?? {}), ["simple", "standard", "complex", "expert"]);
          return new Response(JSON.stringify({
            answers: { tier: { type: "choice", choice: "expert", confidence: 0.98 } },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );

    assert.equal(requestUrl, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(streamed, false);
    assert.equal(decision.tierId, "expert");
    assert.equal(decision.modelRef, "openrouter/~openai/gpt-astra-latest");
    assert.equal(decision.thinkingLevel, "xhigh");
    assert.equal(decision.fallback, false);
  });
});
