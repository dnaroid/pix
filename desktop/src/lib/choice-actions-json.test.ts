import { describe, expect, it } from "vitest";
import { parseChoiceActions } from "./choice-actions";
import { MAX_JSON_ACTIONS_CHARS, parseJsonChoiceActions } from "./choice-actions-json";
import { choiceActionsPresentation, latestChoiceActionsMessageId } from "./choice-actions-replies";
import { splitHtmlSandboxSegments } from "./html-sandbox";
import type { MessageItem } from "./transcript-types";

const entries = [
  { label: "Фаза 3: установить", prompt: "Разрешаю Фазу 3: выполни ./webcli install и подскажи, как загрузить расширение. Живые прогоны пока не запускай." },
  { label: "Бесплатные прогоны", prompt: "Установка сделана. Запусти бесплатные живые прогоны webcli: tripo image, tripo export и chatgpt generate." },
  { label: "Показать изменения", prompt: "Покажи структуру файлов проекта webcli и коротко опиши каждый файл." },
];
const json = JSON.stringify(entries, null, 2);
const actions = {
  submitLabel: "Continue",
  items: entries.map((entry) => ({ ...entry, checked: false })),
  buttons: true,
};

describe("JSON choice compatibility", () => {
  it("preserves the reported labels and full prompts as independent buttons", () => {
    expect(parseJsonChoiceActions(json)).toEqual(actions);
    expect(parseChoiceActions("pix-actions", json)).toEqual(actions);
    expect(parseJsonChoiceActions(JSON.stringify([{ label: "Install", prompt: "First line\nSecond line" }]))?.items[0]?.prompt)
      .toBe("First line\nSecond line");
  });

  it.each([
    "[]", "null", "{}", "[null]", "[[]]", "[1]", '[{"label":"X"}]',
    '[{"label":"X","prompt":1}]', '[{"label":"X","prompt":" "}]',
    '[{"label":" ","prompt":"Run"}]', '[{"label":"X","prompt":"Run","extra":true}]',
    JSON.stringify([{ label: "x".repeat(41), prompt: "Run" }]),
    JSON.stringify([{ label: "X", prompt: "x".repeat(301) }]),
    JSON.stringify([{ label: "X\nY", prompt: "Run" }]),
    JSON.stringify([{ label: "X", prompt: "Run\u0000" }]),
    JSON.stringify(Array.from({ length: 5 }, () => entries[0])),
    " ".repeat(MAX_JSON_ACTIONS_CHARS) + json,
    json + " trailing", json.slice(0, -1),
  ])("keeps invalid or out-of-bounds data as text: %s", (body) => {
    expect(parseJsonChoiceActions(body)).toBeUndefined();
  });

  it.each([json, `Before\n\n${json}`, `Before\n\n\`\`\`json\n${json}\n\`\`\``, `\`\`\`pix-actions\n${json}\n\`\`\``])
    ("segments a standalone trailing menu only when enabled", (text) => {
      expect(splitHtmlSandboxSegments(text, { actions: true }).at(-1)).toEqual({ type: "actions", actions });
      expect(splitHtmlSandboxSegments(text, {})).toEqual([{ type: "markdown", text }]);
    });

  it.each([
    `Example\n${json}`, `${json}\nAfter`, `\`\`\`json\n${json}\n\`\`\`\nAfter`,
    `\`\`\`text\n${json}\n\`\`\``, `\`\`\`markdown\n\`\`\`json\n${json}\n\`\`\`\n\`\`\``,
    `\`\`\`json\n${json}`, `    \`\`\`json\n${json}\n    \`\`\``,
    json.split("\n").map((line) => `    ${line}`).join("\n"),
  ])("leaves examples, nonterminal arrays and unclosed fences untouched", (text) => {
    expect(splitHtmlSandboxSegments(text, { actions: true })).toEqual([{ type: "markdown", text }]);
  });

  it("does not expose buttons before the full JSON payload is streamed", () => {
    for (let length = 1; length < json.length; length += 1) {
      const text = json.slice(0, length);
      expect(splitHtmlSandboxSegments(text, { actions: true })).toEqual([{ type: "markdown", text }]);
    }
  });

  it("uses existing history activation and does not synthesize checkbox receipts", () => {
    const source: MessageItem = { type: "message", id: "a", role: "assistant", text: json, attachments: [] };
    const reply: MessageItem = { type: "message", id: "u", role: "user", text: entries[0]!.prompt, attachments: [] };
    expect(latestChoiceActionsMessageId([source])).toBe("a");
    expect(latestChoiceActionsMessageId([source, reply])).toBeUndefined();
    expect(latestChoiceActionsMessageId([{ ...source, role: "user" }])).toBeUndefined();
    expect(choiceActionsPresentation([source, reply]).replies.size).toBe(0);
    expect(choiceActionsPresentation([source, { ...reply, text: `Continue:\n1. ${entries[0]!.label}` }]).replies.size).toBe(0);
  });
});
