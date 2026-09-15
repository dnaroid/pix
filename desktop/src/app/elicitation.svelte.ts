import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import {
  canAcceptElicitationForSession,
  elicitationSessionId,
  parseElicitation,
  type ElicitationField,
} from "../lib/elicitation";
import {
  createQuestionAcceptResponse,
  createQuestionSelections,
  createQuestionnaireState,
  parseQuestionElicitation,
  type DesktopQuestion,
  type QuestionnaireState,
} from "../lib/question";

export type PendingFormElicitation = {
  kind: "form";
  sessionId: string | null;
  message: string;
  field: ElicitationField;
  resolve: (response: CreateElicitationResponse) => void;
};

export type PendingQuestionElicitation = {
  kind: "question";
  sessionId: string | null;
  requestId: number;
  message: string;
  questions: DesktopQuestion[];
  state: QuestionnaireState;
  resolve: (response: CreateElicitationResponse) => void;
};

export type PendingElicitation = PendingFormElicitation | PendingQuestionElicitation;

type ElicitationStoreOptions = {
  cancelQuestionImageOperation: (requestId?: number) => void;
  activeSessionId: () => string | null;
  onPendingCreated?: (pending: PendingElicitation) => void;
};

export function createElicitationStore(options: ElicitationStoreOptions) {
  let pendingBySession = $state<Map<string, PendingElicitation>>(new Map());
  let pendingUnscoped = $state<PendingElicitation | null>(null);
  let sequence = 0;

  function replace(pending: PendingElicitation): void {
    if (pending.sessionId === null) {
      if (pendingUnscoped?.resolve === pending.resolve) pendingUnscoped = pending;
      return;
    }
    if (pendingBySession.get(pending.sessionId)?.resolve !== pending.resolve) return;
    const next = new Map(pendingBySession);
    next.set(pending.sessionId, pending);
    pendingBySession = next;
  }

  function remove(pending: PendingElicitation): void {
    if (pending.sessionId === null) {
      if (pendingUnscoped?.resolve === pending.resolve) pendingUnscoped = null;
      return;
    }
    if (pendingBySession.get(pending.sessionId)?.resolve !== pending.resolve) return;
    const next = new Map(pendingBySession);
    next.delete(pending.sessionId);
    pendingBySession = next;
  }

  function pendingQuestion(requestId: number): PendingQuestionElicitation | null {
    if (pendingUnscoped?.kind === "question" && pendingUnscoped.requestId === requestId) {
      return pendingUnscoped;
    }
    for (const pending of pendingBySession.values()) {
      if (pending.kind === "question" && pending.requestId === requestId) return pending;
    }
    return null;
  }

  function cancelAll(): void {
    const pending = [
      ...(pendingUnscoped ? [pendingUnscoped] : []),
      ...pendingBySession.values(),
    ];
    pendingUnscoped = null;
    pendingBySession = new Map();
    options.cancelQuestionImageOperation();
    for (const item of pending) item.resolve({ action: "cancel" });
  }

  function requestInternal(
    request: CreateElicitationRequest,
    notifyPending: boolean,
  ): Promise<CreateElicitationResponse> {
    const question = parseQuestionElicitation(request);
    const field = parseElicitation(request);
    if (!question && !field) return Promise.resolve({ action: "cancel" });
    const ownerSessionId = elicitationSessionId(request);
    if (!canAcceptElicitationForSession(
      ownerSessionId,
      new Set(pendingBySession.keys()),
      pendingUnscoped !== null,
    )) {
      return Promise.resolve({ action: "cancel" });
    }

    return new Promise((resolve) => {
      const pending: PendingElicitation = question
        ? {
            kind: "question",
            sessionId: ownerSessionId,
            requestId: ++sequence,
            message: question.message,
            questions: question.questions,
            state: createQuestionnaireState(question.questions),
            resolve,
          }
        : { kind: "form", sessionId: ownerSessionId, message: request.message, field: field!, resolve };
      if (ownerSessionId === null) {
        pendingUnscoped = pending;
      } else {
        const next = new Map(pendingBySession);
        next.set(ownerSessionId, pending);
        pendingBySession = next;
      }
      if (notifyPending) options.onPendingCreated?.(pending);
    });
  }

  function request(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    return requestInternal(request, true);
  }

  function updateQuestionnaire(active: PendingElicitation | null, state: QuestionnaireState, requestId?: number): void {
    if (
      !active
      || active.kind !== "question"
      || (requestId !== undefined && active.requestId !== requestId)
    ) return;
    replace({ ...active, state });
  }

  function updateFormValue(active: PendingElicitation | null, value: string | boolean): void {
    if (!active || active.kind !== "form") return;
    replace({
      ...active,
      field: { ...active.field, value },
    });
  }

  function answerForm(active: PendingElicitation | null, accepted: boolean): void {
    if (!active || active.kind !== "form") return;
    remove(active);
    active.resolve(accepted
      ? { action: "accept", content: { [active.field.key]: active.field.value } }
      : { action: "cancel" });
  }

  function answerQuestion(state: QuestionnaireState, requestId: number): void {
    const pending = pendingQuestion(requestId);
    if (!pending) return;
    const selections = createQuestionSelections(state, pending.questions);
    if (!selections) return;
    remove(pending);
    options.cancelQuestionImageOperation(requestId);
    pending.resolve(createQuestionAcceptResponse(selections));
  }

  function cancel(requestId: number): void {
    const pending = pendingQuestion(requestId);
    if (!pending) return;
    remove(pending);
    options.cancelQuestionImageOperation(requestId);
    pending.resolve({ action: "cancel" });
  }

  function cancelForSession(sessionId: string): void {
    const pending = pendingBySession.get(sessionId);
    if (!pending) return;
    const next = new Map(pendingBySession);
    next.delete(sessionId);
    pendingBySession = next;
    if (pending.kind === "question") options.cancelQuestionImageOperation(pending.requestId);
    pending.resolve({ action: "cancel" });
  }

  async function requestLocalTextInput(message: string, title: string): Promise<string | undefined> {
    const response = await requestInternal({
      mode: "form",
      sessionId: options.activeSessionId() ?? "local",
      message,
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string", title } },
        required: ["value"],
      },
    } as unknown as CreateElicitationRequest, false);
    if (response.action !== "accept") return undefined;
    const content = (response as { content?: Record<string, unknown> | null }).content;
    const value = content?.value;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  return {
    get pendingBySession() { return pendingBySession; },
    get pendingUnscoped() { return pendingUnscoped; },
    replace,
    pendingQuestion,
    cancelAll,
    request,
    updateQuestionnaire,
    updateFormValue,
    answerForm,
    answerQuestion,
    cancel,
    cancelForSession,
    requestLocalTextInput,
  };
}
