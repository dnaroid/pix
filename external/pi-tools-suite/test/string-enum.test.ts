import { expect, test } from "bun:test";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "../src/lib/string-enum.js";

test("string enums preserve provider schema shape and TypeBox validation", () => {
	const schema = Type.Object({ mode: Type.Optional(StringEnum(["run", "scan"] as const, { description: "Mode", default: "run" })) });
	const params: Static<typeof schema> = { mode: "scan" };
	expect(schema.properties.mode).toEqual({ type: "string", enum: ["run", "scan"], description: "Mode", default: "run" });
	expect(Value.Check(schema, params)).toBe(true);
	expect(Value.Check(schema, {})).toBe(true);
	expect(Value.Check(schema, { mode: "invalid" })).toBe(false);
});
