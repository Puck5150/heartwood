# Heartwood
## Product, Architecture, Security, and Build Brief for Claude Code

**Document purpose:**  
This brief gives Claude Code the current product context, proposed architecture, security posture, phased implementation path, and collaboration expectations for the Heartwood project.

Claude should treat this as a starting design, not an unquestionable specification. The first requested task is to assess the design, identify risks or unnecessary complexity, and recommend improvements before generating a large amount of code.

---

## 1. Product Summary

**Heartwood** is a cross-platform desktop focus workspace designed to help users:

1. Start a focused work session with minimal friction.
2. Capture distracting thoughts without changing context.
3. Continue working when they reach a genuine flow state instead of being forced into a break.
4. Control focus music or another audio application from the same interface.
5. Maintain session-linked notes with autosave and optional revision history.
6. Keep their personal data local and private.

The target platforms are:

- Windows
- macOS
- Linux

The application should be a polished, launchable desktop executable with a graphical interface, native installers, system-tray behavior, notifications, global keyboard shortcuts, and reliable recovery after sleep or restart.

---

## 2. Core Product Idea

Traditional Pomodoro timers interrupt the user at a fixed interval, even when the user has finally reached a productive flow state.

Heartwood changes the workflow:

```text
Start a focus session
        |
        v
Work on one clearly defined task
        |
        +--> Distracting thought appears
        |         |
        |         v
        |    Park it immediately
        |    without switching tasks
        |
        v
Timer reaches zero
        |
        +--> Take a break
        +--> Finish the session
        +--> Continue in flow mode
```

The parking lot is not intended to become another full task-management system. It is a temporary capture area that allows the user to stay on task.

---

## 3. Product Positioning

The application should feel like a **local-first focus workspace**, not merely another countdown timer.

A concise product promise:

> Start your focus session, park intrusive thoughts, create working notes, and remain in flow without losing anything.

A concise privacy promise:

> Your attention, thoughts, notes, and work history belong to you. The core application works locally and does not require surveillance to be useful.

---

## 4. Product Principles

### 4.1 Low friction

Starting a session should require very little setup.

Parking a thought should require:

1. Open quick capture.
2. Type the thought.
3. Press Enter.
4. Return immediately to the prior application.

### 4.2 Flow-friendly

When a planned focus interval ends, the application should not automatically force a break.

The user should be offered:

- Take a break
- Continue in flow
- Finish the session

Flow mode should count upward from the end of the planned interval and use gentle, configurable check-ins instead of repeated disruptive alarms.

### 4.3 Local-first

The core application should work fully offline.

The initial product should require:

- No account
- No cloud service
- No internet connection
- No telemetry
- No advertising
- No behavioral analytics

### 4.4 User ownership

Users should be able to:

- Export their data
- Delete their data
- Delete notes and all associated revisions
- Inspect stored information
- Use portable note formats
- Disable network-dependent features

### 4.5 Small, understandable system

Avoid unnecessary frameworks, plugins, services, and dependencies.

The application should be built in phases so that each major subsystem can be understood, tested, and replaced independently.

---

## 5. Intended Users

The initial design is particularly useful for people who:

- Struggle to begin work
- Experience ADHD-related distraction or time blindness
- Use Pomodoro timers but dislike forced interruptions
- Frequently lose focus when switching to another app to record a thought
- Prefer local tools over cloud productivity platforms
- Want lightweight notes connected to focus sessions
- Listen to music, ambient audio, or noise while working

The product should not make medical or therapeutic claims. It may be described as ADHD-friendly or designed with ADHD-related workflows in mind, but it should not claim to treat ADHD.

---

## 6. Core User Workflows

### 6.1 Start a focus session

The user:

1. Enters a short description of the current task.
2. Chooses or accepts a focus duration.
3. Optionally chooses a note.
4. Optionally chooses an audio source.
5. Starts the session.

### 6.2 Park a thought

During a session, the user can:

- Use the parking-lot input in the main interface.
- Use a global keyboard shortcut to open a small quick-capture window.
- Enter a thought and press Enter.
- Return automatically to the previous application.

The application records the timestamp and associated focus session automatically.

