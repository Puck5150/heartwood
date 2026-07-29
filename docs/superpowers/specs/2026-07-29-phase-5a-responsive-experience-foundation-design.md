# Phase 5A: Responsive Experience Foundation

**Status:** Approved design
**Date:** 2026-07-29
**Depends on:** Phase 4C note revisions and persistent workspace shell

## Purpose

Phase 5A replaces the current narrow, card-heavy presentation with a
sleek responsive application shell. It adds a coherent theme system,
light/dark/system appearance modes, timer accent choices, and a sliding
Settings drawer without changing the timer state machine or persistence
model.

The timer remains the visual center of gravity and continues independently
of navigation, Settings, notes, history, and revision work. This phase is
an experience foundation: later native break behavior and Flowstate audio
will plug into defined shell locations instead of forcing another layout
rewrite.

## Product Decisions

- Use one continuous app surface rather than a stack of large cards.
- Keep the focus task and timer visually dominant.
- Use a narrow icon-led workspace rail on desktop.
- Move workspace navigation to a compact bottom bar on small screens.
- Keep every existing workspace and active-session action accessible while
  the timer runs.
- Open Settings as a right-side drawer on desktop and a full-width sliding
  panel on small screens.
- Apply and persist settings immediately; do not add a Save button.
- Move the existing focus alarm selector from the idle screen into
  Settings.
- Keep Flowstate music selection on the active timer in its later audio
  phase; do not ship a placeholder or nonfunctional music control now.
- Support seven theme families:
  - Sunlit
  - Cozy
  - Quiet Natural
  - Coastal Air
  - Night Walk
  - Moon Garden
  - Graphite
- Support Light, Dark, and System appearance modes for every family.
- Support Blue, Green, Orange, Red, and Yellow timer accents. Use one
  hand-authored five-color set for Light and one for Dark, then verify
  those ten values against every theme background. Do not create a
  70-value theme-by-accent matrix.
- Default new or unmigrated installations to Sunlit, System, and Blue.
- Preserve the existing selected alarm tone key and value.
- Keep cards at 8 px radius or less. Use cards only for genuine tools,
  repeated records, dialogs, and popovers.
- Use Lucide icons for workspace and tool actions. Icon-only controls need
  accessible names and tooltips.
- Respect reduced-motion preferences.

## Scope

### Application shell

The shell owns presentation and navigation, not session behavior. It
contains:

- Desktop workspace rail
- Mobile bottom navigation
- Current workspace region
- Active timer presentation
- Global nonblocking notices
- Settings trigger and drawer

The shell must render Focus, History, and the contextual Revisions
workspace already introduced in Phase 4C. Revisions remains contextual and
is not promoted to a permanent top-level destination.

On desktop, the rail uses stable icon-button dimensions and keeps labels in
tooltips and accessible names. On mobile, the bottom navigation uses icons
with short visible labels because hover tooltips are unavailable.
`WorkspaceNav.svelte` owns one semantic navigation structure and changes
its arrangement with CSS at the shell breakpoint; do not maintain separate
desktop and mobile navigation trees.

Changing workspaces or opening Settings must not mount, unmount, reset,
pause, or own the session state machine. The existing top-level wall-clock
effect, deadline detection, and completion alarm remain independent of
visible workspace.

### Focus workspace

The active task and timer remain centered in the primary region. Timer
digits use tabular numerals and stable dimensions so ticks cannot shift
surrounding controls.

The primary timer surface provides:

- Current task
- Countdown or flow elapsed time
- Current mode and paused state
- Pause/resume
- Finish action
- Park a thought
- Access to Parking Lot and Session Notes

Desktop keeps Parking Lot and Session Notes in adjacent secondary regions.
Mobile uses a compact tab/disclosure control, but both panels stay mounted
in the DOM while the active tab changes. The inactive panel is hidden from
layout and assistive technology without destroying component-local drafts.
Switching panels must not clear a parked-thought draft, clear note content,
or interrupt either persistence controller.

When History or Revisions is active, the Phase 4C compact timer remains
available. Phase 5A restyles it to match the new shell but does not change
its ownership or behavior.

### Settings drawer

