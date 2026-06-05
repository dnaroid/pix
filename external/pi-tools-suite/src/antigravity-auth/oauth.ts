import { createHash, randomBytes } from "node:crypto";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { DEFAULT_PROJECT_ID, LOAD_ENDPOINTS, REDIRECT_URI, SCOPES, TOKEN_EXPIRY_SKEW_MS, PROVIDER_ID } from "./constants";
import { accountFromCredential, clampAccountIndex, encodeApiKey, findMatchingAccountIndex, getAccountProjectId, getAccountRefreshToken, getGoogleOAuthClientCredentials, getPiAuthPath, getStoredAccounts, joinRefresh, readJsonFile, splitRefresh, writeJsonFileSecure } from "./auth-store";
import { getAntigravityHeaders } from "./headers";
import { notifyAntigravityLoginFailure } from "./status";
import type { AntigravityAddAccountResult, AntigravityFailoverCredential, AntigravityLoginCallbacks, GoogleOAuthClientCredentials, OpencodeAntigravityAccount, PiAuthCredential, PiAuthData, RefreshedAntigravityAccount } from "./types";

function base64Url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64Url(randomBytes(32));
	const challenge = base64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function encodeState(payload: { verifier: string; projectId?: string }): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state: string): { verifier: string; projectId?: string } {
	const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
	if (!parsed || typeof parsed.verifier !== "string") throw new Error("Missing PKCE verifier in OAuth state");
	return { verifier: parsed.verifier, projectId: typeof parsed.projectId === "string" ? parsed.projectId : undefined };
}

function assertGoogleOAuthCredentialsConfigured(credentials?: GoogleOAuthClientCredentials): asserts credentials is GoogleOAuthClientCredentials & { clientId: string } {
	if (!credentials?.clientId) {
		throw new Error(`Antigravity Google OAuth client credentials are missing in Pi auth: ${getPiAuthPath()}.`);
	}
}

async function fetchProjectId(accessToken: string): Promise<string | undefined> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		...getAntigravityHeaders("gemini-cli"),
		"Client-Metadata": getAntigravityHeaders()["Client-Metadata"],
	};

	for (const endpoint of LOAD_ENDPOINTS) {
		try {
			const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: {
						ideType: "ANTIGRAVITY",
						platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
						pluginType: "GEMINI",
					},
				}),
			});
			if (!response.ok) continue;
			const data = (await response.json()) as any;
			const project = data?.cloudaicompanionProject;
			if (typeof project === "string" && project) return project;
			if (typeof project?.id === "string" && project.id) return project.id;
		} catch {
			// Try the next endpoint.
		}
	}
	return undefined;
}

async function fetchGoogleUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				"User-Agent": getAntigravityHeaders("gemini-cli")["User-Agent"],
			},
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { email?: unknown };
		return typeof data.email === "string" && data.email ? data.email : undefined;
	} catch {
		return undefined;
	}
}

function extractOAuthParams(input: string): { code: string; state: string } {
	const trimmed = input.trim();
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		if (code && state) return { code, state };
	} catch {
		// Fall through to compact code#state parsing.
	}
	const [code, state] = trimmed.split("#", 2);
	if (code && state) return { code, state };
	throw new Error("Paste the full localhost callback URL, or code#state.");
}

export async function loginAntigravity(callbacks: AntigravityLoginCallbacks, options: { authPath?: string } = {}): Promise<OAuthCredentials> {
	try {
		const auth = await readJsonFile<PiAuthData>(options.authPath ?? getPiAuthPath(), {});
		const oauthClient = getGoogleOAuthClientCredentials(auth[PROVIDER_ID]);
		assertGoogleOAuthCredentialsConfigured(oauthClient);

		const { verifier, challenge } = generatePkce();
		const state = encodeState({ verifier });
		const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
		url.searchParams.set("client_id", oauthClient.clientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", REDIRECT_URI);
		url.searchParams.set("scope", SCOPES.join(" "));
		url.searchParams.set("code_challenge", challenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("state", state);
		url.searchParams.set("access_type", "offline");
		url.searchParams.set("prompt", "consent");

		callbacks.onAuth({ url: url.toString() });
		const pasted = await callbacks.onPrompt({
			message: "Paste the full http://localhost:51121/oauth-callback URL after Google login (or code#state):",
		});
		const params = extractOAuthParams(pasted);
		const decodedState = decodeState(params.state);
		if (decodedState.verifier !== verifier) throw new Error("OAuth state verifier mismatch");

		const start = Date.now();
		const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
				Accept: "*/*",
				"User-Agent": getAntigravityHeaders("gemini-cli")["User-Agent"],
			},
			body: new URLSearchParams({
				client_id: oauthClient.clientId,
				...(oauthClient.clientSecret ? { client_secret: oauthClient.clientSecret } : {}),
				code: params.code,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}),
		});
		if (!tokenResponse.ok) throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
		const tokenPayload = (await tokenResponse.json()) as { access_token: string; refresh_token?: string; expires_in: number };
		if (!tokenPayload.refresh_token) throw new Error("Missing refresh token in Google response");

		const [projectId, email] = await Promise.all([fetchProjectId(tokenPayload.access_token), fetchGoogleUserEmail(tokenPayload.access_token)]);
		return {
			refresh: joinRefresh(tokenPayload.refresh_token, projectId ?? DEFAULT_PROJECT_ID),
			access: encodeApiKey(tokenPayload.access_token, projectId ?? DEFAULT_PROJECT_ID),
			expires: start + tokenPayload.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
			...(email ? { email } : {}),
		};
	} catch (error) {
		notifyAntigravityLoginFailure(error);
		throw error;
	}
}

