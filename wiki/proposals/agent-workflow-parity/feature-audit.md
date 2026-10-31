# Аудит возможностей: Pix против Claude Code / Codex

Статус: снимок исследования на 2026-10-29 (Pi SDK 1.4.0). Проверено только чтением исходников и документации, в рантайме ничего не проверялось. «Нет» означает «не найдено в просмотренных путях»: `desktop/src`, `desktop/src-tauri`, `external/pi-tools-suite/src`, `acp/`, `src/`, установленный SDK.

[Назад к разделу](index.md)

| # | Возможность | Статус | Что есть (доказательство) | Пробел относительно CC/Codex |
|---|---|---|---|---|
| 1 | Чекпоинты / откат файлов | Частично | **Undo changes** откатывает сессию и записанные мутации `Write` / `Edit` / `apply_patch` / `ast_apply` ([контракт](../../desktop/conversations/desktop-user-message-actions.md), `src/bundled-extensions/workspace-undo/index.ts`, `src/app/workspace/workspace-undo.ts`). **Edit and resend** откатывает только историю. `desktop/src-tauri/src/project_file_history.rs` хранит историю операций проводника, а не правок агента. | Мутации через Bash не записываются. Нет режима «откатить только код». Нет предпросмотра того, что будет откачено. См. [checkpoints.md](checkpoints.md). |
| 2 | Пользовательские хуки | Частично | В SDK есть события расширений `input`, `tool_call` (block и мутация `input`), `tool_result`, `agent_settled`, `ui_prompt_start`, `session_start` / `session_shutdown` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`). | Нет декларативной конфигурации в стиле `.pi/hooks.jsonc` с shell-командой на событие. Сейчас нужно писать TS-расширение. См. [user-hooks.md](user-hooks.md). |
| 3 | Фоновые shell-процессы | Есть (после снимка) | На момент снимка `Bash` отклонял `run_in_background`. Реализовано модулем `external/pi-tools-suite/src/background-shell/`: см. [контракт](../../tools/background-shell.md). | Закрыто. Исходное предложение: [background-shell.md](background-shell.md). |
| 4 | Plan mode | Нет | Только `.pi/plans/` и подсказки в промпте. | Нет состояния «только чтение до утверждения плана». Технически его можно реализовать через блокировку в `tool_call`. |
| 5 | Режимы разрешений | Частично | `external/pi-tools-suite/src/shell-command-policy.ts` классифицирует команды по области и типу. | Нет режимов ask / accept-edits / auto, переключателя в UI и подтверждения с diff. |
| 6 | Песочница для shell | Нет | Расширения и shell работают с правами процесса. | Нет профиля `sandbox-exec` / Seatbelt (Codex `workspace-write`). |
| 7 | `@`-упоминание файлов | Есть | TUI и Desktop предлагают до 20 fuzzy-совпадений файлов и папок из общего локального индекса вне UI-потока; вложенные `.gitignore` учитываются, симлинки не обходятся. Поддерживаются инкрементальное наблюдение за файлами, клавиатурная/мышиная навигация и доступность; выбор вставляет буквальный `@path` (JSON-кавычки для пробелов/кавычек), без чтения/прикрепления содержимого. | Диапазоны строк не поддерживаются. См. контракт Desktop и соответствующую реализацию TUI. |
| 8 | `/review` с пресетами | Частично | Ревью диффа LLM в `GitDiffPane.svelte`, `GitPanel.svelte`, `GitCommitComposer.svelte`. | Нет команды `/review` и пресетов base-branch / uncommitted / commit. |
| — | `$ARGUMENTS` в prompt-командах | Нет | `external/pi-tools-suite/src/prompt-commands/index.ts` подставляет только `{cwd}` и `{{cwd}}`; команды хранятся в конфиге, а не в `.pi/commands/*.md`. | Нет параметризованных команд из файлов. |

## Поправка к первичной оценке

В первом обзоре пункт 1 был отмечен как «нет». На деле Pix уже ведёт журнал мутаций по каждому пользовательскому сообщению и откатывает их с защитой от конфликтов. Поэтому предложение по чекпоинтам расширяет существующий механизм, а не заменяет его.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"422d3327fcd03d4cba0bf100c62454264f85f75b2e626fa3a58d064eb451291f","checkedAt":"2026-10-31T00:44:29.072Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":65,"reportLanguage":"ru"} -->
