import {
  Editor, defaultValueCtx, editorViewCtx, editorViewOptionsCtx, remarkCtx, rootCtx, serializerCtx,
} from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import {
  commonmark, createCodeBlockCommand, toggleEmphasisCommand, toggleInlineCodeCommand,
  toggleStrongCommand, turnIntoTextCommand, wrapInBlockquoteCommand, wrapInBulletListCommand,
  wrapInHeadingCommand, wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { undo, redo } from "@milkdown/kit/prose/history";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, type EditorState } from "@milkdown/kit/prose/state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable } from "@milkdown/kit/prose/tables";
import type { EditorView, NodeView } from "@milkdown/kit/prose/view";
import { $prose, callCommand, insert, replaceAll } from "@milkdown/kit/utils";
import { isSafeWikiUrl, splitWikiMarkdown, unsupportedWikiMarkdownNode } from "./wiki-markdown-content";

export type WikiEditorAction = "paragraph" | "heading1" | "heading2" | "heading3"
  | "bold" | "italic" | "inlineCode" | "codeBlock" | "quote" | "bulletList"
  | "orderedList" | "taskList" | "table" | "addRow" | "addColumn" | "deleteRow"
  | "deleteColumn" | "deleteTable" | "undo" | "redo";

export interface WikiEditorSelection {
  bold: boolean;
  italic: boolean;
  heading: number;
  inTable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  href: string;
  text: string;
}

export const emptyWikiEditorSelection: WikiEditorSelection = {
  bold: false, italic: false, heading: 0, inTable: false, canUndo: false, canRedo: false, href: "", text: "",
};

export interface WikiMarkdownEditorOptions {
  element: HTMLElement;
  value: string;
  disabled: () => boolean;
  onChange: (markdown: string) => void;
  onSave: () => void;
  onSelectionChange: (selection: WikiEditorSelection) => void;
  onError: (error: unknown) => void;
  onResolveImage?: (source: string) => Promise<string | undefined>;
  onOpenLink?: (href: string) => void | Promise<void>;
}

/** Links can span text nodes with different bold/italic marks. */
function linkAtCaret(state: EditorState) {
  const { selection } = state;
  if (!selection.empty || !selection.$from.parent.inlineContent) return undefined;
  const position = selection.$from;
  const link = position.marks().find((mark) => mark.type.name === "link")
    ?? position.nodeAfter?.marks.find((mark) => mark.type.name === "link")
    ?? position.nodeBefore?.marks.find((mark) => mark.type.name === "link");
  if (!link) return undefined;
  let start: number | undefined;
  let end = 0;
  let match: { from: number; to: number; href: string; title: unknown; text: string } | undefined;
  function finish() {
    if (start != null && position.parentOffset >= start && position.parentOffset <= end) {
      const from = position.start() + start;
      const to = position.start() + end;
      match = { from, to, href: String(link!.attrs.href), title: link!.attrs.title, text: state.doc.textBetween(from, to, " ") };
    }
    start = undefined;
  }
  position.parent.forEach((node, offset) => {
    if (match) return;
    if (node.marks.some((mark) => mark.eq(link))) {
      start ??= offset;
      end = offset + node.nodeSize;
    } else finish();
  });
  if (!match) finish();
  return match;
}

function selectionState(view: EditorView): WikiEditorSelection {
  const { selection, schema, storedMarks, doc } = view.state;
  const marks = storedMarks ?? selection.$from.marks();
  const marked = (name: string) => {
    const type = schema.marks[name];
    return Boolean(type && (selection.empty ? marks.some((mark) => mark.type === type)
      : doc.rangeHasMark(selection.from, selection.to, type)));
  };
  let heading = 0;
  let inTable = false;
  for (let depth = selection.$from.depth; depth > 0; depth--) {
    const node = selection.$from.node(depth);
    if (node.type.name === "heading") heading = Number(node.attrs.level);
    if (node.type.spec.tableRole === "table") inTable = true;
  }
  const currentLink = linkAtCaret(view.state);
  return {
    bold: marked("strong"), italic: marked("emphasis"), heading, inTable,
    canUndo: undo(view.state), canRedo: redo(view.state),
    href: currentLink?.href ?? String(marks.find((mark) => mark.type.name === "link")?.attrs.href ?? ""),
    text: currentLink?.text ?? doc.textBetween(selection.from, selection.to, " "),
  };
}

