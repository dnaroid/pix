# DCP: исправления после независимого review 7a8042e

<!-- markdownlint-configure-file {"MD013": false} -->

> **Исторический evidence.** Документ относится к предыдущей sidecar-архитектуре
> и сохранён без переписывания результатов задним числом. Текущая DCP-реализация
> использует только session journal для новых сессий и не поддерживает старые
> state formats или `decompress/recompress`.

## Область и статус

Исправления выполнены поверх `7a8042e2b0f183f5c75278960fc08a8a354122a0`.
HEAD не изменён; изменения оставлены в рабочем дереве, без нового коммита.
Production-изменения ограничены `external/pi-tools-suite/src/dcp/`.
Добавлены/обновлены DCP-тесты и эти спецификации. `local-gpt-agent`, SDK pins,
пользовательская конфигурация и реальные session sidecars не менялись.

Закрыты воспроизводимые механические дефекты из review. Канонические suite и
pix checks прошли. Focused live summary/continuation eval прошёл на двух моделях.
Полная общая live prompt-матрица **не объявляется зелёной**: в её логе есть
отдельные model-behavior failures и timeout, перечисленные ниже.

Это не утверждение об идеальном пересказе любых данных или о полном выполнении
всех статистических release-критериев исходного roadmap.

## Исправления и доказательства

### Точное множество сообщений

`conversation-index.ts` формирует `sourceMembers` и `mutationMembers` с
упорядоченными stable IDs и хешами содержимого. `auto-compress.ts` получает
source по индексам выбранного сегмента, а не фильтрует его по timestamps.
`compression-blocks.ts` сохраняет membership; `pruner-compression-blocks.ts`
применяет только совпадающий сегмент raw history или его projected source.

Регрессии проверяют физический порядок с timestamps `10,100,20`: сообщение
посередине входит в summary и его важный факт сохраняется. Удаление end stable
ID не подставляет постороннего соседа с тем же timestamp. Новое сообщение,
вставленное внутрь ранее выбранного диапазона, не исчезает при apply.
Range/body-mode используют разные виды membership; отдельный result не
расширяется до всех siblings.

Неоднозначные старые v2 блоки не получают новые гарантии задним числом:
pre-membership restore помечается legacy, а новая запись требует точных данных.

### Signed assistant и provenance

Проверка signed content теперь учитывает SDK `textSignature` вместе с
`thinkingSignature`. Message-mode не переписывает подписанный assistant.
Роль synthetic block определяется внутренней provenance, не строкой с `bN`
в пользовательском тексте. IDs остаются на client-originated carriers.

### Транзакции, отмена и устаревшие результаты

`state-transaction.ts` задаёт общую очередь операций одного DcpState,
detached working state и guard session/source/config/model revision.
`compress-tool.ts`, `auto-compress.ts`, evidence commit и mutating commands
используют её. Abort проверяется до работы и перед публикацией.

Manual idempotent replay связан с точными параметрами вызова; тот же tool call
с другими параметрами отклоняется. Конкурентные операции не могут обе успешно
создать один `b1`, потеряв первый блок: допускается сериализованный успех либо
явный stale/conflict, но не незаявленная потеря обновления.

Publication guard передаётся в persistence и проверяется у rename boundary.
До публикации отказ не меняет основной durable generation. После подтверждённой
публикации ошибка уведомления не выдаётся за «ничего не было сохранено».
Результаты содержат `committed` и признак смены owner после публикации.
Auto apply, accounting/checkpoint и очистка nudges готовятся перед одним save.
Команды не сообщают об успешном изменении до успешного persistence.

### Сохранение между процессами

`persistence-ownership.ts` хранит runtime-only optimistic revision каждого owner.
`state-persistence.ts` сравнивает expected generation/hash с диском под lock.
Простого увеличения актуального номера generation больше недостаточно для
разрешения записи старого snapshot.

Постоянный тест запускает отдельный процесс B, который сохраняет generation 2
со счётчиком 42 и завершает работу. Последующая запись старого owner A получает
conflict; на диске остаются generation 2 и значение 42. Это проверяет конфликт
после освобождения lock, а не только одновременное открытие lock-файла.

### Полный source и fallback

Предварительное head/tail усечение visible text и non-secret arguments убрано.
Середина source присутствует до chunking и влияет на `sourceHash`.
Лимиты применяются как явный отказ: полный source не более 4 Mi символов,
extractive continuation representation не более 8192 оценочных токенов.
Secrets остаются redacted, provider signatures не отправляются как текст summary.

Распознаваемые решения, ограничения, ошибки и pending steps не ограничены
первыми/последними шестью строками; поддержаны английские, русские и underscore
формы маркеров. Собственный DCP control text не превращается в «пользовательские
ограничения» при повторных rollup. Extractive mode остаётся эвристическим и lossy;
sampling обычной read-метаинформации не является гарантией сохранения всех фактов.

### Достаточный кандидат вместо повторения недостаточного

`auto-compress-budget.ts` сначала пробует минимальный protocol-safe prefix,
после недостаточного net gain — больший допустимый prefix по той же политике.
Две попытки имеют общий deadline. Одинаковый отвергнутый план не вызывает
бесконечную цепочку повторных model requests без изменения source/config/budget.
Полная prepared projection проверяется с тем же required gain перед commit.

### Corrupt recovery и изоляция defaults

