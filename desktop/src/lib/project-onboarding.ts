import type { ProjectIconImage } from "./project-icon";
import { registryPublicationScope, type RegistryItem } from "./registry";

export type OnboardingResource = RegistryItem & { type: "agent" | "skill" };
export type OnboardingIcon = { kind: "file"; image: ProjectIconImage } | { kind: "generate"; prompt: string };

export interface ProjectOnboardingChoices {
  git: boolean;
  wiki: boolean;
  knowledge: boolean;
  autoCheck: boolean;
  resources: readonly OnboardingResource[];
  icon?: OnboardingIcon;
}

export interface ProjectOnboardingActions {
  git(): Promise<void>;
  wiki(signal: AbortSignal): Promise<void>;
  knowledge(signal: AbortSignal): Promise<void>;
  autoCheck(signal: AbortSignal): Promise<void>;
  install(resource: OnboardingResource, signal: AbortSignal): Promise<void>;
  icon(icon: OnboardingIcon, signal: AbortSignal): Promise<void>;
}

export function isOnboardingResource(item: RegistryItem): item is OnboardingResource {
  return item.type !== "project" && item.remote && item.actions.includes("install")
    && registryPublicationScope(item) === "global";
}

/** Fixed plan built on submit. A retry resumes at the first unfinished step. */
export function projectOnboardingPlan(choices: ProjectOnboardingChoices, actions: ProjectOnboardingActions) {
  type Step = { label: string; run: (signal: AbortSignal) => Promise<void> };
  const steps: Step[] = [];
  if (choices.git) steps.push({ label: "Initialize Git", run: actions.git });
  if (choices.wiki) steps.push({ label: "Create Wiki", run: actions.wiki });
  if (choices.knowledge) steps.push({ label: "Enable Knowledge indexing", run: actions.knowledge });
  if (choices.wiki && choices.knowledge && choices.autoCheck) {
    steps.push({ label: "Enable background Wiki checks", run: actions.autoCheck });
  }
  for (const resource of choices.resources) {
    steps.push({ label: `Install ${resource.type} ${resource.name}`, run: signal => actions.install(resource, signal) });
  }
  const icon = choices.icon;
  if (icon) steps.push({ label: "Save project icon", run: signal => actions.icon(icon, signal) });
  let cursor = 0;
  let running = false;

  return {
    async run(signal: AbortSignal, onStep: (label: string) => void) {
      if (running) return;
      running = true;
      try {
        for (; cursor < steps.length; cursor++) {
          signal.throwIfAborted();
          const step = steps[cursor]!;
          onStep(step.label);
          await step.run(signal);
          signal.throwIfAborted();
        }
      } finally {
        running = false;
      }
    },
  };
}
