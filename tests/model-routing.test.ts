import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRoutingConfig } from "../src/config.js";
import {
  buildModelRoutingPrompt,
  parseModelRoutingTierId,
  routeModelForPrompt,
  routingDefaultTier,
} from "../src/app/model/model-routing.js";

const config: ModelRoutingConfig = {
  enabled: true,
  modelRef: "router/primary",
  fallbackModels: ["router/fallback"],
  defaultTier: "standard",
  tiers: [
    { id: "simple", description: "Small local work.", modelRef: "target/simple", thinking: "minimal" },
    { id: "standard", description: "Normal implementation work.", modelRef: "target/standard", thinking: "medium" },
    { id: "complex", description: "Broad architecture and debugging.", modelRef: "target/complex", thinking: "high" },
  ],
};

describe("model routing", () => {
  it("parses strict JSON, fenced JSON, and bare semantic tier ids", () => {
    assert.equal(parseModelRoutingTierId('{"tier":"complex"}', config), "complex");
    assert.equal(parseModelRoutingTierId('```json\n{"choice":"simple"}\n```', config), "simple");
    assert.equal(parseModelRoutingTierId("standard", config), "standard");
    assert.equal(parseModelRoutingTierId('{"tier":"unknown"}', config), undefined);
  });

  it("builds a semantic router prompt without exposing target model refs", () => {
    const prompt = buildModelRoutingPrompt(config, "Refactor this subsystem", 2);
    assert.match(prompt, /simple: Small local work\./u);
    assert.match(prompt, /complex: Broad architecture and debugging\./u);
    assert.match(prompt, /Attachments: 2/u);
    assert.match(prompt, /Refactor this subsystem/u);
    assert.doesNotMatch(prompt, /target\/complex/u);
  });

  it("uses the configured deterministic fallback tier", () => {
    assert.equal(routingDefaultTier(config).id, "standard");
    assert.equal(routingDefaultTier({ ...config, defaultTier: "missing" }).id, "simple");
  });

  it("falls through router models and returns the chosen target tier", async () => {
    const streamed: string[] = [];
    const fallbackModel = { provider: "router", id: "fallback", maxTokens: 4_096 };
    const runtime = {
      getModel: (provider: string, modelId: string) => provider === "router" && modelId === "fallback" ? fallbackModel : undefined,
      refresh: async () => {},
      streamSimple: (model: { id: string }) => {
        streamed.push(model.id);
        return (async function* () {
          yield { type: "text_delta", delta: '{"tier":"complex"}' };
        })();
      },
    } as never;

    const decision = await routeModelForPrompt(runtime, config, "hard task");
    assert.equal(decision.tier.id, "complex");
    assert.equal(decision.tier.modelRef, "target/complex");
    assert.equal(decision.tier.thinking, "high");
    assert.equal(decision.routerModelRef, "router/fallback");
    assert.equal(decision.fallback, false);
    assert.deepEqual(streamed, ["fallback"]);
  });

  it("accepts a structured task-tier tool decision", async () => {
    let capturedContext: unknown;
    const model = { provider: "router", id: "primary", maxTokens: 4_096 };
    const runtime = {
      getModel: () => model,
      refresh: async () => {},
      streamSimple: (_model: unknown, context: unknown) => {
        capturedContext = context;
        return (async function* () {
          yield {
            type: "toolcall_end",
            toolCall: {
              type: "toolCall",
              id: "route-1",
              name: "select_task_tier",
              arguments: { tier: "simple" },
            },
          };
        })();
      },
    } as never;

    const decision = await routeModelForPrompt(runtime, config, "small task");
    assert.equal(decision.tier.id, "simple");
    assert.equal(decision.fallback, false);
    const tool = (capturedContext as { tools?: Array<{ parameters?: { properties?: { tier?: { enum?: string[] } } } }> })
      .tools?.[0];
    assert.deepEqual(tool?.parameters?.properties?.tier?.enum, ["simple", "standard", "complex"]);
  });

  it("uses OpenRouter Decisions API for Jev instead of chat completions", async () => {
    let streamed = false;
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    let authorization = "";
    const runtime = {
      getAuth: async (provider: string) => provider === "openrouter"
        ? { auth: { apiKey: "or-test-key" } }
        : undefined,
      streamSimple: () => {
        streamed = true;
        throw new Error("Jev must not use chat completions");
      },
    } as never;
    const aliasConfig = {
      ...config,
      modelRef: "openrouter/~typesafe/jev-latest",
      fallbackModels: [],
    };

    const decision = await routeModelForPrompt(
      runtime,
      aliasConfig,
      "normal task",
      2,
      undefined,
      {
        fetch: async (input, init) => {
          requestUrl = String(input);
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify({
            answers: {
              tier: { type: "choice", choice: "complex", confidence: 0.93 },
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    );

    assert.equal(decision.tier.id, "complex");
    assert.equal(decision.routerModelRef, "openrouter/~typesafe/jev-latest");
    assert.equal(streamed, false);
    assert.equal(requestUrl, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(authorization, "Bearer or-test-key");
    assert.equal(requestBody?.model, "~typesafe/jev-latest");
    assert.deepEqual(
      ((requestBody?.questions as Record<string, unknown>)?.tier as Record<string, unknown>)?.criteria,
      {
        simple: "Small local work.",
        standard: "Normal implementation work.",
        complex: "Broad architecture and debugging.",
      },
    );
    assert.doesNotMatch(JSON.stringify(requestBody), /target\/complex/u);
  });

  it("returns the default tier when no router model can be resolved", async () => {
    const runtime = { getModel: () => undefined, refresh: async () => {} } as never;
    const decision = await routeModelForPrompt(runtime, config, "task");
    assert.equal(decision.tier.id, "standard");
    assert.equal(decision.fallback, true);
  });
});
