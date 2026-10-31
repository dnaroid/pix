# Предложение: пользовательские хуки

Статус: предложение для согласования. Это не утверждённая архитектура и не разрешение на реализацию.

[Назад к разделу](index.md) · [Аудит](feature-audit.md)

## 1. Проблема

Простые автоматизации требуют писать и подключать TS-расширение Pi:

- «прогнать форматтер после правки»;
- «запретить `git push --force`»;
- «добавить вывод `git status` к каждому промпту»;
- «уведомить, когда агент ждёт ответа».

В Claude Code для этого есть декларативные hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `Notification` и другие) с shell-командой на событие. В Codex есть `notify`.

Все нужные события в Pi SDK уже есть (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`, SDK 1.4.0). Не хватает только декларативного слоя.

## 2. Предложение

### 2.1. Конфигурация

Секция `hooks` в существующих слоях конфигурации suite: пользовательский `~/.config/pi/pi-tools-suite.jsonc` и проектный `.pi/pi-tools-suite.jsonc`. Загрузчик и слияние слоёв переиспользуются из `external/pi-tools-suite/src/config.ts`, а не появляется новый файл.

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "command": ".pi/hooks/deny-force-push.sh", "timeoutMs": 5000 }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit|apply_patch", "command": "npx prettier --write \"$PIX_HOOK_FILE\"", "async": true }
    ],
    "Notification": [
      { "command": "terminal-notifier -message \"$PIX_HOOK_MESSAGE\"" }
    ]
  }
}
```

### 2.2. Соответствие событиям SDK

| Хук | Событие SDK | Что может хук |
|---|---|---|
| `PreToolUse` | `tool_call` | Заблокировать (`block` + `reason`), изменить аргументы (`updatedInput` → мутация `event.input`) |
| `PostToolUse` | `tool_result` | Добавить контекст к результату (дописать `content` с сохранением `structuredContent`), пометить `isError` |
| `UserPromptSubmit` | `input` | Заблокировать или дополнить текст (`transform`) |
| `Stop` | `agent_before_settle` | Вернуть `continue: true` с причиной, т.е. попросить агента продолжить. Счётчик защищает от зацикливания (например не больше 3 подряд) |
| `SessionStart` / `SessionEnd` | `session_start` / `session_shutdown` | Побочные эффекты; `SessionStart` может добавить контекст |
| `Notification` | `ui_prompt_start`, `agent_settled` | Только побочные эффекты |

`matcher` — регулярное выражение по **нормализованному** имени инструмента. Alias'ы `model-tools` (`Bash` / `bash` / `shell`, `Write` / `write`) приводятся к одному имени по той же логике, что `normalizedToolName` в `workspace-undo`. Опция `nested: false` исключает вызовы с `parentToolCallId` (codemode).

### 2.3. Протокол команды

- **stdin:** JSON с полями `{ hook, session_id, cwd, tool_name, tool_input, tool_result?, prompt?, transcript_path? }`. Поля совпадают с Claude Code там, где это возможно, чтобы готовые скрипты переносились без правок.
- **Переменные окружения:** `PIX_HOOK_EVENT`, `PIX_HOOK_TOOL`, `PIX_HOOK_FILE` (если путь однозначен), `PIX_PROJECT_DIR`.
- **Код возврата:** `0` — успех; stdout может содержать JSON `{ decision?: "block" | "allow", reason?, additionalContext?, updatedInput? }`. `2` — блокировка, stderr становится причиной (совместимо с CC). Любой другой код — неблокирующая ошибка: пишется в диагностический логгер ([logging](../../operations/logging.md)) и показывается предупреждением, ход продолжается.
- **Таймаут:** по умолчанию 10 с для блокирующих событий. При таймауте PreToolUse **не** блокирует: fail-open с предупреждением. Политика `failClosed: true` задаётся для конкретного хука.
- **Лимит вывода:** например 64 KB; `additionalContext` дополнительно усекается.

### 2.4. Производительность

SDK ожидает обработчики `tool_call` / `tool_result` последовательно, поэтому каждый синхронный хук добавляет задержку к инструменту. `async: true` (только для PostToolUse / Notification / SessionEnd) запускает команду без ожидания. Такие процессы привязаны к сессии и убиваются на `session_shutdown`. Подпроцессы хуков никогда не блокируют UI-поток Desktop: всё выполняется в ACP-процессе.

### 2.5. Доверие (главный риск)

Проектный `.pi/pi-tools-suite.jsonc` попадает в репозиторий. Если хуки из клонированного репозитория выполняются автоматически, это RCE. Поэтому:

- проектные хуки выполняются только в доверенном проекте (SDK `project_trust`) **и** после явного одобрения конкретного набора хуков;
- одобрение привязано к hash секции `hooks` и hash'ам упомянутых скриптов из `.pi/hooks/`. При изменении нужно одобрить заново. До одобрения хуки пропускаются, и показывается уведомление «N hooks pending approval»;
- пользовательские хуки из `~/.config/pi/` доверены по определению;
- аварийное отключение: `PI_TOOLS_SUITE_DISABLED_MODULES=hooks`.

## 3. Не входит в MVP

- Импорт `.claude/settings.json` hooks. Возможен позже по образцу `opencode-import`.
- Хуки как LLM-промпты (prompt-based hooks в CC).
- UI-редактор хуков в Desktop. На первом этапе достаточно просмотра списка и одобрения.

## 4. Проверка (при реализации)

- Unit-тесты маппинга: block по exit 2; `updatedInput`; `additionalContext` с сохранением `structuredContent`; таймаут fail-open/fail-closed; защита `Stop` от зацикливания; matcher по alias'ам; `nested: false`.
- Тест доверия: недоверенный проект → хуки не выполняются; изменился скрипт → требуется повторное одобрение.
- Тест очистки async-хуков на `session_shutdown`.

## 5. Открытые вопросы

1. Отдельный файл `.pi/hooks.jsonc` (как у CC — отдельно от прочих настроек) или секция в `pi-tools-suite.jsonc`? Предлагается секция.
2. Fail-open по умолчанию для PreToolUse — приемлемо? Альтернатива — fail-closed для хуков, помеченных как политика безопасности.
3. Нужна ли совместимость имён полей с CC один к одному или достаточно близкой?

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"68926e439e8d8a04a81026db12a0055720126541aa4b258fd58b08678866ae27","checkedAt":"2026-10-31T01:02:10.827Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":51,"reportLanguage":"ru"} -->
