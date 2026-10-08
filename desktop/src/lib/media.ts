import { attachmentKind, mimeTypeForName } from "./attachments";
import { isGlbPath } from "./glb";

export type PreviewMediaKind = "image" | "video" | "audio" | "model";

// Preview support is separate from prompt attachment kinds: audio remains a file
// attachment, rather than being sent to providers as an image/video content block.
export function previewMediaKindForPath(path: string): PreviewMediaKind | undefined {
  if (isGlbPath(path)) return "model";
  const mimeType = mimeTypeForName(path);
  if (mimeType.startsWith("audio/")) return "audio";
  const kind = attachmentKind(mimeType);
  return kind === "file" ? undefined : kind;
}
