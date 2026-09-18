import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PIX_RELEASES_URL = "https://github.com/dnaroid/pix/releases/latest";
export const PIX_RELEASES_API_URL = "https://api.github.com/repos/dnaroid/pix/releases/latest";
export const PIX_RELEASE_TARGETS = ["linux-x64", "macos-arm64", "macos-x64", "windows-x64"] as const;

export type ReleaseInstallVariant = "tui" | "desktop";

export type ReleaseInstallInfo = {
	version: string;
	target: string;
	variant: ReleaseInstallVariant;
};

export type GitHubReleaseAsset = {
	name: string;
	url: string;
	size?: number;
};

export type StableGitHubRelease = {
	tag: string;
	version: string;
	assets: GitHubReleaseAsset[];
};

export function isReleaseInstall(packageRoot: string): boolean {
	// Presence alone fails closed: a damaged manifest must never enable global npm mutation.
	return existsSync(join(packageRoot, ".pix-portable.json"));
}

export function readReleaseInstallInfo(packageRoot: string): ReleaseInstallInfo | undefined {
	const marker = join(packageRoot, ".pix-portable.json");
	if (!existsSync(marker)) return undefined;
	try {
		const data = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
		if (data.format !== 2 || typeof data.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(data.version)) return undefined;
		if (typeof data.target !== "string" || !PIX_RELEASE_TARGETS.includes(data.target as typeof PIX_RELEASE_TARGETS[number])) return undefined;
		if (data.variant !== "tui" && data.variant !== "desktop") return undefined;
		return { version: data.version, target: data.target, variant: data.variant };
	} catch {
		return undefined;
	}
}

export async function fetchLatestReleaseVersion(_packageName: string, currentVersion: string, timeoutMs: number): Promise<string | undefined> {
	return (await fetchLatestStableRelease(currentVersion, timeoutMs))?.version;
}

export async function fetchLatestStableRelease(currentVersion: string, timeoutMs: number): Promise<StableGitHubRelease | undefined> {
	const response = await fetch(PIX_RELEASES_API_URL, {
		headers: { accept: "application/vnd.github+json", "User-Agent": `pix/${currentVersion}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`GitHub Releases returned ${response.status}`);
	const data = await response.json() as Record<string, unknown>;
	if (data.draft === true || data.prerelease === true) return undefined;
	if (typeof data.tag_name !== "string" || !/^v\d+\.\d+\.\d+$/u.test(data.tag_name)) return undefined;
	const assets = Array.isArray(data.assets) ? data.assets.flatMap((entry): GitHubReleaseAsset[] => {
		if (typeof entry !== "object" || entry === null) return [];
		const asset = entry as Record<string, unknown>;
		if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") return [];
		return [{
			name: asset.name,
			url: asset.browser_download_url,
			...(typeof asset.size === "number" && Number.isSafeInteger(asset.size) && asset.size >= 0 ? { size: asset.size } : {}),
		}];
	}) : [];
	return { tag: data.tag_name, version: data.tag_name.slice(1), assets };
}

export function releaseUpdateHint(packageRoot?: string): string {
	const install = packageRoot ? readReleaseInstallInfo(packageRoot) : undefined;
	if (install?.variant === "tui") {
		return "Run `pix update` from a terminal to download, verify, and stage the matching portable release. Pix replaces its installation after the updater process exits; settings and sessions remain in your user profile.";
	}
	if (install?.variant === "desktop") {
		return "Use the Pix Desktop update notification to download, verify, install, and restart the native application. The bundled backend does not mutate npm or portable files.";
	}
	return `Download the complete package for your OS/CPU from ${PIX_RELEASES_URL}. The release marker is damaged or too old for safe self-update, so automatic replacement is disabled.`;
}
