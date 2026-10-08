# Code Health для Pix — проект архитектурной рекомендации

Статус: предложение для согласования, не утверждённая архитектура и не план немедленной реализации. Синтез раундов 1–4; впереди независимая критика раунда 5. Участники: P1 — GPT-6 Astra, P2 — GLM-5.3, P3 — Claude Opus 5.5. Репозиторные факты ниже проверены чтением текущих локальных контрактов/исходников; тесты не запускались. Совет не подтверждает эмпирическую полезность будущего продукта.

## 1. Проблема, ограничения и критический разбор

Нужна полезная непрерывная обратная связь о новых проблемах и архитектурном ухудшении во время AI-assisted разработки. Это НЕ единый решаемый класс задач: измерить рост файла, доказать import cycle и воспроизвести stale completion — принципиально разные проверки.

Главный риск — построить инфраструктуру раньше полезного сигнала. Даже точная метрика «файл вырос на 40 строк» может ничего не добавить к diff; вопрос «где cleanup?» после каждого Promise — шум, хотя он формально не утверждает дефект. Неполный анализ может ложно успокаивать. Вычисление в фоне всё равно конкурирует за CPU/RAM. Baseline, идентичность findings, trust, внешние writers и teardown часто сложнее самих правил. Автоматические nudges расходуют контекст и способны запустить churn. Источники: P1-K1/K4/K5, P2-C3/E3/E4, P3-C1.

Поэтому допустим результат исследования «не строить runtime»: оставить полезные project checks или журнал проверяемых обязательств. Неудача счётчика строк не опровергает конкретное AST-правило; успешное правило не доказывает нужность брокера или автоматических уведомлений (P1-R4, P2-R2/D1).

Фиксированные ограничения: без изменений кода/зависимостей на этом этапе, без auto-fix и автоматического продолжения агента; paid council разрешён пользователем только для этой дискуссии. Будущий анализ по умолчанию локальный, opt-in, user-only. Разрешение на этот council НЕ является согласием на будущую передачу файлов в Code Health LLM.

## 2. Подтверждённые факты репозитория

- [Observer spec](specs/heads-up-observer.md) и [решение 0034](docs/decisions/0034-heads-up-observer.md): Observer не code reviewer/enforcer, не читает файлы самостоятельно, работает с ограниченным разговорным/tool-evidence, tool-less inference, максимум три замечания. Встраивание файлового ревью или передача исходников ему по новому каналу требуют явного пересмотра контракта (P1-F1, P3-A).
- SDK 1.1.0 последовательно ожидает tool_result handlers. Await диагностики внутри hook добавляет latency основному инструменту; замена content без structuredContent может удалить structuredContent. Поэтому существующее LSP/comment-checker enrichment — не шаблон неблокирующего фонового анализа (P1-F2).
- [mutation-events](external/pi-tools-suite/src/lsp/mutation-events.ts) даёт пути-кандидаты, включая changedFiles от ast_apply; nested SDK/codemode вызовы имеют parentToolCallId и собственные hooks. Это не доказательство фактической записи и не универсальное покрытие shell/external процессов (P2-F4).
- Comment-checker пропускает added-comment extraction для ast_apply; это ограничение его hunk-based подхода, НЕ отсутствие changedFiles у ast_apply. Полный снимок кандидата устраняет именно отсутствие diff, но не делает event stream полным (P2-F5, P1-R3).
- agent_settled сам содержит aborted, а финальный outcome tracked через agent_before_settle. Автоматическую сводку нельзя запускать по каждому turn_end или считать любой settled успешным (P2-F2).
- [LSP manager](external/pi-tools-suite/src/lsp/shared-manager.ts) уже решает LSP leases/trust/lifecycle, но sharedDiagnosticsForFile возвращает строку; универсального versioned Findings Store или общего analyzer-broker API нет. Его reuse ограничен существующими LSP responsibilities (P1-F3/K4).
- AST-grep интеграция запускает внешний executable; его присутствие не гарантировано. TypeScript devDependency не равна доступному runtime compiler. Нельзя обещать «без новых зависимостей» и одновременно незаметно установить анализатор (P1-F3).
- Существующий comment-checker timestamp module-scoped. Это не подходящая модель session-owned dedup; исправление этого отдельного кода не входит в задачу (P2-F1).
- [Artifact contract](specs/harness-artifact-storage.md): disposable reports — уникальные .pi/artifacts/; harness-owned output — свои .pi/subagents/ и council storage. Durable baselines/suppressions не scratch. Initialized Desktop TTL 72h/manual cleanup immediate, поэтому сохраняемые evidence нужно экспортировать.

