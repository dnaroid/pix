import type { NormalizedQuestion, QuestionSelection } from "./types.js";

export type RemoteQuestionHandler = (
	questions: NormalizedQuestion[],
	signal?: AbortSignal,
) => Promise<QuestionSelection[] | null | undefined>;

type RemoteQuestionRegistry = Map<string, RemoteQuestionHandler>;

const REGISTRY_KEY = Symbol.for("pix.question.remote-registry.v1");

export function registerRemoteQuestionHandler(sessionId: string, handler: RemoteQuestionHandler): () => void {
	const registry = remoteQuestionRegistry();
	registry.set(sessionId, handler);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		if (registry.get(sessionId) === handler) registry.delete(sessionId);
	};
}

export async function runRemoteQuestionnaire(
	sessionId: string,
	questions: NormalizedQuestion[],
	signal?: AbortSignal,
): Promise<QuestionSelection[] | null | undefined> {
	const handler = remoteQuestionRegistry().get(sessionId);
	if (!handler) return undefined;
	try {
		return await handler(questions, signal);
	} catch {
		if (signal?.aborted) return null;
		// Remote integrations are optional. If Telegram/networking fails before an
		// answer is obtained, fall back to the normal local question UI.
		return undefined;
	}
}

function remoteQuestionRegistry(): RemoteQuestionRegistry {
	const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RemoteQuestionRegistry };
	root[REGISTRY_KEY] ??= new Map();
	return root[REGISTRY_KEY];
}
