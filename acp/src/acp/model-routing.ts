import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse as parseJsonc } from "jsonc-parser";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { pixProjectConfigPath, pixUserConfigPath } from "./pix-config-paths.js";
import type { PixThinkingLevel } from "./default-model.js";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_TOKENS = 96;
const ROUTER_TOOL_NAME = "select_task_tier";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export interface ModelRoutingTier {
  readonly id: string;
  readonly description: string;
  readonly modelRef: string;
  readonly thinking: PixThinkingLevel;
}

export interface ModelRoutingConfig {
  readonly enabled: boolean;
  readonly default: boolean;
  readonly modelRef: string;
  readonly fallbackModels: readonly string[];
  readonly defaultTier: string;
  readonly tiers: readonly ModelRoutingTier[];
}

export interface ModelRoutingDecision {
  readonly tierId: string;
  readonly modelRef: string;
  readonly thinkingLevel: PixThinkingLevel;
  readonly routerModelRef?: string;
  readonly fallback: boolean;
}

export interface ModelRoutingDependencies {
  readonly fetch?: typeof globalThis.fetch;
}

export const DEFAULT_MODEL_ROUTING: ModelRoutingConfig = {
  enabled: false,
  default: false,
  modelRef: "openrouter/~typesafe/jev-latest",
  fallbackModels: [],
  defaultTier: "standard",
  tiers: [
    { id: "simple", description: "Simple questions, lookups, explanations, and small localized edits.", modelRef: "openrouter/~openai/gpt-luna-latest", thinking: "minimal" },
    { id: "standard", description: "Normal implementation work, routine debugging, and moderate multi-file changes.", modelRef: "openrouter/~openai/gpt-terra-latest", thinking: "medium" },
    { id: "complex", description: "Complex debugging, architecture, broad refactors, and tasks with multiple interacting systems.", modelRef: "openrouter/~openai/gpt-sol-latest", thinking: "high" },
    { id: "expert", description: "Exceptionally difficult, ambiguous, or high-risk work requiring maximum reasoning depth.", modelRef: "openrouter/~openai/gpt-astra-latest", thinking: "xhigh" },
  ],
};

const THINKING_LEVELS = new Set<PixThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function loadModelRoutingConfig(cwd: string, homeDir = homedir()): ModelRoutingConfig {
  const global = readModelRoutingConfig(pixUserConfigPath(homeDir), DEFAULT_MODEL_ROUTING);
  return readModelRoutingConfig(pixProjectConfigPath(cwd), global);
}

export function modelRoutingConfigFromParsed(raw: unknown, fallback: ModelRoutingConfig): ModelRoutingConfig {
  if (!isRecord(raw) || !isRecord(raw.modelRouting)) return cloneConfig(fallback);
  const value = raw.modelRouting;
  const parsedTiers = Array.isArray(value.tiers)
    ? value.tiers.flatMap((candidate): ModelRoutingTier[] => {
        if (!isRecord(candidate)) return [];
        const id = nonEmptyString(candidate.id)?.toLowerCase();
        const description = nonEmptyString(candidate.description);
        const modelRef = nonEmptyString(candidate.modelRef);
        const thinking = normalizeThinking(candidate.thinking);
        if (!id || !/^[a-z][a-z0-9_-]*$/u.test(id) || !description || !modelRef || !thinking) return [];
        return [{ id, description, modelRef, thinking }];
      })
    : [];
  const tiers = parsedTiers.length > 0
    ? [...new Map(parsedTiers.map((tier) => [tier.id, tier])).values()]
    : fallback.tiers.map((tier) => ({ ...tier }));
  const requestedDefault = nonEmptyString(value.defaultTier)?.toLowerCase();
  const defaultTier = requestedDefault && tiers.some((tier) => tier.id === requestedDefault)
    ? requestedDefault
    : tiers.some((tier) => tier.id === fallback.defaultTier)
      ? fallback.defaultTier
      : tiers[0]?.id ?? "standard";
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    default: typeof value.default === "boolean" ? value.default : fallback.default,
    modelRef: nonEmptyString(value.modelRef) ?? fallback.modelRef,
    fallbackModels: Object.prototype.hasOwnProperty.call(value, "fallbackModels")
      ? modelFallbackList(value.fallbackModels)
      : [...fallback.fallbackModels],
    defaultTier,
    tiers,
  };
}

