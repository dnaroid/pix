import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

import type { PixConfig } from "../../config.js";
import type { AppOptions } from "../types.js";
import { createPixRuntime } from "../runtime.js";

export type RegistryCommandResult = {
	lines: string[];
	errors: string[];
	statusText?: string;
};

export async function runRegistryCommandForeground(
	options: AppOptions,
	config: PixConfig,
	args: string,
): Promise<RegistryCommandResult> {
	const { modelRef: _modelRef, sessionPath: _sessionPath, ...baseOptions } = options;
	const commandConfig: PixConfig = { ...config };
	delete (commandConfig as Partial<PixConfig>).defaultModel;
	const runtime = await createPixRuntime(
		{ ...baseOptions, noSession: true },
		{ config: commandConfig },
	);
	const notifications: Array<{ message: string; type: "info" | "warning" | "error" }> = [];
	try {
		const runner = runtime.session.extensionRunner;
		const command = runner.getCommand("registry");
		if (!command) throw new Error("Resource registry extension is unavailable.");

		const ui = {
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			notify: (message: string, type: "info" | "warning" | "error" = "info") => { notifications.push({ message, type }); },
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
		} as unknown as ExtensionUIContext;
		runner.setUIContext(ui, "tui");
		runner.bindCommandContext({
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		} satisfies ExtensionCommandContextActions);

		const beforeMessages = runtime.session.messages.length;
		await command.handler(args, runner.createCommandContext());
		const statusText = registryStatusText(runtime.session.messages.slice(beforeMessages));
		return {
			lines: notifications.flatMap(({ message }) => message.split(/\r?\n/u)),
			errors: notifications.filter(({ type }) => type === "error").flatMap(({ message }) => message.split(/\r?\n/u)),
			...(statusText ? { statusText } : {}),
		};
	} finally {
		await runtime.dispose();
	}
}

function registryStatusText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message)) continue;
		if (message.customType !== "pix-system") continue;
		if (!isRecord(message.details) || message.details.kind !== "resource-registry-status") continue;
		if (typeof message.content === "string") return message.content;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
