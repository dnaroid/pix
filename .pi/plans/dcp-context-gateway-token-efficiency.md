<!-- markdownlint-disable MD013 MD060 -->

# DCP + Context Gateway: план снижения token/context overhead

Status: **completed — deterministic implementation/verification complete**

Last updated: **2026-09-08**

Owner: текущая Pi/Code-сессия, работающая в `/Volumes/128GBSSD/Projects/pi-ui-extend`.

Основной scope:

- `external/pi-tools-suite/src/dcp/**`
- `external/pi-tools-suite/src/context-gateway/**`
- связанные producer/wrapper-слои только там, где без них невозможно безопасное budget enforcement
- соответствующие тесты в `external/pi-tools-suite/test/**`

---

## 0. Как использовать этот файл в новой сессии

Этот документ — одновременно implementation plan и progress tracker. Новая сессия должна:

1. Сначала прочитать этот файл целиком.
2. Прочитать `.pi/skills/pi-session-inspector/SKILL.md`.
3. Не редактировать исходную session JSONL. Она используется только как read-only benchmark fixture/evidence source.
4. Перед изменениями подтвердить текущую реализацию и тесты: код мог измениться после даты этого плана.
5. Вести статусы задач прямо в этом файле.
6. После каждого законченного логического шага записывать verification evidence в `Progress log` внизу.
7. Не отмечать задачу `[x]`, пока acceptance criteria и перечисленные тесты не прошли.
8. При изменении дизайна добавлять запись в `Decision log`, а не молча отклоняться от плана.

### Статусы

- `[ ]` — не начато
- `[~]` — в работе
- `[x]` — завершено и проверено
- `[!]` — заблокировано; причина должна быть записана рядом и в Progress log
- `[-]` — сознательно исключено из scope; обязательно объяснить почему

### Главный принцип

Оптимизировать нужно **полный provider-visible context**, а не локальные размеры строк.

Нельзя считать улучшением изменение, которое:

- уменьшает один tool result, но заставляет модель повторно вызывать tool для восстановления потерянных фактов;
- ломает provider prefix/cache continuity;
- теряет user intent, actionable errors, mutation evidence или protocol tool groups;
- уменьшает `contentBytes`, но увеличивает суммарные prompt token-occurrences;
- экономит токены за счёт неявного/необратимого удаления данных без recovery contract.

---

## 1. Исходная измеренная база

## 1.1 Reference session

Использовать как главный реальный benchmark:

`/Users/buzz/.pi/agent/sessions/--Volumes-128GBSSD-Projects-pi-ui-extend--/2026-09-08T09-55-23-058Z_01a08071-9731-729b-a9c2-c7fb2bdb30c7.jsonl`

Session id:

`01a08071-9731-729b-a9c2-c7fb2bdb30c7`

Model:

`openai-codex/gpt-5.6-sol`

Context window observed:

`272,000`

Исходный user-level DCP override для `openai-codex/gpt-5*`:

- `minContextPercent = 26%`
- `maxContextPercent = 46%`

## 1.2 Session-level baseline

Измерено на reference session:

| Метрика | Baseline |
|---|---:|
| Assistant/provider calls | 56 |
| Prompt token-occurrences (`input + cacheRead`) | 2,521,842 |
| Uncached input | 194,034 |
| Cache read | 2,327,808 |
| Output | 16,534 |
| Session cost | $2.630094 |
| Tool results | 71 |
| DCP compression blocks | 1 |
| DCP pruned tool results | 0 |

`prompt token-occurrences` — основная метрика context-management: один и тот же старый токен, повторно отправленный модели N раз, считается N раз.

## 1.3 DCP baseline

Фактический block `b1`:

- selected range: `m001..m072`
- selected messages: 72
- provider projection before: **54,326 tokens**
- provider projection after: **6,007 tokens**
- measured per-request net gain: **48,319 tokens**
- summary token estimate: **5,918 tokens**
- compression ratio: ~11.1% retained / ~88.9% removed
- calls after compression: 27
- gross avoided prompt token-occurrences: **48,319 × 27 = 1,304,613**
- same-flow gross reduction estimate: ~**34.1%**
- estimated net reduction after DCP control-plane overhead: ~**29–31%**

Контекст до/после:

- nudge emitted around **26.91%**
- compression committed around **27.58%**
- next provider context dropped to roughly **8.20%**

## 1.4 DCP overhead baseline

Примерные provider-visible static costs текущей реализации:

- `SYSTEM_PROMPT`: ~527 tokens
- `COMPRESS_RANGE_DESCRIPTION`: ~2,005 tokens
- provider-like compress description/schema group: ~2,355 tokens
- parameter schema alone: ~313 tokens

Distributed message ID overhead непосредственно перед compression:

- 71 messages
- 43 DCP carriers
- raw projection estimate: 52,454 tokens
- projection with carrier IDs: 53,946 tokens
- **ID overhead: 1,492 tokens (~34.7 tokens/carrier)**

## 1.5 Protected-fragment baseline — главный DCP hotspot

Модель передала в `compress` summary примерно **5,555 chars**.

Сохранённый `b1.summary` стал:

- **23,673 chars**
- **5,918 tokens**
- protected fragments: **11**
- protected fragment chars: **18,025**

То есть около **76% итогового summary по символам** пришло не из continuation summary, а из verbatim continuity/protected material.

Основной подозреваемый: `shell` входит в `ALWAYS_PROTECTED_TOOLS`, а compression pipeline добавляет protected tool outputs/fragment ledger обратно в block.

Ключевые места:

- `src/dcp/pruner-tools.ts`
- `src/dcp/compression-blocks.ts`
- `collectCurrentProtectedFragments`
- `appendProtectedToolOutputs`
- `appendProtectedFragmentLedger`

## 1.6 Context Gateway offline replay baseline

Текущий gateway не изменяет provider result; replay использует его собственную telemetry logic поверх reference JSONL.

