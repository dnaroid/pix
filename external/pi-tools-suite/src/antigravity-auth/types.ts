import type { Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

export type HeaderStyle = "antigravity" | "gemini-cli";
export type AntigravityModel = Model<"antigravity-unified-gateway"> & { antigravityProjectId?: string; antigravityHeaderStyle?: HeaderStyle };

export type AntigravityPart = {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	thought_signature?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
	functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
};

export type AntigravityContent = {
	role: "user" | "model";
	parts: AntigravityPart[];
};

export type AntigravityChunk = {
	response?: {
		candidates?: Array<{
			content?: { role?: string; parts?: AntigravityPart[] };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			cachedContentTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	error?: { code?: number; message?: string; status?: string };
};

export type OpencodeAntigravityAccount = {
	email?: string;
	refreshToken?: string;
	projectId?: string;
	managedProjectId?: string;
	enabled?: boolean;
};

export type OpencodeAntigravityStorage = {
	version?: number;
	accounts?: OpencodeAntigravityAccount[];
	activeIndex?: number;
};

export type PiAuthCredential = {
	type?: string;
	refresh?: string;
	access?: string;
	expires?: number;
	email?: string;
	accounts?: OpencodeAntigravityAccount[];
	activeIndex?: number;
	[key: string]: unknown;
};

export type PiAuthData = Record<string, PiAuthCredential>;

export type RefreshedAntigravityAccount = {
	account: OpencodeAntigravityAccount;
	credentials: OAuthCredentials & PiAuthCredential;
	projectId: string;
};

export type AntigravityFailoverCredential = {
	apiKey: string;
	projectId: string;
	email?: string;
	accountIndex: number;
	accountCount: number;
};

export type AntigravityStatusDetails = {
	kind: "status" | "switch";
	email?: string;
	accountIndex?: number;
	accountCount?: number;
	projectId?: string;
	status?: number;
	expires?: number;
};

export type AntigravityLoginCallbacks = Pick<OAuthLoginCallbacks, "onAuth" | "onPrompt">;

export type OpencodeAntigravityImportResult = {
	imported: boolean;
	reason?: string;
	sourcePath: string;
	authPath: string;
	email?: string;
	accountIndex?: number;
	accountCount?: number;
	overwroteExisting?: boolean;
};

export type AntigravityAddAccountResult = {
	added: boolean;
	updatedExisting?: boolean;
	activated: boolean;
	authPath: string;
	email?: string;
	accountIndex: number;
	accountCount: number;
	projectId?: string;
};