Settings opens from a gear icon anchored to the shell. It slides from the
right on desktop. At the mobile breakpoint it occupies the full app width
and slides over the current workspace.

The drawer:

- Uses one continuous surface with section dividers, not nested cards.
- Keeps the timer running behind it.
- Applies a light scrim to the workspace.
- Closes from its close icon, `Escape`, or a scrim click.
- Traps keyboard focus while open.
- Returns focus to the trigger when closed.
- Uses no visible Apply or Save action.
- Removes its transition when reduced motion is requested.

Phase 5A sections are:

1. **Appearance**
   - Theme family
   - Light/Dark/System mode
   - Timer accent
2. **Audio**
   - Existing focus-completion alarm tone in a dropdown
   - Adjacent icon button for tone preview

The dropdown is an intentional replacement of the current vertical
`ToneSelector.svelte` button list, not merely a relocation of that list.
It preserves the same three stable tone IDs, selected value, preview
behavior, and fallback.

Touch Grass return tones and Flowstate soundscapes are absent until their
own behavior exists.

### Responsive behavior

Use content and interaction breakpoints, not scaled desktop typography.
Font sizes do not scale continuously with viewport width.

Required layouts:

- **Wide desktop:** vertical workspace rail and unconstrained central focus
  surface.
- **Compact desktop/tablet:** rail remains stable while content regions
  reflow without horizontal scrolling.
- **Mobile:** bottom workspace navigation, centered timer, full-width
  Settings panel, and single-column secondary content.

At every supported size:

- Timer digits fit without clipping.
- Long task text wraps or truncates deliberately and never overlaps the
  clock or controls.
- Icon controls retain stable hit areas.
- The on-screen keyboard does not hide the active focus-task or parked-
  thought input.
- The Settings close action remains visible.
- Browser-safe development mode and the Tauri window render the same
  responsive structure.

The minimum supported design viewport for this phase is 360 by 640 CSS
pixels. The Tauri desktop window remains resizable and receives a practical
minimum size after manual verification establishes the smallest usable
desktop shell.

## Theme Architecture

### Typed settings

Add a focused appearance module with closed unions:

```ts
export type ThemeFamily =
  | 'sunlit'
  | 'cozy'
  | 'quiet-natural'
  | 'coastal-air'
  | 'night-walk'
  | 'moon-garden'
  | 'graphite';

export type AppearanceMode = 'light' | 'dark' | 'system';
export type TimerAccent = 'blue' | 'green' | 'orange' | 'red' | 'yellow';
```

The module owns:

- Defaults
- Runtime validators for persisted strings
- System-mode resolution
- Theme metadata used by Settings
- The finite setting-key registry

Components consume validated values. They never interpret arbitrary
settings strings or contain theme-name conditionals.

Use these persisted keys:

| Key | Value |
| --- | --- |
| `themeFamily` | `ThemeFamily` |
| `appearanceMode` | `AppearanceMode` |
| `timerAccent` | `TimerAccent` |
| `selectedToneId` | Existing tone catalog ID |

Do not rename `selectedToneId`; existing installations must retain their
alarm choice.

### Semantic token layer

The app root exposes resolved state through data attributes:

```html
<div
  data-theme="sunlit"
  data-appearance="dark"
  data-timer-accent="blue"
>
```

Theme CSS defines semantic tokens such as:

- `--app-background`
- `--surface`
- `--surface-secondary`
- `--text`
- `--text-muted`
- `--border`
- `--focus-ring`
- `--shadow`
- `--timer-accent`
- `--timer-track`
- `--flow-accent`
- `--break-accent`
- `--danger`

Components use only semantic tokens. They do not reference raw palette
colors or theme-family names.

Each theme supplies one hand-authored light token set and one hand-authored
dark token set. The shared timer palette supplies five hand-authored Light
values and five Dark values; themes do not redefine them. This keeps the
authored surface to 14 theme token sets plus 10 timer colors. Automated
contrast checks validate each timer color against all seven theme
backgrounds in its appearance mode.

`System` resolves through `matchMedia('(prefers-color-scheme: dark)')` and
updates live when the operating-system preference changes. Explicit Light
or Dark ignores later system changes.

