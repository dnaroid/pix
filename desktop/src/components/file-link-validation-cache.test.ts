import { describe, expect, it, vi } from "vitest";
import { FileLinkValidationCache } from "./file-link-validation-cache";

describe("FileLinkValidationCache", () => {
  it("shares in-flight checks and retains resolved true and false results", async () => {
    const cache = new FileLinkValidationCache();
    const validator = vi.fn(async () => true);

    const first = cache.validate("project", "README.md", validator);
    const second = cache.validate("project", "README.md", validator);

    expect(first).toBe(second);
    await expect(first).resolves.toBe(true);
    await Promise.resolve();
    expect(cache.peek("project", "README.md", validator)).toBe(true);
    expect(cache.validate("project", "README.md", validator)).toBe(true);
    expect(validator).toHaveBeenCalledTimes(1);

    const missing = vi.fn(async () => false);
    await expect(cache.validate("local", "~/missing.md", missing)).resolves.toBe(false);
    await Promise.resolve();
    expect(cache.validate("local", "~/missing.md", missing)).toBe(false);
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it("does not share results across validator identities or file scopes", async () => {
    const cache = new FileLinkValidationCache();
    const firstValidator = vi.fn(async () => true);
    const secondValidator = vi.fn(async () => false);

    await cache.validate("project", "README.md", firstValidator);
    await cache.validate("project", "README.md", secondValidator);
    await cache.validate("local", "README.md", firstValidator);

    expect(firstValidator).toHaveBeenCalledTimes(2);
    expect(secondValidator).toHaveBeenCalledTimes(1);
  });

  it("forgets failed checks so a later render can retry", async () => {
    const cache = new FileLinkValidationCache();
    const validator = vi.fn()
      .mockRejectedValueOnce(new Error("temporary filesystem error"))
      .mockResolvedValueOnce(true);

    await expect(cache.validate("project", "README.md", validator)).rejects.toThrow("temporary filesystem error");
    await Promise.resolve();
    await expect(cache.validate("project", "README.md", validator)).resolves.toBe(true);

    expect(validator).toHaveBeenCalledTimes(2);
  });
});
