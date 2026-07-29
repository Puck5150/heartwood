// Native revision metadata DTOs and SQLite/file orchestration: create,
// list, load, rename, and count note revisions. Command wrappers stay thin
// around testable `_core` functions that take a `&sqlx::SqlitePool` and
// `&NoteFileStore` directly, matching note_commands.rs's own pattern.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::note_commands::NoteCommandError;
use crate::note_files::{sha256_hex, NoteFileStore};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RevisionKind {
    Automatic,
    Checkpoint,
    Safety,
}

impl RevisionKind {
    fn as_sql(&self) -> &'static str {
        match self {
            RevisionKind::Automatic => "automatic",
            RevisionKind::Checkpoint => "checkpoint",
            RevisionKind::Safety => "safety",
        }
    }

    fn from_sql(value: &str) -> Result<Self, NoteCommandError> {
        match value {
            "automatic" => Ok(RevisionKind::Automatic),
            "checkpoint" => Ok(RevisionKind::Checkpoint),
            "safety" => Ok(RevisionKind::Safety),
            other => Err(NoteCommandError::Transient { message: format!("unknown revision kind: {other}") }),
        }
    }
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

impl RevisionReason {
    fn as_sql(&self) -> &'static str {
        match self {
            RevisionReason::SessionStarted => "session_started",
            RevisionReason::SessionCompleted => "session_completed",
            RevisionReason::ReviewFinalized => "review_finalized",
            RevisionReason::Manual => "manual",
            RevisionReason::BeforeClear => "before_clear",
            RevisionReason::BeforeRestore => "before_restore",
            RevisionReason::BeforeExternalOverwrite => "before_external_overwrite",
            RevisionReason::BeforeExternalReload => "before_external_reload",
        }
    }

    fn from_sql(value: &str) -> Result<Self, NoteCommandError> {
        match value {
            "session_started" => Ok(RevisionReason::SessionStarted),
            "session_completed" => Ok(RevisionReason::SessionCompleted),
            "review_finalized" => Ok(RevisionReason::ReviewFinalized),
            "manual" => Ok(RevisionReason::Manual),
            "before_clear" => Ok(RevisionReason::BeforeClear),
            "before_restore" => Ok(RevisionReason::BeforeRestore),
            "before_external_overwrite" => Ok(RevisionReason::BeforeExternalOverwrite),
            "before_external_reload" => Ok(RevisionReason::BeforeExternalReload),
            other => Err(NoteCommandError::Transient { message: format!("unknown revision reason: {other}") }),
        }
    }
}

