const LOCATOR_ACTIONS = new Set([
	"click", "fill", "waitFor", "assertVisible", "assertHidden", "assertText", "assertValue", "assertCount",
]);
const MATCH_ACTIONS = new Set(["assertText", "assertValue", "assertURL"]);
const OTHER_ACTIONS = new Set(["goto", "reload", "assertURL", "screenshot"]);

export function compileBrowserFlow(flow, { probe = false } = {}) {
	const { target, steps = [] } = flow;
	// Reject the old contracts instead of silently treating an isolated test as
	// a shared-profile one. No settings or credentials are read from disk.
	for (const key of Object.keys(target)) {
		if (!["kind", "url", "baseUrl"].includes(key)) return { unsupported: `target.${key}` };
	}
	for (const key of Object.keys(flow)) {
		if (!["version", "target", "steps", "timeoutMs"].includes(key)) return { unsupported: key };
	}
	if (target.url !== undefined && target.baseUrl !== undefined) throw new Error("choose target.url or target.baseUrl, not both");
	const baseUrl = httpUrl(target.url ?? target.baseUrl);
	const origin = new URL(baseUrl).origin;
	const { timeoutMs } = flow;
	if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 100_000)) {
		throw new Error("browser timeoutMs must be an integer from 100 to 100000");
	}
	if (!Array.isArray(steps) || (!probe && steps.length === 0)) throw new Error("browser flow requires steps");
	const compiled = [];
	for (const [index, step] of steps.entries()) {
		const where = `browser step ${index + 1}`;
		if (!record(step) || typeof step.action !== "string") throw new Error(`${where} requires an action`);
		const { action } = step;
		if (!LOCATOR_ACTIONS.has(action) && !OTHER_ACTIONS.has(action)) return { unsupported: `${where} action` };
		const keys = new Set(["action"]);
		const spec = { action };
		if (LOCATOR_ACTIONS.has(action)) {
			keys.add("locator");
			const { locator } = step;
			if (!record(locator) || Object.keys(locator).length !== 1) throw new Error(`${where} requires one locator`);
			const [key] = Object.keys(locator);
			if (!["css", "testId"].includes(key)) return { unsupported: `${where} locator type` };
			spec.locator = { [key]: bounded(locator[key], 512, `${where} locator`) };
		}
		if (MATCH_ACTIONS.has(action)) {
			keys.add("equals").add("includes");
			const operators = ["equals", "includes"].filter((key) => Object.hasOwn(step, key));
			if (operators.length !== 1) throw new Error(`${where} requires exactly one of equals or includes`);
			const [op] = operators;
			spec[op] = bounded(step[op], 4096, `${where} matcher`, op === "equals");
		}
		if (action === "waitFor") {
			keys.add("state");
			spec.state = step.state ?? "visible";
			if (!["visible", "hidden", "attached", "detached"].includes(spec.state)) throw new Error(`${where} invalid waitFor state`);
		}
		if (action === "fill") {
			keys.add("value");
			spec.value = bounded(step.value, 4096, `${where} fill value`, true);
		}
		if (action === "goto") {
			keys.add("url");
			spec.url = httpUrl(step.url, baseUrl);
			if (new URL(spec.url).origin !== origin) return { unsupported: `${where} cross-origin navigation` };
		}
		if (action === "screenshot") {
			keys.add("name");
			if (step.name !== undefined && (typeof step.name !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(step.name))) {
				throw new Error(`${where} invalid screenshot name`);
			}
			spec.name = `${String(index + 1).padStart(3, "0")}-${step.name ?? "chrome"}.png`;
		}
		if (action === "assertCount") {
			keys.add("count");
			if (!Number.isSafeInteger(step.count) || step.count < 0) throw new Error(`${where} requires a non-negative count`);
			spec.count = step.count;
		}
		if (Object.keys(step).some((key) => !keys.has(key))) return { unsupported: `${where} options` };
		compiled.push(spec);
	}
	return { baseUrl, origin, timeoutMs, steps: compiled };
}

function record(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function bounded(value, limit, label, allowEmpty = false) {
	if (typeof value !== "string" || value.length > limit || (!allowEmpty && !value.trim())) throw new Error(`${label} is invalid`);
	return value;
}

function httpUrl(value, base) {
	const input = bounded(value, 4096, "browser URL");
	let url;
	try { url = new URL(input, base); } catch { throw new Error("invalid browser URL"); }
	if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("browser URL must use HTTP(S) without credentials");
	return url.href;
}

/** @param {string} origin @param {Record<string, unknown>} [step] */
export function pageSource(origin, step) {
	return `(${actInPage})(${JSON.stringify(origin)},${JSON.stringify(step ?? { action: "ready" })})`;
}

// Return only fixed status tokens so page contents don't enter QA artifacts.
function actInPage(origin, step) {
	if (location.origin !== origin) return "outside-origin";
	if (document.readyState === "loading") return "not-ready";
	const { action, locator } = step;
	if (action === "ready") return "ok";
	const match = (value) => typeof value === "string" &&
		(step.equals !== undefined ? value === step.equals : value.includes(step.includes));
	const result = (ok) => ok ? "ok" : "mismatch";
	if (action === "assertURL") return result(match(location.href));
	let nodes;
	try {
		nodes = document.querySelectorAll(locator.css ?? `[data-testid="${CSS.escape(locator.testId)}"]`);
	} catch { return "invalid-locator"; }
	if (action === "assertCount") return result(nodes.length === step.count);
	if (nodes.length > 1) return "ambiguous";
	const el = nodes[0];
	const visible = !!el?.getClientRects().length && getComputedStyle(el).visibility === "visible";
	switch (action) {
		case "waitFor": return result({ visible, hidden: !visible, attached: !!el, detached: !el }[step.state]);
		case "assertVisible": return result(visible);
		case "assertHidden": return result(!visible);
		case "assertText": return result(visible && match(el.innerText));
		case "assertValue": return result(visible && match(el.value));
		default: break;
	}
	if (!visible || el.matches(":disabled,[aria-disabled=true]")) return "mismatch";
	if (action === "click") {
		const link = el.closest("a[href]");
		const form = el.form;
		const submitter = form && /^(submit|image)$/.test(el.type);
		const baseTarget = document.querySelector("base[target]")?.target;
		const sameTab = (target) => !target || target.toLowerCase() === "_self";
		const sameWebOrigin = (value) => {
			const url = new URL(value, document.baseURI);
			return /^https?:$/.test(url.protocol) && url.origin === origin && !url.username && !url.password;
		};
		if ((link && (link.hasAttribute("download") || !sameTab(link.target || baseTarget) || !sameWebOrigin(link.href))) ||
			(submitter && (!sameTab(el.getAttribute("formtarget") || form.target || baseTarget) ||
				!sameWebOrigin(el.getAttribute("formaction") || form.action || location.href)))) {
			return "unsupported-interaction";
		}
		el.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (typeof el.click !== "function") return "unsupported-interaction";
		el.click();
		return "ok";
	}
	if (el.readOnly || !el.matches("input:is([type=text],[type=search],[type=email],[type=url],[type=tel],[type=number],:not([type])),textarea")) {
		return "unsupported-interaction";
	}
	el.focus();
	const proto = el.localName === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, step.value);
	el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return "ok";
}
