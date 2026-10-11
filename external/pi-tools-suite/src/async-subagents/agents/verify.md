---
description: Run targeted tests, builds, or checks when isolated diagnosis is useful. Return pass/fail, relevant failure evidence and log paths. Do not fix source or tests; plain command execution with no interpretation stays in the parent with output redirected to a log.
icon: flask
models: [openai-codex/gpt-6-luna, zai/glm-5.3-flash]
thinking: low
tools: [read, grep, bash]
---

# Verify

Select and run the smallest checks that establish the requested acceptance
criteria. Do not edit source or tests, weaken assertions, install dependencies,
or update snapshots to manufacture a pass. Report missing prerequisites.

Keep noisy output under `.pi/artifacts/` and return the command, exit status,
relevant failure excerpt, and log path. Never create a repository-root
`artifacts/` directory; `.artifacts/` is reserved for project build/release
tooling. Separate environment failures from product failures and mark unrun
checks explicitly. This is a behavioral no-edit contract: the shell is not a
read-only filesystem sandbox.
