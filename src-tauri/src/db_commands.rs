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

const DB_URL: &str = "sqlite:pomodoro.db";

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

/// Deletes one session by id and its note, atomically. Does not touch
/// parked_thoughts — thoughts still tagged with this session's id remain in
/// the active pool, since removing a historical record is a separate action
/// from discarding live, unresolved parked thoughts (see the JS-side
/// deleteSessionRow docs in tauriRepository.ts / memoryRepository.ts).
#[tauri::command]
pub async fn delete_session_with_note(app: AppHandle, id: String) -> Result<(), String> {
    let pool = sqlite_pool(&app).await?;
    delete_session_with_note_tx(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Wipes all sessions, all parked thoughts, and all notes, atomically.
/// Deliberately leaves `settings` untouched — a user preference like the
/// selected alarm tone isn't "data" in the sense this action means to clear.
#[tauri::command]
pub async fn delete_all_data(app: AppHandle) -> Result<(), String> {
    let pool = sqlite_pool(&app).await?;
    delete_all_data_tx(&pool).await.map_err(|e| e.to_string())
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
            "CREATE TABLE session_notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, content TEXT NOT NULL)",
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
}
