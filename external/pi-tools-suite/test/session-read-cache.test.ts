import { expect, test } from "bun:test";
import { SessionReadCache } from "../src/project-search/session-read-cache.mjs";

test("session snapshots invalidate revisions, copy values and enforce byte/entry bounds", () => {
  const cache = new SessionReadCache<{ text: string }>({ limit: 2, maxBytes: 30 });
  const value = { text: "a" }; cache.set("a", "v1", value); value.text = "mutated";
  const result = cache.get("a", "v1")!; expect(result.text).toBe("a"); result.text = "changed";
  expect(cache.get("a", "v1")!.text).toBe("a");
  cache.set("b", "v1", { text: "b" }); cache.get("a", "v1"); cache.set("c", "v1", { text: "c" });
  expect(cache.get("b", "v1")).toBeUndefined(); expect(cache.get("a", "v2")).toBeUndefined();
  cache.set("c", "v1", { text: "x".repeat(100) }); expect(cache.get("c", "v1")).toBeUndefined();
  const expired = new SessionReadCache({ ttlMs: 0 }); expired.set("x", "v1", {});
  expect(expired.get("x", "v1")).toBeUndefined();
});

test("the boundary budget retains two maximum-length Unicode text boundaries", () => {
  const cache = new SessionReadCache<{ firstText: string; finalText: string }>({ maxBytes: 32768 });
  const value = { firstText: "я".repeat(4096), finalText: "文".repeat(4096) };
  cache.set("session", "v1", value);
  expect(cache.get("session", "v1")).toEqual(value);
  cache.set("oversized", "v1", { firstText: "文".repeat(16384), finalText: "" });
  expect(cache.get("oversized", "v1")).toBeUndefined();
});
