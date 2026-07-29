# Phase 4B Portable Markdown Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite note-content storage with one app-managed Markdown file per session, add safe Edit/Preview presentation, and preserve Phase 4A's autosave, carry-forward, export, deletion, and recovery guarantees.

**Architecture:** Rust owns the app-data note directory, path validation, SHA-256 content versions, atomic writes, staged deletion, startup recovery, and SQLite/file coordination. TypeScript keeps the existing repository and write-queue boundaries, tracks the expected content hash for optimistic conflict detection, and renders Markdown through a deliberately restricted `markdown-it` configuration.

**Tech Stack:** Tauri 2, Rust 1.77.2, `sqlx`, `atomic-write-file`, `sha2`, `chrono`, `uuid`, Svelte 5, TypeScript 6, `markdown-it`, `lucide-svelte`, Vitest, Testing Library, SQLite.

## Global Constraints

- Begin from PR #8's final Phase 4A head after it is merged into `main`; do not implement on the open Phase 4A branch.
- Keep one independent note per session. Carry-forward copies content into a new note file.
- Store files under `<app-data>/notes/`; store only relative paths in SQLite.
- File content is UTF-8 without a byte-order mark and exactly matches the user's string. Do not trim, normalize line endings, or add a final newline.
- Markdown files are authoritative after migration. SQLite `content` is only a temporary legacy fallback and must be `''` for file-backed rows.
- Use lowercase hexadecimal SHA-256 over the exact stored bytes as `content_hash`.
- Never accept an arbitrary absolute note path from the frontend.
- Use atomic same-directory replacement for note writes and same-volume staging for deletion.
- Keep every repository write on the existing shared FIFO queue.
- Treat a file-backed note load that refreshes SQLite's `content_hash` as a
  write for queue-ordering purposes.
- Preserve Phase 4A's 600 ms debounce, bounded automatic retries, manual retry, transition flushes, and window-close blocking.
- Treat conflict, missing-file, and unreadable-file failures as non-transient. Never retry them automatically or convert them into empty notes.
- Markdown raw HTML, embedded images, unsafe URL schemes, scripts, and automatic remote loads remain disabled.
- Keep current timer, parking-lot, history, export, tone, and browser-memory behavior working.
- Preserve the crate's declared Rust 1.77.2 minimum; do not accept a
  dependency update that silently raises the MSRV.
- Do not add checkpoints, revisions, note search, reusable notes, custom note directories, live filesystem watching, Markdown import, or Git integration.

## File Structure

### New files

- `src-tauri/src/note_files.rs`: pure filesystem boundary for names, confinement, reads, hashes, atomic writes, staging, restore, cleanup, and staged-entry enumeration.
- `src-tauri/src/note_commands.rs`: native note DTOs/errors and SQLite/file orchestration for initialization, migration, load, save, clear, and opening the notes directory.
- `src-tauri/permissions/note-commands.toml`: narrowly scoped permissions for the note commands exposed to the main window.
- `src/lib/noteStorage.ts`: typed frontend storage failures and normalization of Tauri command errors.
- `src/lib/noteStorage.test.ts`: frontend error-normalization tests.
- `src/lib/markdown.ts`: configured Markdown renderer and safe-URL policy.
- `src/lib/markdown.test.ts`: renderer security and syntax tests.
- `src/lib/MarkdownPreview.svelte`: reusable safe preview and external-link event handling.
- `src/lib/SessionNotes.test.ts`: Edit/Preview and disabled-editor component tests.

### Modified files

- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: native file, hash, date, UUID, and opener dependencies.
- `src-tauri/src/migrations.rs`: migration version 3 for `file_path` and `content_hash`.
- `src-tauri/src/db_commands.rs`: file-aware session deletion and delete-all.
- `src-tauri/src/lib.rs`: managed note store, opener plugin, and command registration.
- `src-tauri/capabilities/default.json`: note-command permissions and safe default URL opening.
- `package.json`, `package-lock.json`: Markdown, icon, opener, and component-test dependencies.
- `src/lib/notes.ts`, `src/lib/notes.test.ts`: file-backed row/result types while preserving history's current input shape.
- `src/lib/memoryRepository.ts`, `src/lib/memoryRepository.test.ts`: browser-safe parity for the expanded note contract.
- `src/lib/tauriRepository.ts`: wrappers around the new native note commands and structured errors.
- `src/lib/repository.ts`: dispatch the expanded note API.
- `src/lib/noteSaveController.ts`, `src/lib/noteSaveController.test.ts`: non-transient failure classification and draft discard.
- `src/lib/SessionNotes.svelte`: stable Edit/Preview tabs and unavailable-file state.
- `src/lib/History.svelte`: formatted note previews and Open Notes Folder action.
- `src/App.svelte`: initialization, expected hashes, conflict resolution, unavailable-file handling, and cleanup outcomes.
- `README.md`: Phase 4B behavior, storage ownership, recovery, and explicit deferrals.

---

### Task 1: Native Note File Store

**Files:**
- Create: `src-tauri/src/note_files.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: an app-data root `PathBuf`; session ID, task, and local date for a filename; relative paths for all later file operations.
- Produces:

```rust
pub struct NoteFileStore;

pub struct StoredFile {
    pub content: String,
    pub content_hash: String,
}

pub struct StagedDeletion;

#[derive(Clone)]
pub struct StagedEntry {
    pub operation_id: String,
    pub relative_path: String,
}

pub enum NoteFileError {
    Conflict { disk_content: String, disk_hash: String },
    Missing { relative_path: String },
    Unreadable { relative_path: String },
    InvalidPath,
    Io(String),
}

impl NoteFileStore {
    pub fn new(app_data_root: PathBuf) -> Self;
    pub fn initialize(&self) -> Result<(), NoteFileError>;
    pub fn note_relative_path(
        &self,
        session_id: &str,
        task: &str,
        local_date: &str,
    ) -> Result<String, NoteFileError>;
    pub fn read(&self, relative_path: &str) -> Result<StoredFile, NoteFileError>;
    pub fn compare_and_write(
        &self,
        relative_path: &str,
        content: &str,
        expected_hash: Option<&str>,
        force: bool,
    ) -> Result<StoredFile, NoteFileError>;
    pub fn stage_paths(&self, paths: &[String]) -> Result<StagedDeletion, NoteFileError>;
    pub fn stage_all_notes(&self) -> Result<StagedDeletion, NoteFileError>;
    pub fn restore_stage(&self, stage: &StagedDeletion) -> Result<(), NoteFileError>;
    pub fn finalize_stage(&self, stage: &StagedDeletion) -> Result<(), NoteFileError>;
    pub fn staged_entries(&self) -> Result<Vec<StagedEntry>, NoteFileError>;
    pub fn read_staged(&self, entry: &StagedEntry) -> Result<StoredFile, NoteFileError>;
    pub fn restore_staged_entry(&self, entry: &StagedEntry) -> Result<(), NoteFileError>;
    pub fn finalize_staged_entry(&self, entry: &StagedEntry) -> Result<(), NoteFileError>;
    pub fn notes_dir(&self) -> &Path;
}
```

- [ ] **Step 1: Write failing path, encoding, hash, conflict, and staging tests**

Add a `#[cfg(test)]` module to `note_files.rs` with these cases:

```rust
fn test_store() -> (tempfile::TempDir, NoteFileStore) {
    let dir = tempfile::tempdir().expect("create temp app-data root");
    let store = NoteFileStore::new(dir.path().to_path_buf());
    (dir, store)
}

fn initialized_store() -> (tempfile::TempDir, NoteFileStore) {
    let (dir, store) = test_store();
    store.initialize().expect("initialize note directories");
    (dir, store)
}

#[test]
fn filename_is_readable_stable_and_collision_safe() {
    let (_dir, store) = test_store();
    let path = store
        .note_relative_path(
            "123e4567-e89b-12d3-a456-426614174000",
            "  Project: Outline / Review  ",
            "2026-07-28",
        )
        .unwrap();

    assert_eq!(
        path,
        "2026-07-28--project-outline-review--123e4567-e89b-12d3-a456-426614174000.md"
    );
}

#[test]
fn unsupported_task_text_uses_session_slug() {
    let (_dir, store) = test_store();
    let path = store
        .note_relative_path(
            "123e4567-e89b-12d3-a456-426614174000",
            "日本語",
            "2026-07-28",
        )
        .unwrap();
    assert!(path.contains("--session--"));
}

#[test]
fn slug_is_capped_and_identifiers_are_validated() {
    let (_dir, store) = test_store();
    let id = "123e4567-e89b-12d3-a456-426614174000";
    let path = store
        .note_relative_path(id, &"A".repeat(80), "2026-07-28")
        .unwrap();
    assert_eq!(
        path,
        format!("2026-07-28--{}--{id}.md", "a".repeat(48))
    );
    assert!(matches!(
        store.note_relative_path("../../escape", "Task", "2026-07-28"),
        Err(NoteFileError::InvalidPath)
    ));
    assert!(matches!(
        store.note_relative_path(id, "Task", "../bad-date"),
        Err(NoteFileError::InvalidPath)
    ));
}

#[test]
fn exact_utf8_bytes_round_trip_without_normalization() {
    let (_dir, store) = test_store();
    store.initialize().unwrap();
    let content = "line one\r\nline two\nCafé";
    let saved = store
        .compare_and_write("note.md", content, None, false)
        .unwrap();
    let loaded = store.read("note.md").unwrap();

    assert_eq!(loaded.content.as_bytes(), content.as_bytes());
    assert_eq!(loaded.content_hash, saved.content_hash);
}

#[test]
fn stale_expected_hash_returns_the_disk_version_without_overwriting() {
    let (_dir, store) = test_store();
    store.initialize().unwrap();
    let first = store
        .compare_and_write("note.md", "first", None, false)
        .unwrap();
    let external = store
        .compare_and_write("note.md", "external", Some(&first.content_hash), true)
        .unwrap();

    let error = store
        .compare_and_write("note.md", "local draft", Some(&first.content_hash), false)
        .unwrap_err();

    assert!(matches!(
        error,
        NoteFileError::Conflict {
            disk_content,
            disk_hash
        } if disk_content == "external" && disk_hash == external.content_hash
    ));
    assert_eq!(store.read("note.md").unwrap().content, "external");
}

#[test]
fn matching_desired_content_is_an_idempotent_success_after_metadata_failure() {
    let (_dir, store) = test_store();
    store.initialize().unwrap();
    let first = store
        .compare_and_write("note.md", "first", None, false)
        .unwrap();
    let desired = store
        .compare_and_write("note.md", "desired", Some(&first.content_hash), false)
        .unwrap();

    let retried = store
        .compare_and_write("note.md", "desired", Some(&first.content_hash), false)
        .unwrap();
    assert_eq!(retried.content_hash, desired.content_hash);
}

#[test]
fn failure_before_atomic_commit_preserves_the_previous_file() {
    let (_dir, store) = initialized_store();
    store
        .compare_and_write("note.md", "committed", None, false)
        .unwrap();
    let path = store.notes_dir().join("note.md");

    let result = atomic_replace_with_hook(
        &path,
        b"replacement",
        || Err(NoteFileError::Io("forced pre-commit failure".to_string())),
    );

    assert!(result.is_err());
    assert_eq!(store.read("note.md").unwrap().content, "committed");
}

#[test]
fn stage_restore_and_finalize_preserve_then_remove_exact_bytes() {
    let (_dir, store) = initialized_store();
    store
        .compare_and_write("a.md", "alpha\r\nCafé", None, false)
        .unwrap();

    let stage = store.stage_paths(&["a.md".to_string()]).unwrap();
    assert!(matches!(store.read("a.md"), Err(NoteFileError::Missing { .. })));

    store.restore_stage(&stage).unwrap();
    assert_eq!(store.read("a.md").unwrap().content, "alpha\r\nCafé");

    let stage = store.stage_paths(&["a.md".to_string()]).unwrap();
    store.finalize_stage(&stage).unwrap();
    assert!(matches!(store.read("a.md"), Err(NoteFileError::Missing { .. })));
    assert!(store.staged_entries().unwrap().is_empty());
}

#[test]
fn stage_all_recreates_notes_and_can_restore_the_complete_directory() {
    let (_dir, store) = initialized_store();
    store.compare_and_write("a.md", "alpha", None, false).unwrap();
    store.compare_and_write("b.md", "beta", None, false).unwrap();

    let stage = store.stage_all_notes().unwrap();
    assert!(store.notes_dir().is_dir());
    assert!(matches!(store.read("a.md"), Err(NoteFileError::Missing { .. })));
    assert_eq!(store.staged_entries().unwrap().len(), 2);

    store.restore_stage(&stage).unwrap();
    assert_eq!(store.read("a.md").unwrap().content, "alpha");
    assert_eq!(store.read("b.md").unwrap().content, "beta");
    assert!(store.staged_entries().unwrap().is_empty());
}
```

