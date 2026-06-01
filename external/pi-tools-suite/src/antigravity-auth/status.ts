import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { publishStartupSection } from "../startup-section";
import { LEGACY_STATUS_KEY, PROVIDER_ID, STATUS_KEY } from "./constants";
import { accountFromCredential, clampAccountIndex, decodeApiKey, getAccountProjectId, getEffectiveProjectId, getPiAuthPath, getStoredAccounts, readJsonFile } from "./auth-store";
import { formatAntigravityStatus } from "./commands";
import type { AntigravityStatusDetails, OpencodeAntigravityAccount, PiAuthData, PiAuthCredential } from "./types";

let extensionUi: ExtensionUIContext | undefined;
let extensionApi: ExtensionAPI | undefined;

export function rememberAntigravityApi(api: ExtensionAPI): void {
	extensionApi = api;
}

export function rememberAntigravityUi(ui: ExtensionUIContext | undefined): void {
	if (ui) extensionUi = ui;
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
		if (accounts.length === 0) return "no accounts (run /antigravity-import or /antigravity-add-account)";
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
	extensionUi?.setStatus(LEGACY_STATUS_KEY, undefined);
	extensionUi?.setStatus(STATUS_KEY, formatAntigravityStatus(details));
	(extensionApi as any)?.sendMessage?.({
		role: "system",
		content: formatAntigravityStatus(details),
		details,
	});
}
