mod db_commands;
mod migrations;
mod note_commands;
mod note_files;
mod revision_commands;
mod revision_files;

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
      db_commands::delete_note_revision_history,
      note_commands::initialize_note_storage,
      note_commands::save_session_note,
      note_commands::resolve_external_conflict_keep,
      note_commands::resolve_external_conflict_reload,
      note_commands::restore_note_revision,
      note_commands::load_session_note,
      note_commands::load_all_session_notes,
      note_commands::open_notes_folder,
      revision_commands::create_note_revision,
      revision_commands::list_note_revisions,
      revision_commands::load_note_revision,
      revision_commands::rename_note_revision,
      revision_commands::load_note_revision_counts,
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

    /// Every revision command registered in `invoke_handler!` above must
    /// have its own narrowly-scoped allow permission granted in the main
    /// capability — no wildcard/default permission stands in for these.
    #[test]
    fn default_capability_grants_every_revision_command_permission() {
        let raw = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");
        let permissions: Vec<&str> = parsed["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .map(|value| value.as_str().expect("permission entry is a string"))
            .collect();

        for identifier in [
            "allow-create-note-revision",
            "allow-list-note-revisions",
            "allow-load-note-revision",
            "allow-rename-note-revision",
            "allow-load-note-revision-counts",
            "allow-resolve-external-conflict-keep",
            "allow-resolve-external-conflict-reload",
            "allow-restore-note-revision",
            "allow-delete-note-revision-history",
        ] {
            assert!(permissions.contains(&identifier), "missing {identifier} — the command would be denied");
        }
    }

    /// Each permission identifier asserted above must actually come from a
    /// `commands.allow` list in revision-commands.toml, not just happen to
    /// be a string present in default.json — catches a permission file
    /// that stops matching its own command name.
    #[test]
    fn revision_command_permissions_file_allows_the_expected_commands() {
        let raw = include_str!("../permissions/revision-commands.toml");
        for command in [
            "create_note_revision",
            "list_note_revisions",
            "load_note_revision",
            "rename_note_revision",
            "load_note_revision_counts",
            "resolve_external_conflict_keep",
            "resolve_external_conflict_reload",
            "restore_note_revision",
            "delete_note_revision_history",
        ] {
            assert!(
                raw.contains(&format!("\"{command}\"")),
                "revision-commands.toml does not appear to allow {command}"
            );
        }
    }
}
