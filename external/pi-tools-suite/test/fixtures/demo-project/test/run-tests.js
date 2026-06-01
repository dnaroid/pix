import assert from "node:assert/strict";

// Minimal smoke test fixture. E2E agents may inspect or run this script.
const items = [{ sku: "book", quantity: 2, unitPriceCents: 1500 }];
const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
assert.equal(subtotal, 3000);
console.log("fixture smoke ok");
