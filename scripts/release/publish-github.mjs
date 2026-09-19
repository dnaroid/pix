import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checksums, expectedPublishedAssets } from "./checksums.mjs";
import { run, version } from "./common.mjs";

export function assertDraft(release, tag) {
  if (release.tag_name !== tag || release.draft !== true) {
    throw new Error(`Refusing to overwrite a published or mismatched release: ${tag}`);
  }
}

export function assertPublished(release, tag) {
  if (release.tag_name !== tag || release.draft === true || release.prerelease === true) {
    throw new Error(`Release did not publish as stable latest: ${tag}`);
  }
}

export async function findRelease(repository, tag, token, fetcher = fetch) {
  // The by-tag endpoint only guarantees published releases. Authenticated listings include drafts.
  for (let page = 1; page <= 100; page++) {
    const response = await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "pix-release" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot inspect GitHub Releases (${response.status}); no release was modified`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error("Invalid release listing; refusing to publish");
    const match = releases.find((release) => release.tag_name === tag);
    if (match) return match;
    if (releases.length < 100) return undefined;
  }
  throw new Error("Release listing safety limit exceeded; refusing to create a potentially duplicate release");
}

export async function waitForRelease(repository, tag, token, fetcher = fetch, { attempts = 12, delayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const release = await findRelease(repository, tag, token, fetcher);
    if (release) return release;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return undefined;
}

async function publish(directory) {
  const tag = process.env.GITHUB_REF_NAME;
  const repository = process.env.GITHUB_REPOSITORY;
  if (tag !== `v${version()}` || repository !== "dnaroid/pix") throw new Error("Release tag/repository mismatch");
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is required");
  await checksums(directory, version());
  let release = await findRelease(repository, tag, token);
  if (!release) {
    run("gh", ["release", "create", tag, "--repo", repository, "--verify-tag", "--draft", "--title", `Pix ${tag}`, "--generate-notes"]);
    release = await waitForRelease(repository, tag, token);
  }
  if (!release) throw new Error("Created draft is not visible; refusing to upload assets");
  assertDraft(release, tag);
  const files = [...expectedPublishedAssets(version()), "SHA256SUMS"].map((name) => resolve(directory, name));
  run("gh", ["release", "upload", tag, ...files, "--repo", repository, "--clobber"]);
  run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
  release = await waitForRelease(repository, tag, token);
  if (!release) throw new Error("Published release is not visible after publication");
  assertPublished(release, tag);
  console.log(`Published ${tag} with the complete verified matrix and marked it Latest.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: publish-github.mjs <assets-directory>");
  await publish(resolve(process.argv[2]));
}