Add confinement and read-failure cases:

```rust
#[test]
fn traversal_and_absolute_paths_are_rejected() {
    let (_dir, store) = initialized_store();
    assert!(matches!(
        store.compare_and_write("../outside.md", "x", None, false),
        Err(NoteFileError::InvalidPath)
    ));
    assert!(matches!(
        store.compare_and_write("/tmp/outside.md", "x", None, false),
        Err(NoteFileError::InvalidPath)
    ));
}

#[cfg(unix)]
#[test]
fn symlink_resolving_outside_the_notes_root_is_rejected() {
    use std::os::unix::fs::symlink;

    let (dir, store) = initialized_store();
    let outside = dir.path().join("outside.md");
    std::fs::write(&outside, b"private").unwrap();
    symlink(&outside, store.notes_dir().join("linked.md")).unwrap();

    assert!(matches!(store.read("linked.md"), Err(NoteFileError::InvalidPath)));

    let dangling = dir.path().join("missing-outside.md");
    symlink(&dangling, store.notes_dir().join("dangling.md")).unwrap();
    assert!(matches!(
        store.compare_and_write("dangling.md", "private", None, false),
        Err(NoteFileError::InvalidPath)
    ));
    assert!(!dangling.exists());
}

#[cfg(unix)]
#[test]
fn initialize_rejects_a_notes_root_symlinked_outside_app_data() {
    use std::os::unix::fs::symlink;

    let (dir, store) = initialized_store();
    std::fs::remove_dir(store.notes_dir()).unwrap();
    let outside = dir.path().join("outside-notes");
    std::fs::create_dir(&outside).unwrap();
    symlink(&outside, store.notes_dir()).unwrap();

    assert!(matches!(store.initialize(), Err(NoteFileError::InvalidPath)));
}

#[test]
fn missing_and_non_utf8_files_have_distinct_errors() {
    let (_dir, store) = initialized_store();
    assert!(matches!(
        store.read("missing.md"),
        Err(NoteFileError::Missing { .. })
    ));

    std::fs::write(store.notes_dir().join("binary.md"), [0xff, 0xfe]).unwrap();
    assert!(matches!(
        store.read("binary.md"),
        Err(NoteFileError::Unreadable { .. })
    ));
    assert!(matches!(
        store.compare_and_write("binary.md", "replacement", None, false),
        Err(NoteFileError::Unreadable { .. })
    ));
}
```

- [ ] **Step 2: Run the focused native test and verify failure**

Run:

```bash
cd src-tauri
cargo test note_files -- --nocapture
```

Expected: compilation fails because `note_files` and the stated types do not
exist.

- [ ] **Step 3: Add the native dependencies and module registration**

Add:

```toml
atomic-write-file = "=0.2.3"
chrono = { version = "0.4", features = ["clock"] }
sha2 = "0.10"
uuid = { version = "1", features = ["v4"] }
```

Pin `atomic-write-file` to `0.2.3`: the `0.3` line moved to Rust 2024 and
requires Rust 1.85, which is incompatible with this crate's declared Rust
1.77.2 minimum.

Register the module in `src-tauri/src/lib.rs`:

```rust
mod note_files;
```

- [ ] **Step 4: Implement path confinement, hashing, and atomic replacement**

Use `atomic_write_file::AtomicWriteFile` for the write boundary:

```rust
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn atomic_replace_with_hook<F>(
    path: &Path,
    bytes: &[u8],
    before_commit: F,
) -> Result<(), NoteFileError>
where
    F: FnOnce() -> Result<(), NoteFileError>,
{
    use atomic_write_file::AtomicWriteFile;
    use std::io::Write;

    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| NoteFileError::Io(error.to_string()))?;
    file.write_all(bytes)
        .map_err(|error| NoteFileError::Io(error.to_string()))?;
    before_commit()?;
    file.commit()
        .map_err(|error| NoteFileError::Io(error.to_string()))
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), NoteFileError> {
    atomic_replace_with_hook(path, bytes, || Ok(()))
}
```

Before reading or writing, reject absolute paths and `ParentDir`,
`RootDir`, or platform prefix components. Canonicalize the notes root and
any existing target, and reject an existing target whose canonical path is
outside the canonical notes root. For a new file, canonicalize and verify
its parent. Use `symlink_metadata` to reject a dangling final-component
symlink before treating it as a missing file. During initialization,
canonicalize app data and require both
`notes` and `note-trash` to remain beneath it; reject either directory when
it resolves through a symlink outside app data. Accept only a non-empty
ASCII alphanumeric/hyphen session ID
and parse `local_date` as a `chrono::NaiveDate` before interpolating either
into a filename. Production IDs remain the full UUID; the broader
validation keeps small test IDs usable without weakening path safety.

Implement conflict order exactly, propagating every read failure except a
genuinely missing path:

```rust
let desired_hash = sha256_hex(content.as_bytes());
match self.read(relative_path) {
    Ok(current) => {
        let expected_matches = expected_hash == Some(current.content_hash.as_str());
        let desired_already_landed = desired_hash == current.content_hash;
        if !force && !expected_matches && !desired_already_landed {
            return Err(NoteFileError::Conflict {
                disk_content: current.content,
                disk_hash: current.content_hash,
            });
        }
        if desired_already_landed {
            return Ok(current);
        }
    }
    Err(NoteFileError::Missing { .. }) => {
        if expected_hash.is_some() && !force {
            return Err(NoteFileError::Missing {
                relative_path: relative_path.to_string(),
            });
        }
    }
    Err(error) => return Err(error),
}
```

Create staged operations beneath the sibling `note-trash` directory using
a UUID operation directory while preserving the original relative path:

```text
note-trash/<operation-id>/notes/<relative-path>
```

`restore_stage` atomically renames each staged file to its original path.
It must not overwrite an original that appeared after staging; leave the
staged copy intact and return an error for startup recovery.
`finalize_stage` removes only that operation directory.
`stage_all_notes` renames the complete `notes` directory into the
operation directory and immediately recreates an empty `notes` directory.
Restoring a whole-directory stage removes that empty replacement directory
before renaming the staged directory back. An empty `stage_paths` input
returns a no-op `StagedDeletion`; restoring or finalizing it succeeds
without creating an operation directory. `stage_paths` validates and
deduplicates its inputs, skips a genuinely absent file, and propagates all
other path or rename errors. This lets an explicit session deletion clean stale
metadata when its note file is already gone; note clearing performs its own
required read/hash guard first. `staged_entries` recursively lists every
staged file, including files captured by `stage_all_notes`.
These primitives do not query SQLite; metadata-driven recovery is Task 3.

- [ ] **Step 5: Run native tests and static checks**

Run:

```bash
cd src-tauri
cargo test note_files -- --nocapture
cargo check
```

Expected: all `note_files` tests pass and `cargo check` exits 0.

- [ ] **Step 6: Commit the native file boundary**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/note_files.rs
git commit -m "feat: add atomic Markdown note file store"
```

---

### Task 2: SQLite Metadata Migration And Native Note Commands

**Files:**
- Create: `src-tauri/src/note_commands.rs`
- Create: `src-tauri/permissions/note-commands.toml`
- Modify: `src-tauri/src/migrations.rs`
- Modify: `src-tauri/src/db_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `NoteFileStore`, the existing `sqlite:pomodoro.db` pool, Phase
  4A `session_notes` rows, and session task/start metadata.
