import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_WIKI_AUTO_CHECK_VIEW, type WikiAutoCheckView } from "../lib/wiki-auto-check-config";
import WikiAutoCheckControl from "./WikiAutoCheckControl.svelte";

function html(
  state: Partial<WikiAutoCheckView> = {},
  props: { disabled?: boolean; part?: "switch" | "notice"; onChange?: (enabled: boolean) => void } = {},
): string {
  return render(WikiAutoCheckControl, { props: { state: { ...EMPTY_WIKI_AUTO_CHECK_VIEW, ...state }, ...props } }).body;
}
function button(body: string): string { return body.match(/<button\b[^>]*>/u)?.[0] ?? ""; }

describe("Wiki background checking header control", () => {
  it("renders a labelled icon switch without starting work", () => {
    const onChange = vi.fn();
    const tag = button(html({}, { onChange }));
    expect(tag).toContain('role="switch"');
    expect(tag).toContain('aria-checked="false"');
    expect(tag).toContain('aria-label="Проверять в фоне"');
    expect(tag).toContain('title="Проверять в фоне"');
    expect(tag).not.toMatch(/\sdisabled(?:\s|=|>)/u);
    expect(tag).not.toContain("bg-primary/15");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reflects the restored enabled policy with accent pill and progress tooltip", () => {
    const tag = button(html({ enabled: true, completed: 18, total: 64, queued: 45, running: true }, { onChange: vi.fn() }));
    expect(tag).toContain('aria-checked="true"');
    expect(tag).toContain("bg-primary/15");
    expect(tag).toContain("Обработано 18 из 64 · в очереди 45");
  });

  it("keeps the switch disabled during persistence and with no project callback", () => {
    expect(button(html({ saving: true }, { onChange: vi.fn() }))).toMatch(/\sdisabled(?:\s|=|>)/u);
    expect(button(html({}, { disabled: true, onChange: vi.fn() }))).toMatch(/\sdisabled(?:\s|=|>)/u);
    expect(button(html())).toMatch(/\sdisabled(?:\s|=|>)/u);
    expect(button(html({ saving: true }))).toContain("Сохранение…");
  });

  it("distinguishes discovery, watching and finishing after disabling in the tooltip", () => {
    expect(button(html({ enabled: true, scanning: true }))).toContain("Поиск страниц…");
    expect(button(html({ enabled: true }))).toContain("Отслеживание изменений");
    expect(button(html({ enabled: false, running: true }))).toContain("Текущая проверка завершается…");
    expect(button(html({ enabled: true, completed: 4, total: 4 }))).toContain("Обработано 4 из 4 · отслеживание изменений");
  });

  it("renders a recoverable error as escaped text in the notice part only", () => {
    const state = { enabled: true, error: "<script>unsafe</script> & incomplete" };
    const body = html(state, { part: "notice" });
    expect(body).toContain("data-wiki-auto-check-error");
    expect(body).toContain("&lt;script");
    expect(body).toContain("&amp;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<button");
    expect(html({ enabled: true }, { part: "notice" })).not.toContain("data-wiki-auto-check-error");
    expect(html(state)).not.toContain("data-wiki-auto-check-error");
  });
});
