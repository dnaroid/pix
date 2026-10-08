# Code Health для Pix — итог архитектурного брейншторма

Статус: предложение для согласования, не утверждённая архитектура и не разрешение реализации. Завершены пять раундов: идеи, комбинации, критика, пересмотр альтернатив и независимая критика сохранённого синтеза. Участники: P1 — GPT-6 Astra, P2 — GLM-5.3, P3 — Claude Opus 5.5. Существенные уточнения раунда 5 учтены; disposition — в [revision-notes.md](revision-notes.md), история — в [discussion.md](discussion.md). Репозиторные факты проверены чтением локальных исходников. Тесты и runtime-пилоты не запускались. Совет не подтверждает эмпирическую полезность продукта.

## 1. Критический разбор

Измерить рост файла, найти import cycle и воспроизвести stale completion — разные задачи, не один универсальный детектор. Главный риск — построить инфраструктуру раньше полезного сигнала. Даже точная метрика размера может ничего не добавить к diff. Вопрос «где cleanup?» после каждого Promise создаёт шум. Неполный анализ способен ложно успокаивать. Background computation всё равно конкурирует за CPU/RAM; baseline, внешние writers, trust и teardown часто сложнее правил. Nudges расходуют контекст и могут вызвать churn. Основания: P1-K1/K4/K5, P2-C3/E3/E4, P3-C1.

Допустимый результат пилота — не строить runtime, а оставить полезные project checks или проверяемые lifecycle-обязательства. Провал metrics arm не опровергает конкретное правило; успешное правило не доказывает потребность в broker/автоматических уведомлениях.

Фиксированные ограничения: сейчас без изменения кода/зависимостей и без реализации; никакого auto-fix или автоматического продолжения агента. Пользователь разрешил платные запросы только для council. Это НЕ согласие на будущую передачу файлов Code Health LLM. Будущий анализ предлагается opt-in, local-first, user-only.

## 2. Подтверждённые факты репозитория

- [Observer spec](../../../specs/heads-up-observer.md) и [решение 0034](../../../docs/decisions/0034-heads-up-observer.md): Observer не файловый reviewer/enforcer, не читает репозиторий самостоятельно; inference без инструментов, ограниченное разговорное/tool-evidence, максимум три замечания. Новый файловый канал требует пересмотра контракта, а не только нового prompt (P1-F1).
- SDK 1.1.0 последовательно ожидает tool_result handlers. Await анализа в hook повышает latency инструмента; content-only replacement может удалить structuredContent. Существующее LSP/comment-checker enrichment — не шаблон неблокирующего background анализа (P1-F2).
- [mutation-events](../../../external/pi-tools-suite/src/lsp/mutation-events.ts) распознаёт пути-кандидаты, включая changedFiles от ast_apply. Nested SDK/codemode вызовы имеют parentToolCallId и hooks. Это не доказательство фактической записи и не универсальное покрытие shell/external процессов (P2-F4).
- Comment-checker не извлекает added-comment hunks для ast_apply: ограничение его diff-подхода, НЕ отсутствие changedFiles. Чтение текущего кандидата устраняет отсутствие diff, но не делает события полными. Его lastNudgeTimestamp module-scoped, поэтому не следует копировать эту модель для session-owned dedup. Исправление самого comment-checker не входит в задачу.
- agent_settled содержит aborted, а final outcome определяется через agent_before_settle. Любой settled не равен успешному; turn_end не финальная точка (P2-F2).
- [LSP manager](../../../external/pi-tools-suite/src/lsp/shared-manager.ts) решает LSP leases/trust/lifecycle, но sharedDiagnosticsForFile возвращает строку. Это не versioned Findings Store или generic analyzer broker. Reuse ограничен LSP responsibilities (P1-F3/K4).
- AST-grep интеграция запускает внешний executable, наличие которого не гарантировано. TypeScript devDependency не гарантирует runtime compiler. Нельзя обещать «без dependencies», незаметно устанавливая анализатор.
- [Artifact contract](../../../specs/harness-artifact-storage.md): disposable reports — уникальные .pi/artifacts/; subagent evidence — .pi/subagents/; council использует своё configured storage .pi/brainstorms/. Persistent baseline/suppressions не scratch. Desktop cleanup TTL 72h/manual cleanup immediate: важные evidence экспортировать.

