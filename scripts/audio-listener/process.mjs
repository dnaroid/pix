import { spawn } from "node:child_process";

// Resolve only after close: cleanup must never race a child still writing audio.
export function runProcess(command, args, { signal, timeout = 60000, input = "", onRecording } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
        let stdout = "", stderr = "", bytes = 0, failure, escalation;
        const kill = (name) => {
            if (!child.pid) return;
            try { process.kill(-child.pid, name); } catch (error) {
                if (error.code !== "ESRCH") child.kill(name);
            }
        };
        const stop = (error) => {
            if (failure) return;
            failure = error;
            kill("SIGTERM");
            escalation = setTimeout(() => kill("SIGKILL"), 1000);
        };
        const abort = () => stop(new Error("Listener cancelled"));
        const timer = setTimeout(() => stop(new Error("Listener stage timed out")), timeout);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdin.on("error", () => {}); // Early exit may close stdin before the consent write.
        child.stdin.end(input);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (data) => {
            bytes += Buffer.byteLength(data);
            if (bytes > 1024 * 1024) stop(new Error("Listener output limit exceeded"));
            else stdout += data;
        });
        child.stderr.on("data", (data) => {
            if (stderr.length >= 8192) return;
            stderr += data;
            if (stderr.includes("RECORDING DEFAULT MICROPHONE INPUT")) {
                try { onRecording?.(); } catch { stop(new Error("Listener progress delivery failed")); }
                onRecording = undefined;
            }
        });
        child.on("error", () => { failure ??= new Error("Listener executable could not start"); });
        child.on("close", (code) => {
            clearTimeout(timer);
            clearTimeout(escalation);
            signal?.removeEventListener("abort", abort);
            if (failure) reject(failure);
            else if (code !== 0) reject(new Error(`Listener process failed (exit ${code ?? "signal"})`));
            else resolve(stdout);
        });
    });
}

// ACP hosts may ignore the dialog's signal option. A late answer must not record.
export function waitForConsent(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(new Error("Listener cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
    });
}
