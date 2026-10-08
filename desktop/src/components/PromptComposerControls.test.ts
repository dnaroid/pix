import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import PromptComposerControls from "./PromptComposerControls.svelte";

describe("composer enhancement controls", () => {
  it.each([true, false])("renders enhancement pending=%s", (promptEnhancing) => {
    const html = render(PromptComposerControls, { props: {
      menuTrigger: null,
      menuOpen: false,
      voiceState: "idle",
      voiceSupported: true,
      voiceCanStart: true,
      promptRunning: false,
      promptEnhancing,
      canSubmit: true,
      onToggleMenu: () => {},
      onToggleVoice: () => {},
    } }).body;
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(/\sdisabled(?:[=\s>])/.test(button)).toBe(promptEnhancing);
    }
    expect(html.includes("animate-spin")).toBe(promptEnhancing);
    expect(html).toContain(promptEnhancing ? 'aria-label="Improving prompt"' : 'aria-label="Send message"');
  });
});
