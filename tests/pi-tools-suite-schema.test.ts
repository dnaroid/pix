import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";
import { Value } from "typebox/value";

import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../external/pi-tools-suite/src/default-pi-tools-suite-config.js";
import { PiToolsSuiteConfigSchema } from "../src/schemas/pi-tools-suite-schema.js";

function matchingSchema(schema: any, value: unknown): any {
	if (!Array.isArray(schema?.anyOf)) return schema;
	return schema.anyOf.find((candidate: any) => Value.Check(candidate, value)) ?? schema;
}

function assertTemplateKeysAreModeled(value: unknown, rawSchema: any, path = "$"): void {
	const schema = matchingSchema(rawSchema, value);
	if (Array.isArray(value)) {
		if (!schema?.items) return;
		for (const [index, item] of value.entries()) assertTemplateKeysAreModeled(item, schema.items, `${path}[${index}]`);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
		let childSchema = schema?.properties?.[key];
		if (!childSchema && schema?.patternProperties) {
			for (const [pattern, candidate] of Object.entries(schema.patternProperties)) {
				if (new RegExp(pattern).test(key)) {
					childSchema = candidate;
					break;
				}
			}
		}
		assert.ok(childSchema, `template key ${path}.${key} must be explicitly modeled by the schema`);
		assertTemplateKeysAreModeled(childValue, childSchema, `${path}.${key}`);
	}
}

describe("pi-tools-suite config schema", () => {
	it("models the explicit brainstorm roster and bounded round settings", () => {
		assert.equal(Value.Check(PiToolsSuiteConfigSchema, { brainstorm: { models: ["one/a", "two/b"], thinking: "high", timeoutSeconds: 600 } }), true);
		for (const brainstorm of [
			{ models: [] }, { models: ["one/a"] }, { models: ["one/a", "one/a"] },
			{ models: ["one/*", "two/b"] }, { models: ["one", "two/b"] },
			{ models: Array.from({ length: 7 }, (_, i) => `provider/m${i}`) },
			{ thinking: "turbo" }, { timeoutSeconds: 29 }, { timeoutSeconds: 1801 }, { timeoutSeconds: 90.5 },
		]) assert.equal(Value.Check(PiToolsSuiteConfigSchema, { brainstorm }), false);
	});

	it("does not advertise the removed Telegram connector", () => {
		assert.equal("telegramConnector" in PiToolsSuiteConfigSchema.properties, false);
	});

	it("does not advertise the removed result-shaping configuration", () => {
		assert.equal("contextGateway" in PiToolsSuiteConfigSchema.properties, false);
	});

	it("accepts the shipped full default template", () => {
		const template = parse(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC) as Record<string, unknown>;
		assert.equal(Value.Check(PiToolsSuiteConfigSchema, template), true);
		assertTemplateKeysAreModeled(template, PiToolsSuiteConfigSchema);
	});

	it("accepts todo thinking ranges and null but rejects single-level strings", () => {
		assert.equal(Value.Check(PiToolsSuiteConfigSchema, {
			todoThinkingOverrides: { "opus/*": { min: "low", max: "medium" }, "glm-*": { min: "max", max: "max" }, "inherited/*": null },
		}), true);
		for (const policy of ["max", { min: "low" }, { min: "low", max: "turbo" }]) {
			assert.equal(Value.Check(PiToolsSuiteConfigSchema, { todoThinkingOverrides: { "model/*": policy } }), false);
		}
	});

	it("accepts current DCP model overrides and percent-string thresholds", () => {
		assert.equal(Value.Check(PiToolsSuiteConfigSchema, {
			dcp: {
				modelOverrides: {
					"openai-codex/gpt-5*": {
						compress: {
							minContextPercent: "26%",
							maxContextPercent: "46%",
						},
					},
				},
			},
		}), true);
	});

	it("rejects known removed async-subagent and DCP config keys", () => {
		for (const value of [
			{ asyncSubagents: {} },
			{ dcp: { manualMode: { automaticStrategies: true } } },
			{ dcp: { strategies: { autoToolPruning: { enabled: true } } } },
			{ dcp: { pruneNotification: true } },
			{ dcp: { modelOverrides: { "*": { pruneNotification: true } } } },
		]) {
			assert.equal(Value.Check(PiToolsSuiteConfigSchema, value), false);
		}
	});
});
