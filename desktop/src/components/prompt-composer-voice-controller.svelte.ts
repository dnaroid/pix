import { invoke } from "@tauri-apps/api/core";
import { onMount, tick } from "svelte";
import {
  browserDeepgramSupported,
  DeepgramDictationController,
  type DeepgramDictationState,
  type DeepgramToken,
} from "../lib/deepgram";

interface PromptComposerVoiceControllerOptions {
  readonly contextKey: () => string | undefined;
  readonly ready: () => boolean;
  readonly editorMode: () => boolean;
  readonly questionMode: () => boolean;
  readonly dismissAutocomplete: () => void;
  readonly insertTranscript: (text: string, sessionId: string | undefined) => Promise<void>;
}

export function createPromptComposerVoiceController(options: PromptComposerVoiceControllerOptions) {
  let controller: DeepgramDictationController | undefined;
  let state = $state<DeepgramDictationState>("idle");
  let interim = $state<string | undefined>();
  let error = $state("");
  let supported = $state(false);
  let sessionId = $state<string | undefined>();

  onMount(() => {
    supported = browserDeepgramSupported();
    if (!supported) return;
    controller = new DeepgramDictationController(
      {
        onState: (nextState: DeepgramDictationState) => { state = nextState; },
        onFinal: (text: string) => { void options.insertTranscript(text, sessionId); },
        onInterim: (text: string | undefined) => {
          interim = sessionId === options.contextKey() ? text : undefined;
        },
        onError: (message: string) => { error = message; },
      },
      async () => await invoke<DeepgramToken>("deepgram_token"),
    );
    return () => {
      const activeController = controller;
      sessionId = undefined;
      interim = undefined;
      controller = undefined;
      if (activeController) void activeController.dispose();
    };
  });

  $effect(() => {
    if (state === "idle") return;
    const contextKey = options.contextKey();
    if (
      !contextKey
      || sessionId !== contextKey
      || !options.ready()
      || options.editorMode()
      || options.questionMode()
    ) {
      sessionId = undefined;
      interim = undefined;
      void stop();
    }
  });

  function canStart(): boolean {
    return !options.editorMode()
      && !options.questionMode()
      && supported
      && options.ready()
      && !!options.contextKey();
  }

  async function toggle(): Promise<void> {
    if (!controller) return;
    const starting = controller.currentState() === "idle";
    if (starting) {
      const contextKey = options.contextKey();
      if (!canStart() || !contextKey) return;
      sessionId = contextKey;
    }
    error = "";
    options.dismissAutocomplete();
    await controller.toggle();
    if (controller.currentState() === "idle") {
      sessionId = undefined;
      interim = undefined;
    }
  }

  async function stop(): Promise<void> {
    const activeController = controller;
    if (!activeController) return;
    if (activeController.currentState() !== "idle") await activeController.stop();
    sessionId = undefined;
    interim = undefined;
    await tick();
  }

  return {
    get state() { return state; },
    get interim() { return interim; },
    get error() { return error; },
    get supported() { return supported; },
    get canStart() { return canStart(); },
    toggle,
    stop,
  };
}

export type PromptComposerVoiceController = ReturnType<typeof createPromptComposerVoiceController>;
