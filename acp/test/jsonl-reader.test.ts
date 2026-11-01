import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { attachJsonlReader } from "../src/pi/jsonl-reader.js";

function fixture() {
	const stream = new Readable({ read() {} });
	const lines: string[] = [];
	const dispose = attachJsonlReader(stream, (line) => lines.push(line));
	return { stream, lines, dispose };
}

test("JSONL preserves Unicode, CRLF, blank records and an unterminated tail at every byte boundary", () => {
	const input = Buffer.from('Привет 😀\u2028\u2029\rinside\r\n\n{"data":"a\\nb"}\ntail');
	for (let split = 0; split <= input.length; split++) {
		const { stream, lines } = fixture();
		stream.emit("data", input.subarray(0, split));
		stream.emit("data", input.subarray(split));
		stream.emit("end");
		assert.deepEqual(lines, ["Привет 😀\u2028\u2029\rinside", "", '{"data":"a\\nb"}', "tail"]);
		assert.equal(stream.listenerCount("data"), 0);
		assert.equal(stream.listenerCount("end"), 0);
		assert.equal(stream.listenerCount("close"), 0);
	}
});

test("JSONL handles decoded strings and flushes an incomplete UTF-8 tail exactly once", () => {
	const { stream, lines } = fixture();
	stream.emit("data", "one\nsecond\r");
	stream.emit("data", "\n");
	stream.emit("data", Buffer.from([0xe2, 0x82]));
	stream.emit("end");
	stream.emit("end");
	assert.deepEqual(lines, ["one", "second", "\ufffd"]);
});

test("JSONL scans only incoming chunks, not the accumulated large record", () => {
	const { stream, lines, dispose } = fixture();
	const chunk = "a".repeat(4096);
	const count = 128;
	let scanned = 0;
	const original = String.prototype.indexOf;
	// Synchronous instrumentation, restored before assertions or any async work.
	// A growing-buffer reader scans count*(count+1)/2 chunks here.
	String.prototype.indexOf = function (search, offset = 0) {
		if (search === "\n") scanned += this.length - offset;
		return original.call(this, search, offset);
	};
	try {
		for (let i = 0; i < count; i++) stream.emit("data", chunk);
		stream.emit("data", "\n");
	} finally {
		String.prototype.indexOf = original;
		dispose();
	}
	assert.equal(scanned, count * chunk.length + 1);
	assert.deepEqual(lines, [chunk.repeat(count)]);
});

test("dispose and premature close discard a partial record without removing other listeners", () => {
	for (const close of [false, true]) {
		const { stream, lines, dispose } = fixture();
		const unrelated = () => {};
		stream.on("data", unrelated);
		stream.emit("data", "unfinished");
		if (close) stream.emit("close");
		else dispose();
		dispose();
		stream.emit("data", " tail\n");
		stream.emit("end");
		assert.deepEqual(lines, []);
		assert.deepEqual(stream.listeners("data"), [unrelated]);
		assert.equal(stream.listenerCount("end"), 0);
		assert.equal(stream.listenerCount("close"), 0);
	}
});

test("disposing inside a callback suppresses remaining records in the same chunk", () => {
	const stream = new Readable({ read() {} });
	const lines: string[] = [];
	const dispose = attachJsonlReader(stream, (line) => { lines.push(line); dispose(); });
	stream.emit("data", "first\nsecond\ntail");
	stream.emit("end");
	assert.deepEqual(lines, ["first"]);
});
