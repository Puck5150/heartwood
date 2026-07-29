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
    }, Migration {
        version: 4,
        description: "create note_revisions table",
        sql: r#"
            -- Metadata only: no note/revision content and no path ever lives
            -- in SQLite. The path is derived from validated session_id and
            -- content_hash by revision_files.rs. UNIQUE(session_id,
            -- content_hash) is the session-scoped content-addressed
            -- deduplication key; the combined CHECK enforces the exact
            -- kind/reason pairing Rust and TypeScript also enforce.
            CREATE TABLE note_revisions (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (
                    kind IN ('automatic', 'checkpoint', 'safety')
                ),
                reason TEXT NOT NULL CHECK (
                    reason IN (
                        'session_started',
                        'session_completed',
                        'review_finalized',
                        'manual',
                        'before_clear',
                        'before_restore',
                        'before_external_overwrite',
                        'before_external_reload'
                    )
                ),
                label TEXT CHECK (label IS NULL OR length(label) <= 80),
                created_at INTEGER NOT NULL,
                UNIQUE(session_id, content_hash),
                CHECK (
                    (kind = 'automatic' AND reason IN (
                        'session_started', 'session_completed', 'review_finalized'
                    ))
                    OR (kind = 'checkpoint' AND reason = 'manual')
                    OR (kind = 'safety' AND reason IN (
                        'before_clear',
                        'before_restore',
                        'before_external_overwrite',
                        'before_external_reload'
                    ))
                )
            );

            CREATE INDEX idx_note_revisions_session_created
                ON note_revisions(session_id, created_at DESC);
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

    async fn migrated_pool() -> sqlx::SqlitePool {
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
        // Keep the temp dir alive for the pool's lifetime by leaking it —
        // these are short-lived test-only connections to a fresh file each
        // time, not a resource anything else depends on.
        std::mem::forget(dir);
        pool
    }

    async fn insert_session(pool: &sqlx::SqlitePool, id: &str) {
        sqlx::query("INSERT INTO sessions (id, task, status, updated_at) VALUES (?, ?, 'complete', 1000)")
            .bind(id)
            .bind("Task")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn version_four_creates_the_expected_table_and_index() {
        let pool = migrated_pool().await;

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('note_revisions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        for expected in ["id", "session_id", "content_hash", "kind", "reason", "label", "created_at"] {
            assert!(columns.contains(&expected.to_string()), "missing column {expected}");
        }

        let indexes: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_index_list('note_revisions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(indexes.contains(&"idx_note_revisions_session_created".to_string()));

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM note_revisions").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn note_revisions_rejects_an_unknown_kind_or_reason() {
        let pool = migrated_pool().await;
        insert_session(&pool, "s1").await;

        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES ('r1', 's1', 'h1', 'bogus', 'manual', 1000)",
        )
        .execute(&pool)
        .await
        .is_err());

        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES ('r1', 's1', 'h1', 'checkpoint', 'bogus', 1000)",
        )
        .execute(&pool)
        .await
        .is_err());
    }

    #[tokio::test]
    async fn note_revisions_rejects_a_mismatched_kind_reason_pair() {
        let pool = migrated_pool().await;
        insert_session(&pool, "s1").await;

        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES ('r1', 's1', 'h1', 'checkpoint', 'before_restore', 1000)",
        )
        .execute(&pool)
        .await
        .is_err());

        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES ('r1', 's1', 'h1', 'automatic', 'manual', 1000)",
        )
        .execute(&pool)
        .await
        .is_err());
    }

    #[tokio::test]
    async fn note_revisions_enforces_the_eighty_character_label_limit() {
        let pool = migrated_pool().await;
        insert_session(&pool, "s1").await;

        let label_80 = "x".repeat(80);
        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, label, created_at)
             VALUES ('r1', 's1', 'h1', 'checkpoint', 'manual', ?, 1000)",
        )
        .bind(&label_80)
        .execute(&pool)
        .await
        .is_ok());

        let label_81 = "x".repeat(81);
        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, label, created_at)
             VALUES ('r2', 's1', 'h2', 'checkpoint', 'manual', ?, 1000)",
        )
        .bind(&label_81)
        .execute(&pool)
        .await
        .is_err());
    }

    #[tokio::test]
    async fn note_revisions_enforces_unique_session_and_content_hash() {
        let pool = migrated_pool().await;
        insert_session(&pool, "s1").await;

        sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES ('r1', 's1', 'h1', 'checkpoint', 'manual', 1000)",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(sqlx::query(
            "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
             VALUES ('r2', 's1', 'h1', 'checkpoint', 'manual', 2000)",
        )
        .execute(&pool)
        .await
        .is_err());
    }

    #[tokio::test]
    async fn listing_order_uses_rowid_as_a_tiebreaker_for_equal_timestamps() {
        let pool = migrated_pool().await;
        insert_session(&pool, "s1").await;

        for id in ["r1", "r2", "r3"] {
            sqlx::query(
                "INSERT INTO note_revisions (id, session_id, content_hash, kind, reason, created_at)
                 VALUES (?, 's1', ?, 'checkpoint', 'manual', 1000)",
            )
            .bind(id)
            .bind(format!("hash-{id}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM note_revisions WHERE session_id = 's1' ORDER BY created_at DESC, rowid DESC",
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        // Same timestamp for all three — insertion order (rowid) must break
        // the tie, newest insertion first.
        assert_eq!(ids, vec!["r3", "r2", "r1"]);
    }
}
