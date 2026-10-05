# Claude Code `You Should Know` — local reverse-engineering snapshot

This directory is intentionally local-only. The repository ignores `.pi/`, so
none of these files should be committed.

## Source

- Wrapper package: `@anthropic-ai/claude-code@2.1.288`
- Native package: `@anthropic-ai/claude-code-darwin-arm64@2.1.288`
- Embedded Bun module: `/$bunfs/root/chunk-3wpxt1pf.js`
- Native executable SHA-256:
  `bbe93063f7a0879a1021b2891e5c9354e5b3b98433e32efe6750f7710afed750`

NPM metadata at extraction time:

- native tarball SHA-1:
  `8095f7c379eeacc17c7aefd459255e053ec04795`
- native integrity:
  `sha512-kioqJixZJY87Dgoog1VAHxPo+5h0XrDTRFLmZzRKxfjfEGF6aKv+Zt1OqJUfeUnD3+VUr+iqemRZ5vPTg2gGeQ==`
- wrapper tarball SHA-1:
  `db23b6403d85545e4575e97dbfdfbc5bb745f598`
- wrapper integrity:
  `sha512-tnc8XuK5xQkyE6oowhhSPIjLuNc0S3MkjIHqycDsKP6yJlLtIjMt6v1TOkYLUiumcZ9jOgJZ6h9Vn3/f0murdQ==`

## Files

- `chunk-3wpxt1pf.recovered-fragments.js` — recovered source fragments for
  the full built-in module. This is the main preservation copy.
- `carve-212m.strings.txt` — strings from the binary region containing the
  module, kept so the reconstruction can be checked or redone.
- `native-package.json` / `wrapper-package.json` — package metadata.
- `SHA256SUMS` — hashes for the preserved local extraction files.

## Important limitation

The recovered JavaScript is **not an exact source-file restoration and is not
guaranteed to parse as JavaScript**. The native Bun executable stores embedded
source/bytecode data and `strings` splits some template literals and control
boundaries. Function bodies, exports, prompts, constants and the main control
flow are nevertheless recoverable enough for behavioral analysis.

Do not treat this file as Anthropic's published source or copy it into Pix
product code. Use it only as a local reference when comparing behavior and
reconstruct Pix functionality independently.

## Reproduction

The native package can be fetched again with:

```sh
npm pack @anthropic-ai/claude-code-darwin-arm64@2.1.288
```

The wrapper package can be fetched with:

```sh
npm pack @anthropic-ai/claude-code@2.1.288
```
