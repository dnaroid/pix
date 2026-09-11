# Pix Desktop Design Contract

This document defines the visual language for the desktop application. It is a decision contract, not an inspiration board.

Theme: **Pix Desktop semantic theme**
Light foundation: **Claude+** —
`https://tweakcn.com/themes/cmdght103000n04lh3e2ae93r`
Dark direction: **high-contrast, cool desktop palette inspired by Zed**

The machine-readable Claude+ reference used as the light-theme foundation is
bundled with the frontend skill at:

`.pi/skills/pix-desktop-frontend/references/claude-plus.theme.json`

## 1. Product character

The application is a compact desktop productivity tool.

Do not design pages. Design a window, panes, commands, and transient surfaces.

Its visual model is a strict modern **chat/IDE workbench**: conversation,
technical output, navigation, editor-like input, and runtime chrome should feel
like one integrated desktop environment rather than separate chat and dashboard
products.

The interface SHOULD feel:

- calm rather than sterile;
- quiet rather than decorative;
- professional rather than corporate-heavy;
- dense enough for daily desktop work;
- precise and editor-like in its pane geometry and interaction states;
- tactile through subtle surfaces, borders, and restrained radius;
- consistent with the active semantic palette: warm neutral/terracotta in light
  mode and cool, crisp, high-contrast surfaces in dark mode.

The interface MUST NOT drift toward a generic AI/SaaS landing-page aesthetic.

Avoid oversized hero typography, gradient decoration, glassmorphism, neon glows, giant empty cards, excessive pills, and decorative background effects.

## 2. Source of truth

For visual implementation, use this priority:

1. Explicit task requirements.
2. Live semantic theme tokens in `desktop/src/styles.css`.
3. This `DESIGN.md`.
4. The bundled Pix IDE visual-language reference.
5. The bundled Claude+ theme reference for light-theme intent.
6. Existing neighboring UI patterns that do not conflict with the above.
7. Generic frontend conventions.

Do not copy a legacy local style when it contradicts the current semantic theme.

## 3. Styling model

New UI SHOULD use Tailwind CSS v4 with semantic utilities backed by the theme variables.

Prefer:

```text
bg-background
text-foreground
bg-card
text-card-foreground
bg-popover
text-popover-foreground
bg-primary
text-primary-foreground
bg-secondary
text-secondary-foreground
bg-muted
text-muted-foreground
bg-accent
text-accent-foreground
border-border
border-input
ring-ring
bg-sidebar
text-sidebar-foreground
bg-chrome
text-chrome-foreground
bg-chrome-hover
bg-panel
bg-panel-strong
bg-panel-hover
bg-panel-selected
bg-chat-user
border-chat-user-border
bg-code
border-code-border
bg-selection
text-selection-foreground
text-tool-success
text-tool-warning
text-tool-error
```

Use the configured semantic radius and shadow utilities.

Do not introduce arbitrary visual values such as:

```text
bg-[#...]
text-[#...]
border-[#...]
rounded-[...]
shadow-[...]
```

Arbitrary dimensions are acceptable only when they express a real desktop constraint that is not part of the theme, such as a minimum pane width or a known titlebar height.

## 4. Color behavior

### Primary accent

Primary is emphasis, not decoration. Its hue is theme-dependent: light mode uses
the Claude+ terracotta accent, while dark mode uses a cool blue accent for
clearer desktop contrast.

Use primary for:

- the dominant action in a local interaction context;
- focus/ring emphasis;
- meaningful selected emphasis;
- small active indicators when neutral styling is insufficient.

Do NOT use primary for every button, every icon, every navigation item, or passive status text.

### Neutral surfaces

Use `background` for the application canvas.

Use `card` for a contained functional surface that needs separation from the
canvas but is not part of the persistent IDE workbench.

Use `chrome` for persistent titlebar/status/rail surfaces and `chrome-hover` for
their local hover treatment.

Use `panel` for integrated workbench panes and secondary pane regions. Use
`panel-strong` for inset editor/input surfaces, `panel-hover` for hoverable rows,
and `panel-selected` for quiet selected-state emphasis.

Use `code` plus `code-border` for code, tool output, diffs, previews, and other
sustained technical reading surfaces.

Use `chat-user` plus `chat-user-border` for the user prompt block. It should
remain distinct from assistant prose without reading like a messenger bubble.

Use `selection` plus `selection-foreground` for native text selection. Selection
must remain clearly visible without becoming a saturated primary block; in dark
mode prefer a restrained blue-tinted layer while keeping normal readable text.

Use `muted` for generic subdued content only when none of the more specific
workbench roles above applies.

