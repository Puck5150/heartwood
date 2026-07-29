// Native note DTOs/errors and SQLite/file orchestration: initialization
// (staged-deletion recovery + legacy migration), load, save (including
// whitespace-triggered clearing), and the delete/delete-all wiring added in
// Task 3. Command wrappers stay thin around testable `_core` functions that
// take a `&sqlx::SqlitePool` and `&NoteFileStore` directly, so the actual
// logic can be exercised in tests without a full Tauri app context.

use chrono::TimeZone;
use uuid::Uuid;

use crate::note_files::{sha256_hex, NoteFileError, NoteFileStore};

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
/// committed yet (or was rolled back) — restore the staged copy. If a row
/// still references it, the *original* location matches that reference,
/// *and* the staged copy is an identical duplicate of it (also matches
/// `expected_hash`) — finish the delete by discarding the redundant staged
/// copy; nothing is lost since the original already holds the same bytes.
/// Anything else — including a staged copy whose hash *differs* from
/// `expected_hash` even though the original matches — is left in place
/// and surfaced as a transient error rather than guessed at, since the
/// staged copy could hold content that's genuinely different from (and
/// possibly newer than) both the original file and whatever the delete
/// this staged copy came from was ever meant to remove.
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
            Ok(original)
                if original.content_hash == expected_hash && staged.content_hash == expected_hash =>
            {
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
    recover_restore_manifests_core(pool, store).await?;
    recover_staged_data_core(pool, store).await?;
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

pub(crate) struct SafeClearOutcome {
    pub(crate) safety_revision: Option<crate::revision_commands::RevisionDto>,
    pub(crate) cleanup_pending: bool,
}

/// Shared by an ordinary whitespace clear (`before_clear`) and "Keep my
/// version" resolving in favor of a blank draft during an external
/// conflict (`before_external_overwrite`): stages `file_path` (an atomic,
/// unconditional rename — never a conditional one, so the *exact* bytes on
/// disk at this instant are what get verified, not a possibly-stale
/// earlier read), then reads and hashes those staged bytes and compares
/// against `expected_hash`. A mismatch restores the stage and returns a
/// fresh `Conflict`; if the live path was recreated by something else in
/// the meantime, `restore_stage` itself fails and both the staged and
/// recreated copies are preserved — the freshest known truth (the
/// recreated live file) is what gets reported instead. Once verified,
/// non-blank staged bytes become a deduplicated `safety_reason` revision;
/// its row and the `session_notes` row are inserted/reused and deleted in
/// one transaction before the staged file is finally discarded. Any
/// failure from here on restores the staged file, so an accidental clear
/// (or a Keep choice that turns out to fail) never loses the note or its
/// safety net.
async fn stage_and_clear_with_safety_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    note_id: &str,
    file_path: &str,
    expected_hash: Option<&str>,
    safety_reason: crate::revision_commands::RevisionReason,
    now: i64,
) -> Result<SafeClearOutcome, NoteCommandError> {
    let stage = store.stage_paths(&[file_path.to_string()])?;
    let Some(entry) = stage.entry_for(file_path) else {
        // The row referenced a file that was already absent on disk.
        sqlx::query("DELETE FROM session_notes WHERE id = ?").bind(note_id).execute(pool).await?;
        return Ok(SafeClearOutcome { safety_revision: None, cleanup_pending: false });
    };

    let staged = match store.read_staged(&entry) {
        Ok(staged) => staged,
        Err(error) => {
            let _ = store.restore_stage(&stage);
            return Err(error.into());
        }
    };

    if expected_hash != Some(staged.content_hash.as_str()) {
        return Err(match store.restore_stage(&stage) {
            Ok(()) => {
                NoteCommandError::Conflict { disk_content: staged.content, disk_hash: staged.content_hash }
            }
            Err(_) => match store.read(file_path) {
                Ok(live) => NoteCommandError::Conflict { disk_content: live.content, disk_hash: live.content_hash },
                Err(error) => error.into(),
            },
        });
    }

    if staged.content.trim().is_empty() {
        // Nothing to snapshot (policy: no revision for blank content) —
        // just finish the clear.
        sqlx::query("DELETE FROM session_notes WHERE id = ?").bind(note_id).execute(pool).await?;
        let cleanup_pending = store.finalize_stage(&stage).is_err();
        return Ok(SafeClearOutcome { safety_revision: None, cleanup_pending });
    }

    // Verifies an existing object, repairs one that's missing, and rejects
    // corruption — same contract create_note_revision_core relies on.
    if let Err(error) = store.ensure_revision_object(session_id, &staged.content, &staged.content_hash) {
        let _ = store.restore_stage(&stage);
        return Err(error.into());
    }

    let mut tx = pool.begin().await?;
    let dto = match crate::revision_commands::insert_or_reuse_revision_row(
        &mut tx,
        session_id,
        &staged.content_hash,
        crate::revision_commands::RevisionKind::Safety,
        safety_reason,
        now,
    )
    .await
    {
        Ok(dto) => dto,
        Err(error) => {
            let _ = store.restore_stage(&stage);
            return Err(error);
        }
    };

    if let Err(error) = sqlx::query("DELETE FROM session_notes WHERE id = ?").bind(note_id).execute(&mut *tx).await
    {
        let _ = store.restore_stage(&stage);
        return Err(error.into());
    }

    if let Err(error) = tx.commit().await {
        let _ = store.restore_stage(&stage);
        return Err(error.into());
    }

    let cleanup_pending = store.finalize_stage(&stage).is_err();
    Ok(SafeClearOutcome { safety_revision: Some(dto), cleanup_pending })
}

/// Whitespace-only content means "no note", routed through the shared
/// stage/verify/snapshot/delete flow above with reason `before_clear`. See
/// `stage_and_clear_with_safety_core` for the full contract.
async fn clear_session_note_with_safety_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    existing: ExistingNoteMetadata,
    expected_hash: Option<&str>,
    now: i64,
) -> Result<SaveNoteResponse, NoteCommandError> {
    let Some(file_path) = existing.file_path else {
        // Still a legacy row with no file yet — nothing to stage.
        sqlx::query("DELETE FROM session_notes WHERE id = ?")
            .bind(&existing.id)
            .execute(pool)
            .await?;
        return Ok(SaveNoteResponse { note: None, cleanup_pending: false });
    };

    let outcome = stage_and_clear_with_safety_core(
        pool,
        store,
        session_id,
        &existing.id,
        &file_path,
        expected_hash,
        crate::revision_commands::RevisionReason::BeforeClear,
        now,
    )
    .await?;
    Ok(SaveNoteResponse { note: None, cleanup_pending: outcome.cleanup_pending })
}

/// Upserts a session's note content. Non-whitespace content writes the file
/// (compare-and-write with the caller's expected hash/force flag) and then
/// updates SQLite metadata only after that succeeds — a metadata-only
/// failure after a successful write is safely retried, since a retry's
/// desired content already matches what's on disk (`compare_and_write`'s
/// idempotent-success path). Whitespace-only content clears the note
/// instead of persisting an empty one; see `clear_session_note_with_safety_core`.
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
            Some(existing) => clear_session_note_with_safety_core(pool, store, session_id, existing, expected_hash, now).await,
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

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolutionResponse {
    pub note: Option<SessionNoteDto>,
    pub safety_revision: Option<crate::revision_commands::RevisionDto>,
}

