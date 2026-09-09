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

## 9. Panels and cards

Do not wrap every section in a card.

Use a card/panel only when it provides one of these functions:

- groups a coherent task;
- separates editable/interactive state from the canvas;
- communicates elevation;
- creates a distinct detail/inspector region.

Otherwise use spacing, typography, and separators.

Default panel recipe:

```text
bg-card
text-card-foreground
border border-border
rounded-xl
```

Add `shadow-xs` only when the surface needs slight lift.

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

Running state indicators SHOULD be small and restrained.

The transcript MUST NOT use top/bottom gradient fading or CSS masking to obscure
content near the scroll edges. Content should remain fully opaque up to the pane
boundaries; separation from surrounding chrome should come from layout,
spacing, and borders instead.

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

## 19. Legacy CSS and migration

Existing CSS does not need a wholesale rewrite.

When touching existing UI:

- preserve working behavior;
- migrate visual values to semantic tokens when it improves consistency;
- use Tailwind for new UI or substantial component changes;
- do not perform unrelated style migrations.

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
