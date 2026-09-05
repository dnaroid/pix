# DCP: план доведения до надёжного автономного управления контекстом

<!-- markdownlint-configure-file {"MD013": false} -->

**Тип:** design / implementation roadmap, не as-is спецификация.\
**Статус:** план подготовлен; реализация этапов ниже не выполнена в рамках этого документа.\
**Дата:** 2026-09-05.\
**Репозиторий:** `/Volumes/128GBSSD/Projects/pi-ui-extend` (pix).\
**Базовая ревизия:** `6bd426c` — `Break timestamp ties with stable message order`.\
**Область:** `external/pi-tools-suite/src/dcp/**`, DCP-тесты сьюта, необходимые схемы и документация.\
**Связанные документы:** [as-is DCP](./03-dcp.md), [provider-cache stability](./26-dcp-provider-cache-stability.md).

## 1. Цель и определение готовности

Довести DCP до состояния, в котором ему можно доверить многочасовой автономный run: он своевременно освобождает рабочий контекст, не удаляет незапланированные сообщения, сохраняет необходимые для продолжения сведения, переживает ошибки и перезапуски и не разрушает provider cache на каждом запросе.

«Идеальность» в этом плане — проверяемые инженерные свойства, а не обещание абсолютно безошибочного пересказа произвольного текста. Lossy summary не может одновременно гарантировать сохранение любого потенциально важного факта и произвольное уменьшение объёма. Поэтому структурные гарантии проверяются детерминированно; смысловая сохранность — отдельными continuation-evals; невозможность безопасно уменьшить контекст становится явным состоянием, а не бесконечным нуджем или скрытым удалением.

Основной контракт:

> DCP изменяет только заранее определённые элементы проекции. Для каждого изменения известны исходный контент, способ его представления после изменения и причина допустимости. После принятия summary фактическое множество удаляемых сообщений не расширяется.

Три результата допустимы: **полезное безопасное преобразование**, **обоснованный отказ без изменения состояния**, **явное ограниченное аварийное завершение/передача управления**, когда защищённый минимум не помещается. «Ноль компакций» само по себе не ошибка при низком давлении; ошибка — отсутствие прогресса при наличии безопасного и полезного плана.

## 2. Границы работы и правила выполнения

1. Источник истины — `external/pi-tools-suite/`. Не редактировать live mirror вручную. `local-gpt-agent`, его задачу, код и реальные сессии не менять и не запускать для проверки.
2. Сохранить существующие `compress.ranges[]`, `compress.messages[]`, `mNNN`, `bN` и `/dcp` как внешний интерфейс. Улучшения результатов и диагностики делать обратно совместимыми; изменение семантики сохранённых блоков версионировать.
3. Основная реализация остаётся в `src/dcp/**`; тесты — в фактическом каталоге `external/pi-tools-suite/test/`, а не в несуществующем для текущего набора `src/dcp/__tests__/`.
4. Изменения централизованного `src/tool-descriptions.ts`, общего config generator, package scripts или host runtime вне указанной области требуют отдельного расширения scope. Не обходить правило дублированием tool metadata внутри DCP. При обнаружении блокирующего SDK ограничения оформить отдельную зависимость, а не править SDK незаметно.
5. Сохранить точные одинаковые пины трёх `@earendil-works/*`. На baseline это `0.85.1`; план не предполагает обновления SDK или установки библиотек. Не добавлять БД, сервис или агентный framework ради этого рефакторинга.
6. Все проверки headless. Никаких TUI сценариев, изменения личного конфига, отправки реальной истории сторонним моделям или рестарта пользовательского процесса без отдельного разрешения.
7. После каждой порции кода — focused tests, полный suite gate и host `npm run check`. После model-facing prompt changes — также live prompt-evals; skipped live tests не считать пройденной проверкой смысла.
8. Проверять доступность runtime до запуска команд. Node и Bun не взаимозаменять молча. В текущем shell напрямую обнаружен Bun; команды Node/npm ниже предполагают восстановленный repo-supported toolchain.
9. Данный документ — только план. Его сохранение не включает реализацию, deployment, коммит или новые paid-model вызовы.

## 3. Отправная точка и реестр проблем

Обозначения: **C** — подтверждено чтением baseline кода; **R** — дополнительно воспроизведено изолированным probe в предшествующем аудите; **V** — риск, для которого нужен отдельный тест. R-примеры пока не являются постоянными регресс-тестами: этап E00 должен перенести их в репозиторий.

Пути в таблице относительно `external/pi-tools-suite/src/dcp/`. Номера строк относятся к baseline и после изменений могут сдвигаться; ориентироваться также на имена функций.

| ID | Приоритет / статус | Проблема и исходная точка |
| --- | --- | --- |
| F01 | P0 / C,R | Message-mode для одного результата параллельной tool-группы удаляет соседний результат при последующем расширении диапазона. `compress-tool.ts:324–364`; `pruner-compression-blocks.ts:201–278`. |
| F02 | P0 / C,R | Несколько ranges неатомарны: первый создаёт блок, второй падает на overlap, но первый остаётся активным. `compress-tool.ts:193–281`. |
| F03 | P0 / C,R | Блок допускается даже при увеличении контекста: probe принял ~6 исходных токенов → ~1000 токенов summary. `compression-blocks.ts:615–670`. |
| F04 | P1 / C,R | Programmatic digest не сохраняет решения и следующие шаги, если они не попали в отдельно защищаемый контент. `auto-compress.ts:99–120`. |
| F05 | P0 / C,R | При одном user-turn и `messageMode.keepRecentTurns=2` свежий result предлагается как «старше двух turns». Начальный cutoff остаётся концом истории. `pruner-candidates.ts:284–335`. |
| F06 | P0 / C,R | Persistence dedup общий для модуля, не пути: одинаковое состояние A/B может сохранить только A. Проявление через реальные вкладки отдельно не доказано. `state-persistence.ts:12–13,171–193`. |
| F07 | P1 / C,V | Запись sidecar непосредственно в целевой JSON; snapshot содержит ссылки на изменяемые arrays/blocks; возможны crash/read races и несоответствие hash записанным bytes. `state-persistence.ts:175–186`; `state.ts:632–657`. |
| F08 | P1 / C | `after_provider_response` означает получение HTTP response до чтения stream, а не успешное завершение assistant response. В SDK 0.85.1 hook не содержит request ID. SDK `types.d.ts:519–537`; DCP `index.ts:798–849`. |
| F09 | P1 / C,V | Emergency range использует наличие более позднего assistant как structural witness, output-pruning — `providerSeenToolIds`. Разные критерии принятия контента требуют единой модели доказательств. `pruner-candidates.ts:174–271`; `pruner-emergency.ts:157–173`. |
| F10 | P1 / C | Transcript summarizer теряет tool arguments; комментарий о cap не подкреплён ограничением всего transcript; auth выполняется до локального timeout. `auto-compress.ts:60–79,173–228`. |
| F11 | P1 / C | Cleanup удаляет и sidecar существующей не текущей сессии, когда mtime старше семи дней. Это политика, опасная для отложенного resume, а не гарантированная потеря raw transcript. `state-persistence.ts:123–165`. |
| F12 | P1 / C,V | Dedup определяется input fingerprint, не равенством результатов: одинаковая команда может иметь разные значимые outputs. `pruner-tools.ts:141–168`. |
| F13 | P1 / C,V | `currentTurn` считается по всем `role=user`, хотя повторная проекция может содержать synthetic summaries; статистика lifetime calls сериализуется как размер сохраняемой runtime map. `pruner.ts:70–98`; `state.ts:639`. |
| F14 | P1 / C,V | Protected artifacts читаются синхронно и относительно `process.cwd()`; лимит применяется после чтения. Restore может не иметь части ToolRecord, хотя raw history ещё доступна. `compression-blocks.ts:351–421`; `state.ts:599–638`. |
| F15 | P1 / V | Нет доказанного end-to-end контракта повторных компрессий с сохранением критических фактов, positive gain и восстановлением append-only payload после rewrite. Нужен длинный replay, а не только helper tests. |