- Produces these commands:

```rust
initialize_note_storage() -> Result<(), NoteCommandError>
save_session_note(
    session_id: String,
    content: String,
    expected_hash: Option<String>,
    now: i64,
    force: bool,
) -> Result<SaveNoteResponse, NoteCommandError>
load_session_note(session_id: String) -> Result<Option<SessionNoteDto>, NoteCommandError>
load_all_session_notes() -> Result<Vec<SessionNoteDto>, NoteCommandError>
```

Keep command wrappers thin around these testable cores:

```rust
async fn initialize_note_storage_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<(), NoteCommandError>;

async fn save_session_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    content: &str,
    expected_hash: Option<&str>,
    now: i64,
    force: bool,
) -> Result<SaveNoteResponse, NoteCommandError>;

async fn load_session_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
) -> Result<Option<SessionNoteDto>, NoteCommandError>;

async fn load_all_session_notes_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<Vec<SessionNoteDto>, NoteCommandError>;
```

The serialized DTO contract is:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNoteDto {
    pub id: String,
    pub session_id: String,
    pub content: String,
    pub file_path: Option<String>,
    pub content_hash: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteResponse {
    pub note: Option<SessionNoteDto>,
    pub cleanup_pending: bool,
}
```

- [ ] **Step 1: Add migration version 3 and a schema assertion test**

Append:

```rust
Migration {
    version: 3,
    description: "add Markdown file metadata to session_notes",
    sql: r#"
        ALTER TABLE session_notes ADD COLUMN file_path TEXT;
        ALTER TABLE session_notes ADD COLUMN content_hash TEXT;
        CREATE UNIQUE INDEX idx_session_notes_file_path
            ON session_notes(file_path)
            WHERE file_path IS NOT NULL;
    "#,
    kind: MigrationKind::Up,
}
```

Add a migration test that applies versions 1 through 3 to a temporary
SQLite database:

```rust
#[tokio::test]
async fn version_three_keeps_legacy_content_and_adds_file_metadata() {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    let dir = tempfile::tempdir().unwrap();
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(dir.path().join("migrations.db"))
                .create_if_missing(true),
        )
        .await
        .unwrap();
    for migration in migrations() {
        sqlx::raw_sql(migration.sql.as_ref())
            .execute(&pool)
            .await
            .unwrap();
    }
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM pragma_table_info('session_notes')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert!(columns.contains(&"content".to_string()));
    assert!(columns.contains(&"file_path".to_string()));
    assert!(columns.contains(&"content_hash".to_string()));
}
```

- [ ] **Step 2: Write failing migration, load, save, clear, and error-shape tests**

In `note_commands.rs`, test the core functions without a Tauri app. Define
the fixture in that test module:

```rust
struct TestFixture {
    _dir: tempfile::TempDir,
    pool: sqlx::SqlitePool,
    store: NoteFileStore,
}

#[derive(sqlx::FromRow)]
struct TestNoteMetadata {
    content: String,
    file_path: Option<String>,
    content_hash: Option<String>,
}

impl TestFixture {
    async fn new() -> Self {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let dir = tempfile::tempdir().expect("create fixture root");
        let db_path = dir.path().join("notes.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .expect("connect fixture database");
        sqlx::query(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                task TEXT NOT NULL,
                started_at INTEGER
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE session_notes (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                content TEXT NOT NULL,
                file_path TEXT,
                content_hash TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();

        let store = NoteFileStore::new(dir.path().join("app-data"));
        store.initialize().unwrap();
        Self { _dir: dir, pool, store }
    }

    async fn insert_session(&self, id: &str, task: &str, started_at: i64) {
        sqlx::query("INSERT INTO sessions (id, task, started_at) VALUES (?, ?, ?)")
            .bind(id)
            .bind(task)
            .bind(started_at)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    async fn insert_legacy_note(&self, id: &str, session_id: &str, content: &str) {
        sqlx::query(
            "INSERT INTO session_notes (
                id, session_id, content, created_at, updated_at
            ) VALUES (?, ?, ?, 1000, 1000)",
        )
        .bind(id)
        .bind(session_id)
        .bind(content)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn note_metadata(&self, session_id: &str) -> TestNoteMetadata {
        sqlx::query_as(
            "SELECT content, file_path, content_hash
             FROM session_notes WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn legacy_content(&self, session_id: &str) -> String {
        sqlx::query_scalar("SELECT content FROM session_notes WHERE session_id = ?")
            .bind(session_id)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn fail_next_metadata_update(&self) {
        sqlx::query(
            "CREATE TRIGGER fail_note_metadata_update
             BEFORE UPDATE OF file_path ON session_notes
             BEGIN
                 SELECT RAISE(ABORT, 'forced metadata failure');
             END",
        )
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn allow_metadata_updates(&self) {
        sqlx::query("DROP TRIGGER fail_note_metadata_update")
            .execute(&self.pool)
            .await
            .unwrap();
    }

    async fn insert_file_backed_note(
        &self,
        session_id: &str,
        file_content: &str,
        stale_sqlite_content: &str,
    ) {
        self.insert_session(session_id, "Task", 1_722_163_200_000).await;
        let file_path = format!("{session_id}.md");
        let stored = self
            .store
            .compare_and_write(&file_path, file_content, None, false)
            .unwrap();
        sqlx::query(
            "INSERT INTO session_notes (
                id, session_id, content, file_path, content_hash, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1000, 1000)",
        )
        .bind(format!("note-{session_id}"))
        .bind(session_id)
        .bind(stale_sqlite_content)
        .bind(file_path)
        .bind(stored.content_hash)
        .execute(&self.pool)
        .await
        .unwrap();
    }
}
```

Then write:

```rust
#[tokio::test]
async fn legacy_content_migrates_byte_for_byte_and_clears_sqlite_content() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Write report", 1_722_163_200_000).await;
    fixture.insert_legacy_note("n1", "s1", "line one\r\nCafé").await;

    initialize_note_storage_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    let row = fixture.note_metadata("s1").await;
    assert_eq!(row.content, "");
    assert!(row.file_path.is_some());
    assert!(row.content_hash.is_some());
    let loaded = load_session_note_core(&fixture.pool, &fixture.store, "s1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.content.as_bytes(), "line one\r\nCafé".as_bytes());
}

#[tokio::test]
async fn metadata_failure_after_file_write_is_idempotent_on_retry() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Write report", 1_722_163_200_000).await;
    fixture.insert_legacy_note("n1", "s1", "legacy").await;
    fixture.fail_next_metadata_update().await;

    assert!(initialize_note_storage_core(&fixture.pool, &fixture.store).await.is_err());
    assert_eq!(fixture.legacy_content("s1").await, "legacy");

    fixture.allow_metadata_updates().await;
    initialize_note_storage_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();
    assert_eq!(
        load_session_note_core(&fixture.pool, &fixture.store, "s1")
            .await
            .unwrap()
            .unwrap()
            .content,
        "legacy"
    );
}

#[tokio::test]
async fn migration_file_failure_leaves_legacy_content_authoritative() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Write report", 1_722_163_200_000).await;
    fixture.insert_legacy_note("n1", "s1", "legacy survives").await;
    let relative_path = fixture
        .store
        .note_relative_path("s1", "Write report", "2024-07-28")
        .unwrap();
    std::fs::create_dir(fixture.store.notes_dir().join(relative_path)).unwrap();

    assert!(initialize_note_storage_core(&fixture.pool, &fixture.store)
        .await
        .is_err());
    assert_eq!(fixture.legacy_content("s1").await, "legacy survives");
}

#[tokio::test]
async fn file_backed_load_never_falls_back_to_stale_legacy_content() {
    let fixture = TestFixture::new().await;
    fixture.insert_file_backed_note("s1", "file content", "stale sqlite").await;

    let note = load_session_note_core(&fixture.pool, &fixture.store, "s1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(note.content, "file content");
}

#[tokio::test]
async fn load_accepts_an_external_edit_and_refreshes_the_metadata_hash() {
    let fixture = TestFixture::new().await;
    fixture.insert_file_backed_note("s1", "initial", "").await;
    let before = fixture.note_metadata("s1").await;
    let path = before.file_path.as_deref().unwrap();
    let external = fixture
        .store
        .compare_and_write(
            path,
            "external edit",
            before.content_hash.as_deref(),
            true,
        )
        .unwrap();

    let loaded = load_session_note_core(&fixture.pool, &fixture.store, "s1")
        .await
        .unwrap()
        .unwrap();
    let after = fixture.note_metadata("s1").await;

    assert_eq!(loaded.content, "external edit");
    assert_eq!(loaded.content_hash.as_deref(), Some(external.content_hash.as_str()));
    assert_eq!(after.content_hash.as_deref(), Some(external.content_hash.as_str()));
}
```

Add these concrete cases:

```rust
#[tokio::test]
async fn whitespace_legacy_rows_are_removed_without_creating_files() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
    fixture.insert_legacy_note("n1", "s1", " \n\t ").await;

    initialize_note_storage_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_notes")
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn update_preserves_id_and_created_at_and_carry_creates_a_second_file() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "First", 1_722_163_200_000).await;
    fixture.insert_session("s2", "Second", 1_722_166_800_000).await;

    let first = save_session_note_core(
        &fixture.pool, &fixture.store, "s1", "draft", None, 1000, false,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let updated = save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        "final",
        first.content_hash.as_deref(),
        2000,
        false,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    let carried = save_session_note_core(
        &fixture.pool, &fixture.store, "s2", "final", None, 3000, false,
    )
    .await
    .unwrap()
    .note
    .unwrap();

    assert_eq!(updated.id, first.id);
    assert_eq!(updated.created_at, first.created_at);
    assert_ne!(carried.id, first.id);
    assert_ne!(carried.file_path, first.file_path);
    assert_eq!(carried.content, updated.content);
}

#[tokio::test]
async fn ordinary_save_retries_metadata_after_the_file_already_landed() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
    let first = save_session_note_core(
        &fixture.pool, &fixture.store, "s1", "first", None, 1000, false,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    fixture.fail_next_metadata_update().await;

    assert!(save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        "second",
        first.content_hash.as_deref(),
        2000,
        false,
    )
    .await
    .is_err());
    fixture.allow_metadata_updates().await;

    let retried = save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        "second",
        first.content_hash.as_deref(),
        2000,
        false,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    assert_eq!(retried.content, "second");
    assert_eq!(
        fixture.note_metadata("s1").await.content_hash,
        retried.content_hash
    );
}

#[tokio::test]
async fn whitespace_save_removes_the_file_and_metadata() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
    let first = save_session_note_core(
        &fixture.pool, &fixture.store, "s1", "content", None, 1000, false,
    )
    .await
    .unwrap()
    .note
    .unwrap();

    let cleared = save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        " \n\t ",
        first.content_hash.as_deref(),
        2000,
        false,
    )
    .await
    .unwrap();

    assert!(cleared.note.is_none());
    assert!(!cleared.cleanup_pending);
    assert!(matches!(
        fixture.store.read(first.file_path.as_deref().unwrap()),
        Err(NoteFileError::Missing { .. })
    ));
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'",
    )
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn whitespace_clear_refuses_to_delete_an_external_edit() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
    let first = save_session_note_core(
        &fixture.pool, &fixture.store, "s1", "initial", None, 1000, false,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    fixture
        .store
        .compare_and_write(
            first.file_path.as_deref().unwrap(),
            "external edit",
            first.content_hash.as_deref(),
            true,
        )
        .unwrap();

    let result = save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        " \n\t ",
        first.content_hash.as_deref(),
        2000,
        false,
    )
    .await;

    assert!(matches!(result, Err(NoteCommandError::Conflict { .. })));
    assert_eq!(
        fixture
            .store
            .read(first.file_path.as_deref().unwrap())
            .unwrap()
            .content,
        "external edit"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'",
        )
        .fetch_one(&fixture.pool)
        .await
        .unwrap(),
        1
    );
}