export async function addAntigravityAccount(
	callbacks: AntigravityLoginCallbacks,
	options: { authPath?: string; activate?: boolean; email?: string } = {},
): Promise<AntigravityAddAccountResult> {
	const authPath = options.authPath ?? getPiAuthPath();
	const credentials = (await loginAntigravity(callbacks, { authPath })) as OAuthCredentials & PiAuthCredential;
	const refreshDetails = splitRefresh(credentials.refresh);
	const projectId = refreshDetails.projectId || refreshDetails.managedProjectId || DEFAULT_PROJECT_ID;
	const account: OpencodeAntigravityAccount = {
		email: options.email ?? credentials.email,
		refreshToken: refreshDetails.refreshToken,
		projectId,
		managedProjectId: refreshDetails.managedProjectId,
		...getGoogleOAuthClientCredentials(credentials),
		enabled: true,
	};

	const auth = await readJsonFile<PiAuthData>(authPath, {});
	const existing = auth[PROVIDER_ID];
	const accounts = getStoredAccounts(existing);
	const existingTopLevelAccount = accountFromCredential(existing);
	if (accounts.length === 0 && existingTopLevelAccount) {
		accounts.push(existingTopLevelAccount);
	}

	let accountIndex = findMatchingAccountIndex(accounts, account);
	const updatedExisting = accountIndex >= 0;
	if (updatedExisting) {
		accounts[accountIndex] = { ...accounts[accountIndex], ...account, enabled: true };
	} else {
		accountIndex = accounts.push(account) - 1;
	}

	const shouldActivate = options.activate || !existing || accounts.length === 1 || clampAccountIndex(existing.activeIndex, accounts.length) === accountIndex;
	const activeIndex = shouldActivate ? accountIndex : clampAccountIndex(existing.activeIndex, accounts.length);
	const activeAccount = accounts[activeIndex] ?? account;
	const activeRefresh = shouldActivate ? credentials.refresh : existing?.refresh ?? joinRefresh(activeAccount.refreshToken!, getAccountProjectId(activeAccount), activeAccount.managedProjectId);

	auth[PROVIDER_ID] = {
		...existing,
		type: "oauth",
		refresh: activeRefresh,
		access: shouldActivate ? credentials.access : existing?.access ?? "",
		expires: shouldActivate ? credentials.expires : existing?.expires ?? 0,
		email: shouldActivate ? account.email : existing?.email ?? activeAccount.email,
		accounts,
		activeIndex,
	};
	await writeJsonFileSecure(authPath, auth);

	return {
		added: !updatedExisting,
		updatedExisting,
		activated: shouldActivate,
		authPath,
		email: account.email,
		accountIndex,
		accountCount: accounts.length,
		projectId,
	};
}

async function refreshAccountToken(account: OpencodeAntigravityAccount, oauthClient?: GoogleOAuthClientCredentials): Promise<RefreshedAntigravityAccount> {
	const refreshToken = getAccountRefreshToken(account);
	if (!refreshToken) throw new Error(`Missing refresh token for Antigravity account ${account.email ?? "<unknown>"}`);
	const clientCredentials = getGoogleOAuthClientCredentials(account) ?? oauthClient;
	assertGoogleOAuthCredentialsConfigured(clientCredentials);
	const projectId = getAccountProjectId(account);
	const start = Date.now();
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			Accept: "*/*",
			"User-Agent": getAntigravityHeaders("gemini-cli")["User-Agent"],
		},
		body: new URLSearchParams({
			client_id: clientCredentials.clientId,
			...(clientCredentials.clientSecret ? { client_secret: clientCredentials.clientSecret } : {}),
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});
	if (!response.ok) throw new Error(`Token refresh failed for ${account.email ?? "Antigravity account"}: ${await response.text()}`);
	const payload = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
	return {
		account,
		projectId,
		credentials: {
			refresh: joinRefresh(payload.refresh_token ?? refreshToken, projectId, account.managedProjectId),
			access: encodeApiKey(payload.access_token, projectId),
			expires: start + payload.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
			email: account.email,
		},
	};
}

