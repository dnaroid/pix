import { describe, expect, it, vi } from "vitest";
import { createValidatedProjectPath } from "./validated-project-path";
import source from "../components/ValidatedProjectPath.svelte?raw";

describe("validated project path lifecycle", () => {
  it("shows the link immediately and does not validate before activation", () => {
    expect(source).toContain("valid = $state(true)");
    expect(source).toContain("valid = true;");
    expect(source).not.toContain("current.validate()");
    const validate = vi.fn().mockResolvedValue(true);
    createValidatedProjectPath("run", "directory", { validate, open: vi.fn() }, vi.fn(), vi.fn());
    expect(validate).not.toHaveBeenCalled();
  });
  it("rechecks existence on click and leaves deleted or failed targets as plain text", async () => {
    const validate = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("missing"));
    const open = vi.fn();
    const setValid = vi.fn();
    const onNavigate = vi.fn();
    const link = createValidatedProjectPath("file.ts", "file", { validate, open }, setValid, onNavigate);
    expect(await link.validate()).toBe(true);
    await link.open();
    await link.open();
    expect(setValid.mock.calls).toEqual([[true], [false], [false]]);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it("drops validation and clicks finishing after teardown or target replacement", async () => {
    let complete!: (value: boolean) => void;
    const validate = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const open = vi.fn();
    const setValid = vi.fn();
    const onNavigate = vi.fn();
    const link = createValidatedProjectPath("run", "directory", { validate, open }, setValid, onNavigate);
    const pending = link.open();
    link.dispose();
    complete(true);
    await pending;
    await link.open();
    expect(setValid).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it("opens once after validation, even if closing the dialog disposes the link", async () => {
    let complete!: (value: boolean) => void;
    const validate = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const open = vi.fn();
    const events: string[] = [];
    const link = createValidatedProjectPath("run", "directory", { validate, open }, () => {}, () => { events.push("close"); link.dispose(); });
    open.mockImplementation(async () => { events.push("open"); });
    const pending = link.open();
    await link.open();
    complete(true);
    await pending;
    expect(validate).toHaveBeenCalledWith("run", "directory");
    expect(open).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["close", "open"]);
  });
});
