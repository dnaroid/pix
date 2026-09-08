# 32 — DCP: упрощение и переход на журнал новых сессий

<!-- markdownlint-configure-file {"MD013": false} -->

> **Статус:** P00–P09 реализованы в working-tree diff; deterministic P10 закрыт. Live provider canary и production rollout P11 не выполнялись и остаются DEFERRED.
> **Дата / версия документа:** 8 сентября 2026 года, v0.3.
> **Implementation baseline HEAD:** `46d3057` (`Add observe-only Context Gateway to pi-tools-suite`). DCP-изменения после него находятся в working tree, отдельный commit не создавался.
> **Назначение:** последовательные implementation/review задачи с трекингом решений, изменений, тестов и удаления старого кода.
> **Источник требований:** обсуждение с пользователем: упростить DCP, сохранить provider cache, отказаться от `decompress/recompress`, использовать `session-recovery` для деталей и убрать отдельный DCP sidecar. Последнее обязательное уточнение: старые сессии и любое legacy НЕ поддерживаются; миграции пользовательских данных нет.

## 1. Целевое решение и границы работы

**DCP управляет компактным рабочим контекстом; `session-recovery` читает исходную историю.** Принятые изменения проекции хранятся маленькими структурированными записями в самой сессии. Уже опубликованные summaries, ID и служебные вставки воспроизводятся без повторной генерации. Пользовательского переключения сжатых блоков туда и обратно больше нет.

```text
Pi session JSONL
  ├─ исходные сообщения: не переписываются DCP
  └─ custom entries DCP: принятые решения, не сообщения модели
            │
            ├─ текущая ветка + replay решений → стабильная проекция → provider
            ├─ session-recovery → точные страницы архива → НОВЫЙ tool result
            └─ UI → отображаемая копия без служебных блоков
```

Отмена компрессии и восстановление состояния после restart — разные функции. Удаляется первая; вторая остаётся для сессий нового формата как детерминированное применение сохранённых решений. Отказ от sidecar не означает отказ от persistence.

**Чистый разрыв совместимости:** новая реализация работает только с сессиями, созданными ею. Не читать, не конвертировать, не чинить и не продолжать старые сессии; не создавать importer, compatibility adapter, fallback, dual-write, режим выбора backend или переходное окно. Существующие данные оставить на диске нетронутыми. Дальше слово «переход» означает замену реализации, а не перенос пользовательских данных.

### 1.1. Что считается успехом

- Только новые сессии используют журнал; ни один рабочий путь не читает и не пишет отдельный DCP state-файл. JSONL нового формата с доступной исходной историей достаточен для восстановления проекции.
- Между явными изменениями истории DCP сохраняет уже отправленный префикс; после изменения новые продолжения снова стабильны. Restart новой сессии отдельно проверяется на равенство её проекции, без сравнений с импортированными данными.
- Детали сжатой истории можно адресно дочитать, включая конец длинной секции и длинного сообщения. Чтение не включает старый блок обратно в контекст.
- Уменьшаются количество независимых политик, runtime-полей, путей persistence и состояний отмены. Нет цели достигнуть произвольного числа строк ценой потери защит.
- Сохранность требований и качество продолжения проверяются отдельно от уменьшения количества токенов. Улучшение качества не считается доказанным самим рефакторингом.

### 1.2. Что этим документом не разрешено

Подготовка плана не разрешает менять production-код, конфиги пользователя, SDK pins, запускать платные модели, изменять личные сессии, удалять sidecars или перезапускать процессы. Реализация — отдельная задача. Конвертация старых данных исключена из этой реализации, а не отложена до отдельного разрешения или следующего этапа.

Не входят: физическое сокращение исходного JSONL, поддержка прежних сессий/config aliases/форматов DCP, массовая очистка старых файлов, новый artifact store/БД/daemon, реализация Context Gateway, переписывание provider SDK, смена summarizer-модели и универсальная система event sourcing. Не копировать upstream-код ради сходства архитектур.

Существующий [план Context Gateway](31-context-gateway-extension-plan.md) — независимая работа. DCP не должен становиться зависимым от Gateway. Сохранность внешних артефактов, на которые уже ссылается исходная история, не появляется автоматически из наличия JSONL.

## 2. Проверенная база и источники

Пути в таблице относятся к рабочему дереву на указанном HEAD; это локальные источники, а не описание будущей реализации. Символы важнее номеров строк. Установленные `node_modules` — свидетельство проверенной версии, их не редактировать.

| ID | Подтверждённое устройство / ограничение | Источник |
| --- | --- | --- |
| B01 | DCP загружает sidecar на `session_start`; старые custom `dcp-state` snapshots игнорируются. Есть отдельное наследование из предыдущей сессии. | `external/pi-tools-suite/src/dcp/index.ts`, обработчик `session_start` |
| B02 | Sidecar содержит не только отмену: блоки, стабильные aliases, pruning, anchors и другие поля. Есть envelope, `.prev`, `.fence`, recovery marker и блокировка. | `src/dcp/state.ts`, `state-persistence.ts` внутри suite; [as-is spec](../specs/03-dcp.md) |
| B03 | `decompress/recompress` меняют активность старых блоков; это не адресное чтение истории. | `external/pi-tools-suite/src/dcp/commands.ts`, `handleDecompress`, `handleRecompress` |
| B04 | `session-recovery` читает raw `getBranch()` / `getEntries()` и регистрирует четыре инструмента. | `external/pi-tools-suite/src/session-recovery/index.ts`, `entriesFor`, `sessionRecovery` |
| B05 | Чтение секции берёт только её начало: максимум 50 entries, тело до 8 000 символов, общий вывод до 30 000; offset/cursor отсутствует. Search тоже не имеет продолжения выдачи. | там же, константы, `session_read_section`, `session_search` |
| B06 | Общий renderer recovery способен сериализовать поля custom entry; `contentResult` обрезает уже сериализованный JSON как строку. | там же, `renderEntry`, `contentResult` |
| B07 | Обычный `custom` не становится сообщением модели; `custom_message` становится. | SDK `dist/core/session-manager.js`, `sessionEntryToContextMessages` |
| B08 | SDK `_appendEntry` обновляет память/leaf до `_persist`; первая запись может откладываться до появления assistant. В видимом пути append нет `fsync`. | SDK `dist/core/session-manager.js`, `_appendEntry`, `_persist` |
| B09 | Pix имеет собственный `LazySessionManager`: append тоже меняет память до записи; есть tail-view и отдельная гидратация. Нельзя считать частичный view полной веткой. | `src/app/session/lazy-session-manager.ts`, `appendEntry`, `hydrate`, `contextEntries` |
| B10 | Сейчас IDs распределены по user/tool-result carriers; assistant content не используется как носитель. Existing mappings сохраняются. | suite `src/dcp/pruner-message-ids.ts`; [cache spec](../specs/26-dcp-provider-cache-stability.md) |
| B11 | Новый user turn сейчас разрешает новые решения автоматического pruning; upgrade может изменить старый frozen nudge. Это слабее нового требования append-only. | suite `src/dcp/pruner.ts`, `automaticPruneCheckpoint`; `pruner-nudge.ts`, `upsertNudgeAnchor` |
| B12 | UI-фильтр отдельно обрабатывает `<dcp-message-ids>`; он не учитывает fenced examples. Provider cleanup — другая реализация. | `src/markdown-format.ts`, `stripDcpControlMetadata`; suite `src/dcp/pruner-metadata.ts` |
| B13 | Stats и несколько host-путей удаления зависят от DCP sidecar. | `src/app/rendering/dcp-stats.ts`; `src/app/commands/command-session-actions.ts`; `src/app/session/tabs-controller.ts`; `acp/src/acp/pix-acp-agent.ts` |
| B14 | Exact membership, защита signed assistant, очередь транзакций, stale-owner guards и provider evidence уже существуют. Название `recovery.ts` относится также к rehydration метаданных, а не только к отмене. | suite `src/dcp/conversation-index.ts`, `compression-preview.ts`, `state-transaction.ts`, `provider-tool-results.ts`, `recovery.ts` |
| B15 | Root pi-пакеты закреплены на `0.85.1`; проверены Node `24.16.0` и Bun `1.3.14`. Проверки root/suite/ACP/Desktop имеют разные команды. | соответствующие `package.json`; локальные executable/version probes |

При подготовке документа working tree содержал чужой untracked каталог `external/pi-tools-suite/test/context-gateway/`; при уточнении v0.2 также обнаружен `external/pi-tools-suite/docs/context-gateway-p00-adr.md`. Их не редактировать, не удалять и не включать в изменения DCP. Перед каждым этапом baseline/status проверяются заново: параллельная работа может продолжаться.

При финальной проверке также появился сторонний diff `tests/tabs-controller.test.ts`; он не относится к созданию плана и не изменялся этой работой. Каталог `plans/` целиком исключён правилом `.gitignore:20`: данный файл сохранён локально, но не добавлен в Git index. Встроенные trackers ниже доступны независимо от Git; для версионирования самого документа нужен отдельный явный выбор добавить файл принудительно или изменить ignore-правило. Этот план не меняет `.gitignore` и не включает чужой diff.

Предыдущие прогоны из обсуждения — исторические наблюдения: 237 focused DCP, 51 UI/content, отдельно 5 cache и 6 recovery tests. Они могли пересекаться, не суммируются и не являются текущим полным gate. При создании этого плана implementation-тесты заново не запускались; P00 обязан зафиксировать новый baseline.

## 3. Решения, которые не следует заново переизобретать

