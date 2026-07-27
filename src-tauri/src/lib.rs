mod migrations;

const DB_URL: &str = "sqlite:pomodoro.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations(DB_URL, migrations::migrations())
        .build(),
    )
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
