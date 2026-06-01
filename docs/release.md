# Release and update verification

Use this checklist before publishing `pi-ui-extend` so installs work on macOS, Linux, and Windows and the `pi-tools-suite` extension payload is included.

## Local release check

```bash
npm install --ignore-scripts
npm run release:check
npm run smoke-test
```

`release:check` runs type checking, the test suite, a production build, and `npm pack --dry-run`.
`smoke-test` packs the real tarball, installs it into an isolated temp directory, checks the bundled files, and runs non-interactive `pix` commands from the installed package.

## Publish a new npm version

Pix uses the same release style as `indexer-cli`: a local command bumps the version, smoke-tests the tarball, then pushes the release commit and tag. GitHub Actions publishes the tag to npm using the `NPM_TOKEN` repository secret.

One-time setup:

```bash
gh secret set NPM_TOKEN
```

Release commands:

```bash
npm run publish-npm              # patch release
npm run publish-npm -- minor      # minor release
npm run publish-npm -- major      # major release
npm run publish-npm -- 0.2.0      # exact version
```

The command requires a clean working tree on `master`, pulls latest from `origin/master`, runs `release:check`, runs `npm version`, runs the tarball smoke test, then pushes the branch and `v*` tag. The tag workflow verifies that `package.json` matches the tag before `npm publish --access public`.

Only the root `package.json` version is bumped for Pix releases. Do not bump `external/pi-tools-suite/package.json` unless publishing the suite as a separate package.

## Tarball smoke test

From a clean temporary directory:

```bash
npm pack /path/to/pi-ui-extend
npm install -g ./pi-ui-extend-*.tgz --ignore-scripts
pix update --check
```

Confirm the dry-run/pack output contains:

- `bin/pix.mjs`
- `dist/**`
- `extensions/**`
- `external/pi-tools-suite/**`
- `README.md` and `docs/release.md`

## External suite checks

`external/pi-tools-suite` is a real checked-in package directory, not a symlink. Pix links it into the standard user extension location (`~/.pi/agent/extensions/pi-tools-suite` on macOS/Linux) before creating SDK services. The normal test suite verifies both the renderer-owned bundled extensions and the suite installer/link behavior.

When Bun is available, also run the suite's own checks:

```bash
npm --prefix external/pi-tools-suite test
```

Some modules have optional runtime dependencies or host services:

- `web-search` requires a local Ollama web-search/web-fetch API.
- `terminal-bell` uses optional platform notification helpers when present.
- `async-subagents` writes run state under the workspace `.pi/subagents/` directory.

## Update UX

- `/update` inside Pix performs a non-mutating npm latest-version check and tells the user what to run.
- `pix update --check` performs the same check without a TTY.
- `pix update` updates package-manager installs of Pix and therefore also updates the `external/pi-tools-suite` payload. The next Pix startup refreshes the user extension link.
- Source checkouts are intentionally not self-mutated; update them with `git pull`, `npm install --ignore-scripts`, `npm run build:pix`, and `npm run link:pix`.
- Separately installed Pi packages are updated by Pi itself with `pi update --extensions` or `pi update`.

Update checks respect `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PIX_SKIP_VERSION_CHECK=1`.
