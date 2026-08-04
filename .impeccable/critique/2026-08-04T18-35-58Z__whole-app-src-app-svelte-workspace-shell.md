---
target: whole app (src/App.svelte + workspace shell)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-08-04T18-35-58Z
slug: whole-app-src-app-svelte-workspace-shell
---
## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Mode labels, paused state, live-region announcements, checkpoint status — excellent |
| 2 | Match Between System and Real World | 4 | "Plant a thought," "Touch Grass," "Quiet overtime" — natural, embodied language |
| 3 | User Control and Freedom | 3 | Good pause/resume/cancel coverage; no confirm/undo on deleting a single planted thought |
| 4 | Consistency and Standards | 3 | Undefined `--surface-raised` token breaks Soundscape popover states; "End session" uses danger styling for a non-destructive action |
| 5 | Error Prevention | 3 | Excellent for sessions/notes (hash-checked conflicts, safety snapshots); weak for planted-thought deletion |
| 6 | Recognition Rather Than Recall | 2 | Icon-only desktop nav/Settings/Soundscape trigger; text-only Theme/accent pickers, no swatches |
| 7 | Flexibility and Efficiency of Use | 2 | No keyboard shortcuts for start/pause/finish; no bulk actions in History; no recent-task list |
| 8 | Aesthetic and Minimalist Design | 3 | Mostly clean; Review screen is dense; idle screen under-designed |
| 9 | Help Recognize/Diagnose/Recover from Errors | 4 | Plain-language, specific, actionable errors everywhere |
| 10 | Help and Documentation | 1 | No in-app help, no first-run guidance, everything lives in the external README |
| **Total** | | **29/40** | **Good** (upper-Acceptable/lower-Good band) |

## Design Specificity Verdict

**The copy is specific to this product. The visual chrome is not — and the detector independently confirms this split.**

The design-review pass (reading every major component) found the *words* genuinely authored for Heartwood: "plant a thought"/"Greenhouse", "Touch Grass" as an intermission type, flow/break-specific color tokens, completion-prompt copy that reads like it was written by someone who understands a distracted, anxious brain. But strip the strings and colors and the layout underneath — flat cards, stock `lucide-svelte` icons, a system-font stack, unstyled number spinners — is the same visual vocabulary any small productivity app uses. There's no plant/leaf/growth motif anywhere; the "Greenhouse" tab is a plain text label with no icon, styled identically to "Notes" next to it.

The deterministic scanner corroborates this independently, without having read the design-review's conclusion: it flagged a **side-tab accent border** (`MarkdownPreview.svelte:75`, the single most recognizable AI-generated-UI tell), a **flat type hierarchy** (10 distinct font sizes compressed into a 1.6:1 ratio — no real scale), and **undersized functional text** (History's stat labels render at 10.88px, under a reasonable 11px floor) — all textbook "generic small-app" patterns, not something reaching for a specific identity.

**Verdict stands: the words are specific, the interface is category-interchangeable.**

## Overall Impression

This is a well-engineered, unusually safety-conscious app (hash-verified note conflicts, pre-destructive safety snapshots, a genuinely rigorous 7-family×2-mode×5-accent token system with an automated contrast test) wearing a generic productivity-app skin. The single biggest opportunity is closing the gap between how much craft went into the *words* and the *token architecture* versus how little of that shows up visually — the Greenhouse metaphor, the theme system's depth, and the emotional peak of finishing a session are all currently under-expressed in pixels relative to what's already built underneath them.

## What's Working

1. **Data-safety UX is a real differentiator.** Explicit conflict-resolution choices, automatic pre-destructive safety-snapshot revisions, and never-silently-wiped drafts on save failure — for a tool whose whole pitch is "your notes live on your machine," this earns trust directly.
2. **Product-specific vocabulary.** "Plant a thought," "Touch Grass," "Quiet overtime" — copy that couldn't be lifted into an unrelated app unchanged.
3. **A disciplined token/theme architecture** — 7 theme families × 2 appearance modes × 5 timer accents, all semantic custom properties, with a contrast-completeness test referenced in the code. Most small apps hardcode a light/dark toggle; this one built a real system.

## Priority Issues

**[P1] Icon-only desktop nav with no visible labels**
What: the nav rail, Settings trigger, and Soundscape ("flow-state music") trigger all hide their text labels ≥640px, leaving only icons + hover tooltips.
Why it matters: a first launch gives a new user 4-5 unlabeled icons to decode by trial or hover, on what the README calls the primary (desktop) target.
Fix: give Settings and the Soundscape trigger a persistent visible label on desktop, not just a tooltip.
Command: `clarify`

**[P1] Undefined `--surface-raised` token breaks Soundscape popover interaction states**
What: `SoundscapePopover.svelte` references `var(--surface-raised)` three times (music-trigger hover/active, playback-action button, preset-list hover/selected) — this custom property is never declared anywhere in `app.css` or any theme block.
Why it matters: across all 14 theme/appearance combinations, these three interactive states silently lose their intended background.
Fix: declare `--surface-raised` in the token sets, or point these three at the already-defined `--surface-secondary`.
Command: `harden`

**[P2] No confirmation or undo for deleting a single planted thought**
What: deleting one planted thought (Review screen or the front-page list) is instant with no confirm and no undo — while History's individual-session delete and delete-all both get a two-step inline confirm with explicit consequence copy.
Why it matters: inconsistent with the app's own otherwise-excellent data-safety posture; a stray click permanently loses a captured idea, the exact thing Greenhouse promises not to lose.
Fix: reuse History's inline-confirm pattern, or add an Undo toast.
Command: `harden`

