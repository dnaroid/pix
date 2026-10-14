import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Logs sidebar preference is optional and disabled by default", () => {
  const desktop = PixDesktopConfigSchema.properties.desktop;
  assert.equal((desktop.properties.logPanelEnabled as { default?: boolean }).default, false);
  assert.equal(desktop.properties.logPanelEnabled.type, "boolean");
  for (const config of [{}, { desktop: {} }, { desktop: { logPanelEnabled: false } }, { desktop: { logPanelEnabled: true } }]) {
    assert.equal(Value.Check(PixDesktopConfigSchema, config), true);
  }
  assert.equal(Value.Check(PixDesktopConfigSchema, { desktop: { logPanelEnabled: "true" } }), false);
});
