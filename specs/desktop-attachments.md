# Desktop chat attachments

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Implemented; this is the current Desktop attachment contract.

## Goal

Show image and video attachments in the desktop composer and transcript, while keeping other files accessible through the operating system.

## Scope

- Add attachments through the file picker, native drag-and-drop, and clipboard paste.
- Send pathless pasted images as ACP image content when supported.
- Send path-backed images as resource links plus Pix file-image metadata so ACP
  can materialize them for Pi without embedding their bytes in the Desktop
  request body.
- Send video and other files as local resource links so the agent receives their paths.
- Render image/video previews in the composer, user messages, and supported ACP content.
- Preserve the current composer attachments when the draft is captured as a
  project task from the composer overflow menu.

## Non-goals

- Sending video bytes directly to the model.
- Editing, transcoding, or downloading attachments.
- Persisting chat-only copied files outside the application cache unless the
  user explicitly captures that draft as a project task.

## Behavior

- The composer accepts up to ten files per prompt and supports removal before sending.
- Images and videos show thumbnail previews. Clicking either opens a modal media viewer.
- Other files show a compact file tile. Clicking it opens the path with the operating system's default application.
- Selected and dropped images keep their local path. On submission they become
  ACP resource links and are also listed in private Pix file-image metadata for
  the ACP adapter.
- Pathless pasted images use their clipboard bytes and become ACP image blocks
  when image prompting is supported.
- Pasted images use their clipboard bytes. Other pasted files are copied to the Pix cache first so the agent receives a usable local path.
- A prompt may contain text, attachments, or both.
- Creating a project task from the composer persists path-backed attachments as
  task description markers. A pathless image is first materialized into the
  project's `.pi/task-attachments` storage, then persisted through the same
  marker format, so task creation never silently drops an attachment.
- Loaded sessions replay persisted images as previews. Persisted resource-link markers are restored as file/video attachments when their local paths remain available.
- Attachment failures leave the composer contents intact and surface the existing error banner.

## Contracts

- `session/prompt` receives `ContentBlock[]`: path-backed files (including
  images) use resource-link blocks; pathless supported images use image blocks.
- Path-backed images additionally travel in Pix `_meta["pix.fileImages"]` so the
  ACP adapter can materialize image content for Pi while retaining the resource
  link in the persisted prompt surface.
- Resource links are persisted in Pi text as Pix attachment markers containing a file URI.
- Project-task capture uses the same marker encoding. The Tauri
  `cache_task_attachment` command provides a workspace-confined path for any
  pathless composer image before the task document is written.
- The Tauri shell exposes bounded attachment inspection/read/cache commands and an approved-path opener command.
- Dialog and drop selections are admitted through Tauri's dynamic asset scope, then persisted in Pix's approved attachment registry for session replay.

## Invariants

- No file is submitted twice in one prompt.
- Image reads, combined embedded prompt bytes, clipboard copies, and the clipboard cache are size-bounded.
- Attachment drafts are bound to the active workspace/session and stale asynchronous additions are discarded.
- Read, preview, and open operations accept only paths approved by user selection or Pix's own clipboard cache.
- Unsupported files never render inside an unsafe HTML embed.
- Media modal and remove controls remain keyboard accessible.

## Edge cases

- Missing/deleted paths remain visible as file tiles; opening errors are reported.
- A pasted non-image exceeding the IPC size limit is rejected.
- If image prompting is not advertised, images fall back to resource links when a path exists; pathless pasted images are rejected.

## Related files

- `desktop/src/App.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/lib/attachments.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src-tauri/src/lib.rs`
- `acp/src/acp/session-replay.ts`
- `acp/src/acp/pix-acp-agent.ts`

## Verification

- Unit tests cover media classification, data-URL decoding, file-URI markers,
  transcript attachment chunks, and ACP history replay.
- `npm run check` and `npm test` in `desktop/`.
- Relevant ACP tests and the desktop production web build pass.

## Risks / unknowns

- Cached clipboard files expire after seven days, can be removed by the operating system, and then cannot be reopened from old sessions.
- A previously approved external path can later point to different contents if another process replaces that file.

## Evidence

- Confirmed by code: `desktop/src/App.svelte::buildPromptPayload` distinguishes
  path-backed images from pathless clipboard images; ACP materializes the
  private file-image metadata before prompting Pi.
- Confirmed by code: composer-to-task capture materializes any pathless image
  through `cache_task_attachment` before writing task attachment markers.
- Confirmed by docs: ACP resource links are baseline prompt content; Tauri's asset protocol serves local media and the opener plugin opens paths with the default application.
- Confirmed by user: files should be added by picker, drag-and-drop, and paste; non-image files should be passed to the agent by local path.
