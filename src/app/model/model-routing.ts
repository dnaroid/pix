import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelRoutingConfig, ModelRoutingTier } from "../../config.js";
import { parseModelRef } from "./model-ref.js";
import type { SessionModel } from "../types.js";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_TOKENS = 96;
const ROUTER_INPUT_MAX_CHARS = 24_000;
const ROUTER_TOOL_NAME = "select_task_tier";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export const AUTO_MODEL_REF = "pix:auto";

export type ModelRoutingDecision = {
  tier: ModelRoutingTier;
  routerModelRef?: string;
  fallback: boolean;
};

export type ModelRoutingDependencies = {
  fetch?: typeof globalThis.fetch;
};

export async function routeModelForPrompt(
  modelRuntime: ModelRuntime,
  config: ModelRoutingConfig,
  prompt: string,
  attachmentCount = 0,
  signal?: AbortSignal,
  dependencies: ModelRoutingDependencies = {},
): Promise<ModelRoutingDecision> {
  const fallbackTier = routingDefaultTier(config);
  if (!config.enabled || config.tiers.length === 0) return { tier: fallbackTier, fallback: true };

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)])
    : AbortSignal.timeout(ROUTER_TIMEOUT_MS);
  const refs = [...new Set([config.modelRef, ...config.fallbackModels].map((ref) => ref.trim()).filter(Boolean))];
  let refreshed = false;

  for (const modelRef of refs) {
    if (requestSignal.aborted) break;
    let parsed: ReturnType<typeof parseModelRef>;
    try { parsed = parseModelRef(modelRef); } catch { continue; }
    if (isOpenRouterJev(parsed.provider, parsed.modelId)) {
      try {
        const tierId = await requestOpenRouterJevDecision(
          modelRuntime,
          parsed.modelId,
          config,
          prompt,
          attachmentCount,
          requestSignal,
          dependencies.fetch ?? globalThis.fetch,
        );
        const tier = config.tiers.find((candidate) => candidate.id === tierId);
        if (tier) return { tier, routerModelRef: modelRef, fallback: false };
      } catch {
        if (requestSignal.aborted) break;
      }
      continue;
    }
    let model = modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined;
    model ??= dynamicOpenRouterAliasModel(modelRuntime, parsed.provider, parsed.modelId);
    if (!model && !refreshed) {
      try {
        await modelRuntime.refresh({
          allowNetwork: true,
          providers: [parsed.provider],
          force: true,
          signal: requestSignal,
        });
      } catch { /* try local/fallback models */ }
      refreshed = true;
      model = modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined;
      model ??= dynamicOpenRouterAliasModel(modelRuntime, parsed.provider, parsed.modelId);
    }
    if (!model) continue;

    try {
      const tierId = await requestTier(modelRuntime, model, config, prompt, attachmentCount, requestSignal);
      const tier = config.tiers.find((candidate) => candidate.id === tierId);
      if (tier) return { tier, routerModelRef: modelRef, fallback: false };
    } catch {
      if (requestSignal.aborted) break;
    }
  }

  return { tier: fallbackTier, fallback: true };
}

function isOpenRouterJev(provider: string, modelId: string): boolean {
  return provider === "openrouter" && /^~?typesafe\/jev(?:-|$)/u.test(modelId);
}

async function requestOpenRouterJevDecision(
  modelRuntime: ModelRuntime,
  modelId: string,
  config: ModelRoutingConfig,
  prompt: string,
  attachmentCount: number,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<string | undefined> {
  const auth = await modelRuntime.getAuth("openrouter", { signal });
  const apiKey = auth?.auth.apiKey?.trim();
  if (!apiKey) throw new Error("OpenRouter authentication is unavailable");
  const response = await fetchImpl(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    signal,
    headers: {
      ...normalizeHeaders(auth?.auth.headers),
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      state: {
        request: prompt.trim().slice(0, ROUTER_INPUT_MAX_CHARS),
        attachment_count: Math.max(0, Math.floor(attachmentCount)),
      },
      questions: {
        tier: {
          type: "choice",
          instructions: "Choose exactly one semantic task-complexity tier for this coding-agent request based on scope, ambiguity, risk, and reasoning depth.",
          criteria: Object.fromEntries(config.tiers.map((tier) => [tier.id, tier.description])),
        },
      },
    }),
  });
  if (!response.ok) {
    const details = (await response.text().catch(() => "")).trim().slice(0, 500);
    throw new Error(`OpenRouter Decisions request failed (${response.status})${details ? `: ${details}` : ""}`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.tier)) return undefined;
  const choice = payload.answers.tier.choice;
  if (typeof choice !== "string") return undefined;
  const normalized = choice.trim().toLowerCase();
  return config.tiers.some((tier) => tier.id === normalized) ? normalized : undefined;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!isRecord(headers)) return {};
  return Object.fromEntries(
    Object.entries(headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []),
  );
}

