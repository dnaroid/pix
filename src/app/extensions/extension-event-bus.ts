import { EventEmitter } from "node:events";

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { logPixEvent } from "../logger.js";

export type ExtensionEventForwarder = (channel: string, data: unknown) => void;

export function createIsolatedExtensionEventBus(forwardEmit?: ExtensionEventForwarder, project?: () => string | undefined): EventBus {
	const emitter = new EventEmitter();
	emitter.setMaxListeners(0);

	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
			forwardEmit?.(channel, data);
		},
			on: (channel, handler) => {
			const safeHandler = async (data: unknown): Promise<void> => {
				const workspace = project?.();
				try {
					await handler(data);
				} catch (error) {
					logPixEvent("error", "extensions:handler-failed", { channel, error }, { module: "extension-event-bus", ...(workspace ? { project: workspace } : {}) });
				}
			};

			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
	};
}