SDK источники: node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/{types.d.ts,runner.js} и core/agent-session.js. Локальное execution project config не sandbox/no-network guarantee; LSP trust не разрешает любые lint/Git/test команды. Test sources heads-up-controller, codemode-sdk, LSP lifecycle прочитаны, НЕ выполнены.

## 3. Альтернативы и trade-offs

A–D не строго взаимоисключающие: D — способ анализа, C — события, B — упаковка/ownership, A — смешение с Observer.

| Вариант | Coupling и complexity | Latency и цена | Noise, extensibility и тестируемость | Влияние на агента / вывод |
|---|---|---|---|---|
| A: внутри Observer | Смешивает разговорную и файловую freshness; apparent reuse нарушает контракт | LLM/context budgets, конкуренция за три карточки; фон не бесплатен | Трудно изолировать регрессии; неполный контекст слаб для ревью | User-only возможен, но НЕ MVP; отдельное контрактное обсуждение |
| B: самостоятельный code-health suite + UI bridge | Хорошие границы, но store/IPC/leases/plugins быстро становятся платформой | Async не исключает CPU/RAM competition; LLM необязателен, broker дорог в разработке | Хорошая изоляция/расширение, noise зависит от правил | Возможная зрелая упаковка после измеренной потребности, не prerequisite |
| C: after-edit hook | Малый collector, но ограниченное покрытие | Await analysis блокирует tool; даже patch scan нужен byte cap | Простые collector tests; transient states и shell/external gaps; platform creep | Не менять tool content по умолчанию; nudges отдельно |
| D: LSP/lint/AST + selective LLM | Reuse правил, но разные availability/trust/formats | Локальные проверки потенциально дешевле LLM, стоимость измерять; LSP enrichment уже awaited | Проверять полезность по правилам; semantic/runtime limits остаются | Основной кандидат detection, не новый обязательный линтер |
| E: проверяемые обязательства / project ratchets без runtime | Малая инфраструктура, project-owned policy/tests | Нет фоновых запросов; ручной разбор и тесты тоже стоят ресурсов | Не ловит неожиданный риск; риск бюрократии; действия проверяемы | Полноценная альтернатива движку, не обязательный checklist каждой сессии |

Рекомендация: D для detection, C как поздняя opt-in автоматизация, E как самостоятельный путь lifecycle-проверок. B — возможная упаковка, не стартовая обязанность. A не выбирать для MVP (P1-R1/R2, P2-R1–R3, P3-R1/R2).

## 4. Рекомендуемая архитектура и первый продукт

Выбор родителя: маленький manual /health по выбранным файлам, отдельно от Observer; затем тонкая standalone автоматизация при доказанной добавочной полезности. Это P1-R1, НЕ полный консенсус: P2/P3 предпочитают collector+manual с opt-in settle summary.

Логические границы без новой платформы:
1. Collector — bounded paths/source tags, без file I/O/AST/full-write analysis или изменения tool_result; overflow сообщает partial coverage.
2. Snapshot/runner — async scoped read; CPU-heavy analysis в worker/process, не UI/main thread. Только доступные разрешённые analyzers; один physical in-flight на runtime, bounded pending/coalescing/cancellation.
3. Session-owned result state — snapshot, rule/version, anchor, evidence, coverage, delivery generation. Без durable DB/plugin registry/daemon в MVP.
4. Presentation — пользовательский отчёт, позднее компактная opt-in сводка. Не расходовать Observer inference/cards. Общий визуальный компонент позже не означает общий inference/freshness.

Manual pilot оценивает detection, НЕ coverage/noise/timing/stale delivery непрерывного режима; пользователь должен выбрать scope. Автоматизации нужен отдельный live gate. Collector-first — реальная альтернатива: потенциально дешёвые candidate metadata помогают scope, но добавляют critical-path/lifecycle код уже в пилоте и не дают полного FS покрытия (P3-S3). Независимость сохранять: отключение Observer не меняет /health и наоборот. No background Git/watcher/IPC/broker/LLM/agent injection в manual MVP.

## 5. Detection и доказательства

Severity — последствия, evidence class/confidence — что установлено; не псевдовероятности в процентах.

