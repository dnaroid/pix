// Conservative reader for the native drain receipt. A process exit alone
// (including bridge code 143) is not proof that descendants were drained.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface OwnedLaunchReceipt {
	status: "ok" | "fail" | "retry";
	cause: string;
	/** Only true after a durable, boot-bound journal and a kernel-zero oracle. */
	contained: boolean;
	payloadCode: number | null;
}

export function readOwnedLaunchReceipt(runDir: string): OwnedLaunchReceipt | null {
	let raw: string;
	let journal: string;
	try {
		raw = readFileSync(join(runDir, "drain.json"), "utf8");
		journal = readFileSync(join(runDir, "owned.json"), "utf8");
	} catch { return null; }
	const fields = /^role=drain status=(ok|fail|retry) cause=([a-z_-]+) boot=(\d+\.\d{6}) cid=([0-9a-f]+) sup_cid=[0-9a-f]+ started=(\d+) exited=(\d+) esrch=([01]) signaled=\d+ iterations=\d+ mismatch=\d+ payload_code=(-?\d+) at=\d+(?: note=[a-z_-]+)?\n$/.exec(raw);
	const birth = /^role=owned boot=(\d+\.\d{6}) cid=([0-9a-f]+) worker_pid=\d+ worker_pidversion=\d+ worker_token=[0-9a-f]{64} journaled_at=\d+\n$/.exec(journal);
	if (!fields || !birth) return null;
	const [, status, cause, boot, cid, started, exited, esrch, payloadCode] = fields;
	const code = Number(payloadCode);
	const zero = (esrch === "0" && BigInt(started) === BigInt(exited)) || esrch === "1";
	return {
		status: status as OwnedLaunchReceipt["status"], cause,
		contained: status === "ok" && birth[1] === boot && birth[2] === cid && zero &&
			(!["natural", "leader_exit"].includes(cause) || (code >= 0 && code <= 255)),
		payloadCode: Number.isInteger(code) && code >= 0 && code <= 255 ? code : null,
	};
}
