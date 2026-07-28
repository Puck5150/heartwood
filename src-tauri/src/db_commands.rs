// Native Tauri commands for the two deletes that must be atomic: removing a
// session together with its note, and wiping all data. tauri-plugin-sql's JS
// `execute()` only ever runs one query per pool checkout, and while a single
// call *can* carry a `BEGIN; ...; COMMIT;` multi-statement string on one
// connection, there is no way from JS to guarantee a matching ROLLBACK runs
// on that same connection if a statement in the middle fails — a later,
// separate `db.execute('ROLLBACK')` could be handed a different pooled
// connection entirely, leaving the first one stuck mid-transaction when it's
// returned to the pool. A real `sqlx::Transaction` fixes this at the type
// level: it holds one connection for its whole lifetime, and its `Drop` impl
// issues the rollback automatically if `commit()` was never reached —
// including on every early return via `?` below — so there is no code path
// that can leave a half-applied delete or a dangling open transaction.

use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::note_commands::NoteCommandError;
use crate::note_files::NoteFileStore;

const DB_URL: &str = "sqlite:pomodoro.db";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub cleanup_pending: bool,
}

fn transient(error: sqlx::Error) -> NoteCommandError {
    NoteCommandError::Transient { message: error.to_string() }
}

async fn note_path_for_session(pool: &sqlx::SqlitePool, id: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT file_path FROM session_notes WHERE session_id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map(|row| row.flatten())
}

pub(crate) async fn sqlite_pool(app: &AppHandle) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let lock = instances.0.read().await;
    let pool = lock
        .get(DB_URL)
        .ok_or_else(|| "database not loaded".to_string())?;
    match pool {
        DbPool::Sqlite(pool) => Ok(pool.clone()), // Pool<Sqlite> is a cheap Arc-backed handle
        #[allow(unreachable_patterns)]
        _ => Err("expected a sqlite database pool".to_string()),
    }
}

/// Core transaction logic, independent of Tauri's `AppHandle`, so it can be
/// exercised directly against a real `sqlx::SqlitePool` in tests below
/// without spinning up a full Tauri app context.
async fn delete_session_with_note_tx(pool: &sqlx::SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM session_notes WHERE session_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await
}

/// Core transaction logic for wiping all data — see
/// `delete_session_with_note_tx`'s doc for why this is split out from the
/// `#[tauri::command]` wrapper below.
async fn delete_all_data_tx(pool: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM parked_thoughts").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM session_notes").execute(&mut *tx).await?;

    tx.commit().await
}

/// Deletes one session by id, its note row, and its note *file* together.
/// SQLite and the filesystem can't share one atomic transaction, so this
/// stages the note file (a same-volume rename into `note-trash/`) *before*
/// the SQL transaction runs: if the transaction fails, the staged file is
/// restored and nothing is lost; if it commits, the staged file is
/// finalized (permanently discarded). A finalize failure after a committed
/// transaction is reported via `cleanup_pending` rather than treated as
/// overall failure — the data deletion the user asked for did commit;
/// only the leftover file cleanup needs a retry (which startup recovery
/// performs automatically).
pub(crate) async fn delete_session_with_note_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
    id: &str,
) -> Result<DeleteOutcome, NoteCommandError> {
    let path = note_path_for_session(pool, id).await.map_err(transient)?;
    let stage = store.stage_paths(&path.into_iter().collect::<Vec<_>>())?;
    match delete_session_with_note_tx(pool, id).await {
        Ok(()) => {
            let cleanup_pending = store.finalize_stage(&stage).is_err();
            Ok(DeleteOutcome { cleanup_pending })
        }
        Err(error) => {
            store.restore_stage(&stage)?;
            Err(transient(error))
        }
    }
}

