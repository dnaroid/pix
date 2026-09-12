import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  attachmentKind,
  mimeTypeForName,
  type Attachment,
  type AttachmentFile,
} from "../lib/attachments";
import {
  MAX_QUESTION_IMAGE_BYTES,
  MAX_QUESTION_IMAGE_BYTES_TOTAL,
  MAX_QUESTION_IMAGES,
  addQuestionImages,
  totalQuestionImageBytes,
  totalQuestionImageCount,
  type QuestionImage,
} from "../lib/question";
import type {
  PendingElicitation,
  PendingQuestionElicitation,
} from "./elicitation.svelte";
import {
  decodedQuestionImageBytes,
  fileBase64,
} from "./attachment-io";

type QuestionImageCandidate = {
  name: string;
  size: number;
  mimeType: string;
  readData: () => Promise<string>;
};

type QuestionImageControllerOptions = {
  activePendingElicitation: () => PendingElicitation | null;
  pendingQuestion: (requestId: number) => PendingQuestionElicitation | null;
  replacePending: (pending: PendingElicitation) => void;
  questionImageOperationIds: () => Map<number, number>;
  setQuestionImageOperationIds: (ids: Map<number, number>) => void;
  workspace: () => string;
  activeSessionId: () => string | null;
  draftSessionTabActive: () => boolean;
  sessionMutationRunning: () => boolean;
  setErrorMessage: (message: string) => void;
  reportError: (error: unknown) => void;
  nextAttachmentId: () => string;
  activateAttachment: (attachment: Attachment) => void | Promise<void>;
};

export function createQuestionImageController(options: QuestionImageControllerOptions) {
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

  async function chooseQuestionImages(questionId: string, expectedRequestId?: number): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || (expectedRequestId !== undefined && requestId !== expectedRequestId)) return;
    const operationId = beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      const workspace = options.workspace();
      const selected = await open({
        directory: false,
        multiple: true,
        title: "Attach images to answer",
        ...(workspace ? { defaultPath: workspace } : {}),
      });
      if (!selected) return;
      await appendQuestionImagePaths(questionId, requestId, typeof selected === "string" ? [selected] : selected);
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId) && questionRequestIsActive(requestId)) {
        options.reportError(error);
      }
    } finally {
      finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function addQuestionImagePaths(questionId: string, paths: readonly string[]): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (requestId === null || paths.length === 0) return;
    const operationId = beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      await appendQuestionImagePaths(questionId, requestId, paths);
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId) && questionRequestIsActive(requestId)) {
        options.reportError(error);
      }
    } finally {
      finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function appendQuestionImagePaths(
    questionId: string,
    requestId: number,
    paths: readonly string[],
  ): Promise<void> {
    const files = await invoke<AttachmentFile[]>("inspect_attachments", { paths });
    const issue = await appendQuestionImageCandidates(questionId, requestId, files.map((file) => ({
      name: file.name,
      size: file.size,
      mimeType: mimeTypeForName(file.name),
      readData: () => invoke<string>("read_attachment_base64", { path: file.path }),
    })));
    if (issue && questionRequestIsActive(requestId)) options.setErrorMessage(issue);
  }

  async function addPastedQuestionImages(
    questionId: string,
    files: readonly File[],
    expectedRequestId?: number,
  ): Promise<void> {
    const requestId = questionImageRequestId(questionId);
    if (
      requestId === null
      || (expectedRequestId !== undefined && requestId !== expectedRequestId)
      || files.length === 0
    ) return;
    const operationId = beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      const issue = await appendQuestionImageCandidates(questionId, requestId, files.map((file) => ({
        name: file.name,
        size: file.size,
        mimeType: file.type || mimeTypeForName(file.name),
        readData: () => fileBase64(file),
      })));
      if (issue && questionRequestIsActive(requestId)) options.setErrorMessage(issue);
    } catch (error) {
      if (questionCanAcceptImages(questionId, requestId) && questionRequestIsActive(requestId)) {
        options.reportError(error);
      }
    } finally {
      finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function appendQuestionImageCandidates(
    questionId: string,
    requestId: number,
    candidates: readonly QuestionImageCandidate[],
  ): Promise<string | null> {
    const images: QuestionImage[] = [];
    let issue: string | null = null;
    let queuedBytes = 0;
    for (const candidate of candidates) {
      let pending = options.pendingQuestion(requestId);
      if (!pending || !questionCanAcceptImages(questionId, requestId)) return null;
      if (totalQuestionImageCount(pending.state) + images.length >= MAX_QUESTION_IMAGES) {
        issue = `Attach at most ${MAX_QUESTION_IMAGES} images to a questionnaire.`;
        break;
      }
      if (attachmentKind(candidate.mimeType) !== "image") {
        issue = "Only image files can be attached to an answer.";
        continue;
      }
      if (candidate.size <= 0) {
        issue = `${candidate.name} is empty and could not be attached.`;
        continue;
      }
      if (candidate.size > MAX_QUESTION_IMAGE_BYTES) {
        issue = `${candidate.name} is too large (maximum 25 MB).`;
        continue;
      }
      const data = await candidate.readData();
      pending = options.pendingQuestion(requestId);
      if (!pending || !questionCanAcceptImages(questionId, requestId)) return null;
      const decodedBytes = decodedQuestionImageBytes(data);
      if (decodedBytes === null || decodedBytes === 0) {
        issue = `${candidate.name} is empty or invalid and could not be attached.`;
        continue;
      }
      if (decodedBytes > MAX_QUESTION_IMAGE_BYTES) {
        issue = `${candidate.name} is too large (maximum 25 MB).`;
        continue;
      }
      if (totalQuestionImageBytes(pending.state) + queuedBytes + decodedBytes > MAX_QUESTION_IMAGE_BYTES_TOTAL) {
        issue = "Question images can total at most 50 MB.";
        break;
      }
      images.push({
        type: "image",
        data,
        mimeType: candidate.mimeType,
        name: candidate.name,
        size: decodedBytes,
      });
      queuedBytes += decodedBytes;
    }
    appendQuestionImagesToPending(questionId, requestId, images);
    return issue;
  }

  function appendQuestionImagesToPending(
    questionId: string,
    requestId: number,
    images: readonly QuestionImage[],
  ): void {
    const pending = options.pendingQuestion(requestId);
    if (!pending || !questionCanAcceptImages(questionId, requestId) || images.length === 0) return;
    const question = pending.questions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    options.replacePending({
      ...pending,
      state: addQuestionImages(pending.state, questionId, images, question),
    });
  }

  function openQuestionImage(image: QuestionImage): void {
    void options.activateAttachment({
      id: options.nextAttachmentId(),
      name: image.name,
      kind: "image",
      mimeType: image.mimeType,
      size: image.size,
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
    });
  }

  return {
    activeCustomQuestionId,
    canAcceptDroppedAttachments,
    cancelQuestionImageOperation,
    chooseQuestionImages,
    addQuestionImagePaths,
    addPastedQuestionImages,
    openQuestionImage,
  };
}
