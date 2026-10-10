import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { modelThinkingConfigState } from "./model-thinking";

/** Display-only last-known selection, not a runtime configuration/catalog. */
export type SessionTabModel = {
  modelRef: string;
  modelName: string;
  thinking: string;
};

export type SessionTabModels = Map<string, Map<string, SessionTabModel>>;

export function sessionTabModel(configOptions: readonly SessionConfigOption[]): SessionTabModel | undefined {
  const { currentModel, currentThinking } = modelThinkingConfigState(configOptions);
  return currentModel ? {
    modelRef: currentModel.ref,
    modelName: currentModel.name,
    thinking: currentThinking,
  } : undefined;
}

export function parseSessionTabModels(raw: string | null): SessionTabModels {
  const result: SessionTabModels = new Map();
  try {
    const projects: unknown = JSON.parse(raw ?? "null");
    if (!isRecord(projects)) return result;
    for (const [workspace, sessions] of Object.entries(projects)) {
      if (!isRecord(sessions)) continue;
      const models = new Map<string, SessionTabModel>();
      for (const [sessionId, value] of Object.entries(sessions)) {
        if (!sessionId || !isRecord(value)) continue;
        if (!validText(value.modelRef) || !validText(value.modelName) || !validText(value.thinking)) continue;
        models.set(sessionId, {
          modelRef: value.modelRef,
          modelName: value.modelName,
          thinking: value.thinking,
        });
      }
      if (models.size) result.set(workspace, models);
    }
  } catch {
    // Missing/old/corrupt display metadata must not affect tab restoration.
  }
  return result;
}

export function serializeSessionTabModels(models: ReadonlyMap<string, ReadonlyMap<string, SessionTabModel>>): string {
  return JSON.stringify(Object.fromEntries(
    [...models].map(([workspace, sessions]) => [workspace, Object.fromEntries(sessions)]),
  ));
}

/** Only the status-bar display consumes these synthetic options. */
export function sessionTabModelDisplayOptions(model: SessionTabModel): SessionConfigOption[] {
  return [
    { id: "model", name: "Model", type: "select", currentValue: model.modelRef,
      options: [{ value: model.modelRef, name: model.modelName }] },
    { id: "thought_level", name: "Thinking", type: "select", currentValue: model.thinking,
      options: [{ value: model.thinking, name: model.thinking }] },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}