Точные исходники SDK: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{types.d.ts,runner.js} и core/agent-session.js. Локальное исполнение project config не sandbox и не гарантия отсутствия сети; LSP trust не даёт разрешения на любые lint/Git/test команды.

## 3. Альтернативы и trade-offs

Варианты не строго взаимоисключающие: D выбирает способ анализа, C — вход событий, B — упаковку и ownership, A — смешение с Observer.

| Вариант | Coupling / complexity | Latency / стоимость | Noise / тестируемость / расширение | Влияние на агента и вывод |
|---|---|---|---|---|
| A: встроить в Observer | Максимальная связанность разговорной и файловой свежести; reuse scheduling выглядит экономно, но нарушает контракт | Background возможен, но LLM-токены/ограниченный context и конкуренция за три карточки | Сложно изолировать регрессии двух механизмов; ревью без чтения контекста слабое | User-only сохранить можно; НЕ рекомендуем для MVP. Открыто после отдельного изменения контракта |
| B: standalone code-health suite + UI bridge | Хорошие границы detection/scheduling/presentation, но store, IPC, leases и plugins быстро становятся платформой | Async не исключает ресурсной конкуренции; LLM необязателен; межсессионный broker дорог в разработке | Хорошая изоляция и расширяемость, noise определяется анализаторами | Подходит позднее при измеренной потребности, не стартовая обязанность |
| C: after-edit hook | Минимальная начальная стоимость; использовать только collector | Await analysis блокирует tool; даже scan patch требует byte cap | Простые тесты collector; transient code, shell/external gaps; при росте легко превращается в B | Без изменения tool content. Nudges отдельно opt-in, не default |
| D: LSP/lint/AST + selective LLM | Reuse специализированных правил, но availability/trust/formats разнородны | Локальные проверки обычно дешевле LLM, но затраты надо мерить; существующее LSP enrichment уже awaited | Полезность проверяется по правилам, semantic/runtime limits остаются; конфиги project-owned | Основной кандидат для detection; не означает новый обязательный линтер |
| E: проверяемые обязательства и project ratchets без runtime | Самая небольшая инфраструктура; проект владеет policy и тестами | Нет фоновых запросов; пользовательская работа/тесты имеют стоимость | Не обнаруживает неожиданный риск; может стать бюрократией; легко проверяемые действия | Полноценная альтернатива движку, а не обязательный слой каждой сессии |

Рекомендуем D для анализа, C как последующую опциональную автоматизацию, E как независимый путь для lifecycle-рисков. B — возможная зрелая упаковка, не предварительное условие. A не выбирать для MVP. Источники: P1-A–E, P1-R1/R2, P2-R1–R3, P3-R1/R2.

## 4. Рекомендуемые границы и этап первого продукта

Рекомендация родителя: сначала маленький ручной эксперимент /health по выбранным файлам, отдельно от Observer; затем тонкая самостоятельная opt-in автоматизация, если доказана добавочная полезность. Это выбор в пользу P1-R1, а не утверждение полного консенсуса.

Логические роли нужны, универсальная платформа не нужна:
1. Collector: только bounded candidate paths/source tags; не читает файлов, не анализирует полный write, не меняет tool_result. Huge patch parsing ограничивается; overflow означает partial coverage.
2. Snapshot/runner: читает ограниченную разрешённую область асинхронно; CPU-heavy AST/graph — worker или процесс, не UI/main thread. Запускает только доступные разрешённые анализаторы. Один физический in-flight анализ на runtime, bounded pending dirty-set, coalescing, cancellation/generation guards.
3. Небольшое session-owned состояние результатов: snapshots, rule/version, anchor, evidence, coverage, delivery generation. Не plugin registry, отдельный daemon или durable DB в MVP.
4. Presentation: отдельный пользовательский отчёт; позднее компактная opt-in сводка. Не тратить Observer inference/card slots. Общий визуальный компонент возможен позже, но не означает общие inference/freshness.

