// SDK disk APIs are synchronous. This isolated manager must never be the source runtime's manager.
import { parentPort, workerData } from "node:worker_threads";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let childPath;
try {
	const { sessionPath, leafId, cwd, unflushedEntries } = workerData;
	const manager = leafId === null || unflushedEntries
		? SessionManager.create(cwd, dirname(sessionPath))
		: SessionManager.open(sessionPath);
	let capturedEntries;
	if (unflushedEntries && leafId !== null) {
		const snapshot = SessionManager.inMemory(cwd, undefined, [manager.getHeader(), ...unflushedEntries]);
		snapshot.createBranchedSession(leafId);
		capturedEntries = snapshot.getEntries();
	}
	childPath = leafId === null || unflushedEntries ? manager.getSessionFile() : manager.createBranchedSession(leafId);
	if (!childPath) throw new Error("fork requires a persistent session");
	// The SDK defers flushing metadata-only sessions. A child must be loadable before notification.
	if (!existsSync(childPath)) {
		mkdirSync(dirname(childPath), { recursive: true });
		writeFileSync(childPath, [
			{ ...manager.getHeader(), parentSession: sessionPath }, ...(capturedEntries ?? manager.getEntries()),
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { encoding: "utf8", flag: "wx" });
	}
	parentPort.postMessage({ child: { sessionPath: childPath, piSessionId: manager.getSessionId() } });
} catch (error) {
	if (childPath) rmSync(childPath, { force: true });
	parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
} finally {
	parentPort.close();
}