**Уже исправлено и должно остаться исправленным:** отсутствие emergency range в одном длинном user-turn; ложный overlap смежных same-timestamp `m170/m171`; приоритет exact stable ID при материализации; попадание same-timestamp live head в summarizer input. Не переписывать эти исправления обратно ради упрощения.

**Исторический test baseline из предыдущей проверки:** DCP focused — 137 pass / 0 fail / 761 assertions в 9 файлах. Более ранний полный gate: suite — 478 pass / 58 skip; host — 998 pass. Это не результаты нового прогона при сохранении плана и не критерий качества будущей реализации; E00 обязан зафиксировать актуальные числа заново.

**Поправка к as-is документации:** DCP преобразует контекстные копии, а не обязательно уничтожает raw session history. `/dcp decompress` уже существует. Утверждения «после restart всё потеряно», «partial overlap никогда не мутирует состояние», «origin call исчез — блок деактивируется» нельзя переносить из старой спеки без проверки. Метаданные могут быть восстановлены из raw history; это требуется проверить, а не заранее объявлять невозможным.

## 4. Инварианты целевой реализации

| ID | Проверяемый контракт |
| --- | --- |
| I01 | **Raw history immutable:** DCP не изменяет исходные session messages, nested content, tool arguments, signatures и attachments. |
| I02 | **Exact mutation set:** изменённые/удалённые элементы совпадают с `plan.mutations`; «попутного» удаления при apply нет. |
| I03 | **Source coverage:** весь заменяемый контент входит в manifest summary source либо в детерминированно сохраняемый protected/duplicate representation. Это структурная, не смысловая гарантия. |
| I04 | **Protocol integrity:** все оставшиеся tool-call/result группы валидны; подписанное assistant-содержимое либо оставлено целиком без изменения, либо удалено целой согласованной группой. |
| I05 | **Protected continuity:** текущий user request и in-flight head не заменяются автоматически; явно защищённые данные не исчезают и не усекаются молча. |
| I06 | **Atomicity:** ошибка до commit не меняет blocks, IDs, accounting, decisions и durable state; batch не оставляет незаявленный частичный результат. |
| I07 | **Isolation:** результат старого session/branch/model/config epoch не применяется к новому. Request evidence и persistence очереди разделены по владельцу. |
| I08 | **Positive gain:** автоматическая успешная компрессия уменьшает полную проекцию по одному estimator, включая protected content и служебные carriers. |
| I09 | **Bounded progress:** при устойчивом давлении и наличии допустимого полезного плана действие происходит после ограниченного числа подтверждённых возможностей; иначе выдаётся конечная причина блокировки. |
| I10 | **Cache stability:** после одного намеренного rewrite следующая обычная continuation не переписывает неизменную DCP-часть provider input. Фактический cache hit провайдера не гарантируется. |
| I11 | **Determinism/idempotence:** одинаковые history/state/config дают одинаковую проекцию; повторное применение не создаёт новые IDs, blocks, savings и новые opportunities. |
| I12 | **Durability/recovery:** подтверждённый persistent commit читается целиком после restart; recovery не смешивает поколения и сессии. |
| I13 | **Truthful outcomes:** `committed`, `noop`, `blocked`, `cancelled`, `failed`, degraded summary и неизвестное качество различимы в результате и диагностике. |
| I14 | **Bounded resources:** ограничены input/output/deadline summarizer, replay work, cache/state growth и diagnostic payloads; отмена не приводит к позднему commit. |
| I15 | **Trust/provenance:** summary сохраняет происхождение сведений; tool output не превращается в новую пользовательскую инструкцию, raw данные не попадают в телеметрию по умолчанию. |

Приоритет конфликтов: **целостность/права пользователя → protocol validity → явно защищённая информация → ограниченный прогресс → экономия → cache hit**. Cache нельзя сохранять ценой бесконечного no-op, а экономию — ценой незаявленного удаления. Если все требования одновременно невыполнимы, нужен явный blocked outcome.

## 5. Целевая архитектура: один план вместо независимых эвристик

### 5.1. Разделение ответственности

```text
raw history + DCP state + session epoch + effective config
  -> immutable ConversationIndex
  -> pure eligibility / CompressionPlan
  -> summary preparation from EXACT plan source
  -> pure projected result + semantic/structural/budget checks
  -> serialized commit with epoch/revision validation
  -> durable state + published projection + compact diagnostic result
```

`index.ts` становится адаптером событий и оркестратором, а не местом, где вперемешку определяются eligibility, side effects и политика безопасности. Не создавать десятки абстракций заранее: выделять модули по мере появления второго потребителя или отдельного проверяемого контракта.

### 5.2. Минимальные внутренние сущности

**ConversationIndex:** последовательность raw entries текущей ветки, stable identity, отдельный порядок в ветке, source hash/revision, user-turn identity, tool-group membership, origin (`raw`, `block`, `dcp-control`), actual published IDs и сведения о доступности контента. Порядок `mNNN` — идентичность/история выделения, не универсальный порядок ветки после fork/import. Timestamps — вспомогательные данные, не основной способ выбора современных boundaries.

**CompressionPlan:** session identity/epoch, branch revision, effective config/model key, source projection hash, операции, фактические source IDs, protected fragments, included blocks, evidence kind, gain estimate, причина и recovery references. Для каждой операции хранить разные поля `requestedSelection` и `effectiveSelection`. Plan ничего не пишет и не резервирует следующий `bN` в live state.

**ProjectionResult:** новая проекция и diff изменяемых IDs, ошибки валидатора, размер до/после, ожидаемая область cache rewrite. Материализация не пересчитывает eligibility и не расширяет boundaries.

**CommitResult:** discriminated union состояний `committed | noop | blocked | cancelled | failed`. Новые block IDs и accounting выдаются только для commit. Для проверки отказа хранить reason code, безопасные alternatives и ограничения retry.

**ProviderEvidence:** локальный attempt/transaction sequence, owner session/epoch, transport status, source hashes/IDs, подтверждение завершения response и capabilities адаптера. Не смешивать `published_to_model`, `sent_in_payload`, `http_accepted` и `response_completed` в один boolean.

### 5.3. Важные решения до реализации

**Message-mode.** Для `toolResult` использовать замену тела на том же result/carrier с тем же call ID: не удалять assistant и соседние results. Этот вид блока должен иметь явную семантику, а не интерпретироваться legacy range splice. Для подписанного assistant или структурно неподдерживаемого сообщения — отказ с безопасным full-group range. На первом защитном этапе допустим такой отказ вместо body-replacement; недопустимо молча расширить выборку.

