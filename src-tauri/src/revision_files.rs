// Immutable, per-session content-addressed revision snapshot objects.
// Extends NoteFileStore (defined in note_files.rs) with ownership of
// `note-revisions/<session-id>/<sha256>.md`. Every path is derived from a
// validated session id and a validated lowercase 64-character hex SHA-256
// filename — the frontend and revision_commands.rs never supply or operate
// on an arbitrary absolute path.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::note_files::{
    atomic_replace, io_err, resolve_within, sha256_hex, validate_operation_id, validate_session_id, NoteFileError,
    NoteFileStore,
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
}
