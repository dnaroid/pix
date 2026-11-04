# Pix demo: task to verified diff

**Status: recording script, not a completed live-agent demonstration.** Target:
Pix Desktop on supported macOS Apple Silicon. This scenario uses a disposable
public fixture, never a customer repository. No new Pix feature is required.

**Language requirement:** all visible screenshots and demo footage must be in
English: UI labels, prompts, agent replies, session/task names, source comments,
test names/output, captions and any narration. Do not publish mixed-language
captures or translate agent output by painting over a screenshot.

[Testing and QA](index.md) · [README](../../../README.md)

## Existing media and evidence limits

The checked-in [TUI overview](../../assets/screenshots/pix-overview.png),
[tabs](../../assets/screenshots/pix-tabs.png),
[command menu](../../assets/screenshots/pix-command-menu.png),
[todo panel](../../assets/screenshots/pix-adaptive-todo.png) and
[subagents panel](../../assets/screenshots/pix-subagents.png) were produced by
the [capture harness](../../../scripts/capture-readme-screenshots.ts).
It runs the real TUI renderer, but supplies a local `MockModel` and fixture
todo/subagent responses. These illustrate presentation, **not** live model
quality, actual parallel execution or native Desktop behavior.

The existing overview used in README is English. The capture script and all
five companion SVG text captures contain no Cyrillic text; review the rendered
media as well before publishing a new selection.

The tracked media inventory contains no Desktop walkthrough video or native
Desktop screenshot suitable for the README hero. Do not relabel the TUI images
or manufacture agent results to fill that gap. This audit did not launch or
test the GUI; recording and native acceptance remain unverified.

## Prepare off-camera

1. Use an installed Pix Desktop release or an already working development build.
   For an isolated native test copy, follow [isolated QA](desktop-qa-isolated-launch.md);
   do not restart a working daily session just for a recording.
2. Run `npm run qa:sandbox` in the Pix checkout and note the returned workspace.
   It copies the public [QA fixture](../../../fixtures/qa/pix-project/README.md)
   into a unique disposable location. Keep all demo edits in that copy.
3. In that disposable workspace, run `npm test`: the baseline has two greeting
   tests and no dependency installation is required. First apply the
   [English-only fixture preparation](#english-only-fixture-preparation) below,
   then run the tests. Initialize the review
   baseline with `git add .` and `git commit -m "Demo baseline"` **there only**.
   The generated repository has no remote; do not add one. Ensure Git author
   identity is acceptable for recording before committing.
4. Connect a provider off-camera using the normal UI. A live task consumes
   provider quota and sends selected fixture/context text to that provider.
   Do not record credentials, account settings, private profiles or OAuth flows.
   Use lexical project search; embeddings are not needed for this scenario.
5. Close unrelated tabs, notifications and customer projects. Record only the
   Pix window. Use an English project/session name, English application/system
   menus and readable UI scale. Keep the
   release/build identifier and unedited recording for provenance.

### English-only fixture preparation

The reusable QA template intentionally contains Unicode examples. For this
recording, adjust **only the disposable copy**, before the baseline commit:

- In `test/greeting.test.mjs`, replace the second test with
  `test("named greeting", () => assert.equal(greeting("Ada"), "Hello, Ada!"));`.
  Keep the default test unchanged.
- In `docs/notes.md`, use the heading `# QA notes — test project` and replace
  the non-English search-phrase checklist item with
  `- [ ] Find the English phrase: safe sandbox.`
- In `data/items.json`, set the `unicode` record's label to `safe sandbox`.
- In the copied `README.md`, describe `docs/notes.md` as Markdown, English
  sample text and a checklist.

This is an English demo baseline, not a change to Pix's Unicode QA coverage.
The actual whitespace fix and new tests must still be performed live by the
agent. Review the project files and any inherited instructions before recording
so retrieved snippets and visible tool results are also English.

## Prompt to use

```text
Use English for all replies, plans, task/session titles, comments and tests.
In this disposable demo project, update greeting(name) to trim surrounding
whitespace. An empty or whitespace-only name must use "QA". Preserve the
existing default and named-greeting behavior. First locate the implementation and
tests with lexical project search, then read the original files. Add focused
regression tests, make the smallest change and run npm test. Report changed
files and the actual test result. Do not install dependencies, commit, push,
access other projects or modify Pix itself.
```

Expected outcomes: `greeting("  Ada  ")` returns `Hello, Ada!`;
`greeting("")` and `greeting("   ")` return `Hello, QA!`; the two existing
cases continue to pass. Do not pre-populate agent messages or test results.

## Recording storyboard (edited target: 60–90 seconds)

| Time | Action | Observable evidence / suggested caption |
| --- | --- | --- |
| 0–10 s | Open the disposable project in Pix Desktop. Show Project Explorer and the greeting files. | “A project workspace, not an isolated chat.” |
| 10–20 s | Start a conversation and submit the prompt above. | The actual task and acceptance criteria remain readable. |
| 20–35 s | Expand the lexical search result, then the source/test reads. | “Retrieve context, then verify against original files.” If search has no hit, retain the honest fallback instead of staging a result. |
| 35–55 s | Show tool edits and the test invocation. | “The agent implements; checks provide evidence.” Keep failures and retries honest. |
| 55–75 s | Open Source Control and inspect the implementation/test diff. Expand the test output. | The two existing cases and new whitespace regressions pass; show the real command/count, not a typed success caption. |
| 75–90 s | Return to the agent's summary and the uncommitted diff. | “Review before committing.” No push, release or automatic acceptance. |

The live task may take longer. Cut waiting time or speed it up with a visible
label; never present the edited duration as a performance measurement. If the
run fails or blocks, report that outcome or record a new successful run—do not
splice results from a different implementation into a success story.

## Publish only after inspection

- Verify that the diff matches the task and test output belongs to that run.
- Review every visible text surface and audio track for English-only presentation.
  If the agent or UI introduces another language, correct the setup and record
  again; do not fake the displayed conversation or verification output.
- Check every frame, terminal line and filename for secrets, personal paths,
  account details and unrelated code. Do not include the private QA profile.
- Retain the raw recording privately. Export an approved, uniquely named still
  to `wiki/assets/` and a short video to a public location approved by the owner.
  Scratch files under `.pi/artifacts/` may be cleaned immediately and are not
  durable public demo URLs.
- Add the real screenshot/video to README with build/date and fixture scope.
  Replace the fixture preview only once a native capture exists. Do not claim
  that this small task validates larger-project performance or all platforms.