/// Looks up the one file-backed note an external-conflict resolution can
/// ever apply to. A conflict is only ever reported for an existing
/// file-backed note, so a missing row or a still-legacy (no `file_path`)
/// one means the caller's state is stale in some other way — surfaced as
/// a transient error rather than silently no-op'd.
async fn existing_file_backed_note(
    pool: &sqlx::SqlitePool,
    session_id: &str,
) -> Result<(String, String, i64), NoteCommandError> {
    let existing = sqlx::query_as::<_, ExistingNoteMetadata>(
        "SELECT id, file_path, created_at FROM session_notes WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    match existing {
        Some(ExistingNoteMetadata { id, file_path: Some(file_path), created_at }) => Ok((id, file_path, created_at)),
        _ => Err(NoteCommandError::Transient { message: "no file-backed note to resolve".to_string() }),
    }
}

async fn refresh_note_metadata(
    pool: &sqlx::SqlitePool,
    note_id: &str,
    session_id: &str,
    file_path: &str,
    created_at: i64,
    content: &str,
    content_hash: &str,
    now: i64,
) -> Result<SessionNoteDto, NoteCommandError> {
    sqlx::query("UPDATE session_notes SET content = '', file_path = ?, content_hash = ?, updated_at = ? WHERE id = ?")
        .bind(file_path)
        .bind(content_hash)
        .bind(now)
        .bind(note_id)
        .execute(pool)
        .await?;
    Ok(SessionNoteDto {
        id: note_id.to_string(),
        session_id: session_id.to_string(),
        content: content.to_string(),
        file_path: Some(file_path.to_string()),
        content_hash: Some(content_hash.to_string()),
        created_at,
        updated_at: now,
    })
}

/// "Keep my version": re-reads the disk file fresh and requires its hash
/// to still equal `conflict_hash` — a second external change in the
/// meantime returns a *fresh* `Conflict` instead of trusting stale
/// information. A blank `draft` means the user's intent was actually to
/// clear the note despite the external edit, so this resolves through the
/// same stage/verify/snapshot/delete flow a whitespace clear uses, tagged
/// `before_external_overwrite` instead of `before_clear`. A non-blank
/// draft snapshots the verified external bytes as `before_external_overwrite`
/// first, then compare-and-writes the draft against that exact hash
/// without `force` — if a *third* version has since landed, that write
/// itself reports the fresh conflict. If the draft has already landed on
/// disk (a lost response retried), metadata is simply repaired and no new
/// safety snapshot is created. If the safety snapshot itself cannot be
/// committed, the destructive write never happens and the caller's draft
/// and conflict state remain intact.
pub(crate) async fn resolve_external_conflict_keep_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    draft: &str,
    conflict_hash: &str,
    now: i64,
) -> Result<ConflictResolutionResponse, NoteCommandError> {
    let (note_id, file_path, created_at) = existing_file_backed_note(pool, session_id).await?;

    if draft.trim().is_empty() {
        let outcome = stage_and_clear_with_safety_core(
            pool,
            store,
            session_id,
            &note_id,
            &file_path,
            Some(conflict_hash),
            crate::revision_commands::RevisionReason::BeforeExternalOverwrite,
            now,
        )
        .await?;
        return Ok(ConflictResolutionResponse { note: None, safety_revision: outcome.safety_revision });
    }

    let current = store.read(&file_path)?;
    if current.content_hash != conflict_hash {
        return Err(NoteCommandError::Conflict { disk_content: current.content, disk_hash: current.content_hash });
    }

    let draft_hash = sha256_hex(draft.as_bytes());
    if draft_hash == current.content_hash {
        // Already landed during a lost response — repair metadata only.
        let note = refresh_note_metadata(pool, &note_id, session_id, &file_path, created_at, draft, &draft_hash, now)
            .await?;
        return Ok(ConflictResolutionResponse { note: Some(note), safety_revision: None });
    }

    store.ensure_revision_object(session_id, &current.content, &current.content_hash)?;
    let mut tx = pool.begin().await?;
    let safety_dto = crate::revision_commands::insert_or_reuse_revision_row(
        &mut tx,
        session_id,
        &current.content_hash,
        crate::revision_commands::RevisionKind::Safety,
        crate::revision_commands::RevisionReason::BeforeExternalOverwrite,
        now,
    )
    .await?;
    tx.commit().await?;

    // A third version landing here surfaces as a fresh Conflict — the
    // safety snapshot of the *first* external version we just committed
    // stays, which is harmless: it's simply one more entry in the timeline.
    let stored = store.compare_and_write(&file_path, draft, Some(&current.content_hash), false)?;
    let note =
        refresh_note_metadata(pool, &note_id, session_id, &file_path, created_at, &stored.content, &stored.content_hash, now)
            .await?;
    Ok(ConflictResolutionResponse { note: Some(note), safety_revision: Some(safety_dto) })
}

