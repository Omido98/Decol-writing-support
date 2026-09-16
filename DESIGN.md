---
version: alpha
name: Inkwell
description: "A writer's desk — warm charcoal paper, a single ink-teal accent, and documents set in serif. Dark theme is the normative palette; light is the paper variant."
colors:
  background: "#14120f"
  foreground: "#f2ede4"
  surface: "#1e1b17"
  surface-alt: "#282419"
  border: "#3a352c"
  primary: "#34d399"
  primary-hover: "#3bd9a8"
  on-primary: "#0d2b22"
  secondary: "#a8a094"
  muted: "#8a8376"
  error: "#f87171"
  on-error: "#330b0b"
  warning: "#fbbf24"
  on-warning: "#2a1e02"
  ring: "#34d399"
  selection: "#24312c"
typography:
  headline-lg:
    fontFamily: Geist Variable
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist Variable
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Geist Variable
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.4
  body-lg:
    fontFamily: Geist Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
  body-md:
    fontFamily: Geist Variable
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Geist Variable
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: Geist Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  label-md:
    fontFamily: Geist Variable
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: Geist Variable
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
  mono-sm:
    fontFamily: Geist Mono Variable
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  mono-xs:
    fontFamily: Geist Mono Variable
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
  doc-lg:
    fontFamily: Source Serif 4 Variable
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.7
  doc-md:
    fontFamily: Source Serif 4 Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
  doc-sm:
    fontFamily: Source Serif 4 Variable
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: 6px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  card-padding: 20px
  card-gap: 16px
  navigator-width: 240px
  inspector-width: 360px
  doc-column: 720px
  chat-column: 768px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 12px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-disabled:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.secondary}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 12px
  button-outline:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 12px
  button-destructive:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-error}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    height: 32px
    padding: 0 12px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.card-padding}"
  chat-user-bubble:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  chat-document:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    typography: "{typography.doc-sm}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  navigator-panel:
    backgroundColor: "{colors.background}"
    width: "{spacing.navigator-width}"
  inspector-panel:
    backgroundColor: "{colors.background}"
    width: "{spacing.inspector-width}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  helper-text:
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
  cursor-stream:
    backgroundColor: "{colors.ring}"
    height: 16px
    width: 8px
  input-field:
    backgroundColor: "{colors.surface-alt}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 12px
  list-item:
    backgroundColor: transparent
    rounded: "{rounded.md}"
    padding: 8px 12px
  list-item-hover:
    backgroundColor: "{colors.surface-alt}"
  list-item-selected:
    backgroundColor: "{colors.selection}"
  status-saving:
    textColor: "{colors.secondary}"
    typography: "{typography.mono-xs}"
  status-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    typography: "{typography.body-sm}"
  status-empty:
    textColor: "{colors.muted}"
    typography: "{typography.body-sm}"
  status-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
    typography: "{typography.body-sm}"
  revision-row:
    backgroundColor: transparent
    textColor: "{colors.secondary}"
    typography: "{typography.mono-sm}"
    rounded: "{rounded.sm}"
  tab-pill-active:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    height: 32px
    padding: 0 16px
  tab-pill-inactive:
    backgroundColor: transparent
    textColor: "{colors.secondary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    height: 32px
    padding: 0 16px
---

## Brand & Style

**Inkwell** is the visual identity for Decol Writing Support, a desktop
workbench for writing essays, articles, and academic texts from a decolonial
and anti-colonial perspective, with an AI collaborator.

The metaphor is a writer's desk at night. Decolonial writing is document craft
done with care and weight — the UI should feel like a calm, well-lit desk, not a
monitoring dashboard. Warm charcoal tones stand in for dark paper, text is warm
ink rather than pure white, and the single mint accent behaves like a fountain
pen: used sparingly, for exactly one important action at a time. The emotional
register is focused, trustworthy, and editorial — quiet confidence instead of
urgency.

