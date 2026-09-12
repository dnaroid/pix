import { open } from "@tauri-apps/plugin-dialog";
import type { QuestionImage } from "../lib/question";
import type { QuestionImageControllerOptions } from "./question-image-controller-options";
import { createQuestionImageIngest } from "./question-image-ingest";
import { createQuestionImageState } from "./question-image-state";

export function createQuestionImageController(options: QuestionImageControllerOptions) {
  const state = createQuestionImageState(options);
  const ingest = createQuestionImageIngest(options, state);

  async function chooseQuestionImages(questionId: string, expectedRequestId?: number): Promise<void> {
    const requestId = state.questionImageRequestId(questionId);
    if (requestId === null || (expectedRequestId !== undefined && requestId !== expectedRequestId)) return;
    const operationId = state.beginQuestionImageOperation(requestId);
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
      await ingest.appendQuestionImagePaths(
        questionId,
        requestId,
        typeof selected === "string" ? [selected] : selected,
      );
    } catch (error) {
      if (state.questionCanAcceptImages(questionId, requestId) && state.questionRequestIsActive(requestId)) {
        options.reportError(error);
      }
    } finally {
      state.finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function addQuestionImagePaths(questionId: string, paths: readonly string[]): Promise<void> {
    const requestId = state.questionImageRequestId(questionId);
    if (requestId === null || paths.length === 0) return;
    const operationId = state.beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      await ingest.appendQuestionImagePaths(questionId, requestId, paths);
    } catch (error) {
      if (state.questionCanAcceptImages(questionId, requestId) && state.questionRequestIsActive(requestId)) {
        options.reportError(error);
      }
    } finally {
      state.finishQuestionImageOperation(requestId, operationId);
    }
  }

  async function addPastedQuestionImages(
    questionId: string,
    files: readonly File[],
    expectedRequestId?: number,
  ): Promise<void> {
    const requestId = state.questionImageRequestId(questionId);
    if (
      requestId === null
      || (expectedRequestId !== undefined && requestId !== expectedRequestId)
      || files.length === 0
    ) return;
    const operationId = state.beginQuestionImageOperation(requestId);
    if (operationId === null) return;
    try {
      await ingest.appendPastedQuestionImages(questionId, requestId, files);
    } catch (error) {
      if (state.questionCanAcceptImages(questionId, requestId) && state.questionRequestIsActive(requestId)) {
        options.reportError(error);
      }
    } finally {
      state.finishQuestionImageOperation(requestId, operationId);
    }
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
    activeCustomQuestionId: state.activeCustomQuestionId,
    canAcceptDroppedAttachments: state.canAcceptDroppedAttachments,
    cancelQuestionImageOperation: state.cancelQuestionImageOperation,
    chooseQuestionImages,
    addQuestionImagePaths,
    addPastedQuestionImages,
    openQuestionImage,
  };
}
