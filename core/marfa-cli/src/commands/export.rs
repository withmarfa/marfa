use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use clap::{Args, ValueEnum};
use flate2::write::GzDecoder;
use serde_json::{Value, json};

use super::{StateFilter, state_list};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Export the instance's data: items as NDJSON, or everything as an archive.
#[derive(Debug, Default, Args)]
pub struct ExportArgs {
    /// `ndjson` for items one per line, `archive` for the whole instance.
    #[arg(long)]
    pub format: Option<ExportFormat>,
    /// Where to write. Omitted, the export goes to stdout. The path is
    /// replaced only by an export that ends whole, and for an archive only by
    /// one that lacks no blobs.
    #[arg(long, value_name = "PATH")]
    pub output: Option<PathBuf>,
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// A state to answer; repeat it or separate states with commas. `any` is
    /// every state, and is given alone. Unset answers every state but the bin.
    #[arg(long, value_delimiter = ',')]
    pub state: Vec<StateFilter>,
    /// The source the items were written under.
    #[arg(long)]
    pub source: Option<String>,
    /// Exclusive lower bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_after: Option<String>,
    /// Exclusive upper bound on the item's own time, RFC 3339.
    #[arg(long, value_name = "TIME")]
    pub occurred_before: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum ExportFormat {
    Ndjson,
    Archive,
}

impl ExportFormat {
    fn as_str(self) -> &'static str {
        match self {
            ExportFormat::Ndjson => "ndjson",
            ExportFormat::Archive => "archive",
        }
    }
}

/// How long an archive export waits for the server's first byte. The server
/// checks the whole selection before it sends an archive, so the wait grows
/// with the instance (about two minutes for 250,000 items).
const ARCHIVE_WAIT: Duration = Duration::from_secs(30 * 60);

/// How long the wait goes unremarked, and how often it is remarked on after.
const FIRST_REMARK: Duration = Duration::from_secs(5);
const REMARK_EVERY: Duration = Duration::from_secs(15);

#[cfg(test)]
pub fn request(args: &ExportArgs) -> Result<Request, CliError> {
    request_waiting(args, ARCHIVE_WAIT)
}

fn request_waiting(args: &ExportArgs, archive_wait: Duration) -> Result<Request, CliError> {
    let request = Request::get(&["export"])
        .query_opt("format", args.format.map(ExportFormat::as_str))
        .query_opt("type", args.type_.clone())
        .query_opt("state", state_list(&args.state)?)
        .query_opt("source", args.source.clone())
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .streamed();
    Ok(if args.format == Some(ExportFormat::Archive) {
        request.awaiting(archive_wait)
    } else {
        request
    })
}

pub fn run(args: ExportArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    run_waiting(args, remote, out, ARCHIVE_WAIT)
}

fn run_waiting(
    args: ExportArgs,
    remote: &Remote,
    out: &Printer,
    archive_wait: Duration,
) -> Result<(), CliError> {
    let request = request_waiting(&args, archive_wait)?;
    let (content_type, reader) = {
        let _remarks = (args.format == Some(ExportFormat::Archive)).then(|| {
            Remarks::every(FIRST_REMARK, REMARK_EVERY, |waited| {
                eprintln!(
                    "still preparing the archive ({}s): the server checks every row before it sends the first byte",
                    waited.as_secs()
                );
            })
        });
        remote.stream(&request)?
    };
    let mut reader = ManifestTap::new(reader, args.format == Some(ExportFormat::Archive));
    match &args.output {
        Some(path) => {
            let written = write_whole(path, &mut reader)?;
            out.report(
                &json!({ "path": path, "size_bytes": written, "content_type": content_type }),
                || {
                    format!(
                        "{written} byte(s) of {content_type} into {}",
                        path.display()
                    )
                },
            )
        }
        None => {
            // Raw even under `--json`: an archive is bytes to redirect.
            let mut stdout = io::stdout().lock();
            io::copy(&mut reader, &mut stdout)?;
            stdout.flush()?;
            reader.whole()
        }
    }
}

