import type { SystemMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HEADER = "Pi documentation \\(read only when the user asks about pi itself";
const TAGGED_DOCS = new RegExp(`<docs>\\s*${HEADER}[^\\n]*\\n[\\s\\S]*?</docs>[ \\t]*(?:\\r?\\n)?`, "g");
const LEGACY_DOCS = new RegExp(`^${HEADER}[^\\n]*\\r?\\n(?:- [^\\r\\n]*(?:\\r?\\n|$))+(?:\\r?\\n)?`, "gm");
const PROTECTED_SECTIONS = /(<(?:project_context|project_instructions|skills|available_skills|addendum)(?:\s[^>]*)?>[\s\S]*?<\/(?:project_context|project_instructions|skills|available_skills|addendum)>)/g;

/** Remove only the SDK documentation boilerplate, not project/skill instructions. */
export function stripUpstreamPiDocs(prompt: string): string {
	return prompt.split(PROTECTED_SECTIONS).map((part, index) => index % 2 === 1
		? part
		: part.replace(TAGGED_DOCS, "").replace(LEGACY_DOCS, "")
	).join("");
}

export function sanitizeSystemPrompt(message: SystemMessage): SystemMessage {
	const content = typeof message.content === "string"
		? stripUpstreamPiDocs(message.content)
		: message.content.map((block) => ({ ...block, text: stripUpstreamPiDocs(block.text) }));
	const docs = message.sections?.docs;
	// A null section removes earlier SDK docs patches too, without flattening tools
	// or other sections into an opaque forceSystemPrompt override.
	const sections = typeof docs === "string" && stripUpstreamPiDocs(docs) !== docs
		? { ...message.sections, docs: null }
		: message.sections;
	return { ...message, content, ...(sections ? { sections } : {}) };
}

/** Run after prompt reconstruction, for every provider/model and every request. */
export function registerPromptSanitizer(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		// SDK projects an existing forced prompt after context_with_system hooks.
		// Sanitize that override too, without making structured prompts opaque.
		const forced = event.systemPromptOptions.forceSystemPrompt;
		if (forced !== undefined) event.systemPromptOptions.forceSystemPrompt = stripUpstreamPiDocs(forced);
	});
	pi.on("context_with_system", (event) => ({
		messages: event.messages.map((message) => message.role === "system" ? sanitizeSystemPrompt(message) : message),
	}));
}