/// Wipes all sessions, parked thoughts, and notes — both rows and files —
/// atomically for the database side, with the same stage-before/finalize-
/// or-restore-after pattern as `delete_session_with_note_core`.
pub(crate) async fn delete_all_data_core(
    pool: &sqlx::SqlitePool,
    store: &NoteFileStore,
) -> Result<DeleteOutcome, NoteCommandError> {
    let stage = store.stage_all_notes()?;
    match delete_all_data_tx(pool).await {
        Ok(()) => {
            let cleanup_pending = store.finalize_stage(&stage).is_err();
            Ok(DeleteOutcome { cleanup_pending })
        }
        Err(error) => {
            store.restore_stage(&stage)?;
            Err(transient(error))
        }
    }
}

/// Deletes one session by id and its note, atomically. Does not touch
/// parked_thoughts — thoughts still tagged with this session's id remain in
/// the active pool, since removing a historical record is a separate action
/// from discarding live, unresolved parked thoughts (see the JS-side
/// deleteSessionRow docs in tauriRepository.ts / memoryRepository.ts).
#[tauri::command]
pub async fn delete_session_with_note(
    app: AppHandle,
    store: tauri::State<'_, NoteFileStore>,
    id: String,
) -> Result<DeleteOutcome, NoteCommandError> {
    let pool = sqlite_pool(&app).await.map_err(|message| NoteCommandError::Transient { message })?;
    delete_session_with_note_core(&pool, &store, &id).await
}

