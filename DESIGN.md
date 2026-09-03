# Pix Desktop Design Contract

This document defines the visual language for the desktop application. It is a decision contract, not an inspiration board.

Theme: **Claude+**  
Source: `https://tweakcn.com/themes/cmdght103000n04lh3e2ae93r`

The machine-readable theme values are bundled with the frontend skill at:

`.pi/skills/pix-desktop-frontend/references/claude-plus.theme.json`

## 1. Product character

The application is a compact desktop productivity tool.

The interface SHOULD feel:

- warm rather than sterile;
- quiet rather than decorative;
- professional rather than corporate-heavy;
- dense enough for daily desktop work;
- tactile through subtle surfaces, borders, and restrained radius;
- consistent with the Claude+ neutral/terracotta palette.

The interface MUST NOT drift toward a generic AI/SaaS landing-page aesthetic.

Avoid oversized hero typography, gradient decoration, glassmorphism, neon glows, giant empty cards, excessive pills, and decorative background effects.

## 2. Source of truth

For visual implementation, use this priority:

1. Explicit task requirements.
2. Live semantic theme tokens in `desktop/src/styles.css`.
3. This `DESIGN.md`.
4. The bundled Claude+ theme reference.
5. Existing neighboring UI patterns that do not conflict with the above.
6. Generic frontend conventions.

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

Terracotta is emphasis, not decoration.

Use primary for:

- the dominant action in a local interaction context;
- focus/ring emphasis;
- meaningful selected emphasis;
- small active indicators when neutral styling is insufficient.

Do NOT use primary for every button, every icon, every navigation item, or passive status text.

### Neutral surfaces

Use `background` for the application canvas.

Use `card` for a contained functional surface that needs separation from the canvas.

Use `muted` for subdued technical content, code/tool output backgrounds, or low-emphasis grouped regions.

Use `popover` for elevated transient UI such as menus, dialogs, and popovers.

Use `sidebar` for persistent navigation/utility chrome where a distinct desktop region is needed.

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

Claude+ uses a generous base radius, but desktop density still matters.

Use smaller semantic radii for controls and larger semantic radii for composed surfaces.

Guidance:

- controls: `rounded-md` or `rounded-lg`;
- input/composer surfaces: `rounded-lg` or `rounded-xl`;
- dialogs and substantial floating surfaces: `rounded-xl` or `rounded-2xl`;
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

Secondary actions SHOULD use neutral semantic surfaces or ghost treatment.

Destructive actions MUST be visually distinguishable from primary actions and SHOULD not use primary terracotta as a substitute for destructive semantics.

Toolbar actions SHOULD generally be quiet until hover/active state.

## 11. Inputs and composer UI

Inputs SHOULD use semantic border/input/ring tokens.

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

Every new surface, border, text color, and interaction state MUST work in both Claude+ light and dark palettes.

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
3. Is terracotta reserved for meaningful emphasis?
4. Did I create unnecessary cards, borders, pills, or shadows?
5. Is the information density appropriate for a desktop productivity tool?
6. Does the visual hierarchy make the primary task/action obvious?
7. Do light and dark modes both work?
8. Are hover, focus-visible, disabled, loading, and error states covered where relevant?
9. Does the narrow desktop window remain usable?
10. Did I avoid redesigning unrelated UI?
