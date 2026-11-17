import { describe, expect, it } from "vitest";
import {
  REGISTRY_MUTATION_TIMEOUT_MS,
  REGISTRY_REFRESH_TIMEOUT_MS,
  registryActionTimeoutMs,
} from "./acp-pix-extensions";
import { REGISTRY_GIT_NETWORK_TIMEOUT_MS, REGISTRY_LOCK_STALE_MS } from "../../../acp/src/registry/lock-timing";

describe("registryActionTimeoutMs", () => {
  it("bounds catalog refresh so the panel spinner always settles", () => {
    expect(registryActionTimeoutMs({ action: "refresh" })).toBe(REGISTRY_REFRESH_TIMEOUT_MS);
  });

  it("outlasts reclaiming a stale lock left by a killed ACP plus one fetch", () => {
    // Regression: a 90s refresh timeout expired before the 120s stale window,
    // so every open project showed a timeout after an unclean restart.
    expect(REGISTRY_REFRESH_TIMEOUT_MS).toBeGreaterThan(REGISTRY_LOCK_STALE_MS + REGISTRY_GIT_NETWORK_TIMEOUT_MS);
  });

  it("bounds mutations generously enough for lock wait and push", () => {
    expect(registryActionTimeoutMs({ action: "sync-project", scope: "project" })).toBe(REGISTRY_MUTATION_TIMEOUT_MS);
    expect(registryActionTimeoutMs({ action: "push", type: "skill", name: "pdf" })).toBe(REGISTRY_MUTATION_TIMEOUT_MS);
    expect(REGISTRY_MUTATION_TIMEOUT_MS).toBeGreaterThan(180_000);
  });

  it("leaves actions that wait on user dialogs unbounded", () => {
    expect(registryActionTimeoutMs({ action: "configure" })).toBeNull();
    expect(registryActionTimeoutMs({ action: "project-key" })).toBeNull();
    expect(registryActionTimeoutMs({ action: "tags", type: "skill", name: "pdf" })).toBeNull();
  });
});
