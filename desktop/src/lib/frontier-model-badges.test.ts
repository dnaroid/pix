import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { createFrontierBadgeStore, frontierBadgeConfig, hasFrontierBadge } from "./frontier-model-badges";
import picker from "../components/ModelThinkingPicker.svelte?raw";
import statusBar from "../components/StatusBar.svelte?raw";
import badge from "../components/FrontierModelBadge.svelte?raw";
import settings from "./settings.ts?raw";
import preview from "../app/preview-file-io.ts?raw";

describe("frontier model crowns", () => {
  it("uses configured refs, normalized IDs and aliases, excluding disabled entries and Auto", () => {
    const config = frontierBadgeConfig(JSON.stringify({ economy: true, frontierModels: [
      { model: "vendor/frontier", expensive: true, roles: ["oracle"], aliases: ["*alias*"] },
      { model: "vendor/disabled", enabled: false },
      "pix:auto",
    ] }))!;
    for (const ref of ["vendor/frontier", "other/~FRONTIER", "other/alias-release"]) {
      expect(hasFrontierBadge(ref, config)).toBe(true);
    }
    for (const ref of ["vendor/disabled", "vendor/ordinary", "pix:auto"]) {
      expect(hasFrontierBadge(ref, config)).toBe(false);
    }
  });

  it("uses runtime defaults only for omitted lists, preserving explicit empty lists", () => {
    expect(frontierBadgeConfig("{/* omitted */}")!.models.length).toBeGreaterThan(0);
    expect(frontierBadgeConfig('{"frontierModels": []}')!.models).toEqual([]);
    expect(frontierBadgeConfig("{broken")).toBeUndefined();
  });

  it("coalesces reads and does not overwrite saved settings with an older completion", async () => {
    let resolve!: (value: string) => void;
    let reads = 0;
    const store = createFrontierBadgeStore(() => {
      reads += 1;
      return new Promise<string>((done) => { resolve = done; });
    });
    const request = store.refresh();
    expect(store.refresh()).toBe(request);
    expect(reads).toBe(1);
    store.publish('{"frontierModels": ["vendor/new"]}');
    resolve('{"frontierModels": ["vendor/old"]}');
    await request;
    expect(hasFrontierBadge("vendor/new", get(store))).toBe(true);
    expect(hasFrontierBadge("vendor/old", get(store))).toBe(false);
  });

  it("keeps last known state on failed reads and malformed settings", async () => {
    const store = createFrontierBadgeStore(async () => { throw new Error("offline"); });
    expect(get(store).models).toEqual([]);
    store.publish('{"frontierModels": ["vendor/frontier"]}');
    await store.refresh();
    store.publish("{broken");
    expect(hasFrontierBadge("vendor/frontier", get(store))).toBe(true);
  });

  it("wires the same accessible Lucide badge into both surfaces and saved settings paths", () => {
    expect(picker).toContain('<FrontierModelBadge modelRef={model.ref} />');
    expect(statusBar).toContain('<FrontierModelBadge modelRef={modelThinking.currentModel.ref} />');
    expect(badge).toContain('@lucide/svelte/icons/crown');
    expect(badge).toContain('aria-label="Frontier model"');
    expect(settings).toContain('frontierBadges.publish(draft.savedSource)');
    expect(preview).toContain('frontierBadges.publish(result.document.content)');
  });
});
