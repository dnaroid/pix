// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";

import { refreshSession } from "../src/session.js";

test("refreshSession performs one token-load attempt", async () => {
  let attempts = 0;
  await assert.rejects(
    refreshSession(async () => {
      attempts += 1;
      throw new Error("transient");
    }),
    /transient/,
  );
  assert.equal(attempts, 1);
});
