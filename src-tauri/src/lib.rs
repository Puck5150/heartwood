mod db_commands;
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
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      db_commands::delete_session_with_note,
      db_commands::delete_all_data,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
