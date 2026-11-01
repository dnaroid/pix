import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** LF-only framing: scan each decoded chunk once, join only complete records. */
export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let parts: string[] = [];
	let disposed = false;

	const dispose = () => {
		disposed = true;
		parts = [];
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("close", dispose);
	};
	const emit = () => {
		const line = parts.join("");
		// Release the accumulated record before calling potentially reentrant code.
		parts = [];
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};
	const consume = (text: string) => {
		let offset = 0;
		while (!disposed) {
			const newline = text.indexOf("\n", offset);
			if (newline < 0) {
				if (offset < text.length) parts.push(text.slice(offset));
				return;
			}
			parts.push(text.slice(offset, newline));
			emit();
			offset = newline + 1;
		}
	};
	const onData = (chunk: Buffer | string) => {
		if (!disposed) consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
	};
	const onEnd = () => {
		if (disposed) return;
		consume(decoder.end());
		if (!disposed && parts.length > 0) emit();
		dispose();
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	stream.on("close", dispose);
	return dispose;
}
