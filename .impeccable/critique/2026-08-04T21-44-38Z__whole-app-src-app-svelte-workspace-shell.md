---
target: whole app (src/App.svelte + workspace shell)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-04T21-44-38Z
slug: whole-app-src-app-svelte-workspace-shell
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Compact timer bar, live-region announcements, checkpoint status |
| 2 | Match Between System and Real World | 4 | Coherent gardening metaphor throughout, specific voice ("Go for a frickin' walk.") |
| 3 | User Control and Freedom | 4 | Pause/resume/cancel everywhere; planted-thought delete now has a confirm step |
| 4 | Consistency and Standards | 3 | Inconsistent duration-error copy (idle vs. review); fragmented end-of-session vocabulary (6 near-synonymous labels) |
| 5 | Error Prevention | 3 | Strong confirm-before-delete coverage, but destructive buttons look identical to benign links until clicked |
| 6 | Recognition Rather Than Recall | 2 | Icon-only nav; 7-option Theme picker with no preview |
| 7 | Flexibility and Efficiency of Use | 2 | No keyboard shortcuts, no duration presets, no task autocomplete despite History storing every past task |
| 8 | Aesthetic and Minimalist Design | 3 | Timer itself restrained; Focus/Flow states expose 4 simultaneous interactive clusters at once |
| 9 | Error Recovery | 3 | Excellent for storage/persistence; idle-screen duration field fails with zero explanatory text |
| 10 | Help and Documentation | 1 | "Quiet overtime," Flow, Greenhouse, Touch Grass all introduced with no in-app explanation |
| **Total** | | **29/40** | **Good** — same total as the first run, composition shifted (3 fixed, ~4 new) |

## Design Specificity Verdict

**This round's read leans more positive than the first, and it's worth being honest about why rather than just taking the more flattering number.** The design review found stronger direct evidence this pass — "Go for a frickin' walk." in the Touch Grass intermission, seven evocative (not generic) theme names, the recently-shipped removal of red/danger styling from "End session" reinforcing a deliberate non-punitive philosophy — and concluded the product now reads as authored, not interchangeable.

The deterministic scanner's signal is **unchanged from the first run**: the same side-tab border, the same flat type scale, the same "overused font" and undersized-text findings. That's expected — none of today's three fixes touched typography, borders, or the visual system, so there was nothing for the detector to move. The honest synthesis: the *copy and structural philosophy* read as more specific on a deeper pass, but the *visual chrome* genuinely has not changed and the original critique's verdict on it still holds.

## What Changed Since the Last Run

**Fixed and confirmed:**
- ✅ **Undefined `--surface-raised` token** — confirmed live: the Soundscape popover's preset-row hover and the nav-rail trigger's active state both now render a visible background box in screenshots, matching the corrected token.
- ✅ **No confirm/undo on deleting a planted thought** — this round's design review scored heuristic 3 (User Control) a full point higher specifically because this gap is closed.
- ✅ **"End session" danger styling** — this round's review cited the removal directly as evidence of the app's deliberate non-punitive design philosophy, rather than flagging it as an inconsistency.

**Unchanged (not in this round's fix scope):**
- Icon-only desktop nav/Settings/Soundscape labels
- Theme/Timer-accent pickers, text-only, no preview
- Progress bar's `width` transition (CLI + live DOM, identical finding both runs) — still expected to resolve with the planned arc/ring redesign
- History's stat labels at 10.88px in a flat 10-size type scale

**New this round** (found on a deeper pass, not regressions):
- **[P1] No in-app explanation of core mechanics.** "Quiet overtime," Flow, Greenhouse, and Touch Grass are all genuinely novel concepts introduced with zero contextual help anywhere in the running app — a first-timer hits the overtime prompt with three unexplained choices right after an alarm just played.
- **[P2] Idle-screen duration field fails silently.** Invalid duration disables Start with no error text, while the structurally identical field on the Review screen explicitly explains itself ("Enter a whole number of minutes between 1 and 180"). One of two duration inputs in the app doesn't follow the pattern the other already established.
- **[P2] Destructive actions are visually indistinguishable from benign links until the confirm click.** Delete session, delete thought, delete revision history, and delete-all all use `.link.danger { color: var(--text-muted) }` — the same muted gray as Cancel. The confirm step is a solid backstop, but there's no visual "this is destructive" signal before that first click.
- **[P3] Focus/Flow states expose four simultaneous interactive clusters** — Timer, Step Away, Greenhouse, and Notes are all expanded and interactive at once during the one state where the app's own stated purpose ("one task, one timer") argues hardest for minimalism.
- **Accessibility gap**: switching workspaces (Focus → History → Revisions) fires no `aria-live` announcement, unlike the app's own intermission-announcement pattern that already does this correctly elsewhere — an inconsistency, not a new class of problem.

## False Positives (excluded above)

The 2 `text-occlusion` findings on the History/Settings/Soundscape states are the same class identified as false positives in the first run: the "occluded" text is literally a truncated fragment of the detector's own rule name ("undersized functional te…"), not real app content. Discarded again. The 4 repeated `undersized-ui-text` findings across History/Settings/Soundscape are one underlying element (the History stat row) persisting off-screen across states, not four independent bugs.

## Persona Red Flags (new/updated this round)

**Jordan (first-timer)**: hits "Quiet overtime" — a genuinely novel, undefined mechanic — right after an alarm, with three choices and zero explanation of what any of them mean or why the timer didn't just stop.

**Sam (accessibility)**: workspace navigation swaps the visible region with no `aria-live` announcement, unlike the app's own well-built intermission-announcement pattern that isn't reused here — a screen-reader user gets no confirmation "History" actually loaded.

**Alex (power user)**: still no keyboard shortcuts anywhere, still no task autocomplete despite every past task already living in History.

## Questions to Consider

1. If quiet overtime is the branding, should the *first* automatic transition be silent, reserving the alarm for repeated ignored check-ins?
2. The product's thesis is "one task, one timer" — why do Greenhouse and Notes stay fully expanded through the whole session instead of being opt-in during the state where distraction is most costly?
3. Delete-all is one click away from unrecoverable loss, styled identically to Cancel — is same-color text enough friction for something genuinely irreversible?