| ID | Решение | Практическое следствие |
| --- | --- | --- |
| D01 | Raw history не меняется DCP. | Recovery читает только реально сохранённое; не обещает вернуть bytes, ранее обрезанные upstream. |
| D02 | Нет `decompress/recompress` в целевом режиме. | Нет пользовательского `deactivatedByUser` и циклов отмены; supersession при новом rollup остаётся. |
| D03 | Один источник истины: журнал текущей ветки. | Нет dual-write JSONL + sidecar и нет постоянного shadow-state. |
| D04 | Сохраняются решения, не весь runtime-state. | Replay строит индексы/счётчики; неизменный `context`/retry не создаёт запись. |
| D05 | Компрессия и её публикация используют один общий безопасный путь. | Существующий exact membership не заменяется подбором по timestamp или regex. |
| D06 | Cache contract строже прежнего spec. | Новый user turn сам по себе не разрешает ретроактивный pruning; nudge upgrade только в новый хвост. |
| D07 | Retrieval — новый tool result. | Не возвращать старые записи на прежние места; не запускать mutation tools заново для восстановления. |
| D08 | Новый журнал и новая политика проверяются раздельно. | Сначала стабильный replay на новых synthetic сессиях, затем сравнение поведения; старый runtime нужен только как исходный benchmark до удаления. |
| D09 | Только новые сессии; legacy отсутствует целиком. | Нет импорта, старых readers/renderers, config aliases, command shims, backend switch и поддержки прежних сессий. Это принятое требование, не открытый ADR. |
| D10 | Safety сохраняется, а не переносится в новый сложный framework. | Не создавать собственные WAL, generation fences, GC и БД поверх session journal. |
| D11 | Модельные prompts и tool schemas статичны в обычном продолжении. | IDs/проценты/кандидаты не подставляются в system prompt или динамический enum инструмента. |
| D12 | Архив — страховка, не оправдание плохой summary. | Текущие требования, ограничения, решения и незавершённая работа остаются в рабочем контексте. |

Удаление отмены не означает запрет обычного fork сессии нового формата. Ветка, созданная до операции сжатия, по определению имеет другой журнал. Это отдельное пользовательское действие с другой проекцией, а не скрытый обход D02. Restart/resume/export/fork ниже всегда относятся только к новому формату; они не означают совместимость с дорефакторинговыми сессиями.

## 4. Инварианты приёмки

| ID | Обязательное свойство |
| --- | --- |
| I01 | Ни одна операция DCP не переписывает исходные сообщения JSONL, не удаляет исходные файлы и не расширяет доступ к данным. |
| I02 | Применяются только структурированные, валидные DCP entries активной ветки. Строка маркера или JSON в user/tool text не создаёт полномочий. |
| I03 | Одинаковая ветка, журнал и версия renderer дают одну проекцию; restart не перегенерирует summary, aliases или frozen control text. |
| I04 | Обычный новый шаг сохраняет прежний сериализованный provider input плюс требуемые response items как префикс. Изменения иных расширений учитываются отдельно. |
| I05 | Одна принятая rewrite-операция фиксирует все её согласованные изменения. Следующие минимум два продолжения append-only; нет каскада отложенных уборок. |
| I06 | Signed assistant objects, reasoning, tool calls, call IDs и порядок протокольных групп сохраняются. New range не режет незавершённую/параллельную группу. |
| I07 | Применение ограничено точными исходными members и их содержимым. Нет расширения диапазона, угадывания соседей или автоматического удаления orphan pairs для новых операций. |
| I08 | Ошибка prepare/append не публикует новое сжатие. Неопределённый результат записи блокирует дальнейшую мутацию до проверки; память SDK не считается доказательством записи. |
| I09 | Повтор operation ID с теми же данными идемпотентен; с другими данными — конфликт. Все части одного `compress` принимаются вместе либо ни одна. |
| I10 | Смена session/branch/model/config во время await инвалидирует неподтверждённый план; поздний результат не попадает в новую вкладку. |
| I11 | Recovery имеет точное адресное чтение и продолжение всех ограниченных выдач. Truncation, конец и отсутствие источника различимы. |
| I12 | Recovery не выдаёт DCP control payload, скрытые reasoning/signatures или произвольные файлы по переданному path. Исторический текст не становится новой инструкцией. |
| I13 | UI-cleanup меняет только display copy. Code fences, inline code, цитаты и обычный текст с похожими тегами не повреждаются. |
| I14 | Новые сессии создаются и продолжаются без DCP sidecar и legacy paths. Отсутствующий/повреждённый журнал уже инициализированной новой сессии не заменяется пустым состоянием или чтением старого sidecar. |
| I15 | Hard-capacity проверяется до запроса. Отсутствие безопасной компрессии — явное состояние, не бесконечный nudge, не скрытая потеря контекста. |
| I16 | Retention/ветвление/нативная compaction не приводят к повторной вставке старого сырого диапазона или к двойному summary. |
| I17 | Нет подтверждения улучшения по одному `tokensSaved`. Оцениваются выполнение задачи, retrieval/re-read, стоимость и cache diagnostics с указанной областью измерения. |

При конфликте приоритет: разрешения и сохранность доступных данных → protocol validity → правильность задачи → стабильность проекции → ограничение окна → экономия токенов. Cache hit не гарантируется; гарантия DCP ограничена отсутствием незапланированного изменения собственного provider-visible префикса.

## 5. Минимальный контракт журнала

### 5.1. Формат и объём

Рабочее имя custom type — `dcp-journal`; `schemaVersion: 1` фиксируется на P01. Это **обычный `custom`**, не `custom_message`, не текст tool result и не сериализованный `DcpState`. Названия ниже проектные; окончательная TypeScript-схема и fixtures принимаются вместе.

Одна запись содержит `operationId`, единственную поддерживаемую версию, ссылку на предыдущую принятую DCP-операцию текущей ветки и один из трёх ограниченных payload. У первой записи `init` predecessor отсутствует; остальные продолжают её цепочку:

| Тип | Содержимое | Когда записывается |
| --- | --- | --- |
| `init` | Минимальное объявление нового формата/renderer и идентичности исходной сессии, без снимка DCP state. | Один раз при создании новой сессии до её первого provider request; fork наследует init по своей ветке. Не добавлять init задним числом в уже существующую сессию. |
| `publish` | Только новые постоянные `mNNN`/`bN` assignments и новые frozen control carriers; при необходимости явная смена сохраняемой настройки режима. | Перед первым использованием новых данных в provider projection; повторный render/неизменный retry — без записи. |
| `rewrite` | Полный batch новых replacement operations, точные source/mutation members, готовые replacement bytes/shape/позиции, поглощённые блоки и изменения control carriers. | Один раз после всех проверок `compress` или того же bounded emergency path. |

Сохранять достаточно данных для точного воспроизведения replacement: текст, role/тип, стабильный ID, позиция, обязательные metadata и frozen protected fragments. Статистические оценки хранить только если они невычислимы и действительно нужны. Не дублировать raw outputs, полный provider payload или все tool records.

`sourceMembers` (что реально видел summarizer) и `mutationMembers` (какие raw entries разрешено заменить) не объединять, пока тестами не доказана эквивалентность. Для rollup они различаются. Hash/version служат проверке целостности, не аутентификации недоверенной сессии.

Ссылки — на стабильные entry identities и отдельные synthetic block IDs, не на смещения после фильтрации. Для нового инструмента оставить компактные `mNNN` без отдельного ID-редизайна: assignments дописываются delta-batch, уже выданные не перенумеровываются и не переиспользуются после rollup. High-watermark выводится из полного журнала новых assignments, не только активных блоков. Это не поддержка прежнего формата сессии.

`bN` неизменяем: новый summary создаёт новый блок, а не переписывает старый. Supersession выводится из принятых операций. Runtime может содержать derived active-set; пользовательских undo-флагов и повторной активации в целевой схеме нет.

Обычное накопление immutable журнала допустимо. Сначала измерить его размер и время replay. Не вводить snapshots каждые N запросов, rewrite JSONL, GC или дополнительный индекс на диске без измеренного основания.

### 5.2. Replay и жизненный цикл

1. Получить полную текущую ветку, а не только context после native compaction и не tail LazySessionManager. Построить transient indexes один раз; доказать полноту host adapter.
2. Проверить версии/схему/размеры/дубли/ссылки. Неизвестная версия, конфликт operation ID, пропуск predecessor или повреждение source — явный blocked state.
3. Применить операции ветки к её исходным сообщениям с учётом native compaction boundary. DCP-блоки до этой границы не должны воскресить raw или дублировать host summary.
4. Восстановить aliases и frozen carriers. Runtime indexes, counters и активные блоки вычисляются из журнала; render не обновляет его.
5. При обычном append продолжить инкрементально. При tree/fork/compaction/reload инвалидировать transient cache по реальному изменению ветки, не по времени.

Fork включает только события-предки выбранного leaf. Наследованные IDs не отвергать только потому, что у нового session file другой header ID. Origin binding для будущей записи и provenance существующих событий — разные проверки. Записи из соседней ветки не «подмешивать для восстановления».

При native compaction определить на P01 точное правило retirement: сохранять события в raw archive, но применять только replacements с источниками в текущей host projection. Пересечение boundary не чинить по timestamp; использовать поддерживаемый safe cut или явно отказать. Тест должен покрывать summary DCP, уже вошедшую в host summary.

### 5.3. Публикация: обязательный gate до отказа от sidecar

Проектный поток: `capture owner → prepare detached batch → preview/gain → revalidate → append whole operation → confirm outcome → install committed projection`. После commit сбой уведомления не превращает выполненную операцию в неуспех. При смене владельца подтверждённая операция остаётся в исходной сессии, но не копируется в память новой.

Проверить реальный `pi.appendEntry` и обоих session managers: время записи, что означает успешный return, deferred first flush, disk full/permission error, partial line, crash, ошибка после append, дальнейшие descendants ошибочной in-memory entry. В `_appendEntry` память меняется раньше диска [B08/B09]; простого `try/catch` и проверки `getBranch()` недостаточно.