Use `popover` for elevated transient UI such as menus, dialogs, and popovers.

Use `sidebar` for persistent navigation/utility chrome where a distinct desktop region is needed.

In dark mode, adjacent persistent regions SHOULD remain visibly separable.
Prefer subtle but legible differences between `background`, `card`, `popover`,
and `sidebar`, with borders strong enough to define pane geometry without
becoming bright outlines.

## 5. Typography

Primary UI font: **Outfit**.

Technical font: **Geist Mono**.

Use Geist Mono for:

- code;
- commands;
- file paths;
- technical identifiers;
- logs;
- tool output;
- terminal-like content.

Do not use monospace for the whole application.

Build hierarchy with weight, spacing, and muted foreground before introducing many font sizes.

UI copy SHOULD remain compact and direct.

## 6. Radius, borders, and elevation

The semantic theme uses a compact editor-oriented base radius. Persistent panes
and ordinary controls should feel precise rather than soft.

Use smaller semantic radii for controls and larger semantic radii for composed surfaces.

Guidance:

- controls: `rounded-sm` or `rounded-md`;
- input/composer surfaces: `rounded-md` or `rounded-lg`;
- dialogs and substantial floating surfaces: usually `rounded-lg`;
- `rounded-xl` and larger require a specific composed/floating-object reason;
- avoid pill shapes unless the semantic object is actually a chip/tag/status capsule.

Prefer a subtle border before adding a shadow.

Use shadows only to communicate elevation. Do not stack strong borders and strong shadows together.

## 7. Spacing and density

Design for a desktop window, not a marketing page.

Prefer compact controls and stable pane geometry.

Typical local spacing SHOULD cluster around Tailwind's standard 1–4 spacing steps. Larger spacing is appropriate for section separation, empty states, or modal composition.

Do not create large empty whitespace solely to make the UI look "premium".

## 8. Application layout

Prefer persistent desktop regions:

- tab/title area;
- sidebar when navigation breadth warrants it;
- main content/workspace;
- contextual toolbar when actions are persistent;
- bottom status region for low-priority runtime information;
- independently scrollable transcript/content panes.

Keep the application window itself stable. Prefer scrolling inside content regions rather than allowing the entire desktop shell to behave like a web page.

### 8.1 Desktop application model

Treat the product as a stable workbench:

```text
window
├─ titlebar / session tabs
├─ activity rail + optional navigation pane
├─ primary workspace
│  ├─ transcript/document surface
│  └─ anchored composer/editor
├─ optional contextual inspector
└─ compact status chrome
```

Transient surfaces (menus, context menus, pickers, popovers, dialogs, drag
previews) live above this workbench rather than reshaping it.

Every substantial surface must be classifiable as either:

- **attached** — persistent workbench geometry with shared edges and separators;
- **floating** — transient/elevated UI where radius and shadow communicate layer.

Attached panes MUST NOT use card geometry merely for decoration. In particular,
sidebar, workspace, composer region, inspector, titlebar/tab strip, and status bar
should feel structurally connected.

### 8.2 Desktop density scale

Prefer a small repeated geometry vocabulary:

- titlebar/session tabs: `36px`;
- compact pane headers/toolbars: `32–36px`;
- status bar: approximately `28px`;
- compact icon actions: `24–28px`;
- navigator/menu/tree rows: `24–30px`;
- ordinary desktop form controls: `28–32px` by default;
- composed modal form controls may reach `36px` when readability warrants it.

These are Pix defaults rather than universal hit-target requirements. The goal is
consistent desktop density, not making every control the same size.

### 8.3 Scroll ownership

The shell remains fixed to the window. Long-lived regions own their scroll:

- transcript/editor;
- file/project explorer;
- task/source-control/registry panes;
- inspectors;
- menus/pickers when their contents exceed their bounds.

Pane headers, title/tabs, composer chrome, and status chrome should remain stable
while their corresponding content scrolls. Avoid ambiguous nested scrolling.

## 9. Panels and cards

Do not wrap every section in a card.

Use a card/panel only when it provides one of these functions:

- groups a coherent task;
- separates editable/interactive state from the canvas;
- communicates elevation;
- creates a distinct detail/inspector region.

Otherwise use spacing, typography, and separators.

Default **attached workbench pane** recipe:

```text
bg-panel
text-foreground
border-border on the shared pane edge that needs separation
no outer shadow
no outer radius where the pane attaches to other workbench regions
```

Default **floating/contained** recipe when genuine elevation/containment is needed:

```text
bg-popover text-popover-foreground
border border-border
rounded-md or rounded-lg
shadow-xs / shadow-md only when elevation is semantically meaningful
```

