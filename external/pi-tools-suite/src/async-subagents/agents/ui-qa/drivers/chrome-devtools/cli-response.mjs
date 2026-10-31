// Never publish raw CLI output: tool errors can contain private URLs or tokens.
export function decodeCliResponse(stdout, command) {
	const fail = (reason) => { throw new Error(`chrome-devtools ${command} ${reason}`); };
	const text = stdout.trim();
	if (!text) return fail("returned an empty response");
	let parsed;
	try {
		parsed = JSON.parse(text.split(/\r?\n/).filter(Boolean).pop());
	} catch {
		return fail("returned invalid JSON");
	}
	// CLI 1.9 serializes MCP isError content as an array despite exit code 0.
	if (Array.isArray(parsed) && parsed.some((entry) => entry?.type === "text" && typeof entry.text === "string")) {
		return fail("reported an MCP tool error (details withheld for privacy)");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return fail("returned unsupported response data");
	}
	if (parsed.isError === true) return fail("reported an MCP tool error (details withheld for privacy)");
	if (command === "new_page" || command === "list_pages") {
		if (!Array.isArray(parsed.pages) || parsed.pages.length === 0 || parsed.pages.some((page) =>
			!page || !Number.isInteger(page.id) || page.id < 0 || typeof page.url !== "string"
		)) return fail("returned missing or invalid page records");
	}
	return parsed;
}
