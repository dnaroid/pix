import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import TaskFieldSelect from "./TaskFieldSelect.svelte";
import TaskProjectLinkInput from "./TaskProjectLinkInput.svelte";
import selectorSource from "./TaskFieldSelect.svelte?raw";
import relationsSource from "./WorkspaceSidebarTaskRelations.svelte?raw";
import taskEditorSource from "./WorkspaceSidebarTaskEditor.svelte?raw";
import tasksPanelSource from "./WorkspaceSidebarTasksPanel.svelte?raw";
import linkInputSource from "./TaskProjectLinkInput.svelte?raw";

describe("Pix task dropdowns", () => {
  it("renders a styled, accessible non-native selector for a selected value", () => {
    const html = render(TaskFieldSelect, { props: {
      value: "idea",
      ariaLabel: "Task type",
      options: [{ value: "feature", label: "Feature" }, { value: "idea", label: "Idea" }],
      onChange: () => {},
    } }).body;
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-label="Task type"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Idea</span>');
    expect(html).toContain("lucide-chevron-down");
    expect(html).not.toContain("<select");
  });

  it("does not leave system selects in type, parent, related-task or task-filter controls", () => {
    for (const source of [relationsSource, taskEditorSource, tasksPanelSource]) {
      expect(source).toContain("<TaskFieldSelect");
      expect(source).not.toMatch(/<select\b/);
    }
  });

  it("replaces the file-link datalist with a keyboard-friendly Pix suggestion popup", () => {
    const html = render(TaskProjectLinkInput, { props: {
      value: "docs/", suggestions: ["docs/plan.md", "docs/spec.md"], onAdd: () => {},
    } }).body;
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Project file path or URL"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-label="Add linked file"');
    expect(html).not.toContain("<datalist");
    expect(relationsSource).toContain("<TaskProjectLinkInput");
    expect(relationsSource).not.toContain("<datalist");
    for (const contract of [
      'event.key === "ArrowDown"', 'event.key === "Escape"',
      'event.key === "Enter"', 'role="listbox"',
      'window.addEventListener("scroll", reposition, true)',
      'window.removeEventListener("scroll", reposition, true)',
      'onpointerdown={(event) => event.preventDefault()}',
    ]) expect(linkInputSource).toContain(contract);
  });

  it("keeps keyboard, search, outside dismissal and scroll positioning for narrow editor popups", () => {
    for (const control of [
      'aria-haspopup="listbox"', 'role="combobox"', 'role="listbox"',
      'event.key === "Escape"', 'event.key === "ArrowDown"',
      'event.key === "Enter"', 'event.key === "Home"',
      'window.addEventListener("scroll", reposition, true)',
      'window.removeEventListener("scroll", reposition, true)',
      "handleOutsidePointerDown", "handlePopupPointerDown",
      "querySelector<HTMLButtonElement>",
    ]) expect(selectorSource).toContain(control);
    expect(selectorSource).toContain("maxHeight");
    expect(selectorSource).toContain('class="fixed z-[70]');
  });
});
