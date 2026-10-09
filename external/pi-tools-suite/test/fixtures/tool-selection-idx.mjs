#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(), ".pi", "idx-events.jsonl"), JSON.stringify({ args }) + "\n");
const command = args[0] || "";
const joined = args.join(" ").toLowerCase();
if (command === "context" && /shipment|freeze/.test(joined)) {
  console.log("CONTEXT query=shipment freeze behavior\nWarnings:\n! No primary knowledge matched the query.\nRead next:\n> src/payments.ts");
} else if (command === "context") {
  if (fs.existsSync("specs/payment-retry.md")) console.log("Primary knowledge:\nS specs/payment-retry.md status=fresh lifecycle=active score=9.10");
  console.log("CONTEXT query=payment retry idempotency\nImplementation:\nC src/payments.ts:19-33 reason=semantic\nTests:\nT test/run-tests.js reason=explicit conf=high");
} else if (command === "audit") {
  if (joined.includes("src/audit.ts")) {
    console.log("changed: 1 | known affected: 0 | uncovered: 1 | changed docs: 0 | semantic sweep: yes\n  uncovered src/audit.ts\n  candidates src/audit.ts: specs/payment-retry.md");
  } else if (joined.includes("retry-contract.md")) {
    console.log("changed: 2 | known affected: 0 | uncovered: 0 | changed docs: 1 | semantic sweep: yes\n  missing specs/payment-retry.md\n  doc specs/payments/retry-contract.md — unclassified — score=8 spec-candidate");
  } else {
    console.log("changed: 1 | known affected: 1 | uncovered: 0 | changed docs: 0 | semantic sweep: yes\n  known specs/payment-retry.md — inputs-changed — src/payments.ts");
  }
} else if (command === "search") {
  const domain = args[args.indexOf("--domain") + 1];
  if (domain !== "document") {
    console.log("src/payments.ts:19-33 (score: 0.91, rank=1, domain=code)");
    if (args.includes("--include-content")) console.log("Content: 1 lines\nbuildPaymentRequest creates a fresh random idempotencyKey on every request.");
  } else if (fs.existsSync("specs/payment-retry.md") && !/shipment|freeze/.test(joined)) {
    console.log("specs/payment-retry.md:1-21 (score: 0.85, rank=1, domain=document)");
  }
} else if (command === "architecture") {
  console.log("Checkout Service (README.md)\nModules:\n- src/cart.ts: checkout cart totals\n- src/discounts.ts: coupon logic\n- src/payments.ts: checkout gateway payment request construction\n- src/audit.ts: checkout audit events\n- docs/checkout-plan.md: proposed rollout plan\nTests: test/run-tests.js\nDependency edges: not available in this fixture index; read sources to verify wiring.");
} else if (command === "structure") {
  console.log("src/payments.ts — function buildPaymentRequest:19-33; src/cart.ts; src/discounts.ts; src/audit.ts");
} else if (command === "explain" || command === "deps" || command === "ast") {
  console.log("src/payments.ts::buildPaymentRequest handles cardToken, amountCents, and idempotencyKey.");
} else if (command === "knowledge" && args[1] === "dirty") {
  console.log(fs.existsSync(".pi/knowledge-reviewed") ? "no" : "yes");
} else if (command === "knowledge" && args[1] === "acknowledge") {
  if (args.length < 3 || args.slice(2).some(file => !fs.existsSync(file))) {
    console.error("acknowledge requires existing spec paths");
    process.exitCode = 1;
  } else {
    fs.writeFileSync(".pi/knowledge-reviewed", JSON.stringify(args.slice(2)));
    console.log("Acknowledged " + args.slice(2).join(", "));
  }
} else {
  console.error("unsupported fake idx command: " + command);
  process.exitCode = 1;
}
