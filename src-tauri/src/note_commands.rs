// Native note DTOs/errors and SQLite/file orchestration: initialization
// (staged-deletion recovery + legacy migration), load, save (including
// whitespace-triggered clearing), and the delete/delete-all wiring added in
// Task 3. Command wrappers stay thin around testable `_core` functions that
// take a `&sqlx::SqlitePool` and `&NoteFileStore` directly, so the actual
// logic can be exercised in tests without a full Tauri app context.

use chrono::TimeZone;
use uuid::Uuid;

use crate::note_files::{NoteFileError, NoteFileStore};

#[derive(Debug, serde::Serialize)]
#[serde(tag = "code", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NoteCommandError {
    Conflict { disk_content: String, disk_hash: String },
    Missing { relative_path: String },
    Unreadable { relative_path: String },
    Transient { message: String },
}

impl From<NoteFileError> for NoteCommandError {
    fn from(error: NoteFileError) -> Self {
        match error {
            NoteFileError::Conflict { disk_content, disk_hash } => {
                NoteCommandError::Conflict { disk_content, disk_hash }
            }
            NoteFileError::Missing { relative_path } => NoteCommandError::Missing { relative_path },
            NoteFileError::Unreadable { relative_path } => NoteCommandError::Unreadable { relative_path },
            NoteFileError::InvalidPath => {
                NoteCommandError::Transient { message: "invalid note path".to_string() }
            }
            NoteFileError::Io(message) => NoteCommandError::Transient { message },
        }
    }
}

impl From<sqlx::Error> for NoteCommandError {
    fn from(error: sqlx::Error) -> Self {
        NoteCommandError::Transient { message: error.to_string() }
    }
}

#[derive(serde::Serialize, Clone, Debug)]
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

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteResponse {
    pub note: Option<SessionNoteDto>,
    pub cleanup_pending: bool,
}

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

