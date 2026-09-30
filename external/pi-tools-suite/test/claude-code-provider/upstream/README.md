# Upstream offline tests

Ported from chem/pi-claude-code-provider commit
`a87b98539f57945b8a6df8c26db4cdcf3ed38a7a` (v0.5.0), MIT © 2026 chem.
The adjacent LICENSE is retained verbatim. Runtime provenance and update steps:
[`src/claude-code-provider/UPSTREAM.md`](../../../src/claude-code-provider/UPSTREAM.md).

All 21 behavioral unit suites use local Node/fake-CLI fixtures, not Claude.
Run `npm run test:claude-provider-upstream` from the suite; the normal `npm test`
also runs them after Bun tests. `.case.js` keeps Bun from discovering the Node
runner fixtures twice. Files run serially to avoid stressing process-cleanup
deadlines concurrently. Platform-specific skips remain upstream constraints.

Local adaptations: imports resolve the maintained adapter; TypeScript uses the
installed `tsx` loader rather than the upstream source-map shim. Image-count
rejection cases explicitly set the internal count override; default >20-image
acceptance is covered by `../image-count.test.ts`. The optional compat-resolution
fixture denies only the adapter import, not the current SDK's own dependency.
Metric timeout diagnostics include only category/phase/cleanup state.

Release-policy, repository branding/lint and paid live-smoke suites are not
ported: they test the upstream distribution or external service rather than
this adapter's offline behavior. No fake CLI result constitutes service QA.
