import { existsSync } from "node:fs";
import { join } from "node:path";

export const PIX_RELEASES_URL = "https://github.com/dnaroid/pix/releases/latest";

export function isReleaseInstall(packageRoot: string): boolean {
  // Presence alone fails closed: a damaged manifest must never enable global npm mutation.
  return existsSync(join(packageRoot, ".pix-portable.json"));
}

export async function fetchLatestReleaseVersion(_packageName: string, currentVersion: string, timeoutMs: number): Promise<string | undefined> {
  const response = await fetch("https://api.github.com/repos/dnaroid/pix/releases/latest", {
    headers: { accept: "application/vnd.github+json", "User-Agent": `pix/${currentVersion}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub Releases returned ${response.status}`);
  const data = await response.json() as Record<string, unknown>;
  if (data.draft === true || data.prerelease === true) return undefined;
  return typeof data.tag_name === "string" && /^v\d+\.\d+\.\d+$/u.test(data.tag_name)
    ? data.tag_name.slice(1) : undefined;
}

export function releaseUpdateHint(): string {
  return `Download the complete package for your OS/CPU from ${PIX_RELEASES_URL}. Close Pix before replacing it. Settings and sessions remain in your user profile. This installation does not update global npm/Pi packages.`;
}