#[tokio::test]
async fn conflict_and_missing_errors_keep_their_structured_fields() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
    let first = save_session_note_core(
        &fixture.pool, &fixture.store, "s1", "first", None, 1000, false,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    fixture
        .store
        .compare_and_write(
            first.file_path.as_deref().unwrap(),
            "external",
            first.content_hash.as_deref(),
            true,
        )
        .unwrap();

    let conflict = save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        "local",
        first.content_hash.as_deref(),
        2000,
        false,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        conflict,
        NoteCommandError::Conflict {
            disk_content,
            disk_hash: _
        } if disk_content == "external"
    ));

    let forced = save_session_note_core(
        &fixture.pool,
        &fixture.store,
        "s1",
        "local",
        first.content_hash.as_deref(),
        2000,
        true,
    )
    .await
    .unwrap()
    .note
    .unwrap();
    assert_eq!(forced.content, "local");

    std::fs::remove_file(
        fixture
            .store
            .notes_dir()
            .join(first.file_path.as_deref().unwrap()),
    )
    .unwrap();
    let missing = load_session_note_core(&fixture.pool, &fixture.store, "s1")
        .await
        .unwrap_err();
    assert!(matches!(missing, NoteCommandError::Missing { .. }));
}

#[tokio::test]
async fn load_all_reads_every_file_backed_note() {
    let fixture = TestFixture::new().await;
    fixture.insert_session("s1", "First", 1_722_163_200_000).await;
    fixture.insert_session("s2", "Second", 1_722_166_800_000).await;
    save_session_note_core(
        &fixture.pool, &fixture.store, "s1", "one", None, 1000, false,
    )
    .await
    .unwrap();
    save_session_note_core(
        &fixture.pool, &fixture.store, "s2", "two", None, 2000, false,
    )
    .await
    .unwrap();

    let notes = load_all_session_notes_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();
    let contents: std::collections::BTreeSet<_> =
        notes.into_iter().map(|note| note.content).collect();
    assert_eq!(
        contents,
        std::collections::BTreeSet::from(["one".to_string(), "two".to_string()])
    );
}
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
cd src-tauri
cargo test note_commands -- --nocapture
```

Expected: compilation fails because the command module and migration
helpers do not exist.

- [ ] **Step 4: Implement the native command error and migration core**

Use a serializable tagged error without absolute paths or note content in
ordinary I/O messages:

```rust
#[derive(Debug, serde::Serialize)]
#[serde(
    tag = "code",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NoteCommandError {
    Conflict { disk_content: String, disk_hash: String },
    Missing { relative_path: String },
    Unreadable { relative_path: String },
    Transient { message: String },
}
```

Migration must:

1. Query rows where `file_path IS NULL`.
2. Delete whitespace-only rows.
3. Load `task` and `started_at` from `sessions`.
4. If the session row is missing, leave the legacy row untouched and return
   a transient migration error rather than dropping content.
5. Convert `started_at` to a local `YYYY-MM-DD` with `chrono::Local`.
6. Write the file.
7. Update `file_path`, `content_hash`, and `content = ''` in one SQLite
   statement while preserving the row's original timestamps.

Implement the loop with explicit row types:

```rust
#[derive(sqlx::FromRow)]
struct LegacyNoteRow {
    id: String,
    session_id: String,
    content: String,
}

#[derive(sqlx::FromRow)]
struct SessionNamingMetadata {
    task: String,
    started_at: i64,
}

#[derive(sqlx::FromRow)]
struct ExistingNoteMetadata {
    id: String,
    file_path: Option<String>,
    created_at: i64,
}

let rows = sqlx::query_as::<_, LegacyNoteRow>(
    "SELECT id, session_id, content
     FROM session_notes
     WHERE file_path IS NULL",
)
.fetch_all(pool)
.await?;

for row in rows {
    if row.content.trim().is_empty() {
        sqlx::query("DELETE FROM session_notes WHERE id = ?")
            .bind(&row.id)
            .execute(pool)
            .await?;
        continue;
    }
    let session = sqlx::query_as::<_, SessionNamingMetadata>(
        "SELECT task, started_at FROM sessions WHERE id = ?",
    )
    .bind(&row.session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| NoteCommandError::Transient {
        message: "legacy note session metadata unavailable".to_string(),
    })?;
    let local_date = chrono::Local
        .timestamp_millis_opt(session.started_at)
        .single()
        .ok_or_else(|| NoteCommandError::Transient {
            message: "invalid session start timestamp".to_string(),
        })?
        .format("%Y-%m-%d")
        .to_string();
    let relative_path = store.note_relative_path(
        &row.session_id,
        &session.task,
        &local_date,
    )?;
    let stored = store.compare_and_write(
        &relative_path,
        &row.content,
        None,
        false,
    )?;
    sqlx::query(
        "UPDATE session_notes
         SET content = '', file_path = ?, content_hash = ?
         WHERE id = ?",
    )
    .bind(relative_path)
    .bind(stored.content_hash)
    .bind(row.id)
    .execute(pool)
    .await?;
}
```

- [ ] **Step 5: Implement load and save core functions**

Query the current note metadata and session naming inputs first:

```rust
let existing = sqlx::query_as::<_, ExistingNoteMetadata>(
    "SELECT id, file_path, created_at FROM session_notes WHERE session_id = ?",
)
.bind(session_id)
.fetch_optional(pool)
.await?;
let session = sqlx::query_as::<_, SessionNamingMetadata>(
    "SELECT task, started_at FROM sessions WHERE id = ?",
)
.bind(session_id)
.fetch_optional(pool)
.await?
.ok_or_else(|| NoteCommandError::Transient {
    message: "session metadata unavailable".to_string(),
})?;
let note_id = existing
    .as_ref()
    .map(|note| note.id.clone())
    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
let created_at = existing.as_ref().map(|note| note.created_at).unwrap_or(now);
let local_date = chrono::Local
    .timestamp_millis_opt(session.started_at)
    .single()
    .ok_or_else(|| NoteCommandError::Transient {
        message: "invalid session start timestamp".to_string(),
    })?
    .format("%Y-%m-%d")
    .to_string();
let relative_path = match existing.and_then(|note| note.file_path) {
    Some(path) => path,
    None => store.note_relative_path(session_id, &session.task, &local_date)?,
};
```

Import `chrono::TimeZone`. Then use this save ordering:

```rust
let stored = store.compare_and_write(
    &relative_path,
    &content,
    expected_hash.as_deref(),
    force,
)?;

