/**
 * Build script: generate JSON Schema files from TypeBox definitions.
 *
 * Usage:  npx tsx scripts/generate-schemas.ts [--check]
 *
 * Outputs:
 *   schemas/pix.json
 *   schemas/pi-tools-suite.json
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PixConfigSchema } from "../src/schemas/pix-schema.js";
import { PiToolsSuiteConfigSchema } from "../src/schemas/pi-tools-suite-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "..", "schemas");

mkdirSync(outDir, { recursive: true });

const checkOnly = process.argv.includes("--check");

const schemas = [
	{ name: "pix.json", schema: PixConfigSchema },
	{ name: "pi-tools-suite.json", schema: PiToolsSuiteConfigSchema },
];

let changed = false;

for (const { name, schema } of schemas) {
	const filePath = resolve(outDir, name);
	// TypeBox schemas are already plain JSON Schema objects — just serialize.
	const json = JSON.stringify(schema, null, 2) + "\n";
	const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;

	if (existing !== json) {
		changed = true;
		if (checkOnly) {
			console.error(`✗ ${filePath} is out of date. Run npm run generate-schemas.`);
		} else {
			writeFileSync(filePath, json, "utf8");
			console.log(`✓ updated ${filePath}`);
		}
	} else {
		console.log(`✓ unchanged ${filePath}`);
	}
}

if (checkOnly && changed) {
	process.exitCode = 1;
} else if (checkOnly) {
	console.log(`\nAll generated schemas are up to date.`);
} else {
	console.log(`\nGenerated ${schemas.length} schema(s) in ${outDir}/`);
}
