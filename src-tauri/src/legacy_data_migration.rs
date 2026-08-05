// One-time recovery for the Pomodoro Parking Lot -> Heartwood rename
// (bundle identifier com.pomodoroparkinglot.app -> com.heartwood.app,
// commit 616b4ba): Tauri scopes app-data/app-config dirs by identifier, so
// that rename silently pointed every installer at a fresh, empty folder —
// a user upgrading from alpha.1 to alpha.2 saw their notes "disappear"
// even though the old folder was never touched.
//
// ponytail: hardcodes the one known old identifier rather than a list of
// past identifiers. If the app is ever renamed again, add the *new* old
// identifier here (or generalize to a Vec if a second rename actually
// happens) — YAGNI until then.
//
// Called once per identifier-scoped root (app_data_dir, app_config_dir)
// during setup(), before anything else reads or writes that root. Only
// acts when the new root doesn't exist yet, so it can never overwrite or
// merge into real Heartwood data.

use std::fs;
use std::io;
use std::path::Path;

const OLD_IDENTIFIER: &str = "com.pomodoroparkinglot.app";

/// If `new_root` doesn't exist yet and its sibling directory under the old
/// identifier does, copies the old directory's contents into `new_root`.
/// The old directory is left untouched as a fallback. A no-op in every
/// other case (new root already has data, or there's nothing to recover).
pub fn migrate_if_needed(new_root: &Path) -> io::Result<()> {
    if new_root.exists() {
        return Ok(());
    }
    let Some(parent) = new_root.parent() else { return Ok(()) };
    let old_root = parent.join(OLD_IDENTIFIER);
    if !old_root.is_dir() {
        return Ok(());
    }
    copy_dir_recursive(&old_root, new_root)
}

/// Skips symlinks rather than following them, matching NoteFileStore's own
/// symlink defense elsewhere in this codebase — a recovery copy has no
/// business escaping either directory tree.
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        } else if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dst_path)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn copies_old_identifier_dir_into_missing_new_root() {
        let parent = TempDir::new().unwrap();
        let old_root = parent.path().join(OLD_IDENTIFIER);
        fs::create_dir_all(old_root.join("notes")).unwrap();
        fs::write(old_root.join("pomodoro.db"), b"legacy data").unwrap();
        fs::write(old_root.join("notes/session-1.md"), b"# hello").unwrap();

        let new_root = parent.path().join("com.heartwood.app");
        migrate_if_needed(&new_root).unwrap();

        assert_eq!(fs::read(new_root.join("pomodoro.db")).unwrap(), b"legacy data");
        assert_eq!(fs::read(new_root.join("notes/session-1.md")).unwrap(), b"# hello");
        // Old data is left in place as a fallback, not moved.
        assert!(old_root.join("pomodoro.db").exists());
    }

    #[test]
    fn never_touches_an_existing_new_root() {
        let parent = TempDir::new().unwrap();
        let old_root = parent.path().join(OLD_IDENTIFIER);
        fs::create_dir_all(&old_root).unwrap();
        fs::write(old_root.join("pomodoro.db"), b"legacy data").unwrap();

        let new_root = parent.path().join("com.heartwood.app");
        fs::create_dir_all(&new_root).unwrap();
        fs::write(new_root.join("pomodoro.db"), b"real heartwood data").unwrap();

        migrate_if_needed(&new_root).unwrap();

        assert_eq!(fs::read(new_root.join("pomodoro.db")).unwrap(), b"real heartwood data");
    }

    #[test]
    fn no_op_when_no_legacy_directory_exists() {
        let parent = TempDir::new().unwrap();
        let new_root = parent.path().join("com.heartwood.app");

        migrate_if_needed(&new_root).unwrap();

        assert!(!new_root.exists());
    }
}
