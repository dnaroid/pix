import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Add SDK codemode without replacing the host's direct tool selection. */
export default function codemode(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		// Child profiles deliberately preserve their explicit tool allowlist.
		if ([process.env.PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION, process.env.MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION]
			.some((value) => /^(1|true|yes|on)$/i.test(value?.trim() ?? ""))) return;

		// The CLI already registers this builtin; SDK hosts do not. Wait until
		// session_start so the complete host registry is available for deduplication.
		if (!pi.getAllTools().some((tool) => tool.name === "codemode")) {
			await createCodemodeExtension({ mode: "on" })(pi);
		}
		const active = pi.getActiveTools();
		if (!active.includes("codemode")) pi.setActiveTools([...active, "codemode"]);
	});
}