### 6.3 Timer completion

At the end of the planned focus interval:

```text
Focus check

Your planned session is complete.

[ Take a break ]
[ Continue in flow ]
[ Finish session ]
```

### 6.4 Flow mode

When the user chooses flow mode:

- Music continues unless configured otherwise.
- The timer changes from countdown to elapsed extension time.
- The application records planned focus time and flow-extension time separately.
- Optional gentle reminders can occur after a configurable interval.
- The user can pause or finish at any time.

### 6.5 Session review

At the end of the session, the user sees:

- Planned focus duration
- Flow duration
- Total elapsed time
- Session note
- Parked thoughts

Each parked thought can be:

- Deleted
- Kept for later
- Converted into a note
- Added to the current note
- Carried into another session
- Exported or copied

### 6.6 Session-linked notes

The user can:

- Create or open a Markdown note.
- Attach it to the current session.
- Edit it during the session.
- Autosave changes.
- Create named checkpoints.
- Review and restore older revisions.
- Disable revision history for selected notes.

### 6.7 Audio control

The user can choose between:

- A compatible system media player
- Local imported audio
- Generated noise or ambient sound

The initial system-player integration should support, where the operating system and player permit:

- Current track and artist
- Album artwork
- Play and pause
- Previous and next
- Volume
- Open the original player
- Select among detected media sessions

Searching streaming catalogs and selecting arbitrary tracks is a later provider-specific feature, not an initial requirement.

---

## 7. Proposed Technology Stack

### 7.1 Primary stack

- **Desktop framework:** Tauri 2
- **UI:** Svelte with TypeScript
- **Desktop/backend logic:** Rust
- **Local structured storage:** SQLite
- **Notes:** Markdown files
- **Editor:** CodeMirror 6 or another focused Markdown editor
- **Audio fallback:** Rust audio library such as Rodio
- **Optional local Git support:** libgit2 through Rust bindings, later
- **Build and release automation:** GitHub Actions or equivalent

### 7.2 Why this stack

Tauri is proposed because the application needs:

- Windows, macOS, and Linux builds
- Native installers
- System tray integration
- Notifications
- Global shortcuts
- Controlled filesystem access
- Signed update support
- A smaller runtime footprint than a typical Electron application

Svelte is proposed because the interface is expected to be compact and state-driven without requiring a large frontend framework.

Rust is proposed for the authoritative timer, native integrations, security-sensitive operations, storage access, and audio control.

SQLite is proposed because the product is local-first and contains structured relationships among sessions, parked thoughts, settings, notes, and revisions.

Markdown is proposed because it is portable, inspectable, and usable outside the application.

### 7.3 Design assumption to challenge

Claude should specifically assess whether the authoritative timer must live in Rust in the first implementation or whether a TypeScript timer using persisted wall-clock timestamps is sufficient until tray/background requirements are added.

The design should avoid using Rust merely because Tauri supports it. Rust should be used where it creates a clear reliability, security, or platform-integration benefit.

---

## 8. Proposed High-Level Architecture

```text
┌──────────────────────────────────────────────────────────┐
│                    Svelte Interface                      │
│                                                          │
│ Timer | Parking Lot | Notes | Audio | History | Settings │
└──────────────────────────┬───────────────────────────────┘
                           │ Tauri commands and events
┌──────────────────────────▼───────────────────────────────┐
│                      Rust Core                           │
│                                                          │
│ Timer Engine       Parking Service    Note Service       │
│ Audio Controller   Revision Service   Storage Service    │
│ Tray Service       Shortcut Service   Update Service     │
└──────────────┬─────────────────┬─────────────────────────┘
               │                 │
┌──────────────▼───────┐  ┌──────▼────────────────────────┐
│       SQLite         │  │        Local Files            │
│                      │  │                               │
│ Sessions             │  │ Markdown notes                │
│ Parked thoughts      │  │ Imported audio                │
│ Note metadata        │  │ Exported backups              │
│ Revisions/settings   │  │ Optional local Git repository │
└──────────────────────┘  └───────────────────────────────┘
```

---

## 9. Major Components

### 9.1 Timer engine