**Range-mode.** Замкнуть диапазон по целым tool-группам до summarization. Auto path пересказывает полный замкнутый сегмент. Если модель уже передала summary для узкого диапазона, а closure требует соседних сообщений, вернуть `requires_closed_range` с точными start/end: нельзя предполагать, что имеющийся summary их покрывает. Сохраняемые verbatim соседи возможны только как явный, просчитанный план, не скрытый fallback.

**Границы.** Современный stable ID имеет приоритет над timestamp; отсутствие ID не разрешает выбрать другое сообщение с таким timestamp. Legacy fallback допустим только при однозначном соответствии и с diagnostic provenance. Ошибка называет actual block boundaries, первый действительно свободный ID и первый protocol-safe start — это не всегда один ID.

**Protected data.** Выделить fragment ledger с source ID/hash, origin, правилом защиты и текстом. «Protected» означает сохранение обязательного контента, а не надежду на prompt. Не оборачивать недоверенный output как новую инструкцию высокого приоритета. Явные инструкции пользователя и процитированные tool сведения различаются.

**Batch.** Все ranges валидируются до первого commit. Невалидные message entries могут по-прежнему soft-skip с отчётом; оставшийся допустимый набор применяется единым атомарным commit. Любой fatal error отменяет весь ещё не принятый набор.

**Migration.** Новые block semantics получают version/type; чтение legacy blocks остаётся отдельным совместимым путём. Не делать одинаковые `mode: message` с разным поведением без версии. Rollback бинарника не равен безопасному rollback sidecar: это отдельная процедура E10.

## 6. Этапы реализации

Все чекбоксы означают будущую работу. Для каждого этапа обязательны связанные инварианты и его собственные негативные тесты, а не только общий зелёный suite.

### E00 — зафиксировать baseline и воспроизведения

**Приоритет:** P0. **Зависимости:** нет. **Результат:** воспроизводимый реестр дефектов, fixtures и контрольная точка перед рефакторингом.

- [ ] Зафиксировать git HEAD/status, runtime версии, SDK pins, полный test baseline; не затереть существующие пользовательские изменения.
- [ ] Перенести R-примеры F01–F06 в именованные регресс-тесты. Вначале подтвердить падения на baseline; не менять ожидаемые результаты, чтобы легализовать дефект.
- [ ] Создать fixture factory для одного user-turn, N последовательных/параллельных tool-групп, controlled timestamps, signed assistant blocks, unique critical facts и управляемых provider events.
- [ ] Сделать memory-only persistence и инъецируемый clock/fake summarizer. Файловые тесты используют временный каталог, а не личные sidecars.
- [ ] Зафиксировать сценарий инцидента: 1 user request около 11 KB + 100 пар; context pressure задаётся относительно effective model threshold. Не считать 55% универсальным emergency: порог может быть модельным.
- [ ] Отдельно перечислить неизвестные F07–F15 и назначить каждому тест/этап; не выдавать предположение за production reproduction.

**Приёмка:** каждому F01–F06 соответствует минимальный красный regression на старом коде; существующий baseline воспроизводится. Красные тесты не публикуются в основной ветке без исправления или изолированного audit runner.

### E01 — немедленные защитные исправления

**Приоритет:** P0. **Зависимости:** E00. **Файлы:** `compress-tool.ts`, `compression-blocks.ts`, `pruner-candidates.ts`, focused tests.

- [ ] Убрать silent expansion в новых message operations: безопасно отказать для tool-группы до готовности exact body replacement из E02.
- [ ] Проверять все ranges против текущих active blocks и друг друга до мутации; временно это может быть preflight поверх существующих helpers.
- [ ] Исправить `keepRecentTurns` message-mode: недостаток user-turn’ов не делает всю историю stale. Разделить routine gating и explicit emergency gating.
- [ ] Ввести защиту от неположительной экономии хотя бы для auto path; окончательный gain рассчитывается на проекции в E05, а не только по summary string.
- [ ] Ошибки возвращают корректные свободные/protocol-safe IDs из реального snapshot; неизвестные IDs не угадываются и не clamp’ятся по суффиксу.
- [ ] Закрепить отсутствие изменений state при этих отказах, включая `nextBlockId`, `active`, counters и sidecar.

**Приёмка:** F01–F03,F05 больше не приводят к тихой потере/частичному commit; инцидентный intra-turn fallback и same-timestamp регрессии не возвращаются. Это защитный milestone, не завершённая новая архитектура.

### E02 — canonical index, точный план и materialization

**Приоритет:** P0. **Зависимости:** E01. **Файлы:** `pruner-message-ids.ts`, `pruner-candidates.ts`, `pruner-compression-blocks.ts`, `pruner.ts`, `state.ts`; новые небольшие `conversation-index.ts` / `compression-plan.ts` при необходимости.

- [ ] Строить единый immutable index текущей raw ветки; отдельно хранить visibility/projection mapping, а не восстанавливать порядок из timestamps и числовых IDs.
- [ ] Получать actual raw IDs до model-call; не считать строки `<dcp-system-reminder>` в пользовательском тексте доказательством synthetic origin.
- [ ] Реализовать pure closure по tool-группам, включающим несколько results и passthrough messages; не пересекать незавершённую группу.
- [ ] Реализовать tool-result body replacement для message-mode; сохранить роль, call ID, порядок и неизменные sibling bodies. Signed assistant не редактировать.
- [ ] Для новых range blocks применять ровно заранее записанные границы и membership; убрать скрытый backward/forward expansion из нового apply path.
- [ ] Превратить orphan repair в invariant check для новых планов. Уже повреждённую историю обрабатывать отдельной диагностической процедурой, не маскировать ошибку нового planner дополнительным удалением.
- [ ] Проверить совместное применение разных блоков: adjacent, nested rollup, message-body внутри range, sparse IDs, same timestamps, timestamp drift, missing boundary и branch fork.
- [ ] Все projected user summaries помечать как synthetic вне model text. `currentTurn` и age считать только по real-user boundaries canonical index.

**Приёмка:** I01–I05,I11 проходят property tests; changed IDs совпадают с plan; выбранный result A не меняет result B; неизвестная современная boundary не подменяется timestamp совпадением.

### E03 — атомарный commit и session-safe persistence

**Приоритет:** P0. **Зависимости:** E00; полный commit pipeline зависит от E02. Изоляцию persistence F06 можно исправлять отдельным небольшим изменением раньше.

**Файлы:** `state-persistence.ts`, `state.ts`, `compress-tool.ts`, `auto-compress.ts`, `index.ts`; при необходимости `compression-transaction.ts`.