sqlx::query(
    r#"
    INSERT INTO session_notes (
        id, session_id, content, file_path, content_hash, created_at, updated_at
    ) VALUES (?, ?, '', ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
        content = '',
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    "#,
)
.bind(note_id)
.bind(session_id)
.bind(&relative_path)
.bind(&stored.content_hash)
.bind(created_at)
.bind(now)
.execute(pool)
.await?;
```

For `load_session_note_core` and every row in
`load_all_session_notes_core`, read the file once through `NoteFileStore`,
return that exact content/hash, and update SQLite's `content_hash` when it
differs from the freshly read hash. This accepts an external edit made
while the app was closed. Propagate a metadata-refresh failure as
`Transient`; never return the stale SQLite hash or fall back to `content`.

When content is whitespace-only and no metadata row exists, return
`SaveNoteResponse { note: None, cleanup_pending: false }`. When a row
exists, read its current file before staging and apply the same
expected-hash/force check as a normal write; a stale hash returns
`Conflict` with the disk version instead of deleting it. After that guard,
use Task 1's `stage_paths`, delete the metadata row, then call
`finalize_stage`. Restore the stage when metadata deletion fails. Return
`cleanup_pending: true` only when metadata deletion committed but final
staging cleanup failed.

- [ ] **Step 6: Register commands and narrow permissions**

Change the existing pool helper in `db_commands.rs` to
`pub(crate) async fn sqlite_pool(...)`. Every note command wrapper must
call this helper so it uses the same `sqlite:pomodoro.db` pool registered
by `tauri-plugin-sql`; do not create a second pool. Map lookup failures to
`NoteCommandError::Transient`.

Initialize and manage the store:

```rust
.setup(|app| {
    use tauri::Manager;
    let root = app.path().app_data_dir()?;
    let store = note_files::NoteFileStore::new(root);
    store
        .initialize()
        .map_err(|error| std::io::Error::other(format!("{error:?}")))?;
    app.manage(store);
    Ok(())
})
```

Add each exposed command to `generate_handler!`. Define matching custom
permissions in `note-commands.toml` and add only those identifiers to the
main capability. Do not grant generic filesystem read/write access for
the notes directory.

- [ ] **Step 7: Run migration and command checks**

Run:

```bash
cd src-tauri
cargo test note_commands -- --nocapture
cargo test migrations -- --nocapture
cargo check
```

Expected: all focused tests pass and `cargo check` exits 0.

- [ ] **Step 8: Commit native note persistence**

```bash
git add src-tauri/src/migrations.rs src-tauri/src/note_commands.rs src-tauri/src/db_commands.rs src-tauri/src/lib.rs src-tauri/permissions/note-commands.toml src-tauri/capabilities/default.json
git commit -m "feat: migrate session notes to Markdown files"
```

---

### Task 3: File-Aware Deletion And Startup Recovery

**Files:**
- Modify: `src-tauri/src/note_files.rs`
- Modify: `src-tauri/src/note_commands.rs`
- Modify: `src-tauri/src/db_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/db-commands.toml`

**Interfaces:**
- Consumes: relative `file_path` metadata, the shared note store, and the
  existing SQLite delete transactions.
- Produces database-driven use of Task 1's staging API plus:

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub cleanup_pending: bool,
}

async fn recover_staged_deletions_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<(), NoteCommandError>;

async fn delete_session_with_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    id: &str,
) -> Result<DeleteOutcome, NoteCommandError>;

async fn delete_all_data_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<DeleteOutcome, NoteCommandError>;
```

- [ ] **Step 1: Write failing database/file coordination tests**

Replace the existing test schema with the Phase 4B columns and define:

```rust
struct FileBackedDeleteFixture {
    _dir: tempfile::TempDir,
    pool: sqlx::SqlitePool,
    store: NoteFileStore,
}

impl FileBackedDeleteFixture {
    async fn new() -> Self {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

        let dir = tempfile::tempdir().expect("create fixture root");
        let db_path = dir.path().join("delete.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .expect("connect fixture database");
        sqlx::query(
            "CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                task TEXT NOT NULL,
                status TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE session_notes (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                content TEXT NOT NULL,
                file_path TEXT,
                content_hash TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE parked_thoughts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                text TEXT NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .unwrap();
        let store = NoteFileStore::new(dir.path().join("app-data"));
        store.initialize().unwrap();
        Self { _dir: dir, pool, store }
    }

    async fn insert_session_note(
        &self,
        session_id: &str,
        file_path: &str,
        content: &str,
    ) {
        let stored = self
            .store
            .compare_and_write(file_path, content, None, false)
            .unwrap();
        sqlx::query(
            "INSERT INTO sessions (id, task, status) VALUES (?, 'Task', 'complete')",
        )
        .bind(session_id)
        .execute(&self.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO session_notes (
                id, session_id, content, file_path, content_hash, created_at, updated_at
            ) VALUES (?, ?, '', ?, ?, 1000, 1000)",
        )
        .bind(format!("note-{session_id}"))
        .bind(session_id)
        .bind(file_path)
        .bind(stored.content_hash)
        .execute(&self.pool)
        .await
        .unwrap();
    }

    async fn fail_note_delete(&self) {
        sqlx::query(
            "CREATE TRIGGER fail_note_delete
             BEFORE DELETE ON session_notes
             BEGIN
                 SELECT RAISE(ABORT, 'forced note delete failure');
             END",
        )
            .execute(&self.pool)
            .await
            .unwrap();
    }
}
```

Then extend `db_commands.rs` tests:

```rust
#[tokio::test]
async fn deleting_a_session_commits_the_rows_then_removes_its_file() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "content").await;

    let outcome = delete_session_with_note_core(&fixture.pool, &fixture.store, "s1")
        .await
        .unwrap();

    assert!(!outcome.cleanup_pending);
    assert_eq!(row_count(&fixture.pool, "sessions").await, 0);
    assert_eq!(row_count(&fixture.pool, "session_notes").await, 0);
    assert!(matches!(
        fixture.store.read("s1.md"),
        Err(NoteFileError::Missing { .. })
    ));
}

#[tokio::test]
async fn deleting_one_session_does_not_touch_an_unrelated_note() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "one").await;
    fixture.insert_session_note("s2", "s2.md", "two").await;

    delete_session_with_note_core(&fixture.pool, &fixture.store, "s1")
        .await
        .unwrap();

    assert!(matches!(
        fixture.store.read("s1.md"),
        Err(NoteFileError::Missing { .. })
    ));
    assert_eq!(fixture.store.read("s2.md").unwrap().content, "two");
    assert_eq!(row_count(&fixture.pool, "sessions").await, 1);
    assert_eq!(row_count(&fixture.pool, "session_notes").await, 1);
}

#[tokio::test]
async fn failed_sql_transaction_restores_the_staged_file() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "content").await;
    fixture.fail_note_delete().await;

    assert!(
        delete_session_with_note_core(&fixture.pool, &fixture.store, "s1")
            .await
            .is_err()
    );
    assert_eq!(fixture.store.read("s1.md").unwrap().content, "content");
    assert_eq!(row_count(&fixture.pool, "sessions").await, 1);
}
```

Add delete-all and startup recovery cases:

```rust
#[tokio::test]
async fn delete_all_clears_rows_and_every_note_file() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "one").await;
    fixture.insert_session_note("s2", "s2.md", "two").await;
    sqlx::query(
        "INSERT INTO parked_thoughts (id, session_id, text)
         VALUES ('t1', 's1', 'thought')",
    )
    .execute(&fixture.pool)
    .await
    .unwrap();

    let outcome = delete_all_data_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    assert!(!outcome.cleanup_pending);
    assert_eq!(row_count(&fixture.pool, "sessions").await, 0);
    assert_eq!(row_count(&fixture.pool, "session_notes").await, 0);
    assert_eq!(row_count(&fixture.pool, "parked_thoughts").await, 0);
    assert!(fixture.store.staged_entries().unwrap().is_empty());
}

#[tokio::test]
async fn startup_restores_a_staged_file_when_metadata_still_references_it() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "content").await;
    fixture
        .store
        .stage_paths(&["s1.md".to_string()])
        .unwrap();

    recover_staged_deletions_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    assert_eq!(fixture.store.read("s1.md").unwrap().content, "content");
    assert!(fixture.store.staged_entries().unwrap().is_empty());
}

#[tokio::test]
async fn startup_finishes_a_staged_delete_when_metadata_is_gone() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "content").await;
    fixture
        .store
        .stage_paths(&["s1.md".to_string()])
        .unwrap();
    sqlx::query("DELETE FROM session_notes WHERE session_id = 's1'")
        .execute(&fixture.pool)
        .await
        .unwrap();

    recover_staged_deletions_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    assert!(matches!(
        fixture.store.read("s1.md"),
        Err(NoteFileError::Missing { .. })
    ));
    assert!(fixture.store.staged_entries().unwrap().is_empty());
}

#[tokio::test]
async fn startup_refuses_to_guess_when_original_and_stage_both_conflict_with_metadata() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "expected").await;
    fixture
        .store
        .stage_paths(&["s1.md".to_string()])
        .unwrap();
    fixture
        .store
        .compare_and_write("s1.md", "unexpected", None, true)
        .unwrap();

    let result = recover_staged_deletions_core(&fixture.pool, &fixture.store).await;
    assert!(result.is_err());
    assert_eq!(fixture.store.read("s1.md").unwrap().content, "unexpected");
    assert!(!fixture.store.staged_entries().unwrap().is_empty());
}

#[tokio::test]
async fn startup_restores_an_interrupted_delete_all_when_rows_remain() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "one").await;
    fixture.insert_session_note("s2", "s2.md", "two").await;
    fixture.store.stage_all_notes().unwrap();

    recover_staged_deletions_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    assert_eq!(fixture.store.read("s1.md").unwrap().content, "one");
    assert_eq!(fixture.store.read("s2.md").unwrap().content, "two");
    assert!(fixture.store.staged_entries().unwrap().is_empty());
}

#[tokio::test]
async fn startup_finishes_an_interrupted_delete_all_when_rows_are_gone() {
    let fixture = FileBackedDeleteFixture::new().await;
    fixture.insert_session_note("s1", "s1.md", "one").await;
    fixture.insert_session_note("s2", "s2.md", "two").await;
    fixture.store.stage_all_notes().unwrap();
    sqlx::query("DELETE FROM session_notes")
        .execute(&fixture.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM sessions")
        .execute(&fixture.pool)
        .await
        .unwrap();

    recover_staged_deletions_core(&fixture.pool, &fixture.store)
        .await
        .unwrap();

    assert!(matches!(
        fixture.store.read("s1.md"),
        Err(NoteFileError::Missing { .. })
    ));
    assert!(matches!(
        fixture.store.read("s2.md"),
        Err(NoteFileError::Missing { .. })
    ));
    assert!(fixture.store.staged_entries().unwrap().is_empty());
}
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
cd src-tauri
cargo test note_files -- --nocapture
cargo test db_commands -- --nocapture
```

Expected: new staging and file-aware delete tests fail.

- [ ] **Step 3: Implement metadata-driven recovery**

Create each operation beneath the sibling `note-trash` directory so rename
stays on the app-data volume. Preserve the original relative path inside
the operation directory:

```text
note-trash/<operation-id>/notes/<relative-path>
```

`initialize_note_storage_core` must call recovery before legacy migration.
For each staged file:

```rust
for entry in store.staged_entries()? {
    let expected_hash = sqlx::query_scalar::<_, Option<String>>(
        "SELECT content_hash FROM session_notes WHERE file_path = ?",
    )
    .bind(&entry.relative_path)
    .fetch_optional(pool)
    .await?
    .flatten();

    let Some(expected_hash) = expected_hash else {
        store.finalize_staged_entry(&entry)?;
        continue;
    };
    let staged = store.read_staged(&entry)?;
    match store.read(&entry.relative_path) {
        Err(NoteFileError::Missing { .. })
            if staged.content_hash == expected_hash =>
        {
            store.restore_staged_entry(&entry)?;
        }
        Ok(original) if original.content_hash == expected_hash => {
            store.finalize_staged_entry(&entry)?;
        }
        _ => {
            return Err(NoteCommandError::Transient {
                message: "staged note recovery requires attention".to_string(),
            });
        }
    }
}
```

When both original and staged files exist, remove the staged copy only when
the original matches SQLite's `content_hash`. If the original does not
match, retain both and return the visible recovery error above. A staged
file whose hash does not match referenced metadata is also retained for
manual recovery.

- [ ] **Step 4: Wrap the existing delete transactions with staging**

For single-session deletion:

```rust
let path = note_path_for_session(pool, id).await?;
let stage = store.stage_paths(&path.into_iter().collect::<Vec<_>>())?;
match delete_session_with_note_tx(pool, id).await {
    Ok(()) => {
        let cleanup_pending = store.finalize_stage(&stage).is_err();
        Ok(DeleteOutcome { cleanup_pending })
    }
    Err(error) => {
        store.restore_stage(&stage)?;
        Err(error.into())
    }
}
```

For delete-all, call `stage_all_notes`, run the existing all-data
transaction, then finalize or restore with the same rule.

Whitespace-note clearing in `save_session_note_core` must use the same
stage, metadata-delete, finalize pattern.

- [ ] **Step 5: Run all native tests**

Run:

```bash
cd src-tauri
cargo test
cargo check
```

Expected: all Rust tests pass, including the existing transaction
fault-injection test.

- [ ] **Step 6: Commit deletion recovery**

```bash
git add src-tauri/src/note_files.rs src-tauri/src/note_commands.rs src-tauri/src/db_commands.rs src-tauri/src/lib.rs src-tauri/permissions/db-commands.toml
git commit -m "feat: coordinate Markdown files with data deletion"
```

---

### Task 4: Frontend Repository Contract And File-Backed App Wiring

**Files:**
- Modify: `src/lib/notes.ts`
- Modify: `src/lib/notes.test.ts`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/memoryRepository.test.ts`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/repository.ts`
- Modify: `src/lib/history.ts`
- Modify: `src/lib/history.test.ts`
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: native command DTOs from Task 2 and deletion outcomes from Task
  3.
- Produces:

```ts
export interface SessionNoteRow {
  id: string;
  session_id: string;
  content: string;
  file_path: string | null;
  content_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface SaveNoteOptions {
  expectedHash?: string | null;
  force?: boolean;
}

export interface SaveNoteResult {
  note: SessionNoteRow | null;
  cleanupPending: boolean;
}

export interface DeleteOutcome {
  cleanupPending: boolean;
}

initializeNoteStorage(): Promise<void>
saveNote(
  sessionId: string,
  content: string,
  now: number,
  options?: SaveNoteOptions,
): Promise<SaveNoteResult>
loadNoteRecordForSession(sessionId: string): Promise<SessionNoteRow | null>
loadNoteForSession(sessionId: string): Promise<string | null>
loadAllSessionNotes(): Promise<SessionNoteRow[]>
deleteSessionRow(id: string): Promise<DeleteOutcome>
deleteAllData(): Promise<DeleteOutcome>
```

- [ ] **Step 1: Update failing note and memory-repository tests first**

Change row fixtures to include:

```ts
{
  id: 'n1',
  session_id: 's1',
  content: 'Some real notes',
  file_path: 'memory/s1.md',
  content_hash: 'known-hash',
  created_at: 1_000,
  updated_at: 1_000,
}
```

Add:

```ts
it('whitespace content deletes the note instead of retaining an empty row', async () => {
  await saveNote('s1', 'real note', 1_000);
  const result = await saveNote('s1', ' \n\t ', 2_000);

  expect(result.note).toBeNull();
  expect(await loadNoteForSession('s1')).toBeNull();
  expect(await loadAllSessionNotes()).toEqual([]);
});

it('returns a new content hash after every distinct saved version', async () => {
  const first = await saveNote('s1', 'first', 1_000);
  const second = await saveNote('s1', 'second', 2_000, {
    expectedHash: first.note!.content_hash,
  });

  expect(second.note!.content_hash).not.toBe(first.note!.content_hash);
  expect((await loadNoteRecordForSession('s1'))!.content).toBe('second');
});
```

- [ ] **Step 2: Run frontend tests and verify failure**

Run:

```bash
npm test -- src/lib/notes.test.ts src/lib/memoryRepository.test.ts src/lib/history.test.ts
```

Expected: type and assertion failures for the expanded contract.

- [ ] **Step 3: Implement the expanded types and memory backend**

Keep history's current `SessionNoteRow[]` input, but add metadata fields.
In memory mode, hash exact UTF-8 bytes with Web Crypto:

```ts
async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
```

Use `memory/<session-id>.md` as the non-persistent development path.
`initializeNoteStorage` is a no-op success in memory mode; all other
semantics match Tauri. Remove the public `deleteNoteForSession` repository
operation and its old direct-delete test; whitespace `saveNote` is now the
only standalone clearing path. The memory backend may use a private map
deletion helper when `deleteSessionRow` cascades.

- [ ] **Step 4: Implement Tauri wrappers and runtime dispatch**

Call `getDb()` before every native command that needs the registered SQL
pool. Normalize camel-case native DTOs into `SessionNoteRow` in one helper:

```ts
function fromNativeNote(note: NativeSessionNote): SessionNoteRow {
  return {
    id: note.id,
    session_id: note.sessionId,
    content: note.content,
    file_path: note.filePath,
    content_hash: note.contentHash,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  };
}
```

Keep `loadNoteForSession` as a compatibility convenience returning only
`record?.content ?? null`. Export the record-returning function for App
hash tracking. Remove every direct `session_notes` SQL
read/write/delete from `tauriRepository.ts`; all note content and metadata
operations now go through the native commands.

- [ ] **Step 5: Wire startup, load, save, and cleanup outcomes in App**

Initialize storage before parallel recovery reads:

```ts
await initializeNoteStorage();
const [row, thoughts, toneId] = await Promise.all([
  loadLatestSessionRow(),
  loadAllParkedThoughts(),
  getSetting(SELECTED_TONE_SETTING_KEY),
]);
```

Track expected hashes per session:

```ts
const noteHashBySession = new Map<string, string | null>();
let cleanupWarning = $state<string | null>(null);

const noteSaveController = createNoteSaveController(async (sessionId, content) => {
  const result = await writeQueue.enqueue(() =>
    saveNote(sessionId, content, Date.now(), {
      expectedHash: noteHashBySession.get(sessionId) ?? null,
    }),
  );
  if (result.note) noteHashBySession.set(sessionId, result.note.content_hash);
  else noteHashBySession.delete(sessionId);
  if (result.cleanupPending) {
    cleanupWarning = 'Note cleared, but file cleanup will retry when the app restarts.';
  }
});
```

On session recovery, load the record and seed both `noteContent` and the
hash map. Enqueue `loadNoteRecordForSession` because it may refresh
SQLite's hash after an external edit. Clear the new session's hash when
starting without carry-forward.
Preserve the existing controller invalidation and shared-queue ordering
before `deleteSessionRow` and `deleteAllData`; file staging must never race
an enqueued note save.
When deletion returns `cleanupPending`, update UI state to reflect the
committed database deletion but show `cleanupWarning` in its own
`role="status"` banner. Do not put this warning in `error`, because a
successful `flushPendingNoteSave` clears the general error state.

When opening History or exporting, retain Phase 4A's note flush first,
then drain the queue. Load completed-session and parked-thought rows, and
enqueue `loadAllSessionNotes` before deriving history/export because that
file-backed load may update content hashes. A missing or unreadable note
must reject the history/export load visibly rather than omit content.

- [ ] **Step 6: Run frontend and native contract checks**

Run:

```bash
npm test
npm run check
npm run build
cd src-tauri
cargo test
```

Expected: all tests and checks pass.

- [ ] **Step 7: Commit repository integration**

```bash
git add src/lib/notes.ts src/lib/notes.test.ts src/lib/memoryRepository.ts src/lib/memoryRepository.test.ts src/lib/tauriRepository.ts src/lib/repository.ts src/lib/history.ts src/lib/history.test.ts src/App.svelte
git commit -m "feat: use file-backed notes through the repository"
```

---

### Task 5: Conflict-Aware Autosave And Recovery UI

**Files:**
- Create: `src/lib/noteStorage.ts`
- Create: `src/lib/noteStorage.test.ts`
- Modify: `src/lib/noteSaveController.ts`
- Modify: `src/lib/noteSaveController.test.ts`
- Modify: `src/lib/SessionNotes.svelte`
- Modify: `src/App.svelte`

**Interfaces:**
- Consumes: serialized `NoteCommandError` values and the current per-session
  save queue.
- Produces:

```ts
export type NoteFailureKind = 'transient' | 'conflict' | 'missing' | 'unreadable';

export class NoteStorageError extends Error {
  readonly kind: NoteFailureKind;
  readonly diskContent: string | null;
  readonly diskHash: string | null;
  readonly relativePath: string | null;

  constructor(
    kind: NoteFailureKind,
    details: {
      message?: string;
      diskContent?: string | null;
      diskHash?: string | null;
      relativePath?: string | null;
    } = {},
  ) {
    super(details.message ?? `Note storage ${kind}`);
    this.name = 'NoteStorageError';
    this.kind = kind;
    this.diskContent = details.diskContent ?? null;
    this.diskHash = details.diskHash ?? null;
    this.relativePath = details.relativePath ?? null;
  }
}

export function normalizeNoteStorageError(error: unknown): NoteStorageError;

export interface NoteSaveFailure {
  kind: NoteFailureKind;
  error: unknown;
}

export interface NoteSaveFlushResult {
  ok: boolean;
  invalidated: boolean;
  attempt: number;
  exhausted: boolean;
  failure: NoteSaveFailure | null;
}

discard(sessionId: string): void

createNoteSaveController(
  save: (sessionId: string, content: string) => Promise<void>,
  maxAutoRetries?: number,
  classifyFailure?: (error: unknown) => NoteFailureKind,
): NoteSaveController
```

- [ ] **Step 1: Write failing normalization tests**

```ts
it('normalizes a native conflict without dropping the disk version', () => {
  const error = normalizeNoteStorageError({
    code: 'conflict',
    diskContent: 'external version',
    diskHash: 'abc123',
  });

  expect(error.kind).toBe('conflict');
  expect(error.diskContent).toBe('external version');
  expect(error.diskHash).toBe('abc123');
});

it('maps unknown failures to transient without exposing note content', () => {
  const error = normalizeNoteStorageError(new Error('disk unavailable'));
  expect(error.kind).toBe('transient');
  expect(error.diskContent).toBeNull();
});
```

- [ ] **Step 2: Write failing controller classification and discard tests**

```ts
it('retains a conflict draft but does not increment or auto-retry it', async () => {
  const conflict = new NoteStorageError('conflict', {
    diskContent: 'disk',
    diskHash: 'hash',
  });
  const controller = createNoteSaveController(
    async () => {
      throw conflict;
    },
    3,
    (error) => normalizeNoteStorageError(error).kind,
  );

  controller.schedule('s1', 'local draft');
  const result = await controller.flush();

  expect(result.failure?.kind).toBe('conflict');
  expect(result.attempt).toBe(0);
  expect(result.exhausted).toBe(false);
  expect(controller.hasPending()).toBe(true);
});

it('discard clears the draft without permanently invalidating the session', async () => {
  const calls: string[] = [];
  const controller = createNoteSaveController(async (_id, content) => {
    calls.push(content);
  });

  controller.schedule('s1', 'discard me');
  controller.discard('s1');
  await controller.flush();
  controller.schedule('s1', 'future edit');
  await controller.flush();

  expect(calls).toEqual(['future edit']);
});

it.each(['missing', 'unreadable'] as const)(
  'keeps a %s-file draft pending without an automatic empty save',
  async (kind) => {
    const savedContents: string[] = [];
    const controller = createNoteSaveController(
      async (_id, content) => {
        savedContents.push(content);
        throw new NoteStorageError(kind, { relativePath: 's1.md' });
      },
      3,
      (error) => normalizeNoteStorageError(error).kind,
    );

    controller.schedule('s1', 'preserve this draft');
    const result = await controller.flush();

    expect(result.failure?.kind).toBe(kind);
    expect(result.attempt).toBe(0);
    expect(controller.hasPending()).toBe(true);
    expect(savedContents).toEqual(['preserve this draft']);
  },
);
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
npm test -- src/lib/noteStorage.test.ts src/lib/noteSaveController.test.ts
```

Expected: failures for missing normalization, failure metadata, classifier,
and `discard`.

- [ ] **Step 4: Implement failure normalization and controller behavior**

Normalize only the serialized fields the Rust enum intentionally exposes:

```ts
export function normalizeNoteStorageError(error: unknown): NoteStorageError {
  if (error instanceof NoteStorageError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = error as Record<string, unknown>;
    if (value.code === 'conflict') {
      return new NoteStorageError('conflict', {
        diskContent: typeof value.diskContent === 'string' ? value.diskContent : null,
        diskHash: typeof value.diskHash === 'string' ? value.diskHash : null,
      });
    }
    if (value.code === 'missing' || value.code === 'unreadable') {
      return new NoteStorageError(value.code, {
        relativePath: typeof value.relativePath === 'string' ? value.relativePath : null,
      });
    }
  }
  return new NoteStorageError('transient');
}
```

Keep the existing retry path only for `transient`. For other kinds,
reinsert the same session entry without increasing its attempt count:

```ts
const kind = classifyFailure(error);
if (kind !== 'transient') {
  if (!pending.has(sessionId)) pending.set(sessionId, entry);
  return {
    ok: false,
    invalidated: false,
    attempt: entry.attempt,
    exhausted: false,
    failure: { kind, error },
  };
}
```

Update `OK_RESULT`, `worstResult`, and all existing exact-result assertions
to include `failure: null`. Preserve all Phase 4A overlap and invalidation
tests.

- [ ] **Step 5: Add App conflict and unavailable-file state**

Use a separate state from the general `error` string:

```ts
type NoteStorageIssue = {
  sessionId: string;
  kind: Exclude<NoteFailureKind, 'transient'>;
  diskContent: string | null;
  diskHash: string | null;
};

let noteStorageIssue = $state<NoteStorageIssue | null>(null);
let confirmingConflictReload = $state(false);
const forceNextNoteSave = new Set<string>();
```

In the save callback, pass `force: forceNextNoteSave.has(sessionId)` and
remove the flag only after success. In `flushPendingNoteSave`, branch on
`result.failure?.kind` before scheduling a retry.

Implement:

```ts
async function handleReloadExternalNote() {
  if (!noteStorageIssue) return;
  const sessionId = noteStorageIssue.sessionId;
  const record = await writeQueue.enqueue(() =>
    loadNoteRecordForSession(sessionId),
  );
  noteSaveController.discard(sessionId);
  noteContent = record?.content ?? '';
  noteHashBySession.set(sessionId, record?.content_hash ?? null);
  noteStorageIssue = null;
  confirmingConflictReload = false;
}

function handleKeepAppNote() {
  if (!noteStorageIssue || !noteStorageIssue.diskHash) return;
  noteHashBySession.set(noteStorageIssue.sessionId, noteStorageIssue.diskHash);
  forceNextNoteSave.add(noteStorageIssue.sessionId);
  noteStorageIssue = null;
  void flushPendingNoteSave();
}
```

Reload must use the existing inline Cancel/Confirm pattern before discarding
the local draft. For missing/unreadable files, keep the editor disabled and
offer Retry load and Open Notes Folder; do not offer automatic recreation.

- [ ] **Step 6: Run all frontend checks**

Run:

```bash
npm test
npm run check
npm run build
```

Expected: all tests pass, Svelte reports zero errors and warnings, and the
production build succeeds.

- [ ] **Step 7: Commit conflict handling**

```bash
git add src/lib/noteStorage.ts src/lib/noteStorage.test.ts src/lib/noteSaveController.ts src/lib/noteSaveController.test.ts src/lib/SessionNotes.svelte src/App.svelte
git commit -m "feat: protect note drafts from file conflicts"
```

---

### Task 6: Safe Markdown Preview And Notes-Folder Access

**Files:**
- Create: `src/lib/markdown.ts`
- Create: `src/lib/markdown.test.ts`
- Create: `src/lib/MarkdownPreview.svelte`
- Create: `src/lib/MarkdownPreview.test.ts`
- Create: `src/lib/SessionNotes.test.ts`
- Modify: `src/lib/SessionNotes.svelte`
- Modify: `src/lib/History.svelte`
- Modify: `src/lib/memoryRepository.ts`
- Modify: `src/lib/tauriRepository.ts`
- Modify: `src/lib/repository.ts`
- Modify: `src/App.svelte`
- Modify: `src-tauri/src/note_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/note-commands.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vite.config.ts`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**
- Consumes: note content strings, the native `open_notes_folder` command,
  and user clicks on rendered safe links.
- Produces:

```ts
export function isSafeExternalUrl(url: string): boolean;
export function renderMarkdown(content: string): string;
export function renderPlainTextFallback(content: string): string;
openNotesFolder(): Promise<void>;
```

`SessionNotes.svelte` gains:

```ts
disabled?: boolean;
```

`History.svelte` gains:

```ts
onOpenNotesFolder: () => Promise<void>;
```

- [ ] **Step 1: Install preview, icon, opener, and component-test dependencies**

Run:

```bash
npm install markdown-it lucide-svelte
npm install -D @types/markdown-it @testing-library/svelte jsdom
npm run tauri add opener
```

After the Tauri helper modifies capabilities, replace any broad
`opener:default` entry with `opener:allow-default-urls`. The frontend only
needs the plugin's allowlisted `http`, `https`, and `mailto` URL opening.
The Rust command opens the fixed notes directory and does not expose
`openPath` to JavaScript.

Configure client-side Svelte resolution for component tests:

```ts
export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  ...(mode === 'test' ? { resolve: { conditions: ['browser'] } } : {}),
}));
```

- [ ] **Step 2: Write failing Markdown security and syntax tests**

```ts
it('renders the supported Markdown surface', () => {
  const html = renderMarkdown('# Heading\n\n- item\n\n`code`\n\n> quote');
  expect(html).toContain('<h1>Heading</h1>');
  expect(html).toContain('<li>item</li>');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<blockquote>');
});

it('never emits raw HTML or executable links', () => {
  const html = renderMarkdown(
    '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![remote](https://example.com/a.png)',
  );
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('<img');
});

it.each([
  ['https://example.com', true],
  ['http://example.com', true],
  ['mailto:person@example.com', true],
  ['javascript:alert(1)', false],
  ['file:///tmp/private', false],
  ['./relative.md', false],
])('applies the safe external URL allowlist to %s', (url, expected) => {
  expect(isSafeExternalUrl(url)).toBe(expected);
});

it('escapes every HTML-sensitive character in the plain-text fallback', () => {
  expect(renderPlainTextFallback(`<script data-x="'">& run</script>`)).toBe(
    `<pre>&lt;script data-x=&quot;&#39;&quot;&gt;&amp; run&lt;/script&gt;</pre>`,
  );
});
```

- [ ] **Step 3: Write failing SessionNotes component tests**

Add `// @vitest-environment jsdom` at the top:

