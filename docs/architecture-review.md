# Heartwood — Architecture Review

*Response to `heartwood-project-brief.md`, structured around the brief's own Section 22 request.*

**Document purpose:** this is Claude's review of the brief, for the user to bring back into the ChatGPT conversation before implementation starts, per the collaboration model in Section 21.

**A note on currency:** several judgments below (macOS media APIs, Tauri's capability system, Windows code-signing rules, Wayland limitations) depend on ecosystem details that move fast. Checked against current docs and issue trackers as of July 2026 — worth a quick re-check before Phase 7–9 if there's a long gap between this review and building those parts. Sources are listed at the end.

---

## Where this differs from the brief

| Topic | Brief's default | This review |
|---|---|---|
| Revision history | Bespoke "simpler than Git" system now; real Git deferred as advanced/later (§9.4, §17) | Open question, not a settled call — your own framing ("version controlled") suggests you may want real Git from day one. See §8. |
| Rust footprint | Nine named Rust "services" from the start (§9) | Keep Phase 1–4 almost entirely in Svelte/TypeScript; only pull logic into Rust when Tauri's security model or OS integration forces it. See §5. |
| Global quick-capture | Assumed to work via a global keyboard shortcut everywhere (§6.2, §11.3) | Doesn't work on Wayland at all — a protocol-level restriction, not a Tauri bug. Needs a fallback designed in from Phase 1. See §2.1. |
| macOS media control | Treated as one of three roughly-equal platforms (§12.2) | Materially higher risk since macOS 15.4 locked down `MediaRemote`. Scope as best-effort, build last, disclose clearly. See §2.2. |
| Living docs | Nine separate docs maintained from day one (§20) | Consolidate into ~3 (architecture+threat+privacy+data model in one file, testing.md, ADR log) until any one section outgrows it. See §3. |
| Encryption | "Assess before public release" (§11.7) | Agree with deferring — and there's no drop-in encrypted-SQLite plugin in the Tauri ecosystem, so budget real implementation time when you get there. See §2.5. |

---

## 1. Overall assessment

- **Yes, technically realistic.** Tauri 2 + Svelte + Rust + SQLite is a proven combination for exactly this kind of app — small, local-first, cross-platform utility. Every individual piece (timer-by-timestamp, Markdown notes, SQLite metadata, capability-scoped windows) is well-trodden; nothing here requires inventing new techniques.
- **Stack is appropriate**, with one caveat: the brief reaches for Rust more than an MVP needs. Tauri *requires* Rust for the shell (window/tray/capability management is unavoidable), but the component list in §9 puts business logic — parking lot, notes, revisions, even early storage — into named Rust "services" before there's a UI to drive them. I'd invert that; see §5.
- **The brief already did the hard part of self-critique.** It explicitly asks me to challenge the Rust-timer assumption, the SQLite/file duplication risk, premature encryption, and the repo structure. Most of what follows is disagreement about *sequencing and degree*, not direction.
- **The one thing I'd push back on hardest isn't technical.** "Version controlled" — your words, describing the project — gets quietly downgraded to a bespoke revision system, with real Git deferred as "advanced" (§9.4, §17). That's a product-scope question more than an engineering one. See §8.

---

## 2. Top technical risks

Ranked by how much each could undercut the product if not planned for early — not the brief's original order.

### 2.1 Wayland breaks the app's core pitch (not called out in the brief)

Global keyboard shortcuts fundamentally don't work on Wayland — it's a deliberate compositor restriction (apps can't read key events while unfocused), not a Tauri gap that's about to get patched. Tauri's `global-shortcut` plugin only works reliably on X11 today; the relevant Wayland protocol proposal has stalled. Wayland is the default compositor on most current Linux desktops now (GNOME and KDE both default to it).

This hits the headline UX directly: "type a thought, hit Enter, snap back to what you were doing" (§4.1) depends on that global hotkey. On a Wayland desktop it just won't fire.

**Recommendation:** design a fallback from Phase 1, not Phase 5 — ship a small CLI/IPC entry point (e.g. `myapp --capture`) that the user binds to their own desktop environment's shortcut settings (every major DE supports custom commands on a key combo). Document this as the Linux answer instead of promising a universal global hotkey.

Related, smaller wrinkle: tray icons need `libayatana-appindicator` (preferred) or the older, largely unmaintained `libappindicator3`. Vanilla GNOME doesn't render third-party tray icons without a Shell extension for the AppIndicator/KStatusNotifierItem protocol. There are also still-open Tauri 2 issues about tray icons failing to appear under GNOME+Wayland specifically in dev/`.deb` builds (fine in AppImage). Test on a real Wayland GNOME session early, not just X11.

### 2.2 macOS media integration is riskier than the brief assumes

The brief already flags this as needing research (§12.2) — the research says: harder than a "likely limited adapter."

Apple hardened `MediaRemote.framework` in macOS 15.4 so only Apple-entitled processes can read now-playing data directly. Every third-party "now playing" tool had to move to indirect workarounds: driving an entitled system binary (community-maintained Perl-based adapters are the current approach), or AppleScript/JXA automation (simpler, but no artwork and polling-based updates). None of this is Apple-sanctioned, all of it can break on any macOS update without notice, and it's explicitly incompatible with Mac App Store distribution — fine, since the brief targets direct/notarized distribution, not the Store.

**Recommendation:** keep macOS media control fully optional and last-built. The brief already sequences it last (Phase 7) — good instinct, just weight it as meaningfully higher-risk than Windows/Linux, not equal. State plainly in the privacy/capability docs that it's best-effort and may stop working after an OS update.

### 2.3 Timer reliability — mostly solved by the brief's own design, with one gap

The wall-clock-timestamp model (§9.1, not decrementing an integer) is the right call and avoids most classic bugs (sleep, DST, missed ticks).

The gap: a *hidden* window (minimized to tray) isn't guaranteed to keep running. There's an open Tauri issue of hidden webviews on Windows going away after roughly 50 minutes while the Rust backend keeps running — right in the range of a real focus or flow session. This doesn't break timer *accuracy* (remaining time is always recomputed from persisted timestamps, never trusted from a running counter) — but it can break the *notification* that's supposed to fire when the planned interval ends, if that logic lives only in the frontend.

**Recommendation:** put exactly one thing in Rust for this reason — a scheduled callback keyed off the persisted `planned_end_at` that fires the OS notification / wakes the window, independent of whether the webview is alive. Leave the rest of the timer math (remaining-time display, pause/resume while visible) in the frontend.

### 2.4 Note storage / revision duplication

The brief already flags this as needing a decision (§10.5) rather than assuming an answer — agreed that it needs a firm one. Concrete recommendation in §5; the revision-storage mechanism specifically is an open question in §8.

### 2.5 Encryption — lower risk than it looks, but no free lunch

Agree with deferring (§11.7) — key-lifecycle bugs in encrypted local storage are genuinely nasty to recover from.

One correction to plan around: Tauri's official SQL plugin has no built-in SQLCipher support (it's been a standing, unresolved feature request for years). The official encrypted-storage plugin, Stronghold, is a secrets/key vault (IOTA Stronghold-backed) — the right tool for provider tokens or a derived key, not a drop-in encrypted replacement for the sessions/notes database. If the main DB gets encrypted later, budget for hand-wiring `sqlx` + SQLCipher rather than expecting a config flag to do it.

### 2.6 Packaging and signing — mostly cost/process, not technical

- **macOS:** Apple Developer Program ($99/yr) + notarization — well-trodden, no surprises.
- **Windows:** two things worth knowing changed recently. Since March 2024, EV certificates no longer give instant SmartScreen reputation — EV and standard (OV) certs now both build reputation the same way, through download volume over time, so there's no security reason to pay EV prices just to dodge the "Unknown Publisher" warning. Since June 2023, all certificate private keys must live on a hardware token or HSM industry-wide — the old "download a .pfx and sign locally" flow is gone. For a GitHub Actions pipeline, Microsoft's cloud-HSM signing service (Azure Artifact Signing, formerly Trusted Signing) is built for exactly this — no physical token to pass between build agents.
- **Linux:** no signing requirement in the same sense; the open decision is packaging format (AppImage vs. `.deb`/`.rpm` vs. Flatpak) — worth an explicit ADR rather than an implicit choice.

---

## 3. Overengineering concerns — what I'd delay or simplify

- **Nine named Rust "services" (§9) before Phase 1 ships anything.** Timer Engine, Parking Service, Note Service, Audio Controller, Revision Service, Storage Service, Tray Service, Shortcut Service, Update Service — that's a services-oriented decomposition for an app without a UI yet. Start with two or three real modules (a thin `commands` layer, `storage`) and let further Rust-side structure emerge once Phase 5+ actually needs tray/shortcut/native code.
- **Nine living docs from day one (§20).** Real process overhead to keep in sync for a project still proving its core loop. Fold architecture + threat model + privacy model + data model into one `architecture.md` with clear sections; split a section out only once it outgrows the file. Keep the ADR log from day one though — that one's cheap and pays for itself early.
- **The capability-based `MediaProvider` abstraction (§9.5) is *not* overengineering**, flagging this since it's the kind of thing that's tempting to cut — three genuinely different platform backends plus generated-sound and local-file providers are all coming eventually; the abstraction is justified now rather than retrofitted later. Keep it.
- **Repo structure (§14) pre-declares a taxonomy the code doesn't fill yet** — `components/{timer,parking-lot,notes,audio,history,settings,layout}`, `stores/`, `services/`, `types/`, `routes-or-views/`, mirrored on the Rust side, plus a three-way test split before there's a single test. Start flatter (a handful of files under `src/lib/`) and let folders appear once a category actually has enough in it to need one.
- **Revision-service policy (§9.4) is more than an MVP needs** — checkpoint on session end, named checkpoint, before-restore, before-overwrite, and "after a configurable period of meaningful change" is five triggers before you know which ones you'll actually use. Start with two — end of session, and an explicit "save checkpoint" — and add the rest only if you find yourself wanting them.

---

## 4. Recommended MVP

The brief's own MVP list (§16) is already close to right — twelve items, no platform-polish requirement, offline-capable. Two adjustments:

- **Pull Markdown notes out of the very first slice.** Notes + revisions is a genuinely separate subsystem from timer + parking lot. Ship "start a session, park thoughts, finish, see a review screen, data survives a restart" as the first testable milestone — that alone validates or invalidates the core hypothesis (flow-friendly Pomodoro + frictionless capture). Notes can be the next slice, not bundled into the first.
- **Prototype the UI before wiring up Tauri at all.** A Svelte/Vite frontend runs fine as an ordinary browser app. Build and iterate on the timer + parking-lot interaction there first — faster reload, no Rust toolchain or WebView2 install needed to validate the UX — then add the `src-tauri` shell once the interaction is settled. This is consistent with the brief's own Phase 1 description ("in-memory state only," §15); worth being explicit that Phase 1 doesn't need Tauri installed at all.

Revised first slice:
1. Enter a task, start/pause/resume a wall-clock-timestamp timer, no persistence.
2. Park a thought from the main window (global shortcut and quick-capture window arrive in a later phase).
3. Timer-complete decision screen (break / flow / finish).
4. Flow mode counts up.
5. End-of-session review screen listing parked thoughts.

Everything else in §16 (persistence, notes, deletion, offline) is right — just one phase later than "the very first thing that runs."

---

## 5. Architecture recommendations

**Frontend/backend boundary:** default to Svelte/TypeScript. Move something into Rust only when one of these is true: Tauri's permission model already requires the operation to go through a Rust command (filesystem writes, for instance); the feature is inherently OS-native (tray, global shortcuts, media session APIs); or there's a measured reliability reason (the notification-scheduling case in §2.3). Everything else — parking lot CRUD, note CRUD, timer math, session review — is frontend state talking to SQLite through Tauri's SQL plugin.

**Timer ownership:** source of truth is persisted timestamps in SQLite, not any particular process. The frontend computes "remaining" from those timestamps whenever it's visible; Rust owns exactly one thing — the scheduled end-of-interval callback from §2.3. Neither side needs to "own" a ticking clock.

**State representation — answering the brief's own §9.1 question:** yes, model it as a strict state machine, but be careful where you enforce it. The proposed `sessions` table (§10.1) is a flat set of nullable timestamp columns (`paused_at`, `flow_started_at`, `completed_at`, all nullable) — that shape allows invalid combinations (e.g. `flow_started_at` set while `status = 'PAUSED'`) even though SQL itself has no opinion about it. Keep the wide nullable-column table for storage — normal and fine for SQL — but define the *in-memory* representation as a tagged union, one variant per state, each carrying only the fields valid for that state:

```text
SessionState
├── Idle
├── Focusing         { started_at, planned_end_at }
├── Paused           { started_at, planned_end_at, paused_at, accumulated_pause_ms }
├── AwaitingDecision  { started_at, planned_end_at, focus_completed_at }
├── Flow             { started_at, flow_started_at }
├── Break            { started_at, break_started_at }
└── Complete         { started_at, completed_at, ... }
```

One (de)serialization function converts between this and the flat SQL row. Illegal combinations become unrepresentable in code, even though SQLite still stores a wide table.

**Storage model — answering §10.5:** Markdown files are the single source of truth for note *content* — matches the brief's own "portable, inspectable" principle (§4.4). SQLite holds metadata only (path, title, revision pointers), never a duplicate copy of current content. This resolves the sync-bug risk the brief itself raises. See §8 for how *revisions specifically* should be stored.

**State management:** native Svelte stores (writable/derived) are enough — no need for a heavier state library. The brief doesn't propose one; I wouldn't add one either.

**Testing approach:** write the timer's remaining-time calculation as a pure function of `(now, state) → remaining`, tested with zero Tauri/UI involvement. That's what makes the sleep/DST/clock-change tests in §19.1 cheap to write instead of requiring a running app per case.

---

## 6. Security review

The posture in §11 is already solid — least-privilege capabilities, no shell exec, strict CSP, Markdown sanitization, no embedded HTML by default, logging redaction. A few confirmations and gaps:

- **Confirmed buildable as designed:** Tauri 2's capability system supports exactly the per-window scoping §11.3 asks for (the quick-capture window getting only "create a thought, close" permissions) — capabilities attach to specific window labels, and a window only gets the union of what's explicitly attached to it. Not aspirational; this is how the system already works.
- **Gap — DB scope per window:** the brief doesn't mention scoping database access per window. Worth adding once notes/parking-lot commands are split across windows — quick-capture shouldn't carry the same DB scope as the main window, even though both eventually touch `parking_lot_items`.
- **New surface from the Wayland fallback (§2.1):** the CLI/IPC entry point for triggering quick-capture is a new attack surface that didn't exist in the brief's original design. Scope it to exactly one action (open quick-capture) — same least-privilege treatment as everything else in §11.3.
- **Update mechanism:** Tauri's official updater plugin does signature verification out of the box — consistent with §11.8's "signed update metadata" requirement. No custom work needed beyond generating and safeguarding the signing keypair.
- **Licensing (§18):** if a license-validation network call is added later, an offline-verifiable key or a check-once-and-cache model keeps it consistent with §11.2's "optional, explicitly enabled, revocable" requirement — avoid anything that phones home on every launch.
- **Encryption, restated from §2.5:** deferring is right; when you get there, plan for hand-rolled `sqlx` + SQLCipher (no official plugin support) plus Stronghold for secrets/tokens specifically.

---

## 7. Platform-specific concerns

**Windows**
- Media session integration: `GlobalSystemMediaTransportControlsSessionManager` (WinRT) via the `windows` crate — standard, well-supported path.
- Code signing: see §2.6 — Azure Artifact Signing over a traditional EV cert for a CI/CD-driven release process.

**macOS**
- Media integration: see §2.2 — best-effort, build last, disclose the fragility.
- Everything else (notarization, tray via `NSStatusItem`, global shortcuts) is standard Tauri territory — no special concerns.

**Linux**
- Wayland breaks global shortcuts entirely (§2.1) — needs a designed fallback, not a later patch.
- Tray icon support needs `libayatana-appindicator` (preferred) or `libappindicator3` (older, largely unmaintained, missing on some distros) — worth checking at first run and telling the user what's missing rather than failing silently.
- MPRIS (the standard D-Bus media-control interface) is the right target for reading/controlling other players — mature, stable spec, well-supported from Rust.
- Packaging format is an open decision (§7 above) — AppImage is the least friction for a first release (no distro-specific packaging, works everywhere); `.deb`/`.rpm`/Flatpak can follow.

---

## 8. Open questions

1. **Git or bespoke revisions?** You described this to me as a notepad that's *version controlled* — the brief treats real Git integration as an advanced, later feature and proposes a simpler built-in revision system for the MVP (§9.4, §17). Both are defensible:
   - *Bespoke snapshot store* (content-addressed, hash + timestamp, no external dependency): matches the brief's "simpler than Git" MVP instinct, avoids pulling `libgit2` — a real C dependency with cross-compilation cost — into the riskiest early phase, and migrates cleanly into a real git repo later since it's just files on disk.
   - *Real Git from day one* (`git2-rs` / libgit2 bindings — not a shelled-out `git` binary, which the brief's own §11.3 rules out): gives real diffing, real history, and tooling you already know, at the cost of a heavier dependency and more moving parts while the core product is still unproven.
   - My lean is the snapshot store first, structured so it can become a real git repo without a data migration — but this is genuinely your call, and it hinges on what "version controlled" meant when you wrote that. Worth resolving with ChatGPT before Phase 4.
2. **Linux packaging format** — AppImage-first, or commit to `.deb`/Flatpak from the start? (§7)
3. **Store distribution vs. direct** — the brief assumes direct/notarized distribution throughout. Worth an explicit ADR either way, partly because Windows Store distribution would eliminate the code-signing question entirely (§2.6) at the cost of store review and revenue share.
4. **Solo dev or eventual collaborators?** Some of the process overhead flagged in §3 (nine services, nine docs) makes more sense if a team is coming later than if this stays a solo project — worth stating the assumption explicitly since it changes how much structure to build ahead of need.

---

## 9. Proposed first implementation milestone

**Deliverable:** a plain Svelte/Vite web app (no Tauri yet) implementing the revised first slice from §4.

**Acceptance criteria:**
- Enter a task name, start a focus session with a chosen duration.
- Timer computed from a stored start timestamp + planned duration, not a decrementing counter — verify by changing the system clock mid-session and confirming the display recovers correctly.
- Pause/resume works and correctly accumulates paused time across repeated cycles.
- Park a thought from a text input in the main window; the parked-thoughts list updates immediately.
- On timer completion, the three-way decision screen appears (break / flow / finish) and each choice transitions state correctly.
- Flow mode counts up from zero and can be paused or finished.
- End-of-session screen shows planned duration, flow duration, total elapsed, and the parked-thought list.
- Invalid state combinations are unreachable (ties to §5's tagged-union recommendation) — verified by unit tests on the pure timer/session-state functions, not just manual clicking.

**Suggested structure for this slice only** (expand later, per §3):
```text
src/
├── lib/
│   ├── session.ts        (state machine + pure timer math, unit-tested)
│   ├── ParkingLot.svelte
│   ├── Timer.svelte
│   ├── DecisionScreen.svelte
│   └── SessionReview.svelte
├── App.svelte
└── main.ts
```

**Tests to include:** normal completion, pause/resume (including repeated cycles), invalid-transition rejection, clock-change recovery, midnight/DST crossing — all doable as pure-function unit tests against `session.ts`, no browser or Tauri needed. Pulled from the brief's own §19.1 list, scoped to what's testable at this stage.

**Explicitly out of scope for this milestone:** Tauri shell, SQLite, notes, tray, global shortcuts, audio, any platform-specific code. Those remain Phase 2 onward, per the brief's own phasing (§15) — this milestone doesn't change that sequence, just narrows what "Phase 1" produces.

---

## Sources checked for this review

- Wayland global-shortcut limitation: `tauri-apps/global-hotkey` issue #28; `tauri-apps/tao` issue #307
- macOS `MediaRemote` lockdown (15.4+): Apple Feedback Assistant report FB17228659; `ungive/mediaremote-adapter` and related Rust wrappers
- Tauri 2 capabilities / per-window scoping: `v2.tauri.app/security/capabilities/`; `v2.tauri.app/learn/security/capabilities-for-windows-and-platforms/`
- Hidden-webview reliability: `tauri-apps/tauri` issue #14088
- SQLCipher / Stronghold ecosystem state: `tauri-apps/plugins-workspace` issues #7 and #2528; `v2.tauri.app/plugin/stronghold/`
- Windows code-signing changes (EV/SmartScreen, HSM mandate, Azure Artifact Signing): Microsoft Learn — `windows/apps/package-and-deploy/smartscreen-reputation` and `.../code-signing-options`
- Linux tray dependencies: Tauri v1 system-tray docs; `tauri-apps/tauri` issue #14234
