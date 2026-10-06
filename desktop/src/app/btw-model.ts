import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AUTO_MODEL_REF, clampThinkingLevel, modelThinkingConfigState } from "../lib/model-thinking";

/** Rebase the full catalogue onto BTW without mutating parent configuration.
 * The shared statusbar picker remains responsible for visibility and search.
 * Auto creates/routes parent sessions; it is not a side-inference model.
 */
export function btwModelPickerConfig(
  options: readonly SessionConfigOption[], modelRef: string | null, thinkingLevel: string | null,
): SessionConfigOption[] {
  const parent = modelThinkingConfigState(options);
  const models = parent.models.filter((model) => model.ref !== AUTO_MODEL_REF);
  const ref = modelRef ?? parent.currentModel?.ref ?? "";
  const selected = models.find((model) => model.ref === ref);
  const levels = selected?.thinkingLevels ?? ["off"];
  return [
    { id: "model", name: "Model", type: "select", currentValue: ref,
      options: models.map((model) => ({ value: model.ref, name: model.name, _meta: { "pix.thinkingLevels": [...model.thinkingLevels] } })) },
    { id: "thought_level", name: "Thinking", type: "select",
      currentValue: clampThinkingLevel(thinkingLevel ?? parent.currentThinking, levels),
      options: levels.map((level) => ({ value: level, name: level })) },
  ];
}
