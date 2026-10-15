import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const INVENTORY_CHANNEL = "pi-tools-suite:context-inventory";
const STATE_WIDGET = "pix.session-state";

/** Add host-owned loader state at the supported RPC widget transport boundary. */
export function installContextInventoryHost(AgentSession, options = {}) {
	const original = AgentSession.prototype.bindExtensions;
	const originalUIs = new WeakMap();
	const requestedPath = options.privateAgentsPath ?? process.env.PIX_PROJECT_AGENTS_FILE;
	// The ACP host sets this for the current workspace only. Do not accept an
	// inherited/stale process environment as authority to load another file.
	const privateAgentsPath = options.privateAgentsPath
		?? (!process.argv.includes("--no-context-files")
			&& requestedPath
			&& resolve(requestedPath) === join(process.cwd(), ".pi", "AGENTS.md")
				? requestedPath : undefined);
	// Install before Pi constructs AgentSession: its constructor snapshots the
	// first system prompt before bindExtensions runs. This public loader getter
	// is also used by subsequent prompt rebuilds and by the inventory below.
	if (privateAgentsPath && options.DefaultResourceLoader?.prototype?.getAgentsFiles) {
		const prototype = options.DefaultResourceLoader.prototype;
		const baseGetAgentsFiles = prototype.getAgentsFiles;
		let reportedFailure;
		prototype.getAgentsFiles = function getProjectAgentsFiles(...args) {
			const base = baseGetAgentsFiles.apply(this, args);
			try {
				if (!statSync(privateAgentsPath).isFile()) return base;
				const content = readFileSync(privateAgentsPath, "utf8").replace(/^\uFEFF/, "");
				reportedFailure = undefined;
				return base.agentsFiles.some((file) => file.path === privateAgentsPath)
					? base : { agentsFiles: [...base.agentsFiles, { path: privateAgentsPath, content }] };
			} catch (error) {
				if (error?.code === "ENOENT") reportedFailure = undefined;
				if (error?.code !== "ENOENT" && reportedFailure !== error?.code) {
					reportedFailure = error?.code;
					options.onReadError?.(privateAgentsPath, error);
				}
				return base;
			}
		};
	}
	AgentSession.prototype.bindExtensions = function bindContextInventory(bindings) {
		const ui = originalUIs.get(bindings.uiContext) ?? bindings.uiContext;
		if (!ui?.setWidget) return original.call(this, bindings);
		const session = this;
		const wrappedUI = {
			...ui,
			setWidget(key, lines, ...options) {
				return ui.setWidget(key, withContextFiles(session, key, lines), ...options);
			},
		};
		// Replacement runtimes may reuse an existing UI; do not retain the old session.
		originalUIs.set(wrappedUI, ui);
		return original.call(this, { ...bindings, uiContext: wrappedUI });
	};
}

function withContextFiles(session, key, lines) {
	if (key !== STATE_WIDGET || lines?.[0] !== INVENTORY_CHANNEL) return lines;
	try {
		const state = JSON.parse(lines[1]);
		if (!state || state.version !== 1) return lines;
		// Read on each event: reload and workspace replacement must never reuse a snapshot.
		const files = session.resourceLoader.getAgentsFiles().agentsFiles;
		// Other file-backed prompt addenda are context too. Report paths, not contents.
		const appendFiles = session.resourceLoader.getAppendSystemPromptSources?.() ?? [];
		const contextFiles = [...new Set([...files, ...appendFiles].map((file) => file.path.trim()).filter(Boolean))];
		return [lines[0], JSON.stringify({ ...state, contextFiles })];
	} catch {
		// Preserve the legacy payload if loader state or the envelope is unavailable.
		return lines;
	}
}
