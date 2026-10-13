import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "../src/greeting.mjs";

test("default greeting", () => assert.equal(greeting(), "Hello, QA!"));
test("Cyrillic greeting", () => assert.equal(greeting("Тест"), "Hello, Тест!"));
