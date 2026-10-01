//! A blob's bytes, held beside the working copy and fetched when a caller
//! asks for them (`device.md` 30, 37, 38).
//!
//! Hydration never comes here (`device.md` 28): an item carries its blob's
//! name, and a slice of a thousand photos is a thousand names until someone
//! opens one.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use ureq::Agent;

use crate::Result;
use crate::error::CoreError;
use crate::http::{Call, CallBody, Http, Method, refusal};

const PREFIX: &str = "sha256:";

/// The most bytes the cache keeps of blobs nothing waits to send
/// (`device.md` 37). Room for a working set of photos and documents a
/// person opens, and still a small part of a phone's storage; the cache is
/// named by content, so bytes evicted are fetched again when asked for.
pub(crate) const CACHE_MOST: u64 = 512 * 1024 * 1024;

/// Where a working copy's bytes live: a folder beside its file, one file per
/// blob, named by the hex of its hash.
pub(crate) struct Cache {
    dir: PathBuf,
    /// Held while bytes are taken in for an upload and queued, and while the
    /// cache is trimmed, so a trim never takes bytes an upload is about to
    /// name.
    settling: Mutex<()>,
}

/// Why bytes did not arrive whole: the source failed, or the cache did.
enum Copy {
    Source(io::Error),
    Cache(io::Error),
}

impl Cache {
    pub(crate) fn beside(store: &Path) -> Cache {
        let mut name = store.as_os_str().to_owned();
        name.push(".blobs");
        Cache {
            dir: PathBuf::from(name),
            settling: Mutex::new(()),
        }
    }

    /// Holds off every trim until the guard is dropped.
    pub(crate) fn hold(&self) -> MutexGuard<'_, ()> {
        self.settling
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Marks held bytes as just read, so a trim takes the bytes read longest
    /// ago first.
    pub(crate) fn touch(&self, path: &Path) {
        let _ = File::options()
            .append(true)
            .open(path)
            .and_then(|file| file.set_modified(SystemTime::now()));
    }

    /// Takes away the held copy of `hash`, unless `kept` names it. Its bytes
    /// are named by their content, so a later ask fetches them again. Called
    /// under `hold`, with `kept` read under it.
    pub(crate) fn let_go(&self, hash: &str, kept: &HashSet<String>) {
        let Ok(hex) = hex_of(hash) else {
            return;
        };
        if !kept.contains(hex) {
            let _ = fs::remove_file(self.dir.join(hex));
        }
    }

