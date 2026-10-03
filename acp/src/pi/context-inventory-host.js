const INVENTORY_CHANNEL = "pi-tools-suite:context-inventory";
const STATE_WIDGET = "pix.session-state";

/** Add host-owned loader state at the supported RPC widget transport boundary. */
export function installContextInventoryHost(AgentSession) {
	const original = AgentSession.prototype.bindExtensions;
	const originalUIs = new WeakMap();
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
		const contextFiles = [...new Set(files.map((file) => file.path.trim()).filter(Boolean))];
		return [lines[0], JSON.stringify({ ...state, contextFiles })];
	} catch {
		// Preserve the legacy payload if loader state or the envelope is unavailable.
		return lines;
	}
}
