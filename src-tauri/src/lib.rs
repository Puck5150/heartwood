mod db_commands;
mod legacy_data_migration;
mod migrations;
mod note_commands;
mod note_files;
mod revision_commands;
mod revision_files;

const DB_URL: &str = "sqlite:pomodoro.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Only reassigned under `#[cfg(desktop)]` below — genuinely unused on mobile.
  #[allow(unused_mut)]
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

  // Android's install plugin is only a dependency on that target (see
  // Cargo.toml's target-cfg block) — referencing it unconditionally would
  // fail to compile on desktop.
  #[cfg(target_os = "android")]
  {
    builder = builder.plugin(tauri_plugin_android_installer::init());
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
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_upload::init())
    .setup(|app| {
      use tauri::Manager;
      let root = app.path().app_data_dir()?;
      let config_root = app.path().app_config_dir()?;
      // Must run before anything else touches either root: the sqlite
      // plugin creates config_root lazily on first DB access, and
      // NoteFileStore::initialize() creates `root` right below.
      legacy_data_migration::migrate_if_needed(&root)
        .map_err(|error| std::io::Error::other(format!("legacy app-data migration: {error:?}")))?;
      if config_root != root {
        legacy_data_migration::migrate_if_needed(&config_root).map_err(|error| {
          std::io::Error::other(format!("legacy app-config migration: {error:?}"))
        })?;
      }
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
    // A capability's `permissions` array holds either a plain identifier
    // string or an object (`{"identifier": ..., "allow": [...]}`) for a
    // permission that also carries a scope — every test in this module
    // needs the identifier either way.
    fn permission_identifiers<'a>(parsed: &'a serde_json::Value, key: &str) -> Vec<&'a str> {
        parsed[key]
            .as_array()
            .expect("permissions array")
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .or_else(|| value["identifier"].as_str())
                    .expect("permission entry is a string or has an `identifier` field")
            })
            .collect()
    }

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
        let permissions = permission_identifiers(&parsed, "permissions");

        assert!(
            permissions.contains(&"opener:allow-open-url"),
            "missing opener:allow-open-url — openUrl() calls would be denied"
        );
        assert!(
            permissions.contains(&"opener:allow-default-urls"),
            "missing opener:allow-default-urls — the mailto/tel/http/https scope would be denied"
        );
    }

    /// Best-effort focus-warning/completion notifications need this
    /// grant, or every send silently fails behind an unrelated-looking
    /// permission-denied error. Guards against it regressing back out.
    #[test]
    fn default_capability_grants_notification_permission() {
        let raw = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");
        let permissions = permission_identifiers(&parsed, "permissions");

        assert!(
            permissions.contains(&"notification:default"),
            "missing notification:default — ensurePermission()/notifyWarning()/notifyCompletion() would be denied"
        );
    }

    /// App.svelte's isAndroidPlatform check (which picks the Android vs.
    /// desktop update-check implementation) needs this on every platform,
    /// unlike android-installer below — os:init() itself is registered
    /// unconditionally in lib.rs, so this belongs in the universal
    /// default.json, not the android-only capability file.
    #[test]
    fn default_capability_grants_os_permission() {
        let raw = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");
        let permissions = permission_identifiers(&parsed, "permissions");

        assert!(
            permissions.contains(&"os:default"),
            "missing os:default — platform() would be denied, breaking Android-vs-desktop update detection"
        );
    }

    /// androidUpdate.ts's download step needs this: plugin-upload's
    /// `download()` streams the response straight to disk on the Rust
    /// side (never bringing the ~140MB APK into JS memory at all), unlike
    /// the plugin-http/fetch approach tried first, which broke partway
    /// through large binary transfers ("Invalid array length" from the
    /// JS<->Rust IPC bridge reassembling chunks). Without this grant the
    /// download command is silently denied and the update controller's
    /// own `.catch()` swallows the error with no visible cause.
    #[test]
    fn default_capability_grants_upload_permission() {
        let raw = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");
        let permissions = permission_identifiers(&parsed, "permissions");

        assert!(
            permissions.contains(&"upload:default"),
            "missing upload:default — the Android update download's download() would be denied"
        );
    }

    /// android-installer's commands only exist on the Android target (see
    /// Cargo.toml's target-cfg block) — granting this in the universal
    /// default.json would fail capability validation on desktop, so it
    /// lives in a separate, platform-scoped capability file instead.
    #[test]
    fn android_capability_grants_android_installer_permission_and_is_platform_scoped() {
        let raw = include_str!("../capabilities/android.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");

        let permissions = permission_identifiers(&parsed, "permissions");
        assert!(
            permissions.contains(&"android-installer:default"),
            "missing android-installer:default — canInstall/requestInstallPermission/install would be denied"
        );

        let platforms: Vec<&str> = parsed["platforms"]
            .as_array()
            .expect("platforms array — without it this capability would also apply to desktop")
            .iter()
            .map(|value| value.as_str().expect("platform entry is a string"))
            .collect();
        assert_eq!(
            platforms,
            vec!["android"],
            "android-installer:default must stay scoped to platforms: [\"android\"]"
        );
    }

    /// Every revision command registered in `invoke_handler!` above must
    /// have its own narrowly-scoped allow permission granted in the main
    /// capability — no wildcard/default permission stands in for these.
    #[test]
    fn default_capability_grants_every_revision_command_permission() {
        let raw = include_str!("../capabilities/default.json");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("valid capability JSON");
        let permissions = permission_identifiers(&parsed, "permissions");

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
