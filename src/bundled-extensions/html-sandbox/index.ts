import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { advertiseHtmlSandbox, HTML_SANDBOX_GUIDE, HTML_SANDBOX_TOOL_DESCRIPTION } from "./guide.js";

/**
 * Bundled only for Pix Desktop RPC sessions. The short capability note goes
 * into the current turn's system prompt; details are fetched on demand.
 */
export default function htmlSandboxExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pix_html_sandbox_guide",
		label: "Pix HTML Sandbox guide",
		description: HTML_SANDBOX_TOOL_DESCRIPTION,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text: HTML_SANDBOX_GUIDE }], details: {} };
		},
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.mode !== "rpc") return;
		return { systemPrompt: advertiseHtmlSandbox(event.systemPrompt) };
	});
}
