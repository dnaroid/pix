import { loadSecretFirewallConfig } from "./config.js";
import { SecretRedactor, type SecretKind, type SecretRedactionResult, type SecretRedactionSummary } from "./redact.js";

type ExtensionAPI = any;
type ExtensionContext = {
	cwd?: string;
	ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void };
};

function maybeNotify(ctx: ExtensionContext, result: SecretRedactionSummary, source: string, enabled: boolean): void {
	if (!enabled || result.count === 0) return;
	try {
		ctx.ui?.notify?.(
			`Secret firewall redacted ${result.count} secret${result.count === 1 ? "" : "s"} from ${source}: ${result.kinds.join(", ")}.`,
			"warning",
		);
	} catch {
		// Protection must not fail because a headless or stale UI cannot notify.
	}
}

export default function credentialFirewall(pi: ExtensionAPI): void {
	const redactor = new SecretRedactor();

	pi.on("before_provider_request", async (event: { payload?: unknown }, ctx: ExtensionContext) => {
		const config = loadSecretFirewallConfig(ctx.cwd ?? process.cwd());
		const result = redactor.redact(event.payload);
		if (result.count === 0) return undefined;
		maybeNotify(ctx, result, "provider payload", config.notify);
		return result.value;
	});

	pi.on("tool_result", async (event: { content?: unknown; details?: unknown }, ctx: ExtensionContext) => {
		const config = loadSecretFirewallConfig(ctx.cwd ?? process.cwd());
		if (!config.sessionHygiene) return undefined;

		const content = redactor.redact(event.content);
		const details = redactor.redact(event.details);
		const count = content.count + details.count;
		if (count === 0) return undefined;
		const kinds = [...new Set([...content.kinds, ...details.kinds])] as SecretKind[];
		maybeNotify(ctx, { count, kinds }, "tool result", config.notify);
		return {
			...(content.count > 0 ? { content: content.value } : {}),
			...(details.count > 0 ? { details: details.value } : {}),
		};
	});

	pi.on("message_end", async (event: { message?: unknown }, ctx: ExtensionContext) => {
		const config = loadSecretFirewallConfig(ctx.cwd ?? process.cwd());
		if (!config.sessionHygiene || !event.message) return undefined;
		const result = redactor.redact(event.message);
		if (result.count === 0) return undefined;
		maybeNotify(ctx, result, "session message", config.notify);
		return { message: result.value };
	});
}

export { loadSecretFirewallConfig } from "./config.js";
export { SecretRedactor } from "./redact.js";
export type { SecretFirewallConfig } from "./config.js";
export type { SecretKind, SecretRedactionResult, SecretRedactionSummary } from "./redact.js";
