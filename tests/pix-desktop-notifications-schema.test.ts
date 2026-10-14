import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Desktop notification mode is optional, remains native by default, and matches the shipped schema", () => {
  for (const config of [
    {},
    { desktop: {} },
    { desktop: { notifications: { enabled: true } } },
    { desktop: { notifications: { enabled: false, usePix: true } } },
    { desktop: { notifications: { enabled: true, usePix: false } } },
  ]) {
    assert.equal(Value.Check(PixDesktopConfigSchema, config), true);
  }
  assert.equal(Value.Check(PixDesktopConfigSchema,
    { desktop: { notifications: { usePix: "true" } } },
  ), false);
  const property = PixDesktopConfigSchema.properties.desktop.properties.notifications;
  assert.equal(property.properties.enabled.default, true);
  assert.equal(property.properties.usePix.default, false);
  const schema = JSON.parse(readFileSync(new URL("../schemas/pix-desktop.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.desktop.properties.notifications, JSON.parse(JSON.stringify(property)));
});
