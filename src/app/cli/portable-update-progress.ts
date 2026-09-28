type ProgressOutput = { write(text: string): unknown; isTTY?: boolean };

/** Keep long update phases visible without emitting a stream of frames into logs. */
export function createPortableUpdateProgress(output: ProgressOutput = process.stderr): {
	stage: (message: string) => void;
	stop: () => void;
} {
	const frames = ["|", "/", "-", "\\"];
	let message = "";
	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	return {
		stage(next) {
			message = next;
			if (output.isTTY) {
				output.write(`\r\x1b[2K${frames[frame++ % frames.length]} ${message}`);
				if (!timer) {
					timer = setInterval(() => output.write(`\r\x1b[2K${frames[frame++ % frames.length]} ${message}`), 120);
					timer.unref();
				}
			} else {
				output.write(`${message}\n`);
			}
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = undefined;
			if (message && output.isTTY) output.write("\r\x1b[2K");
			message = "";
		},
	};
}
