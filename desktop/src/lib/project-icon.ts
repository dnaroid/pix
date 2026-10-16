/** Validated image returned by the Rust project-icon commands. */
export interface ProjectIconImage {
  readonly mimeType: string;
  readonly dataBase64: string;
}

/** `keep` leaves the stored logo untouched; `none` reverts to initials. */
export type ProjectIconChange =
  | { readonly kind: "keep" }
  | { readonly kind: "none" }
  | { readonly kind: "image"; readonly image: ProjectIconImage };

export interface ProjectSettingsDraft {
  readonly color: string | undefined;
  readonly icon: ProjectIconChange;
}

export function projectIconDataUrl(image: ProjectIconImage): string {
  return `data:${image.mimeType};base64,${image.dataBase64}`;
}
