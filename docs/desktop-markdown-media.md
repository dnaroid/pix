# Spec: Desktop Markdown media previews

## Type

Change

## Goal

Show an inline preview when transcript Markdown links to a supported local image or video, including `file://` artifacts outside the active workspace, and keep every local artifact label actionable.

## Scope

- Relative Markdown destinations that resolve inside the active workspace.
- Absolute local paths expressed as `file://` Markdown destinations, such as QA artifacts in the system temporary directory.
- Image formats: AVIF, BMP, GIF, JPEG, PNG, SVG, and WebP.
- Video formats: M4V, MOV, MP4, OGV, and WebM.
- Both ordinary Markdown links and local Markdown image syntax.

## Non-goals

- Embedding remote media.
- Adding codecs beyond those supported by the desktop WebView.
- Changing previews for non-media project files.
- Inline previews for non-media `file://` artifacts; those remain links and open in the operating-system default application.

## Behavior

- A supported local media link renders an inline, bounded preview with its Markdown label as a caption.
- A supported `file://` media link uses the same preview treatment after its URL is decoded to an absolute local path.
- Images are lazy-loaded and open the existing media preview dialog when clicked.
- Videos expose native inline playback controls; their caption opens the media preview dialog.
- A missing, disallowed, or unrenderable media file leaves a readable fallback and a clickable caption.
- Opening a supported media link uses the media path flow, not the UTF-8 source-file reader.
- Other relative project links continue to open the source preview dialog.
- Other `file://` links remain visibly clickable and open only after an explicit click.

## Contracts

- The frontend requests a resolved media file using the active workspace and normalized relative path.
- The backend canonicalizes both workspace and destination, rejects traversal and symlink escapes, verifies a supported extension, and grants asset-protocol access only to the resolved file.
- A `file://` destination is accepted only when it decodes to an absolute path. The backend canonicalizes it, requires an existing regular file, and grants asset-protocol access only for supported image/video previews.
- Non-media local files are passed to the OS opener only in response to a user click.
- Markdown output continues to escape labels, paths, and attributes before insertion through `{@html}`.

## Edge cases

- URL-like, absolute, control-character, and parent-traversing destinations are not treated as project media.
- URL schemes other than `file://`, malformed file URLs, relative `file:` forms, and decoded control characters are not treated as local files.
- Query strings and fragments are removed by the existing project-path normalization.
- Media loading failures do not replace the transcript with a global error.
- Clicking a failed media caption still reports the underlying file-resolution error through the normal project-file action.

## Related files

- `desktop/src/lib/markdown.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`

## Verification

- Markdown unit tests cover workspace and `file://` image/video links, image syntax, escaping, and rejected destinations.
- Rust unit tests cover supported workspace/absolute media, unsupported binary files, relative local paths, traversal, and workspace containment.
- `npm run test`, `npm run check`, and `npm run build:web` pass in `desktop/`.
- `cargo test` passes in `desktop/src-tauri/`.

## Risks / unknowns

- Actual video playback remains codec-dependent in the operating-system WebView; load failures use the fallback state.
- A transcript can request an inline view of any readable local image/video via an explicit `file://` URL. The bytes remain local and are exposed only to the app's scoped asset protocol.

## Evidence

- Confirmed by code: relative links currently call `read_project_file`, which always decodes bytes as UTF-8.
- Confirmed by code: attachment previews already use Tauri's scoped asset protocol and the existing media dialog.
- Confirmed by the reported session: QA artifact links use `file:///tmp/...`, which the project-path normalizer intentionally rejects and previously reduced to plain labels.
- Confirmed by tests: project paths are normalized and constrained to the active workspace.
