import { describe, expect, it, vi } from "vitest";
import { openExternalHref } from "./external-links";

describe("openExternalHref", () => {
  it("opens safe URLs with the supplied system opener", async () => {
    const opener = vi.fn(async () => undefined);

    await expect(openExternalHref("https://www.google.com", opener)).resolves.toBe(true);
    expect(opener).toHaveBeenCalledOnce();
    expect(opener).toHaveBeenCalledWith("https://www.google.com/");
  });

  it("does not pass unsupported URL schemes to the system opener", async () => {
    const opener = vi.fn(async () => undefined);

    await expect(openExternalHref("javascript:alert(1)", opener)).resolves.toBe(false);
    expect(opener).not.toHaveBeenCalled();
  });
});
