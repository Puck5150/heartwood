// Pure filesystem boundary for Phase 4B's Markdown note files. Owns
// resolving the app-data/notes/note-trash directories, generating and
// validating relative note paths, reading files, hashing content, atomic
// compare-and-write, and staged deletion/restore/recovery. The frontend and
// note_commands.rs never supply or operate on an arbitrary absolute path —
// every relative path passed in here is confined beneath the canonical
// notes directory before any read or write happens.

use std::fs;
use std::path::{Component, Path, PathBuf};

use uuid::Uuid;

pub struct NoteFileStore {
    app_data_root: PathBuf,
    notes_dir: PathBuf,
    trash_dir: PathBuf,
    revisions_dir: PathBuf,
    operations_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct StoredFile {
    pub content: String,
    pub content_hash: String,
}

pub struct StagedDeletion {
    /// `None` means a no-op stage (e.g. `stage_paths` given only already-
    /// absent files) — restoring or finalizing it is a trivial success.
    operation_dir: Option<PathBuf>,
}

impl StagedDeletion {
    /// Builds the `StagedEntry` for `relative_path` within this staged
    /// operation, so callers that staged exactly one known path (the
    /// before-clear/external-conflict safety flows) can read/restore/
    /// finalize it individually via the same symlink-safe helpers
    /// `staged_entries()` produces. `None` for a no-op stage (nothing
    /// existed to stage in the first place) — callers must treat that as
    /// "there was never a file to snapshot", not retry with a bare path.
    pub(crate) fn entry_for(&self, relative_path: &str) -> Option<StagedEntry> {
        let operation_id = self.operation_dir.as_ref()?.file_name()?.to_str()?.to_string();
        Some(StagedEntry { operation_id, relative_path: relative_path.to_string() })
    }
}

#[derive(Clone, Debug)]
pub struct StagedEntry {
    pub operation_id: String,
    pub relative_path: String,
}

#[derive(Debug)]
pub enum NoteFileError {
    Conflict { disk_content: String, disk_hash: String },
    Missing { relative_path: String },
    Unreadable { relative_path: String },
    InvalidPath,
    Io(String),
}

pub(crate) fn io_err(error: std::io::Error) -> NoteFileError {
    NoteFileError::Io(error.to_string())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// Splits a task string into a deterministic, cross-platform-safe slug:
/// ASCII letters/digits only, runs of anything else collapsed to a single
/// hyphen, leading/trailing hyphens trimmed, capped at 48 characters, and
/// `session` when nothing usable survives (e.g. a purely non-ASCII task).
fn slugify(task: &str) -> String {
    let mut slug = String::new();
    let mut last_was_hyphen = true; // suppresses a leading hyphen
    for ch in task.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_hyphen = false;
        } else if !last_was_hyphen {
            slug.push('-');
            last_was_hyphen = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.len() > 48 {
        slug.truncate(48);
        while slug.ends_with('-') {
            slug.pop();
        }
    }
    if slug.is_empty() {
        "session".to_string()
    } else {
        slug
    }
}

/// Production session IDs are full UUIDs; this validation is deliberately a
/// little broader (non-empty ASCII alphanumeric/hyphen) so small test IDs
/// stay usable without weakening path safety — no `.`, `/`, or other
/// character that could influence path resolution is ever accepted.
pub(crate) fn validate_session_id(session_id: &str) -> Result<(), NoteFileError> {
    if session_id.is_empty()
        || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(NoteFileError::InvalidPath);
    }
    Ok(())
}

/// Rejects an absolute path and requires exactly one plain `Normal`
/// component — the only shape a stored relative path may ever take is a
/// flat filename directly inside `notes_dir`, since Phase 4B never nests
/// notes in subdirectories. Requiring exactly one component (rather than
/// just rejecting `..`/root, which would still allow multi-segment
/// `Normal` paths like `a/b.md`) also closes off an intermediate-symlink
/// escape: `resolve_within_notes` only checks whether the *final* path
/// component is a symlink, but the OS still transparently follows any
/// symlinked *intermediate* directory component while resolving the rest
/// of the path — with nesting disallowed outright, there's no intermediate
/// component for such a symlink to occupy.
pub(crate) fn validate_relative_path_str(relative_path: &str) -> Result<(), NoteFileError> {
    if relative_path.is_empty() {
        return Err(NoteFileError::InvalidPath);
    }
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err(NoteFileError::InvalidPath);
    }
    let mut components = path.components();
    match components.next() {
        Some(Component::Normal(_)) => {}
        _ => return Err(NoteFileError::InvalidPath),
    }
    if components.next().is_some() {
        return Err(NoteFileError::InvalidPath);
    }
    Ok(())
}

