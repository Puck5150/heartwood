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
    }]
}
