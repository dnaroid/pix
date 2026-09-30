---
kind: spec
status: active
---

# Claude Code provider image count

## Behavior

Pix's local suite Claude Code provider, derived from
`pi-claude-code-provider@0.5.0`, has no default 20-image count cap.
All image blocks in the effective context remain attached, including historical
images. Counting for metrics and file deduplication are unchanged. Explicit
count overrides in the upstream internal test seam still work.

## Constraints and failure cases

Image MIME/base64/content validation, per-image and aggregate byte limits,
transcript limits, and private-transport guards remain unchanged. This does not
guarantee that Claude Code or the remote service accepts unlimited images.

This is maintained source, not an npm patch installer. Upstream updates require
fresh review; see [local provider](claude-code-provider.md).

## Implementation

- `external/pi-tools-suite/src/claude-code-provider/src/context-serializer.ts`

## Tests

- `external/pi-tools-suite/test/claude-code-provider/image-count.test.ts`

## Verification

Run `bun test external/pi-tools-suite/test/claude-code-provider/image-count.test.ts`.
Tests exercise the real serializer without contacting Claude, including 21 and
100 images, deduplication/metrics and retained byte/MIME/base64/transcript guards.
