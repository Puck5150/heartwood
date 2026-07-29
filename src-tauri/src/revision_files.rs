// Immutable, per-session content-addressed revision snapshot objects.
// Extends NoteFileStore (defined in note_files.rs) with ownership of
// `note-revisions/<session-id>/<sha256>.md`. Every path is derived from a
// validated session id and a validated lowercase 64-character hex SHA-256
// filename — the frontend and revision_commands.rs never supply or operate
// on an arbitrary absolute path.

use std::fs;
use std::path::PathBuf;

use crate::note_files::{atomic_replace, io_err, resolve_within, sha256_hex, validate_session_id, NoteFileError, NoteFileStore};

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
}