Responsibilities:

- Start, pause, resume, finish, and cancel sessions
- Persist actual timestamps
- Calculate remaining time from wall-clock timestamps
- Recover after application restart
- Recover after computer sleep
- Transition into break, flow, or completion states
- Emit events to the UI
- Coordinate optional audio behavior

The timer must not depend on decrementing an integer once per second.

Conceptual model:

```text
remaining = planned_end_timestamp - current_timestamp
```

Suggested states:

```text
IDLE
  |
  v
FOCUSING <----> PAUSED
  |
  v
AWAITING_DECISION
  |        |        |
  v        v        v
BREAK     FLOW    COMPLETE
            |
            +----> PAUSED
            +----> COMPLETE
```

Claude should assess whether this should be a strict finite-state machine and recommend a representation that prevents invalid transitions.

### 9.2 Parking-lot service

Responsibilities:

- Fast item creation
- Session association
- Timestamping
- Status changes
- Quick-capture window
- End-of-session review
- Conversion into notes or future items
- Retention and deletion

The parking lot should not become a complex task manager in the MVP.

### 9.3 Notes service

Responsibilities:

- Create and load Markdown notes
- Autosave safely
- Associate notes with sessions or projects
- Maintain metadata
- Create useful revision checkpoints
- Compare and restore revisions
- Export notes
- Delete notes and associated history

Embedded HTML and executable content should be disabled or sanitized.

### 9.4 Revision service

Default revision behavior should be simpler than Git.

Create revisions at meaningful boundaries:

- End of focus session
- Named checkpoint
- Before restoring another version
- Before overwriting an imported note
- After a configurable period of meaningful change

Do not create a permanent revision for every keystroke.

Actual Git integration should be an advanced, optional future feature.

### 9.5 Audio controller

Use a capability-based provider abstraction.

Conceptual interface:

```text
MediaProvider
├── detect_players()
├── capabilities()
├── get_now_playing()
├── play()
├── pause()
├── previous()
├── next()
├── set_volume()
├── open_player()
├── list_playlists()   optional
├── search()           optional
└── play_item()        optional
```

Potential providers:

- Windows system media sessions
- Linux MPRIS
- macOS adapter
- Local audio provider
- Generated sound provider
- Future provider-specific connectors

The UI must hide unsupported controls instead of pretending every provider supports the same operations.

### 9.6 Storage service

Responsibilities:

- Database initialization and migrations
- Atomic writes
- Consistent deletion behavior
- Export and import
- Backup and restore
- Data-location reporting
- Optional encryption at rest

### 9.7 Security service or security boundaries

Security should primarily come from architecture and least privilege, not a single “security module.”

Responsibilities and boundaries include:

- Tauri capabilities
- Content Security Policy
- File access scoping
- Secret storage
- Input validation
- Markdown sanitization
- Update verification
- Logging policy
- Dependency and release integrity

---

## 10. Proposed Data Model

This is intentionally preliminary.

### 10.1 Sessions

```text
sessions
├── id
├── task_name
├── status
├── started_at
├── planned_end_at
├── paused_at
├── accumulated_pause_ms
├── focus_completed_at
├── flow_started_at
├── completed_at
├── planned_focus_ms
├── actual_focus_ms
├── flow_duration_ms
├── break_duration_ms
├── note_id
└── created_at
```

### 10.2 Parking-lot items

```text
parking_lot_items
├── id
├── session_id
├── text
├── status
├── created_at
├── resolved_at
├── converted_note_id
└── carried_to_session_id
```

### 10.3 Notes

```text
notes
├── id
├── title
├── file_path
├── revision_enabled
├── created_at
└── updated_at
```

### 10.4 Note revisions

```text
note_revisions
├── id
├── note_id
├── session_id
├── revision_type
├── description
├── content_or_snapshot_reference
└── created_at
```

### 10.5 Settings

Settings may begin as a typed table or serialized configuration object, but security-sensitive values should not be stored in plain application settings.

```text
settings
├── key
├── value
├── type
└── updated_at
```

Claude should assess whether note contents should live in SQLite, Markdown files, or both, and recommend a design that avoids synchronization bugs between database metadata and file contents.

