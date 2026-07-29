# Phase 4C Seamless Note Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable per-session note revisions, safe comparison and restore, and workspace navigation that never owns or interrupts the timer.

**Architecture:** The current Markdown file remains authoritative. Rust extends the existing note-file boundary with per-session content-addressed snapshot objects, typed deletion manifests, and a restore journal; SQLite stores revision metadata only. Svelte gains a persistent workspace shell, a focused revision browser, and a process-local revision-operation controller, while every repository mutation remains serialized through the existing FIFO queue.

**Tech Stack:** Tauri 2, Rust 1.77.2, `sqlx`, `atomic-write-file`, `sha2`, `serde`, `uuid`, `tauri-plugin-single-instance`, Svelte 5, TypeScript 6, `diff`/jsdiff, `markdown-it`, `lucide-svelte`, Vitest, Testing Library, SQLite.

## Global Constraints

- Treat `docs/superpowers/specs/2026-07-29-phase-4c-note-revisions-design.md` as authoritative.
- Start from `main` after PR #9. Do not build on an older Phase 4 branch.
- Preserve Rust MSRV `1.77.2`; verify any dependency change against it.
- Register `tauri-plugin-single-instance` before every other plugin and focus the existing main window on a second launch.
- Keep the current Markdown file authoritative. Do not put current or revision content in SQLite.
- Preserve exact UTF-8 bytes. Never trim note content, normalize line endings, or add a final newline.
- Store revision objects at `<app-data>/note-revisions/<session-id>/<sha256>.md`.
- Deduplicate by exact `(session_id, content_hash)` and verify the object before reporting success.
- Keep one shared FIFO for every repository mutation and hash-refreshing load.
- Read-only History/Revisions navigation must never wait for note persistence or timer work.
- Keep the timer wall-clock effect, deadline detection, and alarm independent of `workspaceView`.
- Retain exact boundary content and hash in pending automatic revision requests.
- Use native atomic commands for before-clear, external Keep/Reload, restore, and deletion safety.
- Never use `force` for Phase 4C external-conflict resolution.
- Blank/whitespace-only content never becomes a revision.
- Restore requires inline final confirmation and never changes timer/session metrics.
- Skip unbounded diff/Markdown parsing above 512 KiB or 10,000 lines; cap escaped fallback output at 32 KiB.
- Existing exports continue to contain current notes only. Open Notes Folder continues to expose current notes only.
- Keep current parking-lot, history, tone, Markdown security, carry-forward, and deletion behavior working.
- Use TDD for each task and commit after each independently green task.

## File Structure

### New files

- `src/lib/ActiveTimerBar.svelte`: compact timer/completion controls shown outside the Focus workspace.
- `src/lib/ActiveTimerBar.test.ts`: timer-strip and completion-action component tests.
- `src/lib/WorkspaceNav.svelte`: Focus, History, and Revisions navigation.
- `src/lib/WorkspaceNav.test.ts`: accessible navigation tests.
- `src/lib/revisions.ts`: TypeScript revision types, wire-value validation, labels, and thresholds.
- `src/lib/revisions.test.ts`: type/label validation tests.
- `src/lib/revisionDiff.ts`: bounded jsdiff conversion and line-ending/final-newline metadata.
- `src/lib/revisionDiff.test.ts`: comparison tests.
- `src/lib/revisionOperationController.ts`: pending automatic revision retry/invalidation/close state.
- `src/lib/revisionOperationController.test.ts`: retry and delete-race tests.
- `src/lib/RevisionHistory.svelte`: revision timeline, compare/preview, rename, restore, and history deletion UI.
- `src/lib/RevisionHistory.test.ts`: revision-browser component tests.
- `src-tauri/src/revision_files.rs`: revision objects, operation manifests, typed multi-root staging, and recovery.
- `src-tauri/src/revision_commands.rs`: revision DTOs, SQLite coordination, create/list/load/rename/count, safety, restore, and revision-history deletion.
- `src-tauri/permissions/revision-commands.toml`: minimum permissions for frontend revision commands.

### Modified files

- `src/App.svelte`: workspace orchestration, persistent timer strip, automatic triggers, global revision errors, and close blocking.
- `src/App.test.ts`: fake-timer navigation/completion/integration tests.
- `src/lib/SessionNotes.svelte`: checkpoint and revision-history toolbar actions.
- `src/lib/SessionNotes.test.ts`: toolbar state and feedback tests.
- `src/lib/History.svelte`: revision action/count and explicit deletion copy.
- `src/lib/history.ts`, `src/lib/history.test.ts`: `revisionCount` in summaries.
- `src/lib/notes.ts`: restored-note result types where needed.
- `src/lib/memoryRepository.ts`, `src/lib/memoryRepository.test.ts`: browser parity for revisions.
- `src/lib/tauriRepository.ts`: typed command wrappers.
- `src/lib/repository.ts`: runtime dispatch for revision APIs.
- `src/lib/noteSaveController.ts`, `src/lib/noteSaveController.test.ts`: route clear/conflict resolution through safe native operations.
- `src-tauri/src/note_files.rs`: shared roots/accessors and manifest-aware staged data operations.
- `src-tauri/src/note_commands.rs`: before-clear and external-conflict native paths.
- `src-tauri/src/db_commands.rs`: revision-aware session deletion and delete-all.
- `src-tauri/src/migrations.rs`: schema version 4.
- `src-tauri/src/lib.rs`: single-instance setup, managed stores/modules, command registration, permission assertions.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: single-instance dependency.
- `src-tauri/capabilities/default.json`: revision command permissions.
- `package.json`, `package-lock.json`: `diff` dependency.
- `README.md`: revision behavior, local storage layout, export boundary, and recovery.

---

### Task 1: Persistent Workspace Shell And Single Instance

**Files:**
- Create: `src/lib/ActiveTimerBar.svelte`
- Create: `src/lib/ActiveTimerBar.test.ts`
- Create: `src/lib/WorkspaceNav.svelte`
- Create: `src/lib/WorkspaceNav.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: existing `SessionState`, timer selectors, transition handlers, and `playTone`.
- Produces:

```ts
export type WorkspaceView = 'focus' | 'history' | 'revisions';

export type ActiveTimerBarProps =
  | {
      task: string;
      mode: 'focus' | 'flow' | 'break';
      displayMs: number;
      isPaused: boolean;
      onPause: () => void;
      onResume: () => void;
      onFinish: () => void;
    }
  | {
      task: string;
      mode: 'awaitingDecision';
      onBreak: () => void;
      onFlow: () => void;
      onFinish: () => void;
    };
