import type { PendingQuestionElicitation } from "./elicitation.svelte";
import type { QuestionImageControllerOptions } from "./question-image-controller-options";

export function createQuestionImageState(options: QuestionImageControllerOptions) {
  let operationSequence = 0;

  function activeCustomQuestionId(): string | null {
    const pending = options.activePendingElicitation();
    if (!pending || pending.kind !== "question") return null;
    const question = pending.questions[pending.state.activeTab];
    if (!question || !pending.state.drafts[question.id]?.customSelected) return null;
    return question.id;
  }

  function canAcceptDroppedAttachments(): boolean {
    const pending = options.activePendingElicitation();
    if (
      pending?.kind === "question"
      && options.questionImageOperationIds().has(pending.requestId)
    ) return false;
    if (pending?.kind === "question") return activeCustomQuestionId() !== null;
    return (!!options.activeSessionId() || options.draftSessionTabActive()) && !options.sessionMutationRunning();
  }

  function questionCanAcceptImages(questionId: string, requestId?: number): boolean {
    const pending = requestId === undefined
      ? (options.activePendingElicitation()?.kind === "question" ? options.activePendingElicitation() as PendingQuestionElicitation : null)
      : options.pendingQuestion(requestId);
    return !!pending
      && pending.questions.some((question) => question.id === questionId)
      && pending.state.drafts[questionId]?.customSelected === true;
  }

  function questionRequestIsActive(requestId: number): boolean {
    const pending = options.activePendingElicitation();
    return pending?.kind === "question" && pending.requestId === requestId;
  }

  function questionImageRequestId(questionId: string): number | null {
    const pending = options.activePendingElicitation();
    return pending?.kind === "question" && questionCanAcceptImages(questionId)
      ? pending.requestId
      : null;
  }

  function beginQuestionImageOperation(requestId: number): number | null {
    const current = options.questionImageOperationIds();
    if (current.has(requestId)) return null;
    const operationId = ++operationSequence;
    const next = new Map(current);
    next.set(requestId, operationId);
    options.setQuestionImageOperationIds(next);
    return operationId;
  }

  function finishQuestionImageOperation(requestId: number, operationId: number): void {
    const current = options.questionImageOperationIds();
    if (current.get(requestId) !== operationId) return;
    const next = new Map(current);
    next.delete(requestId);
    options.setQuestionImageOperationIds(next);
  }

  function cancelQuestionImageOperation(requestId?: number): void {
    const current = options.questionImageOperationIds();
    if (requestId === undefined) {
      options.setQuestionImageOperationIds(new Map());
      return;
    }
    if (!current.has(requestId)) return;
    const next = new Map(current);
    next.delete(requestId);
    options.setQuestionImageOperationIds(next);
  }

  return {
    activeCustomQuestionId,
    canAcceptDroppedAttachments,
    questionCanAcceptImages,
    questionRequestIsActive,
    questionImageRequestId,
    beginQuestionImageOperation,
    finishQuestionImageOperation,
    cancelQuestionImageOperation,
  };
}

export type QuestionImageState = ReturnType<typeof createQuestionImageState>;