Выбрать минимальное поддерживаемое host-решение, не второй persistence engine. Не писать напрямую в JSONL из DCP параллельно SessionManager. Если write outcome неизвестен — заморозить DCP и дальнейшую запись затронутой сессии до штатного reload/reconciliation, а не продолжать цепочку от phantom entry. Автоматически повторять mutation tool нельзя.

Отдельно доказать single-writer на session file во всех поддержанных hosts. In-process queue защищает только один процесс. Пока второй writer не исключён/не отклонён доказанно, native journal mode в таком host не включать. Не считать lock ACP session-map блокировкой самого JSONL.

Зафиксировать реальную границу durability: обычный restart, process kill и power loss — разные сценарии. Отсутствие `fsync` не позволяет обещать power-loss durability. Если минимального host-контракта недостаточно, P03 блокируется и оформляется отдельное маленькое host/API изменение; SDK не патчится в `node_modules`.

### 5.4. Что сохранять ради кэша

Сохранить bytes/shape опубликованных в новой сессии ID carriers, summary wrappers, их порядок/позицию и frozen reminders. Перезапуск с той же поддерживаемой версией не меняет уже опубликованные вставки. Не реализовывать набор прежних renderers: неизвестный format/renderer отклоняется. Разрешённая смена model/tools/prompt — отдельная диагностируемая граница, не скрытая часть reload.

Новые reminders только дописываются в ещё не отправленный безопасный хвост. Нельзя прикрепить новый nudge к старому user message или заменить его текст при повышении приоритета. Не удалять ранее отправленный reminder «по истечении срока» на обычном запросе; его retirement входит в явный rewrite batch. Отсутствие безопасного носителя — отложить reminder, не трогать assistant.

Новые решения dedup/error/age pruning собираются отдельно от применения старых. Новый user turn не запускает автоматическую перезапись. Пакетное применение допускается вместе с явной компрессией или отдельно явно выбранной пользователем rewrite-командой. Даже в batch нельзя маскировать невыгодную summary экономией от несвязанных pruning decisions.

## 6. Recovery и UI до удаления функции отмены

### 6.1. Адресное чтение архива

Расширить существующий `session_read_section`, а не обязательно добавлять пятый tool: поддержать взаимоисключающие `section_id` и `entry_id`, entry/body continuation и явные `next_cursor`, `has_more`, `truncated`, `source_available`. Зафиксировать schema, единицы offset и правила multipart/Unicode. Для section cursor нужны позиция entry и позиция внутри её тела; одна лишь пагинация entries не позволяет дочитать длинный result.

Адрес должен вести к конкретному текстовому part или аргументам tool call. Не возвращать hidden thinking/signatures через generic object serialization. Изображения/opaque attachments и upstream-truncated content маркировать как отдельные ограничения, не объявлять восстановленными по текстовому preview.

Cursor привязать к session/scope/entry/версии источника и, для search, query. Обычное добавление новых записей не должно обнулять уже начатое чтение immutable entry; уход на другую ветку не разрешает прочитать теперь недоступные записи. Не принимать произвольный файловый path. `scope=all` — явный выбор, с пометкой иной ветки, а не автоматическое расширение поиска.

Добавить продолжение `session_search` и overview, иначе поиск/навигация тоже могут навсегда скрыть середину длинной истории. Bounded responses строятся до сериализации: не разрезать JSON посередине и не терять continuation metadata из-за общего лимита.

Во всех overview/search/read/context путях отделить DCP control entries от архивных сообщений; скрывать только известные DCP типы, не все чужие custom entries. Данные записи не становятся system instructions. Сохранить действующие ограничения доступа и редактирования чувствительных данных на выдаче.

Summary сохраняет компактные source references, достаточные для адресного чтения (`entryId`/диапазон + scope), а не полный индекс истории. В prompts: конкретная ссылка/фраза → direct read/search; неизвестный участок → overview. Не требовать три подготовительных tool calls перед каждым известным `entryId`.

Перед снятием undo проверить доступность recovery в standalone suite, Pix TUI и ACP/Desktop. Если recovery отключён/недоступен, не скрывать это: либо явно поддержанный degraded profile, либо отказ включать новый режим до доступности reader. Нельзя обещать архивное чтение несуществующего raw source.

### 6.2. Очистка отображения

Вынести один небольшой pure display-filter с общим набором fixtures для TUI и Desktop/ACP paths; location выбрать по реальным package boundaries, не через копирование двух regex. Provider cleanup остаётся отдельным контрактом и не меняет assistant replay bytes.

Фильтр распознаёт только выбранную грамматику новых служебных вставок вне fenced/inline code и цитат. Не добавлять парсеры старых ID/reminder formats: прежние формы и похожий пользовательский текст являются обычным содержимым, а не legacy metadata. Только зарегистрированная грамматика и контекст позволяют скрытие. Текстовая утечка неоднозначна — при сомнении сохранить обычный текст, а не потерять ответ.

Streaming parser хранит ограниченный pending prefix только на display path. Проверить каждый split marker, CRLF, разные fences, незакрытый тег и лимит буфера; незавершённый/ложный кандидат после finalization не должен молча проглатывать весь хвост. Live stream и replay должны давать одинаковую финальную отображаемую копию.

Structured custom journal вообще не должен попадать в transcript как обычное сообщение. UI может показывать краткую activity-строку о принятом сжатии, но не raw payload. Copy/export отображаемого ответа проверяются отдельно; полный session export обязан сохранять journal для replay.

## 7. Граница нового формата: без миграции данных и legacy

### 7.1. Принятое решение

Поддерживаются исключительно сессии, созданные новой реализацией. Нет процедуры переноса данных, dry-run import, compatibility renderer, offline importer, резервного legacy backend или срока их последующего удаления. Все эти механизмы исключены, а не оставлены в TODO.

Создание `init` допустимо только на подтверждённой границе создания новой сессии. Обнаружить непустую сессию без init и «инициализировать как новую» нельзя. Для host, который не даёт различить создание и открытие, P03 требует минимального lifecycle-контракта; он не должен разбирать старые state formats. Новый session file проверяется обычным version discriminator, а не распознаванием десятка прежних форматов.

### 7.2. Матрица нового lifecycle

| Состояние | Поведение новой реализации |
| --- | --- |
| Создаётся новая persistent session | Записать init, затем новые delta/rewrite operations; не создавать DCP sidecar. Deferred first flush покрывается P03 до публикации первой проекции. |
| Повторно открывается валидная сессия нового формата | Replay журнала активной ветки; те же summaries/aliases/carriers без повторной генерации. |
| Fork новой сессии | Наследовать только события-предки и их init; header ID новой копии не делает её legacy. |
| Init отсутствует вне подтверждённого создания новой сессии, либо версия не поддерживается | Обычный отказ продолжать в новом DCP-режиме; предложить создать новую сессию. Не читать sidecar, не конвертировать записи, не продолжать молча без сжатия. |
| Новый journal повреждён, пропущен predecessor, raw source не совпал | Явный blocked state до небезопасного provider request; не считать журнал пустым. Проверка целостности нового формата — не legacy support. |
| Ephemeral session нового формата | In-memory init/journal с явно ограниченным lifetime; без обещания restart persistence. |

Старые файлы остаются нетронутыми и не обслуживаются DCP. Не сканировать диски для их обнаружения, не удалять по возрасту, не добавлять специальную DCP cleanup-команду. Существующие общие права/команды удаления выбранного файла сессии не дают разрешения удалять связанные старые данные массово.

### 7.3. Выпуск и отмена неудачного выпуска

Выпуск включается только для новых сессий после gates. При дефекте остановить создание/продолжение затронутых новых сессий; сохранить их для диагностики без изменения данных. Исправление выпуска не обязано уметь читать старые дорефакторинговые сессии.

Откат кода не является конвертацией форматов. Старый binary не использовать для записи новых journal-сессий; при откате начать отдельную новую сессию выбранной версии. Не проектировать reverse exporter, слияние истории или автоматический возврат state в sidecar. Доступные исходники новых сессий сохраняются, но межверсионная совместимость не обещается.

## 8. Этапы и трекинг реализации

Статусы: `TODO`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `DONE`, `DEFERRED`. `DONE` требует diff/commit, выполненных проверок, закрытых замечаний и записи evidence; один checkbox не доказывает корректность. При выполнении этапа менять статус здесь и добавлять запись в журнал §12.

| Этап | Результат | Зависимости | Статус | Изменение / evidence |
| --- | --- | --- | --- | --- |
| P00 | Baseline и regression fixtures | — | DONE | Baseline после Context Gateway зафиксирован; существующие DCP/recovery/UI gates были зелёными до переключения architecture |
| P01 | Контракт journal, identity, cache и ownership | P00 | DONE | `dcp-journal` v1, exact v2 operations, transient/durable split и cache invariants закреплены тестами/specs |
| P02 | Recovery pagination и safe UI filtering | P00, согласованный reader contract P01 | DONE | Direct `entry_id`, cursors/search/overview paging; TUI + Desktop display filtering с fence/quote/fail-open fixtures |
| P03 | Подтверждённый host append / single-writer gate | P01 | DONE | Host append + active-branch check; error-path durable JSONL reconciliation; post-append throw и non-durable phantom fault tests. Поддержанный contract — один live writer на session file; произвольные независимые внешние writers не поддерживаются |
| P04 | Pure replay и journal writer в изоляции | P01, P03 | DONE | `journal.ts`, validation/reducer/delta writer, idempotency/conflict/immutable-decision tests |
| P05 | Новый формат: admission, restart/fork и serializer parity | P04 | DONE | New-session-only init, restart/fork equality, no-sidecar lifecycle and provider-prefix tests |
| P06 | Интеграция runtime, branch/compaction/restart | P02–P05 | DONE | DCP runtime switched to journal; no `agent_end` snapshot persistence or sidecar restore/save |
| P07 | Удаление undo и упрощение policy | P06 | DONE | `decompress/recompress` removed; routine retroactive pruning removed; frozen reminders; bounded emergency + summary-first hard-pressure path |
| P08 | Host consumers, stats, lifecycle, перенос JSONL нового формата | P06, P07 | DONE | Stats/session deletion/export consumers no longer discover/delete DCP sidecars; full JSONL carries journal |
| P09 | Удаление obsolete code и синхронизация docs/config | P07, P08 | DONE | Sidecar modules/tests removed; removed policy config keys stripped; as-is/cache specs updated, old roadmap/evidence marked historical |
| P10 | End-to-end deterministic gates и benchmark | P09 | DONE | Deterministic gates + 100/1k/10k benchmark PASS; live provider canary перенесён в P11 и intentionally NOT_RUN |
| P11 | Выпуск только для новых сессий, без migration window | P10 | DEFERRED | Binary behavior is new-session-only, but live/production canary rollout requires separate authorization/evidence |