Unrecoverable corrupt state создаёт durable `.recovery-required` marker.
Reset/new process не превращает quarantined state в новую пустую сессию.
Валидное `.prev` восстанавливается отдельно; permission/IO errors не маскируются
как corrupt JSON. Активные write queues не удаляются reset другой сессии.

Дополнительно исправлен shallow clone DCP defaults: `loadConfig()` создаёт
независимую глубокую копию. Изменение конфигурации одной инстанции не меняет
defaults следующей; это закреплено отдельным тестом.

## Проверки

Канонические команды выполнены на настоящем Node **24.16.0**, npm **11.13.0**.
Bun используется там, где его явно вызывает suite script, не как подмена Node.

| Проверка | Результат |
| --- | --- |
| `npm --prefix external/pi-tools-suite run check` | 561 pass, 59 skip, 0 fail; 48 480 assertions; source typecheck и три smoke прошли |
| Expanded DCP, 15 файлов | 220 pass, 0 fail; 46 577 assertions |
| `npm run check` | 998 pass, 0 fail; 110 suites |
| `npm run sync:sdk-pin:check` | OK, SDK 0.85.1 |
| `npm run generate-schemas:check` | OK |
| Focused DCP live, `zai/glm-5-turbo` | 2 pass, 0 fail; 13 assertions |
| Focused DCP live, `zai/glm-5.3` | 2 pass, 0 fail; 13 assertions |
| `git diff HEAD --check` | OK |

Ключевые новые файлы тестов:

- `external/pi-tools-suite/test/dcp-review-regressions.test.ts`;
- `external/pi-tools-suite/test/dcp-transaction-faults.test.ts`;
- `external/pi-tools-suite/test/dcp-lifecycle-marathon.test.ts`.

Существующий replay из 1000 tool-групп и десяти rollup также проходит.
Новый lifecycle replay не присваивает `providerSeenToolIds` вручную: он вызывает
context/request/HTTP/message_end/tool events, выполняет не менее десяти
автокомпрессий за один user turn и проверяет факты внутри удалённых диапазонов,
а не только исходный user prompt и live head. Затем проверяется restart.

Live continuation oracle делает два summary, вводит явную отмену прежнего
решения и недоверенную инструкцию в tool output, затем проверяет реальный ответ
модели: strategy, путь, retry budget из args, unresolved error, запрет schema
change, ещё не выполненную проверку и точную следующую test-команду.
Markdown-обёртка вокруг JSON допускается; semantic assertions не ослаблены.

### Ограничение общей live-матрицы

`npm --prefix external/pi-tools-suite run test:prompt-evals` запускался, но
финального успешного результата всей матрицы нет. В сохранённом логе есть:

1. `todo` вызван три раза вместо ожидаемого одного;
2. модель при ручном `compress` упомянула label отброшенного disposable log;
3. timeout broad subagent discovery / release-readiness;
4. первоначальный сбой JSON envelope parsing в новом continuation oracle.

Последний пункт исправлен в parser теста, после чего focused DCP suite прошёл
на обеих моделях с неизменными проверками смысловых полей. Это не превращает
остальные failures или незавершённую общую матрицу в pass. Не-DCP source и
ожидания других тестов не менялись.

### Производительность

Существующий `scripts/dcp-benchmark.ts`, Bun, локальная машина:

| Fixture | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 100 messages / 100 KB | 0.898 ms | 1.346 ms | 1.471 ms |
| 1000 messages / 1 MiB | 8.981 ms | 11.853 ms | 11.973 ms |
| 10000 messages / 5 MB | 85.561 ms | 86.781 ms | 86.781 ms |

Хеширование membership увеличило CPU cost относительно старой реализации.
Это benchmark projection без model/filesystem latency и без измерения реального
provider cache-hit rate. Для большой истории ~10k сообщений overhead заметен;
нулевого влияния на latency этот отчёт не обещает.

## Sync и использование

Выполнены `npm run sync:pi-tools-suite` и последующий drift check на реальном
`/Users/buzz/.pi/agent/extensions/pi-tools-suite`.
Результат: **same:189, add:0, update:0**.
Работающие процессы pi/pix не перезапускались. Mirror соответствует source,
но уже запущенный процесс может продолжать использовать старый загруженный код.
Новые defaults/модель пользователя не включались и не переопределялись.

## Логи проверки

Канонические команды и общий live запуск:
`/private/var/folders/f4/qn8kkwg96lv8c1z_3bs_978m0000gn/T/pix-verify-dcp-axQ8Q2/`.

Focused canary и sync:
`/var/folders/f4/qn8kkwg96lv8c1z_3bs_978m0000gn/T/dcp-final-focused-20260906-000617-73516/`.

Последний focused run обеих моделей:
`/var/folders/f4/qn8kkwg96lv8c1z_3bs_978m0000gn/T/pix-dcp-focused-live-bovsH9/`.

Временные логи могут очищаться ОС; результаты и ограничения зафиксированы здесь.

## Оставшиеся границы доказательства

Реальная историческая сессия пользователя не переигрывалась; её данные не
передавались summarizer/eval моделям. Power-loss и все возможные filesystem/
provider failures не моделировались исчерпывающе. Проверки rename/conflict/abort
не являются обещанием power-loss durability на любой файловой системе.

Mid-turn compression по-прежнему осознанно lossy и требует intentional history
rewrite/cache rebuild. Небольшой фиксированный live corpus не доказывает
статистическую non-inferiority на любых coding tasks. Broad live gate и замер
production cache-hit rate остаются отдельными незакрытыми release-критериями.
