export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-unified-gateway";
export const STATUS_KEY = "dcp:antigravity";
export const LEGACY_STATUS_KEY = "antigravity";
export const ALL_ACCOUNTS_EXHAUSTED_MARKER = "ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED";

export const CLIENT_ID = process.env.PIX_ANTIGRAVITY_GOOGLE_CLIENT_ID ?? process.env.ANTIGRAVITY_GOOGLE_CLIENT_ID ?? "";
export const CLIENT_SECRET = process.env.PIX_ANTIGRAVITY_GOOGLE_CLIENT_SECRET ?? process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET ?? "";
export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";
export const ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";
export const ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com";
export const STREAM_ENDPOINTS = [ENDPOINT_DAILY, ENDPOINT_AUTOPUSH, ENDPOINT_PROD];
export const LOAD_ENDPOINTS = [ENDPOINT_PROD, ENDPOINT_DAILY, ENDPOINT_AUTOPUSH];
export const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
export const MIN_THOUGHT_SIGNATURE_LENGTH = 50;