The **document is the centre of gravity**. The workspace is built around the
manuscript being written; the navigator, the inspector, and the AI are
attendants that step back while the writer works. The AI assistant is a writing
collaborator, not a chat toy: its output renders as serif **document bubbles** —
a surface well with a hairline border — so every reply is clearly
containerized. Machine readouts (token estimates, timestamps, save state) are
set in Geist Mono, like instrument dials on the desk.

## Colors

The palette is warm throughout. Every neutral carries a faint brown undertone —
there is no cool gray, no blue-black, no pure white — so the app reads as
"paper and ink" rather than "tech dashboard". The tokens below are the **dark
theme, which is the app's default**; the light theme is a paper variant of the
same system (mapping at the end of this section).

- **Background (#14120f):** Warm charcoal paper. The entire app sits on this.
- **Surface (#1e1b17):** Cards and panels, one step lighter than the paper.
- **Surface-alt (#282419):** Hover fills, input fields, and nested wells.
- **Border (#3a352c):** Hairline definition between tonal layers.
- **Foreground (#f2ede4):** Warm ink for primary text.
- **Primary (#34d399):** The single accent — restrained mint, luminous enough
  to anchor dark paper. Reserved for the one primary action per screen,
  selected list items, focus rings, and the active tab pill. Text on it is
  deep tea-green (`on-primary` #0d2b22).
- **Secondary (#a8a094):** Warm stone for metadata, inactive pills, captions.
- **Muted (#8a8376):** Placeholders, helper text, and disabled controls only.
- **Error (#f87171):** Soft vermilion for destructive actions and failures.
- **Warning (#fbbf24):** Amber for truncation and caution notes — never for
  actions.

### Interaction states

- **Hover:** fills step up one tonal layer (`surface` → `surface-alt`); text
  steps up (`secondary` → `foreground`); accent buttons step to
  `primary-hover`.
- **Focus:** a 2px ring in the `ring` colour at 50% opacity, always visible,
  never removed. Focus is never indicated by colour alone — focused elements
  also show the ring outline.
- **Selected:** list items and rows fill with the tinted `selection` well and
  switch text to `foreground`.
- **Disabled:** 50%-opacity treatment on controls; text reads `muted`;
  disabled controls keep their hit area but ignore input.
- **Error:** text and 1px borders in `error` on a `surface` well; never bare
  red text on the background.
- **Saving:** quiet — mono type in `secondary` ("Saving…"), a spinner, or the
  stream cursor. "Saved" appears only after persistence is acknowledged.
- **Revision:** history rows and version chips use `mono-sm` in `secondary`
  with 1px `border` outlines; the selected revision fills `selection`.

### Light theme (paper variant)

| Token | Value | Token | Value |
|---|---|---|---|
| background | `#f7f4ef` | foreground | `#1f1b15` |
| surface | `#ffffff` | secondary | `#6b6357` |
| surface-alt | `#f1ece4` | muted | `#948c7e` |
| border | `#e3ddd2` | error | `#b91c1c` |
| primary | `#0f6e5c` | on-primary | `#ffffff` |
| warning | `#b45309` | selection | `#ddeae4` |

Light-theme accent is a **deep teal** — darker and more saturated than the
dark-theme mint, so it holds AA contrast on paper. The user may pick a custom
accent from a preset palette or a colour picker; the app derives a foreground
pair that meets the 4.5:1 target (adjusting the accent's lightness when a
mid-tone would fail both candidates), and preset colours stay inside the warm
family.

## Typography

Three voices, one purpose: UI chrome must stay quiet so the documents can
speak.

- **Geist Sans** (variable) is the interface voice — headings, labels, body
  text, forms, set at a 14px base. Neutral and modern; used at 400/500/600
  only.
- **Geist Mono** (variable) is the instrument voice — token estimates,
  timestamps, counts, save state, revision ids, anything that reports machine
  state. It signals "this is data, not prose".
- **Source Serif 4** (variable) is the document voice — every manuscript,
  draft, and AI-written letter. The **manuscript is set at 18px by default,
  user-adjustable** (a size control, not a zoom hack), with generous leading.
  In chat, assistant output is set at 15px/1.6 inside a surface bubble.

Hierarchy: `headline-lg` for workspace titles, `headline-md` for section
titles, `headline-sm` for card titles, `body-lg`/`body-md` for running UI
text, `caption` for metadata, `label-md`/`label-sm` (500 weight) for buttons
and chips. Headings use tight tracking; body and manuscripts never do.

### Manuscript typography

The manuscript column is a **65–75 character measure**. Inside it:

- **Paragraphs** are `doc-lg` with a full blank line between paragraphs; no
  first-line indent.
- **Headings** step down from the manuscript size (28/22/18px semibold serif),
  always in the document voice — never the UI voice.
- **Tables** take a 1px `border` grid, `surface-alt` header row, and the
  manuscript's serif; cells pad 8px 12px.
- **Quotations** indent 24px with a 2px left rule in `border`; long quotations
  keep the manuscript size.
- **Annotations** (footnote markers, comment anchors) are superscript links in
  `primary`; their notes sit in `doc-sm`.

## Layout & Spacing

The app is a single desktop window (minimum 900×600) with a
**document-centred workspace** on a 4px grid:

- **Left navigator** (240px, collapsible): projects, their documents, briefs,
  sources, and conversations; standalone items keep their place. Collapsed, it
  folds to a slim rail of icons.
- **Centre document pane:** the manuscript, the project brief, or the
  conversation — one focus at a time, capped at the 65–75ch reading measure.
- **Right inspector** (360px, collapsible): Assistant / Sources / Review
  views. It never pushes the document below a readable width — when the
  window narrows, side panels collapse first.

Spacing is an 8px rhythm over a 4px unit: controls are 32px tall (desktop
sizing with ≥28px hit areas everywhere), inputs 36px, card padding 20px, card
gaps 16px, section margins 32px. The app is information-dense on purpose — a
desktop workbench — but never cramped: every card keeps 20px of breathing
room.

### Panel behaviour

- Side panels collapse/expand via labelled buttons (icon + tooltip +
  aria-label); the document pane never drops below ~50ch before panels start
  collapsing.
- Collapse is measured from the **actual container and current panel widths**
  (not a fixed window-width sum): the inspector gives way first, then the
  navigator. A panel that does not fit is never unreachable — its rail opens
  it as an explicit drawer (Escape or the scrim closes it, focus moves into
  the drawer).
- Panels stay mounted while collapsed, focus-hidden, or in focus mode, so
  their local state (project expansion, assistant drafts, scroll position)
  survives; only their presentation changes.
- Panel sizes persist per session; collapsed state persists too. Both
  separators resize with the mouse and with Arrow keys (aria-valuenow on the
  separator).
- The inspector keeps its scroll position per view when switching between
  Assistant / Sources / Review.

### Keyboard navigation

- Tabs, list rows, buttons, and dialogs are reachable with Tab/arrow keys in
  reading order; the tab bar responds to Left/Right arrows.
- Dialogs trap focus, close on Escape, and return focus to their opener.
- Stop/escape always has a keyboard path; destructive actions require an
  explicit dialog confirmation.

## Elevation & Depth

Depth is conveyed by **tonal layering**, not shadows: paper → surface cards →
surface-alt wells, each separated by a 1px `border`. Floating layers (dialogs,
select popovers, dropdowns) step up via a slightly lighter surface and a soft
shadow (`0 4px 16px rgba(0,0,0,0.25)` in dark, `0 4px 16px rgba(31,27,21,0.10)`
in light). Focus is a 2px ring in the primary hue with 50% opacity — never a
glow, never a blur. The active tab pill is flat primary, not a glowing bubble.

## Shapes

The shape language is **editorial**: slightly squared, with softness reserved
for things that should feel tactile. Controls (buttons, inputs, chips) use
8px; cards and dialogs use 12px; pills — status chips, the active tab pill,
the "Latest" jump button — are fully round. 6px exists only for micro
elements. Corners are never mixed within one element, and a 1px border
outlines every container.

## Components

### Buttons
Primary buttons are solid mint with deep tea-green text; hover steps one notch
brighter (`primary-hover`); disabled buttons are `surface-alt` wells with
`muted` text. Ghost and outline buttons are borderless/bordered quiet text
actions. Destructive buttons are solid vermilion with deep vermilion-ink text.
One primary action per screen, maximum.

### Cards
`surface` background, 1px border, 12px radius, 20px padding. Cards hold one
logical unit of data; related units sit 16px apart. Card titles use
`headline-sm`.

### Chat
User messages are compact primary bubbles (8px radius). Assistant messages are
**document bubbles**: surface background, 1px hairline border, serif type at
15px/1.6, capped at 75ch — one reply per bubble, so where a message starts and
ends is always clear. The action rail (regenerate, copy) sits beside each
assistant message as quiet icon buttons. A blinking cursor marks live
streaming.

### Inputs
36px fields on `surface-alt` with 1px borders; textareas share the treatment.
Placeholder text is muted. Focus shows the primary ring. Invalid input uses
the error-state treatment (error border + helper text), never colour alone.

### List items
Navigator rows, thread dropdowns, and version lists list transparently until
hover (`surface-alt` fill); the selected row fills with the tinted
`selection` well. Rows expose destructive affordances on hover only.

### Tab pill
The active tab is a full-round primary pill with on-primary text; inactive
tabs are transparent with secondary text, gaining a hover tint. Arrow-key
navigation moves between tabs.

### Status communication

- **Loading:** quiet placeholders (skeleton rows or "Loading…" in `muted`);
  the layout never jumps when content arrives.
- **Empty states:** one sentence in `muted` plus, where useful, one quiet
  action. Empty states teach; they never scold.
- **Saving/Saved:** mono readouts near the document title; "Saving…" in
  `secondary` while in flight, "Saved" only after the persistence is
  acknowledged. Unsaved changes read "Unsaved" in `secondary`.
- **Interrupted/truncated:** the partial answer stays visible with an amber
  `warning` note; the content is never silently discarded.
- **Recovery:** failed saves keep the user's text editable and show an error
  well with explicit Retry and Discard actions. Startup recovery reports list
  malformed/orphan/conflict material in an expandable banner.
- **Errors:** `status-error` wells — `surface` fill, 1px `error` border,
  readable sentence, and (where useful) one action. No bare red text on
  paper.

### Motion & accessibility

- Motion is functional and short (≤200ms, ease-out): panel slides, dialog
  fades, feedback flashes. Nothing loops except the streaming cursor and
  loading spinners.
- **Reduced motion:** all non-essential animation is disabled when the OS
  requests it (`prefers-reduced-motion`); the cursor stops blinking, spinners
  become static labels where possible.
- **200% zoom:** the layout reflows — panels collapse per the rules above,
  the document column keeps its measure, and no control is clipped or hidden
  behind scroll alone.
- Colour is never the only signal: state changes pair colour with text or
  icon.

## Do's and Don'ts

- Do use the primary accent for exactly one primary action per screen
- Do render AI output as serif document bubbles — surface well, hairline border, one reply per bubble
- Do keep machine readouts (tokens, timestamps, save state, revisions) in Geist Mono
- Do keep the manuscript column at a 65–75ch measure with the serif document voice
- Do keep every control reachable by keyboard, with a visible focus ring
- Don't use cool grays or pure white/black — the palette is warm by contract
- Don't add shadows to cards — define layers with surfaces and 1px borders
- Don't use more than two UI weights (400/600, plus 500 for labels) per view
- Don't mix corner radii within a single element; pills are only for chips,
  the tab pill, and small jump buttons
- Don't show "Saved" before persistence is acknowledged, and never discard
  the user's draft automatically
- Do maintain WCAG AA contrast (4.5:1 for normal text) against `background`
  and `surface` at all times
- Don't place the accent on large surfaces — it is an instrument, not a wall