/// Writes the export to a file beside `path`, then names that file `path`
/// only once the stream has ended whole and, for an archive, lists no missing
/// blobs, so an export cut short, or one that lacks files, never replaces an
/// earlier backup at `path`.
///
/// An archive that lacks blobs is kept whole beside `path` as
/// `<path>.incomplete`, replacing only an earlier file of that name, and is
/// answered as [`CliError::ArchiveKeptApart`]. An archive whose manifest
/// cannot be read is not an archive, so it is removed like a cut stream.
fn write_whole(path: &Path, reader: &mut ManifestTap<impl Read>) -> Result<u64, CliError> {
    let name = path
        .file_name()
        .ok_or_else(|| CliError::Invalid(format!("{} names no file", path.display())))?;
    let partial = path.with_file_name(format!(
        ".{}.partial-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    let mut file = std::fs::File::create(&partial).map_err(|error| {
        CliError::Invalid(format!("cannot write {}: {error}", partial.display()))
    })?;
    let copied = io::copy(reader, &mut file).and_then(|written| {
        file.sync_all()?;
        Ok(written)
    });
    drop(file);
    let written = match copied {
        Ok(written) => written,
        Err(error) => {
            return Err(CliError::Io(io::Error::new(
                error.kind(),
                format!(
                    "{error}: the export ended early, so nothing was written to {}, {}",
                    path.display(),
                    removed(&partial)
                ),
            )));
        }
    };
    match reader.whole() {
        Ok(()) => {
            std::fs::rename(&partial, path).map_err(|error| {
                let _ = std::fs::remove_file(&partial);
                CliError::Invalid(format!("cannot write {}: {error}", path.display()))
            })?;
            Ok(written)
        }
        Err(CliError::ArchiveLacksBlobs(missing)) => {
            let incomplete = path.with_file_name(format!("{}.incomplete", name.to_string_lossy()));
            let target_held = std::fs::symlink_metadata(path).is_ok();
            // A move that is refused (a directory at the name, say) keeps the
            // bytes where they are, and the answer still names the blobs.
            let (kept, refused) = match std::fs::rename(&partial, &incomplete) {
                Ok(()) => (incomplete.clone(), None),
                Err(error) => (partial, Some(error.to_string())),
            };
            Err(CliError::ArchiveKeptApart {
                missing,
                target: path.to_path_buf(),
                incomplete,
                kept,
                target_held,
                refused,
            })
        }
        Err(error) => Err(CliError::Invalid(format!(
            "{error}, so nothing was written to {}, {}",
            path.display(),
            removed(&partial)
        ))),
    }
}

/// Removes the partial file and says what became of it.
fn removed(partial: &Path) -> String {
    match std::fs::remove_file(partial) {
        Ok(()) => "and the partial file was removed".to_string(),
        Err(_) => format!("and the partial file is left at {}", partial.display()),
    }
}

