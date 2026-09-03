import { openUrl } from "@tauri-apps/plugin-opener";
import { normalizeExternalHref } from "./markdown";

type UrlOpener = (url: string) => Promise<void>;

export async function openExternalHref(
  href: string,
  opener: UrlOpener = openUrl,
): Promise<boolean> {
  const normalizedHref = normalizeExternalHref(href);
  if (!normalizedHref) return false;
  await opener(normalizedHref);
  return true;
}