```

- [ ] **Step 1: Add failing shell component tests**

Create tests that render `ActiveTimerBar` in focus, paused, flow, break, and awaiting-decision modes. Assert task/clock text, Pause/Resume/Finish callbacks, and Break/Flow/Finish callbacks. Create `WorkspaceNav` tests that assert accessible buttons and `aria-current="page"` for the active workspace.

```ts
it('offers all completion decisions without navigating', async () => {
  const onBreak = vi.fn();
  const onFlow = vi.fn();
  const onFinish = vi.fn();
  render(ActiveTimerBar, {
    task: 'Write launch brief',
    mode: 'awaitingDecision',
    onBreak,
    onFlow,
    onFinish,
  });

  await fireEvent.click(screen.getByRole('button', { name: 'Continue in flow' }));
  expect(onFlow).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run src/lib/ActiveTimerBar.test.ts src/lib/WorkspaceNav.test.ts
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the presentational shell**

Use Lucide `Pause`, `Play`, `Square`, `Timer`, `History`, and `FileClock` icons. Keep icon-only controls at stable dimensions with tooltips and accessible names. The compact strip must not own intervals or session state.

```svelte
{#if mode === 'awaitingDecision'}
  <button type="button" onclick={onBreak}>Take a break</button>
  <button type="button" onclick={onFlow}>Continue in flow</button>
  <button type="button" onclick={onFinish}>Finish session</button>
{:else}
  <span class="clock">{formatDuration(displayMs)}</span>
{/if}
```

- [ ] **Step 4: Add failing App fake-timer tests**

Extend `App.test.ts` to start a short focus, navigate to History, advance fake time past the deadline, and assert:

```ts
expect(screen.getByRole('status', { name: 'Focus complete' })).toBeInTheDocument();
expect(playTone).toHaveBeenCalledTimes(1);
expect(screen.getByText('Session history')).toBeInTheDocument();
```

Add a second test that advances additional ticks and proves the tone does not replay.

- [ ] **Step 5: Refactor App workspace ownership**

Replace `view: 'main' | 'history'` with `workspaceView: WorkspaceView`. Keep the top-level 250 ms wall-clock effect and focus-due effect unconditional. Render the full existing session surface only for `focus`; render the compact bar above History/Revisions when the session is focusing, paused, flowing, flow-paused, on break, or awaiting decision.

Read-only navigation changes `workspaceView` immediately. Start `flushPendingNoteSave()` in the background without awaiting it and keep the global failure banner visible.

```ts
function handleNavigate(next: WorkspaceView) {
  workspaceView = next;
  if (noteSaveController.hasPending()) void flushPendingNoteSave();
}
```

```svelte
{#if workspaceView !== 'focus' && session.status !== 'idle' && session.status !== 'complete'}
  {#if session.status === 'awaitingDecision'}
    <ActiveTimerBar
      task={session.task}
      mode="awaitingDecision"
      onBreak={handleChooseBreak}
      onFlow={handleChooseFlow}
      onFinish={handleChooseFinish}
    />
  {:else}
    <ActiveTimerBar
      task={session.task}
      mode={compactMode}
      displayMs={compactDisplayMs}
      isPaused={compactIsPaused}
      onPause={handlePause}
      onResume={handleResume}
      onFinish={compactFinish}
    />
  {/if}
{/if}
```

- [ ] **Step 6: Add the official single-instance plugin first**

Add the desktop-target dependency and register it before SQL/dialog/fs/opener. The callback should show and focus the existing `main` window:

```rust
#[cfg(desktop)]
{
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
}
```

Use the Tauri-supported dependency command from `src-tauri/` and retain MSRV 1.77.2:

```bash
cargo add tauri-plugin-single-instance --target 'cfg(any(target_os = "macos", windows, target_os = "linux"))'
```

- [ ] **Step 7: Verify the slice**

Run:

```bash
npx vitest run src/lib/ActiveTimerBar.test.ts src/lib/WorkspaceNav.test.ts src/App.test.ts
npm run check
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/App.svelte src/App.test.ts src/lib/ActiveTimerBar.svelte src/lib/ActiveTimerBar.test.ts src/lib/WorkspaceNav.svelte src/lib/WorkspaceNav.test.ts src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: keep timer active across workspaces"
```

---

### Task 2: Revision Domain, Bounded Diff, And Retry Controller

**Files:**
- Create: `src/lib/revisions.ts`
- Create: `src/lib/revisions.test.ts`
- Create: `src/lib/revisionDiff.ts`
- Create: `src/lib/revisionDiff.test.ts`
- Create: `src/lib/revisionOperationController.ts`
- Create: `src/lib/revisionOperationController.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

```ts
export type RevisionKind = 'automatic' | 'checkpoint' | 'safety';
export type RevisionReason =
  | 'session_started'
  | 'session_completed'
  | 'review_finalized'
  | 'manual'
  | 'before_clear'
  | 'before_restore'
  | 'before_external_overwrite'
  | 'before_external_reload';

export interface NoteRevision {
  id: string;
  sessionId: string;
  contentHash: string;
  kind: RevisionKind;
  reason: RevisionReason;
  label: string | null;
  createdAt: number;
}

export interface LoadedNoteRevision extends NoteRevision {
  content: string;
}

export interface CreateRevisionRequest {
  sessionId: string;
  content: string;
  contentHash: string;
  kind: RevisionKind;
  reason: RevisionReason;
  createdAt: number;
}

export interface RevisionOperationController {
  submit(request: CreateRevisionRequest): Promise<boolean>;
  retry(): Promise<boolean>;
  flush(): Promise<boolean>;
  invalidate(sessionId?: string): void;
  hasPending(sessionId?: string): boolean;
}

export type LineEndingKind = 'none' | 'LF' | 'CRLF' | 'mixed';

export interface RevisionDiffLine {
  kind: 'context' | 'added' | 'removed' | 'marker';
  marker: '' | '+' | '-' | '\\';
  text: string;
}

export interface RevisionComparison {
  lines: RevisionDiffLine[];
  fromLineEndings: LineEndingKind;
  toLineEndings: LineEndingKind;
  oversized: boolean;
  truncated: boolean;
}
```

- [ ] **Step 1: Install jsdiff**

```bash
npm install diff
```

Do not install `@types/diff`; current jsdiff includes its own TypeScript declarations.

- [ ] **Step 2: Write failing revision model tests**

Cover valid/invalid kind-reason pairs, default labels, label trimming/null normalization, and the 80-character limit:

```ts
expect(validateRevisionPair('automatic', 'session_started')).toBe(true);
expect(validateRevisionPair('checkpoint', 'before_restore')).toBe(false);
expect(normalizeRevisionLabel('   ')).toBeNull();
expect(() => normalizeRevisionLabel('x'.repeat(81))).toThrow();
```

- [ ] **Step 3: Implement exact unions and helpers**

Export `validateRevisionPair`, `normalizeRevisionLabel`, `revisionDisplayLabel`, `MAX_DIFF_BYTES = 524_288`, `MAX_DIFF_LINES = 10_000`, and `MAX_FALLBACK_BYTES = 32_768`.

```ts
const validReasons: Record<RevisionKind, readonly RevisionReason[]> = {
  automatic: ['session_started', 'session_completed', 'review_finalized'],
  checkpoint: ['manual'],
  safety: ['before_clear', 'before_restore', 'before_external_overwrite', 'before_external_reload'],
};

export function validateRevisionPair(kind: RevisionKind, reason: RevisionReason): boolean {
  return validReasons[kind].includes(reason);
}

export function normalizeRevisionLabel(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (Array.from(trimmed).length > 80) throw new Error('Revision labels are limited to 80 characters.');
  return trimmed;
}
```

- [ ] **Step 4: Write failing diff tests**

Test added/removed/context lines, LF/CRLF/mixed detection, missing-final-newline markers, Unicode, 512 KiB, 10,000 lines, and 32 KiB fallback truncation.

```ts
const result = buildRevisionComparison('one\r\ntwo', 'one\nthree\n');
expect(result.toLineEndings).toBe('LF');
expect(result.fromLineEndings).toBe('CRLF');
expect(result.lines.some((line) => line.kind === 'removed')).toBe(true);
expect(result.lines.some((line) => line.kind === 'added')).toBe(true);
```

- [ ] **Step 5: Implement bounded comparison**

Use `diffLines(revisionContent, currentContent, { newlineIsToken: true })`. Convert jsdiff change runs into stable presentation rows with `context`, `added`, `removed`, and `marker` kinds. Check UTF-8 byte length and line count before calling jsdiff or Markdown rendering. Oversized input returns a capped escaped-text model and never invokes jsdiff.

```ts
export function isBoundedForRichComparison(content: string): boolean {
  return (
    new TextEncoder().encode(content).byteLength <= MAX_DIFF_BYTES
    && content.split(/\r\n|\r|\n/).length <= MAX_DIFF_LINES
  );
}

export function buildRevisionComparison(from: string, to: string): RevisionComparison {
  if (!isBoundedForRichComparison(from) || !isBoundedForRichComparison(to)) {
    return buildTruncatedTextComparison(from, to, MAX_FALLBACK_BYTES);
  }
  return convertDiffRuns(diffLines(from, to, { newlineIsToken: true }), from, to);
}
```

- [ ] **Step 6: Write failing controller tests**

Use a deferred fake executor to prove:

- exact boundary bytes survive a later editor change;
- transient failures retry with the original reason/timestamp/hash;
- invalid bytes/hash are terminal;
- exhausted work remains available to manual retry;
- `flush()` reports false while relevant work still fails;
- invalidation before and after a queued delete prevents resurrection.

```ts
const original = request({ content: 'at completion', contentHash: hash('at completion') });
const pending = controller.submit(original);
editorContent = 'changed during review';
releaseExecutor();
await pending;
expect(execute).toHaveBeenLastCalledWith(original);
```

- [ ] **Step 7: Implement the controller**

Model generation-based invalidation on `noteSaveController.ts`, but retain the whole immutable request. Retry only errors classified `transient`; keep one pending request per session/reason/hash and rely on native deduplication for repeated events.

```ts
interface PendingRevision {
  request: Readonly<CreateRevisionRequest>;
  generation: number;
  attempts: number;
}

const generations = new Map<string, number>();
const pending = new Map<string, PendingRevision>();

function generationFor(sessionId: string): number {
  return generations.get(sessionId) ?? 0;
}

function invalidate(sessionId?: string) {
  if (sessionId === undefined) {
    for (const id of pending.keys()) generations.set(id, generationFor(id) + 1);
    pending.clear();
    return;
  }
  generations.set(sessionId, generationFor(sessionId) + 1);
  pending.delete(sessionId);
}

function retain(request: CreateRevisionRequest): PendingRevision {
  return {
    request: Object.freeze({ ...request }),
    generation: generationFor(request.sessionId),
    attempts: 0,
  };
}
```

- [ ] **Step 8: Verify and commit**

```bash
npx vitest run src/lib/revisions.test.ts src/lib/revisionDiff.test.ts src/lib/revisionOperationController.test.ts
npm run check
git add package.json package-lock.json src/lib/revisions.ts src/lib/revisions.test.ts src/lib/revisionDiff.ts src/lib/revisionDiff.test.ts src/lib/revisionOperationController.ts src/lib/revisionOperationController.test.ts
git commit -m "feat: add revision domain and retry primitives"
```

---

### Task 3: Migration And Immutable Revision File Store

**Files:**
- Create: `src-tauri/src/revision_files.rs`
- Modify: `src-tauri/src/note_files.rs`
- Modify: `src-tauri/src/migrations.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

```rust
pub struct StoredRevisionObject {
    pub content: String,
    pub content_hash: String,
}

pub enum RevisionObjectStatus {
    Created(StoredRevisionObject),
    ExistingVerified(StoredRevisionObject),
    RepairedMissing(StoredRevisionObject),
}

impl NoteFileStore {
    pub fn ensure_revision_object(
        &self,
        session_id: &str,
        content: &str,
        expected_hash: &str,
    ) -> Result<RevisionObjectStatus, NoteFileError>;

    pub fn read_revision_object(
        &self,
        session_id: &str,
        content_hash: &str,
    ) -> Result<StoredRevisionObject, NoteFileError>;
}
```

- [ ] **Step 1: Write failing migration tests**

Create a real version-3 schema fixture, run migration 4, and assert:

```rust
assert!(columns.contains(&"content_hash".to_string()));
assert_eq!(row_count(&pool, "note_revisions").await, 0);
```

Insert invalid kind/reason and an 81-character label and assert SQLite rejects them. Insert equal timestamps and verify query ordering later uses `rowid DESC`.

- [ ] **Step 2: Add migration version 4**

Use the exact schema and CHECK constraints from the approved design spec. Do not rebuild or mutate `session_notes`.

```sql
CREATE TABLE note_revisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('automatic', 'checkpoint', 'safety')),
    reason TEXT NOT NULL CHECK (reason IN (
        'session_started', 'session_completed', 'review_finalized', 'manual',
        'before_clear', 'before_restore', 'before_external_overwrite',
        'before_external_reload'
    )),
    label TEXT CHECK (label IS NULL OR length(label) <= 80),
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, content_hash),
    CHECK (
        (kind = 'automatic' AND reason IN ('session_started', 'session_completed', 'review_finalized'))
        OR (kind = 'checkpoint' AND reason = 'manual')
        OR (kind = 'safety' AND reason IN (
            'before_clear', 'before_restore',
            'before_external_overwrite', 'before_external_reload'
        ))
    )
);
CREATE INDEX idx_note_revisions_session_created
    ON note_revisions(session_id, created_at DESC);
```

- [ ] **Step 3: Write failing revision object tests**

Cover root creation, traversal, absolute paths, invalid IDs/hashes, symlinked roots/session directories/objects, exact CRLF/Unicode bytes, immutable idempotency, missing-object repair from verified source bytes, corrupt-object rejection, and hash mismatch between request and bytes.

```rust
let hash = sha256_hex("hello\r\n".as_bytes());
let first = store.ensure_revision_object("s1", "hello\r\n", &hash).unwrap();
let second = store.ensure_revision_object("s1", "hello\r\n", &hash).unwrap();
assert!(matches!(first, RevisionObjectStatus::Created(_)));
assert!(matches!(second, RevisionObjectStatus::ExistingVerified(_)));
```

- [ ] **Step 4: Extend the managed file boundary**

Add `revisions_dir` and `operations_dir` to `NoteFileStore`, create them in `initialize()`, and expose only `pub(crate)` accessors needed by `revision_files.rs`. Validate a revision path as exactly two normal components: validated session ID plus validated lowercase 64-character SHA-256 filename.

Write objects with the existing atomic-write helper. If metadata indicates an existing object:

- valid object: return it;
- missing object with verified source bytes: recreate it;
- present hash-mismatched object: return a corruption error without replacement.

```rust
fn validate_content_hash(hash: &str) -> Result<(), NoteFileError> {
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        Ok(())
    } else {
        Err(NoteFileError::InvalidPath)
    }
}

fn revision_path(&self, session_id: &str, hash: &str) -> Result<PathBuf, NoteFileError> {
    validate_session_id(session_id)?;
    validate_content_hash(hash)?;
    let session_dir = self.revisions_dir.join(session_id);
    match fs::symlink_metadata(&session_dir) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(NoteFileError::InvalidPath);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&session_dir).map_err(io_err)?;
        }
        Err(error) => return Err(io_err(error)),
    }
    resolve_within(&session_dir, session_dir.join(format!("{hash}.md")))
}
```

- [ ] **Step 5: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml migrations
cargo test --manifest-path src-tauri/Cargo.toml revision_files
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/migrations.rs src-tauri/src/note_files.rs src-tauri/src/revision_files.rs src-tauri/src/lib.rs
git commit -m "feat: add immutable note revision storage"
```

---

### Task 4: Native Revision Metadata Commands

**Files:**
- Create: `src-tauri/src/revision_commands.rs`
- Create: `src-tauri/permissions/revision-commands.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDto {
    pub id: String,
    pub session_id: String,
    pub content_hash: String,
    pub kind: RevisionKind,
    pub reason: RevisionReason,
    pub label: Option<String>,
    pub created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRevisionDto {
    #[serde(flatten)]
    pub revision: RevisionDto,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionCountDto {
    pub session_id: String,
    pub count: i64,
}
```

Commands:

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRevisionRequest {
    pub session_id: String,
    pub content: String,
    pub content_hash: String,
    pub kind: RevisionKind,
    pub reason: RevisionReason,
    pub created_at: i64,
}

create_note_revision(request: CreateRevisionRequest)
list_note_revisions(session_id)
load_note_revision(revision_id)
rename_note_revision(revision_id, label)
load_note_revision_counts()
```

- [ ] **Step 1: Write failing command-core tests**

Test valid creation, missing session rejection, blank no-op, invalid pairs, dedupe with object verification, missing-object repair, corrupt-object block, newest-first plus `rowid` tie order, verified load, rename trim/null/80 limit, counts without body reads, and metadata failure after object creation retry.

- [ ] **Step 2: Implement explicit Rust enums and conversion**

Use `serde(rename_all = "snake_case")` wire values and a `TryFrom`/match that rejects unknown values. Do not deserialize arbitrary strings directly into SQL without checking kind/reason pairing.

```rust
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionKind {
    Automatic,
    Checkpoint,
    Safety,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionReason {
    SessionStarted,
    SessionCompleted,
    ReviewFinalized,
    Manual,
    BeforeClear,
    BeforeRestore,
    BeforeExternalOverwrite,
    BeforeExternalReload,
}

fn valid_pair(kind: RevisionKind, reason: RevisionReason) -> bool {
    matches!(
        (kind, reason),
        (RevisionKind::Automatic, RevisionReason::SessionStarted)
            | (RevisionKind::Automatic, RevisionReason::SessionCompleted)
            | (RevisionKind::Automatic, RevisionReason::ReviewFinalized)
            | (RevisionKind::Checkpoint, RevisionReason::Manual)
            | (RevisionKind::Safety, RevisionReason::BeforeClear)
            | (RevisionKind::Safety, RevisionReason::BeforeRestore)
            | (RevisionKind::Safety, RevisionReason::BeforeExternalOverwrite)
            | (RevisionKind::Safety, RevisionReason::BeforeExternalReload)
    )
}
```

- [ ] **Step 3: Implement create/list/load/rename/count cores**

For creation:

1. reject hash mismatch and blank content;
2. begin a transaction and confirm `sessions.id` exists;
3. look up duplicate row;
4. ensure/verify the object;
5. insert metadata or return the verified duplicate;
6. commit.

Load by revision ID, never by caller-supplied path/hash. Verify object bytes after fetching metadata.

```rust
pub(crate) async fn create_note_revision_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    request: CreateRevisionRequest,
) -> Result<Option<RevisionDto>, NoteCommandError>;

pub(crate) async fn load_note_revision_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    revision_id: &str,
) -> Result<LoadedRevisionDto, NoteCommandError>;
```

- [ ] **Step 4: Register minimum permissions**

Add one allow permission per command, include only those identifiers in `default.json`, and extend `lib.rs` capability tests to assert command registration and permission presence.

```toml
[[permission]]
identifier = "allow-create-note-revision"
description = "Allows creating a note revision."
commands.allow = ["create_note_revision"]

[[permission]]
identifier = "allow-list-note-revisions"
description = "Allows listing note revision metadata."
commands.allow = ["list_note_revisions"]

[[permission]]
identifier = "allow-load-note-revision"
description = "Allows loading verified note revision content."
commands.allow = ["load_note_revision"]

[[permission]]
identifier = "allow-rename-note-revision"
description = "Allows renaming note revision metadata."
commands.allow = ["rename_note_revision"]

[[permission]]
identifier = "allow-load-note-revision-counts"
description = "Allows loading revision counts by session."
commands.allow = ["load_note_revision_counts"]
```

Do not add a wildcard/default permission.

- [ ] **Step 5: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml revision_commands
cargo test --manifest-path src-tauri/Cargo.toml capability_permissions
cargo check --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/revision_commands.rs src-tauri/permissions/revision-commands.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: expose note revision metadata commands"
```

---

### Task 5: Repository Parity And History Revision Counts

**Files:**
- Modify: `src/lib/revisions.ts`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/memoryRepository.test.ts`
- Modify: `src/lib/repository.ts`
- Modify: `src/lib/history.ts`
- Modify: `src/lib/history.test.ts`
- Modify: `src/lib/History.svelte`

**Interfaces:**

```ts
export function createNoteRevision(request: CreateRevisionRequest): Promise<NoteRevision | null>;
export function listNoteRevisions(sessionId: string): Promise<NoteRevision[]>;
export function loadNoteRevision(revisionId: string): Promise<LoadedNoteRevision>;
export function renameNoteRevision(revisionId: string, label: string | null): Promise<NoteRevision>;
export function loadNoteRevisionCounts(): Promise<Map<string, number>>;
```

`SessionSummary` gains:

```ts
revisionCount: number;
```

- [ ] **Step 1: Write failing adapter and history tests**

Assert browser memory and Tauri normalization use identical camelCase domain objects, dedupe exact session/hash content, list newest first, rename, load bodies, and count without loading bodies.

Update `buildSessionHistory` tests:

```ts
const summaries = buildSessionHistory(rows, thoughts, notes, new Map([['s1', 2]]));
expect(summaries[0].revisionCount).toBe(2);
```

- [ ] **Step 2: Implement Tauri wrappers and runtime exports**

Keep every Tauri revision read that may repair metadata/object state on the shared queue at the App callsite. Pure metadata listing/count reads may run as reads after prior writes drain.

```ts
export async function createNoteRevision(
  request: CreateRevisionRequest,
): Promise<NoteRevision | null> {
  return invoke<NoteRevision | null>('create_note_revision', { request });
}

export async function loadNoteRevision(revisionId: string): Promise<LoadedNoteRevision> {
  return invoke<LoadedNoteRevision>('load_note_revision', { revisionId });
}
```

- [ ] **Step 3: Implement browser-memory parity**

Store immutable revision bodies separately from metadata. Validate the same kind/reason/label rules. Never mutate a body during rename.

```ts
const revisionsById = new Map<string, NoteRevision>();
const revisionContentByHash = new Map<string, string>();

function objectKey(sessionId: string, contentHash: string): string {
  return `${sessionId}:${contentHash}`;
}
```

- [ ] **Step 4: Update History presentation**

Show a Lucide `FileClock` action when the current note is non-empty or `revisionCount > 0`. Pass the selected session ID to `onViewRevisions`. Keep current note preview unchanged. Update per-session and delete-all confirmation copy to explicitly include current notes and revision history.

```svelte
{#if summary.noteContent || summary.revisionCount > 0}
  <button
    type="button"
    class="icon-link"
    title="View note revisions"
    aria-label={`View revisions for ${summary.task}`}
    onclick={() => onViewRevisions(summary.id)}
  >
    <FileClock size={16} aria-hidden="true" />
  </button>
{/if}
```

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/memoryRepository.test.ts src/lib/history.test.ts
npm run check
git add src/lib/revisions.ts src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/repository.ts src/lib/memoryRepository.test.ts src/lib/history.ts src/lib/history.test.ts src/lib/History.svelte
git commit -m "feat: connect revisions to history repositories"
```

---

### Task 6: Revision Browser, Checkpoints, And Automatic Boundaries

**Files:**
- Create: `src/lib/RevisionHistory.svelte`
- Create: `src/lib/RevisionHistory.test.ts`
- Modify: `src/lib/SessionNotes.svelte`
- Modify: `src/lib/SessionNotes.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**

```ts
interface RevisionHistoryProps {
  sessionId: string;
  task: string;
  sessionDate: number;
  currentContent: string;
  currentHash: string | null;
  revisions: NoteRevision[];
  loadRevision: (id: string) => Promise<LoadedNoteRevision>;
  onRename: (id: string, label: string | null) => Promise<NoteRevision>;
  writesDisabled: boolean;
  onBack: () => void;
}
```

- [ ] **Step 1: Write failing SessionNotes toolbar tests**

Assert checkpoint and revisions buttons have Lucide icons, tooltips, accessible names, stable dimensions, and disabled checkpoint state for blank/unavailable content. Assert click callbacks and non-blocking `Checkpoint saved` / `No changes since the last revision` statuses.

- [ ] **Step 2: Write failing RevisionHistory tests**

Cover newest selection, timeline metadata, Changes/Preview tabs, diff
markers independent of color, bounded fallback, inline rename
Enter/blur/Escape, and status/alert semantics.

- [ ] **Step 3: Implement the approved compact browser**

Follow the approved mock and spec for timeline, comparison, and preview.
Use one timeline and one unframed comparison pane; do not nest cards.
Reuse `MarkdownPreview` only below thresholds. Keep all labels and long
lines within compact width. Do not add restore or deletion controls in
this slice; Tasks 8 and 9 add them only after their native operations are
available.

```svelte
<div class="revision-layout">
  <ol class="revision-timeline" aria-label="Note revisions">
    {#each revisions as revision (revision.id)}
      <li>
        <button
          type="button"
          aria-pressed={selectedId === revision.id}
          onclick={() => selectRevision(revision.id)}
        >
          <strong>{revisionDisplayLabel(revision)}</strong>
          <span>{formatDateTime(revision.createdAt)} · {revision.kind}</span>
        </button>
      </li>
    {/each}
  </ol>
  <section class="revision-comparison" aria-label="Revision comparison">
    {#if comparisonMode === 'changes'}
      <div class="diff" role="table" aria-label="Changes since revision">
        {#each comparison.lines as line}
          <div class:added={line.kind === 'added'} class:removed={line.kind === 'removed'} role="row">
            <span class="diff-marker">{line.marker}</span>
            <span>{line.text}</span>
          </div>
        {/each}
      </div>
    {:else if selectedRevision}
      <MarkdownPreview content={selectedRevision.content} />
    {/if}
  </section>
</div>
```

- [ ] **Step 4: Wire manual checkpoint**

On checkpoint:

1. await current note flush;
2. capture exact committed content/hash;
3. submit a `manual` request through the revision controller;
4. show saved/no-change/failure feedback;
5. stay in the current workspace.

```ts
async function handleCheckpoint() {
  if (!(await flushPendingNoteSave())) return;
  const sessionId = currentNoteSessionId();
  const contentHash = sessionId ? noteHashBySession.get(sessionId) : null;
  if (!sessionId || !contentHash || !hasNoteContent(noteContent)) return;
  await revisionController.submit({
    sessionId,
    content: noteContent,
    contentHash,
    kind: 'checkpoint',
    reason: 'manual',
    createdAt: Date.now(),
  });
}
```

- [ ] **Step 5: Wire automatic triggers**

Update `applyResult()` to detect transition into `complete` without delaying state. Capture exact content/hash after successful flush and submit `session_completed`.

Before starting the next session, retain the old finalized content/hash and submit `review_finalized` before new note work. After a carried note save succeeds, submit `session_started` for the new session. Do not synthesize snapshots for recovered complete/pre-4C sessions.

```ts
function applyResult(result: TransitionResult) {
  const previous = session;
  if (!result.ok) {
    error = result.error;
    return;
  }
  session = result.state;
  queueSaveSession(session, Date.now());
  if (previous.status !== 'complete' && session.status === 'complete') {
    void snapshotCompletedSession(session.sessionId, session.completedAt);
  }
}
```

- [ ] **Step 6: Add App integration tests**

Use fake timers/deferred repositories to prove:

- History/Revisions navigation stays immediate during failed note saves;
- checkpoint/restore writes disable until committed content is available;
- completion alarm fires once while revision comparison is open;
- automatic request retains completion bytes after review edits;
- starting the next timer does not await automatic snapshot completion;
- close waits for pending revision work;
- deletion invalidation prevents late automatic retries.

- [ ] **Step 7: Verify and commit**

```bash
npx vitest run src/lib/SessionNotes.test.ts src/lib/RevisionHistory.test.ts src/App.test.ts
npm run check
npm run build
git add src/lib/RevisionHistory.svelte src/lib/RevisionHistory.test.ts src/lib/SessionNotes.svelte src/lib/SessionNotes.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: add seamless note checkpoint browsing"
```

---

### Task 7: Before-Clear And External Conflict Safety

**Files:**
- Modify: `src-tauri/src/revision_files.rs`
- Modify: `src-tauri/src/revision_commands.rs`
- Modify: `src-tauri/src/note_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/revision-commands.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/memoryRepository.test.ts`
- Modify: `src/lib/repository.ts`
- Modify: `src/lib/noteSaveController.ts`
- Modify: `src/lib/noteSaveController.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**

```ts
export interface ConflictResolutionResult {
  note: SessionNoteRow | null;
  safetyRevision: NoteRevision | null;
}

export function keepAppNoteAfterConflict(
  sessionId: string,
  draft: string,
  conflictHash: string,
  now: number,
): Promise<ConflictResolutionResult>;

export function reloadExternalNoteAfterConflict(
  sessionId: string,
  draft: string,
  conflictHash: string,
  now: number,
): Promise<{ note: SessionNoteRow; safetyRevision: NoteRevision | null }>;
```

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionResponse {
    pub note: Option<SessionNoteDto>,
    pub safety_revision: Option<RevisionDto>,
}
```

- [ ] **Step 1: Write failing before-clear native tests**

Fault-inject every boundary:

- stage current file before reading safety bytes;
- stale expected hash restores staging and returns conflict;
- live path recreated during restore preserves both copies;
- missing/corrupt deduplicated safety object blocks clear;
- object failure restores current file and keeps note row;
- SQL failure restores current file and rolls back safety row;
- success inserts/reuses `before_clear`, deletes note row, and finalizes staging.

- [ ] **Step 2: Refactor whitespace save into safe clear**

In `save_session_note_core`, route whitespace content through the native staged-before-clear flow. Do not delete the file before verified safety exists. Insert/reuse the revision row and delete `session_notes` in one transaction.

```rust
if content.trim().is_empty() {
    return clear_session_note_with_safety_core(
        pool,
        store,
        session_id,
        expected_hash,
        now,
    )
    .await;
}
```

- [ ] **Step 3: Write failing native external-conflict tests**

For Keep:

- exact conflict hash snapshots external bytes then compare-writes draft;
- second external change returns a fresh conflict and preserves all content;
- lost-response retry where draft already landed repairs metadata before creating another safety row.

For Reload:

- exact conflict hash snapshots the in-memory draft then returns verified disk content;
- second external change returns a fresh conflict without discarding draft;
- safety failure leaves conflict/draft intact.

- [ ] **Step 4: Implement atomic conflict commands**

Add `resolve_external_conflict_keep` and `resolve_external_conflict_reload`. Remove Phase 4C use of `forceNextNoteSave`; Keep must use expected compare-and-write inside the one native operation. Return normalized fresh conflict fields when disk changes again.

```rust
pub(crate) async fn resolve_external_conflict_keep_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    draft: &str,
    conflict_hash: &str,
    now: i64,
) -> Result<ConflictResolutionResponse, NoteCommandError>;

pub(crate) async fn resolve_external_conflict_reload_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    draft: &str,
    conflict_hash: &str,
    now: i64,
) -> Result<ConflictResolutionResponse, NoteCommandError>;
```

Register both commands in `lib.rs` and add only
`allow-resolve-external-conflict-keep` and
`allow-resolve-external-conflict-reload` to the main capability.

- [ ] **Step 5: Update frontend controller and conflict UI**

Keep pending drafts in `noteSaveController` until the native command succeeds. On fresh conflict, replace the stored conflict hash/content and keep the banner active. On success, discard/commit pending work, update note hash, and refresh revision counts.

```ts
async function handleKeepAppNote() {
  if (!noteStorageIssue?.diskHash) return;
  const sessionId = noteStorageIssue.sessionId;
  const result = await writeQueue.enqueue(() =>
    keepAppNoteAfterConflict(sessionId, noteContent, noteStorageIssue!.diskHash!, Date.now()),
  );
  noteSaveController.discard(sessionId);
  noteHashBySession.set(sessionId, result.note?.content_hash ?? null);
  noteStorageIssue = null;
}
```

- [ ] **Step 6: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml before_clear
cargo test --manifest-path src-tauri/Cargo.toml external_conflict
npx vitest run src/lib/noteSaveController.test.ts src/lib/memoryRepository.test.ts src/App.test.ts
npm run check
git add src-tauri/src/revision_files.rs src-tauri/src/revision_commands.rs src-tauri/src/note_commands.rs src-tauri/src/lib.rs src-tauri/permissions/revision-commands.toml src-tauri/capabilities/default.json src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/memoryRepository.test.ts src/lib/repository.ts src/lib/noteSaveController.ts src/lib/noteSaveController.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: preserve notes across clear and conflict choices"
```

---

### Task 8: Restore Journal And Idempotent Recovery

**Files:**
- Modify: `src-tauri/src/revision_files.rs`
- Modify: `src-tauri/src/revision_commands.rs`
- Modify: `src-tauri/src/note_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/revision-commands.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/lib/revisions.ts`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/memoryRepository.test.ts`
- Modify: `src/lib/repository.ts`
- Modify: `src/lib/RevisionHistory.svelte`
- Modify: `src/lib/RevisionHistory.test.ts`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`

**Interfaces:**

```rust
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct RestoreManifest {
    pub version: u8,
    pub operation_id: String,
    pub phase: RestorePhase,
    pub session_id: String,
    pub current_relative_path: String,
    pub prior: PriorNoteState,
    pub target_revision_id: String,
    pub target_hash: String,
    pub safety_revision_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriorNoteState {
    NoNoteRow,
    Present { content_hash: String },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorePhase {
    Prepared,
    TargetWritten,
    MetadataCommitted,
    Cancelled,
}
```

```ts
export interface RestoreRevisionResult {
  note: SessionNoteRow;
  safetyRevision: NoteRevision | null;
}

export interface CurrentNoteSnapshot {
  sessionId: string;
  content: string;
  contentHash: string | null;
}

export function restoreNoteRevision(
  revisionId: string,
  expectedCurrentHash: string | null,
  now: number,
): Promise<RestoreRevisionResult>;
```

- [ ] **Step 1: Write failing manifest filesystem tests**

Test atomic manifest creation, strict schema/version/ID/path/hash validation, symlink rejection, phase transitions, cancelled cleanup, and enumeration. Manifest JSON must contain no note content.

- [ ] **Step 2: Write failing restore command tests**

Cover:

- selected object verified before use;
- same target bytes repair metadata and succeed before expected-hash check;
- no row plus absent deterministic path creates a current note;
- no row plus orphan path blocks restore;
- row plus missing/unreadable/legacy file blocks restore;
- non-empty prior content gets verified safety before replacement;
- stale expected hash returns conflict before replacement;
- late compare-and-write conflict cancels manifest;
- failure before/during replace leaves current unchanged;
- failure after target write but before metadata upsert resumes the same manifest in-process;
- startup rolls forward target file with stale/missing metadata;
- unexpected external hash cancels without overwriting;
- missing/corrupt target object or missing session blocks recovery.

- [ ] **Step 3: Implement restore core and recovery**

Follow the exact ordered restore flow in the spec. Write the manifest after safety metadata is committed and before current-file replacement. Reuse a matching unfinished manifest on retry. `initialize_note_storage_core` must recover manifests before staged deletions and legacy migration.

```rust
match (current_hash.as_deref(), manifest.prior.hash()) {
    (Some(current), _) if current == manifest.target_hash => {
        upsert_restored_note_metadata(pool, &manifest).await?;
        store.finish_restore_manifest(&manifest)?;
    }
    (current, prior) if current == prior => {
        store.compare_and_write_manifest_target(&manifest)?;
        upsert_restored_note_metadata(pool, &manifest).await?;
        store.finish_restore_manifest(&manifest)?;
    }
    _ => {
        store.cancel_restore_manifest(&manifest)?;
        return Err(NoteCommandError::Conflict {
            disk_content: current_content.unwrap_or_default(),
            disk_hash: current_hash.unwrap_or_default(),
        });
    }
}
```

Register `restore_note_revision`, grant only
`allow-restore-note-revision`, and extend the capability test.

- [ ] **Step 4: Add repository parity**

Browser memory must reproduce confirmation-relevant outcomes, dedupe safety content, restore cleared notes, reject stale expected hashes, and refresh current note content/hash.

```ts
export async function restoreNoteRevision(
  revisionId: string,
  expectedCurrentHash: string | null,
  now: number,
): Promise<RestoreRevisionResult> {
  const revision = requireRevision(revisionId);
  const current = noteBySession.get(revision.sessionId) ?? null;
  assertExpectedOrTarget(current, expectedCurrentHash, revision.contentHash);
  const safetyRevision = current
    ? createSafetyRevision(current, 'before_restore', now)
    : null;
  const note = replaceCurrentNote(revision.sessionId, requireRevisionContent(revision));
  return { note, safetyRevision };
}
```

- [ ] **Step 5: Wire revision restore UI**

Extend `RevisionHistoryProps` with `onRestore` and
`onReloadComparison`. Add the restore button, dynamic confirmation copy,
same-content disabled state, success status, and stale-content recovery.

```ts
interface RestoreActions {
  onRestore: (
    revisionId: string,
    expectedCurrentHash: string | null,
  ) => Promise<RestoreRevisionResult>;
  onReloadComparison: () => Promise<CurrentNoteSnapshot>;
}
```

On stale restore, keep the selected revision, hide confirmation, show
Reload comparison, load fresh current content/hash, then require a new
confirmation. On success update the active editor when IDs match and
update any loaded History summary for an old session. Do not change
`workspaceView` or session state.

Add component tests for dynamic confirmation copy, Cancel, same-content
disablement, success, and stale restore followed by Reload comparison.

```svelte
{#if confirmingRestore}
  <div class="restore-confirmation" role="alert">
    <p>{restoreConfirmationDetail}</p>
    <button type="button" onclick={() => (confirmingRestore = false)}>Cancel</button>
    <button type="button" onclick={confirmRestore}>Confirm restore</button>
  </div>
{:else}
  <button type="button" disabled={selectedMatchesCurrent} onclick={() => (confirmingRestore = true)}>
    Restore this revision
  </button>
{/if}
```

- [ ] **Step 6: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml restore_manifest
cargo test --manifest-path src-tauri/Cargo.toml restore_revision
npx vitest run src/lib/RevisionHistory.test.ts src/App.test.ts src/lib/memoryRepository.test.ts
npm run check
git add src-tauri/src/revision_files.rs src-tauri/src/revision_commands.rs src-tauri/src/note_commands.rs src-tauri/src/lib.rs src-tauri/permissions/revision-commands.toml src-tauri/capabilities/default.json src/lib/revisions.ts src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/memoryRepository.test.ts src/lib/repository.ts src/lib/RevisionHistory.svelte src/lib/RevisionHistory.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: restore note revisions with crash recovery"
```

---

### Task 9: Revision-History, Session, And Delete-All Recovery

**Files:**
- Modify: `src-tauri/src/revision_files.rs`
- Modify: `src-tauri/src/revision_commands.rs`
- Modify: `src-tauri/src/db_commands.rs`
- Modify: `src-tauri/src/note_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/revision-commands.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/repository.ts`
- Modify: `src/lib/History.svelte`
- Modify: `src/lib/RevisionHistory.svelte`
- Modify: `src/App.svelte`
- Modify: `src/App.test.ts`
- Modify: `src/lib/memoryRepository.test.ts`
- Modify: `src/lib/RevisionHistory.test.ts`

**Interfaces:**

```rust
pub enum StagedDataKind {
    RevisionHistory { session_id: String },
    Session { session_id: String },
    AllData,
}

pub struct StagedDataManifest {
    pub version: u8,
    pub operation_id: String,
    pub kind: StagedDataKind,
    pub entries: Vec<StagedDataEntry>,
}

pub struct StagedDataEntry {
    pub root: StagedRoot,
    pub relative_path: String,
    pub entry_type: StagedEntryType,
}

pub enum StagedRoot {
    Notes,
    NoteRevisions,
}

pub enum StagedEntryType {
    File,
    Directory,
}
```

```ts
export function deleteNoteRevisionHistory(sessionId: string): Promise<DeleteOutcome>;
```

- [ ] **Step 1: Write failing typed staging tests**

For revision-history, session, and all-data operations, test:

- manifest records every intended move before the first rename;
- failure on move N rolls back moves `0..N`;
- rollback failure leaves a recoverable manifest;
- rows remain means startup restores all staged entries;
- rows gone means startup finalizes all staged entries;
- identical staged/live duplicates finalize safely;
- differing staged/live bytes preserve both and report error;
- partial directory state never silently deletes content.

- [ ] **Step 2: Implement one multi-root staging primitive**

Replace ad hoc separate staging calls with one manifest-owned operation. Session staging includes its current note path and full revision directory. Delete-all includes full notes and revision roots and recreates both roots after staging.

```rust
pub fn stage_session_data(
    &self,
    session_id: &str,
    current_note_path: Option<&str>,
) -> Result<StagedDataOperation, NoteFileError>;

pub fn stage_revision_history(
    &self,
    session_id: &str,
) -> Result<StagedDataOperation, NoteFileError>;

pub fn stage_all_data(&self) -> Result<StagedDataOperation, NoteFileError>;
```

Each method writes the complete intended-entry manifest before moving the
first entry. Its internal move loop records completed entries and calls
`restore_completed_moves()` before returning any staging error.

- [ ] **Step 3: Extend SQL transactions**

Per-session delete removes `sessions`, `session_notes`, and `note_revisions` for the ID in one transaction. Delete-all removes `sessions`, `parked_thoughts`, `session_notes`, and `note_revisions`; settings remain.

Revision-history delete removes only that session's `note_revisions` rows and leaves current note/session untouched.

```sql
-- Session delete transaction
DELETE FROM sessions WHERE id = ?;
DELETE FROM session_notes WHERE session_id = ?;
DELETE FROM note_revisions WHERE session_id = ?;

-- Delete-all transaction
DELETE FROM parked_thoughts;
DELETE FROM sessions;
DELETE FROM session_notes;
DELETE FROM note_revisions;
```

Register `delete_note_revision_history`, grant only
`allow-delete-note-revision-history`, and extend the capability
test.

- [ ] **Step 4: Invalidate pending work around deletion**

Call both note-save and revision-controller invalidation before enqueueing and again after completion. Clear loaded revision view/counts only after native commit succeeds.

```ts
cancelPendingNoteSave(sessionId);
revisionController.invalidate(sessionId);
const outcome = await writeQueue.enqueue(() => deleteSessionRow(sessionId));
cancelPendingNoteSave(sessionId);
revisionController.invalidate(sessionId);
```

- [ ] **Step 5: Update confirmations and cleanup statuses**

Extend `RevisionHistoryProps` with `onDeleteHistory`, then add the
secondary Delete revision history action and its component tests.

```ts
interface RevisionDeletionAction {
  onDeleteHistory: () => Promise<void>;
}
```

Use inline confirmation:

- revision history: current note/session remain;
- session: session, current note, and revision history are removed;
- delete all: sessions, parked thoughts, current notes, and revision history are removed.

Update cleanup warnings to mention note/revision file cleanup.

```svelte
<p>
  Delete this session, its current note, and its revision history?
</p>
```

- [ ] **Step 6: Verify and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml deletion
cargo test --manifest-path src-tauri/Cargo.toml staged
npx vitest run src/lib/memoryRepository.test.ts src/App.test.ts src/lib/RevisionHistory.test.ts
npm run check
git add src-tauri/src/revision_files.rs src-tauri/src/revision_commands.rs src-tauri/src/db_commands.rs src-tauri/src/note_commands.rs src-tauri/src/lib.rs src-tauri/permissions/revision-commands.toml src-tauri/capabilities/default.json src/lib/tauriRepository.ts src/lib/memoryRepository.ts src/lib/memoryRepository.test.ts src/lib/repository.ts src/lib/History.svelte src/lib/RevisionHistory.svelte src/lib/RevisionHistory.test.ts src/App.svelte src/App.test.ts
git commit -m "feat: delete revision data with recoverable staging"
```

---

### Task 10: Full Validation, Documentation, And Visual Pass

**Files:**
- Modify: `README.md`
- Do not modify the approved spec except to correct a demonstrated contradiction.

**Interfaces:**
- Consumes: all Phase 4C slices.
- Produces: a review-ready Phase 4C branch and PR.

- [ ] **Step 1: Run the complete automated suite**

```bash
npm test
npm run check
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

Expected: all pass. Fix root causes; do not weaken tests.

- [ ] **Step 2: Audit spec coverage**

Map every acceptance criterion in the design spec to at least one automated test or explicit manual check. Confirm exact reason wire values, label limit, diff thresholds, single-instance registration order, command permissions, and current-only export behavior.

- [ ] **Step 3: Run manual Tauri durability checks**

Use `npm run tauri:dev` with a real app-data database:

1. Create, dedupe, rename, compare, and preview checkpoints.
2. Complete a session, edit in review, start another, and verify automatic labels/content.
3. Clear and restore a note.
4. Externally edit then exercise Keep and Reload, including a second edit before confirming.
5. Restore current and old sessions while another timer runs.
6. Expire focus in History and Revisions; verify one alarm and persistent decisions.
7. Delete revision history, one session, and all data.
8. Interrupt restore/deletion at injected phases and restart.
9. Launch a second app instance and verify the existing window focuses.

- [ ] **Step 4: Run the visual pass**

Check light/dark mode at 320 CSS px and normal desktop width. Verify:

- no text/control overlap;
- timer strip dimensions remain stable;
- long task/label/diff lines wrap safely;
- timeline remains scannable;
- `+`/`-` markers communicate without color;
- restore/delete confirmations remain visible;
- no nested cards or excessive rounded surfaces.

- [ ] **Step 5: Update README**

Document:

- automatic/manual/safety revisions;
- current Markdown vs internal revision storage;
- clear vs delete-history/session/delete-all behavior;
- current-only exports and Open Notes Folder;
- single-instance behavior;
- no Git integration yet.

- [ ] **Step 6: Review the final diff and commit**

```bash
git status --short
git diff --stat
git diff --check
git add README.md
git commit -m "docs: describe note revision history"
```

If verification fixes changed code/tests after Task 9, include only those related files in this final commit and explain them in the PR summary.

## Pull Request Requirements

Open one Phase 4C PR after all ten tasks are green. The PR description must include:

- the three implementation slices;
- storage and recovery model;
- timer-independence evidence;
- external-conflict and delete-race evidence;
- test counts and exact validation commands;
- manual Tauri checks performed;
- screenshots of Revisions during an active timer at compact and normal widths;
- explicit deferrals: Git, revision export, individual revision deletion, configurable retention, and Phase 5 native behavior.

Do not merge automatically. Hand the PR back for Codex review.