---

## 11. Security and Privacy Requirements

Security is a first-class product requirement.

### 11.1 Privacy defaults

The core application must:

- Work fully offline
- Require no account
- Include no analytics SDK
- Include no advertising SDK
- Include no tracking pixels
- Upload no notes, tasks, audio history, or usage data
- Keep crash reporting disabled unless the user deliberately creates a diagnostic package
- Avoid storing listening history unless the user explicitly enables it

### 11.2 Network behavior

The core features should require no network access.

Potential network features must be:

- Optional
- Explicitly enabled
- Clearly described
- Separated from local features
- Revocable by the user

Potential future network features:

- Manual or optional update checks
- Optional encrypted sync
- Optional provider account connections
- Optional license validation, designed to minimize data collection

### 11.3 Least privilege

Use the smallest possible Tauri capability set.

Do not include:

- Arbitrary shell execution
- Unrestricted filesystem access
- Remote web content with native application permissions
- Broad home-directory scanning
- Unnecessary plugins

The quick-capture window should have permission only to create a parked thought and close itself.

### 11.4 Content security

- Ship all executable UI code with the application.
- Do not load remote JavaScript.
- Use a strict Content Security Policy.
- Treat Markdown and pasted content as untrusted input.
- Disable embedded HTML by default.
- Sanitize rendered Markdown.
- Block script execution and unsafe URL schemes.
- Never execute code blocks.

### 11.5 Logging

Logs must never include:

- Note contents
- Parked-thought contents
- Current task names
- Encryption keys
- Passwords
- Provider tokens
- Git credentials
- Full private filesystem paths
- Listening history

Logs should be local, short-lived, rotatable, and user-deletable.

### 11.6 Data deletion

The application must support:

- Delete one parked thought
- Delete one session
- Delete one note
- Delete a note and all revisions
- Delete all application data
- Clear logs
- Clear imported audio references
- Disconnect provider accounts and remove tokens

Revision history must not silently retain content after the user believes it has been deleted.

### 11.7 Encryption

Before public release, assess:

- SQLCipher or another encrypted SQLite approach
- Operating-system credential vaults
- Optional application lock
- Backup and restore behavior
- Password changes
- Key recovery
- Cross-platform support
- Migration safety

Do not add encryption until the key lifecycle and recovery behavior are well tested.

### 11.8 Updates and release integrity

Public releases should eventually include:

- Signed Windows installer
- Signed and notarized macOS release
- Signed or checksummed Linux artifacts
- Signed update metadata
- SHA-256 checksums
- Dependency lockfiles
- Software bill of materials
- Secret scanning
- Dependency vulnerability scanning
- Protected production signing credentials

### 11.9 Threats to consider

- Malicious Markdown or pasted HTML
- Malformed imported audio
- Path traversal
- Broad filesystem permissions
- Compromised dependency
- Tampered update
- Sensitive content in logs
- Local unauthorized access
- Deleted content remaining in revisions
- Accidental Git publication
- Provider-token theft
- Signing-key compromise

### 11.10 Honest boundaries

The application cannot fully protect user data if:

- The operating-system account is compromised
- Malware is running with the same user privileges
- An attacker can read process memory
- The user exports data to an insecure location

These limitations should be stated honestly.

---

## 12. Audio Integration Strategy

### 12.1 MVP audio scope

The initial release should not attempt to become a streaming service.

Start with:

1. Generated ambient sound or noise
2. Local user-selected audio
3. System media controls where practical

### 12.2 System-player controls

Initial desired controls:

- Detect active compatible player
- Display current track and artist
- Display artwork if already exposed by the player
- Play or pause
- Previous or next
- Adjust volume where supported
- Open the original media application

Platform expectations:

- Windows: system media session APIs
- Linux: MPRIS
- macOS: likely an adapter with more limited or application-specific behavior

Claude should research and recommend the most maintainable macOS strategy before implementation.

### 12.3 Provider-specific integrations

Spotify, Apple Music, YouTube Music, and similar services should be treated as optional later integrations.

Do not assume that commercial API terms permit a monetized playback-control application.