/// Says something on a thread of its own while it is held, first after
/// `first` and then every `every`, and stops, joined, when dropped.
struct Remarks {
    done: Arc<(Mutex<bool>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}

impl Remarks {
    fn every(
        first: Duration,
        every: Duration,
        mut say: impl FnMut(Duration) + Send + 'static,
    ) -> Remarks {
        let done = Arc::new((Mutex::new(false), Condvar::new()));
        let thread = {
            let done = Arc::clone(&done);
            std::thread::spawn(move || {
                let started = std::time::Instant::now();
                let (finished, wake) = &*done;
                let mut pause = first;
                loop {
                    let guard = finished.lock().unwrap_or_else(|e| e.into_inner());
                    let (guard, _) = wake
                        .wait_timeout_while(guard, pause, |finished| !*finished)
                        .unwrap_or_else(|e| e.into_inner());
                    if *guard {
                        return;
                    }
                    drop(guard);
                    say(started.elapsed());
                    pause = every;
                }
            })
        };
        Remarks {
            done,
            thread: Some(thread),
        }
    }
}

impl Drop for Remarks {
    fn drop(&mut self) {
        let (finished, wake) = &*self.done;
        *finished.lock().unwrap_or_else(|e| e.into_inner()) = true;
        wake.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

const TAR_BLOCK: usize = 512;

/// Reads the archive's first entry, its `manifest.json`, out of the bytes as
/// they pass, so the export can say what the archive lacks without reading
/// what it wrote a second time, which it cannot do on stdout.
struct ManifestTap<R> {
    inner: R,
    archive: bool,
    /// Until the manifest is whole, what the gzip stream decompresses to.
    decoder: Option<GzDecoder<Vec<u8>>>,
    manifest: Option<Vec<u8>>,
}

impl<R: Read> ManifestTap<R> {
    fn new(inner: R, archive: bool) -> Self {
        ManifestTap {
            inner,
            archive,
            decoder: archive.then(|| GzDecoder::new(Vec::new())),
            manifest: None,
        }
    }

    /// The manifest's bytes once the tar holds them all: a header naming
    /// `manifest.json` and its size, then that many bytes.
    fn take_manifest(tar: &[u8]) -> Option<Option<Vec<u8>>> {
        if tar.len() < TAR_BLOCK {
            return None;
        }
        let name = &tar[..100];
        let name = &name[..name.iter().position(|b| *b == 0).unwrap_or(100)];
        if name != b"manifest.json" {
            return Some(None);
        }
        let field = String::from_utf8_lossy(&tar[124..136]);
        let Ok(size) = usize::from_str_radix(field.trim_matches(['\0', ' ']), 8) else {
            return Some(None);
        };
        let end = TAR_BLOCK.checked_add(size)?;
        (tar.len() >= end).then(|| Some(tar[TAR_BLOCK..end].to_vec()))
    }

    /// The blobs the manifest lists under `missing_blobs`, refused when there
    /// are any. An archive whose manifest cannot be read is refused too: the
    /// server writes it first, so a stream without one is not an archive.
    fn whole(&self) -> Result<(), CliError> {
        if !self.archive {
            return Ok(());
        }
        let unreadable =
            || CliError::Invalid("the archive's manifest.json could not be read".into());
        let manifest: Value =
            serde_json::from_slice(self.manifest.as_deref().ok_or_else(unreadable)?)
                .map_err(|_| unreadable())?;
        let mut missing: Vec<String> = manifest
            .get("missing_blobs")
            .and_then(Value::as_object)
            .map(|blobs| blobs.keys().cloned().collect())
            .unwrap_or_default();
        if missing.is_empty() {
            return Ok(());
        }
        missing.sort();
        Err(CliError::ArchiveLacksBlobs(missing))
    }
}

impl<R: Read> Read for ManifestTap<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        if let Some(decoder) = &mut self.decoder {
            // A stream the decoder cannot read is left to the reader of the
            // file; it is not the export's to judge mid-copy.
            if decoder
                .write_all(&buffer[..read])
                .and_then(|()| decoder.flush())
                .is_err()
            {
                self.decoder = None;
            } else if let Some(found) = Self::take_manifest(decoder.get_ref()) {
                self.manifest = found;
                self.decoder = None;
            }
        }
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};

