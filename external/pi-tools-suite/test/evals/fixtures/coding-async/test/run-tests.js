// @ts-nocheck
import assert from "node:assert/strict";
import { ProfileLoader } from "../src/profile-loader.js";

const pending = new Map();
const loader = new ProfileLoader((id) => new Promise((resolve) => pending.set(id, resolve)));
const first = loader.load("old");
const second = loader.load("new");
pending.get("new")({ id: "new" });
await second;
pending.get("old")({ id: "old" });
await first;
assert.equal(loader.current.id, "new", "a stale earlier request must not overwrite the latest profile");
console.log("stale async state protected");
