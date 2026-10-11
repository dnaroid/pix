# Historical delivery-review harness

The live runner and its dedicated tests were removed when the bundled
`delivery-review` role was retired. See [RESULTS.md](RESULTS.md) for retained
historical evidence; those results do not validate the current role pool.
Current readiness evidence review uses `research`; the parent makes the
readiness decision.

The retained fixtures and assertion helpers preserve the historical checks for
grounded risks, fixture immutability, conservative tool use, and readiness
confidence. Their deterministic tests remain runnable from
`external/pi-tools-suite`:

```sh
bun test test/evals/delivery-review/assertions.test.ts
```

There is no current delivery-review live command. Current delegation selection
evals are documented in [docs/evals.md](../../../docs/evals.md).