- [ ] Разделить prepare и commit: summarizer и projection dry-run работают на immutable snapshot, не на live state.
- [ ] Ключ persistence coordinator — полный target path + session identity; никаких общих `lastPersistedStateHash` для A/B. Hash обновляется как persisted только после успешной записи.
- [ ] Сериализовать immutable bytes перед постановкой write в очередь. Не захватывать живые `compressionBlocks`/`nudgeAnchors` для отложенного JSON.stringify.
- [ ] Внутри короткой commit-секции перепроверять owner epoch, branch/config/model revision и source hash. При изменении — `stale_plan`, без применения старого summary к другой истории.
- [ ] Атомарно сохранять временный файл в том же каталоге, затем rename. Установить приватные permissions. Для заявленной crash-durability определить и проверить fsync файла/каталога на поддерживаемых платформах; не приравнивать rename к гарантии пережить power loss.
- [ ] Для persistent sessions публиковать memory state/projection после durable publication. Для `--no-session` явно использовать memory-only commit с теми же structural invariants.
- [ ] Зафиксировать point of no return: отмена до durable publication даёт zero mutation; после неё операция считается committed и не маскируется обычным failed. При неизвестном результате IO — reread/verify generation перед retry.
- [ ] Использовать idempotency key операции (session + tool call/operation key + source hash). Retry после потери ответа не создаёт второй блок и второй savings increment.
- [ ] Запретить late writes устаревшего владельца при session replacement. Координировать смену epoch с commit; snapshots target/session получать до awaits, не обращаться потом к переиспользованному ctx без проверки.
- [ ] Проверить несколько процессов, открывших один sidecar: in-process queue недостаточна. Либо доказанный single-writer lifecycle, либо межпроцессное исключение/конфликт ревизии; last-writer-wins молча недопустим.
- [ ] Ошибка сохранения не должна оставлять в runtime «успешный» блок, которого нет на диске. Ошибка предыдущей записи не должна отравлять очередь следующей.

**Приёмка:** F02,F06,F07 закрыты; fault injection на каждой IO/await границе сохраняет старое или полное новое поколение, но не смесь; concurrent A/B saves и late summarizer безопасны.

### E04 — единая модель provider evidence и eligibility

**Приоритет:** P1, обязательный для автономного режима. **Зависимости:** E02,E03. **Файлы:** `provider-tool-results.ts`, `pruner-emergency.ts`, `pruner-candidates.ts`, `index.ts`, `state.ts`.

- [ ] Сверить порядок hook callbacks с установленным SDK и реальными adapters. Декларация `after_provider_response` прямо говорит «before the response stream is consumed»; 2xx не использовать как completed-response witness.
- [ ] Привязать evidence к конкретной попытке, session epoch, model/provider и content revision. Retry payload, HTTP acceptance, stream completion и abort отражать раздельно.
- [ ] Использовать доступный завершённый assistant/turn event только после проверки его точной SDK семантики, stop reason и наличия всех matching results. Не добавлять выдуманный request ID в SDK types.
- [ ] Для hooks без request identity определить локальную корреляцию и single-flight ограничения. Смешивание summarizer requests с главным provider request обязательно покрыть тестом. Неоднозначность приводит к `evidence_unknown`, а не к массовому `seen=true`.
- [ ] Structural witness из марафонного фикса оставить явно помеченным fallback для поддержанного последовательного event trace. Не считать любой импортированный/failed assistant доказательством того, что весь предыдущий контент дошёл до провайдера.
- [ ] Сохранить current user request, newest assistant group и K последних полных tool-пар; parallel group не делится для достижения точного K. `K=0` всё равно сохраняет in-flight head.
- [ ] В routine и emergency path использовать общий predicate безопасности и разные политики возраста, а не разные понятия принадлежности/защиты.
- [ ] После restart прежнее evidence принимать только для той же source revision и поддерживаемого контракта; отсутствие записи в усечённом ToolRecord cache не является ни доказательством fresh, ни доказательством seen.

**Приёмка:** 2xx + stream error/abort не даёт false eligibility; retries/late events не смешиваются; завершённый run с одним user-turn даёт положительный `eligibleRangePairs`, когда обычный `eligibleOutputPairs` ещё нулевой. Метрики этих разных множеств не подменяют друг друга.

### E05 — контроллер прогресса, бюджет и безопасная деградация

**Приоритет:** P1. **Зависимости:** E02–E04; использует summary policy E06. **Файлы:** `index.ts`, `auto-compress.ts`, `config.ts`, `pruner-metadata.ts`, candidate modules.

- [ ] Выделить pure decision state machine: `normal -> pressure -> awaiting_opportunity -> preparing -> committed/cooldown` либо `blocked/degraded`.
- [ ] `patience` считать по завершённым main-provider opportunities, где было доступно напоминание, а не по числу повторных `context` callbacks. Один retry не даёт новой «проигнорированной» возможности.
- [ ] Задать ливнес-контракт: при auto-enabled, устойчивом effective pressure, завершённой безопасной истории и доступном полезном summary commit происходит не позже следующего допустимого context pass после исчерпания patience. Наличие второго user-turn не требуется.
- [ ] Вместо «всё старое до головы» выбирать минимальный достаточно большой protocol-safe oldest segment для восстановления бюджета. Ограничить повторную компрессию одного блока без новой полезной истории.
- [ ] Оценивать полную проекцию после операции: summary, verbatim fragments, вложенные blocks, ID carriers и reminders. Новый auto block допускается только при положительном gain с margin больше погрешности estimator.
- [ ] Разделить policy threshold и жёсткую вместимость модели. `summaryBuffer` не может поднять рабочий предел выше capacity с output/tool reserve. Не подавлять hard emergency только из-за model override.
- [ ] Учитывать новые tool outputs после последнего provider usage: stale low usage не должно скрывать уже выросшую projected history. Отмечать origin/accuracy оценки, не выдавать её за billed tokens.
- [ ] Ввести hysteresis/cooldown по реальному восстановлению бюджета и новым source bytes, а не wall-clock косметике. Zero-gain не сбрасывает emergency как успех.
- [ ] Дать единую truth table для `enabled`, `manualMode`, `automaticStrategies`, `autoCompress.enabled`, `autoCandidates.enabled`, `emergencyCurrentTurnPruning.enabled`. Advisory toggle не должен случайно выключать разрешённый safety path; выключенный destructive path не должен случайно включаться другим флагом.
- [ ] Декуплировать разрешение summarization от разрешения output deletion с явной migration policy: старый explicit opt-out не расширять молча.
- [ ] При недостатке безопасного материала выдавать конкретное `blocked_reason`: live-head-only, protected-budget-exceeded, evidence-unknown, summarizer-unavailable, non-positive-gain, missing-source, budget-exhausted.
- [ ] Если protected минимум уже не помещается, не удалять его ради процента и не слать тот же oversized request бесконечно. Сохранить recovery state и использовать поддержанный SDK headless abort/handoff путь, проверив его поведение тестом. Не подменять это автоматическим destructive native compact без отдельной политики.

**Приёмка:** 1 user + 100/1000 групп → неоднократное восстановление бюджета без user boundary; repeated transforms не расходуют patience; auto-disabled не создаёт auto summaries; каждый цикл заканчивается полезным действием или конечной наблюдаемой причиной.

### E06 — continuation-focused summaries и полноценный fallback

**Приоритет:** P1. **Зависимости:** E02,E03; budget checks согласованы с E05. **Файлы:** `auto-compress.ts`, `compression-blocks.ts`, `prompts.ts`, tests/prompt-evals.

