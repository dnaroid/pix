import { describe, expect, it } from "vitest";
import {
  isTypeaheadKey,
  linearFocusIndex,
  menuFocusIndex,
  menuTypeaheadFocusIndex,
  typeaheadFocusIndex,
} from "./keyboard-navigation";

describe("linearFocusIndex", () => {
  it("moves on the configured axis and supports Home/End", () => {
    expect(linearFocusIndex(1, "ArrowDown", 4, "vertical")).toBe(2);
    expect(linearFocusIndex(1, "ArrowUp", 4, "vertical")).toBe(0);
    expect(linearFocusIndex(1, "ArrowRight", 4, "vertical")).toBeNull();
    expect(linearFocusIndex(2, "Home", 4, "vertical")).toBe(0);
    expect(linearFocusIndex(1, "End", 4, "horizontal")).toBe(3);
  });

  it("wraps or clamps at the ends", () => {
    expect(linearFocusIndex(3, "ArrowDown", 4, "vertical", true)).toBe(0);
    expect(linearFocusIndex(0, "ArrowUp", 4, "vertical", true)).toBe(3);
    expect(linearFocusIndex(3, "ArrowDown", 4, "vertical", false)).toBe(3);
    expect(linearFocusIndex(0, "ArrowUp", 4, "vertical", false)).toBe(0);
  });
});

describe("typeaheadFocusIndex", () => {
  it("wraps from the current item and matches case-insensitively", () => {
    const labels = ["README.md", "src", "Scripts", "package.json"];
    expect(typeaheadFocusIndex(labels, 0, "s")).toBe(1);
    expect(typeaheadFocusIndex(labels, 1, "s")).toBe(2);
    expect(typeaheadFocusIndex(labels, 3, "r")).toBe(0);
  });
});

describe("menu navigation", () => {
  const items = [
    { label: "Copy" },
    { label: "Fork", disabled: true },
    { label: "Open" },
    { label: "Undo" },
  ];

  it("skips disabled items while wrapping", () => {
    expect(menuFocusIndex(items, 0, "ArrowDown")).toBe(2);
    expect(menuFocusIndex(items, 2, "ArrowUp")).toBe(0);
    expect(menuFocusIndex(items, 3, "ArrowDown")).toBe(0);
    expect(menuFocusIndex(items, 0, "End")).toBe(3);
  });

  it("type-ahead ignores disabled matches", () => {
    expect(menuTypeaheadFocusIndex(items, 0, "f")).toBeNull();
    expect(menuTypeaheadFocusIndex(items, 0, "o")).toBe(2);
  });
});

describe("isTypeaheadKey", () => {
  it("accepts printable unmodified keys only", () => {
    expect(isTypeaheadKey({ key: "a", altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent)).toBe(true);
    expect(isTypeaheadKey({ key: " ", altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent)).toBe(false);
    expect(isTypeaheadKey({ key: "a", altKey: false, ctrlKey: true, metaKey: false } as KeyboardEvent)).toBe(false);
  });
});
