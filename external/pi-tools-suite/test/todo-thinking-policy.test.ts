import { expect, test } from "bun:test";
import { clampTodoThinkingRange, isTodoThinkingPolicy, TODO_THINKING_LEVELS } from "../src/todo/thinking-policy.js";

test("validates ranges and rejects single-level strings", () => {
	for (const value of [{ min: "low", max: "medium" }, { min: "max", max: "max" }]) expect(isTodoThinkingPolicy(value)).toBe(true);
	for (const value of [null, [], "max", "turbo", { min: "high", max: "low" }, { min: "low" }]) expect(isTodoThinkingPolicy(value)).toBe(false);
});

test("clamps requested levels and retains supported choices inside the range", () => {
	const range = { min: "low", max: "medium" } as const;
	expect(TODO_THINKING_LEVELS.map((level) => clampTodoThinkingRange(TODO_THINKING_LEVELS, level, range)))
		.toEqual(["low", "low", "low", "medium", "medium", "medium", "medium"]);
	expect(clampTodoThinkingRange(TODO_THINKING_LEVELS, "off", { min: "max", max: "max" })).toBe("max");
});

test("sparse models never round above Max when a lower supported level exists", () => {
	expect(clampTodoThinkingRange(["low", "high", "max"], "medium", { min: "low", max: "high" })).toBe("high");
	expect(clampTodoThinkingRange(["low", "high", "max"], "medium", { min: "low", max: "medium" })).toBe("low");
	expect(clampTodoThinkingRange(["low", "high", "max"], "max", { min: "medium", max: "medium" })).toBe("low");
	expect(clampTodoThinkingRange(["off"], "high", { min: "low", max: "medium" })).toBe("off");
	expect(clampTodoThinkingRange(["low", "high", "max"], "off", { min: "off", max: "off" })).toBe("low");
});