#[derive(sqlx::FromRow)]
struct NoteRow {
    id: String,
    session_id: String,
    content: String,
    file_path: Option<String>,
    content_hash: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn local_date_from_millis(started_at: i64) -> Result<String, NoteCommandError> {
    chrono::Local
        .timestamp_millis_opt(started_at)
        .single()
        .ok_or_else(|| NoteCommandError::Transient { message: "invalid session start timestamp".to_string() })
        .map(|date_time| date_time.format("%Y-%m-%d").to_string())
}

fn dto_from_row(row: NoteRow, override_content: Option<(String, String)>) -> SessionNoteDto {
    let (content, content_hash) = match override_content {
        Some((content, hash)) => (content, Some(hash)),
        None => (row.content, row.content_hash),
    };
    SessionNoteDto {
        id: row.id,
        session_id: row.session_id,
        content,
        file_path: row.file_path,
        content_hash,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// Reconciles every staged file left over from an interrupted delete or
/// clear against current `session_notes` metadata. For each staged entry:
/// if no row references its original relative path (by content hash),
/// the delete had already committed before the crash — finish it by
/// discarding the staged copy. If a row still references it and the
/// *original* location is genuinely absent, the delete/rename hadn't
/// committed yet (or was rolled back) — restore the staged copy. Anything
/// else (original and staged both present with hashes that don't cleanly
/// resolve one way) is left in place and surfaced as a transient error
/// rather than guessed at.
pub(crate) async fn recover_staged_deletions_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<(), NoteCommandError> {
    for entry in store.staged_entries()? {
        let expected_hash: Option<String> =
            sqlx::query_scalar("SELECT content_hash FROM session_notes WHERE file_path = ?")
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
            Err(NoteFileError::Missing { .. }) if staged.content_hash == expected_hash => {
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
    Ok(())
}

/// Migrates every legacy (`file_path IS NULL`) row: deletes whitespace-only
/// ones outright, and writes the rest to a deterministically-named file
/// before recording that file's path and hash — byte-for-byte, with no
/// normalization. Idempotent: a row already migrated is never revisited (it
/// no longer matches `file_path IS NULL`), and re-running after a partial
/// failure re-derives the same path and either verifies or replaces it with
/// the same legacy content via `compare_and_write`'s own idempotent-success
/// path.
pub(crate) async fn initialize_note_storage_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<(), NoteCommandError> {
    recover_staged_deletions_core(pool, store).await?;

    let rows = sqlx::query_as::<_, LegacyNoteRow>(
        "SELECT id, session_id, content FROM session_notes WHERE file_path IS NULL",
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

        let local_date = local_date_from_millis(session.started_at)?;
        let relative_path = store.note_relative_path(&row.session_id, &session.task, &local_date)?;
        let stored = store.compare_and_write(&relative_path, &row.content, None, false)?;

        sqlx::query("UPDATE session_notes SET content = '', file_path = ?, content_hash = ? WHERE id = ?")
            .bind(relative_path)
            .bind(stored.content_hash)
            .bind(row.id)
            .execute(pool)
            .await?;
    }

    Ok(())
}

/// Reads one session's note record. A still-legacy row (`file_path IS
/// NULL`) returns its SQLite `content` directly — that's the only content
/// available for it and, per the migration failure contract, it remains
/// authoritative until migration succeeds. A file-backed row always reads
/// the actual file rather than trusting `content` (which is `''` for those
/// rows) or a possibly-stale `content_hash`; a mismatch between the fresh
/// hash and the stored one is refreshed in SQLite, accepting an external
/// edit made while the app was closed.
pub(crate) async fn load_session_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
) -> Result<Option<SessionNoteDto>, NoteCommandError> {
    let Some(row) = sqlx::query_as::<_, NoteRow>(
        "SELECT id, session_id, content, file_path, content_hash, created_at, updated_at
         FROM session_notes WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(None);
    };

    let Some(file_path) = row.file_path.clone() else {
        return Ok(Some(dto_from_row(row, None)));
    };

    let stored = store.read(&file_path)?;
    if row.content_hash.as_deref() != Some(stored.content_hash.as_str()) {
        sqlx::query("UPDATE session_notes SET content_hash = ? WHERE id = ?")
            .bind(&stored.content_hash)
            .bind(&row.id)
            .execute(pool)
            .await?;
    }
    Ok(Some(dto_from_row(row, Some((stored.content, stored.content_hash)))))
}

/// Same file-backed-first contract as `load_session_note_core`, for every
/// session at once.
pub(crate) async fn load_all_session_notes_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<Vec<SessionNoteDto>, NoteCommandError> {
    let rows = sqlx::query_as::<_, NoteRow>(
        "SELECT id, session_id, content, file_path, content_hash, created_at, updated_at FROM session_notes",
    )
    .fetch_all(pool)
    .await?;

    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(file_path) = row.file_path.clone() else {
            result.push(dto_from_row(row, None));
            continue;
        };
        let stored = store.read(&file_path)?;
        if row.content_hash.as_deref() != Some(stored.content_hash.as_str()) {
            sqlx::query("UPDATE session_notes SET content_hash = ? WHERE id = ?")
                .bind(&stored.content_hash)
                .bind(&row.id)
                .execute(pool)
                .await?;
        }
        result.push(dto_from_row(row, Some((stored.content, stored.content_hash))));
    }
    Ok(result)
}

/// Whitespace-only content means "no note": stages the existing file (if
/// any), deletes the metadata row, then finalizes the staged file — the
/// same stage/delete/finalize shape Task 3 uses for session and delete-all
/// removal. Applies the same expected-hash/force guard as an ordinary
/// write *before* staging anything, so a stale caller can never delete an
/// externally-changed file; that case returns `Conflict` with the disk
/// version instead.
async fn clear_session_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    existing: ExistingNoteMetadata,
    expected_hash: Option<&str>,
    force: bool,
) -> Result<SaveNoteResponse, NoteCommandError> {
    let Some(file_path) = existing.file_path else {
        // Still a legacy row with no file yet — nothing to stage.
        sqlx::query("DELETE FROM session_notes WHERE id = ?")
            .bind(&existing.id)
            .execute(pool)
            .await?;
        return Ok(SaveNoteResponse { note: None, cleanup_pending: false });
    };

    let current = store.read(&file_path)?;
    let expected_matches = expected_hash == Some(current.content_hash.as_str());
    if !force && !expected_matches {
        return Err(NoteCommandError::Conflict {
            disk_content: current.content,
            disk_hash: current.content_hash,
        });
    }

    let stage = store.stage_paths(&[file_path])?;
    match sqlx::query("DELETE FROM session_notes WHERE id = ?").bind(&existing.id).execute(pool).await {
        Ok(_) => {
            let cleanup_pending = store.finalize_stage(&stage).is_err();
            Ok(SaveNoteResponse { note: None, cleanup_pending })
        }
        Err(error) => {
            store.restore_stage(&stage)?;
            Err(error.into())
        }
    }
}

/// Upserts a session's note content. Non-whitespace content writes the file
/// (compare-and-write with the caller's expected hash/force flag) and then
/// updates SQLite metadata only after that succeeds — a metadata-only
/// failure after a successful write is safely retried, since a retry's
/// desired content already matches what's on disk (`compare_and_write`'s
/// idempotent-success path). Whitespace-only content clears the note
/// instead of persisting an empty one; see `clear_session_note_core`.
pub(crate) async fn save_session_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    content: &str,
    expected_hash: Option<&str>,
    now: i64,
    force: bool,
) -> Result<SaveNoteResponse, NoteCommandError> {
    let existing = sqlx::query_as::<_, ExistingNoteMetadata>(
        "SELECT id, file_path, created_at FROM session_notes WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;

    if content.trim().is_empty() {
        return match existing {
            Some(existing) => clear_session_note_core(pool, store, existing, expected_hash, force).await,
            None => Ok(SaveNoteResponse { note: None, cleanup_pending: false }),
        };
    }

    let session = sqlx::query_as::<_, SessionNamingMetadata>(
        "SELECT task, started_at FROM sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| NoteCommandError::Transient { message: "session metadata unavailable".to_string() })?;

    let note_id = existing.as_ref().map(|note| note.id.clone()).unwrap_or_else(|| Uuid::new_v4().to_string());
    let created_at = existing.as_ref().map(|note| note.created_at).unwrap_or(now);
    let local_date = local_date_from_millis(session.started_at)?;
    let relative_path = match existing.and_then(|note| note.file_path) {
        Some(path) => path,
        None => store.note_relative_path(session_id, &session.task, &local_date)?,
    };

    let stored = store.compare_and_write(&relative_path, content, expected_hash, force)?;

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
    .bind(&note_id)
    .bind(session_id)
    .bind(&relative_path)
    .bind(&stored.content_hash)
    .bind(created_at)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(SaveNoteResponse {
        note: Some(SessionNoteDto {
            id: note_id,
            session_id: session_id.to_string(),
            content: stored.content,
            file_path: Some(relative_path),
            content_hash: Some(stored.content_hash),
            created_at,
            updated_at: now,
        }),
        cleanup_pending: false,
    })
}

async fn pool_for(app: &tauri::AppHandle) -> Result<sqlx::SqlitePool, NoteCommandError> {
    crate::db_commands::sqlite_pool(app)
        .await
        .map_err(|message| NoteCommandError::Transient { message })
}

#[tauri::command]
pub async fn initialize_note_storage(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
) -> Result<(), NoteCommandError> {
    let pool = pool_for(&app).await?;
    initialize_note_storage_core(&pool, &store).await
}

#[tauri::command]
pub async fn save_session_note(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    session_id: String,
    content: String,
    expected_hash: Option<String>,
    now: i64,
    force: bool,
) -> Result<SaveNoteResponse, NoteCommandError> {
    let pool = pool_for(&app).await?;
    save_session_note_core(&pool, &store, &session_id, &content, expected_hash.as_deref(), now, force).await
}

#[tauri::command]
pub async fn load_session_note(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    session_id: String,
) -> Result<Option<SessionNoteDto>, NoteCommandError> {
    let pool = pool_for(&app).await?;
    load_session_note_core(&pool, &store, &session_id).await
}

#[tauri::command]
pub async fn load_all_session_notes(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
) -> Result<Vec<SessionNoteDto>, NoteCommandError> {
    let pool = pool_for(&app).await?;
    load_all_session_notes_core(&pool, &store).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
                .connect_with(SqliteConnectOptions::new().filename(&db_path).create_if_missing(true))
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
            sqlx::query_as("SELECT content, file_path, content_hash FROM session_notes WHERE session_id = ?")
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
            sqlx::query("DROP TRIGGER fail_note_metadata_update").execute(&self.pool).await.unwrap();
        }

        async fn insert_file_backed_note(&self, session_id: &str, file_content: &str, stale_sqlite_content: &str) {
            self.insert_session(session_id, "Task", 1_722_163_200_000).await;
            let file_path = format!("{session_id}.md");
            let stored = self.store.compare_and_write(&file_path, file_content, None, false).unwrap();
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

    #[tokio::test]
    async fn legacy_content_migrates_byte_for_byte_and_clears_sqlite_content() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Write report", 1_722_163_200_000).await;
        fixture.insert_legacy_note("n1", "s1", "line one\r\nCafé").await;

        initialize_note_storage_core(&fixture.pool, &fixture.store).await.unwrap();

        let row = fixture.note_metadata("s1").await;
        assert_eq!(row.content, "");
        assert!(row.file_path.is_some());
        assert!(row.content_hash.is_some());
        let loaded = load_session_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap().unwrap();
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
        initialize_note_storage_core(&fixture.pool, &fixture.store).await.unwrap();
        assert_eq!(
            load_session_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap().unwrap().content,
            "legacy"
        );
    }

    #[tokio::test]
    async fn migration_file_failure_leaves_legacy_content_authoritative() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Write report", 1_722_163_200_000).await;
        fixture.insert_legacy_note("n1", "s1", "legacy survives").await;
        let local_date = local_date_from_millis(1_722_163_200_000).unwrap();
        let relative_path = fixture.store.note_relative_path("s1", "Write report", &local_date).unwrap();
        std::fs::create_dir(fixture.store.notes_dir().join(relative_path)).unwrap();

        assert!(initialize_note_storage_core(&fixture.pool, &fixture.store).await.is_err());
        assert_eq!(fixture.legacy_content("s1").await, "legacy survives");
    }

    #[tokio::test]
    async fn file_backed_load_never_falls_back_to_stale_legacy_content() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "file content", "stale sqlite").await;

