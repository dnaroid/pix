# Running Playwright Tests

To run Playwright tests, use the `npx playwright test` command, or a package manager script. To avoid opening the interactive html report, use `PLAYWRIGHT_HTML_OPEN=never` environment variable.

```bash
# Run all tests
PLAYWRIGHT_HTML_OPEN=never npx playwright test

# Run all tests through a custom npm script
PLAYWRIGHT_HTML_OPEN=never npm run special-test-command
```

# Debugging Playwright Tests

To debug a failing Playwright test, run it with `--debug=cli` option. This command will pause the test at the start and print the debugging instructions.

**IMPORTANT**: run the command in the background, record its PID as owned by the task, and check the output until "Debugging Instructions" is printed. As soon as the generated `tw-...` name appears, register that exact session as owned by this debug run. Plan cleanup immediately: on success, failure, interruption, or timeout, detach the CLI session, stop and reap the background test PID, then check `playwright-cli list` and verify the generated name is absent.

Once instructions containing a session name are printed, use `playwright-cli` to attach the session and explore the page.

```bash
# Run the test in the background and retain ownership of its PID.
PLAYWRIGHT_HTML_OPEN=never npx playwright test --debug=cli > playwright-debug.log 2>&1 &
TEST_PID=$!
# ...
# ... debugging instructions for "tw-abcdef" session ...
# ...

# Attach to the test
playwright-cli attach tw-abcdef
```

Keep the test running in the background while you explore and look for a fix.
The test is paused at the start, so you should step over or pause at a particular location
where the problem is most likely to be.

Every action you perform with `playwright-cli` generates corresponding Playwright TypeScript code.
This code appears in the output and can be copied directly into the test. Most of the time, a specific locator or an expectation should be updated, but it could also be a bug in the app. Use your judgement.

After fixing the test, clean up before rerunning or responding:

```bash
# Detach does not close an external browser. Ignore "not attached" if the test already exited.
playwright-cli -s=tw-abcdef detach || true
kill "$TEST_PID" 2>/dev/null || true
wait "$TEST_PID" 2>/dev/null || true
playwright-cli list  # verify tw-abcdef is absent
```

Do not use `close-all` or `kill-all`: other debug or automation sessions may belong to another task. Rerun normally to check that the test passes.
