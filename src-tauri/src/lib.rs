mod db_commands;
mod migrations;
mod note_commands;
mod note_files;

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
    .setup(|app| {
      use tauri::Manager;
      let root = app.path().app_data_dir()?;
      let store = note_files::NoteFileStore::new(root);
      store
        .initialize()
        .map_err(|error| std::io::Error::other(format!("{error:?}")))?;
      app.manage(store);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      db_commands::delete_session_with_note,
      db_commands::delete_all_data,
      note_commands::initialize_note_storage,
      note_commands::save_session_note,
      note_commands::load_session_note,
      note_commands::load_all_session_notes,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
