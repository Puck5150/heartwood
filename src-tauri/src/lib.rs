mod db_commands;
mod migrations;
mod note_commands;
mod note_files;

const DB_URL: &str = "sqlite:pomodoro.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  // Registered before every other plugin: enforces a single running
  // desktop process, so exactly one process ever owns the shared FIFO
  // write queue and the app-data mutation boundary. A second launch shows
  // and focuses the existing main window instead of creating a second
  // persistence owner.
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      use tauri::Manager;
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
      }
    }));
  }

  builder
    .plugin(
      tauri_plugin_sql::Builder::default()
        .add_migrations(DB_URL, migrations::migrations())
        .build(),
    )
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
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
      note_commands::open_notes_folder,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(test)]
mod capability_permissions {
    // MarkdownPreview.svelte calls the opener plugin's `openUrl()`, which
    // needs its *command* enabled (`opener:allow-open-url`) in addition to
    // the URL *scope* granted by `opener:allow-default-urls` — the scope
    // alone silently denies every openUrl() call, since it doesn't enable
    // the command itself. This guards against that permission regressing
    // back out of the capability file.
    #[test]
    fn default_capability_grants_open_url_command_and_scope() {
        let raw = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");
        let permissions: Vec<&str> = parsed["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .map(|value| value.as_str().expect("permission entry is a string"))
            .collect();

        assert!(
            permissions.contains(&"opener:allow-open-url"),
            "missing opener:allow-open-url — openUrl() calls would be denied"
        );
        assert!(
            permissions.contains(&"opener:allow-default-urls"),
            "missing opener:allow-default-urls — the mailto/tel/http/https scope would be denied"
        );
    }
}
