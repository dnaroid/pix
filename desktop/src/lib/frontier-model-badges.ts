import { invoke } from "@tauri-apps/api/core";
import { parse, type ParseError } from "jsonc-parser";
import { writable } from "svelte/store";
import {
  defaultFrontierConfig,
  isFrontierModel,
  normalizeFrontierModels,
  type FrontierConfig,
} from "../../../external/pi-tools-suite/src/async-subagents/core/frontier-models.js";

/** Classification, not spawn eligibility: economy/role limits do not change badges. */
export function frontierBadgeConfig(source: string): FrontierConfig | undefined {
  const errors: ParseError[] = [];
  const root = parse(source, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || !root || typeof root !== "object" || Array.isArray(root)) return undefined;
  const models = normalizeFrontierModels((root as Record<string, unknown>).frontierModels)
    ?? defaultFrontierConfig().models;
  return { models: models.filter((entry) => entry.enabled !== false), economy: false };
}

export function hasFrontierBadge(ref: string, config: FrontierConfig): boolean {
  return ref !== "pix:auto" && isFrontierModel(ref, config);
}

export function createFrontierBadgeStore(readSource: () => Promise<string>) {
  const state = writable<FrontierConfig>({ models: [], economy: false });
  let revision = 0;
  let pending: Promise<void> | undefined;
  function publish(source: string): void {
    revision += 1;
    const config = frontierBadgeConfig(source);
    if (config) state.set(config);
  }
  function refresh(): Promise<void> {
    if (pending) return pending;
    const started = revision;
    const request = readSource().then((source) => {
      if (revision === started) publish(source);
    }).catch(() => { /* Keep the last known classification on read failure. */ });
    pending = request.finally(() => { pending = undefined; });
    return pending;
  }
  return { subscribe: state.subscribe, publish, refresh };
}

export const frontierBadges = createFrontierBadgeStore(async () => {
  const document = await invoke<{ content: string }>("read_user_config", { kind: "pi-tools-suite" });
  return document.content;
});
