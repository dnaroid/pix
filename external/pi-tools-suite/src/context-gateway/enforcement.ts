import type { ShellCommandClassification } from "../shell-command-policy.js";
import { parseTestBuildOutput, planProspectiveTestOutputDelivery } from "./test-output-parser.js";
import type { ContextGatewayToolClass } from "./types.js";

type ResultContent = unknown;

export interface ContextGatewayEnforcementPlan {
	representation: "passthrough" | "test-build-compact";
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
 * Only recognised, complete, simple test/build output is compacted; every
 * other result stays byte-for-byte passthrough until a recovery contract exists.
 */
export function planContextGatewayEnforcement(input: {
	event: { content?: unknown; details?: unknown; isError?: boolean };
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
