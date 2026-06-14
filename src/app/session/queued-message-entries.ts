import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { shortHash } from "../rendering/render-text.js";
import type { Entry, SubmittedUserMessage } from "../types.js";

export type QueuedEntry = Extract<Entry, { kind: "queued" }>;

export function sdkQueuedMessageEntries(session: AgentSession | undefined): QueuedEntry[] {
	const entries: QueuedEntry[] = [];

	for (const [index, text] of (session?.getSteeringMessages() ?? []).entries()) {
		entries.push({
			id: `queued-sdk-steering-${index}-${shortHash(text)}`,
			kind: "queued",
			mode: "steering",
			text,
			queueSource: "sdk-steering",
			queueIndex: index,
		});
	}

	for (const [index, text] of (session?.getFollowUpMessages() ?? []).entries()) {
		entries.push({
			id: `queued-sdk-follow-up-${index}-${shortHash(text)}`,
			kind: "queued",
			mode: "follow-up",
			text,
			queueSource: "sdk-follow-up",
			queueIndex: index,
		});
	}

	return entries;
}

export function deferredQueuedMessageEntries(messages: readonly SubmittedUserMessage[]): QueuedEntry[] {
	return messages.map((message, index) => ({
		id: `${message.id}-${index}`,
		kind: "queued",
		mode: "steering",
		text: message.displayText,
		queueSource: "deferred",
		queueIndex: index,
	}));
}

export function autoQueuedMessageEntries(messages: readonly SubmittedUserMessage[]): QueuedEntry[] {
	return messages.map((message, index) => ({
		id: `${message.id}-auto-${index}`,
		kind: "queued",
		mode: "steering",
		text: message.displayText,
		queueSource: "auto",
		queueIndex: index,
	}));
}

export function queuedMessageEntries(
	session: AgentSession | undefined,
	autoUserMessages: readonly SubmittedUserMessage[],
	deferredUserMessages: readonly SubmittedUserMessage[],
): QueuedEntry[] {
	return [
		...sdkQueuedMessageEntries(session),
		...autoQueuedMessageEntries(autoUserMessages),
		...deferredQueuedMessageEntries(deferredUserMessages),
	];
}
