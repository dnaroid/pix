import fs from "node:fs";
import path from "node:path";

// Both development cache and release compilation use the same closed source set.
export function macosHelperSources(source) {
	const sources = path.basename(source) === "macos-accessibility.swift"
		? [source, ...["textedit-lease.swift", "textedit-supervisor.swift"].map((name) => path.join(path.dirname(source), name))]
		: [source];
	for (const file of sources) {
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`macOS helper source must be a regular file: ${file}`);
	}
	return sources;
}