| Метрика | Baseline |
|---|---:|
| Results | 71 |
| Errors | 4 |
| contentBytes | 273,687 |
| textBytes | 263,765 |
| Generic results > 8 KiB | 9 |
| potentialBytesOverBudget | 110,816 |
| exact repeated `read` candidates | 1 |
| retrieval calls | 0 |
| native-policy results | 0 |

Breakdown excess относительно generic `maxResultBytes=8192`:

- `read`: **87,400 B**
- `repo_structure`: **16,846 B**
- `shell`: **6,570 B**

Один exact duplicate full-read:

`/Users/buzz/.agents/skills/skill-creator/SKILL.md`

Он был прочитан до compression и затем снова после compression; второй result около 33.9 KB.

Это считать **possible rehydration tax**, но не автоматически ошибкой DCP: повторный read мог быть intentional final verification.

---

## 2. Цели и ограничения

## 2.1 Primary goals

- [x] **G1.** Снизить DCP static/control-plane overhead без ухудшения compression correctness.
- [x] **G2.** Сильно уменьшить verbatim protected-fragment inflation, особенно для shell/test/inspection output.
- [x] **G3.** Убрать silent no-op config для удалённых DCP strategies (`autoToolPruning` и др.).
- [x] **G4.** Сделать Context Gateway полезным не только как telemetry, а как безопасный budget/policy слой там, где существует доказуемый semantic/recovery contract.
- [x] **G5.** Не допустить двойного context-management: Gateway предотвращает безопасно compactable ingress, DCP сворачивает завершённую историю.
- [x] **G6.** Иметь воспроизводимый benchmark на reference session и детерминированные regression tests.

## 2.2 Quantitative targets

После полного плана целевые показатели:

- [x] DCP static provider-visible overhead: **уменьшить минимум на 35%** относительно baseline prompt/tool text.
- [x] ID/control metadata overhead до первого реального compression opportunity: **уменьшить минимум на 50%** или убрать из low-context provider projection.
- [x] Protected-fragment chars для эквивалентного reference compression: **уменьшить минимум на 50%**, сохранив continuity evidence.
- [x] Reference DCP block full-projection gain: **не ниже baseline 48,319**, целевой gain **≥52k** если protected-output refactor применим без потери correctness.
- [x] Context Gateway: 0 irreversible generic truncations.
- [x] Context Gateway native/recoverable policy: critical fact coverage **100%** на contract benchmark.
- [x] Reference session replay: modeled prompt-work не регрессирует; measured control-plane, carrier и active-summary projections все уменьшаются.
- [x] Ни одного нового повторного tool call, вызванного отсутствием continuation/recovery path, в deterministic regression fixtures.

## 2.3 Non-goals

- Не делать generic `slice(0, N)` tool results без способа достать потерянный хвост.
- Не строить новый большой durable artifact store только ради этой оптимизации, пока storeless/native recovery достаточно.
- Не удалять provider-signed assistant content или нарушать tool-call/result grouping.
- Не включать lossy auto-compression по умолчанию глобально.
- Не считать cache-read токены бесплатными: они дешевле, но всё равно занимают окно и стоят денег.
- Не оптимизировать только JSONL размер; цель — provider context/cost/continuation quality.

---

## 3. Workstream A — воспроизводимый baseline и instrumentation

Цель: прежде чем менять алгоритмы, получить repeatable measurements из reference session.

## A1. Session benchmark helper

- [x] Добавить read-only benchmark/helper для указанной JSONL или расширить существующий eval/benchmark harness.

Требования:

- не модифицирует session JSONL;
- считает assistant calls, input/cacheRead/output, tool/result distribution;
- извлекает DCP journal blocks и `compress` result details;
- считает `projectedBeforeTokens`, `projectedAfterTokens`, `netGain`;
- показывает protected fragment count/chars;
- делает offline `ContextGatewayTelemetry` replay;
- показывает repeated exact reads;
- формат вывода — deterministic JSON + короткий human summary.

Предпочтительные места:

- `external/pi-tools-suite/test/evals/**`, если это уже соответствует текущей архитектуре benchmark scripts;
- либо отдельный `test/context-gateway`/DCP support helper, если reuse проще.

Acceptance:

- [x] На reference session helper воспроизводит ключевые числа этого плана с допустимой погрешностью estimator-а.
- [x] Есть unit test на parser/aggregation без зависимости от приватного абсолютного файла.

## A2. Разделить три вида token metrics

- [x] В benchmark output явно показывать:
  - provider-reported uncached input;
  - provider-reported cacheRead;
  - `input + cacheRead` prompt token-occurrences;
  - DCP estimator projection tokens.

Не смешивать эти числа в одну метрику.

## A3. Control-plane accounting

- [x] Добавить reusable test helper, измеряющий токены/байты:
  - DCP system addition;
  - compress tool description;
  - tool schema;
  - carrier metadata;
  - nudge text.

Acceptance:

- [x] Любой дальнейший prompt change даёт видимый before/after diff в тесте/benchmark report.

Verification:

```bash
cd external/pi-tools-suite
bun test test/dcp-prompts.test.ts test/context-gateway/benchmark.test.ts
```

---

## 4. Workstream B — DCP protected continuity без verbatim inflation

**Приоритет: P0. Начинать implementation отсюда после baseline harness.**

Проблема: `ALWAYS_PROTECTED_TOOLS` смешивает две разные идеи:

1. результат нельзя безопасно удалить как обычный stale read;
2. весь stdout надо навечно копировать verbatim в compression summary.

Эти свойства не эквивалентны.

## B1. Разделить protection policy

- [x] Ввести разные решения для:
  - `pruningProtected`: нельзя заменять result generic placeholder-ом;
  - `continuityProtected`: при compression нужно сохранить continuation evidence;
  - `verbatimRequired`: действительно требуется полный exact text.

Не обязательно именно такие имена, но семантика должна быть раздельной.

Файлы-кандидаты:

- `src/dcp/pruner-tools.ts`
- `src/dcp/compression-blocks.ts`
- новый маленький helper, если разделение иначе размазывается по двум модулям.

Acceptance:

- [x] `write/edit/apply_patch` по-прежнему нельзя случайно потерять.
- [x] `shell` больше не означает автоматически «append entire stdout verbatim».
- [x] Старые persisted v2 blocks остаются replay-compatible.

