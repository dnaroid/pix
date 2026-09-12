import { invoke } from "@tauri-apps/api/core";
import {
  attachmentKind,
  mimeTypeForName,
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
import { decodedQuestionImageBytes, fileBase64 } from "./attachment-io";
import type { QuestionImageControllerOptions } from "./question-image-controller-options";
import type { QuestionImageState } from "./question-image-state";

type QuestionImageCandidate = {
  name: string;
  size: number;
  mimeType: string;
  readData: () => Promise<string>;
};

export function createQuestionImageIngest(
  options: QuestionImageControllerOptions,
  state: QuestionImageState,
) {
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
    if (issue && state.questionRequestIsActive(requestId)) options.setErrorMessage(issue);
  }

  async function appendPastedQuestionImages(
    questionId: string,
    requestId: number,
    files: readonly File[],
  ): Promise<void> {
    const issue = await appendQuestionImageCandidates(questionId, requestId, files.map((file) => ({
      name: file.name,
      size: file.size,
      mimeType: file.type || mimeTypeForName(file.name),
      readData: () => fileBase64(file),
    })));
    if (issue && state.questionRequestIsActive(requestId)) options.setErrorMessage(issue);
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
      if (!pending || !state.questionCanAcceptImages(questionId, requestId)) return null;
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
      if (!pending || !state.questionCanAcceptImages(questionId, requestId)) return null;
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
    if (!pending || !state.questionCanAcceptImages(questionId, requestId) || images.length === 0) return;
    const question = pending.questions.find((candidate) => candidate.id === questionId);
    if (!question) return;
    options.replacePending({
      ...pending,
      state: addQuestionImages(pending.state, questionId, images, question),
    });
  }

  return { appendQuestionImagePaths, appendPastedQuestionImages };
}