Provider integrations may add:

- Playlist browsing
- Search
- Track selection
- Queue management
- Device selection

Any provider connection must:

- Use official authentication
- Avoid receiving the user’s password
- Store tokens in OS-protected storage
- Request minimal permissions
- Be removable
- Be disclosed in the privacy dashboard

---

## 13. User Interface Structure

### 13.1 Compact focus mode

Designed to remain visible beside the user’s primary work.

```text
┌───────────────────────────────────────┐
│ Heartwood                  │
├───────────────────────────────────────┤
│ Working on                            │
│ [ Current task_____________________ ] │
│                                       │
│                18:42                  │
│               FOCUSING                │
│                                       │
│       [ Pause ]       [ Finish ]       │
│                                       │
│ Now playing: Focus playlist           │
│        [ ◀ ] [ ▶/Ⅱ ] [ ▶ ]            │
│                                       │
├───────────────────────────────────────┤
│ Park a thought                        │
│ [ Type and press Enter_____________ ] │
│                                       │
│ 3 thoughts parked                     │
└───────────────────────────────────────┘
```

### 13.2 Full workspace mode

```text
┌──────────────┬──────────────────────────────┬──────────────┐
│ Focus        │                              │ Audio        │
│ Parking Lot  │         Timer area           │ controls     │
│ Notes        │                              │              │
│ History      │ Current task                 │──────────────│
│ Settings     │                              │ Session Lot  │
│              │ Markdown note editor         │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

The user should be able to hide side panels.

### 13.3 Quick-capture window

```text
┌──────────────────────────────────────┐
│ Park a thought                       │
│                                      │
│ [ Type thought____________________ ] │
│                                      │
│ Enter to save            Esc to close│
└──────────────────────────────────────┘
```

This window should disappear immediately after saving and return focus to the previously active application.

---

## 14. Proposed Repository Structure

```text
heartwood/
├── src/
│   ├── components/
│   │   ├── timer/
│   │   ├── parking-lot/
│   │   ├── notes/
│   │   ├── audio/
│   │   ├── history/
│   │   ├── settings/
│   │   └── layout/
│   ├── stores/
│   ├── services/
│   ├── types/
│   ├── routes-or-views/
│   └── App.svelte
│
├── src-tauri/
│   ├── src/
│   │   ├── timer/
│   │   ├── parking/
│   │   ├── notes/
│   │   ├── audio/
│   │   ├── storage/
│   │   ├── security/
│   │   └── lib.rs
│   ├── capabilities/
│   └── migrations/
│
├── static/
│   ├── icons/
│   └── audio/
│
├── docs/
│   ├── product-brief.md
│   ├── architecture.md
│   ├── threat-model.md
│   ├── privacy-model.md
│   ├── decisions/
│   └── testing.md
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── end-to-end/
│
└── .github/
    └── workflows/
