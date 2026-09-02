/**
 * ACP session configuration options (`configOptions`) backed by pi's model
 * and thinking-level RPC commands.
 *
 * Two options are exposed:
 *   - `model`         (category "model"): provider/id selector, grouped by
 *                     provider, mapped to `set_model`.
 *   - `thought_level` (category "thought_level"): mapped to
 *                     `set_thinking_level` for the current model.
 *
 * Clients discover the options in `session/new`/`session/load` responses and
 * change them via `session/set_config_option`.
 */

import type { SessionConfigOption, SessionConfigSelectGroup, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { PiClient, PiModel, PiSessionState } from "../pi/pi-rpc-client.js";

export const CONFIG_ID_MODEL = "model";
export const CONFIG_ID_THOUGHT_LEVEL = "thought_level";

/** Canonical value for a model option: `provider/modelId`. */
export function modelValue(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

export function parseModelValue(value: string): { provider: string; modelId: string } | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

/**
 * Build the full config option set from pi state. Never throws for missing
 * state: options whose prerequisites are unavailable are simply omitted.
 */
export async function buildConfigOptions(pi: PiClient): Promise<SessionConfigOption[]> {
	const [state, models, levels] = await Promise.all([
		pi.getState(),
		pi.getAvailableModels(),
		pi.getAvailableThinkingLevels(),
	]);

	const options: SessionConfigOption[] = [];
	if (state.model && models.length > 0) {
		options.push(modelOption(state, models));
	}
	if (levels.length > 0) {
		options.push(thoughtLevelOption(state, levels));
	}
	return options;
}

function modelOption(state: PiSessionState, models: readonly PiModel[]): SessionConfigOption {
	const groups = new Map<string, SessionConfigSelectOption[]>();
	for (const model of models) {
		const group = groups.get(model.provider) ?? [];
		group.push({
			value: modelValue(model.provider, model.id),
			name: model.name ?? model.id,
		});
		groups.set(model.provider, group);
	}
	// Sort groups by provider and options by label for a stable UI order.
	const grouped: SessionConfigSelectGroup[] = [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([provider, options]) => ({
			group: provider,
			name: provider,
			// Sort by value, not display name: locale collation of names is
			// not stable across environments (punctuation/space weighting).
			options: options.sort((a, b) => a.value.localeCompare(b.value)),
		}));

	return {
		type: "select",
		id: CONFIG_ID_MODEL,
		name: "Model",
		category: "model",
		currentValue: modelValue(state.model!.provider, state.model!.id),
		options: grouped,
	};
}

function thoughtLevelOption(state: PiSessionState, levels: readonly string[]): SessionConfigOption {
	const options: SessionConfigSelectOption[] = levels.map((level) => ({ value: level, name: level }));
	const current = levels.includes(state.thinkingLevel) ? state.thinkingLevel : levels[0]!;
	return {
		type: "select",
		id: CONFIG_ID_THOUGHT_LEVEL,
		name: "Thought level",
		category: "thought_level",
		currentValue: current,
		options,
	};
}

/**
 * Apply one `session/set_config_option` request to the pi session.
 * Throws `Error` with a client-visible message for unknown options/values.
 */
export async function applyConfigOption(
	pi: PiClient,
	configId: string,
	value: string,
): Promise<void> {
	switch (configId) {
		case CONFIG_ID_MODEL: {
			const parsed = parseModelValue(value);
			if (!parsed) {
				throw new Error(`invalid model value "${value}"; expected "provider/modelId"`);
			}
			await pi.setModel(parsed.provider, parsed.modelId);
			return;
		}
		case CONFIG_ID_THOUGHT_LEVEL: {
			const levels = await pi.getAvailableThinkingLevels();
			if (!levels.includes(value)) {
				throw new Error(`unknown thought level "${value}"; available: ${levels.join(", ")}`);
			}
			await pi.setThinkingLevel(value);
			return;
		}
		default:
			throw new Error(`unknown config option "${configId}"`);
	}
}
