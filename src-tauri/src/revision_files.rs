// Immutable, per-session content-addressed revision snapshot objects.
// Extends NoteFileStore (defined in note_files.rs) with ownership of
// `note-revisions/<session-id>/<sha256>.md`. Every path is derived from a
// validated session id and a validated lowercase 64-character hex SHA-256
// filename — the frontend and revision_commands.rs never supply or operate
// on an arbitrary absolute path.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::note_files::{
    atomic_replace, io_err, resolve_within, sha256_hex, validate_operation_id, validate_relative_path_str,
    validate_session_id, NoteFileError, NoteFileStore,
};

/// Bumped only if the manifest's on-disk shape ever needs to change in a
/// way `#[serde(deny_unknown_fields)]` wouldn't handle gracefully — nothing
/// currently reads this beyond storing/round-tripping it.
pub(crate) const RESTORE_MANIFEST_VERSION: u8 = 1;

/// Records a note revision restore in flight so a crash or an in-process
/// retry can resume it deterministically instead of re-deciding anything
/// (see `resume_or_complete_restore_manifest` in note_commands.rs). Written
/// only after the safety revision's row already committed, and only just
/// before the current file is actually replaced. Contains no note content
/// — only identifiers and hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct RestoreManifest {
    pub version: u8,
    pub operation_id: String,
    pub phase: RestorePhase,
    pub session_id: String,
    pub current_relative_path: String,
    pub prior: PriorNoteState,
    pub target_revision_id: String,
    pub target_hash: String,
    pub safety_revision_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriorNoteState {
    NoNoteRow,
    Present { content_hash: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestorePhase {
    Prepared,
    TargetWritten,
    MetadataCommitted,
    Cancelled,
}

/// Bumped only if the manifest's on-disk shape ever needs to change in a
/// way `#[serde(deny_unknown_fields)]` wouldn't handle gracefully.
pub(crate) const STAGED_DATA_MANIFEST_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagedRoot {
    Notes,
    NoteRevisions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagedEntryType {
    File,
    Directory,
}

/// One filesystem entity staged as part of a `StagedDataManifest`. An
/// empty `relative_path` means "this root's entire contents" — used only
/// by delete-all's whole-root entries; every other operation always
/// staged a real, validated session id (`NoteRevisions`/`Directory`) or
/// note file path (`Notes`/`File`), which is never empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct StagedDataEntry {
    pub root: StagedRoot,
    pub relative_path: String,
    pub entry_type: StagedEntryType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StagedDataKind {
    RevisionHistory { session_id: String },
    Session { session_id: String },
    AllData,
}

/// Written atomically to `note-trash/<operation-id>/manifest.json` before
/// the first entry is ever moved — the complete, ordered list of intended
/// moves, so a failure partway through (or a crash) always has enough
/// information to either finish or fully reverse the operation. Contains
/// no note or revision content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct StagedDataManifest {
    pub version: u8,
    pub operation_id: String,
    pub kind: StagedDataKind,
    pub entries: Vec<StagedDataEntry>,
}

/// A staged multi-root deletion in flight or completed. `None` means a
/// no-op stage (nothing existed to stage) — restoring or finalizing it is
/// a trivial success, matching `StagedDeletion`'s own contract.
pub struct StagedDataOperation {
    operation_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredRevisionObject {
    pub content: String,
    pub content_hash: String,
}

#[derive(Debug)]
pub enum RevisionObjectStatus {
    /// The object didn't exist yet and was just written.
    Created(StoredRevisionObject),
    /// The object already existed and its bytes verified against the hash.
    ExistingVerified(StoredRevisionObject),
    /// A caller-relabeled `Created` result: the object file was absent but
    /// a SQLite row already referenced this (session_id, content_hash) —
    /// ensure_revision_object() itself has no SQLite awareness, so this
    /// variant only exists for revision_commands.rs to reinterpret a fresh
    /// write as a repair rather than a first-time creation.
    RepairedMissing(StoredRevisionObject),
}

/// A lowercase, 64-character hexadecimal SHA-256 digest — the exact shape
/// every revision object's filename (minus the `.md` extension) must take.
fn validate_content_hash(hash: &str) -> Result<(), NoteFileError> {
    if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        Ok(())
    } else {
        Err(NoteFileError::InvalidPath)
    }
}

fn corrupt(session_id: &str, content_hash: &str) -> NoteFileError {
    NoteFileError::Unreadable { relative_path: format!("{session_id}/{content_hash}.md") }
}

impl NoteFileStore {
    /// Resolves (creating if needed) the per-session revision directory,
    /// rejecting it outright if it exists as a symlink or a non-directory.
    fn revision_session_dir(&self, session_id: &str) -> Result<PathBuf, NoteFileError> {
        validate_session_id(session_id)?;
        if matches!(fs::symlink_metadata(self.revisions_dir()), Ok(metadata) if metadata.file_type().is_symlink())
        {
            return Err(NoteFileError::InvalidPath);
        }
        let session_dir = self.revisions_dir().join(session_id);
        match fs::symlink_metadata(&session_dir) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(NoteFileError::InvalidPath);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&session_dir).map_err(io_err)?;
            }
            Err(error) => return Err(io_err(error)),
        }
        Ok(session_dir)
    }

    fn revision_path(&self, session_id: &str, content_hash: &str) -> Result<PathBuf, NoteFileError> {
        validate_content_hash(content_hash)?;
        let session_dir = self.revision_session_dir(session_id)?;
        resolve_within(&session_dir, session_dir.join(format!("{content_hash}.md")))
    }

    /// Atomically creates the immutable snapshot object for `content` under
    /// `session_id`, or verifies it if one already exists. `expected_hash`
    /// must equal the SHA-256 of `content` — a caller-side mismatch is
    /// rejected before anything touches disk. An existing object whose
    /// bytes don't hash to its own filename is corruption, not silently
    /// replaced.
    pub fn ensure_revision_object(
        &self,
        session_id: &str,
        content: &str,
        expected_hash: &str,
    ) -> Result<RevisionObjectStatus, NoteFileError> {
        validate_content_hash(expected_hash)?;
        let actual_hash = sha256_hex(content.as_bytes());
        if actual_hash != expected_hash {
            return Err(corrupt(session_id, expected_hash));
        }
        let path = self.revision_path(session_id, expected_hash)?;
        match fs::read(&path) {
            Ok(bytes) => {
                let existing_hash = sha256_hex(&bytes);
                if existing_hash != expected_hash {
                    return Err(corrupt(session_id, expected_hash));
                }
                let existing_content =
                    String::from_utf8(bytes).map_err(|_| corrupt(session_id, expected_hash))?;
                Ok(RevisionObjectStatus::ExistingVerified(StoredRevisionObject {
                    content: existing_content,
                    content_hash: existing_hash,
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                atomic_replace(&path, content.as_bytes())?;
                Ok(RevisionObjectStatus::Created(StoredRevisionObject {
                    content: content.to_string(),
                    content_hash: actual_hash,
                }))
            }
            Err(error) => Err(io_err(error)),
        }
    }

    /// Reads and re-hashes a snapshot object, verifying the computed hash
    /// matches the hash the caller asked for (which is also the filename)
    /// before ever returning its content.
    pub fn read_revision_object(
        &self,
        session_id: &str,
        content_hash: &str,
    ) -> Result<StoredRevisionObject, NoteFileError> {
        validate_content_hash(content_hash)?;
        let path = self.revision_path(session_id, content_hash)?;
        let bytes = fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                NoteFileError::Missing { relative_path: format!("{session_id}/{content_hash}.md") }
            } else {
                io_err(error)
            }
        })?;
        let actual_hash = sha256_hex(&bytes);
        if actual_hash != content_hash {
            return Err(corrupt(session_id, content_hash));
        }
        let content = String::from_utf8(bytes).map_err(|_| corrupt(session_id, content_hash))?;
        Ok(StoredRevisionObject { content, content_hash: actual_hash })
    }

    /// Resolves (without creating) the operation directory for a restore
    /// manifest, rejecting a symlinked `operations_dir()` or operation
    /// directory the same way trash/revision directories are guarded.
    fn restore_operation_dir(&self, operation_id: &str) -> Result<PathBuf, NoteFileError> {
        validate_operation_id(operation_id)?;
        if matches!(fs::symlink_metadata(self.operations_dir()), Ok(metadata) if metadata.file_type().is_symlink())
        {
            return Err(NoteFileError::InvalidPath);
        }
        resolve_within(self.operations_dir(), self.operations_dir().join(operation_id))
    }

    fn restore_manifest_path(&self, operation_id: &str) -> Result<PathBuf, NoteFileError> {
        let dir = self.restore_operation_dir(operation_id)?;
        resolve_within(&dir, dir.join("manifest.json"))
    }

    /// Validates every identifier/hash a manifest carries before it's ever
    /// written — a caller-side bug should never be able to persist a
    /// manifest pointing at an invalid path or hash in the first place.
    fn validate_manifest_fields(manifest: &RestoreManifest) -> Result<(), NoteFileError> {
        validate_operation_id(&manifest.operation_id)?;
        validate_session_id(&manifest.session_id)?;
        validate_content_hash(&manifest.target_hash)?;
        if let PriorNoteState::Present { content_hash } = &manifest.prior {
            validate_content_hash(content_hash)?;
        }
        if manifest.current_relative_path.is_empty()
            || manifest.current_relative_path.contains('/')
            || manifest.current_relative_path.contains('\\')
        {
            return Err(NoteFileError::InvalidPath);
        }
        Ok(())
    }

    /// Atomically (re)writes `manifest` to its operation directory —
    /// creating that directory on first write, or overwriting the same
    /// file in place for a phase update. The directory name is exactly
    /// `manifest.operation_id`, so a fresh manifest and a phase update both
    /// resolve to the same path.
    pub(crate) fn write_restore_manifest(&self, manifest: &RestoreManifest) -> Result<(), NoteFileError> {
        Self::validate_manifest_fields(manifest)?;
        let dir = self.restore_operation_dir(&manifest.operation_id)?;
        fs::create_dir_all(&dir).map_err(io_err)?;
        let path = resolve_within(&dir, dir.join("manifest.json"))?;
        let json = serde_json::to_vec_pretty(manifest)
            .map_err(|error| NoteFileError::Io(format!("failed to serialize restore manifest: {error}")))?;
        atomic_replace(&path, &json)
    }

    pub(crate) fn read_restore_manifest(&self, operation_id: &str) -> Result<RestoreManifest, NoteFileError> {
        let path = self.restore_manifest_path(operation_id)?;
        let bytes = fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                NoteFileError::Missing { relative_path: format!("{operation_id}/manifest.json") }
            } else {
                io_err(error)
            }
        })?;
        let manifest: RestoreManifest = serde_json::from_slice(&bytes)
            .map_err(|_| NoteFileError::Unreadable { relative_path: format!("{operation_id}/manifest.json") })?;
        if manifest.version != RESTORE_MANIFEST_VERSION || manifest.operation_id != operation_id {
            return Err(NoteFileError::Unreadable { relative_path: format!("{operation_id}/manifest.json") });
        }
        Ok(manifest)
    }

    /// Re-reads the manifest, updates only its phase, and atomically
    /// rewrites it. A missing manifest (already removed by a concurrent
    /// finish/cancel) is a harmless no-op — nothing left to mark.
    pub(crate) fn set_restore_manifest_phase(
        &self,
        operation_id: &str,
        phase: RestorePhase,
    ) -> Result<(), NoteFileError> {
        let mut manifest = match self.read_restore_manifest(operation_id) {
            Ok(manifest) => manifest,
            Err(NoteFileError::Missing { .. }) => return Ok(()),
            Err(error) => return Err(error),
        };
        manifest.phase = phase;
        self.write_restore_manifest(&manifest)
    }

    /// Discards the entire operation directory (manifest done or
    /// cancelled) — already-absent is a harmless no-op, matching
    /// `finalize_stage`'s contract.
    pub(crate) fn remove_restore_manifest(&self, operation_id: &str) -> Result<(), NoteFileError> {
        let dir = self.restore_operation_dir(operation_id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_err(error)),
        }
    }

    /// Every restore manifest currently on disk, across every operation
    /// directory — the only source of truth startup recovery has, since
    /// there's no in-memory record of what a previous process left
    /// unfinished. A symlinked or invalidly-named operation directory is
    /// skipped rather than followed, matching `staged_entries()`'s own
    /// defense. A directory that validates but holds no readable manifest
    /// (e.g. genuinely corrupt) propagates as an error instead of being
    /// silently skipped — an abandoned operation should never go unnoticed.
    pub(crate) fn restore_manifests(&self) -> Result<Vec<RestoreManifest>, NoteFileError> {
        let mut result = Vec::new();
        match fs::symlink_metadata(self.operations_dir()) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(NoteFileError::InvalidPath),
            Ok(_) => {}
            Err(_) => return Ok(result),
        }
        for entry in fs::read_dir(self.operations_dir()).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_err)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let operation_id = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
            if validate_operation_id(&operation_id).is_err() {
                continue;
            }
            result.push(self.read_restore_manifest(&operation_id)?);
        }
        Ok(result)
    }
}

