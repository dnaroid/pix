export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-unified-gateway";
export const STATUS_KEY = "dcp:antigravity";
export const LEGACY_STATUS_KEY = "antigravity";
export const ALL_ACCOUNTS_EXHAUSTED_MARKER = "ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED";

// Captured native agy CLI wire identity used by cortexkit 2.2.1.
export const AGY_CLI_VERSION = "1.1.24";
export const AGY_CLI_CHANGE_LIST = "974782877";

export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
// Autopush is retained as a named legacy endpoint for compatibility/debugging,
// but current agy/cortexkit traffic falls back daily -> prod only.
export const STREAM_ENDPOINTS = [ENDPOINT_DAILY, ENDPOINT_PROD];
export const LOAD_ENDPOINTS = [ENDPOINT_DAILY, ENDPOINT_PROD];
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
export const MIN_THOUGHT_SIGNATURE_LENGTH = 50;