    /// Takes away the bytes read longest ago until what is left is at most
    /// `most` bytes, never bytes whose hex `kept` names. Half-written copies
    /// are `sweep_incoming`'s. Called under `hold`, with `kept` read under it.
    pub(crate) fn trim(&self, most: u64, kept: &HashSet<String>) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        let mut held: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        let mut total = 0u64;
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !metadata.is_file() || name.starts_with(".incoming-") {
                continue;
            }
            total += metadata.len();
            if !kept.contains(name.as_ref()) {
                let read = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                held.push((read, metadata.len(), entry.path()));
            }
        }
        held.sort();
        for (_, size, path) in held {
            if total <= most {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                total -= size;
            }
        }
    }

    /// The held file for `hash`, where one is held.
    pub(crate) fn held(&self, hash: &str) -> Result<Option<PathBuf>> {
        let path = self.dir.join(hex_of(hash)?);
        Ok(path.is_file().then_some(path))
    }

    /// Copies a file in under the hash of what was read, and answers that
    /// hash. The copy is what an upload later streams from, so a file the
    /// person changes or deletes after asking does not change what is sent.
    ///
    /// An empty file is refused: the server holds no empty blob, so an
    /// upload of one would be refused on its first answer, and the file item
    /// waiting on it with it.
    pub(crate) fn take(&self, source: &Path) -> Result<String> {
        let unreadable = |error: io::Error| {
            CoreError::Invalid(format!("{} cannot be read: {error}", source.display()))
        };
        let file = File::open(source).map_err(unreadable)?;
        let (hash, size, incoming) = self.copy_in(file).map_err(|error| match error {
            Copy::Source(error) => unreadable(error),
            Copy::Cache(error) => self.unwritable(error),
        })?;
        if size == 0 {
            let _ = fs::remove_file(&incoming);
            return Err(CoreError::Invalid(format!(
                "{} is empty, and the server holds no empty blob",
                source.display()
            )));
        }
        self.settle(&incoming, &hash)?;
        Ok(hash)
    }

    /// Takes away bytes a fetch or a copy left half written, where they are
    /// old enough that nothing is still writing them: a process that ended
    /// mid-copy leaves its file behind and nothing else ever will.
    pub(crate) fn sweep_incoming(&self, older_than: Duration) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let stale = entry
                .file_name()
                .to_string_lossy()
                .starts_with(".incoming-")
                && entry
                    .metadata()
                    .and_then(|metadata| metadata.modified())
                    .is_ok_and(|modified| modified.elapsed().is_ok_and(|age| age > older_than));
            if stale {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    /// Keeps fetched bytes, and only once they hash to the name they were
    /// asked for. A short or altered body never lands under a name it does
    /// not have.
    fn keep(&self, hash: &str, bytes: impl Read) -> Result<PathBuf> {
        let (found, _, incoming) = self.copy_in(bytes).map_err(|error| match error {
            Copy::Source(error) => CoreError::BytesAbsent {
                hash: hash.to_string(),
                reason: format!("the bytes stopped arriving: {error}"),
            },
            Copy::Cache(error) => self.unwritable(error),
        })?;
        if found != hash {
            let _ = fs::remove_file(&incoming);
            return Err(CoreError::Decoding(format!(
                "the bytes fetched for {hash} hash to {found}, so they are not the blob asked for"
            )));
        }
        self.settle(&incoming, hash)
    }

    /// Streams into a file under a name no reader looks for, hashing as it
    /// goes.
    fn copy_in(&self, mut from: impl Read) -> std::result::Result<(String, u64, PathBuf), Copy> {
        fs::create_dir_all(&self.dir).map_err(Copy::Cache)?;
        let incoming = self.dir.join(format!(".incoming-{}", uuid::Uuid::now_v7()));
        let copied = (|| {
            let mut to = File::create(&incoming).map_err(Copy::Cache)?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 64 * 1024];
            let mut size = 0u64;
            loop {
                let read = match from.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => return Err(Copy::Source(error)),
                };
                hasher.update(&buffer[..read]);
                to.write_all(&buffer[..read]).map_err(Copy::Cache)?;
                size += read as u64;
            }
            to.sync_all().map_err(Copy::Cache)?;
            Ok((format!("{PREFIX}{:x}", hasher.finalize()), size))
        })();
        match copied {
            Ok((hash, size)) => Ok((hash, size, incoming)),
            Err(error) => {
                let _ = fs::remove_file(&incoming);
                Err(error)
            }
        }
    }

    /// Moves a verified copy under its name. A rename, so a second reader
    /// sees the whole file or none of it.
    fn settle(&self, incoming: &Path, hash: &str) -> Result<PathBuf> {
        let path = self.dir.join(hex_of(hash)?);
        fs::rename(incoming, &path).map_err(|error| {
            let _ = fs::remove_file(incoming);
            self.unwritable(error)
        })?;
        Ok(path)
    }

    fn unwritable(&self, error: io::Error) -> CoreError {
        CoreError::Store(format!(
            "the bytes cannot be held in {}: {error}",
            self.dir.display()
        ))
    }
}

/// A blob's name as the server writes it, from the name or from its hex
/// alone, which the server's own doors take too.
pub(crate) fn named(hash: &str) -> Result<String> {
    let hex = hex_of(hash)?;
    Ok(format!("{PREFIX}{hex}"))
}

/// The SHA-256 name of bytes in hand.
pub(crate) fn name_of(bytes: &[u8]) -> String {
    format!("{PREFIX}{:x}", Sha256::digest(bytes))
}

