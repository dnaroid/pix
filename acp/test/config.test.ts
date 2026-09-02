import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterConfigFromEnv, resolveAdapterConfig } from "../src/config.js";
import { createLogger, parseLogLevel } from "../src/logging.js";

test("resolveAdapterConfig applies defaults", () => {
	const config = resolveAdapterConfig({});
	assert.equal(config.piBinary, "pi");
	assert.equal(config.logLevel, "info");
});

test("resolveAdapterConfig trims and keeps explicit values", () => {
	const config = resolveAdapterConfig({ piBinary: "  /usr/local/bin/pi  ", logLevel: "debug" });
	assert.equal(config.piBinary, "/usr/local/bin/pi");
	assert.equal(config.logLevel, "debug");
});

test("resolveAdapterConfig falls back on blank piBinary", () => {
	assert.equal(resolveAdapterConfig({ piBinary: "   " }).piBinary, "pi");
});

test("parseLogLevel rejects unknown levels", () => {
	assert.equal(parseLogLevel("noisy"), "info");
	assert.equal(parseLogLevel(undefined), "info");
	assert.equal(parseLogLevel("warn"), "warn");
});

test("adapterConfigFromEnv reads environment", () => {
	const config = adapterConfigFromEnv({
		PIX_ACP_PI_BIN: "/opt/pi/bin/pi",
		PIX_ACP_LOG: "warn",
	} as NodeJS.ProcessEnv);
	assert.equal(config.piBinary, "/opt/pi/bin/pi");
	assert.equal(config.logLevel, "warn");
});

test("logger writes only above threshold", () => {
	const lines: string[] = [];
	const logger = createLogger("warn", (line) => lines.push(line));
	logger.debug("hidden");
	logger.info("hidden");
	logger.warn("shown");
	logger.error("also shown");
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /\[pix-acp\] \[warn\] shown/);
	assert.match(lines[1]!, /\[pix-acp\] \[error\] also shown/);
});