MVP может вообще не иметь collector: ручной список файлов достаточен для сравнения полезности. No background Git/watcher/IPC/broker/LLM/plugin framework/agent injection на первом этапе. Отключение Observer не меняет результат /health и наоборот (P1-H4).

## 5. Detection: что можно утверждать

Severity = возможные последствия; evidence class/confidence = что установлено. Не смешивать их и не рисовать псевдоточность в процентах.

| Категория | Реалистичная проверка | Допустимая формулировка |
|---|---|---|
| Детерминированные метрики | Размер/рост файла, превышение согласованного budget | «Размер  N / рост M относительно X», НЕ «God Module доказан» |
| AST и ограниченный dataflow | Размер функции, запрещённые project-policy API, acquisition/cleanup patterns, stale guard в конкретной поддержанной модели | Точный rule match или flow counterexample с assumptions; отсутствие remove рядом само по себе только подозрение |
| Межфайловый граф | Новые разрешённые import edges, boundary violations, SCC/cycle witness | Цикл в построенном графе; unresolved imports/динамика — explicit incomplete coverage, не доказательство runtime deadlock |
| Runtime/тесты | Reordered async completions, repeated mount/unmount, cancellation during teardown, retention after cleanup, blocking spans, lock/wait trace | Воспроизведённое нарушение конкретного инварианта на конкретном снимке. Heap growth сам по себе не доказывает leak; passing test не доказывает отсутствие всех races |
| Heuristic/LLM | Концентрация ответственностей, подозрительный ownership, неполная async цепочка | «Требует проверки», evidence refs и missing context; без auto promotion в verified defect |

Для async races нужны запись состояния, возможные interleavings, owner generation/cancellation semantics и детерминированный контрпример. Listener/subscription не обязан иметь remove/dispose в том же файле: once, AbortSignal, framework teardown или другой владелец могут быть правильными. Sync API call — доказанный вызов/нарушение policy, но main-thread block требует reachable hot path и измерения. Deadlock — wait cycle/reproducer с lock ordering assumptions, НЕ await внутри lock как автоматическое доказательство. God Object и «дублирование ответственности» остаются архитектурной интерпретацией, подкреплённой графом/обсуждением.

Для lifecycle MVP лучше выбранные пользователем обязательства: «поздний результат не меняет нового owner», «последний владелец освобождает ресурс», со ссылкой на существующий тест. «Нет свежего тестового свидетельства» — отдельный статус, не finding о дефекте (P1-H2/K5, P3-H5).

## 6. Pipeline и расписание автоматической фазы

1. Tool/nested event добавляет bounded кандидаты и source tags. Ошибочный инструмент тоже кандидат: возможна partial write. source=tool значит наблюдённый вход, не доказанное авторство.
2. Runtime coalesces duplicate paths. Новый content/config generation инвалидирует затронутые результаты; не всё дерево заново. Debounce объединяет burst, не создаёт per-edit queued tasks.
3. Snapshot фиксирует содержимое/hash и versions всех используемых inputs/config/baseline. Limits/exclusions/symlink boundary применяются до дорогого чтения.
4. Локальный анализ вне main thread, bounded time/bytes/files/processes. Нет capability — not_checked, не auto-install.
5. Перед delivery проверить generation/session/worktree и все input versions. Dependency change инвалидирует graph/dataflow даже при неизменном target. Несопоставимые/изменённые inputs — stale/retry pending, не публикация current.
6. Обновить session-owned результат; уведомлять только о новых/существенно ухудшившихся согласованных правилах. Не дублировать LSP findings и не преобразовывать его string output в «verified» health fact.
7. Automatic user-only summary — только после successful final settlement; manual /health доступен после failed/aborted. Shell/external writes покрываются только отдельной reconciliation, которой нет в исходном MVP; интерфейс это сообщает.