function imageView(node: ProseNode, options: WikiMarkdownEditorOptions): NodeView {
  const dom = document.createElement("span");
  dom.className = "wiki-inline-image";
  dom.contentEditable = "false";
  const image = document.createElement("img");
  image.draggable = false;
  const fallback = document.createElement("span");
  fallback.className = "wiki-image-fallback";
  dom.append(image, fallback);
  let revision = 0;
  let disposed = false;
  let currentSource: string | undefined;
  function update(next: ProseNode) {
    if (next.type.name !== "image") return false;
    const source = String(next.attrs.src ?? "");
    image.alt = String(next.attrs.alt ?? "");
    dom.title = String(next.attrs.title || source);
    fallback.textContent = image.alt || source || "Image";
    if (source === currentSource) return true;
    currentSource = source;
    const owner = ++revision;
    image.hidden = true;
    image.removeAttribute("src");
    fallback.hidden = false;
    if (!isSafeWikiUrl(source, true)) return true;
    void Promise.resolve().then(() => options.onResolveImage ? options.onResolveImage(source) : source)
      .then((resolved) => {
        if (disposed || owner !== revision || !resolved) return;
        image.onload = () => {
          if (disposed || owner !== revision) return;
          image.hidden = false;
          fallback.hidden = true;
        };
        image.onerror = () => {
          if (disposed || owner !== revision) return;
          image.hidden = true;
          fallback.hidden = false;
          options.onError(new Error(`Could not display wiki image: ${source}`));
        };
        image.src = resolved;
      }).catch((error) => { if (!disposed && owner === revision) options.onError(error); });
    return true;
  }
  update(node);
  return {
    dom, update, ignoreMutation: () => true,
    destroy() { disposed = true; revision++; image.onload = null; image.onerror = null; },
  };
}

function listItemView(node: ProseNode, view: EditorView, getPos: () => number | undefined,
  options: WikiMarkdownEditorOptions): NodeView {
  const dom = document.createElement("li");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.contentEditable = "false";
  checkbox.setAttribute("aria-label", "Mark task complete");
  const contentDOM = document.createElement("div");
  contentDOM.className = "wiki-list-content";
  dom.append(checkbox, contentDOM);
  function update(next: ProseNode) {
    if (next.type.name !== "list_item") return false;
    const task = typeof next.attrs.checked === "boolean";
    checkbox.hidden = !task;
    checkbox.disabled = options.disabled();
    checkbox.checked = Boolean(next.attrs.checked);
    dom.classList.toggle("wiki-task-item", task);
    dom.dataset.checked = task ? String(next.attrs.checked) : "";
    return true;
  }
  function change() {
    const pos = getPos();
    if (pos == null) return;
    const current = view.state.doc.nodeAt(pos);
    if (!current || options.disabled()) { if (current) update(current); return; }
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: checkbox.checked }));
  }
  checkbox.addEventListener("change", change);
  update(node);
  return {
    dom, contentDOM, update,
    stopEvent: (event) => event.target === checkbox,
    ignoreMutation: (mutation) => mutation.type !== "selection" && (mutation.target === checkbox || mutation.target === dom),
    destroy() { checkbox.removeEventListener("change", change); },
  };
}

