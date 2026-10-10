import { HTML_SANDBOX_ENGINE_REFERENCE } from "./engine-reference.js";

/** Short capability advertisement: part of the Desktop-only agent system prompt. */
export const HTML_SANDBOX_CAPABILITY_MARKER = "[Pix Desktop interactive chat UI]";
export const HTML_SANDBOX_CAPABILITY = `${HTML_SANDBOX_CAPABILITY_MARKER}
This client can display self-contained interactive HTML/CSS/JavaScript inside assistant messages using fenced pix-html blocks. When the user requests a working interactive experience "in chat" / "в чате" (a playable game, live animation, 2D/3D scene, form, calculator, controls or prototype), use pix-html rather than creating a standalone file, unless they explicitly request a file/project change or the sandbox cannot support the task. CSS/SVG/Canvas animation and locally packaged Phaser (2D) / Three.js (3D) are supported; no CDN/network access is needed or allowed. Before emitting pix-html, check whether the guide's full instructions are already available in this conversation context. If absent, you MUST call pix_html_sandbox_guide first. If present, follow them directly and DO NOT call the guide again, including for a new block or an edit to an earlier prototype. Do not call the guide merely to discuss this capability, explain HTML, show source code, create requested files, or draw static diagrams. Prefer SVG for static visual explanations; this inline rule applies to working interactive UI. If required capabilities are unsupported, explain the limitation and offer an alternative instead of silently substituting a file or claiming it works.`;

/** Tool inventory stays aligned with the per-turn advertisement. */
export const HTML_SANDBOX_TOOL_DESCRIPTION = "Read the syntax, bridge, local Phaser/Three.js engine references and safety limits for live HTML/CSS/JavaScript UI inside Pix Desktop chat. Call before emitting pix-html ONLY if the full guide is absent from the current conversation context. If already available, follow it directly; DO NOT call again for another block or edit. Use for preparing inline games, animations, 2D/3D scenes, forms, calculators or interactive prototypes, not for discussing the feature, static diagrams, HTML explanations or requested file/project edits. Read-only; no filesystem or network action.";

export function advertiseHtmlSandbox(systemPrompt: string): string {
	return systemPrompt.includes(HTML_SANDBOX_CAPABILITY_MARKER)
		? systemPrompt
		: `${systemPrompt}\n\n${HTML_SANDBOX_CAPABILITY}`;
}

/** Full instructions are returned only when the model asks for them. */
export const HTML_SANDBOX_GUIDE = `# Pix Desktop interactive HTML Sandbox

To display a live, interactive prototype inside an assistant message, reply with a **complete, closed** Markdown code fence labeled \`pix-html\` (or \`html-sandbox\`). Do not write an .html file unless the user specifically wants a file/project artifact. Ordinary \`html\` fences are rendered as code, **not** executed.

Example of a working inline form:

\`\`\`pix-html
<style>
body { font: 15px system-ui; padding: 12px; }
form { display: grid; gap: 10px; max-width: 360px; }
</style>
<form>
  <input name="name" placeholder="Your name" required>
  <select name="difficulty"><option value="easy">Easy</option><option value="hard">Hard</option></select>
  <button type="submit">Submit to agent</button>
</form>
<button id="finish">Report score</button>
<script>
document.querySelector("#finish").addEventListener("click", () => {
  window.pix.submit({event: "game_over", score: 1200, level: 3});
});
</script>
\`\`\`

Native form submit automatically sends named string values to the **same Pix conversation**. The same block demonstrates custom JavaScript game events via window.pix.submit(...).

The agent receives submitted JSON as a user message through ACP (queued if the agent is running); the user's composer draft is untouched. The iframe also receives an optional \`message\` acknowledgment: \`{channel:"pix-html-sandbox",type:"ack",status:"sent"|"queued"|"error"}\`.

Constraints: self-contained HTML, CSS, JS only; keep all code inside ONE \`pix-html\` block. Use \`<script>\` and \`addEventListener\` (not inline \`onclick\` attributes). No CDN imports, network calls, external images, file/system access, dynamic imports, workers or access to Pix/Tauri APIs. Local Canvas/WebGL, CSS, input, buttons and selectors work. Users must press Run to execute a prototype; it is not autorun. Source is limited to 200,000 characters; submissions are limited to 16 KiB of JSON, 10 per Run, no more than once a second.

Layout: the sandbox lives in the chat column, not a full browser window. Use responsive widths such as \`width:100%;max-width:100%;box-sizing:border-box\`, flexible layouts, and Canvas sized to its container with a resize handler. The host fits content height up to a limit, then displays a themed internal scrollbar. A separate viewport hint may accompany prototype requests; treat it as a snapshot, not a fixed size.

For "make Tetris in chat", send a playable, self-contained \`pix-html\` block with Canvas, keyboard controls, a score display, and inline JavaScript. Do not substitute an HTML file or a static code example unless specifically requested.

${HTML_SANDBOX_ENGINE_REFERENCE}`;