| Trigger | Предложенное поведение |
|---|---|
| Каждый edit | Запись/инвалидация кандидата, без анализа/nudge |
| Debounce | Поздняя fast tier для доступных локальных правил; continuous edits coalesced, budget ограничен |
| Successful agent_settled | Повод для auto-check/summary, не замена FS snapshot validation |
| Manual /health | Явно выбранная область, доступно и после ошибок; расширение/testing отдельным согласием |
| Deep/LLM | Ручной opt-in; автоматизация только после отдельного доказательства пользы/согласия |

Не обещать абсолютной свежести относительно постоянно меняющегося диска. Гарантия относится к проверенному наблюдённому снимку и delivery generation. Watcher позже ускоряет invalidation, но остаётся lossy и нуждается в overflow reconciliation. Generation checks решают логическую доставку; физический слот удерживается до реального окончания/подтверждённого kill. Просто timeout+AbortSignal не разрешает начать замену игнорирующему отмену анализу. Анализатор не пишет в проверяемое дерево; свои scratch outputs исключены, чтобы не создать loop.

## 7. Baseline, identity, resolution, уведомления

Разделить три идентичности (P1-H3/R3, P2-R4): физический worktree; analysis snapshot+rules/config/dependencies; delivery session+generation. Два worktree одного Git repo нельзя смешивать. Две сессии одного worktree могут дублировать дешёвый анализ в MVP, но имеют независимую доставку/teardown. Shared immutable cache/leases только после измерения duplicate cost; существующий LSP broker не универсальный broker.

Baseline:
- policy baseline: reviewed разрешённые budgets/нарушения; отвечает «хуже согласованной политики»;
- observation baseline: конкретный сохранённый снимок; отвечает «что изменилось между наблюдениями»;
- unknown: состояние без regression claims.
Git HEAD не является pre-agent состоянием dirty worktree. Первый post-edit snapshot не доказывает состояние до edit. Session delta и policy delta показывать раздельно. Обновление baseline/rule/config само инвалидирует сравнение и требует provenance, не автоматического принятия всех новых нарушений.

Позиция родителя по mixed writers: сравнимые снимки позволяют честно показать измеренный delta «между наблюдениями; авторство неизвестно». Нельзя приписывать его агенту; origin tags не фильтруют результаты. Это принимает P1-R4 и сохраняет несогласие P2-E1/P3-H1, предпочитающих state-only. Без сравнимой базы — только state. Unknown авторство само по себе не означает плохое качество.

Stable finding identity: producer/rule + workspace + path/symbol/normalized anchor; snapshot hash отдельно. Lines — location, не ID. Rule version входит в compatibility/cache inputs, а при смене semantics identity мигрируется явно. Rename/duplicate symbol matching conservative; при ambiguity не переносить suppression/«исправлено» автоматически.

Состояния: current_for_snapshot; stale/pending; not_checked/partial; rechecked_clear_in_scope; object_removed/renamed; dismissed/accepted-policy. Отсутствие результата, parser error, abort, coverage loss или удаление пути НЕ означает исправленный дефект. Resolution требует успешной повторной проверки достаточной области с валидными входными версиями. Для deterministic rules второй одинаковый снимок не добавляет доказательства; runtime flaky evidence требует отдельного протокола (P1-K3, P2-R4).

Уведомления: stable-ID dedup и cooldown per session, отдельные policy thresholds/hysteresis для metrics, new/worsened events; existing debt показывать по запросу, не спамить. Изменение строк не повторное предупреждение. Не использовать единый «код здоров» score или трактовать silence как успешную полную проверку. Durable baseline/suppressions хранятся в согласованном persistent project/user storage, не disposable artifacts.

## 8. Реалистичный MVP и расширение

### Фаза 0 — сравнение без runtime-платформы
Параллельно оценить: (a) metrics/ratchets; (b) одно-два точных правила уже доступного анализатора; (c) пользовательские lifecycle obligations; (d) текущий процесс с AGENTS guardrails и LSP без новой функции. Control не требует самовольно re-inject checklist в agent context. Corpus: обычные изменения, известные regressions, синтетические промежуточные состояния; затем добровольный live pilot. History precision не переносится автоматически на agent states и НЕ доказана как её верхняя граница (P1-R4 против P2-E2/P3-R2).

