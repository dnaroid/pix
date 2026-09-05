// @ts-nocheck
import assert from "node:assert/strict";
import { discountedPrice } from "../src/discount.js";

assert.equal(discountedPrice(1000, 15), 850);
assert.equal(discountedPrice(999, 0), 999);
assert.equal(discountedPrice(1998, 25), 1498, "final discounted price must be floored");
assert.throws(() => discountedPrice(1000, 101), RangeError);
console.log("discount behavior ok");
