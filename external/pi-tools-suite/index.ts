import { suiteRuntimeCurrent, warnSourceRuntime } from "./runtime-loader.mjs";

export default async function piToolsSuite(pi: any) {
	const entry = await suiteRuntimeCurrent();
	if (!entry) warnSourceRuntime();
	// Keep this inside the SDK's jiti loader: native .mjs would bypass its SDK
	// aliases, create duplicate registries, and retain stale code across reloads.
	const module = entry ? await import(`./${entry}`) : await import("./src/index.ts");
	await module.default(pi);
}
