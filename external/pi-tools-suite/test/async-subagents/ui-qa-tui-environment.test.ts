import { expect, test } from "bun:test";
import { launchEnvironment } from "../../src/async-subagents/agents/ui-qa/backends/tui.mjs";

test("TUI launches preserve OS user identity without forwarding ambient credentials", () => {
	const inherited = {
		PATH: "/usr/bin", HOME: "/Users/tester", USER: "tester", LOGNAME: "tester",
		TMPDIR: "/tmp/tester", ANTHROPIC_API_KEY: "must-not-leak",
		CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak", NODE_OPTIONS: "--require=untrusted",
		PI_DEBUG_PROMPT: "1",
		UNRELATED: "must-not-leak",
	};
	expect(launchEnvironment({}, inherited)).toEqual({
		PATH: "/usr/bin", HOME: "/Users/tester", USER: "tester", LOGNAME: "tester",
		TMPDIR: "/tmp/tester", TERM: "xterm-256color", PI_UI_QA: "1",
	});
});

test("TUI launches do not invent absent user identity", () => {
	expect(launchEnvironment({}, { PATH: "/bin" })).toEqual({
		PATH: "/bin", TERM: "xterm-256color", PI_UI_QA: "1",
	});
});

test("TUI launches retain validated flow environment overrides", () => {
	expect(launchEnvironment({ LANG: "en_US.UTF-8", TERM: "vt100" }, { USER: "tester" })).toEqual({
		USER: "tester", LANG: "en_US.UTF-8", TERM: "vt100", PI_UI_QA: "1",
	});
});