        let note = load_session_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap().unwrap();
        assert_eq!(note.content, "file content");
    }

    #[tokio::test]
    async fn load_accepts_an_external_edit_and_refreshes_the_metadata_hash() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "initial", "").await;
        let before = fixture.note_metadata("s1").await;
        let path = before.file_path.as_deref().unwrap();
        let external =
            fixture.store.compare_and_write(path, "external edit", before.content_hash.as_deref(), true).unwrap();

        let loaded = load_session_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap().unwrap();
        let after = fixture.note_metadata("s1").await;

        assert_eq!(loaded.content, "external edit");
        assert_eq!(loaded.content_hash.as_deref(), Some(external.content_hash.as_str()));
        assert_eq!(after.content_hash.as_deref(), Some(external.content_hash.as_str()));
    }

    #[tokio::test]
    async fn whitespace_legacy_rows_are_removed_without_creating_files() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        fixture.insert_legacy_note("n1", "s1", " \n\t ").await;

        initialize_note_storage_core(&fixture.pool, &fixture.store).await.unwrap();

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM session_notes").fetch_one(&fixture.pool).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn update_preserves_id_and_created_at_and_carry_creates_a_second_file() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "First", 1_722_163_200_000).await;
        fixture.insert_session("s2", "Second", 1_722_166_800_000).await;

        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "draft", None, 1000, false)
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
        let carried =
            save_session_note_core(&fixture.pool, &fixture.store, "s2", "final", None, 3000, false)
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
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "first", None, 1000, false)
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
        assert_eq!(fixture.note_metadata("s1").await.content_hash, retried.content_hash);
    }

    #[tokio::test]
    async fn whitespace_save_removes_the_file_and_metadata() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
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
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'")
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn whitespace_clear_refuses_to_delete_an_external_edit() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "initial", None, 1000, false)
                .await
                .unwrap()
                .note
                .unwrap();
        fixture
            .store
            .compare_and_write(first.file_path.as_deref().unwrap(), "external edit", first.content_hash.as_deref(), true)
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
            fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content,
            "external edit"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'")
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
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "first", None, 1000, false)
                .await
                .unwrap()
                .note
                .unwrap();
        fixture
            .store
            .compare_and_write(first.file_path.as_deref().unwrap(), "external", first.content_hash.as_deref(), true)
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
            NoteCommandError::Conflict { disk_content, disk_hash: _ } if disk_content == "external"
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

        std::fs::remove_file(fixture.store.notes_dir().join(first.file_path.as_deref().unwrap())).unwrap();
        let missing = load_session_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap_err();
        assert!(matches!(missing, NoteCommandError::Missing { .. }));
    }

    #[tokio::test]
    async fn load_all_reads_every_file_backed_note() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "First", 1_722_163_200_000).await;
        fixture.insert_session("s2", "Second", 1_722_166_800_000).await;
        save_session_note_core(&fixture.pool, &fixture.store, "s1", "one", None, 1000, false).await.unwrap();
        save_session_note_core(&fixture.pool, &fixture.store, "s2", "two", None, 2000, false).await.unwrap();

        let notes = load_all_session_notes_core(&fixture.pool, &fixture.store).await.unwrap();
        let contents: std::collections::BTreeSet<_> = notes.into_iter().map(|note| note.content).collect();
        assert_eq!(contents, std::collections::BTreeSet::from(["one".to_string(), "two".to_string()]));
    }
}