## B2. Conservative shell continuity classification

- [x] Добавить консервативную классификацию shell tool records минимум на:
  - inspection/read-only;
  - test/build/check;
  - mutation/side-effecting;
  - unknown.

Классификация должна **fail closed**: непонятная команда → `unknown`, не read-only.

Не использовать простую проверку только на `;`, `&&` и pipes как доказательство read-only.

Можно переиспользовать/вынести существующие идеи из Context Gateway, но не создавать две расходящиеся классификации.

## B3. Continuity digest для shell/test output

- [x] Для inspection/test/build output вместо полного stdout сохранять bounded continuation fragment:
  - exact command или стабильный command digest;
  - exit code/outcome;
  - test/build summary, если parser уверен;
  - actionable error lines для failure;
  - truncation/source-completeness metadata;
  - указание, что exact raw output нужно re-run/retrieve только при необходимости.

Для successful inspection/test full stdout не должен попадать в protected ledger автоматически.

## B4. Mutation/unknown shell policy

- [x] Для side-effecting/unknown shell не делать агрессивную потерю данных.

Минимальная безопасная continuity запись:

- exact command;
- exit code;
- known changed-files/effect metadata, если producer его предоставляет;
- bounded actionable stderr/error excerpt;
- explicit marker, если exact output deliberately not preserved.

Если доказать безопасный digest невозможно — сохранить verbatim как сейчас.

## B5. Убрать двойное сохранение одного fragment

- [x] Проверить взаимодействие:
  - `appendProtectedToolOutputs`
  - `collectCurrentProtectedFragments`
  - `appendProtectedFragmentLedger`

Цель: один semantic continuity item не должен попадать и в expanded summary, и повторно в ledger под другой формой.

## B6. Tests

- [x] Passing shell test: большой stdout → compact continuity fragment.
- [x] Failing shell test: error evidence сохраняется.
- [x] Read-only shell inspection: full output не копируется verbatim.
- [x] Mutating shell: unsafe uncertainty не теряется; verbatim fallback остаётся.
- [x] Unknown shell: fail-closed behavior.
- [x] Protected `write/edit/apply_patch`: regression behavior unchanged.
- [x] Existing block replay/journal tests проходят.
- [x] Nested/roll-up block protected ledgers не разрастаются рекурсивно.

Кандидаты тестов:

- `test/dcp-review-regressions.test.ts`
- `test/dcp-auto-compression-projection.test.ts`
- `test/dcp-journal.test.ts`
- `test/dcp-journal-lifecycle.test.ts`
- новый focused `test/dcp-protected-continuity.test.ts`, если существующие файлы станут перегружены.

Acceptance target на reference-shaped fixture:

- [x] protected fragment chars уменьшены ≥50%;
- [x] full-projection gain не хуже baseline (`48,319 → 52,165` projected net gain);
- [x] все critical continuation facts сохранены deterministic continuity/journal tests.

---

## 5. Workstream C — сократить DCP static prompt/tool overhead

**Приоритет: P0/P1. Делать после или параллельно B, но измерять отдельно.**

## C1. Дедупликация system prompt и tool description

- [x] Разметить смысловые правила, которые сейчас повторяются в:
  - `SYSTEM_PROMPT`
  - `COMPRESS_RANGE_DESCRIPTION`
  - `promptSnippet`
  - `promptGuidelines`
  - nudge prompts.

- [x] Оставить в system prompt только global behavior/invariants.
- [x] Tool-specific protocol details оставить в tool description/schema.
- [x] Nudge должен ссылаться на уже известный protocol и содержать только urgency + concrete candidate guidance.

## C2. Сжать `COMPRESS_RANGE_DESCRIPTION`

Текущий текст ~8k chars / ~2k tokens.

- [x] Удалить tutorial-style повторения.
- [x] Сохранить строго необходимые invariants:
  - continuation summary, не transcript rewrite;
  - exact visible IDs only;
  - complete tool groups;
  - ranges vs messages;
  - user intent fidelity;
  - placeholder/covered-block safety;
  - no raw huge logs/code unless exact literal required;
  - positive full-projection gain requirement.

Target:

- [x] description token estimate уменьшен минимум на **40%**.

## C3. Сжать `SYSTEM_PROMPT`

Target:

- [x] ~527 → **≤325 estimated tokens** без потери ключевых behavioral constraints.

## C4. Уменьшить nudge duplication

- [x] `TURN_NUDGE`, `ITERATION_NUDGE`, soft/strong context reminders не должны повторять половину tool manual.
- [x] Concrete candidate hint остаётся динамическим payload поверх короткого nudge protocol.

Target:

- [x] routine nudge text уменьшить ≥30%.

## C5. Prompt regression tests

- [x] Обновить `test/dcp-prompts.test.ts` так, чтобы тестировал semantic anchors/invariants, а не случайный полный wording.
- [x] Добавить token/char budget accounting в deterministic session harness, чтобы prompt inflation был виден как before/after metric.

Verification:

```bash
cd external/pi-tools-suite
bun test test/dcp-prompts.test.ts test/dcp-review-regressions.test.ts
```

---

## 6. Workstream D — DCP message IDs только когда они реально нужны

**Приоритет: P1. Более рискованный change из-за Responses/prefix-cache invariants.**

Baseline: перед compression distributed carrier IDs добавляли около **1,492 tokens**.

## D1. Проверить минимальный contract addressability

- [x] Документировать/сохранить contract: model видит `mNNN/bN` через immutable user/tool-result carriers; assistant content не переписывается.
- [x] Проверить provider append-only/cache constraints текущими Responses/lifecycle regression tests.
- [x] Не менять signed assistant messages.

## D2. Lazy/eligible ID publication

Исследовать предпочтительный дизайн:

1. persistent stable IDs продолжают жить внутри DCP journal/runtime;
2. low-context provider projection не получает полный ID carrier для каждого message;
3. когда появляется actionable compression candidate, fresh cache-safe carrier получает минимальную addressability map только для:
   - candidate boundaries;
   - individual message candidates;
   - active compressed block aliases.