/// The hex a hash names, refusing anything that is not 64 lowercase hex
/// digits, with or without `sha256:` before them. The hex becomes a file
/// name, so nothing else may reach one.
pub(crate) fn hex_of(hash: &str) -> Result<&str> {
    Some(hash.strip_prefix(PREFIX).unwrap_or(hash))
        .filter(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        .ok_or_else(|| {
            CoreError::Invalid(format!(
                "{hash} is not a blob's name; a blob is named sha256: and 64 lowercase hex digits"
            ))
        })
}

/// Fetches a blob's bytes into the cache: the link from the server, then
/// the bytes from the link. `hash` is the name as the server writes it.
pub(crate) fn fetch(cache: &Cache, http: &Http, hash: &str) -> Result<PathBuf> {
    let absent = |reason: String| CoreError::BytesAbsent {
        hash: hash.to_string(),
        reason,
    };
    let reply = http
        .call(Call {
            method: Method::Get,
            segments: &["blobs", hash, "url"],
            params: &[],
            headers: &[],
            body: CallBody::None,
            credential: true,
            stream: false,
        })
        .map_err(|error| match error {
            CoreError::Network(reason) => absent(format!("the server cannot be reached: {reason}")),
            other => other,
        })?;
    let text = reply.body;
    // Only the server's own 404, naming its contract: a proxy's says nothing
    // about which bytes the server holds.
    if reply.status == 404 && reply.contract.is_some() {
        // The server holds no bytes by this name. The item naming them is
        // still whole, which is what absent bytes are (`device.md` 30).
        return Err(absent(format!("the server holds none: {text}")));
    }
    if !(200..300).contains(&reply.status) {
        return Err(refusal(reply.status, &text, reply.retry_after_seconds));
    }
    let link: serde_json::Value = serde_json::from_str(&text)?;
    let link = link
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::Decoding(format!("the link door answered no url: {text}")))?;
    // Used exactly as given and never re-serialized: an object store signs
    // its own spelling of the URL. The door answers an absolute link, and
    // anything else is an answer this device cannot read.
    url::Url::parse(link).map_err(|error| {
        CoreError::Decoding(format!(
            "the link door answered a link that is not an absolute URL ({error}): {link}"
        ))
    })?;
    let bytes = open(link).map_err(absent)?;
    cache.keep(hash, bytes)
}

/// Opens a link exactly as the server gave it, with no credential.
///
/// Not through `Http`, for two reasons: `Http` rebuilds a URL from segments
/// and re-encodes them, which breaks an object store's signature, and it
/// carries the bearer, which an object store's host must never see.
fn open(link: &str) -> std::result::Result<impl Read, String> {
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .build()
        .into();
    let response = agent
        .get(link)
        .call()
        .map_err(|error| format!("the link cannot be reached: {error}"))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("the link answered {status}"));
    }
    Ok(response.into_body().into_reader())
}

