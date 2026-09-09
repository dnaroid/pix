# Spec Wiki

> Generated routing index. Primary specs remain the source of truth.
> Prefer `spec_wiki.py search <query>` for retrieval; `fresh` exists only after explicit semantic verification.

> 2 current/proposed primary spec(s) are indexed but not semantically verified yet.

## Current / proposed primary specs

- **Payment capture requirements** — `requirements/payment-behavior.md` · as-is/active · **unverified** · capture,idempotency,payments — Payment capture idempotency contract: a capture with the same idempotency key must not charge twice, exact replay returns the existing capture result, and a reused key with a diff…
- **RFC 007 — Payment timeout contract** — `architecture/rfc-007.md` · change/proposed · **unverified** · error-handling,payments,timeout — Intended payment capture timeout contract: capture requests time out after 10 seconds and return a retryable timeout error without claiming the payment failed at the provider; pro…