- [-] Lazy publication не реализована: compact immutable carrier уже превышает target, а перенос/поздняя публикация создаёт лишний append-only/cache risk.

## D3. Fallback

Если lazy publication ломает provider continuation/cache semantics:

- [x] не форсировать risky lazy-publication change;
- [x] вместо этого сократить carrier syntax до минимального immutable формата;
- [x] сравнить token cost с legacy `<dcp-message-ids>` wrapper.

## D4. Tests

- [x] Addressability сохраняется после reload/session tree.
- [x] Candidate IDs всегда resolvable в `compress`.
- [x] Signed assistant content byte-stable.
- [x] Repeated context transforms не плодят новые IDs.
- [x] Pre-threshold context overhead уменьшается ≥50%.

Кандидаты:

- `test/dcp-marathon-replay.test.ts`
- `test/dcp-lifecycle-marathon.test.ts`
- `test/dcp-journal-lifecycle.test.ts`
- `test/dcp-conversation-index-generative.test.ts`
- `test/dcp-transaction-faults.test.ts`

---

## 7. Workstream E — config hygiene: убрать silent dead settings

**Приоритет: P0, маленький и низкорисковый change.**

Текущий `stripRemovedDcpKeys()` молча удаляет:

- `pruneNotification`
- `manualMode.automaticStrategies`
- `strategies.deduplication`
- `strategies.purgeErrors`
- `strategies.autoToolPruning`

Reference user config содержит `strategies.autoToolPruning`, но runtime фактически не использует его (`prunedTools = 0`).

## E1. Явные config issues

- [x] Loader должен возвращать/публиковать диагностические warnings для removed keys или иметь migration path.

Варианты, выбрать один и зафиксировать в Decision log:

1. strict warning + ignore;
2. автоматическая migration в новую семантику, если mapping однозначен;
3. hard error только для явно опасных несовместимых ключей.

Предпочтение: warning + actionable migration guidance, если нет 1:1 mapping.

## E2. User-visible doctor/status

- [x] `/dcp` status/doctor (если соответствующая команда уже подходит) должен показывать ignored/removed config keys.

## E3. Tests

- [x] `test/dcp-config.test.ts`: removed key больше не исчезает бесследно.
- [x] Existing valid config merge behavior не меняется.
- [x] Model overrides продолжают разрешаться в текущем порядке.

---

## 8. Workstream F — Context Gateway: из telemetry в безопасную policy

**Приоритет: P1/P2. Не включать generic enforce до завершения recovery contracts.**

Baseline runtime до этой реализации:

- `off` — ничего;
- `observe` — telemetry;
- requested `enforce` → effective `off`;
- storage/retrieval layer отсутствует;
- delivery representation в telemetry всегда `passthrough`.

Текущий implementation state:

- `off` — byte-equivalent passthrough;
- `observe` — class-specific telemetry без mutations;
- `enforce` — selective fail-open policy;
- recognised complete simple test/build output может стать bounded semantic compact;
- `read`, unknown/partial/compound/upstream-truncated и unsupported classes остаются passthrough;
- repo native-compact остаётся producer-owned; Gateway его только учитывает и не режет второй раз.

Ключевые файлы:

- `src/context-gateway/index.ts`
- `src/context-gateway/config.ts`
- `src/context-gateway/telemetry.ts`
- `src/context-gateway/storeless-capabilities.ts`
- `src/context-gateway/test-output-parser.ts`
- producer-specific logic, например `src/repo-discovery/native-compact.ts`.

## F1. Исправить budget semantics до enforcement

Сейчас config имеет:

- `maxInlineBytes = 8192`
- `maxResultBytes = 8192`
- `maxExactReadBytes = 32768`
- `maxSearchBytes = 8192`
- `maxSearchMatches = 12`

Но generic observe path практически использует только `maxResultBytes`.

- [x] Ввести class/policy-specific budget resolver.
- [x] `read` оценивается относительно `maxExactReadBytes`, а не generic 8 KiB.
- [x] search/repo/test results оцениваются по соответствующей policy.
- [x] status/telemetry показывают реально применённый class budget.

Acceptance:

- [x] Offline replay больше не называет 8 KiB generic excess готовой enforce экономией.

## F2. Улучшить telemetry attribution

- [x] Repeated read fingerprint учитывает нормализованный path/range/options.
- [x] Exact duplicate отделён от same-file different-range read.
- [-] Автоматически называть repeat `recovery tax` нельзя: intent не выводим из args. Harness хранит post-reduction candidates отдельно и оставляет `likelyRecoveryTaxReads=0` без доказательства.
- [x] Lifecycle-unbound result не засчитывается в текущую branch telemetry.

## F3. Native compact как первый enforce surface

Для `repo_*` уже существует `native-compact` policy с bounded arguments/cursors и recovery behavior.

- [x] Gateway policy/status интегрирован с native compact telemetry вместо post-hoc truncation.
- [x] Repo output не обрезается второй раз в Gateway.
- [x] Benchmark считает continuation calls и critical fact recovery.

Acceptance:

- [x] `test/context-gateway/benchmark.test.ts`: critical fact coverage 100% (`8/8`).
- [x] Native delivered byte ratio **0.3875** (`27,519 / 71,025`), лучше target `<0.55`.
- [x] Refusals/full overrides: `0/0`, соответствуют contract.

## F4. `read` enforce — только с recovery path

На reference session `read` — главный source oversized ingress.

До включения compact delivery нужен contract вида:

- bounded exact prefix/range;
- metadata `hasMore`/source completeness;
- opaque continuation cursor или exact range parameters;
- повторный targeted read не должен требовать заново читать весь файл.

- [x] Producer contract исследован через реальный SDK Read: line `offset/limit` есть, но это current-file continuation, не immutable snapshot; huge single-line не имеет line continuation.
- [-] Post-hoc read compact не включён: producer-native ranges недостаточны для snapshot-correct recovery после изменения файла/huge-line truncation.
- [x] `read` оставлен passthrough + class-specific telemetry; `maxExactReadBytes` не является тупым truncation cap.