```

Claude should recommend changes if this creates artificial separation or excessive early structure.

---

## 15. Proposed Build Path

The project should be implemented in small, testable vertical slices.

### Phase 0: Architecture review

Before generating the application:

1. Assess the proposed stack.
2. Identify technical risks.
3. Identify overengineering.
4. Recommend architecture changes.
5. Identify platform-specific blockers.
6. Recommend the smallest credible MVP.
7. Produce a decision list for user approval.

Do not generate the entire codebase during this phase.

### Phase 1: Interaction prototype

Goal:

- Validate the timer and parking-lot workflow in a simple Svelte interface.

Features:

- Current task field
- Start, pause, resume, reset
- Wall-clock-based timer
- Parking-lot capture
- Timer completion decision
- Flow mode
- In-memory state only

### Phase 2: Desktop shell and local persistence

Features:

- Tauri application
- SQLite initialization
- Persistent settings
- Persistent sessions
- Persistent parked thoughts
- Crash and restart recovery
- Basic desktop window behavior

### Phase 3: Session review and history

Features:

- Session completion screen
- Parked-thought processing
- Focus and flow duration history
- Basic settings
- Data deletion
- Export

### Phase 4: Notes

Features:

- Markdown editor
- Autosave
- Session-linked notes
- Named checkpoints
- Basic revision history
- Compare and restore
- Revision deletion

### Phase 5: Native desktop behavior

Features:

- System tray
- Global quick-capture shortcut
- Notifications
- Compact and workspace modes
- Start-at-login option
- Single-instance behavior

### Phase 6: Audio fallback

Features:

- Generated ambient sound or noise
- Local imported audio
- Looping
- Play, pause, volume
- Timer-linked audio behavior

### Phase 7: System media integration

Features:

- Windows media session adapter
- Linux MPRIS adapter
- macOS strategy based on prior research
- Capability-driven controls
- Privacy-safe now-playing display

### Phase 8: Security hardening

Features:

- Finalized Tauri capabilities
- Strict CSP
- Markdown sanitization
- File import validation
- Log redaction tests
- Dependency scanning
- Security tests
- Threat-model review
- Optional encryption design and prototype

### Phase 9: Packaging and release

Features:

- Windows installer
- macOS packages
- Linux packages
- Signing
- Notarization
- Checksums
- SBOM
- Release workflow
- Optional updater
- Privacy and security documentation

---

## 16. MVP Definition

A credible first MVP should allow the user to:

1. Launch the desktop application.
2. Enter a current task.
3. Start a focus timer.
4. Pause and resume.
5. Park thoughts during the session.
6. Continue into flow mode.
7. Finish the session.
8. Review parked thoughts.
9. Save a Markdown session note.
10. Close and reopen the app without losing the session or data.
11. Delete stored data.
12. Use the core application without an internet connection.

The MVP does not require every target platform to be equally polished on day one, but the architecture must avoid intentionally blocking cross-platform support.

---

## 17. Explicit Non-Goals for the Initial Product

Do not include initially:

- Mandatory user accounts
- Cloud synchronization
- Team collaboration
- Employer productivity reporting
- Advertising
- Behavioral analytics
- Mobile applications
- Website blocking
- AI analysis
- Complex project management
- Full replacement for Obsidian, Notion, or Todoist
- Streaming-service catalog search
- Remote Git hosting
- Gamification
- Subscription infrastructure
- Automatic collection of crash reports

---

## 18. Monetization Assumptions

The application may be commercial and proprietary.

Current preferred posture:

> Proprietary, local-first desktop software with a public privacy and security specification.

Possible later model:

- Paid desktop license
- Free trial
- Optional paid major upgrades
- Optional recurring services only for features with recurring costs, such as encrypted sync or licensed audio packs

The product should not monetize:

- User behavior
- Notes
- Listening activity
- Focus history
- Advertising profiles
- Employee surveillance

Open sourcing may be reconsidered later, but it is not an initial requirement.

---

## 19. Testing Strategy

### 19.1 Timer tests

Test:

- Normal completion
- Pause and resume
- Repeated pause cycles
- Sleep and wake
- Application restart
- System clock change
- Daylight-saving changes
- Crossing midnight
- Flow transition
- Cancel and reset
- Invalid state transitions

### 19.2 Parking-lot tests

Test:

- Fast capture
- Duplicate submissions
- Empty input
- Large input
- Unicode
- Keyboard shortcut behavior
- Focus returning to prior app
- Session association
- Deletion
- Conversion into notes

### 19.3 Notes tests

Test:

- Autosave
- Interrupted writes
- Recovery
- Revision creation
- Compare and restore
- Revision deletion
- Malicious Markdown
- Large notes
- External file changes
- Import and export

### 19.4 Audio tests

Test:

- Missing player
- Multiple players
- Unsupported control
- Track changes
- Player closing
- Sleep and wake
- Audio device changes
- Malformed imported media
- Volume behavior
- Timer-linked playback

### 19.5 Security tests

Test:

- Tauri permission boundaries
- Path traversal
- Untrusted Markdown
- Unsafe URLs
- Secret leakage
- Log redaction
- Update verification
- Data deletion
- Revision deletion
- Token removal
- Dependency vulnerabilities

### 19.6 Cross-platform tests

At minimum, maintain a platform matrix for:

- Windows 11
- Supported macOS versions on Intel and Apple Silicon where practical
- At least one mainstream Linux distribution
- Wayland and X11 considerations where relevant

---

## 20. Documentation and Decision Records

Maintain:

- Product brief
- Architecture overview
- Threat model
- Privacy model
- Data model
- Build and release process
- Testing strategy
- Platform capability matrix
- Architecture Decision Records

Suggested ADR topics:

- Tauri versus Electron
- Rust versus TypeScript timer authority
- SQLite versus file-only storage
- Markdown file storage strategy
- Revision model
- Encryption approach
- Media integration abstraction
- Update policy
- Licensing and activation
- Telemetry prohibition

---

## 21. Collaboration Model: User, ChatGPT, and Claude Code

The user will work with both ChatGPT and Claude Code.

The expected workflow:

1. ChatGPT and the user refine product intent, UX, requirements, and tradeoffs.
2. Claude Code reviews the repository and implementation details.
3. Claude identifies risks, alternatives, and practical constraints.
4. The user brings Claude’s recommendations back to ChatGPT.
5. Decisions are recorded in project documentation or ADRs.
6. Implementation proceeds in small, reviewable increments.
7. The user runs and tests each increment.
8. Bugs and UX observations are brought back to both systems as needed.

### Collaboration rules

- Do not silently change major architecture decisions.
- Record significant design decisions.
- Prefer small commits and focused patches.
- Do not generate an opaque full application in one step.
- Explain the purpose and shape of each subsystem.
- Keep the user involved in testing and decisions.
- Do not replace user learning with unexplained code generation.
- Preserve privacy and security requirements when suggesting shortcuts.
- Do not introduce telemetry or remote services without explicit approval.
- Do not assume a streaming-service integration is legally or commercially permitted.
- Do not add dependencies without explaining their purpose and cost.
- Treat this document and recorded ADRs as the shared source of truth.

---

## 22. Requested Initial Response from Claude

Before implementing code, Claude should respond with an architecture review containing:

1. **Overall assessment**
   - Is the product technically realistic?
   - Is the proposed stack appropriate?

2. **Top technical risks**
   - Cross-platform behavior
   - Timer reliability
   - Media integration
   - Note storage and revisions
   - Encryption
   - Packaging and signing

3. **Overengineering concerns**
   - Which parts should be delayed?
   - Which proposed abstractions are premature?

4. **Recommended MVP**
   - The smallest useful vertical slice
   - What should be built first
   - What should explicitly wait

5. **Architecture recommendations**
   - Frontend/backend boundary
   - Timer ownership
   - Storage model
   - State-management approach
   - Testing approach

6. **Security review**
   - Immediate security requirements
   - Features that create avoidable risk
   - Recommended Tauri capability strategy
   - Privacy-preserving update and licensing options

7. **Platform-specific concerns**
   - Windows
   - macOS
   - Linux
   - System media support

8. **Open questions**
   - Decisions that require the product owner’s input

9. **Proposed first implementation milestone**
   - Deliverables
   - Acceptance criteria
   - Suggested repository structure
   - Tests to include

Claude should challenge assumptions where appropriate and explain tradeoffs clearly. It should not begin a broad implementation until the architecture review is discussed and the first milestone is approved.

---

## 23. Current Product Decisions

The following decisions are currently preferred but may be challenged with a strong technical reason:

- Desktop-first application
- Cross-platform target
- Tauri 2
- Svelte and TypeScript UI
- Rust for native or security-sensitive functionality
- SQLite local storage
- Markdown notes
- Simple built-in revision history before Git
- System media control before provider-specific integrations
- Local-first and offline-capable
- No analytics
- No advertising
- No mandatory account
- Proprietary source code initially
- Potential paid desktop product
- Security and privacy as product differentiators

---

## 24. Success Criteria

The project will be successful if it becomes a focus application that:

- Is pleasant enough to use every day
- Makes starting work easier
- Captures distractions without encouraging context switching
- Preserves productive flow
- Integrates notes and audio without becoming bloated
- Works reliably across desktop systems
- Makes privacy claims that are technically true
- Gives users ownership and control over their data
- Can be maintained and monetized without surveillance

