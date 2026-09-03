export const MAX_ATTACHMENTS = 10;
export const MAX_EMBEDDED_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_EMBEDDED_PROMPT_BYTES = 50 * 1024 * 1024;
export const PIX_ATTACHMENT_MARKER_PREFIX = "[Pix attachment: ";

export type AttachmentKind = "image" | "video" | "file";

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly size?: number;
  readonly path?: string;
  readonly dataUrl?: string;
}

export interface AttachmentFile {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  mp4: "video/mp4",
  ogv: "video/ogg",
  webm: "video/webm",
};

export function attachmentKind(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

export function mimeTypeForName(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase();
  return extension ? MIME_BY_EXTENSION[extension] ?? "application/octet-stream" : "application/octet-stream";
}

export function attachmentFromFile(file: AttachmentFile, id: string): Attachment {
  const mimeType = mimeTypeForName(file.name);
  return {
    id,
    name: file.name,
    kind: attachmentKind(mimeType),
    mimeType,
    size: file.size,
    path: file.path,
  };
}

export function attachmentFromImage(
  data: string,
  mimeType: string,
  id: string,
  uri?: string | null,
): Attachment {
  const path = uri ? filePathFromUri(uri) ?? undefined : undefined;
  return {
    id,
    name: path ? fileNameFromPath(path) : `image.${extensionForMimeType(mimeType)}`,
    kind: "image",
    mimeType,
    ...(path ? { path } : {}),
    dataUrl: `data:${mimeType};base64,${data}`,
  };
}

export function fileUriFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("//")) {
    const [host, ...segments] = normalized.slice(2).split("/");
    return `file://${host}/${segments.map(encodeURIComponent).join("/")}`;
  }
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const segments = absolute.split("/").map((segment, index) =>
    index === 1 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment));
  return `file://${segments.join("/")}`;
}

export function filePathFromUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    const url = new URL(uri);
    let path = decodeURIComponent(url.pathname);
    if (url.hostname) path = `//${url.hostname}${path}`;
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  } catch {
    return null;
  }
}

export function attachmentMarker(path: string): string {
  return `${PIX_ATTACHMENT_MARKER_PREFIX}${fileUriFromPath(path)}]`;
}

export function extractAttachmentMarkers(
  text: string,
  idPrefix: string,
  attachmentOffset = 0,
): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const marker = /^\[Pix attachment: (file:\/\/[^\]]+)\][ \t]*$/gm;
  const cleaned = text.replace(marker, (_match, uri: string) => {
    const path = filePathFromUri(uri);
    if (!path) return _match;
    const name = fileNameFromPath(path);
    attachments.push(attachmentFromFile(
      { path, name, size: 0 },
      `${idPrefix}:attachment:${attachmentOffset + attachments.length}`,
    ));
    return "";
  });
  return {
    text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    attachments,
  };
}

export function fileNameFromPath(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/svg+xml": return "svg";
    default: return mimeType.split("/").at(-1) || "bin";
  }
}
