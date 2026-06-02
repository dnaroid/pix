import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { CommandControllerHost } from "./command-host.js";
import { createId } from "../id.js";

export function getRuntime(host: CommandControllerHost, commandName: string): AgentSessionRuntime | undefined {
	const runtime = host.runtime();
	if (!runtime) {
		host.toast.error(`/${commandName} unavailable`);
		host.addEntry({ id: createId("error"), kind: "error", text: "Runtime is not initialized" });
		return undefined;
	}

	return runtime;
}

export function getIdleRuntime(host: CommandControllerHost, commandName: string): AgentSessionRuntime | undefined {
	const runtime = getRuntime(host, commandName);
	if (!runtime) return undefined;

	if (runtime.session.isStreaming) {
		host.toast.warning(`/${commandName} is unavailable while the agent is running`);
		return undefined;
	}

	return runtime;
}

export function parsePathArgument(argumentsText: string): string | undefined {
	const trimmed = argumentsText.trim();
	if (!trimmed) return undefined;

	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		const end = trimmed.indexOf(quote, 1);
		return end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
	}

	const whitespace = trimmed.search(/\s/);
	return whitespace < 0 ? trimmed : trimmed.slice(0, whitespace);
}