    /// A gzip-compressed tar whose first entry is `manifest.json`, followed by
    /// an entry the tap must not need.
    fn archive(manifest: &str) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, body) in [
            ("manifest.json", manifest.as_bytes()),
            ("items.ndjson", b"{}\n".as_slice()),
        ] {
            let mut header = [0u8; TAR_BLOCK];
            header[..name.len()].copy_from_slice(name.as_bytes());
            let size = format!("{:011o}\0", body.len());
            header[124..136].copy_from_slice(size.as_bytes());
            tar.extend_from_slice(&header);
            tar.extend_from_slice(body);
            tar.resize(tar.len().div_ceil(TAR_BLOCK) * TAR_BLOCK, 0);
        }
        tar.resize(tar.len() + 2 * TAR_BLOCK, 0);
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&tar).unwrap();
        gzip.finish().unwrap()
    }

    /// Copies `bytes` through the tap in small reads, as a stream arrives.
    fn tapped(bytes: Vec<u8>, archive: bool) -> Result<Vec<u8>, CliError> {
        struct Trickle(io::Cursor<Vec<u8>>);
        impl Read for Trickle {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let end = buffer.len().min(7);
                self.0.read(&mut buffer[..end])
            }
        }
        let mut tap = ManifestTap::new(Trickle(io::Cursor::new(bytes)), archive);
        let mut copied = Vec::new();
        io::copy(&mut tap, &mut copied).unwrap();
        tap.whole().map(|()| copied)
    }

    #[test]
    fn names_the_blobs_a_manifest_lists_as_missing_and_passes_the_bytes_on() {
        let bytes =
            archive(r#"{"version":0,"blobs":{},"missing_blobs":{"sha256:bb":{},"sha256:aa":{}}}"#);
        match tapped(bytes.clone(), true) {
            Err(CliError::ArchiveLacksBlobs(missing)) => {
                assert_eq!(missing, ["sha256:aa", "sha256:bb"]);
            }
            other => panic!("expected blobs_missing, got {other:?}"),
        }
        let whole = archive(r#"{"version":0,"blobs":{"sha256:aa":{}},"missing_blobs":{}}"#);
        assert_eq!(tapped(whole.clone(), true).unwrap(), whole);
    }

    /// A source that hands over `good` bytes and then fails, as a stream cut
    /// short by the server does.
    struct CutShort(usize);
    impl Read for CutShort {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.0 == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "cut short"));
            }
            let n = buffer.len().min(self.0);
            buffer[..n].fill(b'x');
            self.0 -= n;
            Ok(n)
        }
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marfa-export-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn leaves_nothing_at_the_path_when_the_stream_is_cut_and_says_so() {
        let dir = scratch();
        let path = dir.join("backup.tar.gz");
        // The witness: an earlier archive at the path is neither cut nor replaced.
        std::fs::write(&path, b"an earlier archive").unwrap();
        let error =
            write_whole(&path, &mut ManifestTap::new(CutShort(100_000), false)).unwrap_err();
        assert!(matches!(error, CliError::Io(_)), "{error:?}");
        assert!(error.to_string().contains("nothing was written"), "{error}");
        assert!(error.to_string().contains("removed"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"an earlier archive");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "a partial file is left: {left:?}");

        let written = write_whole(
            &path,
            &mut ManifestTap::new(io::Cursor::new(b"whole".to_vec()), false),
        )
        .unwrap();
        assert_eq!(written, 5);
        assert_eq!(std::fs::read(&path).unwrap(), b"whole");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn written(path: &Path, bytes: &[u8]) -> Result<u64, CliError> {
        write_whole(
            path,
            &mut ManifestTap::new(io::Cursor::new(bytes.to_vec()), true),
        )
    }

    #[test]
    fn keeps_an_archive_that_lacks_blobs_beside_the_path_and_leaves_the_earlier_file() {
        let hashes: Vec<String> = (0..12).map(|n| format!("sha256:{n:02}")).collect();
        let listed = hashes
            .iter()
            .map(|hash| format!(r#""{hash}":{{}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let lacking = archive(&format!(
            r#"{{"version":0,"blobs":{{}},"missing_blobs":{{{listed}}}}}"#
        ));
        let whole = archive(r#"{"version":0,"blobs":{"sha256:aa":{}},"missing_blobs":{}}"#);

        let dir = scratch();
        let path = dir.join("nightly.tar.gz");
        let incomplete = dir.join("nightly.tar.gz.incomplete");

        // The earlier complete archive stays byte for byte, an earlier file
        // of the incomplete name is the only thing replaced.
        std::fs::write(&path, &whole).unwrap();
        std::fs::write(&incomplete, b"an earlier incomplete archive").unwrap();
        let error = written(&path, &lacking).unwrap_err();
        match &error {
            CliError::ArchiveKeptApart {
                missing,
                target,
                incomplete: wanted,
                kept,
                target_held,
                refused,
            } => {
                assert_eq!(missing, &hashes);
                assert_eq!((target, wanted, kept), (&path, &incomplete, &incomplete));
                assert!(refused.is_none());
                assert!(target_held);
            }
            other => panic!("expected the archive kept apart, got {other:?}"),
        }
        let message = error.to_string();
        assert!(message.contains(&path.display().to_string()), "{message}");
        assert!(
            message.contains(&incomplete.display().to_string()),
            "{message}"
        );
        assert!(message.contains("sha256:09 and 2 more"), "{message}");
        assert!(message.contains("still holds the file"), "{message}");
        assert_eq!(error.exit(), crate::error::Exit::Refused);
        assert_eq!(std::fs::read(&path).unwrap(), whole);
        assert_eq!(std::fs::read(&incomplete).unwrap(), lacking);
        assert_eq!(
            names_in(&dir),
            ["nightly.tar.gz", "nightly.tar.gz.incomplete"]
        );

        // The witness: a whole archive replaces the path and leaves no
        // partial file; the earlier incomplete archive is not its to remove.
        let newer = archive(r#"{"version":0,"blobs":{"sha256:bb":{}},"missing_blobs":{}}"#);
        assert_eq!(written(&path, &newer).unwrap(), newer.len() as u64);
        assert_eq!(std::fs::read(&path).unwrap(), newer);
        assert_eq!(
            names_in(&dir),
            ["nightly.tar.gz", "nightly.tar.gz.incomplete"]
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_an_archive_that_lacks_blobs_beside_a_path_where_nothing_was_and_says_so() {
        let lacking = archive(r#"{"version":0,"blobs":{},"missing_blobs":{"sha256:aa":{}}}"#);
        let dir = scratch();
        let path = dir.join("first.tar.gz");
        let error = written(&path, &lacking).unwrap_err();
        assert!(
            matches!(
                error,
                CliError::ArchiveKeptApart {
                    target_held: false,
                    ..
                }
            ),
            "{error:?}"
        );
        let message = error.to_string();
        assert!(message.contains("nothing was written to"), "{message}");
        assert!(message.contains("nothing there lacks files"), "{message}");
        assert!(!path.exists(), "an archive that lacks files is at the path");
        assert_eq!(
            std::fs::read(dir.join("first.tar.gz.incomplete")).unwrap(),
            lacking
        );
        assert_eq!(names_in(&dir), ["first.tar.gz.incomplete"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reports_the_blobs_and_keeps_the_bytes_when_the_incomplete_name_cannot_be_taken() {
        let lacking = archive(r#"{"version":0,"blobs":{},"missing_blobs":{"sha256:aa":{}}}"#);
        let whole = archive(r#"{"version":0,"blobs":{"sha256:bb":{}},"missing_blobs":{}}"#);
        let dir = scratch();
        let path = dir.join("nightly.tar.gz");
        let incomplete = dir.join("nightly.tar.gz.incomplete");
        std::fs::write(&path, &whole).unwrap();
        std::fs::create_dir(&incomplete).unwrap();
        let error = written(&path, &lacking).unwrap_err();
        let CliError::ArchiveKeptApart {
            missing,
            kept,
            refused,
            ..
        } = &error
        else {
            panic!("expected the archive kept apart, got {error:?}");
        };
        assert_eq!(missing, &["sha256:aa"]);
        assert!(refused.is_some(), "{error:?}");
        assert_eq!(error.exit(), crate::error::Exit::Refused);
        assert_eq!(error.code(), "blobs_missing");
        let message = error.to_string();
        assert!(message.contains("sha256:aa"), "{message}");
        assert!(message.contains("could not be moved"), "{message}");
        assert!(
            message.contains(&incomplete.display().to_string()),
            "{message}"
        );
        // The bytes are where the message says, the path and the directory
        // are as they were.
        assert_eq!(std::fs::read(kept).unwrap(), lacking);
        assert_eq!(std::fs::read(&path).unwrap(), whole);
        assert!(incomplete.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_the_path_and_no_partial_file_when_the_manifest_cannot_be_read() {
        let dir = scratch();
        let path = dir.join("backup.tar.gz");
        std::fs::write(&path, b"an earlier archive").unwrap();
        let error = written(&path, b"not gzip").unwrap_err();
        assert!(matches!(error, CliError::Invalid(_)), "{error:?}");
        assert!(error.to_string().contains("nothing was written"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"an earlier archive");
        assert_eq!(names_in(&dir), ["backup.tar.gz"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_archive_with_no_manifest_and_leaves_ndjson_alone() {
        assert!(matches!(
            tapped(b"not gzip".to_vec(), true),
            Err(CliError::Invalid(_))
        ));
        assert_eq!(
            tapped(b"{\"item\":{}}\n".to_vec(), false).unwrap(),
            b"{\"item\":{}}\n"
        );
    }

    /// A server that answers each connection after `delay`, with `body` under
    /// a `Content-Length` of `claimed`, then closes. Returns its URL.
    fn slow_server(delay: Duration, body: Vec<u8>, claimed: usize, accepts: usize) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for _ in 0..accepts {
                let Ok((mut socket, _)) = listener.accept() else {
                    return;
                };
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request);
                std::thread::sleep(delay);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\n{}: {}\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n",
                    marfa_core::http::CONTRACT_HEADER,
                    marfa_core::contract::CONTRACT_VERSION,
                );
                let _ = socket.write_all(head.as_bytes());
                let _ = socket.write_all(&body);
            }
        });
        url
    }

    fn answering_within(url: &str, budget: Duration) -> Remote {
        Remote::with_http(
            marfa_core::http::Http::with_timeouts(url, "marfa_k1_x", budget, budget).unwrap(),
            Some("marfa_k1_x"),
        )
    }

    fn archive_to(path: &Path) -> ExportArgs {
        ExportArgs {
            format: Some(ExportFormat::Archive),
            output: Some(path.to_path_buf()),
            ..ExportArgs::default()
        }
    }

    const QUIET: Printer = Printer { json: true };

    #[test]
    fn waits_for_an_archive_longer_than_the_usual_answer_budget() {
        let bytes = archive(r#"{"version":0,"blobs":{},"missing_blobs":{}}"#);
        let url = slow_server(Duration::from_millis(1_500), bytes.clone(), bytes.len(), 2);
        let dir = scratch();
        let path = dir.join("big.tar.gz");
        let budget = Duration::from_millis(400);

        // The witness: the same server and the same budget end an NDJSON
        // export, which the server begins at once, before the first byte.
        let ndjson = ExportArgs {
            output: Some(path.clone()),
            ..ExportArgs::default()
        };
        let error = run_waiting(
            ndjson,
            &answering_within(&url, budget),
            &QUIET,
            Duration::from_secs(30),
        )
        .unwrap_err();
        assert!(matches!(error, CliError::Core(_)), "{error:?}");
        assert!(!path.exists());

        run(archive_to(&path), &answering_within(&url, budget), &QUIET).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(names_in(&dir), ["big.tar.gz"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gives_up_on_an_archive_whose_first_byte_never_comes() {
        let url = slow_server(Duration::from_secs(8), Vec::new(), 0, 1);
        let dir = scratch();
        let path = dir.join("never.tar.gz");
        let started = std::time::Instant::now();
        let error = run_waiting(
            archive_to(&path),
            &answering_within(&url, Duration::from_millis(300)),
            &QUIET,
            Duration::from_millis(900),
        )
        .unwrap_err();
        assert!(matches!(error, CliError::Core(_)), "{error:?}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(names_in(&dir).is_empty(), "{:?}", names_in(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn leaves_no_archive_when_the_server_ends_the_stream_short() {
        let whole = archive(r#"{"version":0,"blobs":{},"missing_blobs":{}}"#);
        let url = slow_server(
            Duration::ZERO,
            whole[..whole.len() / 2].to_vec(),
            whole.len(),
            1,
        );
        let dir = scratch();
        let path = dir.join("cut.tar.gz");
        std::fs::write(&path, b"an earlier archive").unwrap();
        let error = run(
            archive_to(&path),
            &answering_within(&url, Duration::from_secs(5)),
            &QUIET,
        )
        .unwrap_err();
        assert!(error.to_string().contains("nothing was written"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"an earlier archive");
        assert_eq!(names_in(&dir), ["cut.tar.gz"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remarks_on_a_wait_until_it_ends_and_then_stops() {
        let said = Arc::new(Mutex::new(Vec::new()));
        let remarks = {
            let said = Arc::clone(&said);
            Remarks::every(
                Duration::from_millis(50),
                Duration::from_millis(50),
                move |waited| said.lock().unwrap().push(waited),
            )
        };
        std::thread::sleep(Duration::from_millis(400));
        drop(remarks);
        let heard = said.lock().unwrap().len();
        assert!(heard >= 2, "{heard}");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(said.lock().unwrap().len(), heard);

        let quick = Arc::new(Mutex::new(0));
        let counted = Arc::clone(&quick);
        drop(Remarks::every(
            Duration::from_secs(60),
            Duration::from_secs(60),
            move |_| *counted.lock().unwrap() += 1,
        ));
        assert_eq!(*quick.lock().unwrap(), 0);
    }
}