### MVP — ручной /health, небольшой agreed scope
- File size/line metrics; function size только если подходящий parser уже доступен. Без policy/baseline — facts-only, не universal warning.
- Один ratchet growth/size rule при явно выбранной comparison базе.
- Одно точно заданное policy rule, например запрещённые synchronous filesystem API в явно выбранных UI hot-path modules, с исключениями. Это violation согласованной policy, НЕ доказательство runtime block. AST backend только доступный/разрешённый, иначе not_checked. Если rule не полезен сверх LSP — не включать его.
- Один-два выбранных lifecycle obligations со ссылками на существующие concurrency tests; не запускать тесты автоматически и не объявлять отсутствие свидетельства дефектом.
- User report: input snapshot, evidence class, policy/delta basis, coverage/limits. Нет новых dependencies, background Git, watcher, LLM, broker, plugin API, Observer changes или agent injection.

Ценность этого набора — гипотеза. Утрата полезности metrics arm не блокирует правило/obligation arm; провал всех arms допускает отсутствие runtime продукта. Repo-owned optional health checks без Pix extension — допустимый конечный вариант E.

### Дальше, только после acceptance gate
1. Opt-in collector + coalescing + successful-settle сводка; manual работает после errors. Проверить burst, partial failed mutations, nested hooks и latency. Эта фаза уже даёт непрерывное наблюдение в явно ограниченном event scope.
2. Project ratchets, dependency boundary/cycle graph и config/dependency-aware invalidation; optional trusted reconciliation shell/external изменений. Не обещать universal coverage. Для не-git workspace можно explicit watched scope/snapshots, если согласованы limits.
3. Выборочная LLM-assisted triage сложных candidates: explicit provider/egress/cost consent, bounded redacted snippets/context, untrusted content не инструкции, no tools/auto fixes. Предлагать вопрос/доказательство, не подтверждать race своим мнением.
4. Suite/общий UI/immutable cache/межпроцессное scheduling — только если измерены multiple analyzer demand или duplicate resource cost. Observer bridge исключительно после отдельного изменения его контракта.

Acceptance: заранее согласовать добавочную usefulness сверх LSP, maintainer-confirmed actionable/false/repeated observations, время разбора, tool latency/event-loop stalls, queue bounds/CPU/RAM и end-to-end snapshot-to-report latency. Offline expert actionability, online acted-on rate и infrastructure value — разные показатели. Численных гарантий нет; согласовать thresholds до пилота. Нарушение stale/teardown/trust invariant запрещает расширение, даже если правила полезны.

## 9. Влияние на агента и безопасность

Default: user-only report. Позднее явная вставка вопроса в пустой composer без отправки — отдельное действие, не авто-reminder. Tool-result nudge opt-in: только маленький актуальный deterministic факт, cooldown и preservations structuredContent; background finding нельзя вставить в уже завершённый tool result задним числом. Opt-in quality gate только для согласованных воспроизводимых правил/полного scope; heuristic не blocker. Никакого auto-fix или unbounded agent continuation.

Права различны: чтение ограниченной области; execution project config/tests/linters; исходящий код/LLM; отправка/continuation. Локальный executable может иметь сеть: «локальный анализ» обещать только в определённом проверенном threat model, не из самого факта subprocess. Untrusted workspace не запускает project plugins/scripts и Git по умолчанию. P3-F1 (Git fsmonitor/filter/index-lock details) остаётся непроверенной гипотезой: предлагаемые --no-optional-locks/disable fsmonitor не считать полной sandbox hardening. Git integration требует отдельной проверки поведения/режима до реализации.

Exclusions/limits: explicit language/file scope, generated/vendor/build/minified/binary/secret paths, symlink/root-escape checks, byte/file/output caps, bounded processes/deadline. Не исключать автоматически весь external/: здесь external/pi-tools-suite — редактируемый исходник проекта. Big monorepo/unsupported language/missing analyzer → visible coverage limitation, не «успешно». LSP remains owner of its diagnostics; avoid duplicate launch/warnings and не менять comment-checker в этом MVP. Desktop QA scope — macOS; TUI portability отдельная проверка.

## 10. Failure modes и обязательные будущие тесты