/// The MIME type a file is sent under: the one given, else its extension's,
/// else bytes.
pub fn mime_type_for(path: &Path, given: Option<&str>) -> String {
    if let Some(given) = given {
        return given.to_string();
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "csv" => "text/csv",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// The file type an attachment becomes: the one given, else the subtype its
/// MIME type names, else `core.file`.
pub fn file_type_for(mime_type: &str, given: Option<&str>) -> String {
    if let Some(given) = given {
        return given.to_string();
    }
    match mime_type.split('/').next().unwrap_or("") {
        "image" => "core.file.image",
        "audio" => "core.file.audio",
        "video" => "core.file.video",
        _ => "core.file",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY: &str = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn a_hash_names_a_file_and_nothing_else_does() {
        assert!(hex_of(EMPTY).is_ok());
        // The hex alone is the same name, as the server's doors take it.
        assert_eq!(
            named("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855").unwrap(),
            EMPTY
        );
        for bad in [
            "sha256:../../etc/passwd",
            "../../etc/passwd",
            "sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
            "sha256:e3b0",
        ] {
            assert!(hex_of(bad).is_err(), "{bad} was taken for a blob's name");
        }
    }

    /// Bytes land under their own hash, and bytes that hash to another name
    /// never land: the witness is the same bytes kept under the right name.
    #[test]
    fn bytes_are_kept_only_under_the_name_they_hash_to() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let other = "sha256:".to_string() + &"a".repeat(64);
        assert!(matches!(
            cache.keep(&other, &b""[..]),
            Err(CoreError::Decoding(_))
        ));
        assert_eq!(cache.held(&other).unwrap(), None);
        let kept = cache.keep(EMPTY, &b""[..]).unwrap();
        assert_eq!(cache.held(EMPTY).unwrap(), Some(kept));
        // Nothing left behind under a name no reader looks for.
        let names: Vec<_> = fs::read_dir(&cache.dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from(hex_of(EMPTY).unwrap())]
        );
    }

    #[test]
    fn an_attachment_is_typed_by_what_it_is_unless_told() {
        assert_eq!(
            mime_type_for(Path::new("scan.PDF"), None),
            "application/pdf"
        );
        assert_eq!(
            mime_type_for(Path::new("x.png"), Some("image/webp")),
            "image/webp"
        );
        assert_eq!(
            mime_type_for(Path::new("noext"), None),
            "application/octet-stream"
        );
        assert_eq!(file_type_for("application/pdf", None), "core.file");
        assert_eq!(file_type_for("audio/mpeg", None), "core.file.audio");
        assert_eq!(file_type_for("image/png", None), "core.file.image");
        assert_eq!(file_type_for("image/png", Some("user.scan")), "user.scan");
    }

    #[test]
    fn a_file_taken_in_is_named_by_what_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("hello.txt");
        fs::write(&source, b"hello").unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let hash = cache.take(&source).unwrap();
        assert_eq!(
            hash,
            "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert_eq!(hash, name_of(b"hello"));
        assert_eq!(
            fs::read(cache.held(&hash).unwrap().unwrap()).unwrap(),
            b"hello"
        );

        // An empty file is refused, and leaves nothing behind.
        let empty = dir.path().join("empty.png");
        fs::write(&empty, b"").unwrap();
        assert!(matches!(cache.take(&empty), Err(CoreError::Invalid(_))));
        assert_eq!(cache.held(EMPTY).unwrap(), None);
    }

    #[test]
    fn a_half_written_copy_is_swept_once_it_is_old() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        fs::create_dir_all(&cache.dir).unwrap();
        let left = cache.dir.join(".incoming-left-by-a-crash");
        fs::write(&left, b"half").unwrap();
        let held = cache.keep(EMPTY, &b""[..]).unwrap();
        // Young enough that something may still be writing it: kept.
        cache.sweep_incoming(Duration::from_secs(3600));
        assert!(left.exists());
        cache.sweep_incoming(Duration::ZERO);
        assert!(!left.exists());
        assert!(
            held.exists(),
            "the sweep took held bytes, which only a half-written copy may lose"
        );
    }

    /// Bytes kept under their name, read `ago` seconds ago.
    fn kept(cache: &Cache, bytes: &[u8], ago: u64) -> (String, PathBuf) {
        let hash = name_of(bytes);
        let path = cache.keep(&hash, bytes).unwrap();
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(ago))
            .unwrap();
        (hex_of(&hash).unwrap().to_string(), path)
    }

    #[test]
    fn a_trim_takes_the_bytes_read_longest_ago_until_the_rest_fit() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (_, oldest) = kept(&cache, b"aaaaaaaaaa", 300);
        let (waiting, named) = kept(&cache, b"bbbbbbbbbb", 200);
        let (_, older) = kept(&cache, b"cccccccccc", 100);
        let (_, newest) = kept(&cache, b"dddddddddd", 0);
        let incoming = cache.dir.join(".incoming-still-arriving");
        fs::write(&incoming, b"half").unwrap();

        // Forty bytes held and twenty-five allowed: the oldest two go but
        // for the one an upload names, so the next oldest goes in its place.
        cache.trim(25, &HashSet::from([waiting]));
        assert!(!oldest.exists(), "the bytes read longest ago were kept");
        assert!(named.exists(), "bytes an upload still names were taken");
        assert!(!older.exists(), "the trim stopped before the rest fit");
        assert!(newest.exists(), "the trim went past what it had to take");
        assert!(
            incoming.exists(),
            "a copy still arriving was taken by a trim"
        );

        // A read moves bytes to the back of the line.
        let (_, first) = kept(&cache, b"eeeeeeeeee", 500);
        cache.touch(&first);
        cache.trim(20, &HashSet::new());
        assert!(first.exists(), "bytes just read were taken first");
        assert!(
            !named.exists(),
            "the trim took something other than the bytes read longest ago"
        );
    }

    #[test]
    fn bytes_let_go_are_gone_unless_an_upload_names_them() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let (hex, path) = kept(&cache, b"held", 0);
        let hash = format!("{PREFIX}{hex}");
        cache.let_go(&hash, &HashSet::from([hex.clone()]));
        assert!(path.exists(), "bytes an upload still names were let go");
        cache.let_go(&hash, &HashSet::new());
        assert_eq!(cache.held(&hash).unwrap(), None);
    }
}