This replaces the current `:root` plus dark-media-query-only theme CSS from
scratch. The implementation first moves every existing component onto the
semantic tokens, then adds root data-attribute selectors for explicit
family and appearance overrides. There is no legacy theme override
mechanism to preserve.

### Initialization

The existing `runStartup()` function remains the only startup gate. Add the
three appearance `getSetting()` calls to its existing `Promise.all`
alongside session, parked-thought, and alarm-tone hydration. Apply validated
appearance state before setting the existing `ready` flag. Do not add a
second readiness flag or an independent settings-startup effect.

The neutral loading state may use base tokens, but the user must not see the
full app flash through a wrong theme. Set the Tauri window's static
`backgroundColor` to a neutral color that is acceptable behind both light
and dark loading states so the native webview pre-paint is deliberate
rather than the platform default. Exact native pre-paint matching for a
persisted dynamic theme is not promised in this phase; the themed
interactive shell remains hidden behind the existing readiness gate.

Invalid or removed values fall back independently:

- Invalid theme -> Sunlit
- Invalid appearance -> System
- Invalid timer accent -> Blue
- Invalid alarm tone -> existing default tone

Fallback values are safe in memory. They are not written back merely
because an older or unknown value was read.

## Settings State And Persistence

Add one small settings controller rather than keeping separate persistence
effects in `App.svelte`. It owns current validated values, write status,
system appearance observation, and setting updates. `runStartup()` owns
hydration and passes validated initial values into the controller.

Every update:

1. Applies the new validated value immediately for live preview.
2. Enqueues `setSetting` through the existing shared FIFO write queue.
3. Clears that key's error when its newest requested value persists.
4. Keeps the in-memory choice in place on failure and exposes a quiet
   inline Retry action for that key.

Retry persists the key's current in-memory value. A small per-key request
sequence prevents an older failure from displaying an error after a newer
value has already persisted; it does not implement rollback or a general
optimistic-write framework. Preferences are not user content, so a failed
write does not justify another note/revision-style persistence controller.
A write already in flight is never canceled or reordered.

The controller receives the existing application `writeQueue`; it must not
construct a queue of its own. Settings writes therefore remain ordered with
session, note, revision, and deletion mutations.

`App.svelte` creates one controller per component instance. A component
`$effect` calls the controller's explicit system-appearance subscription
method and returns its unsubscribe function. The controller does not attach
a `matchMedia` listener at module import or hide disposal inside a
module-scope singleton.

Opening and closing Settings does not cancel a pending write. Delete All
Data retains the existing product decision that user preferences are not
deleted.

## Components And Ownership

Expected boundaries:

- `AppShell.svelte`: responsive shell regions and workspace placement.
- `WorkspaceNav.svelte`: one responsive desktop/mobile navigation tree.
- `SettingsDrawer.svelte`: modal drawer behavior and setting controls.
- `appearance.ts`: types, defaults, validation, and system resolution.
- `settingsController.svelte.ts`: current settings, write status/retry, and
  an explicitly disposable system-mode observer.
- `app.css`: theme token definitions and global element defaults.

`App.svelte` remains the session/workspace orchestrator. It passes state and
callbacks into the shell. The shell does not import repository functions,
start intervals, play alarms, or transition sessions.

`AppShell.svelte` owns drawer open/close state because it is transient shell
UI. Phase 5A limits new `App.svelte` wiring to startup hydration, one
settings-controller instance, its observer cleanup effect, and shell props.
Theme option rendering, drawer focus management, and responsive navigation
logic do not land in `App.svelte`.

Do not create a general design-system package. Reuse the existing Lucide
dependency and extract a shared control only when the same behavior and
accessibility contract occur in multiple places.

## Error Handling

- A settings load failure uses validated defaults and shows the existing
  global storage error/retry path.
- A settings write failure keeps the current in-memory preference, marks
  only that key unsaved, and offers Retry.
- A tone-preview failure remains nonblocking and cannot change the selected
  tone or timer.
- A missing theme token is a development/test failure; production falls
  through to the base semantic token.
- Settings errors never pause, reset, or block the timer.
- Workspace navigation errors never dismiss an active timer completion
  decision.

## Accessibility

- All foreground/background token pairs used for body text, controls, and
  timer digits target WCAG AA contrast.