```ts
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SessionNotes from './SessionNotes.svelte';

afterEach(cleanup);

it('switches between a stable editor and rendered preview', async () => {
  render(SessionNotes, {
    content: '# Session result',
    onChange: vi.fn(),
  });

  expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy();
  await fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  expect(screen.getByRole('heading', { name: 'Session result' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Notes' })).toBeNull();
});

it('disables editing when the file is unavailable', () => {
  render(SessionNotes, {
    content: 'preserved draft',
    onChange: vi.fn(),
    disabled: true,
  });
  expect((screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement).disabled).toBe(true);
});

it('supports arrow-key movement between Edit and Preview tabs', async () => {
  render(SessionNotes, {
    content: '# Keyboard preview',
    onChange: vi.fn(),
  });
  const edit = screen.getByRole('tab', { name: 'Edit' });

  await fireEvent.keyDown(edit, { key: 'ArrowRight' });

  expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Keyboard preview' })).toBeTruthy();
});
```

Call `cleanup()` from an imported Vitest `afterEach` so each test starts
with an empty document; do not add `@testing-library/jest-dom`.

Add `MarkdownPreview.test.ts` with the same environment and cleanup:

```ts
it('opens a clicked safe link only through the injected external opener', async () => {
  const openExternal = vi.fn(async () => {});
  render(MarkdownPreview, {
    content: '[Project](https://example.com/project)',
    openExternal,
  });

  await fireEvent.click(screen.getByRole('link', { name: 'Project' }));

  expect(openExternal).toHaveBeenCalledOnce();
  expect(openExternal).toHaveBeenCalledWith('https://example.com/project');
});
```

