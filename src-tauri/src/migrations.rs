use tauri_plugin_sql::{Migration, MigrationKind};

/// Phase 2 schema: minimal tables only (sessions, parked_thoughts, settings).
/// No notes, no revisions, no history/analytics tables yet — those are later
/// phases. `sessions.id` is the same id as `SessionState.sessionId` on the
/// frontend, so a row can be upserted directly by that id.
pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create sessions, parked_thoughts, settings tables",
        sql: r#"
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                task TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER,
                planned_duration_ms INTEGER,
                accumulated_pause_ms INTEGER,
                paused_at INTEGER,
                focus_completed_at INTEGER,
                flow_started_at INTEGER,
                flow_accumulated_pause_ms INTEGER,
                flow_paused_at INTEGER,
                break_started_at INTEGER,
                planned_focus_ms INTEGER,
                actual_focus_ms INTEGER,
                flow_ms INTEGER,
                took_break INTEGER,
                break_ms INTEGER,
                total_elapsed_ms INTEGER,
                completed_at INTEGER,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE parked_thoughts (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX idx_parked_thoughts_session_id ON parked_thoughts(session_id);

            -- Reserved for Phase 3 settings; no reads/writes yet.
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                type TEXT,
                updated_at INTEGER NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    }, Migration {
        version: 2,
        description: "create session_notes table",
        sql: r#"
            -- One note per session, enforced by the UNIQUE constraint.
            -- No FK to sessions.id: this schema doesn't use FK constraints
            -- anywhere (see parked_thoughts), so deletion is handled
            -- explicitly in the repository layer instead of via cascade.
            CREATE TABLE session_notes (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL UNIQUE,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        "#,
        kind: MigrationKind::Up,
    }, Migration {
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
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Applies every migration in order against a real temporary SQLite
    /// database and asserts version 3 lands with the expected schema shape:
    /// the legacy `content` column stays (Phase 4A rows still need it as a
    /// fallback until migrated), alongside the two new nullable columns.
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
            sqlx::raw_sql(migration.sql.as_ref()).execute(&pool).await.unwrap();
        }
        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('session_notes')")
            .fetch_all(&pool)
            .await
            .unwrap();

        assert!(columns.contains(&"content".to_string()));
        assert!(columns.contains(&"file_path".to_string()));
        assert!(columns.contains(&"content_hash".to_string()));
    }
}
