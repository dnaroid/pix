import { EventEmitter } from "node:events";

import type { EventBus } from "@earendil-works/pi-coding-agent";

export type ExtensionEventForwarder = (channel: string, data: unknown) => void;

export function createIsolatedExtensionEventBus(forwardEmit?: ExtensionEventForwarder): EventBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0);

	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
			forwardEmit?.(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown): Promise<void> => {
				try {
					await handler(data);
				} catch (error) {
					console.error(`Event handler error (${channel}):`, error);
				}
			};

			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
	};
}
