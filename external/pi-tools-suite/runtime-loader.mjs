import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

const ROOT = new URL("./", import.meta.url);
const safePath = (path) => typeof path === "string" && !/[%:#?]/u.test(path) && !path.startsWith("/")
	&& !path.includes("\\") && path.split("/").every((part) => part && part !== "." && part !== "..");

/** Revalidate per factory/reload; source edits must never silently run stale code. */
export async function suiteRuntimeCurrent(root = ROOT) {
	try {
		const manifest = JSON.parse(await readFile(new URL("build/runtime/manifest.json", root), "utf8"));
		if (manifest.version !== 1 || !safePath(manifest.entry) || !manifest.entry.startsWith("build/runtime/") || !manifest.entry.endsWith(".mts")
			|| !Array.isArray(manifest.outputs) || !manifest.outputs.includes(manifest.entry)
			|| !manifest.inputs || typeof manifest.inputs !== "object") return undefined;
		if (!["index.ts", "runtime-loader.mjs", "src/index.ts", "src/module-catalog.ts"]
			.every((path) => typeof manifest.inputs[path] === "string")) return undefined;
		const inputs = Object.entries(manifest.inputs);
		// Bound file work and descriptors, including when an installed manifest is invalid.
		if (!inputs.length || inputs.length > 2000 || manifest.outputs.length > 500) return undefined;
		for (let offset = 0; offset < inputs.length; offset += 16) {
			const current = await Promise.all(inputs.slice(offset, offset + 16).map(async ([path, expected]) => {
				if (!safePath(path) || typeof expected !== "string") return false;
				const bytes = await readFile(new URL(path, root));
				return createHash("sha256").update(bytes).digest("hex") === expected;
			}));
			if (current.some((value) => !value)) return undefined;
		}
		await Promise.all(manifest.outputs.map(async (path) => {
			if (!safePath(path) || !path.startsWith("build/runtime/")) throw new Error("Invalid runtime output");
			await access(new URL(path, root));
		}));
		return manifest.entry;
	} catch { return undefined; }
}

export function warnSourceRuntime() {
	const message = "pi-tools-suite: runtime build missing or stale; loading source (run npm run build:tools-suite in Pix).";
	console.warn(message);
	try {
		const sink = globalThis[Symbol.for("pix.diagnostics.sink")];
		if (typeof sink === "function") void Promise.resolve(sink("warn", "suite:source-runtime", {},
			{ project: process.cwd(), module: "tools-suite" })).catch(() => {});
	} catch { /* Optional diagnostics must not affect extension loading. */ }
}
