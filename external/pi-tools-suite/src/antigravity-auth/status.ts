import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { publishStartupSection } from "../startup-section";
import { LEGACY_STATUS_KEY, PROVIDER_ID, STATUS_KEY } from "./constants";
import { accountFromCredential, clampAccountIndex, decodeApiKey, getAccountProjectId, getEffectiveProjectId, getPiAuthPath, getStoredAccounts, readJsonFile } from "./auth-store";
import { formatAntigravityStatus } from "./commands";
import type { AntigravityStatusDetails, OpencodeAntigravityAccount, PiAuthData, PiAuthCredential } from "./types";

let extensionUi: ExtensionUIContext | undefined;
let extensionApi: ExtensionAPI | undefined;
const notifiedLoginFailures = new WeakSet<object>();
const PROVIDER_FAILURE_DEDUPE_MS = 60_000;
const notifiedProviderFailures = new Map<string, number>();

export function rememberAntigravityApi(api: ExtensionAPI): void {
	extensionApi = api;
}

export function rememberAntigravityUi(ui: ExtensionUIContext | undefined): void {
	if (ui) extensionUi = ui;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatAntigravityLoginFailure(error: unknown): string {
	return `Antigravity login failed: ${errorMessage(error)}. Auth file: ${getPiAuthPath()}`;
}

export function formatAntigravityProviderFailure(error: unknown): string {
	return `Antigravity request failed: ${errorMessage(error)}. Auth file: ${getPiAuthPath()}`;
}

function notifyAntigravityFailure(message: string, details: Record<string, unknown>, options: { ui?: ExtensionUIContext; sendSessionMessage?: boolean } = {}): void {
	const { ui, sendSessionMessage = true } = options;
	const targetUi = ui ?? extensionUi;
	if (typeof targetUi?.notify === "function") {
		targetUi.notify(message, "error");
	} else if (typeof (targetUi as any)?.toast?.error === "function") {
		(targetUi as any).toast.error(message);
	}
	if (!sendSessionMessage) return;
	(extensionApi as any)?.sendMessage?.({
		customType: "antigravity-auth-status",
		content: message,
		display: true,
		details,
	}, { triggerTurn: false });
}

function shouldNotifyProviderFailure(message: string, model?: string): boolean {
	const now = Date.now();
	const key = `${model ?? ""}\0${message}`;
	for (const [existingKey, timestamp] of notifiedProviderFailures) {
		if (now - timestamp > PROVIDER_FAILURE_DEDUPE_MS) notifiedProviderFailures.delete(existingKey);
	}
	const previous = notifiedProviderFailures.get(key);
	if (previous !== undefined && now - previous <= PROVIDER_FAILURE_DEDUPE_MS) return false;
	notifiedProviderFailures.set(key, now);
	return true;
}

export function notifyAntigravityLoginFailure(error: unknown): boolean {
	if (typeof error === "object" && error !== null) {
		if (notifiedLoginFailures.has(error)) return false;
		notifiedLoginFailures.add(error);
	}

	const message = formatAntigravityLoginFailure(error);
	notifyAntigravityFailure(message, {
		kind: "login-failure",
		authPath: getPiAuthPath(),
		error: errorMessage(error),
	});
	return true;
}

export function notifyAntigravityProviderFailure(error: unknown, options: { ui?: ExtensionUIContext; model?: string } = {}): boolean {
	const message = formatAntigravityProviderFailure(error);
	if (!shouldNotifyProviderFailure(message, options.model)) return false;
	notifyAntigravityFailure(message, {
		kind: "provider-failure",
		authPath: getPiAuthPath(),
		error: errorMessage(error),
		model: options.model,
	}, {
		ui: options.ui,
		// Provider failures are raised while the agent is still streaming. pi.sendMessage()
		// would be delivered as a steering message in that state, which can trigger
		// another Antigravity request and create an endless toast/request loop.
		sendSessionMessage: false,
	});
	return true;
}

export async function getCurrentAntigravityStatus(): Promise<AntigravityStatusDetails> {
	const auth = await readJsonFile<PiAuthData>(getPiAuthPath(), {});
	const credential = auth[PROVIDER_ID];
	const accounts = getStoredAccounts(credential);
	const accountIndex = accounts.length > 0 ? clampAccountIndex(credential?.activeIndex, accounts.length) : undefined;
	const account = typeof accountIndex === "number" ? accounts[accountIndex] : undefined;
	const apiProjectId = credential?.access ? decodeApiKey(credential.access).projectId : undefined;
	return {
		kind: "status",
		email: account?.email ?? credential?.email,
		accountIndex,
		accountCount: accounts.length || undefined,
		projectId: apiProjectId || (credential?.refresh ? getEffectiveProjectId(credential.refresh) : undefined),
		expires: credential?.expires,
	};
}

function getStartupAccounts(credential?: PiAuthCredential): OpencodeAntigravityAccount[] {
	const accounts = getStoredAccounts(credential);
	if (accounts.length > 0) return accounts;
	const account = accountFromCredential(credential);
	return account ? [account] : [];
}

function formatStartupAccountName(account: OpencodeAntigravityAccount, index: number): string {
	const email = account.email?.trim();
	if (email) return email;
	const projectId = getAccountProjectId(account);
	return projectId ? `project ${projectId}` : `account ${index + 1}`;
}

async function startupAntigravityAccountList(): Promise<string> {
	try {
		const auth = await readJsonFile<PiAuthData>(getPiAuthPath(), {});
		const accounts = getStartupAccounts(auth[PROVIDER_ID]);
		if (accounts.length === 0) return "no accounts in auth.json (run /antigravity-add-account)";
		return accounts.map(formatStartupAccountName).join(", ");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `error loading accounts: ${message}`;
	}
}

export async function publishAntigravityAuthStartupSection(): Promise<void> {
	publishStartupSection({
		id: "antigravity-auth",
		title: "antigravity-auth",
		body: await startupAntigravityAccountList(),
	});
}

export function emitAntigravityStatus(details: AntigravityStatusDetails): void {
	if (typeof extensionUi?.setStatus === "function") {
		extensionUi.setStatus(LEGACY_STATUS_KEY, undefined);
		extensionUi.setStatus(STATUS_KEY, formatAntigravityStatus(details));
	}
	(extensionApi as any)?.sendMessage?.({
		role: "system",
		content: formatAntigravityStatus(details),
		details,
	});
}