export async function refreshAntigravityToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const credentialDetails = credentials as OAuthCredentials & PiAuthCredential;
	const oauthClient = getGoogleOAuthClientCredentials(credentialDetails);
	const storedAccounts = getStoredAccounts(credentialDetails);
	const baseIndex = clampAccountIndex(credentialDetails.activeIndex, storedAccounts.length);
	const rotationAccount = storedAccounts.length > 0 ? storedAccounts[(baseIndex + 1) % storedAccounts.length] : undefined;
	const nextActiveIndex = rotationAccount ? (baseIndex + 1) % storedAccounts.length : credentialDetails.activeIndex;
	const fallback = splitRefresh(credentials.refresh);
	const refreshed = await refreshAccountToken(
		rotationAccount ?? {
			refreshToken: fallback.refreshToken,
			projectId: fallback.projectId || fallback.managedProjectId,
			managedProjectId: fallback.managedProjectId,
			email: credentialDetails.email,
		},
		oauthClient,
	);
	return {
		...refreshed.credentials,
		...(storedAccounts.length > 0 ? { accounts: storedAccounts, activeIndex: nextActiveIndex, email: rotationAccount?.email ?? credentialDetails.email } : {}),
	};
}

export async function refreshStoredAntigravityCredential(authPath = getPiAuthPath()): Promise<AntigravityFailoverCredential | undefined> {
	const auth = await readJsonFile<PiAuthData>(authPath, {});
	const current = auth[PROVIDER_ID];
	if (current?.type !== "oauth") return undefined;

	const accounts = getStoredAccounts(current);
	const oauthClient = getGoogleOAuthClientCredentials(current);
	const activeIndex = accounts.length > 0 ? clampAccountIndex(current.activeIndex, accounts.length) : 0;
	const fallback = splitRefresh(current.refresh ?? "");
	const account = accounts[activeIndex] ?? {
		refreshToken: fallback.refreshToken,
		projectId: fallback.projectId || fallback.managedProjectId,
		managedProjectId: fallback.managedProjectId,
		email: current.email,
	};
	if (!account.refreshToken) return undefined;

	const refreshed = await refreshAccountToken({ ...account, refreshToken: getAccountRefreshToken(account) }, oauthClient);
	const refreshedParts = splitRefresh(refreshed.credentials.refresh);
	const nextAccounts = accounts.length > 0
		? accounts.map((stored, index) => index === activeIndex
			? {
				...stored,
				refreshToken: refreshedParts.refreshToken || stored.refreshToken,
				projectId: refreshed.projectId,
				managedProjectId: account.managedProjectId,
				email: account.email ?? stored.email,
				enabled: stored.enabled !== false,
			}
			: stored)
		: [];
	const nextCredential: PiAuthCredential = {
		...current,
		type: "oauth",
		...refreshed.credentials,
		...(nextAccounts.length > 0 ? { accounts: nextAccounts, activeIndex, email: account.email ?? current.email } : {}),
	};
	auth[PROVIDER_ID] = nextCredential;
	await writeJsonFileSecure(authPath, auth);

	return {
		apiKey: nextCredential.access ?? "",
		projectId: refreshed.projectId,
		email: account.email,
		accountIndex: activeIndex,
		accountCount: accounts.length || 1,
	};
}

export async function refreshNextFailoverCredential(attemptedAccountIndices: Set<number>): Promise<AntigravityFailoverCredential | undefined> {
	const authPath = getPiAuthPath();
	const auth = await readJsonFile<PiAuthData>(authPath, {});
	const current = auth[PROVIDER_ID];
	if (current?.type !== "oauth") return undefined;

	const accounts = getStoredAccounts(current);
	const oauthClient = getGoogleOAuthClientCredentials(current);
	if (accounts.length <= attemptedAccountIndices.size) return undefined;
	const baseIndex = clampAccountIndex(current.activeIndex, accounts.length);
	let lastRefreshError: unknown;

	for (let offset = 1; offset <= accounts.length; offset += 1) {
		const accountIndex = (baseIndex + offset) % accounts.length;
		if (attemptedAccountIndices.has(accountIndex)) continue;
		attemptedAccountIndices.add(accountIndex);
		const account = accounts[accountIndex];
		try {
			const refreshed = await refreshAccountToken(account, oauthClient);
			const nextCredential: PiAuthCredential = {
				...current,
				type: "oauth",
				...refreshed.credentials,
				accounts,
				activeIndex: accountIndex,
				email: account.email,
			};
			auth[PROVIDER_ID] = nextCredential;
			await writeJsonFileSecure(authPath, auth);
			return {
				apiKey: nextCredential.access ?? "",
				projectId: refreshed.projectId,
				email: account.email,
				accountIndex,
				accountCount: accounts.length,
			};
		} catch (error) {
			lastRefreshError = error;
		}
	}

	if (lastRefreshError) throw lastRefreshError;
	return undefined;
}
