import { expect, test } from "bun:test";
import { COMPRESS_TOOL_PARAMETERS } from "../../src/dcp/compress-tool.js";

test("compress parameters retain the real runtime JSON Schema, not a neighbouring module mock", () => {
	const schema = JSON.parse(JSON.stringify(COMPRESS_TOOL_PARAMETERS));
	expect(schema.type).toBe("object");
	expect(schema.required).toEqual(["topic"]);
	expect(schema.properties.topic.type).toBe("string");
	expect(schema.properties.ranges.type).toBe("array");
	expect(schema.properties.ranges.items.required).toEqual(["startId", "endId"]);
	expect(schema.properties.messages.items.required).toEqual(["messageId"]);
	expect(schema).not.toHaveProperty("kind");
	expect(schema.properties.ranges).not.toHaveProperty("schema");
});