/// Mirrors the SQL CHECK constraint exactly — enforced again here so
/// native code never even attempts to insert (or trust a caller's claim
/// of) a combination SQLite would reject anyway.
pub(crate) fn valid_pair(kind: RevisionKind, reason: RevisionReason) -> bool {
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

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRevisionDto {
    #[serde(flatten)]
    pub revision: RevisionDto,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionCountDto {
    pub session_id: String,
    pub count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRevisionRequest {
    pub session_id: String,
    pub content: String,
    pub content_hash: String,
    pub kind: RevisionKind,
    pub reason: RevisionReason,
    pub created_at: i64,
}

#[derive(sqlx::FromRow)]
struct RevisionRow {
    id: String,
    session_id: String,
    content_hash: String,
    kind: String,
    reason: String,
    label: Option<String>,
    created_at: i64,
}

impl RevisionRow {
    fn into_dto(self) -> Result<RevisionDto, NoteCommandError> {
        Ok(RevisionDto {
            id: self.id,
            session_id: self.session_id,
            content_hash: self.content_hash,
            kind: RevisionKind::from_sql(&self.kind)?,
            reason: RevisionReason::from_sql(&self.reason)?,
            label: self.label,
            created_at: self.created_at,
        })
    }
}

const SELECT_REVISION: &str =
    "SELECT id, session_id, content_hash, kind, reason, label, created_at FROM note_revisions";

async fn pool_for(app: &tauri::AppHandle) -> Result<sqlx::SqlitePool, NoteCommandError> {
    crate::db_commands::sqlite_pool(app)
        .await
        .map_err(|message| NoteCommandError::Transient { message })
}

/// Creates (or, for a session/hash pair that already has a row, reuses) a
/// revision. Returns `Ok(None)` for blank/whitespace-only content — no
/// revision is ever created for it. Recomputes the hash of `request.content`
/// and requires it to equal `request.content_hash` before anything is
/// written; a mismatch is rejected outright rather than trusting the
/// caller's claim.
pub(crate) async fn create_note_revision_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    request: CreateRevisionRequest,
) -> Result<Option<RevisionDto>, NoteCommandError> {
    if !valid_pair(request.kind, request.reason) {
        return Err(NoteCommandError::Transient { message: "invalid revision kind/reason pairing".to_string() });
    }
    if request.content.trim().is_empty() {
        return Ok(None);
    }
    let actual_hash = sha256_hex(request.content.as_bytes());
    if actual_hash != request.content_hash {
        return Err(NoteCommandError::Transient {
            message: "revision content does not match its expected hash".to_string(),
        });
    }

    let mut tx = pool.begin().await?;

    let session_exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM sessions WHERE id = ?")
        .bind(&request.session_id)
        .fetch_optional(&mut *tx)
        .await?;
    if session_exists.is_none() {
        return Err(NoteCommandError::Transient { message: "owning session does not exist".to_string() });
    }

    let existing = sqlx::query_as::<_, RevisionRow>(&format!(
        "{SELECT_REVISION} WHERE session_id = ? AND content_hash = ?"
    ))
    .bind(&request.session_id)
    .bind(&request.content_hash)
    .fetch_optional(&mut *tx)
    .await?;

    // Verifies an existing object, repairs one that's missing, and rejects
    // corruption — covers both the fresh-insert and the duplicate-row path
    // in one call. A failure here (including corruption) propagates via
    // `?`, dropping `tx` and rolling back before any row is touched.
    store.ensure_revision_object(&request.session_id, &request.content, &request.content_hash)?;

    let dto = if let Some(row) = existing {
        row.into_dto()?
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&request.session_id)
        .bind(&request.content_hash)
        .bind(request.kind.as_sql())
        .bind(request.reason.as_sql())
        .bind(request.created_at)
        .execute(&mut *tx)
        .await?;
        RevisionDto {
            id,
            session_id: request.session_id.clone(),
            content_hash: request.content_hash.clone(),
            kind: request.kind,
            reason: request.reason,
            label: None,
            created_at: request.created_at,
        }
    };

    tx.commit().await?;
    Ok(Some(dto))
}

/// Metadata only, newest first — never reads a single snapshot body.
pub(crate) async fn list_note_revisions_core(
    pool: &sqlx::SqlitePool,
    session_id: &str,
) -> Result<Vec<RevisionDto>, NoteCommandError> {
    let rows = sqlx::query_as::<_, RevisionRow>(&format!(
        "{SELECT_REVISION} WHERE session_id = ? ORDER BY created_at DESC, rowid DESC"
    ))
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(RevisionRow::into_dto).collect()
}

/// Loads one revision by id, never by a caller-supplied path/hash. Reads
/// and re-verifies the snapshot object's bytes before returning them.
pub(crate) async fn load_note_revision_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    revision_id: &str,
) -> Result<LoadedRevisionDto, NoteCommandError> {
    let row = sqlx::query_as::<_, RevisionRow>(&format!("{SELECT_REVISION} WHERE id = ?"))
        .bind(revision_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| NoteCommandError::Transient { message: "revision not found".to_string() })?;

    let dto = row.into_dto()?;
    let stored = store.read_revision_object(&dto.session_id, &dto.content_hash)?;
    Ok(LoadedRevisionDto { revision: dto, content: stored.content })
}

/// Trims `label`, normalizes blank/whitespace-only to `None` (which
/// restores the friendly default reason label on the frontend), and
/// enforces the 80-Unicode-character limit as the final authority — the
/// frontend's own validation is a UX nicety, not the source of truth.
fn normalize_label(label: Option<String>) -> Result<Option<String>, NoteCommandError> {
    let Some(raw) = label else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > 80 {
        return Err(NoteCommandError::Transient {
            message: "revision labels are limited to 80 characters".to_string(),
        });
    }
    Ok(Some(trimmed.to_string()))
}

/// Changes only the nullable `label` column — never touches the snapshot
/// object or any other metadata.
pub(crate) async fn rename_note_revision_core(
    pool: &sqlx::SqlitePool,
    revision_id: &str,
    label: Option<String>,
) -> Result<RevisionDto, NoteCommandError> {
    let normalized = normalize_label(label)?;
    sqlx::query("UPDATE note_revisions SET label = ? WHERE id = ?")
        .bind(&normalized)
        .bind(revision_id)
        .execute(pool)
        .await?;

    let row = sqlx::query_as::<_, RevisionRow>(&format!("{SELECT_REVISION} WHERE id = ?"))
        .bind(revision_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| NoteCommandError::Transient { message: "revision not found".to_string() })?;
    row.into_dto()
}

/// One row per session that has at least one revision — never reads a
/// snapshot body. Sessions with zero revisions simply have no row here;
/// the frontend treats an absent entry as a count of zero.
pub(crate) async fn load_note_revision_counts_core(
    pool: &sqlx::SqlitePool,
) -> Result<Vec<RevisionCountDto>, NoteCommandError> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT session_id, COUNT(*) FROM note_revisions GROUP BY session_id")
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(session_id, count)| RevisionCountDto { session_id, count }).collect())
}