/// Recursively merges `source`'s contents into `destination` (created if
/// needed): a file with nothing already at its destination is renamed
/// into place; a nested directory is merged the same way, then removed if
/// left empty. A collision — something already at the destination — is
/// resolved by plain byte-for-byte comparison: identical bytes mean the
/// staged copy is a redundant duplicate, safely discarded; anything else
/// leaves *both* copies in place and reports it rather than guessing. A
/// symlinked entry anywhere in `source` is rejected outright.
fn merge_directory(source: &std::path::Path, destination: &std::path::Path) -> Result<(), NoteFileError> {
    if matches!(fs::symlink_metadata(source), Ok(metadata) if metadata.file_type().is_symlink()) {
        return Err(NoteFileError::InvalidPath);
    }
    fs::create_dir_all(destination).map_err(io_err)?;
    for entry in fs::read_dir(source).map_err(io_err)? {
        let entry = entry.map_err(io_err)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_err)?;
        if metadata.file_type().is_symlink() {
            return Err(NoteFileError::InvalidPath);
        }
        let name = path
            .file_name()
            .ok_or_else(|| NoteFileError::Io("staged entry has no file name".to_string()))?;
        let target = destination.join(name);
        if metadata.is_dir() {
            merge_directory(&path, &target)?;
            let _ = fs::remove_dir(&path); // best-effort: only succeeds once empty
            continue;
        }
        if !target.exists() {
            fs::rename(&path, &target).map_err(io_err)?;
            continue;
        }
        let staged_bytes = fs::read(&path).map_err(io_err)?;
        let live_bytes = fs::read(&target).map_err(io_err)?;
        if staged_bytes == live_bytes {
            fs::remove_file(&path).map_err(io_err)?;
            continue;
        }
        return Err(NoteFileError::Io(format!(
            "cannot restore {}: a differing file already exists at that location",
            target.display()
        )));
    }
    Ok(())
}

