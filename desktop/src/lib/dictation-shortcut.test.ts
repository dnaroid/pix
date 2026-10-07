import { describe, expect, it, vi } from "vitest";
import { attachDictationShortcut } from "./dictation-shortcut";

function setup() {
  let handler = () => {};
  let eligible = true;
  let register!: (release: () => void) => void;
  const toggle = vi.fn(async () => {});
  const onError = vi.fn();
  const release = vi.fn();
  const setNativeEnabled = vi.fn(async (_enabled: boolean) => {});
  const shortcut = attachDictationShortcut({
    listen: (callback) => {
      handler = callback;
      return new Promise((resolve) => { register = resolve; });
    },
    canToggle: () => eligible,
    setNativeEnabled,
    toggle,
    onError,
  });
  return {
    press: () => handler(),
    setEligible: (value: boolean) => { eligible = value; },
    register: () => register(release),
    toggle, onError, release, setNativeEnabled,
    dispose: shortcut.dispose,
    setEnabled: shortcut.setEnabled,
  };
}

describe("native dictation shortcut", () => {
  it("uses the microphone toggle and rechecks eligibility at delivery", () => {
    const owner = setup();
    owner.press();
    owner.press();
    expect(owner.toggle).toHaveBeenCalledTimes(2);
    owner.setEligible(false);
    owner.press();
    expect(owner.toggle).toHaveBeenCalledTimes(2);
  });

  it("releases a registration that completes after unmount and rejects late events", async () => {
    const owner = setup();
    owner.dispose();
    owner.register();
    await Promise.resolve();
    owner.press();
    expect(owner.release).toHaveBeenCalledOnce();
    expect(owner.toggle).not.toHaveBeenCalled();
  });

  it("unsubscribes once on normal disposal", async () => {
    const owner = setup();
    owner.register();
    await Promise.resolve();
    owner.dispose();
    owner.dispose();
    owner.press();
    expect(owner.release).toHaveBeenCalledOnce();
    expect(owner.toggle).not.toHaveBeenCalled();
  });

  it("reports live action errors but not errors after disposal", async () => {
    const owner = setup();
    owner.toggle.mockRejectedValueOnce(new Error("failed"));
    owner.press();
    await Promise.resolve();
    expect(owner.onError).toHaveBeenCalledOnce();
    owner.toggle.mockRejectedValueOnce(new Error("late"));
    owner.press();
    owner.dispose();
    await Promise.resolve();
    expect(owner.onError).toHaveBeenCalledOnce();
  });

  it("contains listener registration failures", async () => {
    const onError = vi.fn();
    const failure = new Error("registration failed");
    attachDictationShortcut({
      listen: () => Promise.reject(failure),
      canToggle: () => true,
      setNativeEnabled: vi.fn(),
      toggle: vi.fn(),
      onError,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("does not intercept before the frontend listener is ready", async () => {
    const owner = setup();
    owner.setEnabled(true);
    await Promise.resolve();
    expect(owner.setNativeEnabled).not.toHaveBeenCalled();
    owner.register();
    await vi.waitFor(() => expect(owner.setNativeEnabled).toHaveBeenCalledWith(true));
    owner.dispose();
    await vi.waitFor(() => expect(owner.setNativeEnabled).toHaveBeenLastCalledWith(false));
  });

  it("never enables a listener disposed during registration", async () => {
    const owner = setup();
    owner.setEnabled(true);
    owner.dispose();
    owner.register();
    await Promise.resolve();
    await Promise.resolve();
    expect(owner.setNativeEnabled).not.toHaveBeenCalled();
  });

  it("serializes teardown after an in-flight native enable", async () => {
    const owner = setup();
    let complete!: () => void;
    owner.setNativeEnabled.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    owner.setEnabled(true);
    owner.register();
    await vi.waitFor(() => expect(owner.setNativeEnabled).toHaveBeenCalledWith(true));
    owner.dispose();
    expect(owner.setNativeEnabled).toHaveBeenCalledTimes(1);
    complete();
    await vi.waitFor(() => expect(owner.setNativeEnabled).toHaveBeenLastCalledWith(false));
  });
});
