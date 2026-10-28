# Disposition раунда 5

Сохранённый [draft-proposal.md](draft-proposal.md) не изменён. Итог: [proposal.md](proposal.md); [discussion.md](discussion.md).
Ни один участник не обнаружил blocking correction для архитектурного обсуждения; это не implementation approval или эмпирическая валидация.

## Принято
- P1-S1: §§6–7,10,12 capability boundary: strong freshness/resolution только known complete inputs/controlled snapshot; opaque LSP diagnostic producer-limited. Hidden-dependency test не предполагает уже существующей capability.
- P1-S2 + P3-S1 (major): computation/publication разделены. Debounce coalesces/invalidates, no active-turn computation первой auto-фазы. Manual/completed settlement запускает checks; newer active request подавляет automatic delivery. Failed/aborted candidates pending. Speculative precompute deferred.
- P1-S3: снято absolute cross-producer LSP dedup; same adapter identity no-repeat, independent overlaps с provenance/limitations.
- P1-S4: M/A/X phase tags; manual pilot не зависит от collector/watcher/reconciliation/composer.
- P3-S2 (major): conditional clean-at-start HEAD/index baseline восстановлен. Chosen-reference clean check, trust, identity/movement; P1-K2 atomicity/concurrent-writer objection сохранён. Git behaviour unverified, no Git MVP.
- P3-S3: manual detection gate не валидирует continuous delivery; отдельный live gate. Collector-first сохранён как реальный critical-path/coverage/lifecycle trade-off.
- P3-S4: periodic reminder rejected-by-default, only opt-in experimental arm; не no-feature control.
- P3-S5: measured delta needs stored comparable snapshot (например prior /health); first post-edit read state-only.
- P3-S6 + P2-X4: corpus source/generation honest: supplied/selected versions/fix pairs/hand-crafted illustrative fixtures; faithful mid-edit capture open. Lab Git execution separately consented, not performed; label/adjudication/sample size thresholds to agree.
- P3-S7: nudge не collector/MVP; собственные approval/critical-path latency budget, verification may wait; no retroactive result injection.
- P2-X2: no-feature comparator explicit также для live gate, не слабое «полезнее LSP».
- P2-X3: stale digest disables/revalidates composer insertion, user-text/session guards, no auto-send/continuation.
- P2-X6/P3-R2: withdrawn unproven history-precision upper bound; domain shift retained.
- P2-X7: ast_apply changedFiles vs comment hunk-extraction distinction сохранено.

## Частично принято
- P2-X5: conservative state-only automatic summary при known co-runtimes и stored comparable snapshot prerequisite приняты. Single registered runtime НЕ exclusive writer proof и НЕ необходимое условие honest manual snapshot delta: registry не видит editors/shell. Manual comparable delta with unknown authorship допустим (P1-R4). No new broker/registry for MVP. P2-E1/P3-H1 preference остаётся видимой.

## Оставлено открытым / без изменений
- P2-X1/X8/X9/X10 подтверждают factology/minority preservation; taxonomy substance присутствует. No blockers не implementation approval.
- P1-R1/P2-R1/P3-R1: manual-first — parent choice, collector-first — реальная альтернатива, не fabricated consensus.
- P2-D1: live gate для suite/default-on/continuous delivery; rule acceptance может остаться project-only.
- P3-F1: Git config/fsmonitor/filter/index-lock safety hypotheses unverified; suggested flags не sandbox proof.
- P1-R4 vs P2-E1/P3-H1: residual mixed-writer presentation preference сохранён.
- E obligations/project ratchet without runtime/null arm — самостоятельные допустимые исходы.

## Редактура и границы
Статус обновлён на completed five rounds; ссылки source files относительно run directory исправлены; preserved draft не изменён. Финальный текст уплотнён без смены выбранной архитектуры; reviewer-requested capability/scheduling/comparator/provenance/test boundaries сохранены.
Не выполнено: product/spec/test edits, installs, tests, runtime pilot/benchmarks, actual capture, Git hardening investigation, ADR. Нет implementation approval; future source egress/continuation требует собственного согласия. До следующего этапа согласовать §12 и acceptance thresholds.
