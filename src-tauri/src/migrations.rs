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
    }, Migration {
        version: 5,
        description: "persist current focus cycle deadline",
        sql: "ALTER TABLE sessions ADD COLUMN focus_deadline_at INTEGER;",
        kind: MigrationKind::Up,
    }, Migration {
        version: 6,
        description: "track completed-session review acknowledgement",
        sql: "ALTER TABLE sessions ADD COLUMN review_acknowledged_at INTEGER;",
        kind: MigrationKind::Up,
    }, Migration {
        version: 7,
        description: "persist resumable intermissions",
        sql: r#"
            ALTER TABLE sessions ADD COLUMN intermission_kind TEXT;
            ALTER TABLE sessions ADD COLUMN intermission_started_at INTEGER;
            ALTER TABLE sessions ADD COLUMN intermission_deadline_at INTEGER;
            ALTER TABLE sessions ADD COLUMN intermission_return_status TEXT;
            ALTER TABLE sessions ADD COLUMN break_intermission_ms INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE sessions ADD COLUMN touch_grass_ms INTEGER NOT NULL DEFAULT 0;
        "#,
        kind: MigrationKind::Up,
    }, Migration {
        version: 8,
        description: "allow sessionless parked thoughts and per-thought notes",
        sql: r#"
            CREATE TABLE parked_thoughts_new (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                text TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                note TEXT
            );
            INSERT INTO parked_thoughts_new (id, session_id, text, created_at)
                SELECT id, session_id, text, created_at FROM parked_thoughts;
            DROP TABLE parked_thoughts;
            ALTER TABLE parked_thoughts_new RENAME TO parked_thoughts;
            CREATE INDEX idx_parked_thoughts_session_id ON parked_thoughts(session_id);
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
    async fn version_eight_drops_session_id_not_null_and_adds_note() {
        let pool = migrated_pool().await;

        let columns: Vec<(String, i64)> =
            sqlx::query_as("SELECT name, \"notnull\" FROM pragma_table_info('parked_thoughts')")
                .fetch_all(&pool)
                .await
                .unwrap();

        let session_id = columns.iter().find(|(name, _)| name == "session_id").unwrap();
        assert_eq!(session_id.1, 0, "session_id must no longer be NOT NULL");

        assert!(columns.iter().any(|(name, _)| name == "note"), "note column must exist");

        let indexes: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_index_list('parked_thoughts')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(
            indexes.iter().any(|name| name.contains("session_id") || name == "idx_parked_thoughts_session_id"),
            "the session_id index must survive the table recreate: {indexes:?}",
        );
    }

    #[tokio::test]
    async fn version_eight_preserves_existing_rows() {
        let pool = migrated_pool().await;
        sqlx::query(
            "INSERT INTO parked_thoughts (id, session_id, text, created_at) VALUES ('t1', 'session-1', 'Old thought', 1000)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let (text,): (String,) = sqlx::query_as("SELECT text FROM parked_thoughts WHERE id = 't1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(text, "Old thought");
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
    async fn version_five_adds_a_nullable_focus_deadline_column() {
        let pool = migrated_pool().await;

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(columns.contains(&"focus_deadline_at".to_string()));

        // A legacy-looking row (inserted before version 5 conceptually
        // existed — no focus_deadline_at value supplied) survives with a
        // null deadline rather than failing the insert.
        insert_session(&pool, "legacy-1").await;
        let deadline: Option<i64> =
            sqlx::query_scalar("SELECT focus_deadline_at FROM sessions WHERE id = 'legacy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(deadline, None);
    }

    #[tokio::test]
    async fn version_six_adds_a_nullable_review_acknowledged_column() {
        let pool = migrated_pool().await;

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(columns.contains(&"review_acknowledged_at".to_string()));

        // A pre-existing completed row (no acknowledgement recorded yet)
        // survives with a null value rather than failing the insert.
        insert_session(&pool, "legacy-1").await;
        let acknowledged_at: Option<i64> =
            sqlx::query_scalar("SELECT review_acknowledged_at FROM sessions WHERE id = 'legacy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(acknowledged_at, None);

        sqlx::query("UPDATE sessions SET review_acknowledged_at = 2000 WHERE id = 'legacy-1'")
            .execute(&pool)
            .await
            .unwrap();
        let acknowledged_at: Option<i64> =
            sqlx::query_scalar("SELECT review_acknowledged_at FROM sessions WHERE id = 'legacy-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(acknowledged_at, Some(2000));
    }

    #[tokio::test]
    async fn version_seven_adds_intermission_state_and_zeroed_totals() {
        let pool = migrated_pool().await;

        let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions')")
            .fetch_all(&pool)
            .await
            .unwrap();
        for expected in [
            "intermission_kind",
            "intermission_started_at",
            "intermission_deadline_at",
            "intermission_return_status",
            "break_intermission_ms",
            "touch_grass_ms",
        ] {
            assert!(columns.contains(&expected.to_string()), "missing column {expected}");
        }

        insert_session(&pool, "legacy-1").await;
        let totals: (i64, i64) = sqlx::query_as(
            "SELECT break_intermission_ms, touch_grass_ms FROM sessions WHERE id = 'legacy-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(totals, (0, 0));
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