| Категория | Реалистичный метод | Допустимое утверждение |
|---|---|---|
| Детерминированные метрики | File size/growth, policy budget | Измеренный размер/рост относительно названной базы, НЕ доказанный God Module |
| AST/ограниченный dataflow | Function size, forbidden API policy, acquisition/cleanup patterns, stale guard конкретной модели | Rule match или flow counterexample с assumptions; отсутствующий remove рядом только suspicion |
| Межфайловый граф | Import edges, boundary rules, SCC/cycle witness | Цикл в построенном графе; unresolved/dynamic imports дают incomplete coverage, не runtime deadlock |
| Runtime/тесты | Reordered completions, repeated mount/unmount, cancellation during teardown, retention/lock traces | Воспроизведённое нарушение конкретного инварианта на snapshot; passing test не доказывает отсутствие всех races |
| Heuristic/LLM | Responsibility concentration, ownership и async chain review | Требует проверки: evidence refs, missing context; no auto-promotion в verified defect |

Async race требует state write, возможных interleavings, ownership/generation/cancellation semantics и детерминированного контрпримера. Listener не обязан иметь remove в том же файле: once/AbortSignal/framework teardown/другой owner могут быть корректными. Heap growth не доказывает leak: нужны retained-resource/ownership evidence. Sync API match доказывает вызов/policy violation, а UI block требует reachable hot path/измерения. Deadlock — wait cycle/reproducer с lock-order assumptions, не один await под lock. God Object/дублирование ответственности остаются архитектурной интерпретацией.

Для MVP lifecycle полезнее user-selected obligations «late completion не меняет нового owner», «last owner освобождает ресурс» со ссылкой на существующий concurrency test. «Нет свежего тестового свидетельства» — статус evidence, не finding дефекта (P1-H2/K5).

## 6. Pipeline и scheduling

1. Mutation/nested event добавляет bounded candidates/source tags. Ошибочный tool тоже может оставить partial write. source=tool — наблюдённый вход, не доказанное авторство.
2. Coalescing по path; content/config generations инвалидируют затронутые результаты. Hook не читает файлы и не анализирует AST. Debounce объединяет кандидаты, а не создаёт per-edit queued tasks.
3. Scoped snapshot: content hashes и versions известных inputs/config/baseline. Limits/exclusions/symlink boundary до дорогого чтения. Полная input-version гарантия возможна только при known complete input set или controlled snapshot. Opaque LSP/analyzer с hidden dependencies остаётся producer-limited diagnostic; не fully rechecked межфайловый finding (P1-S1).
4. Bounded local analysis вне main thread. Missing capability — not_checked, не auto-install.
5. Delivery guard: session/worktree/generation плюс весь подтверждаемый адаптером input vector. Known dependency mismatch инвалидирует даже при неизменном target; unknown inputs — ограничение freshness, не strong promise.
6. Result state и user report. Не повторять тот же finding через ту же известную adapter identity. Полная semantic dedup независимых producers недоказуема при string API: overlaps с provenance, не автоматически разные defects (P1-S3).
7. Первой автоматической фазе compute — manual или после successful final settlement без newer active запроса. Auto-publish требует completed outcome, current delivery generation и valid snapshot. Failed/aborted candidates bounded pending для manual/следующего successful settlement; no auto-summary/continuation.

| Trigger | Поведение первой автоматической фазы |
|---|---|
| Каждый edit | Только record/invalidate, без анализа/nudge |
| Debounce | Coalesce/invalidate, без compute/delivery во время active агента |
| Successful agent_settled | Opt-in compute/summary; completed outcome, no newer active request, snapshot validation |
| Manual /health | Explicit scope, доступно после errors; testing отдельно consented |
| Deep/LLM | Manual opt-in; дальнейшая автоматизация по отдельному gate |

Speculative fast precompute во время active turn — open later option со своим resource pilot; не default и не доставка до successful settlement (P1-S2/P3-S1). Freshness — относительно наблюдённого snapshot в пределах capability, не абсолютная актуальность постоянно меняющегося диска. Watcher later lossy и требует overflow reconciliation. Physical slot держать до реального completion/confirmed kill: timeout/AbortSignal не позволяет replacement игнорирующему abort процессу. Analyzer не пишет в проверяемое дерево; scratch outputs исключены против loops. Shell/external writes требуют reconciliation, отсутствующей в manual MVP; event coverage явно неполная.

## 7. Baseline, identity, resolution