- [ ] Строить transcript строго из source manifest плана. Добавлять tool name, call ID, необходимые args/paths, outcome, exit code и связанность result с call. Не включать credentials/headers или служебные signatures как «полезные args».
- [ ] Разделять наблюдаемые факты, пользовательские ограничения, принятые решения, непроверенные гипотезы, сделанные изменения, результаты проверок и pending next steps. Не маркировать все непустые ответы как качественный summary.
- [ ] Вести bounded continuity ledger: обязательные пользовательские требования и явно извлечённые checkpoints с provenance. Автоматическое извлечение не объявлять исчерпывающим распознаванием всех важных фактов.
- [ ] Protected fragments переносить детерминированно, дедуплицируя по origin/hash; проверять их наличие после нескольких rollups. Protected payload, не помещающийся в бюджет, блокирует план, а не усекается молча.
- [ ] Ограничить весь summarizer input, output, суммарные вызовы и общий deadline операции, включая auth resolution и fallback models. Таймаут отдельной модели не равен общему timeout цепочки.
- [ ] При большом source применять bounded chunking по замкнутым группам с проверкой покрытия каждого source ID и финальным merge; не резать конец transcript, где находятся последние ошибки/решения.
- [ ] Внутренний summary result хранит mode, source hash, preservation checks и reasons. Новые режимы отличают model summary, extractive fallback и отказ; старую телеметрию мигрировать совместимо.
- [ ] Заменить digest «были tool calls N раз» на bounded extractive fallback: exact user constraints, релевантные последние visible assistant checkpoints, paths/outcomes, нерешённые ошибки и source references. Frequency digest оставить только дополнением.
- [ ] Fallback порядок: проверенный model summary → проверенный extractive representation → разрешённое удаление доказанного redundant/noise content → явный отказ. Не интерпретировать ошибку summarizer как разрешение забыть весь сегмент.
- [ ] Если extractive fallback не помещается без потери обязательного минимума, не commit’ить. Восстановление raw источника — дополнительная страховка, не замена сохранению активных ограничений.
- [ ] Проверить вложенные bN: повторный rollup не должен экспоненциально накапливать старые verbatim summaries. Сохранность protected fragments и shrinking budget проверять вместе.
- [ ] После изменения prompt запустить suite prompt-evals и production canary с явно выбранной разрешённой моделью. Настроенный у пользователя summarizer не менять в рамках реализации.

**Приёмка:** F04,F10 закрыты на deterministic fixtures; model outage не уничтожает known checkpoints; arguments-only сведения присутствуют в summary source; live continuation-evals E09 проходят до изменения production policy.

### E07 — restart, recovery, retention и приватность

**Приоритет:** P1. **Зависимости:** E02,E03,E06. **Файлы:** `state.ts`, `state-persistence.ts`, `commands.ts`, `compression-blocks.ts`.

- [ ] Добавить versioned sidecar envelope с session identity, generation/revision, schema version и проверяемым payload. Проверять типы, границы размеров, block graph и циклы при load.
- [ ] Читать legacy state через migration adapter; неоднозначные legacy boundaries явно помечать. Не менять тихо проекцию уже существующего блока только потому, что изменился алгоритм.
- [ ] При corrupted JSON сохранять диагностическую копию/ошибку и пытаться загрузить последнее валидное поколение; не писать пустой state поверх повреждённого как будто сессия новая.
- [ ] Rehydrate нужные metadata/protected source из raw branch при resume. Отсутствие `outputText` в компактном sidecar не равно отсутствию исходного tool result.
- [ ] Recovery использует raw session/branch references прежде всего; дополнительные artifacts — только если исходник действительно не восстанавливается стандартным путём. Не дублировать всю историю в sidecar без необходимости.
- [ ] `/dcp decompress` и recompress должны корректно работать для range, body replacement и rollup, не возвращать pruned siblings/descendants неожиданно и честно сообщать unavailable source. Автоматический повтор mutating tool для восстановления запрещён.
- [ ] Cleanup не удаляет state существующей сессии только по семидневному возрасту; orphan cleanup требует успешного полного scan и проверки ownership. Ошибка чтения session headers не доказывает orphan.
- [ ] Retention покрывает recovery references и активные lease: удаление artifacts не нарушает обещанную восстановимость блока. Явно определить поведение после host native compaction или пользовательского удаления raw history.
- [ ] Artifact reads сделать async и ограниченными до загрузки всего файла. Разрешать только проверенные source references, учитывать realpath/symlink, session cwd вместо глобального process.cwd(), тип файла и общий бюджет.
- [ ] State/recovery файлы приватные; debug/eval reports не содержат raw user/tool text по умолчанию. Данные реальных сессий не отправлять моделям без отдельного согласия.

**Приёмка:** restart/fork/decompress roundtrip сохраняет проекцию и protected ledger; paused session старше 7 дней не теряет DCP state; corrupt/partial writes не превращаются в незаметное обнуление; path/symlink fixtures не читают посторонние файлы.

### E08 — политика pruning, cache stability и наблюдаемость

**Приоритет:** P1 для корректности, P2 для оптимизации. **Зависимости:** E02–E07. **Файлы:** `pruner-tools.ts`, `pruner-nudge.ts`, `debug-log.ts`, `index.ts`, `commands.ts`.

- [ ] Разделить доказанные duplicates и предположительно superseded outputs. Одинаковый input fingerprint не означает одинаковые данные после изменения файла, окружения или предыдущего failed run.
- [ ] Для дешёвого exact dedup использовать output identity/hash с semantic metadata (error/success и source scope); для supersession нужна явная политика read-like tool, а не общая эвристика для всех tools.
- [ ] Защиту tool names нормализовать через фактические aliases/metadata, не ограничиваться случайным регистром `write/edit`; неизвестные mutating tools не считать заведомо безопасными для удаления.
- [ ] Все новые pruning decisions включать в общий plan/checkpoint budget. Повторный apply уже принятых решений не создаёт новый rewrite.
- [ ] Сохранить distributed IDs, frozen nudge carriers и assistant-byte stability. В baseline «37 reapplied entries» — не обязательно 37 разных новых prompt messages; различать эти случаи.
- [ ] Эскалация нуджа — изменение decision state, а не косметическая перефразировка старого carrier. Новую guidance публиковать один раз в разрешённой точке с правильными current IDs; одинаковые напоминания агрегировать в telemetry.
- [ ] После commit очищение нуджа, блок и checkpoint применять как одну projection revision, чтобы следующий context не выполнял второй скрытый rewrite.
- [ ] Добавить компактные события plan/preflight/commit/blocked/degraded, duration, evidence kind, revision, before/after tokens и counts. Не сериализовать весь source transcript ради каждого debug event.
- [ ] Показывать отдельно `eligibleRangePairs`, `eligibleOutputPairs`, fresh/in-flight/protected/unknown counts, попытки summaries и реальные commits. Не отчитываться об исправлении eligiblePairs одного алгоритма числом из другого.
- [ ] Отдельно считать per-operation net saved, текущую оценку экономии проекции и lifetime статистику; не выдавать tokensSaved за денежную экономию или provider cache hit. Исправить lifetime count при цикле serialize/restore/serialize.
- [ ] Для unchanged state не выполнять тяжёлые stringify, обходы и filesystem reads только ради выключенного debug. Метрики bounded и session-private.

