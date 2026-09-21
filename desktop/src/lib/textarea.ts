export interface AutosizeTextareaOptions {
  minHeight: number;
  maxHeight: number;
}

export function autosizeTextarea(
  textarea: HTMLTextAreaElement,
  { minHeight, maxHeight }: AutosizeTextareaOptions,
): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}