Три identities: physical worktree; analysis snapshot+rules/config/dependencies; delivery session+generation. Worktrees одного repo не смешивать. Sessions одного worktree могут дублировать дешёвый анализ в MVP, но независимо доставляют/teardown. Shared immutable cache/leases — только после измерения duplicate cost; LSP broker не generic broker.

Baseline классы:
- policy — reviewed budgets/accepted violations: «хуже согласованной политики»;
- observation — конкретный saved snapshot: «изменилось между наблюдениями»;
- unknown — state без regression claim.

HEAD не pre-agent baseline dirty worktree; first post-edit read не устанавливает прежнее состояние. Minority P3-H2/P3-S2: выбранный HEAD/index blob tracked файла, проверенного clean относительно именно этой reference в начале наблюдения, может дать conditional pre-edit provenance. Нужны разрешённый Git execution, reference/index identity и movement detection. P1-K2 objection: это не atomic snapshot, concurrent write/неполная initial check лишают доказательства. Dirty-at-start без snapshot unknown. Git safety unverified; класс открыт, НЕ git-less MVP.

Measured delta только при existing stored comparable snapshot, например prior /health; первое чтение обычно state-only (P3-S5). Не приписывать его агенту, origin tags не фильтруют findings. При known co-runtimes automatic summary default state-only; при unknown writer coverage сообщать limitation. Manual comparable snapshot delta с unknown authorship допустим при любом числе writers. Единственный registered runtime НЕ exclusive-writer proof. Это conservative UI-часть P2-X5, но single-runtime condition для honest delta не принят; registry/broker не строить ради MVP. Остаточные P2-E1/P3-H1 state-only и P1-R4 measured-delta preferences сохранены.

Stable ID: producer/rule+workspace+path/symbol/normalized anchor; snapshot hash отдельно, lines — location, не ID. Rule semantics/version в compatibility/cache, миграция identity explicit. Rename/duplicate-symbol ambiguity не переносит suppression/resolution автоматически. States: current_for_snapshot, stale/pending, not_checked/partial, rechecked_clear_in_scope, object_removed, dismissed/accepted-policy. Absence, error, abort, coverage loss или deleted path НЕ «исправлено». Resolution — successful sufficient-scope recheck с valid inputs в пределах capability; opaque producer не получает stronger guarantee. Два одинаковых снимка не усиливают deterministic rule; flaky runtime evidence требует своего протокола.

Notifications: stable-ID/cooldown per session, metrics thresholds/hysteresis, new/worsened events. Existing debt по запросу; moving lines не повторный alert. No universal «код здоров» score. Baseline/config смена инвалидирует comparability, не автоматически принимает debt. Durable baselines/suppressions в согласованном persistent storage, не scratch.

## 8. MVP, проверка полезности и расширение

### Фаза 0 — независимые arms, а не обязательный engine
Сравнить metrics/ratchets, одно-два точных available analyzer rules, lifecycle obligations и no-feature текущий workflow с теми же AGENTS guardrails/LSP/comment-checker. Control применяется offline И в later live gate (P2-X2). Periodic checklist reminder P2-A5/P3-H7 отвергнут по умолчанию: context/agent-behaviour cost; только отдельный opt-in experimental arm, не control (P3-S4).

Corpus без capture-платформы: supplied/selected обычные версии, regressions/fix pairs, маленькие вручную подготовленные positive/negative fixtures для конкретных промежуточных состояний. Fixtures — synthetic illustrations, НЕ representative agent replay. Faithful mid-edit capture method открыт: later opt-in bounded capture требует согласованной privacy/ресурсов. git show/worktrees для lab corpus — отдельно разрешённое execution, не выполненное сейчас и не automatic Git в untrusted workspace. Label/adjudication protocol может включать независимых reviewers; sample size/thresholds согласовать, не выдумывать (P3-S6/P2-X4). History precision не переносится автоматически на live agent states; «upper bound» недоказан и withdrawn (P1-R4/P2-X6/P3-R2).

