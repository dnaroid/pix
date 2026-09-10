import type { ShellCommandClassification } from "../shell-command-policy.js";
import { parseTestBuildOutput, planProspectiveTestOutputDelivery } from "./test-output-parser.js";
import type { ContextGatewayToolClass } from "./types.js";

type ResultContent = unknown;

export interface ContextGatewayEnforcementPlan {
	representation: "passthrough" | "test-build-compact" | "web-recoverable-compact";
	content: ResultContent;
	sourceContentBytes: number;
	contentBytes: number;
	textBytes: number;
	reason: string;
}

function byteLengthJson(value: unknown): number {
	if (value === undefined) return 0;
	try {
		return new TextEncoder().encode(JSON.stringify(value)).byteLength;
	} catch {
		return 0;
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && typeof part === "object" && !Array.isArray(part)
			&& (part as Record<string, unknown>).type === "text"
			&& typeof (part as Record<string, unknown>).text === "string")
		.map((part) => (part as Record<string, unknown>).text as string)
		.join("\n");
}

function textOnlyContent(content: unknown): boolean {
	return Array.isArray(content)
		&& content.every((part) => part && typeof part === "object" && !Array.isArray(part)
			&& (part as Record<string, unknown>).type === "text"
			&& typeof (part as Record<string, unknown>).text === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedTextBytes(text: string, maximumBytes: number): string {
	const encoder = new TextEncoder();
	if (encoder.encode(text).byteLength <= maximumBytes) return text;
	const suffix = "\n… [compact view truncated; full structured result is recoverable from raw session details]";
	const suffixBytes = encoder.encode(suffix).byteLength;
	if (maximumBytes <= suffixBytes) {
		let low = 0;
		let high = text.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (encoder.encode(text.slice(0, mid)).byteLength <= maximumBytes) low = mid;
			else high = mid - 1;
		}
		return text.slice(0, low);
	}
	const target = Math.max(0, maximumBytes - suffixBytes);
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (encoder.encode(text.slice(0, mid)).byteLength <= target) low = mid;
		else high = mid - 1;
	}
	return `${text.slice(0, low).trimEnd()}${suffix}`;
}

function boundedProviderTextContent(text: string, maximumBytes: number): {
	content: Array<{ type: "text"; text: string }>;
	contentBytes: number;
	textBytes: number;
} {
	const limit = Math.max(1, Math.floor(maximumBytes));
	let low = 1;
	let high = limit;
	let bestText = boundedTextBytes(text, 1);
	let bestContent = [{ type: "text" as const, text: bestText }];
	let bestContentBytes = byteLengthJson(bestContent);

	while (low <= high) {
		const textBudget = Math.floor((low + high) / 2);
		const candidateText = boundedTextBytes(text, textBudget);
		const candidateContent = [{ type: "text" as const, text: candidateText }];
		const candidateBytes = byteLengthJson(candidateContent);
		if (candidateBytes <= limit) {
			bestText = candidateText;
			bestContent = candidateContent;
			bestContentBytes = candidateBytes;
			low = textBudget + 1;
		} else {
			high = textBudget - 1;
		}
	}

	return {
		content: bestContent,
		contentBytes: bestContentBytes,
		textBytes: new TextEncoder().encode(bestText).byteLength,
	};
}