| Сценарий | Acceptance invariant |
|---|---|
| Анализ v1 завершается после v2 | v1 не заменяет/не очищает актуальное состояние v2 |
| File/dependency/config/baseline change during analysis | Input vector mismatch инвалидирует result, даже target hash прежний |
| Ignored abort/hung child | Physical slot не освобождён преждевременно; no replacement storm; timeout/kill не ведёт к late delivery |
| Session switch/shutdown/new prompt | No old delivery; timers/listeners/process ownership released; чужие owners не закрываются |
| Nested/codemode burst and late nested result after abort | Bounded coalescing, candidate retained, no successful auto-summary on failed final outcome |
| Failed tool partially writes | Actual snapshot кандидата проверяется; isError не означает unchanged |
| Huge patch/full write/monorepo overflow | Ограниченный collector overhead; no file I/O/AST in hook; partial coverage вместо silent drop |
| Rename/delete/ambiguous matching | Object_removed/unknown identity, не «defect fixed»; no blind suppression transfer |
| Dirty-start/untracked/mixed writers | Named comparison basis и unknown attribution; no parent authorship claim |
| Shell re-edit already dirty file/watcher overflow | Reconciliation test на содержимое, не только set of dirty paths; без неё explicit uncovered |
| Parser/analyzer unavailable/error/partial | not_checked/partial, never resolved or clean |
| Untrusted config/symlink escape/secret | No project execution or external egress без consent; scoped reads; rejects escaping paths |
| LSP/comment-checker coexistence | No duplicate diagnostics, no unintended changes to content/details/structuredContent |
| Analyzer scratch writes/agent-request feedback | No recursive recheck/nudge loop; approved budgets/cooldowns hold |
| Test evidence followed by edit | Evidence becomes stale; pass not universal proof |

Existing heads-up-controller/codemode-sdk/LSP lifecycle test SOURCES suggest patterns, not coverage of code-health; no tests run or future tests claimed passing.

## 11. Согласия и разногласия council

Сходство позиций: не интегрировать review в Observer для MVP; не анализировать в awaited hook; user-only/local-first с честной evidence/coverage моделью; не начинать с broker; baseline != authorship; resolution != отсутствие findings; дополнительную полезность измерять (P1-R1–R3, P2-R1/R4/R5, P3-R1/T2). Это согласие об ограничениях, не эмпирическое доказательство продукта (P2-C3).

Сохраняемые разногласия:
- Первый продукт: P1 — manual selected-files MVP до collector; P2 — collector + git-less settle ledger/manual; P3 — collector/manual и opt-in auto-summary. Родитель рекомендует manual-first, continuous thin mode следующий.
- Mixed writers: P2/P3 state-only, P1 measured observation delta с unknown authorship. Родитель допускает последнюю формулировку только при comparability.
- Replay: P2/P3 называют history precision upper bound; P1 справедливо требует не утверждать недоказанное неравенство. Родитель сохраняет domain shift, отвергает «upper bound» как факт.
- Platform gate: P2 требует именно live-пилот перед suite/default-on; родитель принимает это для автоматической доставки и дорогой инфраструктуры, но rule acceptance отдельно и может остаться project-only.
- E (user commitments/ratchets) и контрольный вариант без detector остаются самостоятельными альтернативами, не ступенями обязательного engine.

## 12. Что согласовать до реализации

1. Первый deliverable: manual pilot, collector+manual pilot либо project ratchet без runtime?
2. Языки/области MVP и два-три правила, которые действительно важны; policy thresholds/exceptions.
3. Baseline source/storage/review и допустимые формулировки delta при unknown authorship.
4. Что counts as actionable и пороги usefulness/noise/latency/CPU/RAM; кто labels corpus; stop criteria per arm.
5. Manual-only или auto successful-settle opt-in; debounce/budget/max queue для continuous phase.
6. Workspace execution trust для analyzer/Git/tests и future shell/external reconciliation scope.
7. Только user report или позже composer insertion/nudges/gate; каждое отдельное согласие.
8. Future LLM provider, snippets/redaction, egress/cost consent, либо permanently local-only.
9. Ownership/storage между сессиями и условие, при котором разрешён shared broker/UI; Observer integration требует собственного контрактного обсуждения.

До этих согласий код не менять, зависимости не устанавливать, ADR не создавать и реализацию не запускать.