/// Production operation ids are `Uuid::new_v4().to_string()`; this
/// validation is deliberately a little broader (non-empty ASCII
/// alphanumeric/hyphen), matching `validate_session_id`, so small test ids
/// stay usable without weakening path safety.
pub(crate) fn validate_operation_id(operation_id: &str) -> Result<(), NoteFileError> {
    if operation_id.is_empty()
        || !operation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(NoteFileError::InvalidPath);
    }
    Ok(())
}

/// Confirms `joined` (built by joining `root` with caller-validated path
/// segments) stays beneath `root` even if some existing ancestor along the
/// way is a symlink the OS would otherwise transparently follow — an
/// operation directory, the trash root, or the notes root itself. `root`
/// is rejected outright if it's currently a symlink. If `joined` already
/// exists, both it and `root` are canonicalized and the result must start
/// with `root`'s canonical form: canonicalize() resolves every
/// intermediate symlink in the *entire* chain, not just the final
/// component, so this also catches a symlinked final entry (a staged file
/// or note itself) the same way. A path that doesn't exist yet (e.g. a
/// fresh operation directory about to be created) has nothing further to
/// canonicalize — `root` having just been checked directly is as far as
/// that case can be verified before creating it.
pub(crate) fn resolve_within(root: &Path, joined: PathBuf) -> Result<PathBuf, NoteFileError> {
    if matches!(fs::symlink_metadata(root), Ok(metadata) if metadata.file_type().is_symlink()) {
        return Err(NoteFileError::InvalidPath);
    }
    match fs::symlink_metadata(&joined) {
        Ok(_) => {
            let canonical_root = fs::canonicalize(root).map_err(io_err)?;
            match fs::canonicalize(&joined) {
                Ok(resolved) if resolved.starts_with(&canonical_root) => Ok(joined),
                _ => Err(NoteFileError::InvalidPath),
            }
        }
        Err(_) => Ok(joined),
    }
}

/// Uses `symlink_metadata` rather than `exists()` (which follows symlinks)
/// — a symlinked `dir` is rejected outright rather than silently treated
/// as empty or non-empty based on whatever it happens to resolve to.
fn is_dir_empty(dir: &Path) -> Result<bool, NoteFileError> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(NoteFileError::InvalidPath);
            }
            Ok(fs::read_dir(dir).map_err(io_err)?.next().is_none())
        }
        Err(_) => Ok(true),
    }
}

/// Writes `bytes` to a temp file beside `path`, runs `before_commit` (a
/// test/fault-injection hook in production this is always `Ok(())`), and
/// only then atomically renames the temp file over `path`. A failure at
/// any point before `commit()` — including from the hook — leaves whatever
/// was previously at `path` completely untouched.
fn atomic_replace_with_hook<F>(path: &Path, bytes: &[u8], before_commit: F) -> Result<(), NoteFileError>
where
    F: FnOnce() -> Result<(), NoteFileError>,
{
    use atomic_write_file::AtomicWriteFile;
    use std::io::Write;

    let mut file = AtomicWriteFile::options()
        .open(path)
        .map_err(|error| NoteFileError::Io(error.to_string()))?;
    file.write_all(bytes)
        .map_err(|error| NoteFileError::Io(error.to_string()))?;
    before_commit()?;
    file.commit().map_err(|error| NoteFileError::Io(error.to_string()))
}

pub(crate) fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), NoteFileError> {
    atomic_replace_with_hook(path, bytes, || Ok(()))
}

impl NoteFileStore {
    pub fn new(app_data_root: PathBuf) -> Self {
        let notes_dir = app_data_root.join("notes");
        let trash_dir = app_data_root.join("note-trash");
        let revisions_dir = app_data_root.join("note-revisions");
        let operations_dir = app_data_root.join("note-operations");
        Self { app_data_root, notes_dir, trash_dir, revisions_dir, operations_dir }
    }

    pub fn notes_dir(&self) -> &Path {
        &self.notes_dir
    }

    pub(crate) fn trash_dir(&self) -> &Path {
        &self.trash_dir
    }

    pub(crate) fn revisions_dir(&self) -> &Path {
        &self.revisions_dir
    }

    pub(crate) fn operations_dir(&self) -> &Path {
        &self.operations_dir
    }

    /// Creates `notes/`, `note-trash/`, `note-revisions/`, and
    /// `note-operations/` beneath app data if missing, and rejects any of
    /// them when it already exists as a symlink — even one that happens to
    /// resolve somewhere still nested under app data. Idempotent: safe to
    /// call on every launch.
    pub fn initialize(&self) -> Result<(), NoteFileError> {
        fs::create_dir_all(&self.app_data_root).map_err(io_err)?;
        self.ensure_real_dir(&self.notes_dir)?;
        self.ensure_real_dir(&self.trash_dir)?;
        self.ensure_real_dir(&self.revisions_dir)?;
        self.ensure_real_dir(&self.operations_dir)?;
        Ok(())
    }