> **Tracking rule v0.3.** Таблица этапов, implementation register и evidence
> ниже являются авторитетным статусом выполненной работы. Исходные checkbox-листы
> P00–P11 сохранены как детальная execution/acceptance decomposition и не
> переписываются задним числом в `[x]`, если конкретный literal probe был заменён
> эквивалентной проверкой или сознательно находится вне supported contract
> (например, независимые внешние writers одного session JSONL и power-loss/fync).

Реализацию каждого этапа вести отдельной reviewable порцией. P02 можно подготовить параллельно P03/P04, но не включать новую реализацию до закрытия всех prerequisites. Все fixtures сначала синтетические, созданные новым writer. Нет параллельного runtime старой и новой архитектуры; исходный baseline сохраняется лишь как commit/evidence для сравнения.

### P00 — Новый baseline и тесты, которые нельзя потерять

**Правки:** только fixtures/harness/evidence; поведение DCP пока неизменно.

- [ ] Зафиксировать HEAD, dirty/untracked paths, версии runtimes и SDK, эффективный тестовый конфиг. Не читать личный конфиг/историю для benchmark без разрешения.
- [ ] Запустить существующие focused DCP/recovery/UI проверки и доступные полные gates. Для каждого результата записать команду, exit code, pass/fail/skip и scope.
- [ ] Перенести probes UI в regression fixtures: выбранный новый ID/reminder, fenced example, inline code, quote, partial streaming tag. Прежние формы проверяются только как обычный literal text, который нельзя уничтожать, а не как поддерживаемый metadata-протокол.
- [ ] Добавить synthetic recovery fixtures: 120 entries в одном user turn, текст больше 8 000 символов, искомая запись после 50-й, больше лимита search/overview, multipart/Unicode/CRLF, DCP custom payload.
- [ ] Снять фиксированные serializer snapshots исходной реализации на синтетических сценариях для baseline; далее новые snapshots строить новым writer. Не требовать переноса старого persisted state или побайтной совместимости двух форматов. Включить signed assistant и parallel tool group.
- [ ] Зафиксировать размер/LOC production DCP, число persistence paths, типов состояния и набор feature flags. Это baseline сложности, не норматив качества.

**Приёмка:** воспроизводимый baseline; найденные failures отделены от будущих регрессий. Красные characterization cases либо изолированы в audit harness, либо исправляются в той же review-порции; основная ветка не получает необъяснимый красный gate.

**Существующие источники тестов:** `external/pi-tools-suite/test/compress-pruner.test.ts`, `dcp-transaction-faults.test.ts`, `dcp-fork-reconciliation.test.ts`, `dcp-lifecycle-marathon.test.ts`, `session-recovery.test.ts`; `tests/markdown-format.test.ts`, `tests/message-content.test.ts`.

### P01 — Зафиксировать маленькие контракты до кода persistence

**Правки:** schema draft/fixtures, contract tests и записи решений в §13. Не менять production-format на этом этапе.

- [ ] Утвердить единственный `dcp-journal` v1 из §5: init только при создании новой сессии, обязательные поля, bounded sizes, hashing/canonicalization, idempotency, renderer version, допустимые replacement shapes. Нет import payload или старых decoders.
- [ ] Описать точное сопоставление host entry IDs и projected messages. Не опираться только на `role + timestamp`; неоднозначность должна отказывать, а не назначать чужой ID.
- [ ] Отделить durable projection data от transient caches, pressure counters и provider evidence. Unknown evidence после restart не признаётся seen; не выводить completion только из HTTP 2xx или более позднего assistant.
- [ ] Принять cache contract для каждого поддержанного serializer: сравнивать provider-visible items, system/tools и response-item continuation. Не исключать signatures/реальные metadata из сравнения под видом нормализации.
- [ ] Зафиксировать native compaction и fork semantics, работу с LazySessionManager и reader API §6. Определить поведение при отключённом recovery.
- [ ] Описать состояния `prepared`, `committed`, `rejected`, `commit-unknown` и минимальные действия host при каждом. Утвердить single-writer/durability gate P03.

**Приёмка:** таблицы payload/lifecycle/permissions и независимые fixtures согласованы; в списке решений нет незакрытого вопроса, влияющего на удаление raw или публикацию. Не создавать абстракции для нескольких будущих хранилищ.

### P02 — Recovery становится заменой раскрытию блоков; UI не портит текст

Разделить на две маленькие review-порции P02-R и P02-U, обе со статусом в evidence. Это подготовка новых инструментов/отображения; storage runtime ещё не переключается. Такая последовательность diff не создаёт поддерживаемый legacy режим в конечном продукте.

- [ ] **P02-R:** реализовать direct `entry_id`, entry/body cursors, continuation search/overview, bounded valid output и правильные `not-found`, `unavailable`, `end`, `truncated` состояния.
- [ ] Покрыть вычитывание всего доступного текста последовательными страницами без пропусков/дублирования. Проверить совпадение с независимым исходником, а не только с production renderer.
- [ ] Скрыть только control records нового DCP во всех recovery paths; сохранить видимость обычных custom messages. Не добавлять перечень исторических formats. Проверить отсутствие утечек через snippets, error messages и details.
- [ ] **P02-U:** общий display-filter/fixtures для фактических TUI и ACP/Desktop путей. Сохранить raw transcript и provider content неизменными.
- [ ] Проверить split в каждой позиции marker/fence, ограниченность streaming buffer и одинаковый финальный результат live/replay/copy. Не фильтровать текст в provider `message_end` ради UI.
- [ ] Обновить descriptions/prompt guidance для новых сессий без лишних tools или разрастания system prompt; зафиксировать выбранные схемы и не менять их динамически в обычном продолжении.

**Файлы:** `external/pi-tools-suite/src/session-recovery/index.ts`, `external/pi-tools-suite/src/tool-descriptions.ts`, `src/markdown-format.ts`, `src/app/rendering/message-content.ts`; actual ACP/Desktop transcript/rendering paths определить по callers. Новый shared helper допускается только для реального повторного использования.

**Приёмка:** поздний факт в длинной секции читается по найденному ID; длинное тело дочитывается до конца; control payload не выдаётся; literal examples не исчезают. В тесте retrieval добавляет только новый результат и не меняет прежний provider prefix.

### P03 — Доказать безопасный append через host

**Правки:** harness и при необходимости минимальная поддерживаемая host-boundary. Не заменять sidecar до завершения этого gate.

- [ ] Проверить SDK SessionManager и Pix LazySessionManager в persistent, first-flush, hydrated, ephemeral режимах. Проверить полный branch API отдельно от tail UI view.
- [ ] Fault injection: ошибка до записи, во время append, после записи, disk full, denied permission, partial trailing record, отмена/смена owner. Сопоставить disk и memory независимо.
- [ ] Доказать, что phantom in-memory event не становится активным и не получает обычных descendants после неуспешного append. Для unknown outcome проверить штатный stop/reload без второй записи той же операции.
- [ ] Доказать single-writer / rejection второго writer для TUI, ACP/Desktop, standalone suite. Зафиксировать, что поддерживается, а что блокируется, вместо предположения «обычно один процесс».
- [ ] Проверить app restart/process kill и задокументировать отдельно power-loss boundary. Схема журнала сама не добавляет `fsync`.
- [ ] Если нужен host/API fix, оформить отдельный diff и gate. Не менять pin SDK и не встраивать DCP-specific file lock/fence в новый журнал незаметно.

**Приёмка:** есть доказанный append-result contract для каждого включаемого host, включая отличие создания сессии от открытия. При невозможности обеспечить его P03 получает `BLOCKED`; reducer может разрабатываться на fixtures, новый runtime не включается. Это условие безопасности, не повод сохранять старый backend или строить новый storage engine.

### P04 — Pure replay и минимальный journal writer

**Предлагаемые новые файлы:** `external/pi-tools-suite/src/dcp/journal.ts` и `journal-persistence.ts`; окончательное разделение по размеру/ответственности, не обязательно строго два файла. **Предлагаемые тесты:** `dcp-journal.test.ts`, `dcp-journal-faults.test.ts` в suite `test/`.

- [ ] Реализовать typed validation/reducer только новой схемы без доступа к filesystem/provider/UI. Runtime indexes строятся из immutable operations; renderer не имеет побочных записей. Старые custom types не становятся исходным state.
- [ ] Реализовать один writer через подтверждённый host append; очередь/owner guards использовать общие с `compress`. Не вводить отдельную «вторую очередь» для каждого вида события.
- [ ] Alias/control publication — только новые deltas; повтор identical context или retry не увеличивает журнал. Большой control delta тоже bounded и не содержит полного raw map snapshot.
- [ ] Rewrite batch подготовлен целиком; проверены members, current projection, protocol safety и положительный full-projection gain. Новая summary не заменяется пересказом при replay.
- [ ] Обработать duplicate/conflict/unknown version, пропущенный predecessor, поздний результат и corrupt source. Не применять частично валидный batch.
- [ ] Построить инкрементальный in-memory index; init не содержит checkpoint/state snapshot. Никаких импортов или периодических durable snapshots.