/// "Reload file": requires the disk hash to still equal `conflict_hash` —
/// a second external change returns a fresh conflict rather than
/// discarding the draft against stale information. A non-blank in-memory
/// `draft` is snapshotted as `before_external_reload` before the verified
/// disk content is returned; a blank draft has nothing worth keeping and
/// creates no revision (policy: no revision for blank content). If the
/// safety snapshot fails, the conflict/draft remain exactly as they were.
pub(crate) async fn resolve_external_conflict_reload_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    session_id: &str,
    draft: &str,
    conflict_hash: &str,
    now: i64,
) -> Result<ConflictResolutionResponse, NoteCommandError> {
    let (note_id, file_path, created_at) = existing_file_backed_note(pool, session_id).await?;

    let current = store.read(&file_path)?;
    if current.content_hash != conflict_hash {
        return Err(NoteCommandError::Conflict { disk_content: current.content, disk_hash: current.content_hash });
    }

    let mut safety_dto = None;
    if !draft.trim().is_empty() {
        let draft_hash = sha256_hex(draft.as_bytes());
        store.ensure_revision_object(session_id, draft, &draft_hash)?;
        let mut tx = pool.begin().await?;
        let dto = crate::revision_commands::insert_or_reuse_revision_row(
            &mut tx,
            session_id,
            &draft_hash,
            crate::revision_commands::RevisionKind::Safety,
            crate::revision_commands::RevisionReason::BeforeExternalReload,
            now,
        )
        .await?;
        tx.commit().await?;
        safety_dto = Some(dto);
    }

    let note = refresh_note_metadata(
        pool,
        &note_id,
        session_id,
        &file_path,
        created_at,
        &current.content,
        &current.content_hash,
        now,
    )
    .await?;
    Ok(ConflictResolutionResponse { note: Some(note), safety_revision: safety_dto })
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRevisionResponse {
    pub note: SessionNoteDto,
    pub safety_revision: Option<crate::revision_commands::RevisionDto>,
}

/// Upserts `session_notes` for a restore's target: a fresh insert (new
/// `id`, `created_at = now`) if no row exists yet for `session_id`, or —
/// via `ON CONFLICT(session_id)` — an update to the existing row's
/// `file_path`/`content_hash` only, leaving its original `id`/`created_at`
/// untouched. A repeated call (an in-process retry, or startup rolling
/// forward the same manifest) is therefore idempotent regardless of
/// whether an earlier attempt's insert already landed: the fresh random
/// id/created_at values it supplies are simply discarded by the ON
/// CONFLICT path once a row already exists.
async fn upsert_note_metadata_for_restore(
    pool: &sqlx::SqlitePool,
    session_id: &str,
    relative_path: &str,
    content_hash: &str,
    now: i64,
) -> Result<(), NoteCommandError> {
    let note_id = Uuid::new_v4().to_string();
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
    .bind(relative_path)
    .bind(content_hash)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Drives a restore-operation manifest to completion from wherever it left
/// off, purely by comparing the *current* file's actual state against what
/// the manifest recorded — never by trusting `manifest.phase` for
/// correctness (only as a fast-path short-circuit for an operation that's
/// already fully resolved). Used identically by a fresh restore's own
/// first attempt, an in-process retry that found a matching unfinished
/// manifest, and startup recovery iterating every manifest left behind by
/// a previous process. See the design doc's Restore section for the exact
/// three-way outcome this mirrors.
async fn resume_or_complete_restore_manifest(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    manifest: &crate::revision_files::RestoreManifest,
    now: i64,
) -> Result<(), NoteCommandError> {
    use crate::revision_files::{PriorNoteState, RestorePhase};

    if manifest.phase == RestorePhase::Cancelled || manifest.phase == RestorePhase::MetadataCommitted {
        // Already fully resolved (or abandoned) in an earlier pass — any
        // file at `current_relative_path` now is unrelated to this
        // operation, whatever its hash. Just discard the manifest.
        store.remove_restore_manifest(&manifest.operation_id)?;
        return Ok(());
    }

    let current_hash: Option<String> = match store.read(&manifest.current_relative_path) {
        Ok(stored) => Some(stored.content_hash),
        Err(NoteFileError::Missing { .. }) => None,
        Err(error) => return Err(error.into()),
    };
    let prior_hash: Option<String> = match &manifest.prior {
        PriorNoteState::NoNoteRow => None,
        PriorNoteState::Present { content_hash } => Some(content_hash.clone()),
    };

    if current_hash.as_deref() == Some(manifest.target_hash.as_str()) {
        // The target write already landed (this attempt or an earlier
        // one) — only the metadata upsert (and cleanup) remain.
        upsert_note_metadata_for_restore(pool, &manifest.session_id, &manifest.current_relative_path, &manifest.target_hash, now)
            .await?;
        store.remove_restore_manifest(&manifest.operation_id)?;
        return Ok(());
    }

    if current_hash == prior_hash {
        // Still in its recorded prior state — the target write hasn't
        // happened yet. Do it now.
        let target = store.read_revision_object(&manifest.session_id, &manifest.target_hash)?;
        if let Err(error) =
            store.compare_and_write(&manifest.current_relative_path, &target.content, prior_hash.as_deref(), false)
        {
            let _ = store.set_restore_manifest_phase(&manifest.operation_id, RestorePhase::Cancelled);
            let _ = store.remove_restore_manifest(&manifest.operation_id);
            return Err(error.into());
        }
        let _ = store.set_restore_manifest_phase(&manifest.operation_id, RestorePhase::TargetWritten);
        upsert_note_metadata_for_restore(pool, &manifest.session_id, &manifest.current_relative_path, &manifest.target_hash, now)
            .await?;
        let _ = store.set_restore_manifest_phase(&manifest.operation_id, RestorePhase::MetadataCommitted);
        store.remove_restore_manifest(&manifest.operation_id)?;
        return Ok(());
    }

    // Neither the target nor the recorded prior state — something else
    // wrote to this path since the manifest was recorded. Every file and
    // revision is preserved as-is; only the manifest is discarded.
    let _ = store.set_restore_manifest_phase(&manifest.operation_id, RestorePhase::Cancelled);
    let _ = store.remove_restore_manifest(&manifest.operation_id);
    match current_hash {
        Some(_) => {
            let live = store.read(&manifest.current_relative_path)?;
            Err(NoteCommandError::Conflict { disk_content: live.content, disk_hash: live.content_hash })
        }
        None => Err(NoteCommandError::Missing { relative_path: manifest.current_relative_path.clone() }),
    }
}

/// An unfinished restore of this exact (session, target revision) already
/// in flight, if any — resuming it (rather than re-deciding everything
/// and creating a duplicate operation) is what makes an in-process retry
/// idempotent, using the exact same filesystem scan startup recovery uses.
fn find_unfinished_restore_manifest(
    store: &NoteFileStore,
    session_id: &str,
    target_revision_id: &str,
) -> Result<Option<crate::revision_files::RestoreManifest>, NoteCommandError> {
    use crate::revision_files::RestorePhase;
    let manifests = store.restore_manifests()?;
    Ok(manifests.into_iter().find(|manifest| {
        manifest.session_id == session_id
            && manifest.target_revision_id == target_revision_id
            && manifest.phase != RestorePhase::Cancelled
            && manifest.phase != RestorePhase::MetadataCommitted
    }))
}

/// Restores `revision_id` as the session's current note. Follows the
/// design doc's Restore section exactly: verify the target snapshot,
/// distinguish an absent note (eligible for re-creation at its
/// deterministic path) from a file-backed one, short-circuit as an
/// idempotent success if current content already matches the target,
/// reject a stale `expected_current_hash` as a conflict, snapshot
/// non-blank displaced content as `before_restore` *before* writing the
/// manifest, and only then replace the current file — a late external
/// change at that exact point cancels the manifest and surfaces a fresh
/// conflict rather than overwriting anything.
pub(crate) async fn restore_note_revision_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    revision_id: &str,
    expected_current_hash: Option<&str>,
    now: i64,
) -> Result<RestoreRevisionResponse, NoteCommandError> {
    let target_dto = crate::revision_commands::revision_dto_by_id(pool, revision_id).await?;
    // Verifies the selected snapshot's bytes before anything else touches it.
    store.read_revision_object(&target_dto.session_id, &target_dto.content_hash)?;

    if let Some(manifest) = find_unfinished_restore_manifest(store, &target_dto.session_id, &target_dto.id)? {
        resume_or_complete_restore_manifest(pool, store, &manifest, now).await?;
        let note = load_session_note_core(pool, store, &target_dto.session_id)
            .await?
            .ok_or_else(|| NoteCommandError::Transient { message: "restored note is unexpectedly missing".to_string() })?;
        let safety_revision = match &manifest.safety_revision_id {
            Some(id) => Some(crate::revision_commands::revision_dto_by_id(pool, id).await?),
            None => None,
        };
        return Ok(RestoreRevisionResponse { note, safety_revision });
    }

    let existing = sqlx::query_as::<_, ExistingNoteMetadata>(
        "SELECT id, file_path, created_at FROM session_notes WHERE session_id = ?",
    )
    .bind(&target_dto.session_id)
    .fetch_optional(pool)
    .await?;

    let (current_relative_path, prior, current_content) = match existing {
        None => {
            let session = sqlx::query_as::<_, SessionNamingMetadata>(
                "SELECT task, started_at FROM sessions WHERE id = ?",
            )
            .bind(&target_dto.session_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| NoteCommandError::Transient { message: "owning session does not exist".to_string() })?;
            let local_date = local_date_from_millis(session.started_at)?;
            let relative_path = store.note_relative_path(&target_dto.session_id, &session.task, &local_date)?;
            match store.read(&relative_path) {
                Err(NoteFileError::Missing { .. }) => {}
                Ok(_) => {
                    return Err(NoteCommandError::Transient {
                        message: "an unreferenced file already exists at the note's expected path".to_string(),
                    });
                }
                Err(error) => return Err(error.into()),
            }
            (relative_path, crate::revision_files::PriorNoteState::NoNoteRow, None)
        }
        Some(ExistingNoteMetadata { file_path: None, .. }) => {
            return Err(NoteCommandError::Transient { message: "note is still on legacy storage".to_string() });
        }
        Some(ExistingNoteMetadata { file_path: Some(file_path), .. }) => {
            let current = store.read(&file_path)?;
            let content_hash = current.content_hash.clone();
            (file_path, crate::revision_files::PriorNoteState::Present { content_hash }, Some(current.content))
        }
    };

    let current_hash = match &prior {
        crate::revision_files::PriorNoteState::NoNoteRow => None,
        crate::revision_files::PriorNoteState::Present { content_hash } => Some(content_hash.clone()),
    };

    // Already matches: repair metadata if needed and return idempotent
    // success, before ever consulting the frontend's expected hash.
    if current_hash.as_deref() == Some(target_dto.content_hash.as_str()) {
        upsert_note_metadata_for_restore(pool, &target_dto.session_id, &current_relative_path, &target_dto.content_hash, now)
            .await?;
        let note = load_session_note_core(pool, store, &target_dto.session_id)
            .await?
            .ok_or_else(|| NoteCommandError::Transient { message: "restored note is unexpectedly missing".to_string() })?;
        return Ok(RestoreRevisionResponse { note, safety_revision: None });
    }

    if current_hash.as_deref() != expected_current_hash {
        return Err(NoteCommandError::Conflict {
            disk_content: current_content.unwrap_or_default(),
            disk_hash: current_hash.unwrap_or_default(),
        });
    }

    let safety_revision = match &current_content {
        Some(content) if !content.trim().is_empty() => {
            let content_hash = current_hash.clone().expect("non-empty current content implies a known hash");
            store.ensure_revision_object(&target_dto.session_id, content, &content_hash)?;
            let mut tx = pool.begin().await?;
            let dto = crate::revision_commands::insert_or_reuse_revision_row(
                &mut tx,
                &target_dto.session_id,
                &content_hash,
                crate::revision_commands::RevisionKind::Safety,
                crate::revision_commands::RevisionReason::BeforeRestore,
                now,
            )
            .await?;
            tx.commit().await?;
            Some(dto)
        }
        _ => None,
    };

    let manifest = crate::revision_files::RestoreManifest {
        version: crate::revision_files::RESTORE_MANIFEST_VERSION,
        operation_id: Uuid::new_v4().to_string(),
        phase: crate::revision_files::RestorePhase::Prepared,
        session_id: target_dto.session_id.clone(),
        current_relative_path,
        prior,
        target_revision_id: target_dto.id.clone(),
        target_hash: target_dto.content_hash.clone(),
        safety_revision_id: safety_revision.as_ref().map(|dto| dto.id.clone()),
    };
    store.write_restore_manifest(&manifest)?;

    resume_or_complete_restore_manifest(pool, store, &manifest, now).await?;

    let note = load_session_note_core(pool, store, &target_dto.session_id)
        .await?
        .ok_or_else(|| NoteCommandError::Transient { message: "restored note is unexpectedly missing".to_string() })?;
    Ok(RestoreRevisionResponse { note, safety_revision })
}

/// Rolls forward or cancels every restore manifest left behind by a
/// previous process, using the exact same logic a fresh restore's own
/// completion does. Errors from one manifest don't stop the others — each
/// is independent — but the first one is still propagated after every
/// manifest has been attempted, so a genuine problem (corrupt target
/// object, missing session) isn't silently swallowed at startup.
pub(crate) async fn recover_restore_manifests_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<(), NoteCommandError> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut first_error = None;
    for manifest in store.restore_manifests()? {
        if let Err(error) = resume_or_complete_restore_manifest(pool, store, &manifest, now).await {
            if first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Rolls forward or cancels every typed staged-data manifest (session,
/// revision-history, or delete-all deletion) left behind by a previous
/// process. Whether an operation's owning rows still exist is exactly the
/// signal that decides its outcome — restore if they do (the SQL
/// transaction never committed), finalize if they're gone (it did) — the
/// same reasoning `recover_staged_deletions_core` already uses for a
/// plain single-file stage, generalized across both roots. Errors from
/// one manifest don't stop the others, but the first is still propagated
/// at the end.
pub(crate) async fn recover_staged_data_core(pool: &sqlx::SqlitePool, store: &NoteFileStore) -> Result<(), NoteCommandError> {
    let mut first_error = None;
    for manifest in store.staged_data_manifests()? {
        let rows_remain = match &manifest.kind {
            crate::revision_files::StagedDataKind::Session { session_id } => {
                let exists: Option<i64> =
                    sqlx::query_scalar("SELECT 1 FROM sessions WHERE id = ?").bind(session_id).fetch_optional(pool).await?;
                exists.is_some()
            }
            crate::revision_files::StagedDataKind::RevisionHistory { session_id } => {
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM note_revisions WHERE session_id = ?")
                    .bind(session_id)
                    .fetch_one(pool)
                    .await?;
                count > 0
            }
            crate::revision_files::StagedDataKind::AllData => {
                let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions").fetch_one(pool).await?;
                count > 0
            }
        };
        let outcome = if rows_remain {
            store.restore_staged_data_manifest(&manifest)
        } else {
            store.finalize_staged_data_by_id(&manifest.operation_id)
        };
        if let Err(error) = outcome {
            if first_error.is_none() {
                first_error = Some(error.into());
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
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
pub async fn resolve_external_conflict_keep(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    session_id: String,
    draft: String,
    conflict_hash: String,
    now: i64,
) -> Result<ConflictResolutionResponse, NoteCommandError> {
    let pool = pool_for(&app).await?;
    resolve_external_conflict_keep_core(&pool, &store, &session_id, &draft, &conflict_hash, now).await
}

#[tauri::command]
pub async fn resolve_external_conflict_reload(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    session_id: String,
    draft: String,
    conflict_hash: String,
    now: i64,
) -> Result<ConflictResolutionResponse, NoteCommandError> {
    let pool = pool_for(&app).await?;
    resolve_external_conflict_reload_core(&pool, &store, &session_id, &draft, &conflict_hash, now).await
}

#[tauri::command]
pub async fn restore_note_revision(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    revision_id: String,
    expected_current_hash: Option<String>,
    now: i64,
) -> Result<RestoreRevisionResponse, NoteCommandError> {
    let pool = pool_for(&app).await?;
    restore_note_revision_core(&pool, &store, &revision_id, expected_current_hash.as_deref(), now).await
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

/// Opens the canonical app-managed notes directory with the OS file
/// manager. Accepts no path from the frontend — it only ever opens
/// `store.notes_dir()`, ensuring it exists first (a fresh install may not
/// have created it yet if no note has ever been saved).
#[tauri::command]
pub fn open_notes_folder(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
) -> Result<(), NoteCommandError> {
    use tauri_plugin_opener::OpenerExt;

    store.initialize()?;
    app.opener().open_path(store.notes_dir().to_string_lossy(), None::<&str>).map_err(|_error| {
        NoteCommandError::Transient { message: "could not open the notes folder".to_string() }
    })
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
            // Real migrations (not a hand-rolled subset): before-clear and
            // external-conflict safety need the real `note_revisions` table
            // alongside `sessions`/`session_notes`, and using the actual
            // schema keeps this fixture from drifting out of sync with it.
            for migration in crate::migrations::migrations() {
                sqlx::raw_sql(migration.sql.as_ref()).execute(&pool).await.unwrap();
            }

            let store = NoteFileStore::new(dir.path().join("app-data"));
            store.initialize().unwrap();
            Self { _dir: dir, pool, store }
        }

        async fn insert_session(&self, id: &str, task: &str, started_at: i64) {
            sqlx::query(
                "INSERT INTO sessions (id, task, status, started_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
            )
            .bind(id)
            .bind(task)
            .bind(started_at)
            .bind(started_at)
            .execute(&self.pool)
            .await
            .unwrap();
        }

        async fn revision_row_count(&self, session_id: &str) -> i64 {
            sqlx::query_scalar("SELECT COUNT(*) FROM note_revisions WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&self.pool)
                .await
                .unwrap()
        }

        async fn revision_reasons(&self, session_id: &str) -> Vec<String> {
            sqlx::query_scalar(
                "SELECT reason FROM note_revisions WHERE session_id = ? ORDER BY created_at, rowid",
            )
            .bind(session_id)
            .fetch_all(&self.pool)
            .await
            .unwrap()
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
    async fn whitespace_clear_creates_a_before_clear_safety_revision_and_removes_the_note() {
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
        assert_eq!(fixture.revision_row_count("s1").await, 1);
        assert_eq!(fixture.revision_reasons("s1").await, vec!["before_clear".to_string()]);
        let stored = fixture.store.read_revision_object("s1", first.content_hash.as_deref().unwrap()).unwrap();
        assert_eq!(stored.content, "content");
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn whitespace_clear_reuses_an_existing_revision_for_the_same_content() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
                .await
                .unwrap()
                .note
                .unwrap();
        // A manual checkpoint already recorded this exact content before
        // the clear happens — the clear must reuse that row rather than
        // create a second timeline entry for the same bytes.
        let request = crate::revision_commands::CreateRevisionRequest {
            session_id: "s1".to_string(),
            content: "content".to_string(),
            content_hash: first.content_hash.clone().unwrap(),
            kind: crate::revision_commands::RevisionKind::Checkpoint,
            reason: crate::revision_commands::RevisionReason::Manual,
            created_at: 1500,
        };
        crate::revision_commands::create_note_revision_core(&fixture.pool, &fixture.store, request)
            .await
            .unwrap();

        save_session_note_core(&fixture.pool, &fixture.store, "s1", " \n ", first.content_hash.as_deref(), 2000, false)
            .await
            .unwrap();

        assert_eq!(fixture.revision_row_count("s1").await, 1);
        assert_eq!(fixture.revision_reasons("s1").await, vec!["manual".to_string()]);
    }

    #[tokio::test]
    async fn whitespace_clear_conflict_keeps_the_note_and_creates_no_safety_revision() {
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

        assert!(matches!(result, Err(NoteCommandError::Conflict { disk_content, .. }) if disk_content == "external edit"));
        assert_eq!(
            fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content,
            "external edit"
        );
        assert_eq!(fixture.revision_row_count("s1").await, 0);
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn whitespace_clear_with_a_missing_duplicate_object_is_repaired_and_proceeds() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
                .await
                .unwrap()
                .note
                .unwrap();
        let content_hash = first.content_hash.clone().unwrap();
        fixture.store.ensure_revision_object("s1", "content", &content_hash).unwrap();
        std::fs::remove_file(fixture.store.revisions_dir().join("s1").join(format!("{content_hash}.md"))).unwrap();

        let cleared = save_session_note_core(
            &fixture.pool,
            &fixture.store,
            "s1",
            " ",
            first.content_hash.as_deref(),
            2000,
            false,
        )
        .await
        .unwrap();

        assert!(cleared.note.is_none());
        let stored = fixture.store.read_revision_object("s1", &content_hash).unwrap();
        assert_eq!(stored.content, "content");
    }

    #[tokio::test]
    async fn whitespace_clear_with_a_corrupt_duplicate_object_blocks_the_clear_and_keeps_the_note() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
                .await
                .unwrap()
                .note
                .unwrap();
        let content_hash = first.content_hash.clone().unwrap();
        fixture.store.ensure_revision_object("s1", "content", &content_hash).unwrap();
        std::fs::write(fixture.store.revisions_dir().join("s1").join(format!("{content_hash}.md")), b"tampered")
            .unwrap();

        let result =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", " ", first.content_hash.as_deref(), 2000, false)
                .await;

        assert!(result.is_err());
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "content");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn whitespace_clear_sql_failure_restores_the_file_and_rolls_back_the_safety_row() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let first =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
                .await
                .unwrap()
                .note
                .unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_note_delete
             BEFORE DELETE ON session_notes
             BEGIN
                 SELECT RAISE(ABORT, 'forced delete failure');
             END",
        )
        .execute(&fixture.pool)
        .await
        .unwrap();

        let result =
            save_session_note_core(&fixture.pool, &fixture.store, "s1", " ", first.content_hash.as_deref(), 2000, false)
                .await;

        assert!(result.is_err());
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "content");
        assert_eq!(fixture.revision_row_count("s1").await, 0); // rolled back with the rest of the tx
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            1
        );
        assert!(fixture.store.staged_entries().unwrap().is_empty());
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
    async fn resolve_external_conflict_keep_snapshots_external_bytes_and_writes_the_draft() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "external edit", "").await;
        let conflict_hash = fixture.note_metadata("s1").await.content_hash.unwrap();

        let response =
            resolve_external_conflict_keep_core(&fixture.pool, &fixture.store, "s1", "my draft", &conflict_hash, 2000)
                .await
                .unwrap();

        let note = response.note.unwrap();
        assert_eq!(note.content, "my draft");
        assert_eq!(fixture.store.read(note.file_path.as_deref().unwrap()).unwrap().content, "my draft");
        assert_eq!(fixture.revision_reasons("s1").await, vec!["before_external_overwrite".to_string()]);
        let safety = response.safety_revision.unwrap();
        let stored = fixture.store.read_revision_object("s1", &safety.content_hash).unwrap();
        assert_eq!(stored.content, "external edit");
    }

    #[tokio::test]
    async fn resolve_external_conflict_keep_returns_a_fresh_conflict_when_disk_changed_again() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "first external edit", "").await;
        let stale_hash = fixture.note_metadata("s1").await.content_hash.unwrap();
        let file_path = fixture.note_metadata("s1").await.file_path.clone();
        let file_path = file_path.unwrap();
        fixture.store.compare_and_write(&file_path, "second external edit", None, true).unwrap();

        let result =
            resolve_external_conflict_keep_core(&fixture.pool, &fixture.store, "s1", "my draft", &stale_hash, 2000)
                .await;

        assert!(matches!(result, Err(NoteCommandError::Conflict { disk_content, .. }) if disk_content == "second external edit"));
        assert_eq!(fixture.store.read(&file_path).unwrap().content, "second external edit");
        assert_eq!(fixture.revision_row_count("s1").await, 0);
    }

    #[tokio::test]
    async fn resolve_external_conflict_keep_repairs_metadata_when_the_draft_already_landed() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "my draft", "").await;
        let conflict_hash = fixture.note_metadata("s1").await.content_hash.unwrap();

        let response = resolve_external_conflict_keep_core(
            &fixture.pool,
            &fixture.store,
            "s1",
            "my draft",
            &conflict_hash,
            2000,
        )
        .await
        .unwrap();

        assert_eq!(response.note.unwrap().content, "my draft");
        assert!(response.safety_revision.is_none());
        assert_eq!(fixture.revision_row_count("s1").await, 0); // no snapshot for an idempotent repair
    }

    #[tokio::test]
    async fn resolve_external_conflict_keep_with_a_blank_draft_clears_the_note_and_snapshots_external_content() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "external edit", "").await;
        let conflict_hash = fixture.note_metadata("s1").await.content_hash.unwrap();
        let file_path = fixture.note_metadata("s1").await.file_path.unwrap();

        let response =
            resolve_external_conflict_keep_core(&fixture.pool, &fixture.store, "s1", "  \n ", &conflict_hash, 2000)
                .await
                .unwrap();

        assert!(response.note.is_none());
        assert!(matches!(fixture.store.read(&file_path), Err(NoteFileError::Missing { .. })));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(fixture.revision_reasons("s1").await, vec!["before_external_overwrite".to_string()]);
    }

    #[tokio::test]
    async fn resolve_external_conflict_reload_snapshots_the_draft_and_returns_verified_disk_content() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "external edit", "").await;
        let conflict_hash = fixture.note_metadata("s1").await.content_hash.unwrap();

        let response = resolve_external_conflict_reload_core(
            &fixture.pool,
            &fixture.store,
            "s1",
            "my discarded draft",
            &conflict_hash,
            2000,
        )
        .await
        .unwrap();

        assert_eq!(response.note.unwrap().content, "external edit");
        assert_eq!(fixture.revision_reasons("s1").await, vec!["before_external_reload".to_string()]);
        let safety = response.safety_revision.unwrap();
        let stored = fixture.store.read_revision_object("s1", &safety.content_hash).unwrap();
        assert_eq!(stored.content, "my discarded draft");
    }

    #[tokio::test]
    async fn resolve_external_conflict_reload_returns_a_fresh_conflict_when_disk_changed_again() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "first external edit", "").await;
        let stale_hash = fixture.note_metadata("s1").await.content_hash.unwrap();
        let file_path = fixture.note_metadata("s1").await.file_path.unwrap();
        fixture.store.compare_and_write(&file_path, "second external edit", None, true).unwrap();

        let result = resolve_external_conflict_reload_core(
            &fixture.pool,
            &fixture.store,
            "s1",
            "my discarded draft",
            &stale_hash,
            2000,
        )
        .await;

        assert!(matches!(result, Err(NoteCommandError::Conflict { disk_content, .. }) if disk_content == "second external edit"));
        assert_eq!(fixture.revision_row_count("s1").await, 0); // draft never snapshotted against stale info
    }

    #[tokio::test]
    async fn resolve_external_conflict_reload_with_a_blank_draft_creates_no_safety_revision() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "external edit", "").await;
        let conflict_hash = fixture.note_metadata("s1").await.content_hash.unwrap();

        let response =
            resolve_external_conflict_reload_core(&fixture.pool, &fixture.store, "s1", "  \n ", &conflict_hash, 2000)
                .await
                .unwrap();

        assert_eq!(response.note.unwrap().content, "external edit");
        assert!(response.safety_revision.is_none());
        assert_eq!(fixture.revision_row_count("s1").await, 0);
    }

    async fn checkpoint(fixture: &TestFixture, session_id: &str, content: &str, created_at: i64) -> crate::revision_commands::RevisionDto {
        let content_hash = crate::note_files::sha256_hex(content.as_bytes());
        crate::revision_commands::create_note_revision_core(
            &fixture.pool,
            &fixture.store,
            crate::revision_commands::CreateRevisionRequest {
                session_id: session_id.to_string(),
                content: content.to_string(),
                content_hash,
                kind: crate::revision_commands::RevisionKind::Checkpoint,
                reason: crate::revision_commands::RevisionReason::Manual,
                created_at,
            },
        )
        .await
        .unwrap()
        .unwrap()
    }

    #[tokio::test]
    async fn restore_verifies_the_target_object_before_touching_anything() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "current", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target = checkpoint(&fixture, "s1", "target content", 1500).await;
        std::fs::write(
            fixture.store.revisions_dir().join("s1").join(format!("{}.md", target.content_hash)),
            b"tampered",
        )
        .unwrap();

        let result = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, first.content_hash.as_deref(), 2000).await;

        assert!(result.is_err());
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "current");
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn restore_with_current_content_already_matching_the_target_is_idempotent() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "same content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target = checkpoint(&fixture, "s1", "same content", 1500).await;

        // A deliberately wrong expected_current_hash: the already-matches
        // fast path must succeed before ever consulting it.
        let response = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, Some("not-the-real-hash"), 2000)
            .await
            .unwrap();

        assert_eq!(response.note.content, "same content");
        assert!(response.safety_revision.is_none());
        assert_eq!(fixture.revision_row_count("s1").await, 1); // only the checkpoint — no before_restore
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
        assert_eq!(fixture.note_metadata("s1").await.content_hash, first.content_hash);
    }

    #[tokio::test]
    async fn restore_creates_a_current_note_when_none_exists_and_its_deterministic_path_is_absent() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let target = checkpoint(&fixture, "s1", "revived content", 1500).await;

        let response = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, None, 2000).await.unwrap();

        assert_eq!(response.note.content, "revived content");
        assert!(response.safety_revision.is_none()); // nothing was displaced
        let stored = fixture.store.read(response.note.file_path.as_deref().unwrap()).unwrap();
        assert_eq!(stored.content, "revived content");
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn restore_blocks_when_an_orphan_file_occupies_the_deterministic_path() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1_722_163_200_000).await;
        let target = checkpoint(&fixture, "s1", "revived content", 1500).await;
        let local_date = local_date_from_millis(1_722_163_200_000).unwrap();
        let relative_path = fixture.store.note_relative_path("s1", "Task", &local_date).unwrap();
        fixture.store.compare_and_write(&relative_path, "unrelated orphan file", None, false).unwrap();

        let result = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, None, 2000).await;

        assert!(result.is_err());
        assert_eq!(fixture.store.read(&relative_path).unwrap().content, "unrelated orphan file");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM session_notes WHERE session_id = 's1'")
                .fetch_one(&fixture.pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn restore_blocks_when_the_current_row_references_a_missing_file() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "current", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target = checkpoint(&fixture, "s1", "target content", 1500).await;
        std::fs::remove_file(fixture.store.notes_dir().join(first.file_path.as_deref().unwrap())).unwrap();

        let result = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, None, 2000).await;

        assert!(matches!(result, Err(NoteCommandError::Missing { .. })));
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn restore_blocks_when_the_current_row_is_still_legacy() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        fixture.insert_legacy_note("n1", "s1", "legacy content").await;
        let target = checkpoint(&fixture, "s1", "target content", 1500).await;

        let result = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, None, 2000).await;

        assert!(matches!(result, Err(NoteCommandError::Transient { .. })));
        assert_eq!(fixture.legacy_content("s1").await, "legacy content");
    }

    #[tokio::test]
    async fn restore_snapshots_non_blank_prior_content_as_before_restore_before_replacing_it() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "current content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target = checkpoint(&fixture, "s1", "target content", 1500).await;

        let response =
            restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, first.content_hash.as_deref(), 2000)
                .await
                .unwrap();

        assert_eq!(response.note.content, "target content");
        let safety = response.safety_revision.unwrap();
        assert_eq!(safety.reason, crate::revision_commands::RevisionReason::BeforeRestore);
        let stored = fixture.store.read_revision_object("s1", &safety.content_hash).unwrap();
        assert_eq!(stored.content, "current content");
        assert_eq!(fixture.revision_row_count("s1").await, 2); // checkpoint + safety
    }

    #[tokio::test]
    async fn restore_with_a_stale_expected_hash_returns_a_conflict_before_replacing_anything() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "current content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target = checkpoint(&fixture, "s1", "target content", 1500).await;

        let result = restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, Some("stale-hash"), 2000).await;

        assert!(matches!(result, Err(NoteCommandError::Conflict { disk_content, .. }) if disk_content == "current content"));
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "current content");
        assert_eq!(fixture.revision_row_count("s1").await, 1); // checkpoint only — no safety revision created
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn resuming_a_manifest_cancels_and_preserves_everything_on_a_late_external_change() {
        use crate::revision_files::{PriorNoteState, RestoreManifest, RestorePhase, RESTORE_MANIFEST_VERSION};

        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "original", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target_content = "restored content";
        let target_hash = crate::note_files::sha256_hex(target_content.as_bytes());
        fixture.store.ensure_revision_object("s1", target_content, &target_hash).unwrap();

        let manifest = RestoreManifest {
            version: RESTORE_MANIFEST_VERSION,
            operation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa".to_string(),
            phase: RestorePhase::Prepared,
            session_id: "s1".to_string(),
            current_relative_path: first.file_path.clone().unwrap(),
            prior: PriorNoteState::Present { content_hash: first.content_hash.clone().unwrap() },
            target_revision_id: "rev-x".to_string(),
            target_hash: target_hash.clone(),
            safety_revision_id: None,
        };
        fixture.store.write_restore_manifest(&manifest).unwrap();

        // Late external change landing between manifest creation and the
        // (re)attempt that would otherwise complete it.
        fixture
            .store
            .compare_and_write(&first.file_path.clone().unwrap(), "late external edit", first.content_hash.as_deref(), true)
            .unwrap();

        let result = resume_or_complete_restore_manifest(&fixture.pool, &fixture.store, &manifest, 2000).await;

        assert!(matches!(result, Err(NoteCommandError::Conflict { disk_content, .. }) if disk_content == "late external edit"));
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "late external edit");
        assert!(fixture.store.restore_manifests().unwrap().is_empty()); // cancelled and cleaned up
    }

    #[tokio::test]
    async fn a_failure_after_target_write_but_before_metadata_upsert_resumes_the_same_manifest_in_process() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "current content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target = checkpoint(&fixture, "s1", "target content", 1500).await;

        fixture.fail_next_metadata_update().await;
        let first_attempt =
            restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, first.content_hash.as_deref(), 2000).await;
        assert!(first_attempt.is_err());
        // The target write already landed even though the whole operation
        // reported failure.
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "target content");
        assert_eq!(fixture.store.restore_manifests().unwrap().len(), 1);
        let safety_from_first_attempt = fixture
            .store
            .restore_manifests()
            .unwrap()
            .into_iter()
            .next()
            .unwrap()
            .safety_revision_id
            .unwrap();

        fixture.allow_metadata_updates().await;
        let second_attempt =
            restore_note_revision_core(&fixture.pool, &fixture.store, &target.id, first.content_hash.as_deref(), 3000)
                .await
                .unwrap();

        assert_eq!(second_attempt.note.content, "target content");
        assert_eq!(second_attempt.safety_revision.unwrap().id, safety_from_first_attempt);
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
        assert_eq!(fixture.revision_row_count("s1").await, 2); // checkpoint + exactly one safety revision
    }

    #[tokio::test]
    async fn recover_restore_manifests_rolls_forward_a_prepared_manifest_whose_target_was_never_written() {
        use crate::revision_files::{PriorNoteState, RestoreManifest, RestorePhase, RESTORE_MANIFEST_VERSION};

        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "original", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target_content = "restored content";
        let target_hash = crate::note_files::sha256_hex(target_content.as_bytes());
        fixture.store.ensure_revision_object("s1", target_content, &target_hash).unwrap();
        let manifest = RestoreManifest {
            version: RESTORE_MANIFEST_VERSION,
            operation_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb".to_string(),
            phase: RestorePhase::Prepared,
            session_id: "s1".to_string(),
            current_relative_path: first.file_path.clone().unwrap(),
            prior: PriorNoteState::Present { content_hash: first.content_hash.clone().unwrap() },
            target_revision_id: "rev-x".to_string(),
            target_hash: target_hash.clone(),
            safety_revision_id: None,
        };
        fixture.store.write_restore_manifest(&manifest).unwrap();

        recover_restore_manifests_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "restored content");
        assert_eq!(fixture.note_metadata("s1").await.content_hash.unwrap(), target_hash);
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_restore_manifests_repairs_stale_metadata_when_the_target_was_already_written() {
        use crate::revision_files::{PriorNoteState, RestoreManifest, RestorePhase, RESTORE_MANIFEST_VERSION};

        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "original", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target_content = "restored content";
        let target_hash = crate::note_files::sha256_hex(target_content.as_bytes());
        fixture.store.ensure_revision_object("s1", target_content, &target_hash).unwrap();
        // Simulate a crash after the file was already replaced (matching
        // target_hash) but before metadata committed.
        fixture
            .store
            .compare_and_write(&first.file_path.clone().unwrap(), target_content, first.content_hash.as_deref(), false)
            .unwrap();
        let manifest = RestoreManifest {
            version: RESTORE_MANIFEST_VERSION,
            operation_id: "cccccccc-cccc-cccc-cccc-cccccccccccc".to_string(),
            phase: RestorePhase::TargetWritten,
            session_id: "s1".to_string(),
            current_relative_path: first.file_path.clone().unwrap(),
            prior: PriorNoteState::Present { content_hash: first.content_hash.clone().unwrap() },
            target_revision_id: "rev-x".to_string(),
            target_hash: target_hash.clone(),
            safety_revision_id: None,
        };
        fixture.store.write_restore_manifest(&manifest).unwrap();

        recover_restore_manifests_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.note_metadata("s1").await.content_hash.unwrap(), target_hash);
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_restore_manifests_cancels_on_an_unexpected_external_hash_without_overwriting() {
        use crate::revision_files::{PriorNoteState, RestoreManifest, RestorePhase, RESTORE_MANIFEST_VERSION};

        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "original", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        let target_content = "restored content";
        let target_hash = crate::note_files::sha256_hex(target_content.as_bytes());
        fixture.store.ensure_revision_object("s1", target_content, &target_hash).unwrap();
        let manifest = RestoreManifest {
            version: RESTORE_MANIFEST_VERSION,
            operation_id: "dddddddd-dddd-dddd-dddd-dddddddddddd".to_string(),
            phase: RestorePhase::Prepared,
            session_id: "s1".to_string(),
            current_relative_path: first.file_path.clone().unwrap(),
            prior: PriorNoteState::Present { content_hash: first.content_hash.clone().unwrap() },
            target_revision_id: "rev-x".to_string(),
            target_hash: target_hash.clone(),
            safety_revision_id: None,
        };
        fixture.store.write_restore_manifest(&manifest).unwrap();
        fixture
            .store
            .compare_and_write(&first.file_path.clone().unwrap(), "unrelated external edit", first.content_hash.as_deref(), true)
            .unwrap();

        let result = recover_restore_manifests_core(&fixture.pool, &fixture.store).await;

        assert!(result.is_err());
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "unrelated external edit");
        assert!(fixture.store.restore_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_restore_manifests_blocks_on_a_missing_target_object_or_session() {
        use crate::revision_files::{PriorNoteState, RestoreManifest, RestorePhase, RESTORE_MANIFEST_VERSION};

        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let first = save_session_note_core(&fixture.pool, &fixture.store, "s1", "original", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        // No object was ever written for this target hash.
        let missing_target_hash = crate::note_files::sha256_hex(b"never stored");
        let manifest = RestoreManifest {
            version: RESTORE_MANIFEST_VERSION,
            operation_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee".to_string(),
            phase: RestorePhase::Prepared,
            session_id: "s1".to_string(),
            current_relative_path: first.file_path.clone().unwrap(),
            prior: PriorNoteState::Present { content_hash: first.content_hash.clone().unwrap() },
            target_revision_id: "rev-x".to_string(),
            target_hash: missing_target_hash,
            safety_revision_id: None,
        };
        fixture.store.write_restore_manifest(&manifest).unwrap();

        let result = recover_restore_manifests_core(&fixture.pool, &fixture.store).await;

        assert!(result.is_err());
        assert_eq!(fixture.store.read(first.file_path.as_deref().unwrap()).unwrap().content, "original");
        // The manifest is left in place for attention rather than silently discarded.
        assert_eq!(fixture.store.restore_manifests().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn recover_staged_data_restores_a_session_delete_when_the_session_row_still_exists() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let note = save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        // Staged as if the process crashed before the SQL transaction ran
        // at all — the session row is still there.
        fixture.store.stage_session_data("s1", note.file_path.as_deref()).unwrap();

        recover_staged_data_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.store.read(note.file_path.as_deref().unwrap()).unwrap().content, "content");
        assert!(fixture.store.staged_data_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_staged_data_finishes_a_session_delete_when_the_row_is_gone() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let note = save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        fixture.store.stage_session_data("s1", note.file_path.as_deref()).unwrap();
        // Simulate the SQL transaction having actually committed.
        sqlx::query("DELETE FROM sessions WHERE id = 's1'").execute(&fixture.pool).await.unwrap();

        recover_staged_data_core(&fixture.pool, &fixture.store).await.unwrap();

        assert!(matches!(
            fixture.store.read(note.file_path.as_deref().unwrap()),
            Err(NoteFileError::Missing { .. })
        ));
        assert!(fixture.store.staged_data_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_staged_data_restores_a_revision_history_delete_when_rows_remain() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let target = checkpoint(&fixture, "s1", "revision content", 1000).await;
        // Staged before the DELETE ran — the row is still there.
        fixture.store.stage_revision_history("s1").unwrap();

        recover_staged_data_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.store.read_revision_object("s1", &target.content_hash).unwrap().content, "revision content");
        assert!(fixture.store.staged_data_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_staged_data_finishes_a_revision_history_delete_when_rows_are_gone() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let target = checkpoint(&fixture, "s1", "revision content", 1000).await;
        fixture.store.stage_revision_history("s1").unwrap();
        sqlx::query("DELETE FROM note_revisions WHERE session_id = 's1'").execute(&fixture.pool).await.unwrap();

        recover_staged_data_core(&fixture.pool, &fixture.store).await.unwrap();

        assert!(matches!(
            fixture.store.read_revision_object("s1", &target.content_hash),
            Err(NoteFileError::Missing { .. })
        ));
        assert!(fixture.store.staged_data_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_staged_data_restores_delete_all_when_sessions_remain() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let note = save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        checkpoint(&fixture, "s1", "revision content", 1000).await;
        fixture.store.stage_all_data().unwrap();

        recover_staged_data_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.store.read(note.file_path.as_deref().unwrap()).unwrap().content, "content");
        assert!(fixture.store.staged_data_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn recover_staged_data_finishes_delete_all_when_sessions_are_gone() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1", "Task", 1000).await;
        let note = save_session_note_core(&fixture.pool, &fixture.store, "s1", "content", None, 1000, false)
            .await
            .unwrap()
            .note
            .unwrap();
        fixture.store.stage_all_data().unwrap();
        sqlx::query("DELETE FROM sessions").execute(&fixture.pool).await.unwrap();

        recover_staged_data_core(&fixture.pool, &fixture.store).await.unwrap();

        assert!(matches!(
            fixture.store.read(note.file_path.as_deref().unwrap()),
            Err(NoteFileError::Missing { .. })
        ));
        assert!(fixture.store.staged_data_manifests().unwrap().is_empty());
    }

    #[tokio::test]
    async fn staged_deletion_recovery_restores_when_delete_never_committed() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "content", "").await;

        // Simulate a crash between stage_paths() succeeding and the
        // session_notes DELETE committing: the row still references the
        // file, but stage_paths already moved it into trash.
        fixture.store.stage_paths(&["s1.md".to_string()]).unwrap();
        assert!(matches!(fixture.store.read("s1.md"), Err(NoteFileError::Missing { .. })));

        recover_staged_deletions_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.store.read("s1.md").unwrap().content, "content");
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn staged_deletion_recovery_leaves_a_differing_staged_copy_for_attention() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "old content", "").await;

        // Simulate a completed clear (stage + DB delete both committed)
        // whose finalize_stage() never ran before the crash, followed by
        // the user immediately typing a brand new note for the same
        // session/task/day — which reuses the exact same relative path.
        // The live file and SQLite metadata agree with each other ("new
        // content"), but the staged copy holds genuinely different
        // content ("old content") — that mismatch must not be silently
        // discarded, since the staged copy could hold something newer
        // than either the live file or whatever the original delete was
        // ever meant to remove.
        fixture.store.stage_paths(&["s1.md".to_string()]).unwrap();
        sqlx::query("DELETE FROM session_notes WHERE session_id = 's1'").execute(&fixture.pool).await.unwrap();
        let recreated = fixture.store.compare_and_write("s1.md", "new content", None, false).unwrap();
        sqlx::query(
            "INSERT INTO session_notes (
                id, session_id, content, file_path, content_hash, created_at, updated_at
            ) VALUES ('note-s1-2', 's1', '', 's1.md', ?, 2000, 2000)",
        )
        .bind(&recreated.content_hash)
        .execute(&fixture.pool)
        .await
        .unwrap();

        let result = recover_staged_deletions_core(&fixture.pool, &fixture.store).await;

        assert!(matches!(result, Err(NoteCommandError::Transient { .. })));
        assert_eq!(fixture.store.staged_entries().unwrap().len(), 1);
        assert_eq!(fixture.store.read("s1.md").unwrap().content, "new content");
        assert_eq!(fixture.note_metadata("s1").await.content_hash.unwrap(), recreated.content_hash);
    }

    #[tokio::test]
    async fn staged_deletion_recovery_finalizes_an_identical_staged_duplicate() {
        let fixture = TestFixture::new().await;
        fixture.insert_file_backed_note("s1", "content", "").await;
        let expected_hash = fixture.note_metadata("s1").await.content_hash.unwrap();

        fixture.store.stage_paths(&["s1.md".to_string()]).unwrap();
        // A file lands back at the original path with content identical to
        // the staged copy — original, staged, and expected_hash all agree.
        // The staged copy is a pure, redundant duplicate here: discarding
        // it loses nothing since the original already holds the same bytes.
        fixture.store.compare_and_write("s1.md", "content", None, false).unwrap();

        recover_staged_deletions_core(&fixture.pool, &fixture.store).await.unwrap();

        assert!(fixture.store.staged_entries().unwrap().is_empty());
        assert_eq!(fixture.store.read("s1.md").unwrap().content, "content");
        assert_eq!(fixture.note_metadata("s1").await.content_hash.unwrap(), expected_hash);
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
