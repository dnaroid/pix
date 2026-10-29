import { FileMentionIndex } from "../../file-mention-index.js";
import { FileMentionSearch } from "../../file-mention-search.js";
import { fileMentionQuery, insertFileMention, type FileMentionMatch } from "../../file-mentions.js";
import type { InputEditor } from "../../input-editor.js";
import { PopupMenu } from "../../ui.js";
import type { PixMenuItem } from "../types.js";

export class AppFileMentionsController {
	readonly menu = new PopupMenu<PixMenuItem<unknown>>({ maxVisibleRows: 8 });
	private readonly index = new FileMentionIndex();
	private key = "";
	private dismissed = "";
	private syncing = false;
	private matches: FileMentionMatch[] = [];
	private readonly search = new FileMentionSearch((query, signal) => this.index.query(this.cwd(), query, signal), (matches, loading, failed) => {
		this.matches = matches;
		this.menu.openWithItems(matches.length ? matches.map((match) => ({
			label: match.path, description: match.directory ? "folder" : "file",
			value: { label: match.path, value: match.path },
		})) : [{ label: loading ? "Searching project…" : failed ? "File search unavailable — Esc to close" : "No matching paths — Esc to close", value: { label: "", value: undefined } }]);
		if (!this.syncing) this.render();
	});

	constructor(private readonly editor: () => InputEditor, private readonly cwd: () => string,
		private readonly context: () => string, private readonly render: () => void) {}

	private observe(key: string, query: string): void {
		// sync is called during the outer render; its loading update needs no nested render.
		this.syncing = true;
		try { this.search.observe(key, query); }
		finally { this.syncing = false; }
	}

	sync(enabled: boolean): boolean {
		const editor = this.editor();
		const key = `${this.cwd()}\0${this.context()}\0${editor.text}\0${editor.cursor}\0${editor.hasSelection}`;
		const query = enabled && !editor.hasSelection ? fileMentionQuery(editor.text, editor.cursor) : undefined;
		if (!query || this.dismissed === key) {
			this.key = ""; this.observe("", ""); this.menu.close(); return false;
		}
		if (this.key !== key) {
			this.key = key;
			this.observe(key, query.query);
		}
		return true;
	}

	accept(): boolean {
		const editor = this.editor();
		const query = fileMentionQuery(editor.text, editor.cursor);
		const path = this.menu.selectedItem()?.value.value;
		if (!query || typeof path !== "string" || !this.matches.some((match) => match.path === path)) return true;
		const insertion = insertFileMention(editor.text, query, path);
		this.dismiss();
		// insert replaces only the mention; attachments and undo history remain owned by the editor.
		for (let offset = query.end; offset > query.start; offset--) editor.moveLeftExtend();
		editor.insert(insertion.text.slice(query.start, insertion.cursor));
		this.render();
		return true;
	}

	dismiss(): void { this.dismissed = this.key; this.key = ""; this.search.dispose(); this.menu.close(); }
	dispose(): void { this.dismiss(); this.index.dispose(); }
}
