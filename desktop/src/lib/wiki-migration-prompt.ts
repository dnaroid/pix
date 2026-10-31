import type { ProjectWikiConfig } from "./project-wiki";

/**
 * One-shot task for a fresh agent session: move the project's scattered
 * documentation into the configured Wiki, keep every reference working and
 * leave a navigable section structure. Only offered while the Wiki holds
 * nothing but its starter index.
 */
export function wikiMigrationPrompt(config: ProjectWikiConfig): string {
  const wiki = config.path;
  const index = config.indexPath;
  const sectionIndex = config.index.split("/").at(-1)!;
  return `Migrate this project's documentation and specifications into the project Wiki.

The Wiki lives in \`${wiki}/\`; its root page is \`${index}\`. It currently holds only a starter index — replace that placeholder text. Every section folder gets its own \`${sectionIndex}\` page.

## 1. Inventory (read before moving anything)

- Find every human-written documentation file in the repository: \`docs/\`, \`doc/\`, \`documentation/\`, \`specs/\`, \`spec/\`, \`design/\`, \`adr/\`, \`rfcs/\`, \`notes/\`, standalone \`*.md\`/\`*.markdown\`/\`*.mdx\`/\`*.txt\` guides and requirement documents anywhere in the tree, plus the images and diagrams they reference.
- Skip dependencies, vendored and generated output, build artifacts, git submodules, test fixtures, changelog fragments and harness scratch storage (\`node_modules/\`, \`vendor/\`, \`dist/\`, \`build/\`, \`.git/\`, \`.pi/\`, and anything listed in \`.gitignore\`).
- Do not relocate files that tools, registries or law require at a fixed path: root \`README*\`, \`LICENSE*\`, \`NOTICE*\`, \`CHANGELOG*\`, \`CONTRIBUTING*\`, \`SECURITY*\`, \`CODE_OF_CONDUCT*\`, \`AGENTS.md\`, \`CLAUDE.md\` and other agent instruction files, \`.github/\` templates, package README entry points and skill/prompt files that programs load. If such a file contains long-lived documentation, move that content into the Wiki and leave a short summary with a link in the original file.
- Search the code for runtime reads of documentation paths (bundled docs, help text, schema \`$ref\`s, package \`files\` lists). Leave those files in place unless you also update the code that loads them.
- Record the inventory as a migration map: old path → new Wiki path (or "kept in place" / "merged into …" / "archived") with a one-line reason.

## 2. Structure

- Group pages by subject, not by the old folder layout. Typical sections: getting started, usage, architecture, development, operations, reference, decisions (ADRs), proposals, archive — use only the sections this project actually needs and name them for its own domain.
- One subject per page. Merge duplicated or overlapping documents into one page instead of copying them; when sources disagree, keep the current behavior (verify against the code) and note the discrepancy for the final report.
- Put obsolete, superseded or historical material under an archive section, with a note that it is historical, rather than deleting it.
- Use lowercase kebab-case names for files and folders. Keep images in an \`assets/\` folder beside the pages that use them (or a shared \`${wiki}/assets/\`).
- \`${index}\` explains what the project is in a few sentences and links every section index. Each section \`${sectionIndex}\` describes the section and links every page in it. No page may be unreachable from \`${index}\`.
- Preserve the original language and wording of moved documents; edit only headings, structure and links. Write new index pages in the language most of the documentation uses.

## 3. Move

- Move files with \`git mv\` when the project is a Git repository so history follows them; merge content only where the plan says so.
- Remove source folders that become empty. Do not leave a parallel \`docs/\` or \`specs/\` tree behind.

## 4. Fix every reference

- Rewrite relative links and image paths inside the moved pages so they resolve from their new location, including \`#anchor\` fragments whose headings changed.
- Search the whole repository — code comments, error messages, configuration, scripts, CI workflows, tests, package manifests, README and agent instruction files — for the old paths (with and without \`./\`, with and without the extension) and update each one to the new Wiki path.
- Update agent instruction files (\`AGENTS.md\`, \`CLAUDE.md\` and similar) so they point to \`${index}\` as the documentation entry point and say that new guides, requirements and specifications belong in \`${wiki}/\`.
- Absolute URLs to the hosted repository (for example \`github.com/<owner>/<repo>/blob/<branch>/docs/…\`) must point to the new paths as well.

## 5. Verify

- Check every relative link and image in \`${wiki}/\` and in every file you edited: each target file must exist and each anchor must match a heading. Use a small script, not spot checks, and fix what it finds.
- Search once more for each old path from the migration map; only intentional mentions (the migration map itself, historical changelog entries) may remain.
- Run the project's existing documentation or Markdown checks if it has them, plus the focused tests for any code or configuration you touched.

## Rules

- Do not change product behavior. Code edits are limited to updating paths.
- Do not commit or push; leave the changes in the working tree for review.

Finish with a short report: the section tree, the migration map, files kept in place and why, merges and discrepancies found, and the verification you ran with its results.`;
}