**Запрещено:** включить `maxExactReadBytes` как тупой truncation cap.

## F5. Test/build compact delivery

`test-output-parser` уже умеет pure parsing, но reference replay дал 19 shell results как unrecognised и 0 compact candidates.

- [x] Parser/enforce использует только доказуемые Bun/TAP/bounded-TypeScript contracts; generic head/tail отсутствует.
- [x] Compact delivery разрешён ещё строже плана: только `recognised + complete + normal termination`, с обязательными diagnostics.
- [x] Compound/unknown/upstream-truncated shell output остаётся passthrough.

## F6. Enforce mode rollout

Включать настоящий `effective=enforce` поэтапно:

1. repo native-compact only;
2. exact-read producer recovery;
3. recognised test/build output;
4. остальные classes остаются passthrough.

- [x] `enforce` означает selective fail-open policy, а не generic byte cap.
- [x] Doctor честно перечисляет test/build compact, read passthrough, producer-native repo compact и unsupported storage/external surfaces.

---

## 9. Workstream G — связать Gateway и DCP без двойной работы

**Приоритет: P2 после B/C/F.**

Целевая архитектура:

```text
producer/tool
    ↓
Context Gateway
    - не допускает неоправданно oversized ingress
    - сохраняет deterministic recovery path
    ↓
live conversation
    ↓
DCP
    - не борется с каждым большим result сразу
    - сворачивает уже завершённые workflow slices
    - хранит continuation summary, а не raw archive
```

## G1. Gateway-aware DCP metadata

- [x] Gateway `test-build-compact` marker распознаётся DCP continuity; DCP не реконструирует/не ищет отсутствующий raw stdout.
- [x] Нестабильные recovery handles не переносятся в DCP ledger; producer-owned repo cursors остаются producer-owned.

## G2. Avoid duplicate accounting

- [x] Одни и те же bytes не считаются одновременно как Gateway savings и DCP savings.
- [x] Benchmark report разделяет:
  - ingress avoided;
  - history compression gain;
  - recovery tax;
  - static control-plane overhead.

## G3. Rehydration tax

- [x] Добавлена metric exact/same-source reads после compression или compact delivery.
- [x] Любой повторный read не считается regression автоматически.
- [x] `likelyRecoveryTaxReads` остаётся 0 без доказуемого intent; reference exact repeat учитывается как `unattributedCandidates=1`.

---

## 10. Verification matrix

## 10.1 Fast focused tests после каждого change

```bash
cd external/pi-tools-suite
bun test test/dcp-config.test.ts
bun test test/dcp-prompts.test.ts
bun test test/dcp-review-regressions.test.ts
bun test test/context-gateway/config.test.ts
bun test test/context-gateway/observe.test.ts
bun test test/context-gateway/benchmark.test.ts
```

Запускать только релевантный subset в процессе работы; весь набор — перед phase completion.

## 10.2 DCP regression suite перед merge

```bash
cd external/pi-tools-suite
bun test \
  test/dcp-auto-compression-projection.test.ts \
  test/dcp-config.test.ts \
  test/dcp-conversation-index-generative.test.ts \
  test/dcp-journal-lifecycle.test.ts \
  test/dcp-journal.test.ts \
  test/dcp-lifecycle-marathon.test.ts \
  test/dcp-manual-progress.test.ts \
  test/dcp-marathon-replay.test.ts \
  test/dcp-progress-opportunities.test.ts \
  test/dcp-prompts.test.ts \
  test/dcp-recovery.test.ts \
  test/dcp-review-regressions.test.ts \
  test/dcp-shadow-plan.test.ts \
  test/dcp-transaction-faults.test.ts
```

## 10.3 Context Gateway suite перед merge

```bash
cd external/pi-tools-suite
bun test test/context-gateway
```

## 10.4 Typecheck

```bash
cd external/pi-tools-suite
npm run typecheck
```

## 10.5 Full suite

Только после focused suites:

```bash
cd external/pi-tools-suite
npm test
```

`npm run smoke` запускать, если изменения затрагивали extension registration/runtime wiring.

Live/model prompt evals не являются обязательной частью каждого маленького шага. Их запускать только если конкретное изменение невозможно проверить deterministic tests/fixtures или если пользователь отдельно хочет model-based evaluation.

---

## 11. Рекомендуемый порядок реализации

## Phase 0 — baseline

- [x] A1 session benchmark helper
- [x] A2 metric separation
- [x] A3 control-plane accounting

Exit criteria:

- reference measurements reproducible;
- benchmark output committed/available;
- дальнейшие phases имеют before/after numbers.

## Phase 1 — immediate DCP wins

- [x] E1/E2/E3 config hygiene
- [x] B1 protection split
- [x] B2 shell classification
- [x] B3/B4 continuity digest
- [x] B5 dedupe protected fragments
- [x] B6 tests

Exit criteria:

- protected fragment inflation сильно ниже;
- no safety/protocol regression;
- block projection gain не хуже baseline.

## Phase 2 — static overhead

- [x] C1 prompt dedupe
- [x] C2 tool description reduction
- [x] C3 system prompt reduction
- [x] C4 nudge reduction
- [x] C5 tests/budgets

Exit criteria:

- static overhead −35%+;
- prompt invariants preserved.

## Phase 3 — addressability overhead

- [x] D1 contract investigation
- [x] D3 compact carrier fallback; D2 consciously skipped as unnecessary risk
- [x] D4 lifecycle/cache tests

Exit criteria:

- ≥50% pre-threshold ID overhead reduction **или** documented proof, почему меньший safe target — максимум.

## Phase 4 — Context Gateway selective enforce

- [x] F1 class-specific budgets
- [x] F2 telemetry attribution
- [x] F3 repo native-compact integration/accounting
- [-] F4 exact-read compact delivery — intentionally not enabled; recovery is not snapshot-safe
- [x] F5 test/build policy
- [x] F6 selective enforce rollout

Exit criteria:

- никаких generic irreversible truncations;
- supported surfaces реально уменьшают ingress;
- critical fact recovery 100% на fixtures.

## Phase 5 — integration

- [x] G1 Gateway-aware DCP continuity
- [x] G2 split accounting
- [x] G3 recovery tax candidate tracking

Exit criteria:

- нет двойного compression/truncation одного результата;
- benchmark report объясняет, откуда пришёл каждый класс savings.

## Phase 6 — final benchmark/report

- [x] Повторить reference-session offline analysis.
- [x] Сравнить baseline/new:
  - DCP block gain;
  - protected chars/tokens;
  - static DCP tokens;
  - ID metadata tokens;
  - Gateway ingress bytes avoided;
  - continuation/recovery calls;
  - modeled prompt token-occurrences;
  - provider-reported cost там, где доступен реальный run.
- [x] Записать результат в Progress log.
- [x] Обновить этот документ `Status: completed` после прохождения Definition of Done.

---

## 12. Recommended commit/change boundaries

Не смешивать всё в один гигантский change. Предпочтительные независимые boundaries:

1. `test/bench: add token-efficiency baseline accounting`
2. `dcp: separate protected continuity from verbatim output retention`
3. `dcp: compact shell continuity fragments`
4. `dcp: report removed config keys`
5. `dcp: reduce prompt/tool description overhead`
6. `dcp: reduce message-id carrier overhead`
7. `context-gateway: resolve class-specific budgets`
8. `context-gateway: integrate native compact policy`
9. `context-gateway: add recoverable exact-read enforcement`
10. `dcp/context-gateway: integrate recovery-aware accounting`

Каждый boundary должен иметь собственные тесты и измеримый before/after.

---

## 13. Риски и guardrails

## R1. Provider cache break

Риск: изменение старых user/tool carriers может сломать append-only Responses continuation.

Guardrail:

- assistant items не переписывать;
- старый уже отправленный carrier не модифицировать ради нового reminder;
- addressability changes проверять на lifecycle/marathon tests.

## R2. Mutation evidence loss

Риск: слишком агрессивно сжать shell/write output и потерять факт side effect.

Guardrail:

- mutation/unknown classification fail closed;
- command + outcome + known effects сохраняются;
- если безопасный digest не доказан, verbatim fallback.

## R3. Recovery loop

Риск: Gateway сэкономит 20 KB сейчас, но модель потом сделает 3 дополнительных reads.

Guardrail:

- считать recovery calls;
- compact только при deterministic cursor/range/retrieval path;
- benchmark меряет total prompt-work, не один result.

## R4. Journal incompatibility

Риск: изменить block schema и сломать существующие session journals.

Guardrail:

- по возможности не менять persisted v2 schema;
- новые policy metadata делать optional/backward-compatible;
- обязательно journal replay/lifecycle tests.

## R5. Prompt regression

Риск: короткий prompt перестанет заставлять модель выбирать protocol-safe ranges.

Guardrail:

- semantic invariant tests;
- deterministic compression fixtures;
- model eval только как дополнительная проверка, не единственное доказательство.

## R6. Misleading Gateway savings

Риск: `potentialBytesOverBudget` принять за фактическую экономию.

Guardrail:

- telemetry label: `potential`, пока representation=`passthrough`;
- actual savings считать только после реально изменённой delivery representation.

---

## 14. Definition of Done

План считается выполненным только если:

- [x] Все выбранные phases отмечены `[x]`; исключённые имеют `[-]` с объяснением.
- [x] Reference benchmark воспроизводится автоматически/read-only.
- [x] DCP protected-fragment inflation уменьшен ≥50% на representative fixture/reference replay.
- [x] DCP static prompt/tool overhead уменьшен ≥35%.
- [x] DCP compression projection gain не регрессировал.
- [x] Removed DCP config keys больше не игнорируются молча.
- [x] Context Gateway budget semantics class-specific.
- [x] Ни один Gateway enforce path не делает невосстановимую generic truncation.
- [x] Repo native compact сохраняет 100% critical fact coverage.
- [x] Exact read compact delivery не включена: current-file continuation не является snapshot-safe contract.
- [x] Gateway и DCP savings accounting не double-count'ится.
- [x] Focused DCP suite проходит.
- [x] Context Gateway suite проходит.
- [x] `npm run typecheck` проходит.
- [x] `npm test` проходит.
- [x] Финальный Progress log содержит before/after метрики.

---

## 15. Progress log

Новая сессия должна добавлять записи сверху вниз, не стирая предыдущие.

Формат:

```text
YYYY-MM-DD HH:MM — <task IDs>
Status: completed | partial | blocked
Changed:
- file/path — кратко что изменено
Verification:
- command — PASS/FAIL
Metrics:
- before → after
Notes:
- важные наблюдения / follow-up
```

### Entries

2026-09-08 18:45 — host smoke verification

Status: completed

Verification:

- Approved host command `npm run smoke` in `external/pi-tools-suite` —
  **PASS / exit code 0**.
- `smoke:explicit` — PASS (`pong`).
- `smoke:auto` — PASS (`Pong`).
- `smoke:tools` — PASS (`pong`).

Notes:

- Earlier sandbox smoke failure was environment-specific: sandbox execution did
  not have usable Pi provider auth. The exact same package smoke command passed
  outside the sandbox under explicit user approval, so runtime registration is
  now verified in addition to the deterministic suites.

2026-09-08 17:40 — F1-F6/G1-G3/Phase 6 final verification

Status: completed

Changed:

- `src/context-gateway/config.ts` — class-specific budget resolver.
- `src/context-gateway/telemetry.ts` — exact-vs-same-source read attribution,
  applied budget, delivered bytes, enforced results и actual savings.
- `src/context-gateway/enforcement.ts` — selective fail-open enforcement только
  для recognised complete simple test/build output; generic truncation отсутствует.
- `src/context-gateway/index.ts` — настоящий selective `enforce`, honest doctor,
  persisted `contextGateway` representation marker для реально compacted result.
- `test/evals/session-token-efficiency.ts` — split accounting и финальная
  reference projection для continuity summary/carrier/control-plane metrics.