**Приёмка:** reference reducer даёт те же selections/projection на generated cases; replay+restart не меняет aliases и replacement bytes; journal-only tests не создают `dcp-state/`. UI/tools runtime пока не переключены автоматически.

### P05 — Новый формат: admission, lifecycle и cache fixtures

**Предлагаемые тесты:** `external/pi-tools-suite/test/dcp-journal-lifecycle.test.ts` и `dcp-journal-cache.test.ts`. Все сессии создаются новым writer; конвертации sidecar и production importer не существует.

- [ ] Проверить создание persistent/ephemeral session и init; reopen не создаёт второй init. Сессия без нового discriminator вне создания отклоняется общей проверкой версии, без распознавания/чтения старых данных.
- [ ] Проверить запись publish/rewrite, restart и точное равенство собственной новой проекции до/после reload. Сохранить IDs, frozen carriers, source references и готовые summaries.
- [ ] Сравнить SDK serializer input при обычном append, после rewrite и на двух следующих продолжениях. Не выкидывать содержательные metadata/signatures из oracle ради равенства.
- [ ] Покрыть fork до/после rewrite, наследование init, возврат к leaf, одинаковые timestamps, native compaction и reader с полным raw branch вместо lazy tail.
- [ ] Проверить malformed/unknown-version/частично записанный journal и пропуск predecessor. Ни пустой state, ни `dcp-state` файл не становятся fallback; данные не изменяются.
- [ ] Проверить отсутствие DCP-specific чтения/записи sidecar через I/O spies и отсутствие обращений к модели при replay. История с маркерами в user/tool text не создаёт journal operations.

**Приёмка:** новые сессии проходят lifecycle и serializer-prefix контракт на реальном поддерживаемом host harness. Отказ от legacy доказан отсутствием путей обращения к нему, а не набором поддержанных старых fixtures. Stage не сравнивает/мигрирует личные сессии.

### P06 — Подключить журнал к DCP runtime и lifecycle

- [ ] Заменить `session_start`/`agent_end`/`session_shutdown` sidecar restore/save на единственный new-session init/replay и delta commits. Не сохранять весь `DcpState` на окончание каждого запуска; не оставлять backend selector.
- [ ] Перевести `compress`, разрешённые mutating команды и control publication на общий writer. Сохранить проверку stale owner/source/model/config и all-or-nothing нескольких ranges.
- [ ] Сохранить stable `mNNN`/`bN` и assistant-byte invariants внутри новых сессий. Уже опубликованные новые operations применяются без перерасчёта из текущей политики.
- [ ] Проверить fork до/после operation, возврат по дереву, branch switch во время await, resume другой новой сессии, native compaction с сохранёнными/удалёнными boundaries, копирование полного JSONL нового формата без преобразования.
- [ ] Исключить полное сканирование/хеширование raw branch на каждом render без причины; при неполном Lazy view явно получить необходимые данные, а не считать отсутствие отсутствием raw source.
- [ ] Формат один: новая версия init/journal. Не переключать существующие сессии между форматами, не автоматически инициализировать неподдерживаемую историю, не делать dual-write.

**Файлы:** suite `src/dcp/index.ts`, `compress-tool.ts`, `state.ts`, `state-transaction.ts`, `pruner-message-ids.ts`, `pruner-compression-blocks.ts`, `compression-preview.ts`; host session adapters при необходимости.

**Приёмка:** сессия, созданная новым writer, переживает restart/fork без sidecar и без пересоздания summaries. До P07 поведение policy проверяется на синтетическом baseline отдельно от storage/lifecycle, без сохранения совместимого legacy runtime.

### P07 — Убрать undo и сократить число политик

- [ ] Полностью удалить `decompress/recompress`, UI hints/completions и `deactivatedByUser` из runtime. Не оставлять command alias, заглушку переадресации или transitional handler; обычный unknown-command ответ не является compatibility слоем.
- [ ] Проверить recovery availability в каждом разрешённом профиле. Отказ от undo включается только после P02 и доступности raw archive.
- [ ] Сделать обычный режим: статичный `compress` + редкие frozen append-only reminders + единая policy выбора safe candidates. Основная модель предлагает summary.
- [ ] Новые dedup/error/age decisions больше не публикуются на каждом user turn. Уже принятые решения нового журнала продолжают применяться. Новые объединяются с явным rewrite checkpoint; `/dcp sweep`, если оставлен, явно маркируется rewrite-операцией.
- [ ] Удалить независимые эвристические mutation paths и дублирующие счётчики только после замены общим pipeline. Утвердить явный минимальный конфиг нового профиля: disabled default auto-compress не включать, выбранный для нового профиля summarizer не менять молча. Старые config flags/aliases не переносить.
- [ ] Оставить один bounded emergency route через те же prepare/commit проверки. Текущий запрос, active head, protected/unseen results защищены; completed provider evidence не заменяется догадкой. При отсутствии разрешённого safe route — явный handoff/stop до oversized request.
- [ ] Учесть output/tool reserve, same-user-turn длинный цикл, downgrade окна модели, zero/negative gain, ошибки/timeout summarizer, ignored abort и ограничение повторов. Не выдавать partial relief за достижение всего recovery target.
- [ ] Заморозить уже опубликованные в новом формате reminders. Удаление/обновление их возможно только в явном rewrite; новые urgency подсказки — в новый хвост.

**Приёмка:** no-op/new-user/new-tool continuation не меняет уже отправленный префикс; устранены undo cycles и независимая постоянная уборка. Есть однозначная матрица только оставленных новых настроек и разрешений, а не поддержка всех прежних комбинаций флагов. Изменение policy сравнивается с P06 new-session baseline на одном корпусе.

### P08 — Перевести потребителей и жизненный цикл вне модуля

- [ ] `dcp-stats.ts` получает branch-scoped stats из journal reducer или bounded read-model, без синхронного sidecar read на render. Lifetime и current-branch savings различаются и честно обозначены.
- [ ] Обновить TUI/ACP/Desktop descriptions, session deletion confirmations, command completion и activity presentation. Не показывать «sidecar removed» для journal-only сессии.
- [ ] Session deletion удаляет именно выбранный session. Полностью убрать DCP-specific sidecar discovery/cleanup из этих consumers; не затрагивать Gateway/subagent/другие sidecars. Старые DCP файлы на диске этой работой не удаляются.
- [ ] Полный export/fork/открытие перенесённой копии нового JSONL сохраняет DCP custom records без конвертации; human-readable transcript export их не показывает как обычные ответы. Export без служебных records не называется полной резервной копией сессии. Поддержка старого формата не добавляется.
- [ ] Проверить ветки, tab switch, live stream, replay и загрузку деталей tool result во всех фактических UI paths. Shared display contract не дублируется тремя regex.

**Файлы:** `src/app/rendering/dcp-stats.ts`, `src/app/commands/command-session-actions.ts`, `src/app/commands/command-registry.ts`, `src/app/session/tabs-controller.ts`, `src/app/session/lazy-session-manager.ts`, `acp/src/acp/pix-acp-agent.ts`, `desktop/src/App.svelte`; дополнительные callers определяются поиском по symbols.

**Приёмка:** stats/lifecycle/export новых сессий не требуют DCP sidecar; нет sidecar или tool-result fallback для реконструкции state/stats. Чужие state/artifact files не затронуты. Host integration tests подтверждают работу, а не только unit reducer.

### P09 — Удалить старый механизм, а не оставить второй навсегда

- [ ] По таблице §9 полностью удалить sidecar reader/writer, decoder/validators прежних схем, revision ownership, backups/fences/recovery markers/cleanup и их зависимости. Не выносить их в importer или optional legacy module.
- [ ] Удалить undo handlers/flags, periodic full snapshots, superseded nudge/policy branches и ненужные serialization paths. `recovery.ts` удалять только если его remaining callers заменены корректной реконструкцией raw metadata.
- [ ] Перенести safety tests на новые контракты. Удаляемый тест должен иметь replacement test либо запись «feature intentionally removed»; не выбрасывать whole reliability suites ради зелёного gate.
- [ ] Свести config/default template/JSON Schema/tool descriptions/README к одному новому контракту. Удалить прежние aliases и поля; обычная валидация неподдержанного конфига не преобразует его в новый. Не создавать migration warnings/compatibility loaders.
- [ ] Обновить as-is `specs/03-dcp.md`, cache spec и evidence docs; прежние roadmap/evidence сохранить как историю с пометкой superseded, не переписывать старые результаты как новые.
- [ ] Поиск production imports/символов `loadDcpState`, `saveDcpState`, `SerializedDcpState`, `deactivatedByUser` и DCP-specific `dcp-state`/`.fence`/`decompress`/`recompress` не должен находить исполняемые пути. Допустимы только историческая документация и отрицательные removal tests, но не production allowlist legacy.
- [ ] Удалить legacy materialization/restore paths, timestamp fallbacks старых блоков, старые marker parsers, tool-result state/stats fallback и ненужный repair orphan pairs. Сохранить точную проверку/отказ нового формата, не переименовывать compatibility код в «recovery».
- [ ] Сравнить complexity baseline P00 и текущую реализацию: persisted fields, policy paths, LOC/module count, journal bytes. Объяснить оставшуюся сложность защитами, не обещанием будущих возможностей.

**Приёмка:** один writer, один authoritative reducer, одна новая схема; никаких старых backends, readers, importers или compatibility tests как продуктового требования. Нельзя закрыть этап, просто отключив старый механизм флагом или перенеся его из hot path.

### P10 — Полный gate: корректность, продолжение, кэш и стоимость