function dynamicOpenRouterAliasModel(
  modelRuntime: ModelRuntime,
  provider: string,
  modelId: string,
): SessionModel | undefined {
  if (provider !== "openrouter" || !modelId.startsWith("~")) return undefined;
  const template = modelRuntime.getModel("openrouter", "openai/gpt-4o-mini")
    ?? modelRuntime.getModels("openrouter").find((candidate) => candidate.api === "openai-completions");
  if (!template) return undefined;
  return {
    ...template,
    id: modelId,
    name: modelId,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: Math.min(Math.max(template.maxTokens, ROUTER_MAX_TOKENS), 4_096),
  } as unknown as SessionModel;
}

export function routingDefaultTier(config: ModelRoutingConfig): ModelRoutingTier {
  return config.tiers.find((tier) => tier.id === config.defaultTier)
    ?? config.tiers[0]
    ?? {
			id: "standard",
			description: "Default task tier.",
			modelRef: "openrouter/~openai/gpt-terra-latest",
			thinking: "medium",
		};
}

export function buildModelRoutingPrompt(
  config: ModelRoutingConfig,
  prompt: string,
  attachmentCount = 0,
): string {
  const tiers = config.tiers.map((tier) => `- ${tier.id}: ${tier.description}`).join("\n");
  const clippedPrompt = prompt.trim().slice(0, ROUTER_INPUT_MAX_CHARS);
  return [
    "Choose exactly one semantic task tier for a coding-agent request.",
    "Choose based on task complexity, ambiguity, scope, risk, and reasoning depth—not on model names.",
    `Use the ${ROUTER_TOOL_NAME} tool when available. Otherwise return only JSON in the form {"tier":"<id>"}.`,
    "Do not explain the choice.",
    "",
    "Tiers:",
    tiers,
    "",
    `Attachments: ${Math.max(0, Math.floor(attachmentCount))}`,
    "Task:",
    "<task>",
    clippedPrompt,
    "</task>",
  ].join("\n");
}

export function parseModelRoutingTierId(output: string, config: ModelRoutingConfig): string | undefined {
  const valid = new Set(config.tiers.map((tier) => tier.id));
  let text = output.replace(/\r\n/gu, "\n").trim();
  const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text) as unknown;
    const candidate = typeof parsed === "string"
      ? parsed
      : isRecord(parsed)
        ? [parsed.tier, parsed.choice, parsed.decision, parsed.id].find((value): value is string => typeof value === "string")
        : undefined;
    const normalized = candidate?.trim().toLowerCase();
    if (normalized && valid.has(normalized)) return normalized;
  } catch {
    // Generic chat-model fallbacks may emit a bare id rather than JSON.
  }

  const normalized = text.replace(/^["']|["']$/gu, "").trim().toLowerCase();
  if (valid.has(normalized)) return normalized;
  const match = /"(?:tier|choice|decision|id)"\s*:\s*"([^"]+)"/iu.exec(text);
  const fromObjectText = match?.[1]?.trim().toLowerCase();
  return fromObjectText && valid.has(fromObjectText) ? fromObjectText : undefined;
}

async function requestTier(
  modelRuntime: ModelRuntime,
  model: SessionModel,
  config: ModelRoutingConfig,
  prompt: string,
  attachmentCount: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  const maxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, ROUTER_MAX_TOKENS) : ROUTER_MAX_TOKENS;
  let output = "";
  let toolTier: string | undefined;
  let streamError: string | undefined;
  const stream = modelRuntime.streamSimple(
    { ...model, maxTokens },
    {
      systemPrompt: "You are a deterministic task-complexity router.",
      messages: [{ role: "user", content: buildModelRoutingPrompt(config, prompt, attachmentCount), timestamp: Date.now() }],
      tools: [routingTool(config)],
    },
    {
      signal,
      cacheRetention: "none",
      maxRetryDelayMs: 0,
      maxRetries: 0,
      maxTokens,
      timeoutMs: ROUTER_TIMEOUT_MS,
    },
  );
  for await (const event of stream) {
    if (event.type === "text_delta") output += event.delta;
    else if (event.type === "toolcall_end" && event.toolCall.name === ROUTER_TOOL_NAME) {
      const candidate = event.toolCall.arguments.tier;
      if (typeof candidate === "string") toolTier = candidate.trim().toLowerCase();
    }
    else if (event.type === "done" && !output) output = assistantText(event.message);
    else if (event.type === "error") streamError = event.error.errorMessage ?? event.reason;
  }
  if (streamError) throw new Error(streamError);
  if (toolTier && config.tiers.some((tier) => tier.id === toolTier)) return toolTier;
  return parseModelRoutingTierId(output, config);
}

function routingTool(config: ModelRoutingConfig) {
  return {
    name: ROUTER_TOOL_NAME,
    description: "Select exactly one configured semantic task-complexity tier.",
    parameters: {
      type: "object",
      properties: {
        tier: {
          type: "string",
          enum: config.tiers.map((tier) => tier.id),
          description: "The selected semantic task tier id.",
        },
      },
      required: ["tier"],
      additionalProperties: false,
    } as never,
  };
}

function assistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => (
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
  )).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