**Приёмка:** F12,F13 закрыты; после rewrite два следующих provider payloads проходят prefix/equality проверки; одна причина давления не создаёт бесконечную цепочку prompt edits или telemetry growth.

### E09 — доказательная проверка и производительность

**Приоритет:** P1; строится постепенно начиная с E00, а не откладывается до конца. **Зависимости для финального gate:** E01–E08.

- [ ] Разделить тесты на pure planner, projection, commit/persistence, real SDK event harness, provider serialization и live meaning evaluation.
- [ ] Добавить seeded generative tests без обязательной новой зависимости: случайные branches, timestamp collisions, parallel groups, partial outputs, retries, aborts, config changes и block operations. Сохранять seed и минимальный counterexample.
- [ ] Строить expected mutation set и simple reference projection независимо от production planner. Тест «planner согласен с самим собой» не доказывает correctness.
- [ ] Replay: один user-turn, 100 и 1000 групп, не менее 10 успешных последовательных compressions, затем restart/fork; после каждого шага проверять critical facts, I01–I15 и bounded progress.
- [ ] Fault injection: каждый await/IO boundary; auth hang, ignored abort, missing model, stream error after 2xx, late response, corrupt sidecar, disk full, permission error, concurrent writer.
- [ ] Проверить фактическое преобразование installed SDK, а не только JSON-мок. Для неподдержанного provider mode — явный unsupported/degraded режим, а не ложная общая гарантия.
- [ ] Создать corpus continuation tasks с hidden ground truth: состояния файлов, точные ошибки, unresolved work, запреты, решения/их отмена, facts только в tool args, siblings и долгие rollups.
- [ ] Сравнить новую реализацию с текущей и с no-DCP там, где baseline помещается в модельное окно. Не сравнивать «DCP завершил» с заведомо невозможным oversized no-DCP как единственное доказательство качества.
- [ ] Live evals оценивают правильное продолжение и исполнение задач, а не только наличие uppercase маркеров. Фиксировать model/config/seed/corpus revision, число повторов, failures и uncertainty; LLM judge не единственный oracle.
- [ ] Benchmark отделяет DCP overhead от raw history и LLM latency: 100/1000/10000 messages, большие results, много active/inactive blocks и restart. Измерять p50/p95/p99, peak memory, sidecar size и bytes rewritten.
- [ ] Снять baseline перед оптимизацией. Убирать повторный full hashing/scan и синхронные artifact reads; хранить monotonic identity map, но не все большие outputs навечно в live cache.

**Приёмка:** матрица раздела 7 закрыта; gates раздела 8 подтверждены отчётом с воспроизводимыми командами. Зелёные helpers при падающем long replay не разрешают rollout.

### E10 — миграция, документация и контролируемый rollout

**Приоритет:** P1 для выпуска. **Зависимости:** E01–E09.

- [ ] Обновить `specs/03-dcp.md` по фактическому коду: убрать устаревшие заявления про physical data loss, timestamp sort, always-atomic overlap и origin-call deactivation; отличать as-is от проектируемого.
- [ ] Обновить spec 26: normal cache invariants, intentional emergency rewrite и предел доказательства provider acceptance. Runtime config docs/schema должны соответствовать реально реализованным options.
- [ ] Новые internal block versions сначала поддержать в reader и тестах; затем разрешать writer. До включения writer сохранить безопасную baseline копию sidecar в пределах retention policy.
- [ ] Начать с dry-run/shadow planner: он считает plan/diagnostics, не вызывает модели и не меняет state, providers или реальную историю.
- [ ] Canary включать явно на disposable тестовой сессии после детерминированных и live gates. Проверить не только первый compress, но continuation, повторные compressions, restart и recovery.
- [ ] Выключатель запрещает новые автоматические преобразования, но не обязан автоматически разворачивать уже принятые blocks и переполнять окно. Apply существующих blocks остаётся детерминированным.
- [ ] Rollback: остановить создание новых block versions, завершить/отменить pending операции по commit-контракту, сохранить текущую raw history, использовать совместимый reader. Старый бинарник не получает sidecar с неизвестной ему семантикой без проверенной миграции.
- [ ] Выполнить suite/host checks, sync source → mirror и drift check. Перезапуск работающего pi/pix — отдельное явно согласованное действие; sync не обновляет код уже запущенного процесса.
- [ ] Выпускной отчёт перечисляет закрытые Fxx/Ixx, live-tested providers/models, skipped checks, performance/cost данные, migration/rollback результат и оставшиеся ограничения.

**Приёмка:** default policy меняется только после всех release gates; runbook позволяет безопасно остановить новые rewrites без удаления sidecars и raw данных.

## 7. Матрица обязательных регрессий

Новые названия test files ниже — предлагаемые deliverables, не уже существующие команды/файлы. Их можно объединять, если сохраняется ясная принадлежность сценариев.

