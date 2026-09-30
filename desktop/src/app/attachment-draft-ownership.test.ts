import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Attachment, AttachmentFile } from "../lib/attachments";
import { createAttachmentDraftController } from "./attachment-drafts";
import { createAttachmentDraftOwnership } from "./attachment-draft-ownership";
import { createComposerDraftStore } from "./composer-drafts";
import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function image(id: string): Attachment {
  return { id, name: `${id}.png`, kind: "image", mimeType: "image/png", path: `/cache/${id}.png` };
}

function setup() {
  let workspace = "/workspace";
  let owner = "session-a";
  let text = "unsent";
  let attachments = [image("a")];
  const key = () => `${workspace}\0${owner}`;
  const controller = createAttachmentDraftController({
    workspace: () => workspace,
    activeSessionId: () => owner === DRAFT_SESSION_TAB_ID ? null : owner,
    draftSessionTabActive: () => owner === DRAFT_SESSION_TAB_ID,
    sessionMutationRunning: () => false,
    operationRunning: () => false,
    attachmentDraftKey: key,
    promptAttachments: () => attachments,
    setPromptAttachments: (next) => { attachments = next; },
    setErrorMessage: vi.fn(),
    reportError: vi.fn(),
  });
  const drafts = createComposerDraftStore({
    workspace: () => workspace,
    promptText: () => text,
    promptAttachments: () => attachments,
    setPromptText: (next) => { text = next; },
    replacePromptAttachments: controller.replaceDraftAttachments,
  });
  const ownership = createAttachmentDraftOwnership({
    invalidate: controller.invalidate,
    bumpGeneration: controller.bumpGeneration,
  });
  const reconcile = () => ownership.sync(key(), workspace);
  reconcile();

  function switchTo(target: string): void {
    // Same ordering as session selection: restore synchronously, then let the
    // root ownership effect reconcile after the active id has changed.
    drafts.switchTo(owner, target);
    owner = target;
    reconcile();
  }

  return {
    controller, ownership, drafts, switchTo, reconcile,
    get attachments() { return attachments; },
    get text() { return text; },
    setDraft(nextText: string, nextAttachments: Attachment[]) {
      text = nextText;
      attachments = nextAttachments;
    },
    changeWorkspace(next: string) { workspace = next; reconcile(); },
    setOwner(next: string) { owner = next; },
  };
}

describe("attachment draft ownership reconciliation", () => {
  it.each(["session-b", DRAFT_SESSION_TAB_ID])("retains unsent images after switching to %s and back", (target) => {
    const state = setup();
    state.switchTo(target);
    expect(state.attachments).toEqual([]);
    expect(state.text).toBe("");
    state.setDraft("other draft", [image("b")]);

    state.switchTo("session-a");
    expect(state.attachments).toEqual([image("a")]);
    expect(state.text).toBe("unsent");

    state.switchTo(target);
    expect(state.attachments).toEqual([image("b")]);
    expect(state.text).toBe("other draft");
    state.reconcile();
    expect(state.attachments).toEqual([image("b")]);
  });

  it("rejects an old inspection after switching away and back without clearing the restored image", async () => {
    const state = setup();
    let resolve!: (files: AttachmentFile[]) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise<AttachmentFile[]>((done) => { resolve = done; }));
    const adding = state.controller.addAttachmentPaths(["/late.png"]);
    await Promise.resolve(); // inspection is now in flight
    expect(invoke).toHaveBeenCalledWith("inspect_attachments", { paths: ["/late.png"] });
    state.switchTo("session-b");
    state.switchTo("session-a");
    resolve([{ path: "/late.png", name: "late.png", size: 1 }]);
    await adding;
    expect(state.attachments).toEqual([image("a")]);
  });

  it("clears attachments and invalidates pending work when the workspace changes", () => {
    const state = setup();
    const generation = state.controller.generation;
    state.changeWorkspace("/other-workspace");
    expect(state.attachments).toEqual([]);
    expect(state.controller.generation).toBe(generation + 1);
    state.drafts.reset();
    state.switchTo("session-b");
    state.switchTo("session-a");
    expect(state.attachments).toEqual([]);
  });

  it("retargets first-submit ownership without invalidating the materialized draft", () => {
    const state = setup();
    state.switchTo(DRAFT_SESSION_TAB_ID);
    state.setDraft("first prompt", [image("draft")]);
    const generation = state.controller.generation;
    state.ownership.retarget("/workspace", "created-session");
    state.setOwner("created-session");
    expect(state.reconcile()).toBe(false);
    expect(state.controller.generation).toBe(generation);
    expect(state.attachments).toEqual([image("draft")]);
  });
});
