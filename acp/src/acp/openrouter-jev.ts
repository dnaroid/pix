/** Shared OpenRouter Decisions transport for stateless Jev choice routing. */
export const OPENROUTER_JEV_MODEL = "~typesafe/jev-latest";
const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export interface JevChoiceRequest {
  readonly model: string;
  readonly apiKey: string;
  readonly question: string;
  readonly state: Record<string, string | number>;
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

export async function requestOpenRouterJevChoice(request: JevChoiceRequest): Promise<string | undefined> {
  const response = await (request.fetch ?? globalThis.fetch)(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    signal: request.signal,
    headers: {
      ...request.headers,
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model,
      state: request.state,
      questions: {
        [request.question]: {
          type: "choice",
          instructions: request.instructions,
          criteria: request.criteria,
        },
      },
    }),
  });
  if (!response.ok) throw new Error("Jev decision unavailable");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !("answers" in payload)) return undefined;
  const answers = payload.answers;
  if (!answers || typeof answers !== "object" || !(request.question in answers)) return undefined;
  const answer = (answers as Record<string, unknown>)[request.question];
  if (!answer || typeof answer !== "object" || !("choice" in answer) || typeof answer.choice !== "string") return undefined;
  const choice = answer.choice.trim().toLowerCase();
  return Object.hasOwn(request.criteria, choice) ? choice : undefined;
}