- [ ] **Step 4: Run focused frontend tests and verify failure**

Run:

```bash
npm test -- src/lib/markdown.test.ts src/lib/MarkdownPreview.test.ts src/lib/SessionNotes.test.ts
```

Expected: failures because the renderer, preview, and tabs do not exist.

- [ ] **Step 5: Implement the restricted renderer**

Configure one module-level instance:

```ts
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

markdown.disable('image');
markdown.validateLink = isSafeExternalUrl;

export function isSafeExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function renderPlainTextFallback(content: string): string {
  const escaped = content
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  return `<pre>${escaped}</pre>`;
}

export function renderMarkdown(content: string): string {
  try {
    return markdown.render(content);
  } catch {
    return renderPlainTextFallback(content);
  }
}
```

Override `link_open` to add `rel="noopener noreferrer"` without adding
`target`; `MarkdownPreview.svelte` intercepts activation and opens the URL
through `@tauri-apps/plugin-opener` in Tauri or `window.open` in browser
development.

Implement that interception without trusting generated HTML a second time:

```svelte
<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { isSafeExternalUrl, renderMarkdown } from './markdown';

  async function defaultOpenExternal(url: string) {
    if (isTauri()) await openUrl(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  }

  let {
    content,
    openExternal = defaultOpenExternal,
  }: {
    content: string;
    openExternal?: (url: string) => Promise<void>;
  } = $props();

  async function handleClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    if (!isSafeExternalUrl(anchor.href)) return;
    await openExternal(anchor.href);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="markdown-preview" onclick={handleClick}>
  {@html renderMarkdown(content)}
</div>
```