impl NoteFileStore {
    fn staged_data_operation_dir(&self, operation_id: &str) -> Result<PathBuf, NoteFileError> {
        validate_operation_id(operation_id)?;
        if matches!(fs::symlink_metadata(self.trash_dir()), Ok(metadata) if metadata.file_type().is_symlink()) {
            return Err(NoteFileError::InvalidPath);
        }
        resolve_within(self.trash_dir(), self.trash_dir().join(operation_id))
    }

    fn staged_data_manifest_path(&self, operation_id: &str) -> Result<PathBuf, NoteFileError> {
        let dir = self.staged_data_operation_dir(operation_id)?;
        resolve_within(&dir, dir.join("manifest.json"))
    }

    fn write_staged_data_manifest(&self, manifest: &StagedDataManifest) -> Result<(), NoteFileError> {
        validate_operation_id(&manifest.operation_id)?;
        for entry in &manifest.entries {
            match (&entry.root, entry.relative_path.is_empty()) {
                (_, true) => {} // whole-root entry — nothing further to validate
                (StagedRoot::Notes, false) => validate_relative_path_str(&entry.relative_path)?,
                (StagedRoot::NoteRevisions, false) => validate_session_id(&entry.relative_path)?,
            }
        }
        let dir = self.staged_data_operation_dir(&manifest.operation_id)?;
        fs::create_dir_all(&dir).map_err(io_err)?;
        let path = resolve_within(&dir, dir.join("manifest.json"))?;
        let json = serde_json::to_vec_pretty(manifest)
            .map_err(|error| NoteFileError::Io(format!("failed to serialize staged-data manifest: {error}")))?;
        atomic_replace(&path, &json)
    }