export async function createWikiMarkdownEditor(options: WikiMarkdownEditorOptions) {
  let editor: Editor;
  let original = options.value;
  let prefix = "";
  let baseline: ProseNode | undefined;
  let lastPublished = original;
  let initialized = false;
  let disposed = false;
  function readMarkdown(): string {
    if (!initialized || disposed) return lastPublished;
    return editor.action((ctx) => {
      const doc = ctx.get(editorViewCtx).state.doc;
      return baseline?.eq(doc) ? original : prefix + ctx.get(serializerCtx)(doc);
    });
  }
  function publish(view: EditorView, previous?: ProseNode) {
    if (!initialized || disposed) return;
    if (previous && !previous.eq(view.state.doc)) {
      const markdown = readMarkdown();
      if (markdown !== lastPublished) { lastPublished = markdown; options.onChange(markdown); }
    }
    options.onSelectionChange(selectionState(view));
  }
  const integration = $prose(() => new Plugin({
    props: {
      nodeViews: {
        image: (node) => imageView(node, options),
        list_item: (node, view, getPos) => listItemView(node, view, getPos, options),
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (!options.disabled()) options.onSave();
          return true;
        }
        return false;
      },
      handleClick: (_view, _pos, event) => {
        const target = event.target instanceof Element ? event.target.closest("a") : null;
        const href = target?.getAttribute("href");
        if (!href) return false;
        // Editing a link keeps the caret in the document; Cmd/Ctrl-click follows it.
        event.preventDefault();
        if ((event.metaKey || event.ctrlKey) && isSafeWikiUrl(href)) {
          void Promise.resolve().then(() => options.onOpenLink?.(href)).catch(options.onError);
        }
        return Boolean(event.metaKey || event.ctrlKey);
      },
    },
    view: () => ({ update: (view, previous) => publish(view, previous.doc) }),
  }));
  editor = Editor.make().config((ctx) => {
    ctx.set(rootCtx, options.element);
    ctx.set(defaultValueCtx, "");
    ctx.update(editorViewOptionsCtx, (previous) => ({
      ...previous, editable: () => !options.disabled(),
      attributes: { class: "wiki-prose-editor", role: "textbox", "aria-label": "Markdown document", "aria-multiline": "true", spellcheck: "true" },
    }));
  }).use(commonmark).use(gfm).use(history).use(clipboard).use(integration);

  function setValue(value: string) {
    if (initialized && value === readMarkdown()) return;
    const parts = splitWikiMarkdown(value);
    editor.action((ctx) => {
      const reason = unsupportedWikiMarkdownNode(ctx.get(remarkCtx).parse(parts.body));
      if (reason) throw new Error(reason);
    });
    initialized = false;
    editor.action(replaceAll(parts.body, true));
    original = value;
    prefix = parts.prefix;
    lastPublished = value;
    baseline = editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
    initialized = true;
    editor.action((ctx) => publish(ctx.get(editorViewCtx)));
  }
  try { await editor.create(); setValue(options.value); }
  catch (error) { await editor.destroy().catch(options.onError); throw error; }

  function action(command: WikiEditorAction) {
    if (disposed || options.disabled()) return;
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    switch (command) {
      case "paragraph": editor.action(callCommand(turnIntoTextCommand.key)); break;
      case "heading1": case "heading2": case "heading3":
        editor.action(callCommand(wrapInHeadingCommand.key, Number(command.at(-1)))); break;
      case "bold": editor.action(callCommand(toggleStrongCommand.key)); break;
      case "italic": editor.action(callCommand(toggleEmphasisCommand.key)); break;
      case "inlineCode": editor.action(callCommand(toggleInlineCodeCommand.key)); break;
      case "codeBlock": editor.action(callCommand(createCodeBlockCommand.key)); break;
      case "quote": editor.action(callCommand(wrapInBlockquoteCommand.key)); break;
      case "bulletList": editor.action(callCommand(wrapInBulletListCommand.key)); break;
      case "orderedList": editor.action(callCommand(wrapInOrderedListCommand.key)); break;
      case "taskList": {
        let selection = view.state.selection;
        let depth = selection.$from.depth;
        while (depth > 0 && selection.$from.node(depth).type.name !== "list_item") depth--;
        if (!depth) {
          editor.action(callCommand(wrapInBulletListCommand.key));
          selection = view.state.selection;
          depth = selection.$from.depth;
          while (depth > 0 && selection.$from.node(depth).type.name !== "list_item") depth--;
        }
        if (depth) {
          const node = selection.$from.node(depth);
          view.dispatch(view.state.tr.setNodeMarkup(selection.$from.before(depth), undefined,
            { ...node.attrs, checked: typeof node.attrs.checked === "boolean" ? null : false }));
        }
        break;
      }
      case "table": editor.action(insert("| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n")); break;
      case "addRow": addRowAfter(view.state, view.dispatch); break;
      case "addColumn": addColumnAfter(view.state, view.dispatch); break;
      case "deleteRow": deleteRow(view.state, view.dispatch); break;
      case "deleteColumn": deleteColumn(view.state, view.dispatch); break;
      case "deleteTable": deleteTable(view.state, view.dispatch); break;
      case "undo": undo(view.state, view.dispatch); break;
      case "redo": redo(view.state, view.dispatch); break;
    }
    view.focus();
  }

  return {
    readMarkdown, setValue, action,
    focus() { if (!disposed) editor.action((ctx) => ctx.get(editorViewCtx).focus()); },
    setDisabled() {
      if (disposed) return;
      editor.action((ctx) => ctx.get(editorViewCtx).setProps({ editable: () => !options.disabled() }));
      options.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => { input.disabled = options.disabled(); });
    },
    insertLink(href: string, label: string) {
      if (disposed || options.disabled() || !isSafeWikiUrl(href)) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        const type = state.schema.marks.link;
        if (!type) return;
        const currentLink = linkAtCaret(state);
        const mark = type.create({ href, title: currentLink?.title ?? null });
        const { from, to } = currentLink ?? state.selection;
        const transaction = state.tr;
        if (from === to) transaction.replaceSelectionWith(state.schema.text(label || href, [mark]), false);
        else if (label && label !== state.doc.textBetween(from, to, " ")) {
          transaction.replaceWith(from, to, state.schema.text(label, [mark]));
        } else transaction.removeMark(from, to, type).addMark(from, to, mark);
        view.dispatch(transaction.scrollIntoView());
        view.focus();
      });
    },
    insertImage(source: string, alt: string) {
      if (disposed || options.disabled() || !isSafeWikiUrl(source, true)) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const image = view.state.schema.nodes.image?.create({ src: source, alt });
        if (image) view.dispatch(view.state.tr.replaceSelectionWith(image).scrollIntoView());
        view.focus();
      });
    },
    async destroy() { if (disposed) return; disposed = true; await editor.destroy(); },
  };
}

export type WikiMarkdownEditor = Awaited<ReturnType<typeof createWikiMarkdownEditor>>;

