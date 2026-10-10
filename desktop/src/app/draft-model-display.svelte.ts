import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { SvelteMap } from "svelte/reactivity";
import type { ModelDefaultSelection } from "../lib/model-default-preference";
import { AUTO_MODEL_REF } from "../lib/model-thinking";
import {
  sessionTabModel, sessionTabModelDisplayOptions,
  type SessionTabModel,
} from "../lib/session-tab-model";

/** Configured defaults only: never a catalog, startup override or quota. */
export function createDraftModelDisplay(defaultSelection: () => ModelDefaultSelection | undefined) {
  const models = new SvelteMap<string, SessionTabModel>();

  return {
    options(workspace: string): SessionConfigOption[] {
      const selection = defaultSelection();
      let model = models.get(workspace);
      if (selection?.kind === "auto") {
        model = { modelRef: AUTO_MODEL_REF, modelName: "Auto", thinking: "off" };
      } else if (selection?.kind === "model") {
        model = {
          modelRef: selection.modelRef,
          modelName: model?.modelRef === selection.modelRef ? model.modelName
            : selection.modelRef.slice(selection.modelRef.indexOf("/") + 1),
          thinking: selection.thinking,
        };
      }
      return model ? sessionTabModelDisplayOptions(model) : [];
    },
    remember(workspace: string, configOptions: readonly SessionConfigOption[]) {
      const model = sessionTabModel(configOptions);
      if (model) models.set(workspace, model);
      else models.delete(workspace);
    },
  };
}
