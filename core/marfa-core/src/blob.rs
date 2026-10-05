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
use crate::http::{Call, CallBody, Http, Method};

const PREFIX: &str = "sha256:";

pub(crate) const CACHE_MOST: u64 = 512 * 1024 * 1024;

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

    /// Called under `hold`, with `kept` read under it.
    pub(crate) fn let_go(&self, hash: &str, kept: &HashSet<String>) {
        let Ok(hex) = hex_of(hash) else {
            return;
        };
        if !kept.contains(hex) {
            let _ = fs::remove_file(self.dir.join(hex));
        }
    }

    /// Called under `hold`, with `kept` read under it.
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

    pub(crate) fn held(&self, hash: &str) -> Result<Option<PathBuf>> {
        let path = self.dir.join(hex_of(hash)?);
        Ok(path.is_file().then_some(path))
    }

    /// The copy is what an upload later streams from, so a file the person
    /// changes or deletes after asking does not change what is sent.
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

    /// A process that ended mid-copy leaves its file behind, and only its age
    /// tells it from a copy still being written.
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

    fn copy_in(&self, mut from: impl Read) -> std::result::Result<(String, u64, PathBuf), Copy> {
        let mut made = fs::DirBuilder::new();
        made.recursive(true);
        // Another account on the machine reads nothing of what a key reads.
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut made, 0o700);
        made.create(&self.dir).map_err(Copy::Cache)?;
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
            Ok((format!("{PREFIX}{}", hex::encode(hasher.finalize())), size))
        })();
        match copied {
            Ok((hash, size)) => Ok((hash, size, incoming)),
            Err(error) => {
                let _ = fs::remove_file(&incoming);
                Err(error)
            }
        }
    }

    /// A rename, so a second reader sees the whole file or none of it.
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

pub(crate) fn named(hash: &str) -> Result<String> {
    let hex = hex_of(hash)?;
    Ok(format!("{PREFIX}{hex}"))
}

pub(crate) fn name_of(bytes: &[u8]) -> String {
    format!("{PREFIX}{}", hex::encode(Sha256::digest(bytes)))
}

/// The hex becomes a file name, so nothing but 64 lowercase hex digits may reach one.
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
        return Err(absent(format!("the server holds none: {text}")));
    }
    if !(200..300).contains(&reply.status) {
        return Err(http.refused(
            reply.status,
            reply.contract.is_some(),
            &text,
            reply.retry_after_seconds,
        ));
    }
    let link: serde_json::Value = serde_json::from_str(&text)?;
    let link = link
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::Decoding(format!("the link door answered no url: {text}")))?;
    // Used exactly as given and never re-serialized: an object store signs
    // its own spelling of the URL.
    url::Url::parse(link).map_err(|error| {
        CoreError::Decoding(format!(
            "the link door answered a link that is not an absolute URL ({error}): {link}"
        ))
    })?;
    pull(cache, hash, link, CACHE_MOST, LINK_IDLE)
}

/// How long a link may send nothing before the fetch is given up on. A blob
/// can be large and a link slow, so silence has a shorter bound than the
/// whole body. A stalled link must not hold the caller for the body's limit.
const LINK_IDLE: Duration = Duration::from_secs(60);

/// A bound on the whole body, far past any fetch that is going on. The reader
/// that watches for silence leaves its thread behind when it gives up, and a
/// connection that stays silent for good would hold that thread for good; this
/// ends it.
const LINK_BODY_MOST: Duration = Duration::from_secs(6 * 60 * 60);

/// What a link sends is bounded by what the cache holds: a body past it would
/// be trimmed the moment it was kept.
fn pull(cache: &Cache, hash: &str, link: &str, most: u64, idle: Duration) -> Result<PathBuf> {
    let bytes = open(link).map_err(|reason| CoreError::BytesAbsent {
        hash: hash.to_string(),
        reason,
    })?;
    cache.keep(
        hash,
        Bounded {
            inner: Idle::watching(bytes, idle),
            left: most,
        },
    )
}

/// A reader whose reads fail once the source has sent nothing for `idle`. The
/// HTTP client bounds a phase of a call, not a silence in one. The source is
/// read on a thread of its own, which is left behind when a read gives up and
/// ends when the source does, which `LINK_BODY_MOST` makes certain of.
struct Idle {
    chunks: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>,
    idle: Duration,
    held: Vec<u8>,
    at: usize,
}

impl Idle {
    fn watching(mut source: impl Read + Send + 'static, idle: Duration) -> Idle {
        let (sender, chunks) = std::sync::mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let chunk = match source.read(&mut buffer) {
                    Ok(read) => Ok(buffer[..read].to_vec()),
                    Err(error) => Err(error),
                };
                let last = !matches!(&chunk, Ok(bytes) if !bytes.is_empty());
                if sender.send(chunk).is_err() || last {
                    return;
                }
            }
        });
        Idle {
            chunks,
            idle,
            held: Vec::new(),
            at: 0,
        }
    }
}