function planRecoverableWebCompact(details: unknown, toolCallId: string | undefined, maximumBytes: number): string | undefined {
	if (!isRecord(details)) return undefined;
	const recovery = [
		"[Context Gateway: over-budget web result compacted for provider context.]",
		"Full structured source is retained in the raw session toolResult.details and can be recovered with session-recovery.",
		toolCallId ? `Recovery key: toolCallId=${toolCallId}` : undefined,
	].filter((line): line is string => Boolean(line));

	if (Array.isArray(details.results)) {
		const results = details.results.filter(isRecord);
		if (results.length === 0) return undefined;
		const lines = [...recovery, `Search results: ${results.length}`];
		for (let index = 0; index < results.length; index++) {
			const result = results[index]!;
			const title = typeof result.title === "string" ? result.title : `Result ${index + 1}`;
			const url = typeof result.url === "string" ? result.url : "";
			const content = typeof result.content === "string" ? result.content.replace(/\s+/g, " ").trim() : "";
			lines.push(`${index + 1}. ${title}`);
			if (url) lines.push(`   URL: ${url}`);
			if (content) lines.push(`   ${content.slice(0, 900)}${content.length > 900 ? "…" : ""}`);
		}
		return boundedTextBytes(lines.join("\n"), maximumBytes);
	}

	if (typeof details.content === "string") {
		const title = typeof details.title === "string" ? details.title : "Fetched document";
		const links = Array.isArray(details.links) ? details.links.filter((link): link is string => typeof link === "string") : [];
		const lines = [
			...recovery,
			`Title: ${title}`,
			`Content preview: ${details.content.slice(0, Math.max(1_000, maximumBytes))}`,
			...(links.length > 0 ? ["Links:", ...links.slice(0, 8).map((link) => `  - ${link}`)] : []),
		];
		return boundedTextBytes(lines.join("\n"), maximumBytes);
	}

	return undefined;
}

function upstreamTruncated(details: unknown): boolean {
	if (!details || typeof details !== "object" || Array.isArray(details)) return false;
	const record = details as Record<string, unknown>;
	if (record.truncated === true) return true;
	const truncation = record.truncation;
	return !!truncation && typeof truncation === "object" && !Array.isArray(truncation)
		&& (truncation as Record<string, unknown>).truncated === true;
}

/**
 * Selective storeless enforcement. It never performs generic truncation.
 * Recognised complete test/build output and structured recoverable web results
 * have explicit compact contracts; other results remain passthrough.
 */
export function planContextGatewayEnforcement(input: {
	event: { content?: unknown; details?: unknown; isError?: boolean };
	toolCallId?: string;
	toolClass: ContextGatewayToolClass;
	shell: ShellCommandClassification;
	budgetBytes: number;
	maxInlineBytes: number;
}): ContextGatewayEnforcementPlan {
	const sourceText = contentText(input.event.content);
	const sourceContentBytes = byteLengthJson(input.event.content);
	const passthrough = (reason: string): ContextGatewayEnforcementPlan => ({
		representation: "passthrough",
		content: input.event.content,
		sourceContentBytes,
		contentBytes: sourceContentBytes,
		textBytes: new TextEncoder().encode(sourceText).byteLength,
		reason,
	});

	if (input.toolClass === "web") {
		if (!textOnlyContent(input.event.content)) return passthrough("non-text-content");
		if (sourceContentBytes <= input.budgetBytes) return passthrough("within-class-budget");
		const compactText = planRecoverableWebCompact(input.event.details, input.toolCallId, input.maxInlineBytes);
		if (!compactText) return passthrough("web-recovery-source-unavailable");
		const bounded = boundedProviderTextContent(compactText, input.maxInlineBytes);
		return {
			representation: "web-recoverable-compact",
			content: bounded.content,
			sourceContentBytes,
			contentBytes: bounded.contentBytes,
			textBytes: bounded.textBytes,
			reason: "recoverable-structured-web-details",
		};
	}

	if (input.toolClass !== "shell") return passthrough("class-not-enforced");
	if (input.shell.scope !== "simple" || input.shell.kind !== "test-build") {
		return passthrough("shell-not-proven-test-build");
	}
	if (!textOnlyContent(input.event.content)) return passthrough("non-text-content");
	if (sourceContentBytes <= input.budgetBytes) return passthrough("within-class-budget");

	const parsed = parseTestBuildOutput({
		text: sourceText,
		hostOutcome: input.event.isError === true ? "error" : "success",
		upstreamTruncated: upstreamTruncated(input.event.details),
	});
	const compact = planProspectiveTestOutputDelivery(parsed, input.maxInlineBytes, {
		commandScope: input.shell.scope,
	});
	if (compact.decision !== "compact-candidate" || !compact.text) {
		return passthrough(compact.reason);
	}
	const content = [{ type: "text" as const, text: compact.text }];
	return {
		representation: "test-build-compact",
		content,
		sourceContentBytes,
		contentBytes: byteLengthJson(content),
		textBytes: new TextEncoder().encode(compact.text).byteLength,
		reason: compact.reason,
	};
}
