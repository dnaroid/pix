# Wiki migration verification

## Scope and preservation

- Full text of **234 Markdown documents** and **10 screenshot assets** was relocated to Wiki. No documents were merged or deduplicated.
- [The migration map](migration-map.md) accounts for old/new paths and intentionally retained documents. [The inventory](inventory.md) records topics, purposes and lifecycle evidence. Source and destination SHA-256 values are in [the JSON map](migration-map.json).
- Every Markdown file from the original `docs/` and `specs/` trees has a mapped destination. Runtime-loaded instructions, package entry points, legal/upstream notices and test-fixture documents remain at their required locations.
- A working-tree baseline was captured before migration. Existing uncommitted edits were migrated as source content, not replaced with Git HEAD. No staging, reset, stash or commit was performed.
- Binary resources are byte-identical. A body comparison normalizing only document paths and Markdown link destinations initially matched 233/234 moved Markdown documents. The remaining Wiki feature specification received concurrent sidebar-search edits; those were preserved, not rolled back. Subsequent editorial maintenance is limited to migration guidance, caveats and links, not feature requirement changes.
- Final provenance verification accounted for all **244 mapped files**, with **0 hash or coverage errors**. The three expected body differences are the concurrent Wiki specification and editorial updates to the old contract catalogue and historical Desktop MVP references.
- The old `wiki/index.md` was only a generated placeholder. Its authoring instructions are covered by the new home and maintenance pages; it was not treated as substantive product documentation.

## Automated checks

| Check | Result |
| --- | --- |
| Wiki link/heading/media/reachability check | `npm run check:wiki`: **272 pages, 1665 local links, 5 inline images, 0 errors**; all 10 moved PNG/SVG assets also pass provenance checks |
| Checker regression tests | **3 passed**, including adjacent links, Unicode/duplicate Desktop heading IDs, resources, references, HTML links, broken links and orphan pages |
| Desktop Wiki, navigation, search, Markdown and preview tests | **207 passed across 10 files** |
| Tools-suite native-source configuration/policy, Wiki prompt, relocated plan guide and sub-agent contracts | **95 passed across 5 files** |
| Focused TypeScript check | Passed for the Wiki checker, its regression tests and screenshot capture script |
| Package dry run | **283/283 Wiki files** included; required tools-suite `docs/plan-writing.md` remains packaged |
| Whitespace | `git diff --check` passed |

Full test logs are disposable local evidence under `.pi/artifacts/wiki-migration-20261028T222615/`; this page retains the verification outcomes.
The focused checks are not a full CI/release certification. `npm run check:ci` was intentionally not run: project policy reserves it for release preparation or an explicit full push.

## Agent discovery

The existing `project_search` tool, with `sources: ["knowledge"]`, `indexMode: "lexical"` and `pathPrefix: "wiki"`, returned:

- `knowledge:wiki/tools/agents/owned-launch.md:1-20` for “durable detached-descendant containment launcher”;
- `knowledge:wiki/desktop/workbench/desktop-project-wiki.md:158-183` for “Project Wiki Markdown knowledge”, plus additional new feature and decision locations.

No embedding provider was called or configured, no source was enabled and no independent Wiki index was introduced. `.pi/workspace.jsonc` retains its existing settings; the default `wiki/index.md` is used.

## Remaining caveats

[Known conflicts](known-conflicts.md) records older semantic-search configuration guidance, Desktop platform/release-matrix drift, partial ADR supersession and experimental/unaccepted features. These were not silently reconciled by the migration.

## Native Desktop UI verification

The dedicated QA agent used an isolated workspace containing all **283 real Wiki files** and the unchanged default workspace configuration, not invented sample documentation. The live checkout and credentials were left untouched.

| Observable check | Outcome |
| --- | --- |
| Sidebar Wiki opens the index | **PASS** |
| Desktop → workbench opens the nested workspace-navigation specification | **PASS** |
| The real overview screenshot renders, rather than a broken image or placeholder | **PASS** |
| The troubleshooting link navigates to the Desktop guide's AppImage heading | **Not verified**: automation activation failed; the rendered link text was exposed as `AXStaticText` |
| Preview Back returns after that navigation | **Not run**: the preceding navigation did not occur |

The interaction blocker is not evidence of a missing Markdown target or heading: both passed the static check. It also does not prove a product defect. A manual pointer-driven check, or a supported automation activation path, is still needed for the last two interactions. No product code was changed to work around this limitation.

Screenshots and accessibility snapshots were retained under `.pi/artifacts/subagents/2026-10-28T21-24-48-wiki-ui/evidence/` and linked in the migration's user-facing report. These are temporary QA artifacts, not permanent Wiki dependencies. Earlier captures with an incorrect “Why Pix?” assertion and a runner-configuration failure are diagnostic evidence only, not product failures.