Verification:

- `bun test test/context-gateway` — **96 pass / 0 fail / 610 expect calls**.
- Full DCP regression suite — **190 pass / 0 fail / 46,116 expect calls**.
- `npm run typecheck` — **PASS** после последних source/harness changes.
- `npm test` — **789 pass / 63 skip / 0 fail / 49,745 expect calls**,
  852 tests across 74 files. Skips are opt-in live/model E2E/evals without their
  enabling environment, not deterministic failures.
- `npm run smoke` — **PASS outside sandbox under explicit user approval**:
  `smoke:explicit`, `smoke:auto`, and `smoke:tools` all exited 0. The earlier
  sandbox-only auth failure is superseded by this host verification.

Final metrics:

- Reference provider baseline still reproduces exactly: `56` calls,
  `2,521,842` prompt token-occurrences, `16,534` output, `$2.630094` historical
  cost. No new live provider run was performed, so no fabricated new dollar
  cost is reported.
- Protected continuity: **18,025 → 2,641 chars (−85.3%)**.
- Active persisted-summary projection under new continuity policy:
  **5,918 → 2,072 estimated tokens**.
- Same reference compression therefore projects from historical
  **48,319 → 52,165 net tokens saved/request** (`+3,846`, about `+8.0%`).
- `SYSTEM_PROMPT`: ~`527 → 249` estimated tokens (`−52.8%`).
- `COMPRESS_RANGE_DESCRIPTION`: ~`2,005 → 626` (`−68.8%`).
- Static system + compress tool envelope: ~`2,882 → 1,284` (`−55.4%`).
- TURN/ITERATION nudges: ~`293/252 → 108/103` (`−63.1%/−59.1%`).
- Message-ID carriers on reference-shaped pre-compression projection:
  legacy-equivalent **1,560 → 551 estimated tokens (−64.7%)**.
- Historical Gateway replay under corrected class budgets:
  `5/71` over-budget, `25,612 B` potential excess, but **0 actual ingress bytes
  avoided** because the historical session predates selective enforcement.
- Native repo compact deterministic benchmark: **71,025 → 27,519 delivered
  bytes**, ratio **0.3875** (`−61.25%`), critical facts **8/8 = 100%**,
  refusals `0`, full overrides `0`, continuation calls `1 → 3`.
- Reference post-reduction reads: `1` exact repeat candidate remains
  **unattributed**, `likelyRecoveryTaxReads=0`; the harness deliberately does
  not infer user/verification intent from tool arguments alone.

Safety outcomes:

- Mutation/unknown shell continuity stays fail-closed/verbatim.
- Signed assistant/provider items remain byte-stable and append-only lifecycle
  tests pass.
- Gateway never generic-slices read/repo/unknown results.
- Exact-read compact delivery is intentionally disabled because SDK line
  continuation reads the current file version and huge single-line truncation
  lacks a snapshot-safe continuation boundary.

2026-09-08 17:31 — B6/C1-C5/D1-D4 full DCP verification

Status: completed

Verification:

- Full DCP suite from the plan plus `compress-pruner`, protected-continuity and
  shared shell-policy tests — **190 pass / 0 fail / 46,116 expect calls**.
- Coverage includes marathon restart/replay, strict append-only Responses
  continuation, journal lifecycle, signed assistant byte stability, candidate
  addressability, repeated context transforms and protected roll-ups.

Metrics:

- `SYSTEM_PROMPT`: baseline ~`527` → **249 estimated tokens** (`−52.8%`).
- `COMPRESS_RANGE_DESCRIPTION`: ~`2,005` → **626** (`−68.8%`).
- Static system + compress tool envelope: ~`2,882` → **1,284** estimated
  tokens (`−55.4%`).
- `TURN_NUDGE`: ~`293` → **108** (`−63.1%`).
- `ITERATION_NUDGE`: ~`252` → **103** (`−59.1%`).
- Reference-shaped message-ID carrier overhead: legacy-equivalent `1,560` →
  compact immutable **551 tokens** (`−64.7%`). The original measured session
  sample was `1,492`; estimator/projection membership explains the small
  baseline difference.

Decisions:

- D2 lazy publication is intentionally skipped. Existing strict append-only
  continuation depends on immutable old carriers; the compact syntax clears
  the ≥50% target without moving metadata to a later payload tail.

2026-09-08 17:27 — B1-B5 + E1-E3 verified on reference-shaped data

Status: partial

Changed:

- `src/dcp/protected-continuity.ts` — pruning protection отделена от
  compression continuity; proven inspection/test output получает bounded
  digest, mutation/unknown остаётся fail-closed verbatim.
- `src/shell-command-policy.ts` — shared conservative classifier теперь умеет
  quoted arguments и доказуемые inspection pipelines; temp-only writes в
  `/tmp`/`/private/tmp`/`/dev/null` разрешены только для inspection evidence,
  workspace redirects и dangerous flags fail closed.
- `src/dcp/compression-blocks.ts` — удалён второй verbatim append protected tool
  outputs; continuity ledger остаётся единственным semantic source.
- `src/dcp/config.ts`, `src/dcp/commands.ts` — removed DCP keys дают actionable
  `issues` и видны через `/dcp doctor`.

Verification:

- `bun test test/shell-command-policy.test.ts test/dcp-protected-continuity.test.ts`
  — `11 pass / 0 fail`.
- Broader focused batch по DCP/Gateway/session harness — `91 pass / 0 fail`.
- Reference replay после shell-policy refinement — PASS.

Metrics:

- Protected continuity projection: `18,025 → 2,641 chars` (**−85.3%**).
- Target was at least `−50%`; target exceeded by a wide margin.
- Persisted historical block remains `54,326 → 6,007 / netGain=48,319`
  because source JSONL is read-only and records old behaviour; the analyzer
  projects the new continuity policy separately instead of rewriting history.

Notes:

- Large reference hotspot was a read-only `rg ... > /tmp/...; head ...`
  inspection pipeline. The first classifier treated every compound command as
  unknown; the refined lexer proves only allowlisted inspection pipelines and
  rejects workspace writes, command substitution, `find -delete/-exec`,
  `rg --pre`, mutating git/npm forms, and unsupported syntax.
