# Front-Page Parked Thoughts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Let an idle user start a fresh focus session from either a typed task or any unresolved parked thought.

**Architecture:** Keep the idle page as the single session-entry surface. Extract the common fresh-focus transition into a small `App.svelte` helper, and render unresolved thoughts through a compact presentation component whose only action is Start. Consume a thought only after the session transition succeeds, then serialize its database deletion through the existing write queue.

**Tech Stack:** Svelte 5, TypeScript, Vitest, Testing Library, Tauri, SQLite.

## Global Constraints

- Preserve all Phase 5B timer, notification, review, history, and note behavior.
- Show all unresolved parked thoughts, including thoughts whose original session was deleted.
- Use the idle duration field for both typed and parked starts.
- A parked thought must remain visible and persisted when validation or the start transition fails.
- Parked-thought recovery failure must not disable typed-task starts.
- Session recovery failure must disable every fresh-session start.
- Do not reuse the review-only promotion handler, which has note-flush and carry-forward semantics.
- Keep the idle layout compact, responsive, accessible, and visually consistent with the current application.

### Task 1: Characterize The Idle Entry Workflows

**Files:**
- Modify: `src/App.test.ts`

- [x] Add a test proving unresolved parked thoughts appear beside the typed-task form.
- [x] Add a test proving Start uses the parked text and current idle duration.
- [x] Assert the successfully started thought is removed and its queued persistence deletion runs.
- [x] Run the focused test and confirm it fails because the idle chooser does not exist.

### Task 2: Implement Successful Parked Starts

**Files:**
- Create: `src/lib/IdleParkedThoughts.svelte`
- Modify: `src/App.svelte`

- [x] Add a compact, accessible list of unresolved thoughts with one Start action per row.
- [x] Extract a shared fresh-focus helper used by typed and parked starts.
- [x] On successful parked start, remove the thought in memory and enqueue its database deletion.
- [x] Run the focused test and confirm it passes.
- [x] Refactor only while tests remain green.

### Task 3: Protect Failure And Recovery Paths

**Files:**
- Modify: `src/App.test.ts`
- Modify: `src/App.svelte`

- [x] Add a failing test proving an invalid duration retains the thought and does not enqueue deletion.
- [x] Add or strengthen coverage proving parked-thought recovery failure does not block a typed start.
- [x] Add or strengthen coverage proving returning from Review to the start page exposes unresolved thoughts.
- [x] Add the minimal guards required by those tests.
- [x] Run the focused tests after each behavior reaches green.

### Task 4: Document The Completed Entry Point

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [x] Explain that the start page supports a new task or an unresolved parked thought.
- [x] Record the PR #14 follow-up in the current changelog section.

### Task 5: Verify The Integrated Change

**Files:**
- Review all changed files.

- [x] Run `npm run check`.
- [x] Run `npm test -- --run`.
- [x] Run `npm run build`.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [x] Run `git diff --check`.
- [x] Exercise the idle workflow at desktop and mobile widths and inspect screenshots for clipping, overlap, and awkward layout shifts.
- [x] Review the final diff for scope, duplication, recovery behavior, and accidental generated changes.
