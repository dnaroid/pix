import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { publishStartupSection } from "../startup-section";
import { ignoreStaleExtensionContextError } from "../context-usage";
import { queryGoogleUsage } from "./lib/google";
import { queryOpenAIUsage } from "./lib/openai";
import { type AuthData, type QueryResult } from "./lib/types";
import { queryZaiUsage, queryZhipuUsage } from "./lib/zhipu";

const CUSTOM_MESSAGE_TYPE = "usage";

type PiAuthCredential = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
};

type PiAuthData = Record<string, PiAuthCredential | undefined>;

async function readOpenCodeAuth(): Promise<{ authData: AuthData; error?: string }> {
	const authPath = join(homedir(), ".local/share/opencode/auth.json");

	try {
		const content = await readFile(authPath, "utf-8");
		return { authData: JSON.parse(content) as AuthData };
	} catch (error) {
		return {
			authData: {},
			error: `❌ Failed to read auth file: ${authPath}\nError: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function readPiAuth(): Promise<PiAuthData> {
	try {
		const authPath = process.env.NODE_ENV === "test" && process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH
			? process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH
			: join(homedir(), ".pi", "agent", "auth.json");
		const content = await readFile(authPath, "utf-8");
		return JSON.parse(content) as PiAuthData;
	} catch {
		return {};
	}
}

function isExpired(credential: { expires?: number } | undefined): boolean {
	return typeof credential?.expires === "number" && credential.expires < Date.now();
}

async function readAuthData(): Promise<{ authData: AuthData; error?: string }> {
	const { authData, error } = await readOpenCodeAuth();
	const piAuth = await readPiAuth();

	const piOpenAI = piAuth["openai-codex"];
	if ((!authData.openai || isExpired(authData.openai)) && piOpenAI?.type === "oauth" && piOpenAI.access) {
		authData.openai = {
			type: "oauth",
			access: piOpenAI.access,
			refresh: piOpenAI.refresh,
			expires: piOpenAI.expires,
		};
	}

	const piZai = piAuth.zai;
	if (!authData["zai-coding-plan"] && piZai?.key && (piZai.type === "api" || piZai.type === "api_key")) {
		authData["zai-coding-plan"] = { type: "api", key: piZai.key };
	}

	return { authData, error };
}

function collectResult(result: QueryResult | null, title: string, results: string[], errors: string[]): void {
	if (!result) return;

	if (result.success && result.output) {
		if (results.length > 0) results.push("");
		results.push(title);
		results.push("");
		results.push(result.output);
	} else if (result.error) {
		errors.push(result.error);
	}
}

export async function queryUsage(): Promise<string> {
	const { authData, error: authReadError } = await readAuthData();

	const [openaiResult, zhipuResult, zaiResult, googleResult] = await Promise.all([
		queryOpenAIUsage(authData.openai),
		queryZhipuUsage(authData["zhipuai-coding-plan"]),
		queryZaiUsage(authData["zai-coding-plan"]),
		queryGoogleUsage(),
	]);

	const results: string[] = [];
	const errors: string[] = [];

	collectResult(openaiResult, "## OpenAI Account Quota", results, errors);
	collectResult(zhipuResult, "## Zhipu AI Account Quota", results, errors);
	collectResult(zaiResult, "## Z.ai Account Quota", results, errors);
	collectResult(googleResult, "## Google Cloud Account Quota", results, errors);

	if (results.length === 0 && errors.length === 0) {
		const noAccounts = "No configured accounts found.\n\nSupported account types:\n- OpenAI (Plus/Team/Pro subscribers)\n- Zhipu AI (Coding Plan)\n- Z.ai (Coding Plan)\n- Google Cloud (Antigravity)";
		return authReadError ? `${noAccounts}\n\n${authReadError}` : noAccounts;
	}

	let output = results.join("\n");
	if (errors.length > 0) {
		if (output) output += "\n\n";
		output += "❌ Failed to query accounts:\n" + errors.join("\n");
	}

	return output;
}

function sendStatusMessage(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: CUSTOM_MESSAGE_TYPE,
		content: text,
		display: true,
		details: { generatedAt: new Date().toISOString() },
	});
}

async function staleSafe(action: () => void | Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		ignoreStaleExtensionContextError(error);
	}
}

export default function usage(pi: ExtensionAPI) {
	publishStartupSection({
		id: "usage",
		title: "usage",
		body: "/usage — query quota usage for configured AI accounts",
	});

	async function showStatusFromCommand(ctx: ExtensionCommandContext): Promise<void> {
		const text = await queryUsage();

		if (!ctx.hasUI) {
			console.log(text);
			await staleSafe(() => {
				sendStatusMessage(pi, text);
			});
			return;
		}

		await staleSafe(async () => {
			ctx.ui.notify("usage: quota usage refreshed", "info");
			sendStatusMessage(pi, text);
		});
	}

	pi.registerCommand("usage", {
		description: "Query quota usage for configured AI accounts, including per-model Antigravity/Gemini usage where available.",
		handler: async (_args, ctx) => {
			await showStatusFromCommand(ctx);
		},
	});
}
