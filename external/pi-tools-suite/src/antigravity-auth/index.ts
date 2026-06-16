import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../context-usage";
import { decodeApiKey, getEffectiveProjectId } from "./auth-store";
import { formatAddAccountResult, parseAddAccountCommandArgs } from "./commands";
import { API_ID, DEFAULT_PROJECT_ID, ENDPOINT_DAILY, PROVIDER_ID } from "./constants";
import { modelDefinitions } from "./models";
import { addAntigravityAccount, loginAntigravity, refreshAntigravityToken } from "./oauth";
import { emitAntigravityStatus, getCurrentAntigravityStatus, notifyAntigravityLoginFailure, notifyAntigravityProviderFailure, publishAntigravityAuthStartupSection, rememberAntigravityApi, rememberAntigravityUi } from "./status";
import { streamAntigravity } from "./stream";

export { addAntigravityAccount } from "./oauth";
export type { AntigravityAddAccountResult } from "./types";

async function staleSafe(action: () => void | Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		ignoreStaleExtensionContextError(error);
	}
}

export default async function antigravityAuth(pi: ExtensionAPI): Promise<void> {
	rememberAntigravityApi(pi);
	await publishAntigravityAuthStartupSection();

	if (typeof pi.on === "function") {
		pi.on("turn_start", (_event, ctx) => {
			rememberAntigravityUi(ctx.ui);
		});
		pi.on("before_provider_request", (_event, ctx) => {
			rememberAntigravityUi(ctx.ui);
		});
		pi.on("message_end", (event, ctx) => {
			rememberAntigravityUi(ctx.ui);
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== PROVIDER_ID || message.stopReason !== "error" || !message.errorMessage) return;
			notifyAntigravityProviderFailure(message.errorMessage, { ui: ctx.ui, model: message.model });
		});
	}

	pi.registerCommand("antigravity-add-account", {
		description: "Add a new Google Antigravity OAuth account to the Pi rotation pool",
		handler: async (args: string, ctx: any) => {
			rememberAntigravityUi(ctx.ui);
			let authUrl = "";
			try {
				const options = parseAddAccountCommandArgs(args);
				const result = await addAntigravityAccount(
					{
						onAuth: ({ url }) => {
							authUrl = url;
							void staleSafe(() => {
								ctx.ui?.notify?.(`Open this Antigravity OAuth URL, then paste the callback URL:\n${url}`, "info");
							});
						},
						onPrompt: async ({ message }) => {
							if (typeof ctx.ui?.input !== "function") {
								throw new Error(`Interactive input is required. Open this URL and rerun in an interactive Pi session: ${authUrl}`);
							}
							const value = await ctx.ui.input("Antigravity OAuth callback URL", message);
							if (!value) throw new Error("Antigravity OAuth was cancelled.");
							return value;
						},
					},
					options,
				);
				await staleSafe(() => {
					ctx.ui?.notify?.(formatAddAccountResult(result), "info");
				});
				emitAntigravityStatus(await getCurrentAntigravityStatus());
			} catch (error) {
				notifyAntigravityLoginFailure(error);
			}
		},
	});

	pi.registerCommand("antigravity-account", {
		description: "Show the current Antigravity account, project, and rotation position",
		handler: async (_args: string, ctx: any) => {
			rememberAntigravityUi(ctx.ui);
			emitAntigravityStatus(await getCurrentAntigravityStatus());
		},
	});

	pi.registerCommand("antigravity-status", {
		description: "Alias for /antigravity-account",
		handler: async (_args: string, ctx: any) => {
			rememberAntigravityUi(ctx.ui);
			emitAntigravityStatus(await getCurrentAntigravityStatus());
		},
	});

	pi.registerProvider(PROVIDER_ID, {
		name: "Google Antigravity OAuth",
		baseUrl: ENDPOINT_DAILY,
		api: API_ID,
		models: modelDefinitions.map((model) => ({ ...model })) as any,
		oauth: {
			name: "Google Antigravity OAuth",
			login: loginAntigravity,
			refreshToken: refreshAntigravityToken,
			getApiKey: (credentials) => credentials.access,
			modifyModels: (models, credentials) => {
				const accessProjectId = decodeApiKey(credentials.access).projectId;
				return models.map((model) => ({ ...model, antigravityProjectId: accessProjectId || getEffectiveProjectId(credentials.refresh) || DEFAULT_PROJECT_ID }));
			},
		},
		streamSimple: streamAntigravity as any,
	});
}