- Focus rings remain visible in every theme, appearance, and timer accent.
- Theme and accent choices include text labels or accessible names and a
  non-color selected state.
- The Settings drawer uses dialog semantics, an accessible title, a focus
  trap, and focus restoration.
- Icon-only controls have stable accessible names and tooltips.
- Mobile navigation exposes the current destination with
  `aria-current="page"`.
- Motion is functional, short, and disabled under
  `prefers-reduced-motion`.

## Testing

### Pure tests

- Validate every allowed appearance value.
- Reject malformed persisted values and apply the specified defaults.
- Resolve System correctly for light and dark media-query results.
- Respond to system changes only while System is selected.
- Prove every theme/mode defines every required semantic token.
- Check all five mode-specific timer accents for WCAG AA contrast against
  every theme background in that mode.
- Preserve the existing alarm tone setting.

### Controller tests

- Accept the already-validated startup settings as initial state.
- Apply a setting immediately and persist it through the injected queue.
- Keep a failed in-memory choice visible and retry its current value.
- Ignore an older failure after a newer value for that key persists.
- Dispose the system media-query listener through the component effect
  cleanup.

### Component and integration tests

- Open and close Settings by trigger, close button, scrim, and `Escape`.
- Trap focus and restore it to the trigger.
- Keep active timer state and tick count unchanged while Settings opens,
  changes values, and closes.
- Use the real shared `TaskQueue` to prove a settings write queues behind an
  in-flight session/note-style mutation and that one queue drain observes
  both; this catches accidentally constructing a settings-only queue.
- Prove `runStartup()` hydrates appearance, alarm, session, and parked
  thoughts behind the existing single `ready` gate.
- Keep Focus, History, and contextual Revisions navigation working.
- Keep Parking Lot and Session Notes accessible during focus and flow.
- Move alarm selection and preview into Settings without changing playback
  behavior.
- Render explicit labels for theme and timer-accent choices.

### Visual and manual verification

Verify Sunlit, Cozy, Quiet Natural, Coastal Air, Night Walk, Moon Garden,
and Graphite in Light and Dark. Verify System in both operating-system
states.

For timer accents, capture all five choices in Sunlit Light and Graphite
Dark as representative visual checks. Automated contrast tests cover the
complete 7 themes x 2 modes x 5 accents matrix.

Capture and inspect at minimum:

- 360 x 640
- 390 x 844
- 768 x 1024
- 1280 x 800
- 1440 x 900

At each size, inspect idle, active focus, paused focus, flow, break,
awaiting decision, History with compact timer, Revisions, and Settings.
Check long tasks, long notes, empty states, errors, keyboard focus, and
reduced motion.

Run the normal repository validation:

```bash
npm run check
npm test
npm run build
cargo check
```

Then verify the same critical states in `tauri dev`, including persistence
across restart and a live timer expiring while Settings, History, and
Revisions are open.

## Non-Goals

Phase 5A does not include:

- Touch Grass or new break-state behavior
- Pre-alarm warnings or native notifications
- Tray controls, global shortcuts, start at login, or compact windows
- Flowstate soundscapes, looping audio, crossfades, or volume controls
- New alarm assets or custom/imported audio
- A music-note control before Flowstate audio exists
- Daily planning, task backlogs, calendar integration, or calendar OAuth
- New session transitions or persistence columns
- Replacing the current timer state machine
- A general-purpose component library

## Acceptance Criteria

Phase 5A is complete when:

1. The approved sleek shell replaces the current card-heavy layout.
2. Desktop and mobile use purpose-built navigation arrangements.
3. All existing user workflows remain reachable and functional.
4. Seven themes each work in Light and Dark, with live System behavior.
5. Five mode-aware timer accents pass the complete automated contrast
   matrix and the representative visual checks.
6. Settings slides cleanly, is keyboard accessible, and never owns timer
   behavior.
7. The existing alarm choice and preview live in Settings and persist.
8. Invalid settings fall back safely; failed writes retain their in-memory
   choice and expose a working per-key retry.
9. Timer expiration remains correct and audible in every workspace and
   while Settings is open.
10. Automated checks and the specified responsive Tauri verification pass.
