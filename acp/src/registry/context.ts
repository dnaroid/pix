/** Desktop dialogs; no extension/runtime lifecycle is involved. */
export interface RegistryContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly ui: {
		confirm(title: string, message: string): Promise<boolean>;
		input(title: string, prefill?: string): Promise<string | undefined>;
		editor(title: string, prefill?: string): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
}

export interface RegistryExecutor {
	exec(command: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ stdout: string; stderr: string; code: number }>;
}

export function notify(ctx: RegistryContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

export async function confirmOverwrite(ctx: RegistryContext, title: string, message: string): Promise<boolean> {
	return ctx.hasUI && await ctx.ui.confirm(title, message);
}
