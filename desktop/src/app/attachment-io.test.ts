import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import type { Attachment } from "../lib/attachments";
import { materializeComposerTaskAttachments, persistTaskAttachment } from "./attachment-io";

describe("task attachment persistence", () => {
  beforeEach(() => {
    tauri.invoke.mockReset();
  });

  it("copies path-backed composer attachments into project task storage", async () => {
    const attachment: Attachment = {
      id: "attachment-1",
      name: "shot.png",
      kind: "image",
      mimeType: "image/png",
      size: 128,
      path: "/cache/attachments/temporary-shot.png",
    };
    tauri.invoke.mockResolvedValue({
      path: "/workspace/.pi/task-attachments/persisted-shot.png",
      name: "persisted-shot.png",
      size: 128,
    });

    const result = await materializeComposerTaskAttachments(
      [attachment],
      "/workspace",
      null,
      null,
    );

    expect(tauri.invoke).toHaveBeenCalledWith("persist_task_attachment", {
      workspace: "/workspace",
      path: "/cache/attachments/temporary-shot.png",
    });
    expect(result).toEqual([{
      ...attachment,
      path: "/workspace/.pi/task-attachments/persisted-shot.png",
    }]);
  });

  it("keeps attachment metadata while replacing the path with the durable task copy", async () => {
    const attachment: Attachment = {
      id: "attachment-2",
      name: "design.png",
      kind: "image",
      mimeType: "image/png",
      size: 64,
      path: "/workspace/design.png",
    };
    tauri.invoke.mockResolvedValue({
      path: "/workspace/.pi/task-attachments/123-design.png",
      name: "123-design.png",
      size: 96,
    });

    const result = await persistTaskAttachment(attachment, "/workspace");

    expect(result).toEqual({
      ...attachment,
      path: "/workspace/.pi/task-attachments/123-design.png",
      size: 96,
    });
  });
});
