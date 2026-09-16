# Repair handoff — state after B20b (next: B20c)

Written 2026-09-16. The tree is VERIFIED GREEN at this checkpoint; nothing
is half-typed. Authoritative per-batch history is the "Repair programme"
section of `docs/IMPLEMENTATION-PROGRESS.md` (B19, B20a, B20b entries at
the end).

---

## 0. One-line kickoff for a fresh session

> Read `docs/REPAIR-CHECKPOINT-B20B.md` in full, then continue the Decol
> Writing Support repair programme from **B20c** using the execution
> discipline in `docs/REPAIR-CHECKPOINT-B16A.md` section 4 (unchanged).
> Do not commit/push/reset/release; preserve all uncommitted and untracked
> work.

---

## 1. Verified state (commands + numbers, run after B20b)

From the project root:
- `npx tsc --noEmit` — OK.
- `npm test` — **538 passed (53 files)**.
- `npm run build` — OK (pre-existing chunk-size warning only).

From `src-tauri`:
- `cargo test --lib` — **89 passed, 1 ignored** (fixture generator).
- `cargo check` — OK.

**Native schema v13; desktop backup format v3** (unchanged since B18).

Known non-failing stderr noise (unchanged): keychain-locked warnings in
`credentialIsolation.test.ts`; one pre-existing React "update while
rendering" warning in `saveAcknowledgement.test.tsx`.

## 2. What B19/B20a/B20b changed (short version)

See the three entries at the end of `docs/IMPLEMENTATION-PROGRESS.md`.
Summary: faithful footnotes + DOCX fidelity with the asset decision (b)
(text-only backups) documented; Unicode-safe literal find/replace with
scoped shortcuts and the Ctrl+K Link-vs-palette resolution; the command
palette rebuilt on the shared dialog primitive with a focus trap, focus
restoration, one active-result model, IME-safe Enter, and stale-response
protection.

## 3. B20c — Panels/accessibility (exact next batch)

Files: `src/components/workspace/WorkspaceShell.tsx`,
`src/components/workspace/InspectorPanel.tsx`,
`src/components/workspace/ProjectNavigator.tsx`, `src/index.css`,
`DESIGN.md`; tests `src/components/__tests__/workspaceShell.test.tsx`
(plus focused tests as needed). This is UI work: load the global
`design-md` skill first and read the project `DESIGN.md` (the design
contract). If the token contract changes, run the Google linter via
`npx -p @google/design.md designmd lint DESIGN.md` (never install it
globally; use the `designmd` bin alias).

Implement (from `docs/REPAIR-CHECKPOINT-B16A.md` section 8):
- Calculate collapse from actual container/panel widths (the current
  heuristic is `window.innerWidth < MIN_CENTRE_WIDTH + 240 + 360`).
- At narrow widths, an explicit Show opens a drawer or a reachable
  one-panel view.
- Move the inspector resize handle to the inner edge.
- Persist both panel widths; add keyboard resizing.
- Preserve panel-local state across collapse/focus mode.
- Restore list markers and visible editor focus.
- Proper inspector tabs, visible keyboard row actions, expanded/current
  navigation state.
- Align reader/editor typography and meaningful muted text with the
  design contract.
- Respect reduced motion.

Tests: 900/1080/1200 CSS px, maximum panel widths, 200% zoom,
keyboard-only use, actual mount/state preservation. Use DESIGN.md tokens.

First three reads:
1. `src/components/workspace/WorkspaceShell.tsx` — layout state,
   `centreNarrow` heuristic, collapse/focus mode, resize handles, widths
   persistence.
2. `src/components/workspace/InspectorPanel.tsx` +
   `ProjectNavigator.tsx` — panel internals, tabs/rows, list markers,
   local state.
3. `src/components/__tests__/workspaceShell.test.tsx` + `DESIGN.md` —
   the existing harness and the design contract.

## 4. After B20c

B21 → B22 in order; the full remaining plan is in
`docs/REPAIR-CHECKPOINT-B16A.md` section 8 (B21 browser parity/derived
indexes; B22 evidence-based evaluation). `docs/REPAIR-CHECKPOINT-B20A.md`
still has the B20b/B20c pointers and the land-mine list.

## 5. Hard constraints (reminder)

- Branch `repair-r1-r11`, version 0.0.4; everything uncommitted; do NOT
  reset/clean/discard/commit/push/release/bump.
- Use the dedicated file tools; never PowerShell content round-trips.
- Isolated/in-memory datasets only; mocked transports; no paid calls.
- Acceptance must exercise the production path (real buttons, real
  stores, real editor where applicable).
- Test-isolation land mines (unchanged): libraryStore content cache,
  applied-proposal ledger, aiOperations registry, briefCache,
  repo.resetSessionState, Tiptap async destroy, jsdom rect stubs.
- Vitest default `findBy*` timeout is 1000 ms; heavy mounts need
  `waitFor(..., { timeout: 5000 })`. Tiptap's `focus()` defers through
  requestAnimationFrame in jsdom — focus the editor DOM directly in tests
  when focus matters. Base UI modals mark outside content
  `aria-hidden`/`data-base-ui-inert` — use text queries for content
  behind a modal, and the `[data-base-ui-focus-guard]` elements to test
  the focus trap.