impl Read for Idle {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        if self.at == self.held.len() {
            match self.chunks.recv_timeout(self.idle) {
                Ok(chunk) => {
                    self.held = chunk?;
                    self.at = 0;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "the link went silent",
                    ));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
            }
        }
        let n = into.len().min(self.held.len() - self.at);
        into[..n].copy_from_slice(&self.held[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

struct Bounded<R> {
    inner: R,
    left: u64,
}

impl<R: Read> Read for Bounded<R> {
    fn read(&mut self, into: &mut [u8]) -> io::Result<usize> {
        // One more than is left, so a body of exactly the limit ends cleanly
        // and a longer one is seen to be longer.
        let allowed = (self.left + 1).min(into.len() as u64) as usize;
        let read = self.inner.read(&mut into[..allowed])?;
        if read as u64 > self.left {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the link sent more than the cache holds",
            ));
        }
        self.left -= read as u64;
        Ok(read)
    }
}

/// Not through `Http`: it rebuilds a URL from segments and re-encodes them,
/// which breaks an object store's signature, and it carries the bearer,
/// which an object store's host must never see.
fn open(link: &str) -> std::result::Result<impl Read + Send + 'static, String> {
    let agent: Agent = Agent::config_builder()
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(LINK_BODY_MOST))
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
        "epub" => "application/epub+zip",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

    /// A link on a port of its own that sends `body` and then, if asked,
    /// goes quiet with the connection open.
    fn linking(body: Vec<u8>, then_silent: bool) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/bytes", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let mut request = [0u8; 4096];
                let _ = Read::read(&mut socket, &mut request);
                let length = if then_silent {
                    body.len() + 1000
                } else {
                    body.len()
                };
                let _ = write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                );
                let _ = socket.write_all(&body);
                if then_silent {
                    std::thread::sleep(Duration::from_secs(20));
                }
            }
        });
        url
    }

    #[test]
    fn a_link_that_sends_more_than_the_cache_holds_is_cut_off() {
        let bytes = vec![7u8; 1000];
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let within = Duration::from_secs(10);
        // The witness: a limit of exactly the body keeps it.
        let url = linking(bytes.clone(), false);
        assert!(pull(&cache, &hash, &url, 1000, within).is_ok());
        let url = linking(bytes, false);
        let refused = pull(&cache, &hash, &url, 999, within).unwrap_err();
        assert!(
            matches!(&refused, CoreError::BytesAbsent { reason, .. } if reason.contains("more than")),
            "{refused:?}"
        );
    }

    #[test]
    fn a_link_that_goes_quiet_is_given_up_on() {
        let bytes = vec![7u8; 100];
        let hash = name_of(&bytes);
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        let url = linking(bytes, true);
        let started = std::time::Instant::now();
        let refused =
            pull(&cache, &hash, &url, CACHE_MOST, Duration::from_millis(500)).unwrap_err();
        assert!(
            matches!(refused, CoreError::BytesAbsent { .. }),
            "{refused:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn a_link_refused_naming_no_contract_is_the_network() {
        let server = crate::scripted::Scripted::start();
        let http = Http::new(&server.url(), "k").unwrap();
        let hash = name_of(b"bytes");
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("core.sqlite"));
        let door = format!("/blobs/{hash}/url");
        server.on(&door, vec![crate::scripted::unnamed(401, "access_denied")]);
        let refused = fetch(&cache, &http, &hash).unwrap_err();
        assert!(
            matches!(refused, CoreError::Unnamed { status: 401, .. }),
            "a gateway's 401 on a blob's link was read as the credential refused: {refused:?}"
        );
        server.on(&door, vec![crate::scripted::refusal(401, "unauthorized")]);
        assert!(matches!(
            fetch(&cache, &http, &hash).unwrap_err(),
            CoreError::Unauthorized { .. }
        ));
    }

    const EMPTY: &str = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn blob_names_preserve_the_sha256_digest() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        for (bytes, expected) in [
            (&b""[..], EMPTY),
            (
                &b"hello world"[..],
                "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            ),
        ] {
            assert_eq!(name_of(bytes), expected);
            let held = cache.keep(expected, bytes).unwrap();
            assert_eq!(held.file_name().unwrap(), hex_of(expected).unwrap());
            assert_eq!(fs::read(held).unwrap(), bytes);
        }
    }

    #[test]
    fn a_hash_names_a_file_and_nothing_else_does() {
        assert!(hex_of(EMPTY).is_ok());
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
            mime_type_for(Path::new("novel.epub"), None),
            "application/epub+zip"
        );
        assert_eq!(
            mime_type_for(Path::new("lease.docx"), None),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(
            mime_type_for(Path::new("budget.xlsx"), None),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        assert_eq!(
            mime_type_for(Path::new("talk.PPTX"), None),
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
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
    fn a_half_written_copy_is_swept_once_it_is_old() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::beside(&dir.path().join("store.sqlite"));
        fs::create_dir_all(&cache.dir).unwrap();
        let left = cache.dir.join(".incoming-left-by-a-crash");
        fs::write(&left, b"half").unwrap();
        let held = cache.keep(EMPTY, &b""[..]).unwrap();
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

        cache.trim(25, &HashSet::from([waiting]));
        assert!(!oldest.exists(), "the bytes read longest ago were kept");
        assert!(named.exists(), "bytes an upload still names were taken");
        assert!(!older.exists(), "the trim stopped before the rest fit");
        assert!(newest.exists(), "the trim went past what it had to take");
        assert!(
            incoming.exists(),
            "a copy still arriving was taken by a trim"
        );

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
