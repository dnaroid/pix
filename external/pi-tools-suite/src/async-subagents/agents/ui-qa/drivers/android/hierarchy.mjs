const MAX_XML = 2 * 1024 * 1024;
const ATTRIBUTE = /\s+([A-Za-z][\w-]*)="([^"<>]*)"/y;

function decode(value) {
	const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
	if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(value)) throw new Error("invalid XML entity");
	return value.replace(/&([^;]+);/g, (_, name) => {
		if (entities[name]) return entities[name];
		const n = name.startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1));
		if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff))) throw new Error("invalid XML character reference");
		return String.fromCodePoint(n);
	});
}

function escape(value) {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** @returns {{nodes: Record<string, string>[], xml: string, rotation: number, rotationPresent: boolean}} */
export function parseAndroidHierarchy(output) {
	if (Buffer.byteLength(output, "utf8") > MAX_XML) throw new Error("Android hierarchy exceeds limit");
	// DumpCommand reports a failed waitForIdle as stdout with exit code zero.
	// Classify only its exact fixed diagnostic, never screen text or raw dumps.
	if (output.trim() === "ERROR: could not get idle state.") throw new Error("Android UIAutomator idle timeout; hierarchy unavailable");
	let xml = output.trim().replace(/\s*UI (?:hierchary|hierarchy) dumped to: (?:\/dev\/tty|\/proc\/self\/fd\/1)\s*$/, "").trim();
	xml = xml.replace(/^<\?xml\s+version=(['"])1\.0\1\s+encoding=(['"])UTF-8\2(?:\s+standalone=(['"])(?:yes|no)\3)?\s*\?>\s*/i, "");
	const stack = [];
	const nodes = [];
	const safe = [];
	let offset = 0;
	let rootSeen = false;
	let rotation = 0;
	let rotationPresent = false;
	while (offset < xml.length) {
		const whitespace = /^\s*/.exec(xml.slice(offset))[0];
		offset += whitespace.length;
		if (offset === xml.length) break;
		const token = /^<(\/?)(hierarchy|node)\b([^<>]*?)(\/?)>/.exec(xml.slice(offset));
		if (!token) throw new Error("invalid Android hierarchy XML token");
		offset += token[0].length;
		const [, closing, tag, attributes, selfClosing] = token;
		if (closing) {
			if (attributes.trim() || selfClosing || stack.pop() !== tag) throw new Error("invalid XML closing tag");
			safe.push(`</${tag}>`);
			continue;
		}
		if (tag === "hierarchy") {
			if (rootSeen || stack.length) throw new Error("invalid hierarchy root");
			rootSeen = true;
		} else if (!stack.length || stack[0] !== "hierarchy") throw new Error("node outside hierarchy");
		/** @type {Record<string, string>} */
		const attrs = {};
		let pos = 0;
		while (pos < attributes.length && attributes.slice(pos).trim()) {
			ATTRIBUTE.lastIndex = pos;
			const match = ATTRIBUTE.exec(attributes);
			if (!match || Object.keys(attrs).length >= 40 || Object.hasOwn(attrs, match[1]) || match[2].length > 32768) throw new Error("invalid XML attributes");
			attrs[match[1]] = decode(match[2]);
			pos = ATTRIBUTE.lastIndex;
		}
		if (tag === "node") {
			if (nodes.length >= 5000) throw new Error("too many Android nodes");
			nodes.push(attrs);
		}
		if (tag === "hierarchy" && attrs.rotation !== undefined) {
			if (!/^[0-3]$/.test(attrs.rotation)) throw new Error("invalid Android hierarchy rotation");
			rotation = Number(attrs.rotation);
			rotationPresent = true;
		}
		const redacted = { ...attrs };
		if (attrs.password === "true") { redacted.text = "[REDACTED]"; redacted["content-desc"] = "[REDACTED]"; }
		safe.push(`<${tag}${Object.entries(redacted).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}${selfClosing ? "/" : ""}>`);
		if (!selfClosing) stack.push(tag);
		if (stack.length > 64) throw new Error("Android XML nesting exceeds limit");
	}
	if (!rootSeen || stack.length) throw new Error("incomplete Android hierarchy");
	return { nodes, xml: safe.join(""), rotation, rotationPresent };
}

export function rotatedAndroidSize(naturalSize, rotation) {
	if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3) throw new Error("invalid Android display rotation");
	return rotation % 2 ? { width: naturalSize.height, height: naturalSize.width } : naturalSize;
}

export function validateAndroidSelector(selector) {
	if (!selector || typeof selector !== "object" || Array.isArray(selector)
		|| Object.keys(selector).some((key) => !["text", "resourceId", "contentDesc", "index"].includes(key))
		|| !["text", "resourceId", "contentDesc"].some((key) => Object.hasOwn(selector, key))) throw new Error("Android selector requires exact text/resourceId/contentDesc");
	for (const key of ["text", "resourceId", "contentDesc"]) {
		if (Object.hasOwn(selector, key) && (typeof selector[key] !== "string" || !selector[key] || selector[key].length > 512)) throw new Error("invalid Android selector value");
	}
	if (selector.index !== undefined && (!Number.isInteger(selector.index) || selector.index < 0 || selector.index > 4999)) throw new Error("invalid Android selector index");
}

export function selectAndroidNodes(nodes, selector, packageName) {
	validateAndroidSelector(selector);
	const fields = { text: "text", resourceId: "resource-id", contentDesc: "content-desc" };
	const matches = nodes.filter((node) => node.package === packageName && node.password !== "true"
		&& Object.entries(fields).every(([key, attribute]) => selector[key] === undefined || node[attribute] === selector[key]));
	return selector.index === undefined ? matches : matches.slice(selector.index, selector.index + 1);
}

export function androidTapPoint(node, size) {
	const bounds = node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)?.slice(1).map(Number);
	if (node.enabled !== "true" || !bounds) throw new Error("Android target must be enabled with valid bounds");
	const [left, top, right, bottom] = bounds;
	if (left >= right || top >= bottom || right > size.width || bottom > size.height) throw new Error("Android bounds outside screen");
	return [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
}

export function validateAndroidPng(buffer, size) {
	if (buffer.length < 45 || buffer.length > 3 * 1024 * 1024 || buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
		|| buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR"
		|| buffer.toString("ascii", buffer.length - 8, buffer.length - 4) !== "IEND"
		|| buffer.readUInt32BE(16) !== size.width || buffer.readUInt32BE(20) !== size.height) throw new Error("invalid Android PNG or screen dimensions");
}