- [ ] Выполнить матрицу §10 на чистом baseline результата и на ветке с известными сторонними изменениями отдельно, не смешивая причины failures.
- [ ] Прогнать marathon: длинный один user turn, минимум 1 000 tool groups, несколько compress/rollup, retrieval давно сжатого факта, restart и fork. Инварианты проверяет независимый reference oracle.
- [ ] Измерить 100/1 000/10 000 synthetic messages: replay time, per-request transform, allocations/peak memory, journal bytes, стоимость no-op. Никакой модели в deterministic performance gate.
- [ ] Сравнить зафиксированные результаты исходного baseline P00, new-session storage/replay P06 и simplified P07 на одном синтетическом корпусе. Не сохранять старый backend внутри нового binary ради benchmark. No-DCP добавлять там, где он помещается в окно; заведомый overflow не использовать как единственное доказательство выигрыша.
- [ ] По отдельному разрешению запустить live continuation/canary на synthetic или явно разрешённом corpus. Зафиксировать provider/model/config/SDK/corpus revisions, повторения, качество задачи, read/write/uncached tokens по доступным полям, latency и retrieval overhead.
- [ ] Проанализировать first differing provider item/длину сохранённого префикса вокруг каждого rewrite и обычных continuations. Payload equality — отдельный результат от фактического server-side cache hit.
- [ ] Представить failures/uncertainty; no-op prefix rewrites и safety violations недопустимы. Порог принятия по cost/quality согласовать до прогона, не подгонять по результатам.

**Приёмка:** deterministic gates закрыты, нет необъяснённых regressions; live gate не помечается passed, если его пропустили. Без разрешённого live gate production policy rollout остаётся `BLOCKED`/`DEFERRED`, даже если local tests зелёные.

### P11 — Выпуск только для новых сессий

- [ ] Начать с явно выбранных новых тестовых сессий, затем ограниченного разрешённого canary, также созданного новым writer. Ни старые сессии, ни их копии не конвертируются и не включаются в rollout.
- [ ] Для каждого включения зафиксировать binary/format version, owner, scope, restart/prefix outcome, способ остановить неудачный выпуск без изменения данных и причины intentional rewrites.
- [ ] Любое phantom commit, нарушение source membership, protocol или необъяснённая смена префикса останавливает включение. Raw history остаётся доступной для диагностики, не отправляется модели автоматически.
- [ ] Выпустить краткие инструкции: создать новую сессию; детали читать адресно через recovery; продолжение прежних сессий и перенос их DCP state не поддерживаются; откат кода не конвертирует данные.
- [ ] Подтвердить отсутствие временных compatibility flags/modules/aliases и отсутствие автоматической очистки старых данных. В этом плане нет следующего этапа удаления importer, потому что importer не создаётся.

**Приёмка:** нет скрытой зависимости от старых state files, rollout и остаточные ограничения записаны, удаление старого кода подтверждено review. Сам факт сохранения этого плана не закрывает ни один пункт P00–P11.

## 9. Карта удаления и сохранения

Пути в первых строках — относительно `external/pi-tools-suite/src/dcp/`. Даты/коммиты удаления заполняются после фактического diff.

| Компонент | Целевое действие | Условие / замена | Трек |
| --- | --- | --- | --- |
| `commands.ts`: decompress/recompress | Удалить handlers и пользовательские undo transitions | P02 reader + P07 | TODO |
| `state.ts`: undo flags, full serialized runtime | Удалить из новой model | Immutable ops + derived state | TODO |
| `state-persistence.ts` | Удалить целиком: reader/writer/decoder/cleanup/fences/backups | P03–P06: один новый journal, без importer | TODO |
| `persistence-ownership.ts` | Удалить sidecar revision ownership | Host session ownership доказано; stale operation guards остаются | TODO |
| `state-transaction.ts` | Упростить, не удалять safety | Общая queue, detached prepare, owner/source checks | TODO |
| `conversation-index.ts`, `compression-preview.ts` | Сохранить или объединить без изменения exact semantics | Independent reference tests | TODO |
| `compression-blocks.ts`, `pruner-compression-blocks.ts` | Удалить undo/legacy paths целиком; оставить exact materialization и rollup | Только новые exact operations, I06/I07/I16 | TODO |
| `pruner-message-ids.ts` | Сохранить stable addressing; durable assignment через journal delta | Prefix/restart tests | TODO |
| `pruner-nudge.ts` | Удалить retarget/upgrade старого carrier и render-time mutations | Frozen append-only publication | TODO |
| `auto-compress*.ts`, `progress-controller.ts`, `compression-progress.ts`, `pruner-emergency.ts` | Убрать дублирование; не оставлять независимые скрытые mutation paths | Единый bounded emergency pipeline P07 | TODO |
| `provider-tool-results.ts` | Сохранить необходимую completion correlation, сократить только реально ненужное | Нет false seen/unseen при restart/stream error | TODO |
| `recovery.ts` | Проверить оставшуюся rehydration; не путать с undo | Raw metadata reconstruction не теряет protections | TODO |
| `shadow-plan.ts`, debug tools | Сохранить лишь полезные read-only diagnostics/evals | Не второй authoritative state | TODO |
| Stats и session deletion consumers | Перевести на journal; удалить DCP sidecar cleanup и legacy/tool-result fallback | P08 | TODO |
| Config aliases / старые marker parsers / старые restore adapters | Удалить без shims и преобразования старых данных | Новый config/schema/UI contract, P02/P09 | TODO |
| Recovery и display filters | Доработать вместо DCP раскрытия блоков | P02 и cache tests | TODO |

План допускает объединение файлов, но не массовый rename в одном diff с изменением semantics. Не переносить прежний `SerializedDcpState` в новый journal под другим именем. Init — только объявление нового формата; operations — только новые принятые решения. Удаление legacy относится к DCP и его затронутым consumers, не разрешает несвязанный массовый рефакторинг SDK или других расширений.

## 10. Тестовая матрица и команды

### 10.1. Обязательные сценарии

| Test ID | Сценарий / oracle | Инварианты | Этап |
| --- | --- | --- | --- |
| T01 | Raw entries до/после DCP идентичны; journal не попадает в model/UI/recovery как control payload | I01/I02/I12/I13 | P02/P04/P08 |
| T02 | No-op replay, несколько identical retries, new user/tool append: old prefix неизменен, no-op journal не растёт | I03–I05 | P04/P06/P07 |
| T03 | IDs переживают pruning, restart, equal timestamps и byte-identical repeated messages без перенумерации | I03/I07 | P04/P06 |
| T04 | Signed reasoning/text/tool calls и parallel sibling results не изменены | I06 | P04/P06 |
| T05 | Rewrite + два обычных продолжения сохраняют новую проекцию и SDK serializer prefix | I04/I05 | P05–P07 |
| T06 | New nudge/urgency/candidate changes не редактируют старый carrier; system/tools остаются статичными | I04 | P07 |
| T07 | Создание/restart/fork/native compaction новой сессии дают независимую expected projection, без двойной summary/raw resurrection | I03/I14/I16 | P05/P06 |
| T08 | Late prepare, cancellation, source/model/config/branch change, duplicate operation и conflicting parameters | I07–I10 | P03/P04/P06 |
| T09 | Disk/memory fault boundaries, partial append, process kill, second writer, unknown outcome | I08–I10 | P03/P05 |
| T10 | Missing members, changed interior content, invalid/cyclic refs, unknown schema и corrupt journal | I02/I07/I14 | P04/P05 |
| T11 | Archive read по позднему entryId, полный body paging, search/overview continuation, Unicode/multipart | I11/I12 | P02 |
| T12 | Recovery даёт historical source refs; не запускает mutation, не меняет старую проекцию | I01/I04/I12 | P02/P07 |
| T13 | Все streaming split positions, fences/quotes/literal markers, финальный live/replay/copy parity | I13 | P02/P08 |
| T14 | Context pressure в одном длинном user turn, unseen results, model downgrade, zero gain, timeout | I06/I07/I15 | P07 |
| T15 | No-sidecar runtime, branch-scoped stats, deletion/export/reopen новой копии JSONL, TUI/ACP/Desktop parity | I03/I14/I16 | P08/P09 |
| T16 | Marathon, scaling, task continuation и cache/cost evidence | I01–I17 по scope | P10 |
| T17 | Init только при создании; нет legacy imports/decoders/shims; I/O spies подтверждают отсутствие обращений к DCP sidecar | I02/I14, D09 | P05/P09 |

Тесты для removal features не должны заставлять новую архитектуру сохранять старую отмену или читаемость прежних state formats. Тесты exact membership/cache/permissions переводятся на fixtures нового writer и не удаляются вместе с отменой. Для каждого удаляемого legacy теста нужен след «функция исключена по D09» либо новый safety oracle. Все новые filenames из P04/P05 — предлагаемые, сейчас их может не существовать.

### 10.2. Локальные команды для будущих этапов

Команды выполнять из root на доступных проверенных runtimes. Не подменять Node на Bun для root/ACP tests. Этот блок — план запусков, не лог уже выполненных проверок.

```bash
git status --short
git rev-parse HEAD
command -v node
command -v bun
node --version
bun --version

# Reader/UI: существующие файлы; новые fixtures включаются в эти suites.
bun test external/pi-tools-suite/test/session-recovery.test.ts
node --import tsx --test tests/markdown-format.test.ts tests/message-content.test.ts tests/dcp-stats.test.ts

# P00: только исторический baseline перед удалением sidecar-модуля.
bun test external/pi-tools-suite/test/compress-pruner.test.ts external/pi-tools-suite/test/dcp-state-persistence.test.ts external/pi-tools-suite/test/dcp-transaction-faults.test.ts external/pi-tools-suite/test/dcp-fork-reconciliation.test.ts

# После P04/P05: запускать после создания этих предлагаемых тестовых файлов.
bun test external/pi-tools-suite/test/dcp-journal.test.ts external/pi-tools-suite/test/dcp-journal-faults.test.ts external/pi-tools-suite/test/dcp-journal-lifecycle.test.ts external/pi-tools-suite/test/dcp-journal-cache.test.ts

# Полные локальные gates.
npm --prefix external/pi-tools-suite run typecheck
npm --prefix external/pi-tools-suite test
npm run check
npm run check:acp
npm run check:desktop
npm --prefix desktop test
npm run generate-schemas:check
git diff --check
git status --short
```