### Manual MVP /health
- File-size/line metrics; function-size только при available suitable parser. Без policy/baseline — facts-only.
- Один growth/size ratchet при named comparison basis.
- Одно точное project policy rule, например forbidden synchronous filesystem API в explicit UI hot-path modules с exceptions. Policy violation, НЕ доказанный runtime block. Available/permitted AST backend либо not_checked; правило не включать, если не полезно сверх current workflow.
- Один-два selected lifecycle obligations со ссылкой на existing concurrency tests. No automatic test execution; absence evidence не defect.
- Report: snapshot, evidence class, policy/delta basis, coverage/limits. No dependencies/background Git/watcher/LLM/broker/plugin API/Observer changes/agent injection.

Manual detection success НЕ continuous-delivery validation. Metrics arm failure не блокирует rule/obligation arm; all arms failure допускает no runtime. Project-owned optional checks без Pix extension — полноценный итог E.

### Расширение только по acceptance
1. Thin opt-in collector/coalescing и successful-settle computation/summary. Separate live delivery pilot vs no-feature: noise/timing/staleness, bursts, partial writes, nested hooks, latency. Manual доступен после errors. Explicit limited event scope; no speculative active-turn compute default.
2. Project ratchets, dependency boundaries/cycle graph, config/dependency invalidation; trusted optional shell/external reconciliation. Unsupported/non-git scope explicit; no universal coverage promise.
3. Selective LLM triage: provider/egress/cost consent, bounded redacted snippets, untrusted content not instructions, no tools/auto-fixes. Предлагать проверяемую гипотезу, не подтверждать race мнением LLM.
4. Suite/shared UI/cache/interprocess scheduling только по measured analyzer demand/duplicate resource cost. Observer bridge после отдельного пересмотра контракта.

Раздельные detection и delivery gates с no-feature comparator, сопоставимыми задачами и заранее согласованными labels/thresholds. Метрики: maintainer-confirmed actionable/false/repeated observations, review time, tool latency/event-loop stalls, queue/CPU/RAM bounds, snapshot-to-report latency. Offline actionability, live acted-on rate и infrastructure value различны. Численных гарантий нет. Stale/teardown/trust failure запрещает расширение даже при полезных правилах. Live gate обязателен для continuous delivery/suite/default-on; rule acceptance может остаться project-only (P2-D1).

## 9. Агент, trust и integration safety

Default user-only report. Composer insertion позднее — explicit action, blank composer/user-text guards, no auto-send. Tool-result nudge НЕ collector/MVP: отдельные opt-in approval и critical-path latency budget. Получение/верификация current deterministic fact может ждать; не скрывать анализ внутри collector. Preserve structuredContent/cooldown; background finding не вставить в уже завершённый result (P3-S7). Quality gate opt-in только agreed reproducible rules/full scope; heuristics не blocker. No auto-fix/unbounded continuation.

Четыре согласия: scoped read, execution project config/analyzers/Git/tests, source egress, agent sending/continuation. Local subprocess не no-network sandbox; threat model проверять. Untrusted workspace не запускает project plugins/scripts/Git default. P3-F1 Git fsmonitor/filter/index-lock behaviour остаётся unverified hypothesis; suggested flags не sandbox hardening proof. Git integration требует отдельной проверки.

Explicit language/file scope, generated/vendor/build/minified/binary/secret exclusions, canonical symlink/root boundary, bytes/files/output caps, bounded processes/deadline. Не исключать весь external/: external/pi-tools-suite здесь authored source. Big monorepo/unsupported language/missing analyzer — coverage limitation, не «успешно». LSP владеет своей диагностикой; avoid duplicate launch/known warning identities, не менять comment-checker ради MVP. Desktop поддерживает macOS, TUI portability отдельно.

## 10. Failure modes и тесты по фазам

M — manual MVP; A — событийная автоматизация; X — future graph/reconciliation/shared-runtime/composer. Manual gate не требует реализации watcher/collector (P1-S4). Это будущие acceptance, не выполненные tests/готовые SDK guarantees.

