import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

/**
 * Credentials live outside pi-tools-suite.jsonc so the bot token is never part
 * of a shared/synced suite config. The module switch itself stays in the suite
 * config ("modules": { "telegram-bridge": true }).
 */
export const TELEGRAM_BRIDGE_CONFIG_FILE = "telegram-bridge.jsonc";

export interface TelegramBridgeConfig {
	botToken: string;
	/** Forum supergroup id (negative, usually -100…). Undefined = setup mode (/id only). */
	chatId?: number;
	/** Telegram user ids allowed to drive sessions. Empty = nobody. */
	allowedUserIds: number[];
	/** Directory for the broker lock, socket and topic state. */
	stateDir: string;
}

export type TelegramBridgeConfigResult =
	| { ok: true; config: TelegramBridgeConfig }
	| { ok: false; reason: "missing" | "invalid"; detail: string; path: string };

type Env = Record<string, string | undefined>;

export interface LoadTelegramBridgeConfigOptions {
	env?: Env;
	homeDir?: string;
	readFile?: (path: string) => string;
}

export function telegramBridgeConfigPath(env: Env = process.env, home = homedir()): string {
	return env.PIX_TELEGRAM_BRIDGE_CONFIG?.trim() || join(home, ".config", "pi", TELEGRAM_BRIDGE_CONFIG_FILE);
}

export function telegramBridgeStateDir(env: Env = process.env, home = homedir()): string {
	return env.PIX_TELEGRAM_BRIDGE_DIR?.trim() || join(home, ".pi", "agent", "telegram-bridge");
}

function integer(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^-?\d{1,20}$/.test(value.trim())) {
		const parsed = Number(value.trim());
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

function integerList(value: unknown): number[] | undefined {
	const items = typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean)
		: Array.isArray(value) ? value : undefined;
	if (!items) return undefined;
	const parsed = items.map(integer);
	return parsed.every((item): item is number => item !== undefined && item > 0) ? parsed : undefined;
}

export function loadTelegramBridgeConfig(options: LoadTelegramBridgeConfigOptions = {}): TelegramBridgeConfigResult {
	const env = options.env ?? process.env;
	const home = options.homeDir ?? homedir();
	const path = telegramBridgeConfigPath(env, home);
	const read = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
	let raw: Record<string, unknown> = {};
	try {
		const parsed = parseJsonc(read(path)) as unknown;
		if (parsed !== undefined && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
			return { ok: false, reason: "invalid", detail: "config must be a JSON object", path };
		}
		raw = (parsed ?? {}) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { ok: false, reason: "invalid", detail: "config file is unreadable", path };
		}
	}
	if (raw.enabled === false) return { ok: false, reason: "missing", detail: "disabled by \"enabled\": false", path };

	const botToken = (env.PIX_TELEGRAM_BOT_TOKEN?.trim() || (typeof raw.botToken === "string" ? raw.botToken.trim() : ""));
	if (!botToken) return { ok: false, reason: "missing", detail: "botToken is not configured", path };
	if (!/^\d{3,20}:[A-Za-z0-9_-]{20,}$/.test(botToken)) return { ok: false, reason: "invalid", detail: "botToken has an unexpected format", path };

	const chatSource = env.PIX_TELEGRAM_CHAT_ID?.trim() || raw.chatId;
	const chatId = chatSource === undefined || chatSource === "" ? undefined : integer(chatSource);
	if (chatSource !== undefined && chatSource !== "" && (chatId === undefined || chatId >= 0)) {
		return { ok: false, reason: "invalid", detail: "chatId must be the negative id of a forum supergroup", path };
	}
	const usersSource = env.PIX_TELEGRAM_ALLOWED_USER_IDS?.trim() || raw.allowedUserIds;
	const allowedUserIds = usersSource === undefined ? [] : integerList(usersSource);
	if (!allowedUserIds) return { ok: false, reason: "invalid", detail: "allowedUserIds must be a list of positive user ids", path };

	return {
		ok: true,
		config: {
			botToken,
			...(chatId !== undefined ? { chatId } : {}),
			allowedUserIds,
			stateDir: telegramBridgeStateDir(env, home),
		},
	};
}
