import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeApiKey, getEffectiveProjectId, importOpencodeAntigravityAccount } from "./auth-store";
import { formatAddAccountResult, formatImportResult, parseAddAccountCommandArgs, parseImportCommandArgs } from "./commands";
import { API_ID, DEFAULT_PROJECT_ID, ENDPOINT_DAILY, PROVIDER_ID } from "./constants";
import { modelDefinitions } from "./models";
import { addAntigravityAccount, loginAntigravity, refreshAntigravityToken } from "./oauth";
import { emitAntigravityStatus, getCurrentAntigravityStatus, publishAntigravityAuthStartupSection, rememberAntigravityApi, rememberAntigravityUi } from "./status";
import { streamAntigravity } from "./stream";

export { importOpencodeAntigravityAccount } from "./auth-store";
export { addAntigravityAccount } from "./oauth";
export type { AntigravityAddAccountResult, OpencodeAntigravityImportResult } from "./types";

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
	}

	pi.registerCommand("antigravity-import", {
		description: "Import Antigravity OAuth from opencode antigravity-accounts.json into Pi auth.json",
		handler: async (args: string, ctx: any) => {
			try {
				const result = await importOpencodeAntigravityAccount(parseImportCommandArgs(args));
				ctx.ui?.notify?.(formatImportResult(result), result.imported ? "info" : result.reason === "auth-exists-use-force" ? "warn" : "error");
			} catch (error) {
				ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

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
							ctx.ui?.notify?.(`Open this Antigravity OAuth URL, then paste the callback URL:\n${url}`, "info");
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
				ctx.ui?.notify?.(formatAddAccountResult(result), "info");
				emitAntigravityStatus(await getCurrentAntigravityStatus());
			} catch (error) {
				ctx.ui?.notify?.(error instanceof Error ? error.message : String(error), "error");
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