| Фаза | Сценарий | Требование |
|---|---|---|
| M/A | v1 finishes after v2; repeated /health | v1 не заменяет/не очищает v2 |
| M; X graph | Target/config/baseline/dependency mutation | Known mismatch invalidates; hidden inputs opaque producer не получают strong freshness, даже target hash прежний (P1-S1) |
| M/A | Ignored abort/hung child | Slot до real completion/confirmed kill; no replacement storm/late delivery |
| M/A | Session switch/shutdown/new prompt | No obsolete delivery; owned timers/listeners/processes released; чужие owners не закрыты |
| A | Nested/codemode burst, aborted late result/new active request | Bounded coalescing, pending retained; no auto-compute/summary from failed settlement |
| A | Failed tool partially writes | Recheck actual candidate snapshot, isError не unchanged |
| M runner/A collector | Huge files/patches/monorepo overflow | Bounded cost; no file I/O/AST in hook; partial coverage visible |
| M; X rename | Rename/delete/ambiguous identity | object_removed/unknown, не fixed; no blind suppression transfer |
| M/A | Dirty-start/untracked/mixed writers | Named basis; delta only stored comparable snapshots; no agent authorship |
| X | Shell re-edit dirty file/watcher overflow | Content reconciliation, не только path set; until X uncovered scope explicit |
| M/A | Missing/parser error/partial analyzer | not_checked/partial, never clean/resolved |
| M/A; X adapters | Untrusted config/Git/escaping symlink/secret | No unsolicited execution/Git/egress; scoped permitted reads |
| M/A | LSP/comment-checker coexistence | Same-adapter identity no-repeat; overlaps provenance, no perfect semantic dedup promise; preserve content/details/structuredContent |
| A | Scratch writes/agent feedback | No recursive recheck/nudge loop; cooldown/budgets |
| M; X tests | Test evidence followed by edit | Evidence stale, pass not universal proof |
| X | Stale digest/session switch before composer insertion | Disable/revalidate, preserve user text, no auto-send/continuation (P2-X3) |
| X | Concurrent sessions/worktrees/cache/last-owner teardown | Distinct roots/delivery; shared resource до last owner; cache не bypass freshness |
| X | Clean-at-start Git reference/index movement | Conditional provenance invalidated; no old-reference regression claim |

Existing test sources дают patterns, не Code Health coverage; tests не запускались.

## 11. Согласия и сохранившиеся разногласия

Сходство: no Observer review MVP, no analysis in awaited hook, user-only/local-first, honest evidence/coverage, no broker-first, baseline != authorship, absence != resolution. Council convergence НЕ empirical validation (P2-C3).

- Первый продукт: P1 manual-first, P2 collector+git-less ledger/manual, P3 collector/manual+opt-in summary. Родитель выбирает manual-first, но collector-first — реальный scope/critical-path trade-off.
- Mixed writers: P2/P3 state-only, P1 measured observation delta unknown authorship. Parent conservative automatic summary при known co-runtimes и manual comparable delta; residual preference не объявлено разрешённым.
- History replay: upper-bound claim P2/P3 withdrawn после возражения P1; domain shift сохранён, inequality не факт.
- Platform gate: live pilot обязателен для automatic delivery/suite/default-on; отдельное правило может быть принято project-only без runtime.
- E obligations/project ratchets и null arm — самостоятельные финалы, не ступени обязательного engine. Periodic reminder only experimental opt-in, не control/default.
- Clean-at-start Git provenance — open trust-gated minority option с conditional/atomicity objection, не MVP.
- После раунда 5 computation/publication разделены; debounce coalesces. Speculative precompute открыт позднее; freshness/dedup ограничены analyzer capability, не существующие strong LSP guarantees.

## 12. Решения до реализации

1. First deliverable: manual pilot, collector+manual pilot или project ratchet без runtime?
2. Languages/scopes, два-три полезных правила, policy thresholds/exceptions.
3. Baseline source/storage/review, delta wording, conditional Git provenance и trust/movement/atomicity limits.
4. Actionability/пороги usefulness/noise/latency/CPU/RAM; no-feature offline/live comparator; corpus sources/lab Git consent, mid-edit capture method при необходимости, label/adjudication и stop criteria per arm.
5. Manual-only vs successful-settle automation; debounce/budget/queue; speculative precompute later separate decision; reminder отдельным согласием.
6. Workspace execution trust и future shell/external reconciliation scope.
7. User report vs future composer/nudges/gate, каждое отдельное consent.
8. Future LLM provider/snippets/redaction/egress/cost либо permanently local-only.
9. Session ownership/persistent storage; критерий shared broker/UI; отдельный Observer contract discussion.
10. Adapter capabilities: known inputs/snapshot support/freshness/coverage/dedup и producer-limited limits.

До согласования этих решений реализацию не начинать. Код/spec/tests не изменялись; dependencies не устанавливались; ADR не создавался. Council approval не approval реализации.