- [ ] **Step 6: Build the stable Edit/Preview surface**

Use a real tab pattern:

```svelte
<div class="mode-tabs" role="tablist" aria-label="Note view">
  <button
    id="note-edit-tab"
    role="tab"
    aria-selected={mode === 'edit'}
    aria-controls="note-edit-panel"
    tabindex={mode === 'edit' ? 0 : -1}
    onclick={() => (mode = 'edit')}
  >
    Edit
  </button>
  <button
    id="note-preview-tab"
    role="tab"
    aria-selected={mode === 'preview'}
    aria-controls="note-preview-panel"
    tabindex={mode === 'preview' ? 0 : -1}
    onclick={() => (mode = 'preview')}
  >
    Preview
  </button>
</div>

<div class="note-body">
  {#if mode === 'edit'}
    <textarea aria-label="Notes" {disabled}></textarea>
  {:else}
    <MarkdownPreview {content} />
  {/if}
</div>
```

Add one `onkeydown` handler to the tablist that moves and focuses the
selected tab on `ArrowLeft`, `ArrowRight`, `Home`, and `End`. Give each
conditional body `role="tabpanel"`, the matching `id`, and
`aria-labelledby`.

Give `.note-body` one shared `min-height`, `max-height`, and overflow rule
so tabs cannot move surrounding controls. Keep headings inside preview
compact; do not inherit page-level hero sizing.

Replace History's plain `<p class="note">` with `MarkdownPreview`.

- [ ] **Step 7: Implement Open Notes Folder**

Initialize `tauri-plugin-opener` and use its Rust API inside the native
command:

```rust
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn open_notes_folder(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
) -> Result<(), NoteCommandError> {
    store.initialize()?;
    app.opener()
        .open_path(store.notes_dir(), None::<&str>)
        .map_err(|_error| NoteCommandError::Transient {
            message: "could not open the notes folder".to_string(),
        })
}
```

Add an icon-plus-text `FolderOpen` action to History's existing export/data
row. Include a native tooltip via `title="Open notes folder"`. Surface an
open failure in History's existing action-error area.

Expose `openNotesFolder` through `tauriRepository.ts` using
`invoke('open_notes_folder')`, dispatch it from `repository.ts`, and make
the memory implementation a resolved no-op. Import it in `App.svelte` and
pass it to History as `onOpenNotesFolder`. Add
`allow-open-notes-folder` to `note-commands.toml` and the main capability.

- [ ] **Step 8: Run frontend, native, and capability checks**

Run:

```bash
npm test
npm run check
npm run build
cd src-tauri
cargo test
cargo check
```

Expected: all checks pass. Inspect generated Tauri schemas if capability
validation reports an unknown opener permission; do not replace it with a
broad filesystem or shell permission.

- [ ] **Step 9: Commit the preview and folder UI**

```bash
git add package.json package-lock.json vite.config.ts src/lib/markdown.ts src/lib/markdown.test.ts src/lib/MarkdownPreview.svelte src/lib/MarkdownPreview.test.ts src/lib/SessionNotes.svelte src/lib/SessionNotes.test.ts src/lib/History.svelte src/lib/memoryRepository.ts src/lib/tauriRepository.ts src/lib/repository.ts src/App.svelte src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/note_commands.rs src-tauri/src/lib.rs src-tauri/permissions/note-commands.toml src-tauri/capabilities/default.json
git commit -m "feat: add safe Markdown note preview"
```

---

### Task 7: Documentation, Regression Validation, And Manual Tauri Proof

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all Phase 4B behavior from Tasks 1 through 6.
- Produces: accurate project documentation and fresh evidence that the
  complete vertical slice works.

- [ ] **Step 1: Update README with the shipped Phase 4B contract**

Add a new top section covering:

```markdown
## Phase 4B scope: portable Markdown session notes

- One app-managed UTF-8 Markdown file per non-empty session note
- Markdown files authoritative; SQLite stores relative paths and SHA-256 metadata
- Automatic, idempotent migration from Phase 4A SQLite content
- Atomic writes and expected-hash conflict protection
- Staged deletion and startup recovery
- Independent carry-forward files
- Stable Edit/Preview tabs with raw HTML and remote media disabled
- Open Notes Folder from History
- Explicitly deferred: revisions, search, custom folders, live external sync, Git
```

Remove or rewrite Phase 4A text that calls SQLite the current note-content
source while retaining Phase 4A's historical decisions and race fixes.

- [ ] **Step 2: Run the complete automated validation matrix**

Run from the repository root:

```bash
npm test
npm run check
npm run build
git diff --check
```

Run from `src-tauri`:

```bash
cargo test
cargo check
```

Expected:

- Every Vitest file passes.
- Svelte/TypeScript report zero errors and zero warnings.
- Vite production build succeeds.
- Every Rust unit/integration test passes.
- `cargo check` exits 0.
- `git diff --check` emits no output.

- [ ] **Step 3: Perform a real Phase 4A migration test**

1. Before switching to the Phase 4B build, run the Phase 4A Tauri app.
2. Complete two sessions.
3. Save one note containing headings, Unicode, CRLF and LF line endings,
   and no trailing newline.
4. Carry that note into the second session and edit the second copy.
5. Quit the app only after the Phase 4A save reports success.
6. Launch the Phase 4B build against the same app database.
7. Verify both notes migrated to distinct files under:

```text
~/Library/Application Support/com.pomodoroparkinglot.app/notes/
```

8. Verify file bytes preserve the entered text, each SQLite row has a
   relative `file_path` and `content_hash`, and each SQLite `content` is
   `''`.
9. Restart again and verify migration is a no-op with no duplicate files.

- [ ] **Step 4: Exercise lifecycle and failure behavior manually**

In `npm run tauri:dev`, verify:

1. Autosave, blur flush, session transition flush, carry-forward, and
   close/reopen.
2. Edit/Preview stability at 800x600 and the narrowest usable window.
3. Markdown headings, lists, blockquotes, code, safe links, raw HTML,
   `javascript:` links, and remote image syntax.
4. Open Notes Folder.
5. External edit while the app is closed loads on next launch.
6. External edit while the app is open triggers conflict without
   overwriting either version.
7. Cancel/Confirm Reload file and Keep my version.
8. Temporarily rename a note file and verify missing-file handling disables
   destructive autosave.
9. Clear a note, delete one session, and delete all data; inspect both
   SQLite and `notes/`.
10. Interrupt one staged deletion before cleanup, relaunch, and verify
    recovery finishes or restores according to SQLite metadata.
11. Browser `npm run dev` still supports editing and preview through the
    memory repository without Tauri IPC errors.

- [ ] **Step 5: Commit documentation after all validation passes**

```bash
git add README.md
git commit -m "docs: document portable Markdown notes"
```

- [ ] **Step 6: Prepare the pull request evidence**

Include:

```markdown
## Validation

- `npm test`
- `npm run check`
- `npm run build`
- `cargo test`
- `cargo check`
- `git diff --check`
- Manual Phase 4A database migration
- Manual conflict, missing-file, carry-forward, delete, delete-all, restart, and compact-window checks

## Deferred

- Named checkpoints and revision history
- Custom notes directory
- Live external-editor synchronization
- Note search/library
- Git integration
```

Do not claim cross-platform atomicity from macOS-only manual testing. The
Rust tests and `atomic-write-file` provide the automated cross-platform
contract; Windows and Linux packaging/runtime verification remains part of
the later release matrix.
