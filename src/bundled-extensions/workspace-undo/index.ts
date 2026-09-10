import { getAgentDir, type
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	prepareWorkspaceMutation,
	loadWorkspaceUndoIndex,
	revertWorkspaceMutations,
	workspaceMutationFromToolExecution,
	WORKSPACE_MUTATION_ENTRY_TYPE,
	type WorkspaceMutation,
	type WorkspaceMutationPreparation,
} from "../../app/workspace/workspace-undo.js";

export { WORKSPACE_MUTATION_ENTRY_TYPE } from "../../app/workspace/workspace-undo.js";
export const WORKSPACE_UNDO_RPC_COMMAND = "__pix-workspace-undo";
export const WORKSPACE_UNDO_RESULT_CHANNEL = "pix.workspace-undo-result";
export const WORKSPACE_UNDO_RPC_ENV = "PIX_ACP_WORKSPACE_UNDO_BRIDGE";

const RPC_SESSION_STATE_WIDGET_KEY = "pix.session-state";

type PendingToolMutation = {
	userEntryId: string;
	args: unknown;
	preparation?: WorkspaceMutationPreparation;
};

export type WorkspaceUndoBridgeRequest = {
	requestId: string;
	targetEntryId: string;
};

export type WorkspaceUndoBridgeResult = {
	requestId: string;
	status: "ok" | "warning" | "cancelled" | "error";
	revertedChanges?: number;
	changedFiles?: number;
	error?: string;
};

type SessionBranchEntry = {
	id?: unknown;
	type?: unknown;
	customType?: unknown;
	data?: unknown;
};