Root `check` может запускать schema generation; generated diff нужно проверить, а не автоматически считать частью задачи. Полный suite `check` дополнительно включает smoke с Pi CLI: запускать только после проверки доступности CLI и его offline/test profile. Недоступность runner фиксируется как `NOT_RUN`, а не обходится многократными повторениями.

Live script `npm --prefix external/pi-tools-suite run test:prompt-evals:dcp` включает `PROMPT_EVAL_E2E=1` и может обращаться к модели. Только отдельное разрешение, выбранный model/config/corpus и budget. Наличие script не доказывает, что он уже проверяет все continuation criteria P10; при необходимости дополнить oracle, не полагаться лишь на presence-of-keywords.

### 10.3. Evidence и метрики

Для каждого gate записывать: timestamp с timezone, HEAD и dirty paths, platform/runtime/SDK, command, exit code, passed/failed/skipped/not-run, fixture seed/revision, scope и ссылку на review/log. Raw provider/session content не сохранять в общий отчёт по умолчанию.

Cache измерять на provider input после сериализации, а не на внутреннем `messages` до других extensions. Отдельно фиксировать позиции первых различий, длину общего префикса, тип intentional rewrite, cache-read/cache-write/uncached counts только в терминах конкретного provider API. Не складывать поля с разной semantics в одну выдуманную «экономию».

Cost/quality сравнение включает compress generation, дополнительные recovery/search/read calls, повторную обработку context и завершённость задачи. Условие «меньше `tokensSaved`» не означает хуже; «больше `tokensSaved`» не означает дешевле или лучше. Provider TTL/routing и смена model/config учитываются как ограничения эксперимента, не как дефекты reducer.

## 11. Риски и условия остановки

| Risk ID | Риск | Мера / stop gate |
| --- | --- | --- |
| R01 | Session append оставляет phantom memory после I/O failure | P03 обязателен; unknown commit блокирует дальнейшую запись до reconciliation. |
| R02 | Два процесса пишут один JSONL | Доказанный single-writer/rejection на host boundary; иначе native mode не включать. |
| R03 | SDK пропускает malformed JSONL, в том числе часть journal | Validation + predecessor checks выявляют внутренние gaps; полное исчезновение неизвестного хвоста не гарантированно обнаружимо без host durability contract. Не обещать больше P03. |
| R04 | Tail-view/compaction теряет journal либо raw boundaries | Полный branch reader для replay/recovery; native compaction semantics и generated fork tests. |
| R05 | Existing session без init ошибочно принята за новую | Init только на подтверждённом create; reopen неизвестного формата отклоняется общей проверкой, без readers/migration/угадывания. |
| R06 | Новые summaries/aliases применены до подтверждённой записи | Journal commit/reload gate до публикации; sidecar не fallback и вообще не участвует. |
| R07 | Улучшение policy снова нарушает cache | Storage-only baseline P06 отдельно от P07, serializer prefix tests и live canary. |
| R08 | Recovery дорогой/неполный/недоступен | Cursor/read-by-ID, bounded pages, availability gate, измерение retrieval overhead. |
| R09 | UI regex удаляет пользовательский пример либо весь хвост | Узкая grammar, quote/fence preservation, bounded streaming buffer, fail-open для неоднозначного обычного текста. |
| R10 | Ради «простоты» удалены protections/evidence/gain проверки | I06–I10/I15 и замена safety tests обязательны; нет планового удаления по одному имени файла. |
| R11 | Старый binary используется для записи новой journal-сессии | Межверсионная совместимость не обещается; при откате кода начать отдельную новую сессию, не преобразовывать существующую. |
| R12 | Журнал превратился в прежние snapshots после каждого request | Delta-only writes, no-op growth test и complexity review на P09. |
| R13 | Потеря факта не обнаруживается самой моделью | Summary continuation contracts и независимые task oracles; retrieval не оправдывает потерю действующих требований. |
| R14 | Экспорт/другой plugin уже обрезал raw либо external artifact исчез | Явная доступность источника; DCP не обещает восстановление отсутствующих bytes и не повторяет команды. |

## 12. Журнал изменений и evidence tracker

### 12.1. Правила ведения

Каждая implementation-порция получает `CHG-NNN` и этап `Pxx`; для неё указываются затронутые контракты D/I, файлы, удаления, проверка кэша, tests и влияние на единственный новый формат. Сначала `IN_PROGRESS`, после diff — `IN_REVIEW`, после review и gates — `DONE`. `BLOCKED` содержит причину и конкретный недостающий gate. `DEFERRED` не выдаётся за completed. D09 нельзя незаметно ослабить добавлением «временного» legacy path.

Коммиты создаются только при разрешённом workflow. При отсутствии commit записывать `working-tree diff` и точный список файлов; не придумывать SHA. Чужие изменения не включать в запись. Изменения самого плана ведутся отдельно от implementation evidence.

### 12.2. Changelog документа

| Запись | Дата | Изменение | Проверка / scope |
| --- | --- | --- | --- |
| DOC-001 | 2026-09-07 | Создан план v0.1: journal, recovery/UI, cache, migration, stages и tracking | Чтение baseline `daa1b06`; проверены 12 заголовков этапов, локальные ссылки, code fences и whitespace diff; production не менялся, implementation tests при подготовке не запускались |
| DOC-002 | 2026-09-07 | v0.2: по прямому уточнению пользователя исключены старые сессии и любое legacy. Удалены план импорта, import payload, adapters/renderers, dual backend, command/config shims и migration window. P05 заменён проверками новых сессий; обновлены D09/I14, карта удаления, тесты, risks, ADR и release gate | DOC-CHECK-002: 10 структурных проверок PASS, 3 локальные ссылки существуют; только документ. Исторический DOC-001 не является действующим требованием, P00–P11 не выполнялись |
| DOC-003 | 2026-09-08 | v0.3: implementation/evidence tracking обновлён после journal-only рефакторинга. P00–P09 закрыты, P10 deterministic закрыт, live canary/P11 оставлены DEFERRED | Working-tree implementation на baseline `46d3057`; см. G03/G05/G10-D и findings FND-001…FND-004 |

### 12.3. Implementation register

| Change ID | Этап | Статус | Diff / commit и файлы | Проверки / evidence | Reviewer / замечания |
| --- | --- | --- | --- | --- | --- |
| CHG-001 | P00 | DONE | Baseline `46d3057`; characterization tests до refactor | G00 | Context Gateway оставлен отдельным baseline |
| CHG-002 | P01 | DONE | `src/dcp/journal.ts`, exact-state cleanup, cache specs | G03/G05 | Durable projection state отделён от provider evidence/runtime pressure |
| CHG-003R | P02-R | DONE | `src/session-recovery/index.ts`, tool descriptions, recovery tests | T01/T11/T12 | `entry_id`, bounded body/read/search/overview continuation; DCP control entries hidden |
| CHG-003U | P02-U | DONE | `src/markdown-format.ts`, `desktop/src/lib/markdown.ts` + tests | T01/T13 | Filter only display copy; fences/quotes preserved; incomplete marker fail-open |
| CHG-004 | P03 | DONE | `src/dcp/journal.ts`, `dcp-journal.test.ts` | G03 | Confirmed durable post-append error is reconciled; non-durable phantom leaf is rolled back. Supported host contract is single live writer/session |
| CHG-005 | P04 | DONE | New `journal.ts`, `dcp-journal.test.ts` | T01–T05/T08–T10 | Delta-only pure replay; immutable published decisions; no raw output/provider evidence snapshots |
| CHG-006 | P05 | DONE | `dcp-journal-lifecycle.test.ts`, provider-prefix regressions | G05/T17 | New-only admission, restart/fork equality, pre-journal rejection |
| CHG-007 | P06 | DONE | `dcp/index.ts`, `compress-tool.ts`, state/transaction/projection files | T02–T10 | Runtime no longer registers `agent_end` snapshot persistence and never loads sidecar |
| CHG-008 | P07 | DONE | Commands/pruner/nudge/auto-compress simplification + marathon tests | T02/T05/T06/T12/T14 | Undo removed; routine retroactive cleanup removed; summary-first hard pressure; partial positive recovery retained |
| CHG-009 | P08 | DONE | Stats/session/ACP/desktop consumers and tests | T01/T13/T15 | DCP-specific sidecar deletion/discovery removed; full JSONL preserves journal |
| CHG-010 | P09 | DONE | Sidecar modules/tests deleted; config/schema/docs/specs synchronized | D09/T17/§9 | Current DCP production search has no sidecar/undo/serialized-state runtime path; old roadmap/evidence explicitly historical |
| CHG-011 | P10 | DONE | Focused/full/root/ACP/Desktop/schema gates + deterministic benchmark | G10-D PASS | Local deterministic implementation is green; live quality/cache evidence относится к P11 и всё ещё отсутствует |
| CHG-012 | P11 | DEFERRED | No production/live rollout performed | G10-L / §14 | Requires separately authorized provider canary; no migration window will be introduced |

Это заранее выделенные идентификаторы работ, не запись об уже выполненных изменениях. При дроблении этапа добавлять подзаписи и фактические file/diff references, не помечать весь этап DONE по одному подшагу.

Шаблон записи для копирования:

```text
CHG-NNN / Pxx / status:
Дата, автор/owner, reviewer:
Baseline HEAD; сторонние dirty/untracked paths:
Цель и затронутые Dxx / Ixx / Txx:
Изменённые/добавленные/удалённые файлы:
Удалённая старая ответственность; что остаётся и почему:
Изменение provider projection / cache boundary:
Изменение только нового session format / отказ неподдержанной версии:
Подтверждение отсутствия legacy paths / переносов пользовательских данных:
Остановка/откат кода без преобразования сессий:
Команды → exit code; pass/fail/skip/not-run; evidence location:
Review findings → resolution:
Остаточные риски / следующий gate:
Commit SHA либо working-tree diff:
```