| Test ID | Сценарий | Ожидаемый результат | Этап / место |
| --- | --- | --- | --- |
| T01 | Один user, 100 пар, above effective max, normal candidate отсутствует | Emergency closed plan и полезный auto commit без второго user | E00,E04,E05 / `dcp-marathon-replay.test.ts` |
| T02 | 1000 пар, 10 compressions в том же turn | Повторный прогресс, сохранены ledger/head, bounded state | E09 / replay |
| T03 | `keepRecentTurns=2`, один user, pressure ниже max | Routine message candidates пусты | E01 / `compress-pruner.test.ts` |
| T04 | b1 заканчивается m170; m171/m172 имеют equal timestamps | Смежный range проходит; реальный overlap отказывает с верными IDs | E01,E02 / existing tests |
| T05 | Message-mode result A, рядом result B с уникальным фактом | B и assistant bytes неизменны либо операция заранее отклонена | E01,E02 / `dcp-projection.test.ts` |
| T06 | Range разрезает parallel group | Preflight closed-range error; auto source включает всю группу | E02 / planner + projection |
| T07 | Signed assistant, image/tool blocks, nested args | Исходный объект deep-frozen не мутирует; retained assistant exact | E02 / projection |
| T08 | Первый range валиден, второй пересекает active block | Все counters, blocks и sidecar остаются прежними | E01,E03 / transaction |
| T09 | Valid ranges + soft-skipped message IDs | Единственный commit валидного набора, явный skip report | E03 / transaction |
| T10 | Повтор одного tool-call commit после lost reply | Те же operation/block IDs, нет двойного accounting | E03 / transaction |
| T11 | Summary > source или protected appendix съедает gain | Auto noop/blocked, state неизменен | E05 / budget |
| T12 | Все summarizers недоступны | Extractive fallback сохраняет oracle facts либо отказ | E06 / `auto-compress.test.ts` |
| T13 | Path/command/constraint присутствует только в tool args | Есть в source/результате соответствующего preservation rule | E06 / summary |
| T14 | Input больше summarizer context, cap посередине группы | Bounded chunking без silent source omission | E06 / summary budget |
| T15 | Hanging auth, ignored abort, несколько fallback models | Общий deadline, поздний completion не commit’ится | E03,E06 / async faults |
| T16 | HTTP 2xx, затем stream error или cancel | Не появляется completed evidence | E04 / `dcp-provider-lifecycle.test.ts` |
| T17 | Retry, overlapping callbacks и summarizer request | Evidence только своего owner/attempt; ambiguity safe | E04 / lifecycle |
| T18 | Много одинаковых context callbacks без provider completion | Patience/opportunities не увеличиваются | E05 / controller |
| T19 | Смена session/branch/model/config во время await | `stale_plan`/cancelled, новая сессия не изменена | E03,E04 / lifecycle |
| T20 | A/B имеют одинаковый serialized state | Оба sidecar записаны независимо | E03 / persistence |
| T21 | Snapshot меняется после enqueue | На диске bytes/hash одного immutable поколения | E03 / persistence |
| T22 | Crash/IO error до/после rename; повторная загрузка | Старое или новое полное поколение; нет ложного failed commit | E03,E07 / fault injection |
| T23 | Два процесса пишут один sidecar | Сериализация/явный конфликт, без потерянных обновлений | E03 / multiprocess fixture |
| T24 | Живая paused session >7 дней; transient scan error | Её state не удалён | E07 / persistence |
| T25 | Fork внутри rollup, decompress/recompress и resume | Fitting ancestors/ledger корректны, будущая ветка не утекла | E07 / fork reconciliation |
| T26 | Legacy missing IDs, same timestamp ambiguity | Нет guess; диагностический отказ или однозначная migration | E02,E07 / migration |
| T27 | Actual SDK native compaction удаляет raw boundaries | Договорённый recovery/unsupported outcome, не повторное удаление | E07,E09 / integration |
| T28 | Одна команда до/после изменения файла, outputs различны | Не считается exact duplicate | E08 / pruning |
| T29 | `write/Write/edit/Edit/apply_patch/shell` aliases | Политика защиты explicit; нет silent mutable rerun | E08 / protection |
| T30 | Rewrite, затем две ordinary continuations | Стабильный DCP prefix/assistant bytes, один intentional transition | E08,E09 / SDK converter |
| T31 | Frozen guidance, изменившиеся candidates, repeated telemetry | Нет prompt churn и бесконечных stale-ID советов | E08 / nudge |
| T32 | Protected text, quoted malicious output, fake bN/control tags | Сохранены trusted constraints и provenance; нет authority escalation | E06,E07 / trust |
| T33 | Missing/symlink/large artifact; другая cwd | Нет чужого чтения, sync I/O и unbounded read | E07 / artifact |
| T34 | Auto/manual/disabled config truth table; malformed values | Разрешения не расширены, invalid config явно диагностирован | E05 / `dcp-config.test.ts` |
| T35 | Serialize → restore → serialize после многих calls | Lifetime counters стабильны; caches могут быть компактными | E08 / serialization |
| T36 | Protected минимум больше capacity | Явный terminal blocked/handoff, без destructive guess и retry loop | E05 / controller |
| T37 | Генератор случайных traces с фиксированными seed | I01–I15, минимизированные counterexamples | E09 / generative |
| T38 | Реальная модель продолжает task после нескольких summaries | Проходит task oracle, не только string marker checks | E09 / live continuation |

## 8. Метрики и release gates

Числовые цели ниже — **предлагаемые критерии приёмки**, не измеренные свойства текущей версии. Перед live gate зафиксировать corpus, workload и machine profile; не ослаблять критерии после просмотра неудачных результатов без письменного обоснования.

### 8.1. Безусловные gates корректности

- **G1:** ноль silent outside-plan deletions и mutations retained signed assistant в детерминированном corpus и seeded traces.
- **G2:** ноль partial commits при fatal preflight/prepare errors; каждый persistent commit соответствует одному валидному durable generation.
- **G3:** 100% явно защищённых fragments и обязательных oracle facts в соответствующих deterministic fixtures после 10 циклов; неизвестное смысловое качество не отмечено как proven.
- **G4:** ноль успешных auto operations с `projectedAfter >= projectedBefore` по выбранному estimator; metadata/appendices включены в расчёт.
- **G5:** conditional liveness T01/T02/T18/T36 выполнен: ограничены возможности/попытки, а не обещана компрессия любого защищённого payload.
- **G6:** ноль DCP-induced prefix изменений на обычной continuation после intentional rewrite в поддерживаемом provider harness.
- **G7:** все F01–F15 имеют закрывающий тест либо явно описанное ограничение с безопасным runtime outcome; ни один P0 не остаётся «known but enabled».

### 8.2. Смысл, стоимость и latency

Для live corpus начать не менее чем с 30 разных continuation-задач и несколькими повторениями на конфигурацию; это пилот, не достаточное само по себе статистическое доказательство. Измерять task completion, нарушенные constraints, invent/repeat-work rate, tool retries, summary mode и recovered facts без подсказки test markers в каждом prompt.

Целевой non-inferiority margin для task success — не хуже сопоставимого baseline более чем на 5 процентных пунктов. Для release решение должно учитывать доверительный интервал paired difference и достаточный sample size; если он не позволяет заключение, расширить выборку или оставить canary, а не объявлять равенство по близким средним. Критические explicit constraints в release corpus не нарушаются.

Считать полную стоимость: main input/output, доступные cached-token usage, summarizer input/output и дополнительные повторные tool calls. Без тарифов и provider usage не публиковать денежный ROI; сравнивать tokens и latency раздельно. Emergency safety не обязана окупаться на единственном коротком запросе; routine compression должна показывать пользу на подходящих длинных workloads.

### 8.3. Performance budget

E00/E09 фиксируют workload и аппаратную конфигурацию. Начальные целевые бюджеты: для проекции примерно 1000 сообщений / 1 MiB текстового контента p95 DCP CPU path <50 ms на согласованной reference machine; отсутствие непрерывных main-thread участков >20 ms при больших fixtures за счёт chunking/yields. IO и LLM ожидание измеряются отдельно. Это targets, не текущие измерения и не оценка срока разработки.

Дополнительно: не более 20% необоснованной регрессии на обычном workload относительно E00; для 10000 сообщений отдельно измерить peak memory и growth slope. Monotonic IDs могут занимать O(n) метаданных, но большие raw outputs не должны бесконечно дублироваться в памяти/sidecar. Выход за бюджет требует оптимизации или явно ограниченной supported workload, не удаления recovery данных без договора.

## 9. Порядок небольших PR и зависимости

| Поставка | Содержимое | Выпускное условие |
| --- | --- | --- |
| PR-01 | E00 + защитные fixes E01 с минимальными regressions | Нет silent sibling loss/partial range writes в покрытых сценариях |
| PR-02 | Изоляция persistence F06, immutable queued bytes и atomic write foundation E03 | A/B и fault tests; старый формат читается |
| PR-03 | Canonical index, shared policies и exact projection E02 | Старые IDs/cache tests сохранены; message semantics versioned |
| PR-04 | Полный transaction + epoch/revision/idempotence E03 | Batch/async/multiprocess acceptance |
| PR-05 | Provider evidence E04 | SDK traces и 2xx/abort negative tests |
| PR-06 | Budget/progress controller E05 | One-turn liveness и blocked outcomes |
| PR-07 | Summary source, budgets, extractive fallback E06 | Semantic eval gate; плохой fallback не включать раньше |
| PR-08 | Recovery/migration/retention/privacy E07 | Restart/fork/legacy/cleanup matrix |
| PR-09 | Dedup semantics, cache finalization, telemetry E08 | Prefix stability, effective stats, protection aliases |
| PR-10 | Финальный replay/generative/live/performance gate E09 | Отчёт G1–G7 и quality/cost uncertainty |
| PR-11 | Документация, canary и rollout E10 | Совместимый reader, проверенный rollback, sync |