export default function workspaceUndoBridge(pi: ExtensionAPI): void {
	if (process.env[WORKSPACE_UNDO_RPC_ENV] !== "1") return;

	const pendingTools = new Map<string, PendingToolMutation>();

	pi.on("tool_execution_start", async (event, ctx) => {
		const userEntryId = latestUserEntryId(ctx.sessionManager.getBranch() as SessionBranchEntry[]);
		if (!userEntryId) return;
		const preparation = prepareWorkspaceMutation(ctx.cwd, event.toolName, event.args);
		pendingTools.set(event.toolCallId, {
			userEntryId,
			args: event.args,
			...(preparation ? { preparation } : {}),
		});
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const pending = pendingTools.get(event.toolCallId);
		pendingTools.delete(event.toolCallId);
		if (!pending) return;

		const result = record(event.result);
		const mutation = workspaceMutationFromToolExecution({
			cwd: ctx.cwd,
			toolName: event.toolName,
			args: pending.args,
			details: result?.details,
			isError: event.isError,
			preparation: pending.preparation,
		});
		if (!mutation) return;

		// Session custom entries are deliberately used instead of the TUI's
		// process-wide index. They are ignored by LLM context, stay attached to
		// the exact session branch, and cannot be overwritten by another ACP
		// child process working in the same repository.
		pi.appendEntry(WORKSPACE_MUTATION_ENTRY_TYPE, { userEntryId: pending.userEntryId, mutation });
	});

	pi.registerCommand(WORKSPACE_UNDO_RPC_COMMAND, {
		description: "Internal Pix Desktop workspace undo bridge",
		handler: async (args, ctx) => {
			const request = parseWorkspaceUndoBridgeRequest(args);
			if (!request) return;

			try {
				const branch = ctx.sessionManager.getBranch() as SessionBranchEntry[];
				const mutations = workspaceMutationsAfterEntry(
					branch,
					request.targetEntryId,
					loadWorkspaceUndoIndex(getAgentDir()).entries,
				);
				const navigation = await ctx.navigateTree(request.targetEntryId);
				if (navigation.cancelled) {
					emitResult(ctx, { requestId: request.requestId, status: "cancelled" });
					return;
				}

				if (mutations.length === 0) {
					emitResult(ctx, {
						requestId: request.requestId,
						status: "ok",
						revertedChanges: 0,
						changedFiles: 0,
					});
					return;
				}

				const reverted = await revertWorkspaceMutations(ctx.cwd, mutations);
				if (!reverted.ok) {
					emitResult(ctx, {
						requestId: request.requestId,
						status: "warning",
						error: reverted.error,
					});
					return;
				}

				emitResult(ctx, {
					requestId: request.requestId,
					status: "ok",
					revertedChanges: reverted.revertedChanges,
					changedFiles: reverted.changedFiles,
				});
			} catch (error) {
				emitResult(ctx, {
					requestId: request.requestId,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	});
}

export function workspaceMutationsAfterEntry(
	branch: readonly SessionBranchEntry[],
	targetEntryId: string,
	legacyIndex: Readonly<Record<string, WorkspaceMutation[]>> = {},
): WorkspaceMutation[] {
	const targetIndex = branch.findIndex((entry) => entry.id === targetEntryId);
	if (targetIndex < 0) throw new Error(`Session entry ${targetEntryId} is not on the active branch`);

	const target = branch[targetIndex];
	if (!isUserMessageEntry(target)) {
		throw new Error(`Session entry ${targetEntryId} is not a user message`);
	}

	const userIds: string[] = [];
	const customMutations = new Map<string, WorkspaceMutation[]>();
	let currentUserEntryId: string | undefined = targetEntryId;
	for (const entry of branch.slice(targetIndex + 1)) {
		if (isUserMessageEntry(entry) && typeof entry.id === "string") {
			currentUserEntryId = entry.id;
			userIds.push(entry.id);
			continue;
		}
		if (entry.type !== "custom" || entry.customType !== WORKSPACE_MUTATION_ENTRY_TYPE) continue;
		const data = workspaceMutationEntryData(entry.data);
		const owner = data?.userEntryId ?? currentUserEntryId;
		if (!data?.mutation || !owner) continue;
		customMutations.set(owner, [...(customMutations.get(owner) ?? []), data.mutation]);
	}

	// The selected user message itself owns mutations from the turn that is
	// being removed, so it must be first in the undo plan.
	userIds.unshift(targetEntryId);
	return userIds.flatMap((userEntryId) => {
		const sessionEntries = customMutations.get(userEntryId);
		return sessionEntries && sessionEntries.length > 0
			? sessionEntries
			: [...(legacyIndex[userEntryId] ?? [])];
	});
}

export function parseWorkspaceUndoBridgeRequest(value: string): WorkspaceUndoBridgeRequest | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		const input = record(parsed);
		if (
			!input
			|| typeof input.requestId !== "string"
			|| input.requestId.length === 0
			|| typeof input.targetEntryId !== "string"
			|| input.targetEntryId.length === 0
		) return undefined;
		return { requestId: input.requestId, targetEntryId: input.targetEntryId };
	} catch {
		return undefined;
	}
}

function emitResult(ctx: ExtensionContext | ExtensionCommandContext, result: WorkspaceUndoBridgeResult): void {
	ctx.ui.setWidget(RPC_SESSION_STATE_WIDGET_KEY, [WORKSPACE_UNDO_RESULT_CHANNEL, JSON.stringify(result)]);
}

function workspaceMutationEntryData(value: unknown): { userEntryId?: string; mutation?: WorkspaceMutation } | undefined {
	const data = record(value);
	if (!data) return undefined;
	const mutation = isWorkspaceMutation(data.mutation) ? data.mutation : undefined;
	const userEntryId = typeof data.userEntryId === "string" ? data.userEntryId : undefined;
	return {
		...(userEntryId ? { userEntryId } : {}),
		...(mutation ? { mutation } : {}),
	};
}

function isWorkspaceMutation(value: unknown): value is WorkspaceMutation {
	const mutation = record(value);
	if (!mutation) return false;
	if (mutation.type === "patch") {
		return typeof mutation.patch === "string"
			&& (mutation.toolName === undefined || typeof mutation.toolName === "string");
	}
	if (mutation.type === "write") {
		return typeof mutation.path === "string"
			&& typeof mutation.afterContent === "string"
			&& (mutation.beforeContent === undefined || typeof mutation.beforeContent === "string")
			&& (mutation.toolName === undefined || typeof mutation.toolName === "string");
	}
	return false;
}

function isUserMessageEntry(entry: SessionBranchEntry | undefined): boolean {
	const message = record(record(entry)?.message);
	return entry?.type === "message" && message?.role === "user";
}

function latestUserEntryId(branch: readonly SessionBranchEntry[]): string | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (isUserMessageEntry(entry) && typeof entry?.id === "string") return entry.id;
	}
	return undefined;
}

function record(value: unknown): Record<string, any> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, any>
		: undefined;
}