Do not use `rounded-xl` as the generic answer for grouping. Add a shadow only
when the surface needs actual lift.

## 10. Buttons and actions

Within one local interaction context, there SHOULD normally be one visually dominant primary action.

Primary action:

```text
bg-primary text-primary-foreground
```

Treat these as a paired contract. Global element selectors MUST NOT override the
semantic foreground or background chosen by the component. The enabled action
should read as crisp and flat: avoid permanent bevels, glossy borders, or shadows
that make an ordinary control look raised or metallic. Verify the rendered color
pair, not only the class names.

Secondary actions SHOULD use neutral semantic surfaces or ghost treatment.

Destructive actions MUST be visually distinguishable from primary actions and
SHOULD not reuse the primary accent as a substitute for destructive semantics.

Toolbar actions SHOULD generally be quiet until hover/active state.

## 11. Inputs and composer UI

Inputs SHOULD use semantic border/input/ring tokens.

Normalize native selects used inside designed application surfaces. A semantic
background does not remove platform bevels or gradients by itself: use
`appearance-none`, preserve the native select semantics, reserve space for a
Lucide chevron, and verify the closed control in light and dark desktop WebViews.

Focused controls MUST have a visible focus state.

Composer surfaces may read as a distinct card-like work surface, but should not become visually heavier than the transcript/content above them.

Place send/submit emphasis inside the composer rather than coloring the entire composer with primary.

## 12. Navigation, tabs, and selection

Persistent navigation SHOULD primarily use neutral surfaces.

Selected state can be communicated with:

- surface change;
- text contrast;
- border relationship;
- restrained primary indicator.

Do not flood active navigation rows with primary unless the local design specifically requires it.

Keyboard focus and selected/active state are separate and MUST remain visually
distinguishable. Selection persists when focus leaves a selected tab/list/tree
item; focus indicates where keyboard input currently acts.

For true composite widgets:

- `Tab` / `Shift+Tab` move between meaningful components;
- arrow keys move inside tablists, menus, trees, grids, radio groups, and similar
  composites;
- `Home` / `End` move to the first/last item where conventional;
- `Escape` dismisses the topmost transient surface where expected;
- closing/removing the focused object moves focus to a logical neighbor;
- dismissing a transient surface restores focus to its invoker when possible.

Do not add ARIA composite roles without implementing their keyboard behavior.

### 12.1 Commands and context actions

Choose command surfaces intentionally:

- frequent local command → toolbar/stable pane action;
- contextual command → context menu plus optional hover accelerator;
- global/frequent command → command picker/menu and shortcut;
- secondary/rare command → menu/overflow;
- destructive command → destructive semantics, with confirmation or undo where
  the risk warrants it.

Hover-only UI must not be the only path to a critical command. Prefer one command
definition that can feed toolbar, menu, context-menu, and shortcut surfaces.

### 12.2 Resizable panes and spatial memory

Persistent secondary panes such as sidebars and inspectors SHOULD be resizable
when width materially affects repeated work.

Resizable panes need:

- sensible minimum and maximum widths;
- a separator hit target wider than the visible one-pixel divider;
- pointer resizing;
- keyboard resizing when the separator is focusable;
- visible hover/focus affordance;
- best-effort persistence of the preferred size;
- clamping restored size to current window constraints.

At narrow widths, collapse or overlay secondary panes before crushing the primary
workspace.

## 13. Dialogs, popovers, and menus

Transient elevated UI SHOULD use `popover` semantics.

Dialogs need:

- clear title hierarchy;
- concise explanatory text;
- obvious primary/secondary action ordering;
- keyboard-safe focus behavior;
- restrained shadow and backdrop.

Avoid oversized modal padding and huge dialog titles.

## 14. Conversation UI

Assistant content SHOULD remain close to the application canvas and prioritize readability.

User messages may use a contained neutral card/bubble, but should stay compact and avoid consumer-messenger styling.

Tool calls, reasoning details, logs, and code SHOULD visually recede from primary conversational content through muted surfaces and Geist Mono where appropriate.

Conversation spacing MUST prioritize user/assistant turns over service telemetry.
Collapsed thinking rows, tool groups, tool rows, and lightweight runtime/status
entries SHOULD use compact line-height and tight vertical gaps so repeated
operations scan like IDE activity rather than separate chat messages. Expanded
technical bodies may use slightly more room for readability, but SHOULD remain
denser than assistant prose. Do not globally tighten assistant/user Markdown to
achieve service density.

When service telemetry sits between conversational turns, the gap above and
below it SHOULD be visually balanced. Do not leave a large assistant-message
margin above a compact tool/thinking row and a much smaller gap below it.