#[tauri::command]
pub async fn create_note_revision(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    request: CreateRevisionRequest,
) -> Result<Option<RevisionDto>, NoteCommandError> {
    let pool = pool_for(&app).await?;
    create_note_revision_core(&pool, &store, request).await
}

#[tauri::command]
pub async fn list_note_revisions(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Vec<RevisionDto>, NoteCommandError> {
    let pool = pool_for(&app).await?;
    list_note_revisions_core(&pool, &session_id).await
}

#[tauri::command]
pub async fn load_note_revision(
    app: tauri::AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    revision_id: String,
) -> Result<LoadedRevisionDto, NoteCommandError> {
    let pool = pool_for(&app).await?;
    load_note_revision_core(&pool, &store, &revision_id).await
}

#[tauri::command]
pub async fn rename_note_revision(
    app: tauri::AppHandle,
    revision_id: String,
    label: Option<String>,
) -> Result<RevisionDto, NoteCommandError> {
    let pool = pool_for(&app).await?;
    rename_note_revision_core(&pool, &revision_id, label).await
}

#[tauri::command]
pub async fn load_note_revision_counts(app: tauri::AppHandle) -> Result<Vec<RevisionCountDto>, NoteCommandError> {
    let pool = pool_for(&app).await?;
    load_note_revision_counts_core(&pool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::note_files::NoteFileStore;

    struct TestFixture {
        _dir: tempfile::TempDir,
        pool: sqlx::SqlitePool,
        store: NoteFileStore,
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
            for migration in crate::migrations::migrations() {
                sqlx::raw_sql(migration.sql.as_ref()).execute(&pool).await.unwrap();
            }

            let store = NoteFileStore::new(dir.path().join("app-data"));
            store.initialize().unwrap();
            Self { _dir: dir, pool, store }
        }

        async fn insert_session(&self, id: &str) {
            sqlx::query("INSERT INTO sessions (id, task, status, updated_at) VALUES (?, 'Task', 'complete', 1000)")
                .bind(id)
                .execute(&self.pool)
                .await
                .unwrap();
        }

        async fn row_count(&self) -> i64 {
            sqlx::query_scalar("SELECT COUNT(*) FROM note_revisions").fetch_one(&self.pool).await.unwrap()
        }

        async fn fail_next_insert(&self) {
            sqlx::query(
                "CREATE TRIGGER fail_revision_insert
                 BEFORE INSERT ON note_revisions
                 BEGIN
                     SELECT RAISE(ABORT, 'forced insert failure');
                 END",
            )
            .execute(&self.pool)
            .await
            .unwrap();
        }

        async fn allow_inserts(&self) {
            sqlx::query("DROP TRIGGER fail_revision_insert").execute(&self.pool).await.unwrap();
        }
    }

    fn request(session_id: &str, content: &str) -> CreateRevisionRequest {
        CreateRevisionRequest {
            session_id: session_id.to_string(),
            content: content.to_string(),
            content_hash: sha256_hex(content.as_bytes()),
            kind: RevisionKind::Checkpoint,
            reason: RevisionReason::Manual,
            created_at: 1000,
        }
    }

    #[tokio::test]
    async fn creates_and_loads_a_revision() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let created = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(created.kind, RevisionKind::Checkpoint);
        assert_eq!(created.reason, RevisionReason::Manual);
        assert!(created.label.is_none());

        let loaded = load_note_revision_core(&fixture.pool, &fixture.store, &created.id).await.unwrap();
        assert_eq!(loaded.content, "hello");
        assert_eq!(loaded.revision.id, created.id);
    }

    #[tokio::test]
    async fn rejects_a_missing_owning_session() {
        let fixture = TestFixture::new().await;

        let result = create_note_revision_core(&fixture.pool, &fixture.store, request("missing-session", "hello")).await;
        assert!(result.is_err());
        assert_eq!(fixture.row_count().await, 0);
    }

    #[tokio::test]
    async fn blank_content_creates_no_revision() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let result = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "   \n\t "))
            .await
            .unwrap();
        assert!(result.is_none());
        assert_eq!(fixture.row_count().await, 0);
    }

    #[tokio::test]
    async fn rejects_an_invalid_kind_reason_pair() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let mut req = request("s1", "hello");
        req.kind = RevisionKind::Checkpoint;
        req.reason = RevisionReason::BeforeRestore;

        assert!(create_note_revision_core(&fixture.pool, &fixture.store, req).await.is_err());
        assert_eq!(fixture.row_count().await, 0);
    }

    #[tokio::test]
    async fn rejects_content_that_does_not_match_its_hash() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let mut req = request("s1", "hello");
        req.content_hash = sha256_hex(b"something else");

        assert!(create_note_revision_core(&fixture.pool, &fixture.store, req).await.is_err());
        assert_eq!(fixture.row_count().await, 0);
    }

    #[tokio::test]
    async fn duplicate_session_and_hash_returns_the_existing_revision() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let first = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();
        let second = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(fixture.row_count().await, 1);
    }

    #[tokio::test]
    async fn duplicate_row_with_missing_object_is_repaired() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let created = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();
        std::fs::remove_file(fixture.store.revisions_dir().join("s1").join(format!("{}.md", created.content_hash)))
            .unwrap();

        let again = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(again.id, created.id);
        let loaded = load_note_revision_core(&fixture.pool, &fixture.store, &again.id).await.unwrap();
        assert_eq!(loaded.content, "hello");
    }

    #[tokio::test]
    async fn duplicate_row_with_corrupt_object_blocks_the_operation() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let created = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();
        std::fs::write(
            fixture.store.revisions_dir().join("s1").join(format!("{}.md", created.content_hash)),
            b"tampered",
        )
        .unwrap();

        let result = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello")).await;
        assert!(result.is_err());
        assert_eq!(fixture.row_count().await, 1); // unchanged
    }

    #[tokio::test]
    async fn metadata_failure_after_object_creation_retries_idempotently() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;
        fixture.fail_next_insert().await;

        assert!(create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello")).await.is_err());
        assert_eq!(fixture.row_count().await, 0);

        fixture.allow_inserts().await;
        let retried = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fixture.row_count().await, 1);
        let loaded = load_note_revision_core(&fixture.pool, &fixture.store, &retried.id).await.unwrap();
        assert_eq!(loaded.content, "hello");
    }

    #[tokio::test]
    async fn listing_is_newest_first_with_rowid_tiebreak() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;

        let mut first = request("s1", "one");
        first.created_at = 1000;
        let mut second = request("s1", "two");
        second.created_at = 1000; // same timestamp as first
        let mut third = request("s1", "three");
        third.created_at = 500; // earlier timestamp, inserted last

        let r1 = create_note_revision_core(&fixture.pool, &fixture.store, first).await.unwrap().unwrap();
        let r2 = create_note_revision_core(&fixture.pool, &fixture.store, second).await.unwrap().unwrap();
        let r3 = create_note_revision_core(&fixture.pool, &fixture.store, third).await.unwrap().unwrap();

        let listed = list_note_revisions_core(&fixture.pool, "s1").await.unwrap();
        let ids: Vec<String> = listed.iter().map(|r| r.id.clone()).collect();
        // r1/r2 share the newest timestamp (1000) and sort by rowid desc
        // (insertion order reversed); r3's older timestamp sorts last.
        assert_eq!(ids, vec![r2.id, r1.id, r3.id]);
    }

    #[tokio::test]
    async fn rename_trims_normalizes_blank_to_null_and_enforces_the_limit() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;
        let created = create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "hello"))
            .await
            .unwrap()
            .unwrap();

        let renamed = rename_note_revision_core(&fixture.pool, &created.id, Some("  Launch draft  ".to_string()))
            .await
            .unwrap();
        assert_eq!(renamed.label.as_deref(), Some("Launch draft"));

        let cleared = rename_note_revision_core(&fixture.pool, &created.id, Some("   ".to_string())).await.unwrap();
        assert!(cleared.label.is_none());

        let ok_80 = rename_note_revision_core(&fixture.pool, &created.id, Some("x".repeat(80))).await;
        assert!(ok_80.is_ok());

        let rejected_81 = rename_note_revision_core(&fixture.pool, &created.id, Some("x".repeat(81))).await;
        assert!(rejected_81.is_err());
        // Failure keeps the prior (80-char) label rather than clearing it.
        let unchanged = load_note_revision_core(&fixture.pool, &fixture.store, &created.id).await.unwrap();
        assert_eq!(unchanged.revision.label, Some("x".repeat(80)));
    }

    #[tokio::test]
    async fn counts_do_not_read_any_snapshot_body() {
        let fixture = TestFixture::new().await;
        fixture.insert_session("s1").await;
        fixture.insert_session("s2").await;
        create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "one")).await.unwrap();
        create_note_revision_core(&fixture.pool, &fixture.store, request("s1", "two")).await.unwrap();
        create_note_revision_core(&fixture.pool, &fixture.store, request("s2", "three")).await.unwrap();

        let counts = load_note_revision_counts_core(&fixture.pool).await.unwrap();
        let s1_count = counts.iter().find(|c| c.session_id == "s1").unwrap().count;
        let s2_count = counts.iter().find(|c| c.session_id == "s2").unwrap().count;
        assert_eq!(s1_count, 2);
        assert_eq!(s2_count, 1);
    }
}