export function defaultRoutingDecision(config: ModelRoutingConfig): ModelRoutingDecision {
  const tier = config.tiers.find((candidate) => candidate.id === config.defaultTier) ?? config.tiers[0] ?? DEFAULT_MODEL_ROUTING.tiers[1]!;
  return { tierId: tier.id, modelRef: tier.modelRef, thinkingLevel: tier.thinking, fallback: true };
}

export async function routeModelWithRuntime(
  runtime: ModelRuntime,
  config: ModelRoutingConfig,
  prompt: string,
  attachmentCount: number,
  signal?: AbortSignal,
  dependencies: ModelRoutingDependencies = {},
): Promise<ModelRoutingDecision> {
  const fallback = defaultRoutingDecision(config);
  if (!config.enabled) return fallback;
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]) : AbortSignal.timeout(ROUTER_TIMEOUT_MS);
  let refreshed = false;
  for (const ref of [...new Set([config.modelRef, ...config.fallbackModels].map((value) => value.trim()).filter(Boolean))]) {
    if (requestSignal.aborted) break;
    const parsed = parseRef(ref);
    if (!parsed) continue;
    if (isOpenRouterJev(parsed.provider, parsed.modelId)) {
      try {
        const tierId = await requestOpenRouterJevDecision(
          runtime,
          parsed.modelId,
          config,
          prompt,
          attachmentCount,
          requestSignal,
          dependencies.fetch ?? globalThis.fetch,
        );
        const tier = config.tiers.find((candidate) => candidate.id === tierId);
        if (tier) {
          return {
            tierId: tier.id,
            modelRef: tier.modelRef,
            thinkingLevel: tier.thinking,
            routerModelRef: ref,
            fallback: false,
          };
        }
      } catch {
        if (requestSignal.aborted) break;
      }
      continue;
    }
    let model = runtime.getModel(parsed.provider, parsed.modelId);
    model ??= dynamicOpenRouterAliasModel(runtime, parsed.provider, parsed.modelId);
    if (!model && !refreshed) {
      try {
        await runtime.refresh({
          allowNetwork: true,
          providers: [parsed.provider],
          force: true,
          signal: requestSignal,
        });
      } catch { /* continue with local/fallback refs */ }
      refreshed = true;
      model = runtime.getModel(parsed.provider, parsed.modelId);
      model ??= dynamicOpenRouterAliasModel(runtime, parsed.provider, parsed.modelId);
    }
    if (!model) continue;
    try {
      const tierId = await requestTier(runtime, model, config, prompt, attachmentCount, requestSignal);
      const tier = config.tiers.find((candidate) => candidate.id === tierId);
      if (tier) return { tierId: tier.id, modelRef: tier.modelRef, thinkingLevel: tier.thinking, routerModelRef: ref, fallback: false };
    } catch {
      if (requestSignal.aborted) break;
    }
  }
  return fallback;
}

function isOpenRouterJev(provider: string, modelId: string): boolean {
  return provider === "openrouter" && /^~?typesafe\/jev(?:-|$)/u.test(modelId);
}

