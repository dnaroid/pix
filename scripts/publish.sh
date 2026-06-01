#!/usr/bin/env bash
# =============================================================================
# Publish pi-ui-extend to npm via CI.
#
# Prerequisites:
#   1. npm Granular Access Token with package read/write access.
#   2. Token stored in GitHub repo secret: NPM_TOKEN
#      gh secret set NPM_TOKEN
#   3. All release changes committed.
#
# Usage:
#   npm run publish-npm              # patch release
#   npm run publish-npm -- minor      # minor release
#   npm run publish-npm -- major      # major release
#   npm run publish-npm -- 0.2.0      # exact version
#
# What happens:
#   1. Verifies the current branch and clean working tree.
#   2. Pulls latest from the release branch.
#   3. Runs the normal release check before changing the version.
#   4. Bumps package.json + package-lock.json and creates a git tag.
#   5. Smoke-tests the packed tarball users will install.
#   6. Pushes the release commit + tag; GitHub Actions publishes to npm.
# =============================================================================
set -euo pipefail

RELEASE_BRANCH="${PIX_RELEASE_BRANCH:-master}"
REMOTE="${PIX_RELEASE_REMOTE:-origin}"
BUMP="${1:-patch}"

BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [[ "$BRANCH" != "$RELEASE_BRANCH" ]]; then
	echo "Error: must be on ${RELEASE_BRANCH} branch (currently on ${BRANCH})" >&2
	exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Error: working tree is dirty. Commit or stash changes first." >&2
	exit 1
fi

echo "→ Pulling latest from ${REMOTE}/${RELEASE_BRANCH}..."
git pull --rebase "$REMOTE" "$RELEASE_BRANCH"

echo "→ Running release check before bump..."
npm run release:check

echo "→ Bumping ${BUMP} version..."
NEW_VERSION=$(npm version "$BUMP" -m "chore(release): %s")
echo "  Version: ${NEW_VERSION}"

echo "→ Running smoke-test on packed artifact..."
npm run smoke-test

echo "→ Pushing ${RELEASE_BRANCH} and ${NEW_VERSION}..."
git push "$REMOTE" "$RELEASE_BRANCH"
git push "$REMOTE" "$NEW_VERSION"

echo "✓ Pushed ${NEW_VERSION} — CI will build, smoke-test, and publish to npm"
