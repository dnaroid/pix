import { describe, expect, it, vi } from "vitest";
import { createQuestionImageIngest } from "./question-image-ingest";
import { createQuestionImageState } from "./question-image-state";
import {
  chooseCustomAnswer,
  createQuestionSelections,
  createQuestionnaireState,
  type DesktopQuestion,
} from "../lib/question";
import type { PendingQuestionElicitation } from "./elicitation.svelte";
import type { QuestionImageControllerOptions } from "./question-image-controller-options";

const QUESTION: DesktopQuestion = {
  id: "details",
  label: "Details",
  prompt: "What changed?",
  choices: [
    { value: "small", label: "Small" },
    { value: "large", label: "Large" },
  ],
};

class ImmediateFileReader {
  result: string | ArrayBuffer | null = null;
  error: DOMException | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

  readAsDataURL(): void {
    this.result = "data:image/png;base64,aQ==";
    this.onload?.({} as ProgressEvent<FileReader>);
  }
}

describe("question image ingestion", () => {
  it("accepts exactly ten images, rejects the eleventh, and preserves the response image shape", async () => {
    vi.stubGlobal("FileReader", ImmediateFileReader);
    try {
      let pending: PendingQuestionElicitation = {
        kind: "question",
        sessionId: null,
        requestId: 1,
        message: "Answer the question",
        questions: [QUESTION],
        state: chooseCustomAnswer(createQuestionnaireState([QUESTION]), QUESTION.id),
        resolve: () => {},
      };
      let operationIds = new Map<number, number>();
      const errors: string[] = [];
      const options: QuestionImageControllerOptions = {
        activePendingElicitation: () => pending,
        pendingQuestion: (requestId) => requestId === pending.requestId ? pending : null,
        replacePending: (next) => { if (next.kind === "question") pending = next; },
        questionImageOperationIds: () => operationIds,
        setQuestionImageOperationIds: (next) => { operationIds = next; },
        workspace: () => "",
        activeSessionId: () => "session-1",
        draftSessionTabActive: () => false,
        sessionMutationRunning: () => false,
        setErrorMessage: (message) => errors.push(message),
        reportError: (error) => { throw error; },
        nextAttachmentId: () => "attachment-1",
        activateAttachment: () => {},
      };
      const state = createQuestionImageState(options);
      const ingest = createQuestionImageIngest(options, state);
      const files = Array.from({ length: 11 }, (_, index) => ({
        name: `image-${index + 1}.png`,
        size: 1,
        type: "image/png",
      } as File));

      await ingest.appendPastedQuestionImages(QUESTION.id, pending.requestId, files);

      expect(pending.state.drafts.details?.images).toHaveLength(10);
      expect(errors).toEqual(["Attach at most 10 images to a questionnaire."]);
      expect(createQuestionSelections(pending.state, [QUESTION])).toEqual([{
        id: "details",
        customText: "",
        images: Array.from({ length: 10 }, () => ({
          type: "image",
          data: "aQ==",
          mimeType: "image/png",
        })),
      }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
