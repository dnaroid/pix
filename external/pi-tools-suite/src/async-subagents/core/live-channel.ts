import * as path from "node:path";

export type LiveSendMode = "followUp" | "steer";

export interface LiveSendResult {
	/** Pi prompt disposition: "started" (new run in the same process) or "queued". */
	disposition: string;
}

/** Thrown when the channel's process is shutting down after agent_settled. */
export class LiveChannelClosingError extends Error {
	constructor() {
		super("sub-agent is finishing; resume it after completion");
		this.name = "LiveChannelClosingError";
	}
}

/**
 * In-process stdin channel to a running RPC sub-agent owned by this parent
 * process. Agents launched by another process have no channel.
 */
export interface LiveAgentChannel {
	readonly agentDir: string;
	isClosing(): boolean;
	/** Resolves once the agent finished (process completion committed). */
	readonly finished: Promise<void>;
	send(message: string, mode: LiveSendMode): Promise<LiveSendResult>;
}

const CHANNELS = new Map<string, LiveAgentChannel>();

function channelKey(agentDir: string): string {
	return path.resolve(agentDir);
}

export function registerLiveChannel(channel: LiveAgentChannel): void {
	CHANNELS.set(channelKey(channel.agentDir), channel);
}

export function unregisterLiveChannel(channel: LiveAgentChannel): void {
	const key = channelKey(channel.agentDir);
	if (CHANNELS.get(key) === channel) CHANNELS.delete(key);
}

export function getLiveChannel(agentDir: string): LiveAgentChannel | undefined {
	return CHANNELS.get(channelKey(agentDir));
}
