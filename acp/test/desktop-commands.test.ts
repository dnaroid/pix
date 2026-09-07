import assert from "node:assert/strict";
import { test } from "node:test";

import {
	PIX_TOOL_RESULT_METHOD,
	parseDesktopToolResultRequest,
} from "../src/acp/desktop-commands.js";

test("desktop tool-result lazy route is session/tool-call scoped and drops arbitrary path-like extras", () => {
	assert.equal(PIX_TOOL_RESULT_METHOD, "pix/session/tool_result");
	assert.deepEqual(parseDesktopToolResultRequest({
		sessionId: "session-1",
		toolCallId: "tool-1",
		path: "/tmp/pi-bash-not-a-route.log",
		fullOutputPath: "/tmp/pi-ast-grep-not-a-route/output.txt",
	}), {
		sessionId: "session-1",
		toolCallId: "tool-1",
	});
	assert.throws(() => parseDesktopToolResultRequest({ sessionId: "session-1", toolCallId: "" }));
	assert.throws(() => parseDesktopToolResultRequest({ toolCallId: "tool-1" }));
});