PR-06 допускает интеграционный каркас с прежним summarizer, но новая aggressive policy не выкатывается до PR-07/PR-10. Тесты E09 добавляются в каждом предыдущем PR. Независимо можно готовить fixtures, persistence foundation и live corpus; одновременные несовместимые правки `state.ts`/`index.ts` нужно согласовывать через общий контракт.

Не делать «один большой rewrite» и не тратить первый этап на wording нуджей. Самая ранняя ценность — исключить незаявленную потерю соседей и частичные commits.

## 10. Команды проверки и deployment runbook

Перед выполнением — из корня pix, с доступным repo-supported Node toolchain:

```bash
command -v node
command -v npm
command -v mise
command -v bun
node --version
npm --version
bun --version
cat .nvmrc
```

Отсутствующий executable — причина настроить/указать существующий установленный toolchain, не причина исполнять Node-specific проверки через Bun. Версию сверить с `.nvmrc` и package scripts, а не считать числа из этого документа вечными.

Детерминированные gates после изменений production кода:

```bash
npm --prefix external/pi-tools-suite run check
npm run sync:sdk-pin:check
npm run check
npm run generate-schemas:check
git diff --check
```

`npm run check` включает генерацию схем: проверить diff, что она не изменила посторонние схемы. Существующие focused тесты запускаются из suite:

```bash
(
  cd external/pi-tools-suite
  bun test test/compress-pruner.test.ts test/auto-compress.test.ts \
    test/dcp-state-persistence.test.ts test/dcp-state-serialization.test.ts \
    test/dcp-fork-reconciliation.test.ts test/dcp-config.test.ts \
    test/dcp-debug-log.test.ts test/dcp-prompts.test.ts test/compress-ui.test.ts
)
```

После model-facing prompt changes, с разрешёнными расходами и доступным model registry:

```bash
npm --prefix external/pi-tools-suite run test:prompt-evals
npm --prefix external/pi-tools-suite run test:prompt-evals:dcp
```

Production canary model задавать через реально поддерживаемые `PI_TOOLS_SUITE_E2E_MODEL` / `DCP_SUMMARY_E2E_MODEL`, сверив текущий live helper. Новые replay/live continuation файлы добавляются в gate по мере реализации; не считать их уже подключёнными к scripts.

После всех gates и проверки deployment scope:

```bash
npm run sync:pi-tools-suite
npm run sync:pi-tools-suite:check
git status --short
```

Сохранение только данного Markdown не требует sync: runtime suite не изменён. При будущей реализации sync подтверждает совпадение файлов, но не reload процесса. Работающую пользовательскую сессию не перезапускать автоматически.

## 11. Итоговый Definition of Done

- [ ] Все P0 закрыты постоянными регресс-тестами, не только одноразовыми probes.
- [ ] Routine, emergency, manual и direct-tool пути используют общий план/политику безопасности.
- [ ] Материализация не имеет скрытых дополнительных deletions; message-mode не теряет siblings.
- [ ] Atomic commit, epoch guards, idempotence и per-session persistence выдерживают fault injection.
- [ ] Provider evidence учитывает stream completion и не смешивает main/summarizer/retry requests.
- [ ] Marathon replay выполняет 10 полезных компрессий без второго user-turn и без потери oracle facts.
- [ ] Fallback сохраняет проверяемый минимум или явно отказывается; negative/zero gain не считается успехом.
- [ ] Restart/fork/native-compaction boundaries, recovery и retention имеют проверенные контракты.
- [ ] Cache invariants проходят реальные SDK serialization fixtures после нескольких rewrites.
- [ ] Live quality/cost отчёт опубликован с sample size, uncertainty и перечнем моделей; skipped != pass.
- [ ] Performance targets измерены; документация соответствует новой реализации и ограничениям.
- [ ] Проверены migration/rollback, все suite/host gates, sync/drift; нет изменений `local-gpt-agent`.

## 12. Источники и навигация для исполнителя

Ссылки указывают на существующие файлы baseline; новые модули в тексте — предложения. Источники текущих фактов, в отличие от критериев желаемого поведения:

- [Правила сьюта](../.pi/skills/pi-tools-suite/SKILL.md) и [правила pix](../.pi/skills/pix/SKILL.md): headless, source/mirror, проверки, SDK pins, stale ctx.
- [Candidates](../external/pi-tools-suite/src/dcp/pruner-candidates.ts): `detectCompressionCandidate`, `detectEmergencyCompressionCandidate`, `detectMessageCompressionCandidates`.
- [Compress tool](../external/pi-tools-suite/src/dcp/compress-tool.ts): preflight и последовательное применение ranges/message entries.
- [Block creation](../external/pi-tools-suite/src/dcp/compression-blocks.ts): protected content, boundaries, accounting, artifact reads.
- [Block projection](../external/pi-tools-suite/src/dcp/pruner-compression-blocks.ts): actual range expansion, insertion, orphan repair и reconciliation.
- [Auto summary](../external/pi-tools-suite/src/dcp/auto-compress.ts): decision, transcript, fallback, model attempts и deadlines.
- [Lifecycle](../external/pi-tools-suite/src/dcp/index.ts) и [provider evidence](../external/pi-tools-suite/src/dcp/provider-tool-results.ts).
- [Pruning pipeline](../external/pi-tools-suite/src/dcp/pruner.ts), [tool policies](../external/pi-tools-suite/src/dcp/pruner-tools.ts), [emergency output selection](../external/pi-tools-suite/src/dcp/pruner-emergency.ts).
- [State](../external/pi-tools-suite/src/dcp/state.ts), [persistence](../external/pi-tools-suite/src/dcp/state-persistence.ts), [commands/recovery](../external/pi-tools-suite/src/dcp/commands.ts).
- [Message IDs](../external/pi-tools-suite/src/dcp/pruner-message-ids.ts), [nudges](../external/pi-tools-suite/src/dcp/pruner-nudge.ts), [debug log](../external/pi-tools-suite/src/dcp/debug-log.ts).
- [DCP config](../external/pi-tools-suite/src/dcp/config.ts), [suite scripts](../external/pi-tools-suite/package.json), [host scripts и pins](../package.json), [схема](../schemas/pi-tools-suite.json).
- [Основные regressions](../external/pi-tools-suite/test/compress-pruner.test.ts), [summary tests](../external/pi-tools-suite/test/auto-compress.test.ts), [live summary eval](../external/pi-tools-suite/test/prompt-evals/dcp-summary-e2e.test.ts).

Локальный дополнительный источник: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:209–238,513–537`. В baseline SDK описаны `ctx.signal`, `ctx.abort()` и HTTP hook до consumption stream. Этот путь не является tracked документацией и должен повторно проверяться после обновления зависимостей.

**Рекомендуемая первая исполняемая задача:** E00 + E01, отдельно от остального рефакторинга. Зафиксировать и устранить sibling deletion, partial batch и inconsistent recent-turn gating; затем вводить единый exact plan и durable commit.
