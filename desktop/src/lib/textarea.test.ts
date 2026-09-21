import { describe, expect, it } from "vitest";
import { autosizeTextarea } from "./textarea";

function textareaWithScrollHeight(scrollHeight: number): HTMLTextAreaElement {
  return { scrollHeight, style: { height: "", overflowY: "" } } as HTMLTextAreaElement;
}

describe("autosizeTextarea", () => {
  it("grows between the configured minimum and maximum", () => {
    const textarea = textareaWithScrollHeight(96);

    autosizeTextarea(textarea, { minHeight: 64, maxHeight: 160 });

    expect(textarea.style.height).toBe("96px");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("clamps short and long content and only scrolls past the maximum", () => {
    const short = textareaWithScrollHeight(24);
    const long = textareaWithScrollHeight(220);

    autosizeTextarea(short, { minHeight: 64, maxHeight: 160 });
    autosizeTextarea(long, { minHeight: 64, maxHeight: 160 });

    expect(short.style.height).toBe("64px");
    expect(short.style.overflowY).toBe("hidden");
    expect(long.style.height).toBe("160px");
    expect(long.style.overflowY).toBe("auto");
  });
});
