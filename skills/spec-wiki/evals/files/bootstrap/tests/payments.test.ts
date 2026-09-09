// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";

import { capture } from "../src/payments.js";

test("idempotent replay returns the same capture", () => {
  const first = capture("key-1", 100);
  assert.deepEqual(capture("key-1", 100), first);
  assert.throws(() => capture("key-1", 200), /idempotency conflict/);
});