/// Wipes all sessions, all parked thoughts, and all notes, atomically.
/// Deliberately leaves `settings` untouched — a user preference like the
/// selected alarm tone isn't "data" in the sense this action means to clear.
#[tauri::command]
pub async fn delete_all_data(
    app: AppHandle,
    store: tauri::State<'_, NoteFileStore>,
) -> Result<DeleteOutcome, NoteCommandError> {
    let pool = sqlite_pool(&app).await.map_err(|message| NoteCommandError::Transient { message })?;
    delete_all_data_core(&pool, &store).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    /// A real, file-backed SQLite database with a real multi-connection
    /// pool (not `:memory:`, which is private per-connection and would
    /// silently defeat a pool with more than one connection) — as close to
    /// the production `sqlite:pomodoro.db` setup as a test can get.
    async fn test_pool() -> (tempfile::TempDir, sqlx::SqlitePool) {
        let dir = tempfile::tempdir().expect("create temp dir");
        let db_path = dir.path().join("test.db");
        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .expect("connect to test database");

        sqlx::query("CREATE TABLE sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create sessions table");
        sqlx::query(
            "CREATE TABLE session_notes (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                content TEXT NOT NULL,
                file_path TEXT,
                content_hash TEXT
            )",
        )
        .execute(&pool)
        .await
        .expect("create session_notes table");
        sqlx::query("CREATE TABLE parked_thoughts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL)")
            .execute(&pool)
            .await
            .expect("create parked_thoughts table");

        (dir, pool)
    }

    async fn row_count(pool: &sqlx::SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(pool)
            .await
            .expect("count rows")
    }

    #[tokio::test]
    async fn deletes_a_session_and_its_note_together() {
        let (_dir, pool) = test_pool().await;
        sqlx::query("INSERT INTO sessions (id, task, status) VALUES ('s1', 'Task', 'complete')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO session_notes (id, session_id, content) VALUES ('n1', 's1', 'hi')")
            .execute(&pool)
            .await
            .unwrap();

        delete_session_with_note_tx(&pool, "s1").await.expect("delete succeeds");

        assert_eq!(row_count(&pool, "sessions").await, 0);
        assert_eq!(row_count(&pool, "session_notes").await, 0);
    }

    #[tokio::test]
    async fn delete_all_data_clears_every_table_together() {
        let (_dir, pool) = test_pool().await;
        sqlx::query("INSERT INTO sessions (id, task, status) VALUES ('s1', 'Task', 'complete')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO session_notes (id, session_id, content) VALUES ('n1', 's1', 'hi')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO parked_thoughts (id, session_id, text) VALUES ('t1', 's1', 'thought')")
            .execute(&pool)
            .await
            .unwrap();

        delete_all_data_tx(&pool).await.expect("delete-all succeeds");

        assert_eq!(row_count(&pool, "sessions").await, 0);
        assert_eq!(row_count(&pool, "session_notes").await, 0);
        assert_eq!(row_count(&pool, "parked_thoughts").await, 0);
    }

    /// The fault-injection test the review round asked for: force the
    /// *second* statement in a real transaction to fail after the first has
    /// already run against the same connection, and prove the whole
    /// transaction rolled back — the row the first statement deleted is
    /// still there — and that the database is still writable afterward,
    /// i.e. no connection was left stuck mid-transaction by the failure.
    #[tokio::test]
    async fn a_failure_after_the_first_delete_rolls_back_everything_and_leaves_the_db_writable() {
        let (_dir, pool) = test_pool().await;
        sqlx::query("INSERT INTO sessions (id, task, status) VALUES ('s1', 'Task', 'complete')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO session_notes (id, session_id, content) VALUES ('n1', 's1', 'hi')")
            .execute(&pool)
            .await
            .unwrap();

        // Drop the table the *second* statement targets, so
        // delete_session_with_note_tx's first DELETE (on `sessions`)
        // succeeds inside the transaction, then its second DELETE (on
        // `session_notes`) fails outright with "no such table".
        sqlx::query("DROP TABLE session_notes").execute(&pool).await.unwrap();

        let result = delete_session_with_note_tx(&pool, "s1").await;
        assert!(result.is_err(), "expected the second statement to fail");

        // The row the first statement (successfully, in isolation) deleted
        // must still be there: the transaction as a whole rolled back, not
        // just the half that errored.
        assert_eq!(
            row_count(&pool, "sessions").await,
            1,
            "the session row must survive the rolled-back transaction"
        );

        // The database must remain writable afterward — proof no
        // connection was left stuck inside an uncommitted transaction.
        sqlx::query(
            "CREATE TABLE session_notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .expect("database must remain writable after the rolled-back transaction");
        sqlx::query("INSERT INTO session_notes (id, session_id, content) VALUES ('n2', 's1', 'still writable')")
            .execute(&pool)
            .await
            .expect("must still be able to write after the rollback");
    }

    struct FileBackedDeleteFixture {
        _dir: tempfile::TempDir,
        pool: sqlx::SqlitePool,
        store: NoteFileStore,
    }

    impl FileBackedDeleteFixture {
        async fn new() -> Self {
            let dir = tempfile::tempdir().expect("create fixture root");
            let db_path = dir.path().join("delete.db");
            let pool = SqlitePoolOptions::new()
                .max_connections(5)
                .connect_with(SqliteConnectOptions::new().filename(&db_path).create_if_missing(true))
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

        async fn insert_session_note(&self, session_id: &str, file_path: &str, content: &str) {
            let stored = self.store.compare_and_write(file_path, content, None, false).unwrap();
            sqlx::query("INSERT INTO sessions (id, task, status) VALUES (?, 'Task', 'complete')")
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

    #[tokio::test]
    async fn deleting_a_session_commits_the_rows_then_removes_its_file() {
        let fixture = FileBackedDeleteFixture::new().await;
        fixture.insert_session_note("s1", "s1.md", "content").await;

        let outcome = delete_session_with_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap();

        assert!(!outcome.cleanup_pending);
        assert_eq!(row_count(&fixture.pool, "sessions").await, 0);
        assert_eq!(row_count(&fixture.pool, "session_notes").await, 0);
        assert!(matches!(fixture.store.read("s1.md"), Err(crate::note_files::NoteFileError::Missing { .. })));
    }

    #[tokio::test]
    async fn deleting_one_session_does_not_touch_an_unrelated_note() {
        let fixture = FileBackedDeleteFixture::new().await;
        fixture.insert_session_note("s1", "s1.md", "one").await;
        fixture.insert_session_note("s2", "s2.md", "two").await;

        delete_session_with_note_core(&fixture.pool, &fixture.store, "s1").await.unwrap();

        assert!(matches!(fixture.store.read("s1.md"), Err(crate::note_files::NoteFileError::Missing { .. })));
        assert_eq!(fixture.store.read("s2.md").unwrap().content, "two");
        assert_eq!(row_count(&fixture.pool, "sessions").await, 1);
        assert_eq!(row_count(&fixture.pool, "session_notes").await, 1);
    }

    #[tokio::test]
    async fn failed_sql_transaction_restores_the_staged_file() {
        let fixture = FileBackedDeleteFixture::new().await;
        fixture.insert_session_note("s1", "s1.md", "content").await;
        fixture.fail_note_delete().await;

        assert!(delete_session_with_note_core(&fixture.pool, &fixture.store, "s1").await.is_err());
        assert_eq!(fixture.store.read("s1.md").unwrap().content, "content");
        assert_eq!(row_count(&fixture.pool, "sessions").await, 1);
    }

    #[tokio::test]
    async fn delete_all_clears_rows_and_every_note_file() {
        let fixture = FileBackedDeleteFixture::new().await;
        fixture.insert_session_note("s1", "s1.md", "one").await;
        fixture.insert_session_note("s2", "s2.md", "two").await;
        sqlx::query("INSERT INTO parked_thoughts (id, session_id, text) VALUES ('t1', 's1', 'thought')")
            .execute(&fixture.pool)
            .await
            .unwrap();

        let outcome = delete_all_data_core(&fixture.pool, &fixture.store).await.unwrap();

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
        fixture.store.stage_paths(&["s1.md".to_string()]).unwrap();

        crate::note_commands::recover_staged_deletions_core(&fixture.pool, &fixture.store).await.unwrap();

        assert_eq!(fixture.store.read("s1.md").unwrap().content, "content");
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn startup_finishes_a_staged_delete_when_metadata_is_gone() {
        let fixture = FileBackedDeleteFixture::new().await;
        fixture.insert_session_note("s1", "s1.md", "content").await;
        fixture.store.stage_paths(&["s1.md".to_string()]).unwrap();
        sqlx::query("DELETE FROM session_notes WHERE session_id = 's1'").execute(&fixture.pool).await.unwrap();

        crate::note_commands::recover_staged_deletions_core(&fixture.pool, &fixture.store).await.unwrap();

        assert!(matches!(fixture.store.read("s1.md"), Err(crate::note_files::NoteFileError::Missing { .. })));
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn startup_refuses_to_guess_when_original_and_stage_both_conflict_with_metadata() {
        let fixture = FileBackedDeleteFixture::new().await;
        fixture.insert_session_note("s1", "s1.md", "expected").await;
        fixture.store.stage_paths(&["s1.md".to_string()]).unwrap();
        fixture.store.compare_and_write("s1.md", "unexpected", None, true).unwrap();

        let result = crate::note_commands::recover_staged_deletions_core(&fixture.pool, &fixture.store).await;
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

        crate::note_commands::recover_staged_deletions_core(&fixture.pool, &fixture.store).await.unwrap();

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
        sqlx::query("DELETE FROM session_notes").execute(&fixture.pool).await.unwrap();
        sqlx::query("DELETE FROM sessions").execute(&fixture.pool).await.unwrap();

        crate::note_commands::recover_staged_deletions_core(&fixture.pool, &fixture.store).await.unwrap();

        assert!(matches!(fixture.store.read("s1.md"), Err(crate::note_files::NoteFileError::Missing { .. })));
        assert!(matches!(fixture.store.read("s2.md"), Err(crate::note_files::NoteFileError::Missing { .. })));
        assert!(fixture.store.staged_entries().unwrap().is_empty());
    }
}
