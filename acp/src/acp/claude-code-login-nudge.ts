import { spawn } from "node:child_process";

/**
 * Best-effort bound for the headless Claude Code login nudge. The CLI may run
 * an actual model round trip, so the bound is generous; on expiry the child is
 * terminated and the caller still proceeds with its credential reread.
 */
export const CLAUDE_LOGIN_NUDGE_TIMEOUT_MS = 120_000;
/** Grace between SIGTERM and the unignorable SIGKILL escalation. */
export const CLAUDE_LOGIN_NUDGE_KILL_GRACE_MS = 5_000;

/**
 * Ordinary host variables the restricted Claude child environment keeps. In
 * particular no Pi provider credential (`ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, …) is ever forwarded, so
 * the nudge can observe only Claude Code's own stored login.
 */
const CLAUDE_CHILD_ALLOWED_ENV = new Set([
	"CLAUDE_CONFIG_DIR",
	"HOME",
	"LANG",
	"LC_ALL",
	"LOGNAME",
	"PATH",
	"SHELL",
	"TERM",
	"TERM_PROGRAM",
	"TMPDIR",
	"TZ",
	"USER",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
]);

export function restrictedClaudeChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const restricted: NodeJS.ProcessEnv = {};
	for (const name of CLAUDE_CHILD_ALLOWED_ENV) {
		const value = env[name];
		if (typeof value === "string" && value.length > 0) restricted[name] = value;
	}
	return restricted;
}

export interface ClaudeCodeLoginNudgeOptions {
	/** Executable to launch; fixed to the Claude CLI, never a shell. */
	readonly command?: string;
	/**
	 * Headless query arguments. Official docs only guarantee `-p` (print /
	 * headless) queries; the prompt content is best-effort and its output is
	 * never captured or parsed.
	 */
	readonly args?: readonly string[];
	readonly timeoutMs?: number;
	readonly killGraceMs?: number;
	readonly env?: NodeJS.ProcessEnv;
	/** Test seam for the process boundary; defaults to `child_process.spawn`. */
	readonly spawnImpl?: typeof spawn;
}

/**
 * Launch the Claude CLI headless purely so Claude Code can refresh its own
 * login state (e.g. a best-effort `-p '/usage'` query). Resolves `true` when
 * a child was spawned and reached any bounded exit, `false` when it could not
 * be launched at all. Output is never captured, never parsed, and never
 * exposed: Claude CLI output shape is version-dependent and undocumented for
 * headless quota queries, so callers must reread the local credential and
 * their normal quota endpoint after this resolves instead of scraping stdout.
 */
export function launchClaudeCodeLoginNudge(options: ClaudeCodeLoginNudgeOptions = {}): Promise<boolean> {
	const {
		command = "claude",
		args = ["-p", "/usage"],
		timeoutMs = CLAUDE_LOGIN_NUDGE_TIMEOUT_MS,
		killGraceMs = CLAUDE_LOGIN_NUDGE_KILL_GRACE_MS,
		env = restrictedClaudeChildEnv(),
		spawnImpl = spawn,
	} = options;

	return new Promise<boolean>((resolve) => {
		let settled = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (launched: boolean): void => {
			if (settled) return;
			settled = true;
			if (killTimer !== undefined) clearTimeout(killTimer);
			if (graceTimer !== undefined) clearTimeout(graceTimer);
			resolve(launched);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawnImpl(command, [...args], {
				env,
				// Never capture child output: no scraping, no exposure.
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			finish(false);
			return;
		}
		child.on("error", () => finish(false));
		child.on("close", () => finish(true));

		killTimer = setTimeout(() => {
			// Terminate first, then escalate. Complete the request even if a
			// broken process wrapper never delivers a close event after SIGKILL.
			try {
				child.kill("SIGTERM");
			} catch {
				/* already gone */
			}
			graceTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
				finish(true);
			}, killGraceMs);
		}, timeoutMs);
	});
}
