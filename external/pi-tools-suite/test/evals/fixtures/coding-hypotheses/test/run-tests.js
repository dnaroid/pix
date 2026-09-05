// @ts-nocheck
import assert from "node:assert/strict";
import { resetRetryKeys, retryKeyFor } from "../src/retry.js";

resetRetryKeys();
assert.equal(retryKeyFor("u1", "checkout-a"), "u1:checkout-a");
assert.equal(retryKeyFor("u1", "checkout-b"), "u1:checkout-b", "different checkouts for one user need different retry keys");
console.log("retry-key behavior ok");