- B6 remains `[~]` until the complete DCP journal/lifecycle regression suite
  passes, including an explicit failing-test continuity assertion.

2026-09-08 17:22 — A1 reference replay completed

Status: completed

Verification:

- `bun test/evals/run-session-token-efficiency.ts <reference.jsonl>` — PASS.
- Reference provider usage reproduced exactly: `56` assistant calls,
  `194,034` input, `2,327,808` cacheRead, `2,521,842`
  prompt token-occurrences, `16,534` output, `$2.630094` total cost.
- Persisted DCP block reproduced exactly: `54,326 → 6,007`, net gain
  `48,319`, summary estimate `5,918`, `11` protected fragments /
  `18,025` protected chars.
- Tool accounting reproduced: `71` calls/results, `4` errors,
  `1` exact repeated read candidate.

Metrics:

- Phase 0: A1/A2/A3 are now implemented and verified.
- The new replay uses class-specific Gateway budgets, so current diagnostic
  over-budget figures are `5` results / `25,612 B` potential excess rather
  than the old generic-8-KiB `9` / `110,816 B`. This is an intentional metric
  semantics correction, not a claimed delivery saving (`actualBytesSaved=0`).

Notes:

- The replay also exposes before/after projections for later phases; these
  projections are not accepted as completed production changes until their
  source diffs and focused suites are independently verified.

2026-09-08 17:19 — A1/A2/A3 Phase 0 implementation started

Status: partial

Changed:

- `external/pi-tools-suite/src/dcp/compress-tool.ts` — вынесена реальная
  schema `compress` в reusable export без изменения runtime contract.
- `external/pi-tools-suite/test/evals/session-token-efficiency.ts` — добавлен
  read-only deterministic session analyzer: provider usage, DCP journal/block
  metrics, protected fragments, Gateway offline replay, repeated exact reads и
  control-plane accounting.
- `external/pi-tools-suite/test/evals/session-token-efficiency.test.ts` —
  synthetic parser/aggregation + control-plane regression tests.
- `external/pi-tools-suite/test/evals/run-session-token-efficiency.ts` — CLI для
  анализа конкретной JSONL-сессии без её изменения.

Verification:

- Focused pre-change baseline: `42 pass / 0 fail`.
- `bun test test/evals/session-token-efficiency.test.ts` — `2 pass / 0 fail`.
- Первый CLI-запуск на reference session дошёл до запуска, но shell redirect в
  `/tmp` был запрещён sandbox (`Operation not permitted`); это инфраструктурный
  сбой вывода, не failure analyzer-а. Reference numbers ещё нужно подтвердить
  повторным запуском без запрещённого redirect.

Metrics:

- Новый harness уже разделяет `input`, `cacheRead`,
  `input + cacheRead` и DCP estimator/control-plane estimates.
- Control-plane components измеряются отдельно: system prompt, tool
  description, schema и nudges.

Notes:

- A2/A3 завершены на deterministic fixture.
- A1 остаётся `[~]` до воспроизведения reference-session baseline и записи
  фактических чисел в этот файл.

2026-09-08 — PLAN CREATED

Status: completed

Evidence baseline:

- Reference session: `01a08071-9731-729b-a9c2-c7fb2bdb30c7`
- DCP block gain: `48,319 tokens/request`
- Post-compression calls: `27`
- Gross avoided prompt token-occurrences: `1,304,613`
- DCP saved block summary: `5,918 tokens / 23,673 chars`
- Protected fragments: `11 / 18,025 chars`
- Pre-compression ID carrier overhead sample: `1,492 tokens`
- Gateway offline over-budget results: `9/71`
- Gateway generic potential excess: `110,816 bytes`
- Exact duplicate full-read candidates: `1`

---

## 16. Decision log

Добавлять архитектурные решения сюда до/одновременно с реализацией.

| Date | Decision | Reason | Alternatives rejected |
|---|---|---|---|
| 2026-09-08 | Gateway не должен делать generic irreversible truncation | Нет store/retrieval contract; local byte savings может вызвать recovery tax и потерю фактов | `maxResultBytes` как жёсткий post-hoc cap |
| 2026-09-08 | Первым DCP hotspot считать protected shell continuity | 18,025 из 23,673 chars block summary были protected fragments | Сначала оптимизировать thresholds |
| 2026-09-08 | Считать `input + cacheRead` как отдельную context-work metric | Cache tokens дешевле, но занимают окно и повторяются на каждом request | Считать только uncached input |
| 2026-09-08 | Оставить distributed message IDs immutable, но сократить carrier syntax | Compact carrier даёт −64.7% и сохраняет strict append-only Responses continuation | Lazy/on-demand publication с переносом metadata на новый tail |
| 2026-09-08 | Gateway `enforce` — selective semantic policy, не общий byte cap | Доказуемый compact contract есть для recognised complete simple test/build; остальные surfaces должны fail open | Любой result ≤ `maxResultBytes` |
| 2026-09-08 | Не включать post-hoc exact-read compact | SDK offset/limit читает текущую версию, а huge single-line truncation не даёт snapshot-safe line continuation | Тупой `maxExactReadBytes` truncation или pretending current-file range is immutable recovery |
| 2026-09-08 | Repeat reads считать candidates, не автоматически recovery tax | Intent verification/recheck невозможно надёжно вывести из path/range args | Любой post-compression repeat считать regression |

---

## 17. Follow-up for a future session

Основной implementation plan выполнен. Следующая сессия должна начинать не с
повторной реализации, а с review текущего diff и решения о merge/commit boundaries.

Опциональные follow-ups, которые сознательно **не входят** в завершённый scope:

1. Сделать новый real-provider A/B session run, если нужен фактический новый
   dollar-cost вместо deterministic/modelled metrics.
2. Вернуться к exact-read compact только после появления immutable
   snapshot/cursor producer contract.
3. Расширять test/build parser только новыми deterministic format contracts;
   не добавлять generic head/tail truncation.