    fn ensure_real_dir(&self, dir: &Path) -> Result<(), NoteFileError> {
        match fs::symlink_metadata(dir) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(NoteFileError::InvalidPath);
                }
                Ok(())
            }
            Err(_) => fs::create_dir_all(dir).map_err(io_err),
        }
    }

    pub fn note_relative_path(
        &self,
        session_id: &str,
        task: &str,
        local_date: &str,
    ) -> Result<String, NoteFileError> {
        validate_session_id(session_id)?;
        let date = chrono::NaiveDate::parse_from_str(local_date, "%Y-%m-%d")
            .map_err(|_| NoteFileError::InvalidPath)?;
        let slug = slugify(task);
        Ok(format!("{}--{slug}--{session_id}.md", date.format("%Y-%m-%d")))
    }

    /// Resolves `relative_path` to an absolute path beneath `notes_dir`,
    /// rejecting traversal/absolute inputs outright and — via
    /// `resolve_within` — a symlinked `notes_dir` itself or an existing
    /// candidate that canonicalizes somewhere else. A dangling symlink
    /// (whose target doesn't exist) can't be verified and is rejected
    /// rather than risking a write through it.
    fn resolve_within_notes(&self, relative_path: &str) -> Result<PathBuf, NoteFileError> {
        validate_relative_path_str(relative_path)?;
        resolve_within(&self.notes_dir, self.notes_dir.join(relative_path))
    }

    fn read_at(&self, path: &Path, relative_path: &str) -> Result<StoredFile, NoteFileError> {
        let bytes = fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                NoteFileError::Missing { relative_path: relative_path.to_string() }
            } else {
                NoteFileError::Io(error.to_string())
            }
        })?;
        let content = String::from_utf8(bytes)
            .map_err(|_| NoteFileError::Unreadable { relative_path: relative_path.to_string() })?;
        let content_hash = sha256_hex(content.as_bytes());
        Ok(StoredFile { content, content_hash })
    }

    pub fn read(&self, relative_path: &str) -> Result<StoredFile, NoteFileError> {
        let path = self.resolve_within_notes(relative_path)?;
        self.read_at(&path, relative_path)
    }

    /// Compare-and-write with the exact conflict/idempotency ordering
    /// Phase 4B relies on: a stale expected hash against different disk
    /// content is a Conflict (never silently overwritten); a desired write
    /// that already matches what's on disk is a no-op success (makes a
    /// metadata-update retry after a successful file write idempotent).
    pub fn compare_and_write(
        &self,
        relative_path: &str,
        content: &str,
        expected_hash: Option<&str>,
        force: bool,
    ) -> Result<StoredFile, NoteFileError> {
        let path = self.resolve_within_notes(relative_path)?;
        let desired_hash = sha256_hex(content.as_bytes());
        match self.read_at(&path, relative_path) {
            Ok(current) => {
                let expected_matches = expected_hash == Some(current.content_hash.as_str());
                let desired_already_landed = desired_hash == current.content_hash;
                if !force && !expected_matches && !desired_already_landed {
                    return Err(NoteFileError::Conflict {
                        disk_content: current.content,
                        disk_hash: current.content_hash,
                    });
                }
                if desired_already_landed {
                    return Ok(current);
                }
            }
            Err(NoteFileError::Missing { .. }) => {
                if expected_hash.is_some() && !force {
                    return Err(NoteFileError::Missing { relative_path: relative_path.to_string() });
                }
            }
            Err(error) => return Err(error),
        }
        atomic_replace(&path, content.as_bytes())?;
        Ok(StoredFile { content: content.to_string(), content_hash: desired_hash })
    }

    /// Stages the given relative paths (deduplicated; a genuinely absent
    /// one is silently skipped) into a fresh `note-trash/<operation-id>/`
    /// directory. Returns a no-op `StagedDeletion` if nothing existed to
    /// stage — restoring or finalizing it succeeds trivially.
    pub fn stage_paths(&self, paths: &[String]) -> Result<StagedDeletion, NoteFileError> {
        let mut unique: Vec<&str> = Vec::new();
        for path in paths {
            if !unique.contains(&path.as_str()) {
                unique.push(path.as_str());
            }
        }

        let mut to_stage: Vec<(String, PathBuf)> = Vec::new();
        for relative in unique {
            let resolved = self.resolve_within_notes(relative)?;
            if resolved.exists() {
                to_stage.push((relative.to_string(), resolved));
            }
        }
        if to_stage.is_empty() {
            return Ok(StagedDeletion { operation_dir: None });
        }

        let operation_dir = resolve_within(&self.trash_dir, self.trash_dir.join(Uuid::new_v4().to_string()))?;
        let staged_notes_dir = operation_dir.join("notes");
        fs::create_dir_all(&staged_notes_dir).map_err(io_err)?;
        for (relative, resolved) in to_stage {
            let target = staged_notes_dir.join(&relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(io_err)?;
            }
            fs::rename(&resolved, &target).map_err(io_err)?;
        }
        Ok(StagedDeletion { operation_dir: Some(operation_dir) })
    }

    /// Renames every staged file back to its original relative location,
    /// then removes the now-empty operation directory. Refuses to
    /// overwrite a same-named file that appeared at the target after
    /// staging — that file is left as-is and the staged copy is left in
    /// place too, for startup recovery to resolve explicitly.
    pub fn restore_stage(&self, stage: &StagedDeletion) -> Result<(), NoteFileError> {
        let Some(operation_dir) = &stage.operation_dir else {
            return Ok(());
        };
        let operation_dir = resolve_within(&self.trash_dir, operation_dir.clone())?;
        let staged_notes_root = operation_dir.join("notes");
        self.restore_tree(&staged_notes_root, &staged_notes_root)?;
        if is_dir_empty(&staged_notes_root)? {
            let _ = fs::remove_dir(&staged_notes_root);
            let _ = fs::remove_dir(&operation_dir);
        }
        Ok(())
    }

    /// Walks a staged tree and renames each file back to its original
    /// relative location. Rejects — rather than follows or recursively
    /// inspects — a symlinked `dir` itself (checked via `symlink_metadata`,
    /// not `exists()`, which follows symlinks): this is what closes off a
    /// `note-trash/<operation-id>/notes` directory that's actually a
    /// symlink to somewhere outside app data, both for the top-level call
    /// from `restore_stage` and every recursive one. Notes are always
    /// flat, so a symlinked entry found *within* a legitimate directory is
    /// rejected the same way, and every restore destination is resolved
    /// through `resolve_within_notes` rather than a bare join, so a
    /// pre-existing symlink at the destination is caught too.
    fn restore_tree(&self, dir: &Path, staged_root: &Path) -> Result<(), NoteFileError> {
        match fs::symlink_metadata(dir) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(NoteFileError::InvalidPath);
                }
            }
            Err(_) => return Ok(()),
        }
        for entry in fs::read_dir(dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_err)?;
            if metadata.file_type().is_symlink() {
                return Err(NoteFileError::InvalidPath);
            }
            if metadata.is_dir() {
                self.restore_tree(&path, staged_root)?;
                continue;
            }
            let relative = path
                .strip_prefix(staged_root)
                .map_err(|_| NoteFileError::Io("staged entry outside its own operation root".to_string()))?;
            let relative_str = relative.to_string_lossy().replace('\\', "/");
            let target = self.resolve_within_notes(&relative_str)?;
            if target.exists() {
                return Err(NoteFileError::Io(format!(
                    "cannot restore {}: a file already exists at that location",
                    relative.display()
                )));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(io_err)?;
            }
            fs::rename(&path, &target).map_err(io_err)?;
        }
        Ok(())
    }

    /// Removes the staged operation directory entirely, permanently
    /// discarding the file(s) it holds.
    pub fn finalize_stage(&self, stage: &StagedDeletion) -> Result<(), NoteFileError> {
        let Some(operation_dir) = &stage.operation_dir else {
            return Ok(());
        };
        let operation_dir = resolve_within(&self.trash_dir, operation_dir.clone())?;
        fs::remove_dir_all(&operation_dir).map_err(io_err)
    }

    /// Recursively lists every file staged under `note-trash/`, across
    /// every operation directory — including files captured wholesale by
    /// `stage_all_notes`. Used by startup recovery, which has no in-memory
    /// `StagedDeletion` from a process that may have already exited, so
    /// this walk is the only source of truth for what's actually staged —
    /// a symlinked "operation directory" (or one whose name doesn't look
    /// like a real operation id) is skipped outright rather than followed,
    /// since nothing here can vouch for where it actually leads.
    pub fn staged_entries(&self) -> Result<Vec<StagedEntry>, NoteFileError> {
        let mut result = Vec::new();
        if !self.trash_dir.exists() {
            return Ok(result);
        }
        if matches!(fs::symlink_metadata(&self.trash_dir), Ok(metadata) if metadata.file_type().is_symlink())
        {
            return Err(NoteFileError::InvalidPath);
        }
        for operation_entry in fs::read_dir(&self.trash_dir).map_err(io_err)? {
            let operation_entry = operation_entry.map_err(io_err)?;
            let operation_path = operation_entry.path();
            let metadata = fs::symlink_metadata(&operation_path).map_err(io_err)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let operation_id = operation_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string();
            if validate_operation_id(&operation_id).is_err() {
                continue;
            }
            // A `manifest.json` here means this operation directory
            // belongs to the newer, typed staged-data system (session,
            // revision-history, and delete-all deletion — see
            // revision_files.rs's `staged_data_manifests()`), which owns
            // its own recovery. The two passes partition `note-trash/` by
            // this distinction rather than ever double-processing the
            // same operation directory.
            if operation_path.join("manifest.json").exists() {
                continue;
            }
            let staged_notes_dir = operation_path.join("notes");
            // symlink_metadata rather than is_dir(), which follows
            // symlinks — a symlinked `notes` child (even under a
            // legitimately-named, non-symlinked operation directory) is
            // skipped outright rather than enumerated, since it could
            // otherwise transparently redirect this walk to list files
            // from anywhere on disk.
            match fs::symlink_metadata(&staged_notes_dir) {
                Ok(metadata) if metadata.file_type().is_symlink() => continue,
                Ok(metadata) if metadata.is_dir() => {
                    self.collect_staged_files(&staged_notes_dir, &staged_notes_dir, &operation_id, &mut result)?;
                }
                _ => {}
            }
        }
        Ok(result)
    }

    /// Never follows a symlinked entry (file or subdirectory) — notes are
    /// always flat, so a symlinked "subdirectory" has no legitimate reason
    /// to exist here and is skipped rather than walked into. A relative
    /// path that doesn't reduce to a single flat filename (e.g. a
    /// genuinely nested file) is skipped the same way rather than trusted.
    fn collect_staged_files(
        &self,
        dir: &Path,
        root: &Path,
        operation_id: &str,
        out: &mut Vec<StagedEntry>,
    ) -> Result<(), NoteFileError> {
        for entry in fs::read_dir(dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_err)?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                self.collect_staged_files(&path, root, operation_id, out)?;
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| NoteFileError::Io("staged entry outside its own operation root".to_string()))?;
            let relative_path = relative.to_string_lossy().replace('\\', "/");
            if validate_relative_path_str(&relative_path).is_err() {
                continue;
            }
            out.push(StagedEntry { operation_id: operation_id.to_string(), relative_path });
        }
        Ok(())
    }

    /// Validates `entry`'s operation id and relative path *before* joining
    /// them into a path at all, then confirms the joined path — via
    /// `resolve_within` — stays beneath the canonical trash directory even
    /// through a symlinked operation directory or a symlinked entry itself.
    fn staged_entry_path(&self, entry: &StagedEntry) -> Result<PathBuf, NoteFileError> {
        validate_operation_id(&entry.operation_id)?;
        validate_relative_path_str(&entry.relative_path)?;
        let joined = self.trash_dir.join(&entry.operation_id).join("notes").join(&entry.relative_path);
        resolve_within(&self.trash_dir, joined)
    }

    pub fn read_staged(&self, entry: &StagedEntry) -> Result<StoredFile, NoteFileError> {
        let path = self.staged_entry_path(entry)?;
        let bytes = fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                NoteFileError::Missing { relative_path: entry.relative_path.clone() }
            } else {
                NoteFileError::Io(error.to_string())
            }
        })?;
        let content = String::from_utf8(bytes)
            .map_err(|_| NoteFileError::Unreadable { relative_path: entry.relative_path.clone() })?;
        let content_hash = sha256_hex(content.as_bytes());
        Ok(StoredFile { content, content_hash })
    }

    pub fn restore_staged_entry(&self, entry: &StagedEntry) -> Result<(), NoteFileError> {
        let staged_path = self.staged_entry_path(entry)?;
        let target = self.resolve_within_notes(&entry.relative_path)?;
        if target.exists() {
            return Err(NoteFileError::Io(format!(
                "cannot restore {}: a file already exists at that location",
                entry.relative_path
            )));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(io_err)?;
        }
        fs::rename(&staged_path, &target).map_err(io_err)?;
        self.cleanup_empty_operation_dir(&entry.operation_id)
    }

    pub fn finalize_staged_entry(&self, entry: &StagedEntry) -> Result<(), NoteFileError> {
        let staged_path = self.staged_entry_path(entry)?;
        if staged_path.exists() {
            fs::remove_file(&staged_path).map_err(io_err)?;
        }
        self.cleanup_empty_operation_dir(&entry.operation_id)
    }

    fn cleanup_empty_operation_dir(&self, operation_id: &str) -> Result<(), NoteFileError> {
        validate_operation_id(operation_id)?;
        let operation_dir = resolve_within(&self.trash_dir, self.trash_dir.join(operation_id))?;
        let staged_notes_dir = operation_dir.join("notes");
        if is_dir_empty(&staged_notes_dir)? {
            let _ = fs::remove_dir(&staged_notes_dir);
            let _ = fs::remove_dir(&operation_dir);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (tempfile::TempDir, NoteFileStore) {
        let dir = tempfile::tempdir().expect("create temp app-data root");
        let store = NoteFileStore::new(dir.path().to_path_buf());
        (dir, store)
    }

    fn initialized_store() -> (tempfile::TempDir, NoteFileStore) {
        let (dir, store) = test_store();
        store.initialize().expect("initialize note directories");
        (dir, store)
    }

    #[test]
    fn filename_is_readable_stable_and_collision_safe() {
        let (_dir, store) = test_store();
        let path = store
            .note_relative_path(
                "123e4567-e89b-12d3-a456-426614174000",
                "  Project: Outline / Review  ",
                "2026-07-28",
            )
            .unwrap();

        assert_eq!(
            path,
            "2026-07-28--project-outline-review--123e4567-e89b-12d3-a456-426614174000.md"
        );
    }

    #[test]
    fn unsupported_task_text_uses_session_slug() {
        let (_dir, store) = test_store();
        let path = store
            .note_relative_path("123e4567-e89b-12d3-a456-426614174000", "日本語", "2026-07-28")
            .unwrap();
        assert!(path.contains("--session--"));
    }

    #[test]
    fn slug_is_capped_and_identifiers_are_validated() {
        let (_dir, store) = test_store();
        let id = "123e4567-e89b-12d3-a456-426614174000";
        let path = store.note_relative_path(id, &"A".repeat(80), "2026-07-28").unwrap();
        assert_eq!(path, format!("2026-07-28--{}--{id}.md", "a".repeat(48)));
        assert!(matches!(
            store.note_relative_path("../../escape", "Task", "2026-07-28"),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(
            store.note_relative_path(id, "Task", "../bad-date"),
            Err(NoteFileError::InvalidPath)
        ));
    }

    #[test]
    fn exact_utf8_bytes_round_trip_without_normalization() {
        let (_dir, store) = test_store();
        store.initialize().unwrap();
        let content = "line one\r\nline two\nCafé";
        let saved = store.compare_and_write("note.md", content, None, false).unwrap();
        let loaded = store.read("note.md").unwrap();

        assert_eq!(loaded.content.as_bytes(), content.as_bytes());
        assert_eq!(loaded.content_hash, saved.content_hash);
    }

    #[test]
    fn stale_expected_hash_returns_the_disk_version_without_overwriting() {
        let (_dir, store) = test_store();
        store.initialize().unwrap();
        let first = store.compare_and_write("note.md", "first", None, false).unwrap();
        let external = store
            .compare_and_write("note.md", "external", Some(&first.content_hash), true)
            .unwrap();

        let error = store
            .compare_and_write("note.md", "local draft", Some(&first.content_hash), false)
            .unwrap_err();

        assert!(matches!(
            error,
            NoteFileError::Conflict { disk_content, disk_hash }
                if disk_content == "external" && disk_hash == external.content_hash
        ));
        assert_eq!(store.read("note.md").unwrap().content, "external");
    }

    #[test]
    fn matching_desired_content_is_an_idempotent_success_after_metadata_failure() {
        let (_dir, store) = test_store();
        store.initialize().unwrap();
        let first = store.compare_and_write("note.md", "first", None, false).unwrap();
        let desired = store
            .compare_and_write("note.md", "desired", Some(&first.content_hash), false)
            .unwrap();

        let retried = store
            .compare_and_write("note.md", "desired", Some(&first.content_hash), false)
            .unwrap();
        assert_eq!(retried.content_hash, desired.content_hash);
    }

    #[test]
    fn failure_before_atomic_commit_preserves_the_previous_file() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("note.md", "committed", None, false).unwrap();
        let path = store.notes_dir().join("note.md");

        let result = atomic_replace_with_hook(&path, b"replacement", || {
            Err(NoteFileError::Io("forced pre-commit failure".to_string()))
        });

        assert!(result.is_err());
        assert_eq!(store.read("note.md").unwrap().content, "committed");
    }

    #[test]
    fn stage_restore_and_finalize_preserve_then_remove_exact_bytes() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("a.md", "alpha\r\nCafé", None, false).unwrap();

        let stage = store.stage_paths(&["a.md".to_string()]).unwrap();
        assert!(matches!(store.read("a.md"), Err(NoteFileError::Missing { .. })));

        store.restore_stage(&stage).unwrap();
        assert_eq!(store.read("a.md").unwrap().content, "alpha\r\nCafé");

        let stage = store.stage_paths(&["a.md".to_string()]).unwrap();
        store.finalize_stage(&stage).unwrap();
        assert!(matches!(store.read("a.md"), Err(NoteFileError::Missing { .. })));
        assert!(store.staged_entries().unwrap().is_empty());
    }

    #[test]
    fn restore_stage_preserves_both_copies_when_the_live_path_is_recreated() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("a.md", "original", None, false).unwrap();

        let stage = store.stage_paths(&["a.md".to_string()]).unwrap();
        // Something else (an external editor, a fresh save) recreates the
        // live path while the original bytes are staged — the exact race
        // before-clear and external-conflict safety must tolerate.
        store.compare_and_write("a.md", "recreated externally", None, false).unwrap();

        assert!(store.restore_stage(&stage).is_err());

        // Both copies survive: the recreated live file untouched, and the
        // originally staged bytes still readable (never silently dropped).
        assert_eq!(store.read("a.md").unwrap().content, "recreated externally");
        let entries = store.staged_entries().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(store.read_staged(&entries[0]).unwrap().content, "original");
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        let (_dir, store) = initialized_store();
        assert!(matches!(
            store.compare_and_write("../outside.md", "x", None, false),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(
            store.compare_and_write("/tmp/outside.md", "x", None, false),
            Err(NoteFileError::InvalidPath)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_resolving_outside_the_notes_root_is_rejected() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside.md");
        std::fs::write(&outside, b"private").unwrap();
        symlink(&outside, store.notes_dir().join("linked.md")).unwrap();

        assert!(matches!(store.read("linked.md"), Err(NoteFileError::InvalidPath)));

        let dangling = dir.path().join("missing-outside.md");
        symlink(&dangling, store.notes_dir().join("dangling.md")).unwrap();
        assert!(matches!(
            store.compare_and_write("dangling.md", "private", None, false),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(!dangling.exists());
    }

    #[cfg(unix)]
    #[test]
    fn initialize_rejects_a_notes_root_symlinked_outside_app_data() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        std::fs::remove_dir(store.notes_dir()).unwrap();
        let outside = dir.path().join("outside-notes");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, store.notes_dir()).unwrap();

        assert!(matches!(store.initialize(), Err(NoteFileError::InvalidPath)));
    }

    #[test]
    fn nested_relative_paths_are_rejected_even_without_a_symlink() {
        let (_dir, store) = initialized_store();
        assert!(matches!(store.read("subdir/file.md"), Err(NoteFileError::InvalidPath)));
        assert!(matches!(
            store.compare_and_write("subdir/file.md", "x", None, false),
            Err(NoteFileError::InvalidPath)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn nested_relative_paths_are_rejected_through_a_symlinked_intermediate_directory() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-dir");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("file.md"), b"private").unwrap();
        symlink(&outside, store.notes_dir().join("subdir")).unwrap();

        assert!(matches!(store.read("subdir/file.md"), Err(NoteFileError::InvalidPath)));
        assert!(matches!(
            store.compare_and_write("subdir/file.md", "replacement", None, false),
            Err(NoteFileError::InvalidPath)
        ));
        assert_eq!(std::fs::read(outside.join("file.md")).unwrap(), b"private");
    }

    #[cfg(unix)]
    #[test]
    fn staged_entries_skips_a_symlinked_operation_directory() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-op");
        std::fs::create_dir(&outside).unwrap();
        std::fs::create_dir(outside.join("notes")).unwrap();
        std::fs::write(outside.join("notes").join("secret.md"), b"private").unwrap();
        symlink(&outside, store.trash_dir.join("fake-op")).unwrap();

        // A genuine staged file should still be found alongside the
        // symlinked entry, which must be skipped rather than followed.
        store.compare_and_write("a.md", "alpha", None, false).unwrap();
        store.stage_paths(&["a.md".to_string()]).unwrap();

        let entries = store.staged_entries().unwrap();
        assert!(entries.iter().all(|entry| entry.operation_id != "fake-op"));
        assert_eq!(entries.len(), 1);
        assert_eq!(std::fs::read(outside.join("notes").join("secret.md")).unwrap(), b"private");
    }

    #[cfg(unix)]
    #[test]
    fn read_restore_and_finalize_reject_a_symlinked_staged_entry() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-file.md");
        std::fs::write(&outside, b"private").unwrap();
        let op_dir = store.trash_dir.join("11111111-1111-1111-1111-111111111111");
        std::fs::create_dir_all(op_dir.join("notes")).unwrap();
        symlink(&outside, op_dir.join("notes").join("linked.md")).unwrap();

        let entry = StagedEntry {
            operation_id: "11111111-1111-1111-1111-111111111111".to_string(),
            relative_path: "linked.md".to_string(),
        };

        assert!(matches!(store.read_staged(&entry), Err(NoteFileError::InvalidPath)));
        assert!(matches!(store.restore_staged_entry(&entry), Err(NoteFileError::InvalidPath)));
        assert!(matches!(store.finalize_staged_entry(&entry), Err(NoteFileError::InvalidPath)));
        assert_eq!(std::fs::read(&outside).unwrap(), b"private");
        assert!(!store.notes_dir().join("linked.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn finalize_and_restore_stage_reject_a_symlinked_operation_directory() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-op");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keepme.md"), b"private").unwrap();
        let linked_op_dir = store.trash_dir.join("22222222-2222-2222-2222-222222222222");
        symlink(&outside, &linked_op_dir).unwrap();
        let stage = StagedDeletion { operation_dir: Some(linked_op_dir) };

        assert!(matches!(store.finalize_stage(&stage), Err(NoteFileError::InvalidPath)));
        assert!(matches!(store.restore_stage(&stage), Err(NoteFileError::InvalidPath)));
        assert!(outside.exists());
        assert_eq!(std::fs::read(outside.join("keepme.md")).unwrap(), b"private");
    }

    #[test]
    fn staged_entry_operations_reject_an_invalid_operation_id_or_relative_path() {
        let (_dir, store) = initialized_store();
        let traversal_id = StagedEntry { operation_id: "../escape".to_string(), relative_path: "a.md".to_string() };
        let traversal_relative =
            StagedEntry { operation_id: "op-1".to_string(), relative_path: "../escape.md".to_string() };

        assert!(matches!(store.read_staged(&traversal_id), Err(NoteFileError::InvalidPath)));
        assert!(matches!(store.read_staged(&traversal_relative), Err(NoteFileError::InvalidPath)));
        assert!(matches!(store.restore_staged_entry(&traversal_id), Err(NoteFileError::InvalidPath)));
        assert!(matches!(store.finalize_staged_entry(&traversal_id), Err(NoteFileError::InvalidPath)));
    }

    #[cfg(unix)]
    #[test]
    fn trash_operations_reject_a_symlinked_trash_root() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        store.compare_and_write("a.md", "alpha", None, false).unwrap();
        std::fs::remove_dir(&store.trash_dir).unwrap();
        let outside = dir.path().join("outside-trash");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, &store.trash_dir).unwrap();

        assert!(matches!(store.staged_entries(), Err(NoteFileError::InvalidPath)));
        assert!(matches!(
            store.stage_paths(&["a.md".to_string()]),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none()); // nothing written through the symlink
    }

    #[cfg(unix)]
    #[test]
    fn staged_entries_and_restore_stage_reject_a_notes_child_symlinked_outside_app_data() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-notes-child");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), b"private").unwrap();

        // A real, validly-named operation directory (not itself a
        // symlink) whose *notes* child is the symlink — the specific gap
        // `is_dir()`/`exists()` (which follow symlinks) would miss.
        let op_id = "33333333-3333-3333-3333-333333333333";
        let op_dir = store.trash_dir.join(op_id);
        std::fs::create_dir_all(&op_dir).unwrap();
        symlink(&outside, op_dir.join("notes")).unwrap();

        let entries = store.staged_entries().unwrap();
        assert!(entries.iter().all(|entry| entry.operation_id != op_id));

        let stage = StagedDeletion { operation_dir: Some(op_dir) };
        assert!(matches!(store.restore_stage(&stage), Err(NoteFileError::InvalidPath)));

        assert_eq!(std::fs::read(outside.join("secret.md")).unwrap(), b"private");
        assert!(!store.notes_dir().join("secret.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn notes_root_replaced_by_a_symlink_after_initialization_is_rejected() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        store.compare_and_write("a.md", "alpha", None, false).unwrap();

        std::fs::remove_dir_all(store.notes_dir()).unwrap();
        let outside = dir.path().join("outside-notes-root");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), b"private").unwrap();
        symlink(&outside, store.notes_dir()).unwrap();

        assert!(matches!(store.read("secret.md"), Err(NoteFileError::InvalidPath)));
        assert!(matches!(
            store.compare_and_write("secret.md", "x", None, false),
            Err(NoteFileError::InvalidPath)
        ));
        assert_eq!(std::fs::read(outside.join("secret.md")).unwrap(), b"private");
    }

    #[test]
    fn missing_and_non_utf8_files_have_distinct_errors() {
        let (_dir, store) = initialized_store();
        assert!(matches!(store.read("missing.md"), Err(NoteFileError::Missing { .. })));

        std::fs::write(store.notes_dir().join("binary.md"), [0xff, 0xfe]).unwrap();
        assert!(matches!(store.read("binary.md"), Err(NoteFileError::Unreadable { .. })));
        assert!(matches!(
            store.compare_and_write("binary.md", "replacement", None, false),
            Err(NoteFileError::Unreadable { .. })
        ));
    }
}