**[P2] Settings' Theme and Timer-accent pickers are text-only, no visual preview**
What: 7 theme names and 5 color names, listed as plain radio labels, no swatch.
Why it matters: exceeds the ~4-item working-memory guideline for one decision point, and forces recall instead of recognition — for a *color* picker that shows no color.
Fix: add a small color-swatch chip per label; the tokens already exist per theme.
Command: `colorize`

**[P2] Timer progress bar animates `width`, causing layout thrash — confirmed by both static scan and live DOM across every state tested**
What: `Timer.svelte:164`'s `.progress-fill` transitions `width`; the detector caught this both in the static CLI scan and independently on every single live page state (desktop and mobile).
Why it matters: layout-property animation is real jank risk, and it's consistent enough to show up on every page.
Fix: this is very likely resolved as a side effect of the already-planned arc/ring timer redesign — when that ships, drive it with `stroke-dashoffset` (transform-adjacent, no layout recalculation) rather than width, so the new shape doesn't reintroduce the same issue.
Command: `optimize`

**[P3] "End session" styled as a destructive/danger action**
What: the overtime prompt's "End session" button uses `.danger` styling (`var(--danger)`) — the same red used for real errors and destructive deletes.
Why it matters: ending a successful focus session is this app's peak moment; coloring it as a warning undercuts the payoff at exactly the wrong instant.
Fix: neutral/secondary styling; reserve `--danger` for genuinely destructive/error states.
Command: `quieter`

**[P3] History's stat labels render below a reasonable minimum size, in a flat type scale**
What: the `dt` labels ("Focus"/"Planned"/"Total"/"Planted") measure 10.88px live in the browser; the page as a whole uses 10 distinct font sizes compressed into a 1.6:1 ratio with no real hierarchy.
Why it matters: undersized functional text is a legibility risk, and a flat scale is part of why the interface reads generic (see Design Specificity above).
Fix: bump stat-label size slightly; define 3-4 deliberate type steps instead of ad hoc sizes.
Command: `typeset`

## Detector False Positives (excluded from the above)

Three `text-occlusion` findings on the History page were traced to the detector overlapping its own leftover annotation badges from a prior scan pass, not real app content — confirmed by the "occluded" text literally reading a truncated fragment of the detector's own rule name. Discarded.

## Persona Red Flags

**Jordan (first-timer)**
- The entire desktop nav rail, Settings, and Soundscape trigger are icon-only ≥640px — nothing to read, only hover-and-guess.
- The idle front page shows nothing at all when there are no planted thoughts yet — zero hint the Greenhouse feature exists until stumbled into mid-session.
- The Theme picker's 7 unlabeled-by-preview options force guessing what "Coastal Air" looks like before committing.

**Sam (accessibility-dependent, screen reader + keyboard)**
- Credit where due: correctly-implemented ARIA tabs with roving tabindex/arrow keys in three components, global `:focus-visible` outlines, `aria-live` regions for timer/intermission state.
- The same icon-only nav/Settings/Soundscape triggers rely on `title`/`aria-label` for their accessible name but have no persistent *visible* text — fine for a screen reader, but a low-vision user zoomed to 200% (tooltips are unreliable under zoom) gets nothing on-screen to read.
- The completion prompt is deliberately nonmodal and announces itself once via `aria-live`; if focus is elsewhere when that one-shot fires, there's no persistent landmark pointing back to it.

**Alex (power user)**
- No keyboard shortcuts anywhere for start/pause/resume/finish — every core action requires a mouse click.
- History supports only one-by-one delete or delete-everything — no bulk selection.
- No recent-task list or autocomplete; every session starts by retyping the task name from scratch.

## Minor Observations

- The "Greenhouse" tab has no icon, while nearly every other actionable element uses a `lucide-svelte` icon — a small leaf icon here would reinforce the metaphor cheaply.
- The Review screen's "Session review" eyebrow + stats-only presentation reads administrative next to the warmth of "Plant a thought"/"Touch Grass" copy elsewhere — a missed chance to close the loop emotionally.
- The Soundscape popover's border/shadow treatment (1px border + 30px blur) reads as a generic "AI-slop" pattern per the detector's advisory flag — likely fine as-is, worth a quick look alongside the `--surface-raised` fix since you'll already be in that file.
- The detector flagged a small "FOCUSING" kicker sitting above the "Write report" task heading as a recognizable AI-UI pattern on every active-timer state (desktop and mobile) — this may just be a legitimate mode-label/eyebrow, not a real defect; worth a deliberate look rather than an automatic fix.
- The detector reported the primary rendered font as 100% "Roboto" — this may be a rendering-environment artifact (system-ui resolving to Roboto in that Chromium build) rather than something the app forces; independent of the specific font name, it supports the broader point that there's no typographic personality distinguishing the brand.
- `app.css`'s `:root` fallback duplicates the Sunlit/light theme values verbatim by design — a future edit to Sunlit/light risks drifting from `:root` since nothing enforces they stay in sync.
- Number inputs (duration fields) use bare browser-default spinners, visually out of step with the rest of the crafted controls.

## Questions to Consider

1. If Greenhouse is the emotional core of the interruption-handling feature, why does it never appear as an icon, illustration, or growth motif anywhere in the UI?
2. The theme system supports 35+ rigorously contrast-tested combinations, but the picker is a flat list of text radios — what if choosing a theme felt as considered as building the theme system evidently did?
3. The Review screen is the one moment a finished session gets acknowledged, and it opens with the word "review" and a stats table — what would this screen look like designed as a payoff instead of a receipt?
4. Every core action requires a mouse click — for a tool whose pitch is "sit down and focus," what does it mean that a full session can't be run start-to-finish without leaving the keyboard?
5. "End session" is colored the same red as a save failure — is ending a successful focus session actually a danger, or does that color choice quietly send the wrong signal?