### 12.4. Реестр проверок

| Evidence ID | Gate | HEAD / среда | Команда / oracle | Результат | Артефакт / ограничения |
| --- | --- | --- | --- | --- | --- |
| BASE-READ-001 | Подготовка документа | `daa1b06`, Node 24.16.0, Bun 1.3.14 | Чтение исходников, SDK, scripts и git status | Baseline inspected | Только факты §2; не test gate |
| DOC-CHECK-002 | Уточнение плана v0.2 | `daa1b06`, 2026-09-07; сторонние paths в §2 | Python: этапы P00–P11, TODO, v0.2/init, отсутствие import payload/файлов, закрытые ADR, fences/whitespace; проверка links; git status/check-ignore/diff-check | 10 PASS; 12 уникальных этапов TODO; 86 незакрытых задач; 3 ссылки существуют; команды exit 0 | Только проверка документа, не production tests. `plans/` ignored; git diff-check не включает этот документ, его whitespace проверен отдельно. Production edits этой работой не выполнялись |
| G00 | P00 baseline tests | `46d3057`, Node 24.16.0, Bun 1.3.14 | Initial focused DCP/recovery/UI baseline before persistence switch | PASS | Focused DCP 157/157; recovery 6/6; host UI/stats 56/56 before journal edits |
| G03 | P03 append/owner | working tree on `46d3057` | `bun test test/dcp-journal.test.ts test/dcp-journal-lifecycle.test.ts test/dcp-transaction-faults.test.ts` | PASS — 14/14 | Covers durable post-append notification failure, non-durable phantom rollback, stale source/owner/command publication. Independent processes intentionally sharing one session JSONL are outside supported host contract |
| G05 | P05 new-session lifecycle/cache | same | Journal lifecycle + focused provider-prefix/Responses regressions | PASS | Restart/fork projection equality, no-sidecar JSONL, pre-journal rejection; cache prefix cases included in focused DCP gate |
| G10-D | P10 deterministic | same; macOS arm64; SDK 0.85.1 | Focused DCP; full suite; root/ACP/Desktop/typecheck/schema; benchmark | PASS | Final focused DCP/recovery 189/189; full suite 745 pass / 62 opt-in skip / 0 fail; root 1012/1012; ACP 154/154 + stdio; Desktop 154/154 (markdown 25/25); schema direct check unchanged. Benchmark p50: 0.922ms/100, 7.717ms/1k, 76.614ms/10k messages |
| G10-L | P10 live continuation/cache | — | Разрешённый corpus/provider | NOT_RUN | Не запускался: требуется отдельное разрешение, provider/model/budget/corpus. Local prefix equality не выдаётся за server-side cache hit |
| ENV-001 | Wrapper limitations | sandbox | `npm run check`; `npm run check:inner`; `npm run generate-schemas:check` | WRAPPER_BLOCKED | `mise` trust/GPG и `tsx` CLI IPC запрещены sandbox. Эквивалентные Node 24.16.0 команды (`sync-sdk-pin`, `tsc`, `node --import tsx --test`, `node --import tsx scripts/generate-schemas.ts --check`) PASS |

### 12.5. Review findings

| Finding ID | Этап / severity | Наблюдение | Исправление / evidence | Статус |
| --- | --- | --- | --- | --- |
| FND-001 | P07 / high | Long one-user-turn marathon после первого policy simplification сделал 157 emergency body-prune и 0 summaries — риск качества несмотря на освобождение окна | Hard pressure с opt-in autoCompress теперь предпочитает exact summary; positive partial recovery разрешён с сохранением остаточного debt. Marathon после исправления: 26 summary blocks, 0 body-prune, проверяемые retired facts сохранены | CLOSED |
| FND-002 | P10 / test infra | Full suite browser-QA cleanup зависел от `ps`; sandbox запрещает `/bin/ps`, detached child переживал timeout | POSIX cleanup использует recursive `pgrep -P` deepest-first с `ps` fallback. `browser-qa-runner.test.ts` 32/32 | CLOSED |
| FND-003 | P10 / test infra | `todo-persistence-e2e` единственный model-backed test запускался локально по умолчанию и падал без API key | Приведён к explicit opt-in `TODO_PERSISTENCE_E2E=1` (CI имеет отдельный opt-in). Deterministic full suite больше не зависит от credentials | CLOSED |
| FND-004 | P03 / high | SDK `appendEntry` может бросить после durable `appendCustomEntry`, потому что затем синхронно вызывает listeners через `_emit`; простой catch мог ошибочно объявить committed op неуспешным | Error path делает bounded read-only JSONL-tail reconciliation: durable op + active branch считается committed; недолговечный phantom откатывает leaf; durable/memory disagreement требует reload | CLOSED |
| FND-005 | P09 / complexity | До рефакторинга `src/dcp/*.ts` содержал 12 035 строк / 30 модулей; после journal-only cleanup — 10 373 строки / 29 модулей | Чистое снижение 1 662 строк (~13.8%) несмотря на новый journal/recovery/cache safety code. Удалены 904-строчный `state-persistence.ts`, ownership module и большие legacy serialization/undo paths; оставшаяся сложность в основном exact membership, provider cache/evidence и bounded compression safety | CLOSED |
| FND-006 | P10 / test isolation | Context Gateway native recovery/contracts проходили отдельно (48/48), но падали в полном Bun suite из-за широких `mock.module` SDK/TUI mocks из соседних `model-tools`/`ast-grep`/`lsp` тестов | `model-tools` получил локальную dependency injection вместо глобального SDK mock/cache; лишние global mocks в соседних tests удалены. После этого full suite стабильно 745 pass / 62 opt-in skip / 0 fail | CLOSED |

## 13. Решения, которые нужно закрыть на этапах, а не угадывать

| ADR ID | Вопрос | Предпочтительный вариант | Gate / статус |
| --- | --- | --- | --- |
| A01 | Гарантии append и single-writer во всех hosts | Использовать host SessionManager append; подтвердить durable outcome только на error path, не строить второй store. Один live writer на session file является supported host contract; произвольная запись в один JSONL из независимых процессов не поддерживается | P01/P03, CLOSED — CHG-004/FND-004 |
| A02 | Identity projected messages и native compaction retirement | Stable branch/session entry identity + ordered exact membership и полный branch reader; timestamp не является разрешением угадывать чужой member | P01/P05, CLOSED — CHG-002/006 |
| A03 | Где display-filter без package cycle | Pure display-only filter на фактических TUI и Desktop markdown boundaries с одинаковой узкой grammar/fixtures; не переносить фильтрацию в provider/session pipeline ради искусственного package sharing | P02-U, CLOSED — CHG-003U |
| A04 | Cursor/offset/multipart semantics reader | Расширен существующий recovery reader: `entry_id` + opaque continuation cursors + bounded section/search/overview pages | P01/P02-R, CLOSED — CHG-003R |
| A05 | Поддержка старых сессий / миграция данных | Исключена целиком по прямому требованию пользователя; не создавать importer или compatibility path | D09, CLOSED — принято 2026-09-07, DOC-002 |
| A06 | Какой минимальный emergency path остаётся | Exact safe summary rewrite имеет приоритет при явно включённом autoCompress; positive partial progress сохраняется. Bounded provider-seen body-prune остаётся safety floor; protected/live minimum → явный abort/handoff | P07, CLOSED — CHG-008/FND-001 |
| A07 | Переходный период / второй backend | Отсутствует с первого выпуска новой реализации; создание новых сессий вместо конвертации старых | D03/D09, CLOSED — принято 2026-09-07, DOC-002 |

Каждое implementation-закрытие ADR добавляет выбранный вариант, обоснование, затронутые tests и ссылку на `CHG-NNN`. A05/A07 уже закрыты требованием пользователя и DOC-002, не требуют исследования legacy. Изменение решения D01–D12 требует отдельной записи; оно не прячется внутри «рефакторинга».

## 14. Финальный checklist выпуска

- [ ] P00–P11 закрыты по фактическим evidence либо явно исключённый scope согласован; blocked safety gate не обходится.
- [ ] Raw история сохранена, любые заявленные source refs читаются; неизвестная доступность помечена честно.
- [ ] Нет runtime `decompress/recompress`, пользовательских undo-флагов и скрытого раскрытия блоков.
- [ ] Journal — единственный источник решений только новых сессий; no-op не пишет snapshot, runtime не зависит от sidecar.
- [ ] Нет поддержки прежних сессий/форматов, importer/exporter преобразования, command/config shims, legacy readers и второго backend. Существующие пользовательские данные не изменялись и не удалялись.
- [ ] Обычные продолжения сохраняют сериализованный префикс; intentional rewrites отделены от случайных изменений UI/IDs/nudges.
- [ ] Signed assistant и протокольные группы не повреждены; async stale owner и unknown commit обработаны безопасно.
- [ ] Recovery paging/direct read и UI streaming/fenced cases проверены end-to-end во включаемых hosts.
- [ ] Stats/config/schema/docs/export/deletion соответствуют новой архитектуре; Gateway/чужие sidecars не затронуты.
- [ ] Итоговый diff действительно удаляет старые ответственности целиком; нет «временно оставшегося» legacy-кода, выключенного флагом или вынесенного в модуль импорта.
- [ ] Live quality/cache limitations и метрики опубликованы с разрешённым scope; skipped проверки не названы пройденными.

**Первый implementation-шаг:** P00 — воспроизводимый baseline и regression fixtures. Ни удаление `state-persistence.ts`, ни перенос всего `SerializedDcpState` в session entry не являются первым шагом.