    pub(crate) fn read_staged_data_manifest(&self, operation_id: &str) -> Result<StagedDataManifest, NoteFileError> {
        let path = self.staged_data_manifest_path(operation_id)?;
        let bytes = fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                NoteFileError::Missing { relative_path: format!("{operation_id}/manifest.json") }
            } else {
                io_err(error)
            }
        })?;
        let manifest: StagedDataManifest = serde_json::from_slice(&bytes)
            .map_err(|_| NoteFileError::Unreadable { relative_path: format!("{operation_id}/manifest.json") })?;
        if manifest.version != STAGED_DATA_MANIFEST_VERSION || manifest.operation_id != operation_id {
            return Err(NoteFileError::Unreadable { relative_path: format!("{operation_id}/manifest.json") });
        }
        Ok(manifest)
    }

    /// The absolute *live* location an entry refers to, outside any trash
    /// operation directory.
    fn staged_entry_live_path(&self, entry: &StagedDataEntry) -> Result<PathBuf, NoteFileError> {
        if entry.relative_path.is_empty() {
            return Ok(match entry.root {
                StagedRoot::Notes => self.notes_dir().to_path_buf(),
                StagedRoot::NoteRevisions => self.revisions_dir().to_path_buf(),
            });
        }
        match entry.root {
            StagedRoot::Notes => {
                validate_relative_path_str(&entry.relative_path)?;
                resolve_within(self.notes_dir(), self.notes_dir().join(&entry.relative_path))
            }
            StagedRoot::NoteRevisions => {
                validate_session_id(&entry.relative_path)?;
                resolve_within(self.revisions_dir(), self.revisions_dir().join(&entry.relative_path))
            }
        }
    }

    fn staged_entry_trash_path(&self, operation_id: &str, entry: &StagedDataEntry) -> Result<PathBuf, NoteFileError> {
        let dir = self.staged_data_operation_dir(operation_id)?;
        let root_dir = match entry.root {
            StagedRoot::Notes => dir.join("notes"),
            StagedRoot::NoteRevisions => dir.join("note-revisions"),
        };
        if entry.relative_path.is_empty() {
            return resolve_within(&dir, root_dir);
        }
        resolve_within(&dir, root_dir.join(&entry.relative_path))
    }

    /// Writes the complete manifest before moving anything, then moves
    /// each entry in order. A whole-root entry is immediately followed by
    /// recreating an empty root, so the app never observes a moment with
    /// none. A failure at any point rolls back every entry that's now
    /// actually staged — every earlier entry that completed *and* this
    /// entry itself, if its `fs::rename` succeeded but a later step (the
    /// whole-root recreate) failed — before returning the original error;
    /// including the current entry in that rollback range (`..=index`, not
    /// `..index`) is what prevents the operation directory from being
    /// deleted out from under still-unrestored staged data a moment later.
    /// If the rollback itself fails, the manifest (and whatever's still
    /// staged) is deliberately left in place for startup recovery rather
    /// than guessed at further.
    fn stage_data_entries(
        &self,
        kind: StagedDataKind,
        entries: Vec<StagedDataEntry>,
    ) -> Result<StagedDataOperation, NoteFileError> {
        self.stage_data_entries_with_hook(kind, entries, |_index, _entry| Ok(()))
    }

    /// Same as `stage_data_entries`, with an injectable hook called after
    /// each entry's `fs::rename` succeeds but before a whole-root entry's
    /// follow-up recreate-empty-root step runs — a no-op in production
    /// (`stage_data_entries` above), used only by tests to force a
    /// deterministic failure in that exact window.
    fn stage_data_entries_with_hook<F>(
        &self,
        kind: StagedDataKind,
        entries: Vec<StagedDataEntry>,
        after_rename: F,
    ) -> Result<StagedDataOperation, NoteFileError>
    where
        F: Fn(usize, &StagedDataEntry) -> Result<(), NoteFileError>,
    {
        if entries.is_empty() {
            return Ok(StagedDataOperation { operation_id: None });
        }

        let operation_id = Uuid::new_v4().to_string();
        let manifest =
            StagedDataManifest { version: STAGED_DATA_MANIFEST_VERSION, operation_id: operation_id.clone(), kind, entries };
        self.write_staged_data_manifest(&manifest)?;

        for (index, entry) in manifest.entries.iter().enumerate() {
            let move_result: Result<(), NoteFileError> = (|| {
                let live = self.staged_entry_live_path(entry)?;
                let trash = self.staged_entry_trash_path(&operation_id, entry)?;
                if let Some(parent) = trash.parent() {
                    fs::create_dir_all(parent).map_err(io_err)?;
                }
                fs::rename(&live, &trash).map_err(io_err)?;
                after_rename(index, entry)?;
                if entry.relative_path.is_empty() {
                    fs::create_dir_all(&live).map_err(io_err)?;
                }
                Ok(())
            })();
            if let Err(error) = move_result {
                // `..=index`: this entry's own rename may already have
                // landed (the failure could be from `after_rename` or the
                // whole-root recreate, both of which run *after* the
                // rename) — rolling back only `..index` would leave that
                // staged data behind while still reporting overall success
                // up to this point, and the operation directory removal
                // below would then permanently delete it.
                if let Err(rollback_error) = self.rollback_staged_entries(&operation_id, &manifest.entries[..=index]) {
                    return Err(NoteFileError::Io(format!(
                        "staged move failed ({error:?}) and rolling back the already-moved \
                         entries also failed ({rollback_error:?}) — manifest {operation_id} left for recovery"
                    )));
                }
                let _ = fs::remove_dir_all(self.staged_data_operation_dir(&operation_id)?);
                return Err(error);
            }
        }

        Ok(StagedDataOperation { operation_id: Some(operation_id) })
    }

    /// Moves every already-completed entry back to its live location,
    /// reusing `restore_staged_data_entry`'s exact same collision-safe
    /// logic — rollback and restore are the same operation in every way
    /// that matters (a live path that's already occupied again by the
    /// time this runs is preserved and merged/compared, never blindly
    /// overwritten).
    fn rollback_staged_entries(&self, operation_id: &str, completed: &[StagedDataEntry]) -> Result<(), NoteFileError> {
        for entry in completed.iter().rev() {
            self.restore_staged_data_entry(operation_id, entry)?;
        }
        Ok(())
    }

    /// Stages a session's current note file (if any) and its complete
    /// `note-revisions/<session-id>/` directory (if any) under one
    /// manifest — the file store half of per-session deletion.
    pub fn stage_session_data(
        &self,
        session_id: &str,
        current_note_path: Option<&str>,
    ) -> Result<StagedDataOperation, NoteFileError> {
        validate_session_id(session_id)?;
        let mut entries = Vec::new();
        if let Some(path) = current_note_path {
            validate_relative_path_str(path)?;
            if resolve_within(self.notes_dir(), self.notes_dir().join(path))?.exists() {
                entries.push(StagedDataEntry {
                    root: StagedRoot::Notes,
                    relative_path: path.to_string(),
                    entry_type: StagedEntryType::File,
                });
            }
        }
        if self.revisions_dir().join(session_id).exists() {
            entries.push(StagedDataEntry {
                root: StagedRoot::NoteRevisions,
                relative_path: session_id.to_string(),
                entry_type: StagedEntryType::Directory,
            });
        }
        self.stage_data_entries(StagedDataKind::Session { session_id: session_id.to_string() }, entries)
    }

    /// Stages just a session's `note-revisions/<session-id>/` directory —
    /// the file store half of "Delete revision history", which never
    /// touches the current note.
    pub fn stage_revision_history(&self, session_id: &str) -> Result<StagedDataOperation, NoteFileError> {
        validate_session_id(session_id)?;
        let mut entries = Vec::new();
        if self.revisions_dir().join(session_id).exists() {
            entries.push(StagedDataEntry {
                root: StagedRoot::NoteRevisions,
                relative_path: session_id.to_string(),
                entry_type: StagedEntryType::Directory,
            });
        }
        self.stage_data_entries(StagedDataKind::RevisionHistory { session_id: session_id.to_string() }, entries)
    }

    /// Stages the complete `notes/` and `note-revisions/` roots together —
    /// the file store half of delete-all — recreating both empty
    /// immediately after staging.
    pub fn stage_all_data(&self) -> Result<StagedDataOperation, NoteFileError> {
        let mut entries = Vec::new();
        if self.notes_dir().exists() {
            entries.push(StagedDataEntry {
                root: StagedRoot::Notes,
                relative_path: String::new(),
                entry_type: StagedEntryType::Directory,
            });
        }
        if self.revisions_dir().exists() {
            entries.push(StagedDataEntry {
                root: StagedRoot::NoteRevisions,
                relative_path: String::new(),
                entry_type: StagedEntryType::Directory,
            });
        }
        self.stage_data_entries(StagedDataKind::AllData, entries)
    }

    pub(crate) fn finalize_staged_data_by_id(&self, operation_id: &str) -> Result<(), NoteFileError> {
        let dir = self.staged_data_operation_dir(operation_id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_err(error)),
        }
    }

    /// Permanently discards every entry a completed operation staged.
    pub fn finalize_staged_data(&self, operation: &StagedDataOperation) -> Result<(), NoteFileError> {
        match &operation.operation_id {
            Some(id) => self.finalize_staged_data_by_id(id),
            None => Ok(()),
        }
    }

    fn restore_staged_data_entry(&self, operation_id: &str, entry: &StagedDataEntry) -> Result<(), NoteFileError> {
        let trash_path = self.staged_entry_trash_path(operation_id, entry)?;
        if !trash_path.exists() {
            return Ok(()); // nothing left staged for this entry
        }
        let live_path = self.staged_entry_live_path(entry)?;
        match entry.entry_type {
            StagedEntryType::File => {
                if let Some(parent) = live_path.parent() {
                    fs::create_dir_all(parent).map_err(io_err)?;
                }
                if !live_path.exists() {
                    return fs::rename(&trash_path, &live_path).map_err(io_err);
                }
                let staged_bytes = fs::read(&trash_path).map_err(io_err)?;
                let live_bytes = fs::read(&live_path).map_err(io_err)?;
                if staged_bytes == live_bytes {
                    return fs::remove_file(&trash_path).map_err(io_err);
                }
                Err(NoteFileError::Io(format!(
                    "cannot restore {}: a differing file already exists at that location",
                    live_path.display()
                )))
            }
            StagedEntryType::Directory => {
                if !entry.relative_path.is_empty() && !live_path.exists() {
                    if let Some(parent) = live_path.parent() {
                        fs::create_dir_all(parent).map_err(io_err)?;
                    }
                    fs::rename(&trash_path, &live_path).map_err(io_err)?;
                } else {
                    merge_directory(&trash_path, &live_path)?;
                    let _ = fs::remove_dir_all(&trash_path);
                }
                Ok(())
            }
        }
    }

    pub(crate) fn restore_staged_data_manifest(&self, manifest: &StagedDataManifest) -> Result<(), NoteFileError> {
        for entry in &manifest.entries {
            self.restore_staged_data_entry(&manifest.operation_id, entry)?;
        }
        let _ = fs::remove_dir_all(self.staged_data_operation_dir(&manifest.operation_id)?);
        Ok(())
    }

    /// Restores every entry a staged (but never-committed) operation
    /// moved, reversing `stage_data_entries` exactly.
    pub fn restore_staged_data(&self, operation: &StagedDataOperation) -> Result<(), NoteFileError> {
        let Some(operation_id) = &operation.operation_id else { return Ok(()) };
        let manifest = self.read_staged_data_manifest(operation_id)?;
        self.restore_staged_data_manifest(&manifest)
    }

    /// Every typed staged-data manifest currently on disk, across every
    /// operation directory — startup recovery's only source of truth for
    /// what a previous process left unfinished. An operation directory
    /// with no `manifest.json` belongs to the older, untyped single-file
    /// staging a whitespace clear still uses (see note_commands.rs's
    /// `recover_staged_deletions_core`) and is skipped here — the two
    /// recovery passes partition `note-trash/` by that distinction rather
    /// than ever double-processing the same operation directory.
    pub(crate) fn staged_data_manifests(&self) -> Result<Vec<StagedDataManifest>, NoteFileError> {
        let mut result = Vec::new();
        match fs::symlink_metadata(self.trash_dir()) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err(NoteFileError::InvalidPath),
            Ok(_) => {}
            Err(_) => return Ok(result),
        }
        for entry in fs::read_dir(self.trash_dir()).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_err)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let operation_id = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_string();
            if validate_operation_id(&operation_id).is_err() {
                continue;
            }
            match fs::symlink_metadata(path.join("manifest.json")) {
                Ok(metadata) if !metadata.file_type().is_symlink() => {}
                _ => continue,
            }
            result.push(self.read_staged_data_manifest(&operation_id)?);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn initialized_store() -> (tempfile::TempDir, NoteFileStore) {
        let dir = tempfile::tempdir().expect("create temp app-data root");
        let store = NoteFileStore::new(dir.path().to_path_buf());
        store.initialize().expect("initialize note directories");
        (dir, store)
    }

    #[test]
    fn creating_then_reusing_an_object_is_idempotent() {
        let (_dir, store) = initialized_store();
        let hash = crate::note_files::sha256_hex("hello\r\n".as_bytes());

        let first = store.ensure_revision_object("s1", "hello\r\n", &hash).unwrap();
        assert!(matches!(first, RevisionObjectStatus::Created(_)));

        let second = store.ensure_revision_object("s1", "hello\r\n", &hash).unwrap();
        assert!(matches!(second, RevisionObjectStatus::ExistingVerified(_)));
    }

    #[test]
    fn exact_crlf_and_unicode_bytes_round_trip() {
        let (_dir, store) = initialized_store();
        let content = "line one\r\nCafé ☕\nline three";
        let hash = crate::note_files::sha256_hex(content.as_bytes());

        store.ensure_revision_object("s1", content, &hash).unwrap();
        let loaded = store.read_revision_object("s1", &hash).unwrap();

        assert_eq!(loaded.content.as_bytes(), content.as_bytes());
        assert_eq!(loaded.content_hash, hash);
    }

    #[test]
    fn rejects_a_hash_that_does_not_match_the_content() {
        let (_dir, store) = initialized_store();
        let wrong_hash = crate::note_files::sha256_hex(b"something else");

        assert!(matches!(
            store.ensure_revision_object("s1", "actual content", &wrong_hash),
            Err(NoteFileError::Unreadable { .. })
        ));
    }

    #[test]
    fn rejects_invalid_session_ids_and_hashes() {
        let (_dir, store) = initialized_store();
        let hash = crate::note_files::sha256_hex(b"content");

        assert!(matches!(
            store.ensure_revision_object("../escape", "content", &hash),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(
            store.ensure_revision_object("s1", "content", "not-a-valid-hash"),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(
            store.ensure_revision_object("s1", "content", &"F".repeat(64)), // uppercase hex rejected
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(store.read_revision_object("s1", "short"), Err(NoteFileError::InvalidPath)));
    }

    #[test]
    fn missing_revision_read_is_reported_as_missing_not_corrupt() {
        let (_dir, store) = initialized_store();
        let hash = crate::note_files::sha256_hex(b"never written");

        assert!(matches!(store.read_revision_object("s1", &hash), Err(NoteFileError::Missing { .. })));
    }

    #[test]
    fn missing_object_is_repaired_from_verified_source_bytes() {
        let (_dir, store) = initialized_store();
        let content = "will be deleted and recreated";
        let hash = crate::note_files::sha256_hex(content.as_bytes());
        store.ensure_revision_object("s1", content, &hash).unwrap();

        std::fs::remove_file(store.revisions_dir().join("s1").join(format!("{hash}.md"))).unwrap();

        let repaired = store.ensure_revision_object("s1", content, &hash).unwrap();
        assert!(matches!(repaired, RevisionObjectStatus::Created(_)));
        let loaded = store.read_revision_object("s1", &hash).unwrap();
        assert_eq!(loaded.content, content);
    }

    #[test]
    fn corrupt_existing_object_blocks_the_operation_without_replacing_it() {
        let (_dir, store) = initialized_store();
        let content = "original content";
        let hash = crate::note_files::sha256_hex(content.as_bytes());
        store.ensure_revision_object("s1", content, &hash).unwrap();

        // Tamper with the object on disk so its bytes no longer match its
        // own filename hash.
        std::fs::write(store.revisions_dir().join("s1").join(format!("{hash}.md")), b"tampered").unwrap();

        assert!(matches!(
            store.ensure_revision_object("s1", content, &hash),
            Err(NoteFileError::Unreadable { .. })
        ));
        assert!(matches!(store.read_revision_object("s1", &hash), Err(NoteFileError::Unreadable { .. })));
        // The tampered bytes are left exactly as-is — never silently replaced.
        assert_eq!(
            std::fs::read(store.revisions_dir().join("s1").join(format!("{hash}.md"))).unwrap(),
            b"tampered"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_revisions_root() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let store = NoteFileStore::new(dir.path().to_path_buf());
        store.initialize().unwrap();
        std::fs::remove_dir(store.revisions_dir()).unwrap();
        let outside = dir.path().join("outside-revisions");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, store.revisions_dir()).unwrap();

        let hash = crate::note_files::sha256_hex(b"content");
        assert!(matches!(
            store.ensure_revision_object("s1", "content", &hash),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_session_directory() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-session");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("secret.md"), b"private").unwrap();
        symlink(&outside, store.revisions_dir().join("s1")).unwrap();

        let hash = crate::note_files::sha256_hex(b"content");
        assert!(matches!(
            store.ensure_revision_object("s1", "content", &hash),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(store.read_revision_object("s1", &hash), Err(NoteFileError::InvalidPath)));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_object() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-object.md");
        std::fs::write(&outside, b"private").unwrap();
        let content = "whatever hashes to this";
        let hash = crate::note_files::sha256_hex(content.as_bytes());
        std::fs::create_dir_all(store.revisions_dir().join("s1")).unwrap();
        symlink(&outside, store.revisions_dir().join("s1").join(format!("{hash}.md"))).unwrap();

        assert!(matches!(
            store.ensure_revision_object("s1", content, &hash),
            Err(NoteFileError::InvalidPath)
        ));
        assert!(matches!(store.read_revision_object("s1", &hash), Err(NoteFileError::InvalidPath)));
        assert_eq!(std::fs::read(&outside).unwrap(), b"private");
    }

    #[test]
    fn sessions_are_isolated_from_each_other() {
        let (_dir, store) = initialized_store();
        let content = "shared text, different sessions";
        let hash = crate::note_files::sha256_hex(content.as_bytes());

        store.ensure_revision_object("s1", content, &hash).unwrap();
        // s2 has never had this content stored — must be reported missing,
        // not silently found via some shared/global object store.
        assert!(matches!(store.read_revision_object("s2", &hash), Err(NoteFileError::Missing { .. })));
    }

    fn sample_manifest(operation_id: &str) -> RestoreManifest {
        RestoreManifest {
            version: RESTORE_MANIFEST_VERSION,
            operation_id: operation_id.to_string(),
            phase: RestorePhase::Prepared,
            session_id: "s1".to_string(),
            current_relative_path: "note.md".to_string(),
            prior: PriorNoteState::Present { content_hash: crate::note_files::sha256_hex(b"prior") },
            target_revision_id: "rev-1".to_string(),
            target_hash: crate::note_files::sha256_hex(b"target"),
            safety_revision_id: Some("safety-1".to_string()),
        }
    }

    #[test]
    fn writes_reads_and_updates_a_restore_manifest_phase() {
        let (_dir, store) = initialized_store();
        let manifest = sample_manifest("11111111-1111-1111-1111-111111111111");

        store.write_restore_manifest(&manifest).unwrap();
        let loaded = store.read_restore_manifest(&manifest.operation_id).unwrap();
        assert_eq!(loaded, manifest);

        store.set_restore_manifest_phase(&manifest.operation_id, RestorePhase::TargetWritten).unwrap();
        let updated = store.read_restore_manifest(&manifest.operation_id).unwrap();
        assert_eq!(updated.phase, RestorePhase::TargetWritten);
        // Nothing else changed.
        assert_eq!(RestoreManifest { phase: manifest.phase, ..updated.clone() }, manifest);
    }

    #[test]
    fn manifest_json_contains_no_content_field() {
        let (_dir, store) = initialized_store();
        let manifest = sample_manifest("22222222-2222-2222-2222-222222222222");
        store.write_restore_manifest(&manifest).unwrap();

        let raw = std::fs::read_to_string(
            store.operations_dir().join(&manifest.operation_id).join("manifest.json"),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let keys: std::collections::BTreeSet<String> =
            parsed.as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from(
                [
                    "version",
                    "operation_id",
                    "phase",
                    "session_id",
                    "current_relative_path",
                    "prior",
                    "target_revision_id",
                    "target_hash",
                    "safety_revision_id",
                ]
                .map(String::from)
            )
        );
    }

    #[test]
    fn write_restore_manifest_rejects_invalid_identifiers_and_hashes() {
        let (_dir, store) = initialized_store();

        let mut bad_operation_id = sample_manifest("../escape");
        assert!(matches!(store.write_restore_manifest(&bad_operation_id), Err(NoteFileError::InvalidPath)));

        bad_operation_id.operation_id = "op-1".to_string();
        bad_operation_id.session_id = "../escape".to_string();
        assert!(matches!(store.write_restore_manifest(&bad_operation_id), Err(NoteFileError::InvalidPath)));

        let mut bad_hash = sample_manifest("op-2");
        bad_hash.target_hash = "not-a-hash".to_string();
        assert!(matches!(store.write_restore_manifest(&bad_hash), Err(NoteFileError::InvalidPath)));

        let mut bad_prior_hash = sample_manifest("op-3");
        bad_prior_hash.prior = PriorNoteState::Present { content_hash: "short".to_string() };
        assert!(matches!(store.write_restore_manifest(&bad_prior_hash), Err(NoteFileError::InvalidPath)));

        let mut bad_path = sample_manifest("op-4");
        bad_path.current_relative_path = "../escape.md".to_string();
        assert!(matches!(store.write_restore_manifest(&bad_path), Err(NoteFileError::InvalidPath)));
    }

    #[test]
    fn read_restore_manifest_rejects_a_tampered_version_or_operation_id() {
        let (_dir, store) = initialized_store();
        let manifest = sample_manifest("33333333-3333-3333-3333-333333333333");
        store.write_restore_manifest(&manifest).unwrap();

        let path = store.operations_dir().join(&manifest.operation_id).join("manifest.json");
        let mut tampered: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        tampered["version"] = serde_json::json!(99);
        std::fs::write(&path, serde_json::to_vec(&tampered).unwrap()).unwrap();

        assert!(matches!(
            store.read_restore_manifest(&manifest.operation_id),
            Err(NoteFileError::Unreadable { .. })
        ));
    }

    #[test]
    fn remove_restore_manifest_is_idempotent_and_clears_enumeration() {
        let (_dir, store) = initialized_store();
        let manifest = sample_manifest("44444444-4444-4444-4444-444444444444");
        store.write_restore_manifest(&manifest).unwrap();
        assert_eq!(store.restore_manifests().unwrap().len(), 1);

        store.remove_restore_manifest(&manifest.operation_id).unwrap();
        assert!(store.restore_manifests().unwrap().is_empty());
        // Already gone — calling again must not error (cancelled cleanup
        // retried at a later startup relies on this).
        store.remove_restore_manifest(&manifest.operation_id).unwrap();
    }

    #[test]
    fn set_restore_manifest_phase_on_a_missing_manifest_is_a_no_op() {
        let (_dir, store) = initialized_store();
        store.set_restore_manifest_phase("55555555-5555-5555-5555-555555555555", RestorePhase::Cancelled).unwrap();
    }

    #[test]
    fn restore_manifests_enumerates_every_manifest_across_operations() {
        let (_dir, store) = initialized_store();
        let first = sample_manifest("66666666-6666-6666-6666-666666666666");
        let mut second = sample_manifest("77777777-7777-7777-7777-777777777777");
        second.session_id = "s2".to_string();
        store.write_restore_manifest(&first).unwrap();
        store.write_restore_manifest(&second).unwrap();

        let mut found = store.restore_manifests().unwrap();
        found.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        assert_eq!(found, vec![first, second]);
    }

    #[cfg(unix)]
    #[test]
    fn restore_manifests_rejects_a_symlinked_operations_root() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        std::fs::remove_dir(store.operations_dir()).unwrap();
        let outside = dir.path().join("outside-operations");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, store.operations_dir()).unwrap();

        assert!(matches!(store.restore_manifests(), Err(NoteFileError::InvalidPath)));
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn restore_manifests_skips_a_symlinked_operation_directory() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-op");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("manifest.json"), b"{}").unwrap();
        symlink(&outside, store.operations_dir().join("fake-op")).unwrap();

        let real = sample_manifest("88888888-8888-8888-8888-888888888888");
        store.write_restore_manifest(&real).unwrap();

        let found = store.restore_manifests().unwrap();
        assert_eq!(found, vec![real]);
    }

    #[cfg(unix)]
    #[test]
    fn write_restore_manifest_rejects_a_symlinked_operation_directory() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        let outside = dir.path().join("outside-op-write");
        std::fs::create_dir(&outside).unwrap();
        let op_id = "99999999-9999-9999-9999-999999999999";
        symlink(&outside, store.operations_dir().join(op_id)).unwrap();

        let manifest = sample_manifest(op_id);
        assert!(matches!(store.write_restore_manifest(&manifest), Err(NoteFileError::InvalidPath)));
        assert!(!outside.join("manifest.json").exists());
    }

    fn revision_content_hash(content: &str) -> String {
        crate::note_files::sha256_hex(content.as_bytes())
    }

    #[test]
    fn stage_session_data_stages_the_note_and_revision_directory_under_one_manifest() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "note content", None, false).unwrap();
        let hash = revision_content_hash("revision content");
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();

        let operation = store.stage_session_data("s1", Some("s1.md")).unwrap();

        assert!(matches!(store.read("s1.md"), Err(NoteFileError::Missing { .. })));
        assert!(!store.revisions_dir().join("s1").exists());

        let manifest = store.read_staged_data_manifest(operation.operation_id.as_deref().unwrap()).unwrap();
        assert!(matches!(manifest.kind, StagedDataKind::Session { ref session_id } if session_id == "s1"));
        assert_eq!(manifest.entries.len(), 2);
        assert!(manifest
            .entries
            .iter()
            .any(|e| e.root == StagedRoot::Notes && e.relative_path == "s1.md" && e.entry_type == StagedEntryType::File));
        assert!(manifest
            .entries
            .iter()
            .any(|e| e.root == StagedRoot::NoteRevisions && e.relative_path == "s1" && e.entry_type == StagedEntryType::Directory));
    }

    #[test]
    fn stage_session_data_omits_entries_for_what_never_existed() {
        let (_dir, store) = initialized_store();
        // No note, no revisions, for a session that's never had either.
        let operation = store.stage_session_data("s1", None).unwrap();
        assert!(operation.operation_id.is_none());
        store.restore_staged_data(&operation).unwrap(); // no-op is trivially safe
        store.finalize_staged_data(&operation).unwrap(); // no-op is trivially safe
    }

    #[test]
    fn stage_revision_history_never_touches_the_current_note() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "note content", None, false).unwrap();
        let hash = revision_content_hash("revision content");
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();

        let operation = store.stage_revision_history("s1").unwrap();

        assert_eq!(store.read("s1.md").unwrap().content, "note content");
        assert!(!store.revisions_dir().join("s1").exists());

        store.finalize_staged_data(&operation).unwrap();
        assert_eq!(store.read("s1.md").unwrap().content, "note content");
    }

    #[test]
    fn stage_all_data_recreates_both_empty_roots_and_can_restore_the_complete_state() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "note content", None, false).unwrap();
        let hash = revision_content_hash("revision content");
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();

        let operation = store.stage_all_data().unwrap();

        assert!(store.notes_dir().is_dir());
        assert!(store.revisions_dir().is_dir());
        assert!(matches!(store.read("s1.md"), Err(NoteFileError::Missing { .. })));
        assert!(!store.revisions_dir().join("s1").exists());

        store.restore_staged_data(&operation).unwrap();

        assert_eq!(store.read("s1.md").unwrap().content, "note content");
        assert_eq!(store.read_revision_object("s1", &hash).unwrap().content, "revision content");
        assert!(store.staged_data_manifests().unwrap().is_empty());
    }

    #[test]
    fn stage_data_entries_rolls_back_completed_moves_when_a_later_move_fails() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "note content", None, false).unwrap();

        // The second entry references a revision directory that was never
        // created — stage_data_entries() itself (unlike the public
        // stage_*() constructors) doesn't pre-check existence, so its
        // fs::rename fails cleanly and deterministically.
        let entries = vec![
            StagedDataEntry { root: StagedRoot::Notes, relative_path: "s1.md".to_string(), entry_type: StagedEntryType::File },
            StagedDataEntry {
                root: StagedRoot::NoteRevisions,
                relative_path: "s1".to_string(),
                entry_type: StagedEntryType::Directory,
            },
        ];

        let result = store.stage_data_entries(StagedDataKind::Session { session_id: "s1".to_string() }, entries);

        assert!(result.is_err());
        assert_eq!(store.read("s1.md").unwrap().content, "note content");
        assert!(store.staged_data_manifests().unwrap().is_empty());
    }

    #[test]
    fn stage_data_entries_rolls_back_the_notes_root_when_the_recreate_step_fails_after_rename() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("a.md", "alpha", None, false).unwrap();
        store.compare_and_write("b.md", "beta", None, false).unwrap();
        let hash = revision_content_hash("revision content");
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();

        let entries = vec![
            StagedDataEntry { root: StagedRoot::Notes, relative_path: String::new(), entry_type: StagedEntryType::Directory },
            StagedDataEntry {
                root: StagedRoot::NoteRevisions,
                relative_path: String::new(),
                entry_type: StagedEntryType::Directory,
            },
        ];

        // Forces the failure in the exact window between a successful
        // fs::rename (the whole notes root is already sitting in trash)
        // and the follow-up fs::create_dir_all recreating it empty — the
        // second (note-revisions) entry is never even attempted.
        let result = store.stage_data_entries_with_hook(StagedDataKind::AllData, entries, |index, entry| {
            if index == 0 && entry.root == StagedRoot::Notes {
                Err(NoteFileError::Io("forced failure after rename, before recreate".to_string()))
            } else {
                Ok(())
            }
        });

        assert!(result.is_err());
        assert_eq!(store.read("a.md").unwrap().content, "alpha");
        assert_eq!(store.read("b.md").unwrap().content, "beta");
        assert_eq!(store.read_revision_object("s1", &hash).unwrap().content, "revision content");
        assert!(store.staged_data_manifests().unwrap().is_empty());
    }

    #[test]
    fn stage_data_entries_rolls_back_the_note_revisions_root_when_the_recreate_step_fails_after_rename() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("a.md", "alpha", None, false).unwrap();
        let hash = revision_content_hash("revision content");
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();

        let entries = vec![
            StagedDataEntry { root: StagedRoot::Notes, relative_path: String::new(), entry_type: StagedEntryType::Directory },
            StagedDataEntry {
                root: StagedRoot::NoteRevisions,
                relative_path: String::new(),
                entry_type: StagedEntryType::Directory,
            },
        ];

        // The notes root (index 0) completes fully first; the failure
        // lands after the note-revisions root's own rename succeeds but
        // before its recreate step runs — both entries must be rolled
        // back, not just the one that failed.
        let result = store.stage_data_entries_with_hook(StagedDataKind::AllData, entries, |index, entry| {
            if index == 1 && entry.root == StagedRoot::NoteRevisions {
                Err(NoteFileError::Io("forced failure after rename, before recreate".to_string()))
            } else {
                Ok(())
            }
        });

        assert!(result.is_err());
        assert_eq!(store.read("a.md").unwrap().content, "alpha");
        assert_eq!(store.read_revision_object("s1", &hash).unwrap().content, "revision content");
        assert!(store.staged_data_manifests().unwrap().is_empty());
    }

    #[test]
    fn rollback_failure_leaves_a_recoverable_manifest_when_the_live_path_now_differs() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "note content", None, false).unwrap();
        let entry = StagedDataEntry { root: StagedRoot::Notes, relative_path: "s1.md".to_string(), entry_type: StagedEntryType::File };
        let operation_id = "11111111-1111-1111-1111-111111111111".to_string();
        let manifest = StagedDataManifest {
            version: STAGED_DATA_MANIFEST_VERSION,
            operation_id: operation_id.clone(),
            kind: StagedDataKind::Session { session_id: "s1".to_string() },
            entries: vec![entry.clone()],
        };
        store.write_staged_data_manifest(&manifest).unwrap();
        let trash_path = store.staged_entry_trash_path(&operation_id, &entry).unwrap();
        std::fs::create_dir_all(trash_path.parent().unwrap()).unwrap();
        std::fs::rename(store.notes_dir().join("s1.md"), &trash_path).unwrap();
        // Something recreates the live path, with different bytes, before
        // rollback runs.
        store.compare_and_write("s1.md", "recreated externally", None, false).unwrap();

        let result = store.rollback_staged_entries(&operation_id, &[entry]);

        assert!(result.is_err());
        assert_eq!(store.read("s1.md").unwrap().content, "recreated externally");
        assert_eq!(store.read_staged_data_manifest(&operation_id).unwrap(), manifest);
    }

    #[test]
    fn restore_staged_data_finalizes_an_identical_duplicate_without_error() {
        let (_dir, store) = initialized_store();
        let hash = revision_content_hash("revision content");
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();
        let operation = store.stage_revision_history("s1").unwrap();
        // An identical duplicate object gets recreated in the meantime
        // (e.g. a checkpoint fired for the same content again).
        store.ensure_revision_object("s1", "revision content", &hash).unwrap();

        store.restore_staged_data(&operation).unwrap();

        assert_eq!(store.read_revision_object("s1", &hash).unwrap().content, "revision content");
        assert!(store.staged_data_manifests().unwrap().is_empty());
    }

    #[test]
    fn restore_staged_data_preserves_both_copies_when_bytes_differ() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "original", None, false).unwrap();
        let operation = store.stage_session_data("s1", Some("s1.md")).unwrap();
        // Something recreates the live note with different content before
        // the operation is restored.
        store.compare_and_write("s1.md", "recreated externally", None, false).unwrap();

        let result = store.restore_staged_data(&operation);

        assert!(result.is_err());
        assert_eq!(store.read("s1.md").unwrap().content, "recreated externally");
        // The staged manifest and its content are still there — nothing
        // was silently discarded.
        assert!(!store.staged_data_manifests().unwrap().is_empty());
    }

    #[test]
    fn restore_staged_data_preserves_partial_directory_state_without_deleting_anything() {
        let (_dir, store) = initialized_store();
        let kept_hash = revision_content_hash("kept content");
        let new_hash = revision_content_hash("new content");
        store.ensure_revision_object("s1", "kept content", &kept_hash).unwrap();
        let operation = store.stage_revision_history("s1").unwrap();
        // A new revision is created for the same session while the delete
        // is (theoretically) still in flight — the directory now exists
        // again with different content than what was staged.
        store.ensure_revision_object("s1", "new content", &new_hash).unwrap();

        store.restore_staged_data(&operation).unwrap();

        // Both the restored original and the newly-created one survive.
        assert_eq!(store.read_revision_object("s1", &kept_hash).unwrap().content, "kept content");
        assert_eq!(store.read_revision_object("s1", &new_hash).unwrap().content, "new content");
        assert!(store.staged_data_manifests().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn staged_data_manifests_rejects_a_symlinked_trash_root() {
        use std::os::unix::fs::symlink;

        let (dir, store) = initialized_store();
        std::fs::remove_dir(store.trash_dir()).unwrap();
        let outside = dir.path().join("outside-trash");
        std::fs::create_dir(&outside).unwrap();
        symlink(&outside, store.trash_dir()).unwrap();

        assert!(matches!(store.staged_data_manifests(), Err(NoteFileError::InvalidPath)));
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
    }

    #[test]
    fn staged_data_manifests_ignores_the_untyped_clear_flow_staging() {
        let (_dir, store) = initialized_store();
        store.compare_and_write("s1.md", "content", None, false).unwrap();
        // The plain, untyped single-file stage the whitespace-clear flow
        // uses — no manifest.json, so it must never surface here.
        store.stage_paths(&["s1.md".to_string()]).unwrap();

        assert!(store.staged_data_manifests().unwrap().is_empty());
    }
}