Thinking activity MUST remain visible when the model reports a reasoning block,
even when the provider exposes no readable reasoning body. In that case show the
compact `thinking` activity row without inventing reasoning text. Persisted
history SHOULD retain available thinking blocks instead of silently dropping
them.

Running state indicators SHOULD be small and restrained.

The transcript MUST NOT use top/bottom gradient fading or CSS masking to obscure
content near the scroll edges. Content should remain fully opaque up to the pane
boundaries; separation from surrounding chrome should come from layout,
spacing, and borders instead.

Automatically detected file-like Markdown text MUST remain non-interactive until
the target is validated as an existing file. Perform that validation lazily near
the viewport and asynchronously; transcript rendering and scrolling must never
wait for filesystem validation. Missing, stale, or unresolvable paths remain
ordinary text/code rather than clickable file links.

## 15. States

Interactive components MUST account for applicable states:

- default;
- hover;
- focus-visible;
- active/selected;
- disabled;
- loading;
- error/destructive.

Do not use hover as the only way to expose critical state or meaning.

## 16. Motion

Motion is functional feedback, not decoration.

Prefer short opacity/color/transform transitions.

Avoid large entrance animations, springy marketing motion, continuous decorative movement, and animated gradients.

Respect `prefers-reduced-motion` for nonessential movement.

## 17. Accessibility

Use semantic HTML.

Actions use buttons; navigation uses links when navigation is real.

Form controls require accessible labels.

Maintain visible focus indicators.

Do not remove outlines without an equivalent focus-visible treatment.

Use ARIA only where native semantics are insufficient.

## 18. Light and dark modes

Every new surface, border, text color, and interaction state MUST work in both
supported palettes: Claude+-derived light mode and the cool high-contrast dark
mode defined by the semantic tokens in `desktop/src/styles.css`.

Dark mode SHOULD favor:

- near-black charcoal canvas surfaces rather than warm brown-black neutrals;
- brighter foreground text and clearer muted text hierarchy;
- crisp but restrained pane and control borders;
- a cool blue primary/focus accent;
- distinct card, popover, sidebar, and hover surfaces instead of collapsing
  them into one dark tone;
- readable status/tool colors with enough chroma to remain distinguishable on
  the dark canvas.

Never fix a dark-mode problem by adding a one-off hard-coded color when a semantic token can express the role.

## 18.1 Platform-aware desktop behavior

Pix uses one cross-platform visual identity, but platform interaction conventions
remain part of the product contract.

- Keep native minimize/maximize/close controls where practical.
- Maintain real draggable titlebar space that does not overlap buttons/inputs.
- On macOS, reserve and verify traffic-light geometry in the actual Tauri window.
- Prefer native/transparent/overlay titlebar approaches when they satisfy the
  requirement; a fully custom titlebar can sacrifice system window behavior.
- Use `Command` conventions on macOS and `Control` conventions on Windows/Linux
  for primary shortcuts.
- Do not intercept system/WebView shortcuts without a strong product reason.

## 19. Legacy CSS and migration

Existing CSS does not need a wholesale rewrite.

When touching existing UI:

- preserve working behavior;
- migrate visual values to semantic tokens when it improves consistency;
- use Tailwind for new UI or substantial component changes;
- do not perform unrelated style migrations.

For a broad migration from web-like UI to native desktop behavior, use this order:

1. classify attached vs floating surfaces;
2. fix shell and scroll ownership;
3. normalize geometry/density;
4. fix focus lifecycle and composite keyboard behavior;
5. consolidate commands/context actions;
6. add resize/collapse persistence to useful panes;
7. flatten unnecessary cards/radii/shadows;
8. tune palette and micro-polish last.

This migration order is preferred over a cosmetic palette-only redesign.

## 20. Design review questions

Before considering a UI task complete, ask:

1. Does the result look like the same application as the neighboring UI?
2. Are semantic theme tokens used instead of new arbitrary visual values?
3. Is the active theme's primary accent reserved for meaningful emphasis?
4. Did I create unnecessary cards, borders, pills, or shadows?
5. Is the information density appropriate for a desktop productivity tool?
6. Does the visual hierarchy make the primary task/action obvious?
7. Do light and dark modes both work?
8. Are hover, focus-visible, disabled, loading, and error states covered where relevant?
9. Does the narrow desktop window remain usable?
10. Did I avoid redesigning unrelated UI?
11. Are focus and selected state distinct, and does focus return somewhere logical after closing/removing UI?
12. Are important contextual commands reachable without hover alone?
13. Do resizable/secondary panes preserve the primary workspace and useful spatial memory?
14. Does each large region clearly read as attached workbench geometry or intentional floating UI?
