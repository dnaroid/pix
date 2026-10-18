import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ModelUsageStatus } from "./acp-client";
import { modelThinkingConfigState } from "./model-thinking";

export interface ProviderUsageTarget {
  readonly modelRef: string;
  readonly provider: ModelUsageStatus["provider"];
}

const QUOTA_PROVIDERS: Readonly<Record<string, ModelUsageStatus["provider"]>> = {
  openai: "openai",
  "openai-codex": "openai",
  anthropic: "anthropic",
  "pi-claude-code-provider": "anthropic",
  zai: "zhipu",
  "zhipuai-coding-plan": "zhipu",
  antigravity: "google-antigravity",
  "google-antigravity": "google-antigravity",
};

/** Normalize recorded provider routes to their account-quota family. */
export function quotaProviderForRoute(route: string | null): ModelUsageStatus["provider"] | undefined {
  if (route === "zhipu") return "zhipu";
  return route !== null && Object.hasOwn(QUOTA_PROVIDERS, route) ? QUOTA_PROVIDERS[route] : undefined;
}

/** One representative per credential route; Antigravity quotas are model-specific. */
export function providerUsageTargets(configOptions: readonly SessionConfigOption[]): ProviderUsageTarget[] {
  const targets = new Map<string, ProviderUsageTarget>();
  for (const model of modelThinkingConfigState(configOptions).models) {
    const provider = Object.hasOwn(QUOTA_PROVIDERS, model.provider) ? QUOTA_PROVIDERS[model.provider] : undefined;
    if (!provider) continue;
    const key = provider === "google-antigravity" ? model.ref : model.provider;
    if (!targets.has(key)) targets.set(key, { modelRef: model.ref, provider });
  }
  return [...targets.values()];
}
