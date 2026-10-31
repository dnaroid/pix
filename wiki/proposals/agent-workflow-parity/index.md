# Agent workflow parity (Claude Code / Codex)

Статус: исследование и предложения для согласования. Это не утверждённая архитектура и не разрешение на реализацию.

Здесь сравниваются рабочие возможности агента Pix с Claude Code и Codex CLI. Для трёх самых полезных пробелов есть отдельные предложения.

[Wiki home](../../index.md) · [Research and proposals](../index.md)

## Pages

- [Аудит возможностей 1–8](feature-audit.md): что есть, что частично есть, чего нет, с путями к исходникам.
- [Чекпоинты и откат кода](checkpoints.md): расширение существующего Undo changes на Bash-мутации, откат «только код» и предпросмотр.
- [Фоновые shell-процессы](background-shell.md): реализовано, см. [действующий контракт](../../tools/background-shell.md).
- [Пользовательские хуки](user-hooks.md): декларативные shell-хуки на события SDK, без написания расширения.

## Рекомендуемый порядок

1. Фоновые shell-процессы — реализовано ([контракт](../../tools/background-shell.md)). На момент исследования это была самая изолированная задача: SDK уже давал `BashOperations`, а `run_in_background` был помечен «Unsupported».
2. Пользовательские хуки. Это тонкий слой над уже существующими событиями `tool_call` / `tool_result` / `agent_settled`; главный риск — trust.
3. Чекпоинты. Самая ценная, но и самая рискованная задача: она затрагивает существующий контракт [Undo changes](../../desktop/conversations/desktop-user-message-actions.md) и параллельные сессии.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"1863a8c68a279b48d2aa65aa01ef99452e1db05411a86a1cc30c0cd843e88839","checkedAt":"2026-10-31T00:45:18.302Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":45,"reportLanguage":"ru"} -->
