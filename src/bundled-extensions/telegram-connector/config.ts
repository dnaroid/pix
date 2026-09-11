import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

const CONFIG_KEY = "telegramConnector";
const ENV_ENABLED = "PIX_TELEGRAM_CONNECTOR";
const ENV_BOT_TOKEN = "PIX_TELEGRAM_BOT_TOKEN";
const ENV_CHAT_ID = "PIX_TELEGRAM_CHAT_ID";

export type TelegramConnectorConfig = {
	enabled: boolean;
	botToken?: string;
	chatId?: string;
};

export function getTelegramConnectorConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
}

export function readTelegramConnectorConfig(configPath = getTelegramConnectorConfigPath()): TelegramConnectorConfig {
	return readTelegramConnectorConfigState(configPath).config;
}

function readTelegramConnectorConfigState(configPath: string): {
	config: TelegramConnectorConfig;
	explicitlyDisabled: boolean;
} {
	if (!existsSync(configPath)) return { config: { enabled: false }, explicitlyDisabled: false };
	try {
		const parsed = parseJsonc(readFileSync(configPath, "utf-8")) as unknown;
		if (!isRecord(parsed)) return { config: { enabled: false }, explicitlyDisabled: false };
		const raw = parsed[CONFIG_KEY];
		if (!isRecord(raw)) return { config: { enabled: false }, explicitlyDisabled: false };
		const botToken = nonEmptyString(raw.botToken);
		const chatId = normalizeChatId(raw.chatId);
		const explicitlyDisabled = raw.enabled === false;
		return {
			config: {
				enabled: !explicitlyDisabled && Boolean(botToken && chatId),
				...(botToken ? { botToken } : {}),
				...(chatId ? { chatId } : {}),
			},
			explicitlyDisabled,
		};
	} catch {
		return { config: { enabled: false }, explicitlyDisabled: false };
	}
}

export function resolveTelegramConnectorConfig(
	configPath = getTelegramConnectorConfigPath(),
	environment: NodeJS.ProcessEnv = process.env,
): TelegramConnectorConfig {
	const { config: fromConfig, explicitlyDisabled } = readTelegramConnectorConfigState(configPath);
	const envBotToken = nonEmptyString(environment[ENV_BOT_TOKEN]);
	const envChatId = normalizeChatId(environment[ENV_CHAT_ID]);
	const botToken = envBotToken ?? fromConfig.botToken;
	const chatId = envChatId ?? fromConfig.chatId;
	const envEnabled = parseBooleanEnv(environment[ENV_ENABLED]);
	const enabled = envEnabled === false
		? false
		: envEnabled === true
			? Boolean(botToken && chatId)
			: explicitlyDisabled
				? false
				: Boolean(botToken && chatId);
	return {
		enabled,
		...(botToken ? { botToken } : {}),
		...(chatId ? { chatId } : {}),
	};
}

function normalizeChatId(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return /^-?\d+$/.test(trimmed) ? trimmed : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
