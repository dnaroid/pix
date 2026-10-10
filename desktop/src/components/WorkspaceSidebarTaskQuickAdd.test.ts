import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import WorkspaceSidebarTaskQuickAdd from "./WorkspaceSidebarTaskQuickAdd.svelte";
import source from "./WorkspaceSidebarTaskQuickAdd.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

describe("Desktop Tasks Quick Add", () => {
  it("renders a labelled text entry and disabled empty-state submission above the scrollable task list", () => {
    const html = render(WorkspaceSidebarTaskQuickAdd, { props: { workspace: "/project", onCreate: () => {} } }).body;
    expect(html).toContain('aria-label="Quick add task"');
    expect(html).toContain('aria-label="New task text"');
    expect(html).toContain('aria-label="Create task"');
    expect(html).toMatch(/aria-label="Create task"[^>]*disabled/);
    expect(html).not.toContain("Jev picks type · text sent to OpenRouter on add");
    expect(html).toContain("Task text sent to OpenRouter Jev for type classification");
    expect(sidebarSource).toContain("<WorkspaceSidebarTaskQuickAdd {workspace} client={lspClient} {busy} onCreate={createQuickTask} />");
    expect(sidebarSource).toContain('tasksView.expandStatus("todo")');
    expect(sidebarSource).toContain('grid-rows-[auto_minmax(0,1fr)]');
  });

  it("uses existing Deepgram with manual stop/final transcript and does not auto-submit on dictation", () => {
    expect(source).toContain("browserDeepgramSupported()");
    expect(source).toContain('invoke<DeepgramToken>("deepgram_token")');
    expect(source).toContain("new SearchVoiceController(");
    expect(source).toContain("insertSearchTranscript(text, next");
    expect(source).toContain("await voice.stop()");
    expect(source).toContain("voice?.dispose()");
    expect(source).toContain('event.key === "Enter" && !event.shiftKey && !event.isComposing');
    expect(source).not.toContain('onFinal: next => { void submit()');
  });
});
