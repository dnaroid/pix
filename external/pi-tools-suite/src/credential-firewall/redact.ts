import { createHash } from "node:crypto";

export type SecretKind =
	| "private_key"
	| "github_token"
	| "gitlab_token"
	| "api_key"
	| "google_api_key"
	| "aws_access_key"
	| "slack_token"
	| "stripe_key"
	| "npm_token"
	| "pypi_token"
	| "telegram_bot_token"
	| "bearer_token"
	| "basic_auth"
	| "password"
	| "credential";

export interface SecretRedactionSummary {
	count: number;
	kinds: SecretKind[];
}

export interface SecretRedactionResult<T = unknown> extends SecretRedactionSummary {
	value: T;
}

type MatchPattern = { kind: SecretKind; pattern: RegExp };

const EXACT_SECRET_PATTERNS: MatchPattern[] = [
	{ kind: "private_key", pattern: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g },
	{ kind: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g },
	{ kind: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g },
	{ kind: "api_key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,255}\b/g },
	{ kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	{ kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
	{ kind: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,255}\b/g },
	{ kind: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/g },
	{ kind: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{30,255}\b/g },
	{ kind: "pypi_token", pattern: /\bpypi-[A-Za-z0-9_-]{40,255}\b/g },
	{ kind: "telegram_bot_token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
];

const SENSITIVE_ASSIGNMENT = /((?:["']?)(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|pwd|private[_-]?key|npm[_-]?token|github[_-]?token|gitlab[_-]?token|aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token)(?:["']?)\s*[:=]\s*)(["']?)([^\s"',}{;]{8,})(["']?)/gi;
const BEARER_AUTH = /(\bAuthorization\s*:\s*Bearer\s+)([A-Za-z0-9._~+\/=:-]{12,})/gi;
const BASIC_AUTH = /(\bAuthorization\s*:\s*Basic\s+)([A-Za-z0-9+/=]{8,})/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]{4,})(@)/gi;

const SAFE_EXACT_VALUES = new Set([
	"[redacted]",
	"redacted",
	"placeholder",
	"changeme",
	"change-me",
	"not-a-secret",
	"not_secret",
	"example",
	"dummy",
	"replace_me",
	"replace-me",
]);

function shouldSkipCandidate(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return true;
	if (normalized.includes("<secret:")) return true;
	if (normalized.startsWith("$") || normalized.startsWith("${") || normalized.startsWith("{{")) return true;
	if (normalized.startsWith("process.env") || normalized.startsWith("env.")) return true;
	if (/^\*+$/.test(normalized) || /^x+$/.test(normalized)) return true;
	if (/^your[_-][a-z0-9_-]+$/i.test(normalized)) return true;
	return SAFE_EXACT_VALUES.has(normalized);
}

function kindForAssignmentPrefix(prefix: string): SecretKind {
	const normalized = prefix.toLowerCase();
	if (normalized.includes("password") || normalized.includes("passwd") || /\bpwd\b/.test(normalized)) return "password";
	if (normalized.includes("api") && normalized.includes("key")) return "api_key";
	if (normalized.includes("aws") && normalized.includes("access") && normalized.includes("key")) return "aws_access_key";
	if (normalized.includes("private") && normalized.includes("key")) return "private_key";
	return "credential";
}

function kindForSensitiveKey(key: string): SecretKind | undefined {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
	if (normalized === "password" || normalized === "passwd" || normalized === "pwd") return "password";
	if (normalized.includes("private_key")) return "private_key";
	if (normalized.includes("api_key")) return "api_key";
	if (normalized === "aws_access_key_id") return "aws_access_key";
	if (
		normalized.includes("secret") ||
		normalized.includes("token") ||
		normalized === "authorization" ||
		normalized === "credential" ||
		normalized === "credentials"
	) return "credential";
	return undefined;
}

function uniqueKinds(kinds: SecretKind[]): SecretKind[] {
	return [...new Set(kinds)];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function shouldSkipOpaqueField(parent: Record<string, unknown>, key: string): boolean {
	if (key === "encrypted_content" || key === "signature") return true;
	return key === "data" && (parent.type === "image" || parent.type === "input_image" || parent.type === "image_url");
}

export class SecretRedactor {
	// Keep only a one-way digest for stable placeholders; never retain plaintext
	// secret material merely to correlate repeated redactions.
	private readonly placeholders = new Map<string, string>();
	private readonly counters = new Map<SecretKind, number>();

	private placeholder(secret: string, kind: SecretKind): string {
		const fingerprint = createHash("sha256").update(secret).digest("hex");
		const existing = this.placeholders.get(fingerprint);
		if (existing) return existing;
		const next = (this.counters.get(kind) ?? 0) + 1;
		this.counters.set(kind, next);
		const placeholder = `<SECRET:${kind}:${next}>`;
		this.placeholders.set(fingerprint, placeholder);
		return placeholder;
	}

	redactString(input: string): SecretRedactionResult<string> {
		let value = input;
		let count = 0;
		const kinds: SecretKind[] = [];

		const replaceSecret = (secret: string, kind: SecretKind): string => {
			if (shouldSkipCandidate(secret)) return secret;
			count++;
			kinds.push(kind);
			return this.placeholder(secret, kind);
		};

		SENSITIVE_ASSIGNMENT.lastIndex = 0;
		value = value.replace(SENSITIVE_ASSIGNMENT, (match, prefix: string, openingQuote: string, secret: string, closingQuote: string) => {
			if (openingQuote && closingQuote && openingQuote !== closingQuote) return match;
			const replacement = replaceSecret(secret, kindForAssignmentPrefix(prefix));
			return `${prefix}${openingQuote}${replacement}${closingQuote}`;
		});

		BEARER_AUTH.lastIndex = 0;
		value = value.replace(BEARER_AUTH, (_match, prefix: string, secret: string) => `${prefix}${replaceSecret(secret, "bearer_token")}`);

		BASIC_AUTH.lastIndex = 0;
		value = value.replace(BASIC_AUTH, (_match, prefix: string, secret: string) => `${prefix}${replaceSecret(secret, "basic_auth")}`);

		URL_PASSWORD.lastIndex = 0;
		value = value.replace(URL_PASSWORD, (_match, prefix: string, secret: string, suffix: string) => `${prefix}${replaceSecret(secret, "password")}${suffix}`);

		// Exact token formats run last so placeholders introduced by contextual
		// detectors are never reinterpreted as new secret assignments.
		for (const { kind, pattern } of EXACT_SECRET_PATTERNS) {
			pattern.lastIndex = 0;
			value = value.replace(pattern, (secret) => replaceSecret(secret, kind));
		}

		return { value, count, kinds: uniqueKinds(kinds) };
	}

	redact<T>(input: T): SecretRedactionResult<T> {
		const result = this.redactValue(input);
		return { value: result.value as T, count: result.count, kinds: uniqueKinds(result.kinds) };
	}

	private redactValue(input: unknown): SecretRedactionResult {
		if (typeof input === "string") return this.redactString(input);
		if (Array.isArray(input)) {
			let changed = false;
			let count = 0;
			const kinds: SecretKind[] = [];
			const next = input.map((item) => {
				const result = this.redactValue(item);
				if (result.value !== item) changed = true;
				count += result.count;
				kinds.push(...result.kinds);
				return result.value;
			});
			return { value: changed ? next : input, count, kinds };
		}
		if (!isPlainRecord(input)) return { value: input, count: 0, kinds: [] };

		let changed = false;
		let count = 0;
		const kinds: SecretKind[] = [];
		const next: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(input)) {
			if (typeof item === "string" && shouldSkipOpaqueField(input, key)) {
				next[key] = item;
				continue;
			}
			if (typeof item === "string") {
				const keyKind = kindForSensitiveKey(key);
				if (keyKind && !shouldSkipCandidate(item)) {
					const replacement = this.placeholder(item, keyKind);
					next[key] = replacement;
					if (replacement !== item) {
						changed = true;
						count++;
						kinds.push(keyKind);
					}
					continue;
				}
			}
			const result = this.redactValue(item);
			next[key] = result.value;
			if (result.value !== item) changed = true;
			count += result.count;
			kinds.push(...result.kinds);
		}
		return { value: changed ? next : input, count, kinds };
	}
}
