import OggAudioWorker from "./ogg-audio.worker?worker";

const queue: Array<() => void> = [];
let running = false;

function drain(): void {
  if (running) return;
  queue.shift()?.();
}

export function isOggAudioPath(path: string): boolean {
  return /\.(?:ogg|oga|opus)$/i.test(path);
}

/** Serialize fallback work; cancellation also removes queued jobs before they allocate a worker. */
export function decodeOggSource(source: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    let settled = false;
    function finish(error?: Error, wav?: ArrayBuffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker?.terminate();
      const index = queue.indexOf(start);
      if (index >= 0) queue.splice(index, 1);
      if (started) running = false;
      try {
        if (error) reject(error);
        else if (wav) resolve(URL.createObjectURL(new Blob([wav], { type: "audio/wav" })));
        else reject(new Error("Ogg decoder returned no audio."));
      } catch (failure) { reject(failure); }
      finally { drain(); }
    }
    function abort(): void { finish(new DOMException("Aborted", "AbortError")); }
    function start(): void {
      started = true;
      running = true;
      try {
        worker = new OggAudioWorker();
        timer = setTimeout(() => finish(new Error("Ogg audio decoding timed out.")), 30000);
        worker.onerror = (event) => { event.preventDefault(); finish(new Error("Ogg audio decoder could not start.")); };
        worker.onmessageerror = () => finish(new Error("Ogg audio decoder returned an unreadable message."));
        worker.onmessage = (event: MessageEvent<{ wav?: ArrayBuffer; error?: string }>) => {
          finish(event.data.error ? new Error(event.data.error) : undefined, event.data.wav);
        };
        worker.postMessage(source);
      } catch { finish(new Error("Ogg audio decoder could not start.")); }
    }
    signal.addEventListener("abort", abort, { once: true });
    queue.push(start);
    drain();
  });
}