async function requestOpenRouterJevDecision(
  runtime: ModelRuntime,
  modelId: string,
  config: ModelRoutingConfig,
  prompt: string,
  attachmentCount: number,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<string | undefined> {
  const auth = await runtime.getAuth("openrouter", { signal });
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
        request: prompt.trim().slice(0, 24_000),
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
  runtime: ModelRuntime,
  provider: string,
  modelId: string,
): NonNullable<ReturnType<ModelRuntime["getModel"]>> | undefined {
  if (provider !== "openrouter" || !modelId.startsWith("~")) return undefined;
  const template = runtime.getModel("openrouter", "openai/gpt-4o-mini")
    ?? runtime.getModels("openrouter").find((candidate) => candidate.api === "openai-completions");
  if (!template) return undefined;
  return {
    ...template,
    id: modelId,
    name: modelId,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: Math.min(Math.max(template.maxTokens, ROUTER_MAX_TOKENS), 4_096),
  };
}

export function parseRoutingTier(output: string, config: ModelRoutingConfig): string | undefined {
  const ids = new Set(config.tiers.map((tier) => tier.id));
  let text = output.replace(/\r\n/gu, "\n").trim();
  const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text);
  if (fenced) text = fenced[1]!.trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    const candidate = typeof parsed === "string" ? parsed : isRecord(parsed)
      ? [parsed.tier, parsed.choice, parsed.decision, parsed.id].find((entry): entry is string => typeof entry === "string")
      : undefined;
    const normalized = candidate?.trim().toLowerCase();
    if (normalized && ids.has(normalized)) return normalized;
  } catch { /* accept bare fallback-model output below */ }
  const raw = text.replace(/^["']|["']$/gu, "").trim().toLowerCase();
  if (ids.has(raw)) return raw;
  const match = /"(?:tier|choice|decision|id)"\s*:\s*"([^"]+)"/iu.exec(text);
  const fromObject = match?.[1]?.trim().toLowerCase();
  return fromObject && ids.has(fromObject) ? fromObject : undefined;
}

function readModelRoutingConfig(path: string, fallback: ModelRoutingConfig): ModelRoutingConfig {
  if (!existsSync(path)) return cloneConfig(fallback);
  try { return modelRoutingConfigFromParsed(parseJsonc(readFileSync(path, "utf8")) as unknown, fallback); }
  catch { return cloneConfig(fallback); }
}

function cloneConfig(config: ModelRoutingConfig): ModelRoutingConfig {
  return { ...config, fallbackModels: [...config.fallbackModels], tiers: config.tiers.map((tier) => ({ ...tier })) };
}

async function requestTier(runtime: ModelRuntime, model: NonNullable<ReturnType<ModelRuntime["getModel"]>>, config: ModelRoutingConfig, prompt: string, attachmentCount: number, signal: AbortSignal): Promise<string | undefined> {
  const maxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, ROUTER_MAX_TOKENS) : ROUTER_MAX_TOKENS;
  let output = "";
  let toolTier: string | undefined;
  let streamError: string | undefined;
  const stream = runtime.streamSimple({ ...model, maxTokens }, {
    systemPrompt: "You are a deterministic task-complexity router.",
    messages: [{ role: "user", content: routingPrompt(config, prompt, attachmentCount), timestamp: Date.now() }],
    tools: [routingTool(config)],
  }, { signal, cacheRetention: "none", maxRetryDelayMs: 0, maxRetries: 0, maxTokens, timeoutMs: ROUTER_TIMEOUT_MS });
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
  return parseRoutingTier(output, config);
}

function routingPrompt(config: ModelRoutingConfig, prompt: string, attachmentCount: number): string {
  return [
    "Choose exactly one semantic task tier for a coding-agent request.",
    "Choose based on complexity, ambiguity, scope, risk, and reasoning depth—not model names.",
    `Use the ${ROUTER_TOOL_NAME} tool when available. Otherwise return only JSON: {"tier":"<id>"}.`,
    "Do not explain the choice.",
    "",
    "Tiers:",
    ...config.tiers.map((tier) => `- ${tier.id}: ${tier.description}`),
    "",
    `Attachments: ${Math.max(0, Math.floor(attachmentCount))}`,
    "Task:",
    "<task>",
    prompt.trim().slice(0, 24_000),
    "</task>",
  ].join("\n");
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

function parseRef(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 ? { provider: value.slice(0, slash), modelId: value.slice(slash + 1).split(":", 1)[0]! } : undefined;
}

function assistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

function modelFallbackList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))] : [];
}

function normalizeThinking(value: unknown): PixThinkingLevel | undefined {
  return typeof value === "string" && THINKING_LEVELS.has(value as PixThinkingLevel) ? value as PixThinkingLevel : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
