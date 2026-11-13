use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use clap::{Args, ValueEnum};
use serde_json::{Value, json};

use super::{StateFilter, state_list};
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

/// Export the instance's data: everything as an archive, or items as NDJSON.
#[derive(Debug, Default, Args)]
pub struct ExportArgs {
    /// `archive` for the whole instance, the default, or `ndjson` for items
    /// one per line, which leaves out tables, settings and files.
    #[arg(long, value_enum, default_value_t = ExportFormat::Archive)]
    pub format: ExportFormat,
    /// Where to write. Omitted, the export goes to stdout, which an archive
    /// refuses when stdout is a terminal. The path is replaced only by an
    /// export that ends whole, and for an archive only by one that lacks no
    /// blobs.
    #[arg(long, value_name = "PATH")]
    pub output: Option<PathBuf>,
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// A state to answer; repeat it or separate states with commas. `any` is
    /// every state, and is given alone. Unset, an archive carries every state,
    /// the bin included, and `ndjson` every state but the bin.
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, ValueEnum)]
pub enum ExportFormat {
    Ndjson,
    #[default]
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
    let states = match state_list(&args.state)? {
        None if args.format == ExportFormat::Archive => Some(StateFilter::Any.as_str().to_string()),
        states => states,
    };
    let request = Request::get(&["export"])
        .query("format", args.format.as_str())
        .query_opt("type", args.type_.clone())
        .query_opt("state", states)
        .query_opt("source", args.source.clone())
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .streamed();
    Ok(if args.format == ExportFormat::Archive {
        request.awaiting(archive_wait)
    } else {
        request
    })
}

pub fn run(args: ExportArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    refuse_terminal(&args, io::stdout().is_terminal())?;
    run_waiting(args, remote, out, ARCHIVE_WAIT)
}

/// An archive is bytes, so it is not poured onto a screen; this is checked before the server is asked.
fn refuse_terminal(args: &ExportArgs, stdout_is_terminal: bool) -> Result<(), CliError> {
    if args.format == ExportFormat::Archive && args.output.is_none() && stdout_is_terminal {
        return Err(CliError::Usage(
            "an archive is binary, so it is not written to your screen. Save it with --output, \
             for example `marfa export --output marfa-export.tar`, or redirect it with \
             `marfa export > marfa-export.tar`. `--format ndjson` writes items as text"
                .into(),
        ));
    }
    Ok(())
}

fn run_waiting(
    args: ExportArgs,
    remote: &Remote,
    out: &Printer,
    archive_wait: Duration,
) -> Result<(), CliError> {
    let request = request_waiting(&args, archive_wait)?;
    let (content_type, reader) = {
        let _remarks = (args.format == ExportFormat::Archive).then(|| {
            Remarks::every(FIRST_REMARK, REMARK_EVERY, |waited| {
                eprintln!(
                    "still preparing the archive ({}s): the server checks every item before it sends the first byte",
                    waited.as_secs()
                );
            })
        });
        remote.stream(&request)?
    };
    let mut reader = ArchiveTap::new(reader, args.format == ExportFormat::Archive);
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
fn write_whole(path: &Path, reader: &mut ArchiveTap<impl Read>) -> Result<u64, CliError> {
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
const MANIFEST: &[u8] = b"manifest.json";
const FILES: &[u8] = b"files.ndjson.gz";
const CARRIED: &str = "carried";
/// A line of `files.ndjson.gz` holds one hash, a state, a media type and a size.
const FILE_LINE_CAP: usize = 64 * 1024;

/// Reads the archive's first two entries, `manifest.json` and the list of
/// files in `files.ndjson.gz`, out of the bytes as they pass, so the export
/// can say what the archive lacks without reading what it wrote a second
/// time, which it cannot do on stdout.
struct ArchiveTap<R> {
    inner: R,
    archive: bool,
    stage: Stage,
    manifest: Option<Vec<u8>>,
    /// The files `files.ndjson.gz` names but the archive does not carry, once
    /// it has been read to its end.
    lacking: Option<Vec<String>>,
}

enum Stage {
    /// The bytes so far of the header of entry `entry`.
    Header {
        entry: usize,
        held: Vec<u8>,
    },
    Manifest {
        body: Vec<u8>,
        left: u64,
        pad: u64,
    },
    Pad {
        left: u64,
    },
    Files {
        left: u64,
        list: Box<flate2::write::GzDecoder<FileLines>>,
    },
    Done,
}

/// The lines of `files.ndjson.gz` as they inflate, keeping the hash of each
/// file it does not mark carried.
#[derive(Default)]
struct FileLines {
    pending: Vec<u8>,
    lacking: Vec<String>,
}

impl FileLines {
    fn line(&mut self, line: &[u8]) -> io::Result<()> {
        let unreadable = || io::Error::new(io::ErrorKind::InvalidData, "a file line does not read");
        let line: Value = serde_json::from_slice(line).map_err(|_| unreadable())?;
        let hash = line
            .get("hash")
            .and_then(Value::as_str)
            .ok_or_else(unreadable)?;
        let state = line
            .get("state")
            .and_then(Value::as_str)
            .ok_or_else(unreadable)?;
        if state != CARRIED {
            self.lacking.push(hash.to_string());
        }
        Ok(())
    }

    fn finish(mut self) -> io::Result<Vec<String>> {
        if !self.pending.is_empty() {
            let last = std::mem::take(&mut self.pending);
            self.line(&last)?;
        }
        Ok(self.lacking)
    }
}

impl Write for FileLines {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut rest = bytes;
        while let Some(end) = rest.iter().position(|byte| *byte == b'\n') {
            if self.pending.is_empty() {
                self.line(&rest[..end])?;
            } else {
                self.pending.extend_from_slice(&rest[..end]);
                let line = std::mem::take(&mut self.pending);
                self.line(&line)?;
            }
            rest = &rest[end + 1..];
        }
        if self.pending.len() + rest.len() > FILE_LINE_CAP {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "a file line is too long",
            ));
        }
        self.pending.extend_from_slice(rest);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The name and size a ustar header holds, or `None` when it holds neither.
fn header(block: &[u8]) -> Option<(&[u8], u64)> {
    let name = &block[..100];
    let name = &name[..name.iter().position(|b| *b == 0).unwrap_or(100)];
    let field = std::str::from_utf8(&block[124..136]).ok()?;
    let size = u64::from_str_radix(field.trim_matches(['\0', ' ']), 8).ok()?;
    Some((name, size))
}

fn padding(size: u64) -> u64 {
    size.next_multiple_of(TAR_BLOCK as u64) - size
}

impl<R: Read> ArchiveTap<R> {
    fn new(inner: R, archive: bool) -> Self {
        ArchiveTap {
            inner,
            archive,
            stage: if archive {
                Stage::Header {
                    entry: 0,
                    held: Vec::new(),
                }
            } else {
                Stage::Done
            },
            manifest: None,
            lacking: None,
        }
    }

    /// Follows the tar through `bytes` until the list of files has been read,
    /// or the archive is found not to begin as the server writes one.
    fn see(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let stage = std::mem::replace(&mut self.stage, Stage::Done);
            self.stage = match stage {
                Stage::Done => return,
                Stage::Header { entry, mut held } => {
                    let take = (TAR_BLOCK - held.len()).min(bytes.len());
                    held.extend_from_slice(&bytes[..take]);
                    bytes = &bytes[take..];
                    if held.len() < TAR_BLOCK {
                        Stage::Header { entry, held }
                    } else {
                        match (entry, header(&held)) {
                            (0, Some((MANIFEST, size))) => Stage::Manifest {
                                body: Vec::new(),
                                left: size,
                                pad: padding(size),
                            },
                            (1, Some((FILES, size))) => Stage::Files {
                                left: size,
                                list: Box::new(flate2::write::GzDecoder::new(FileLines::default())),
                            },
                            _ => Stage::Done,
                        }
                    }
                }
                Stage::Manifest {
                    mut body,
                    left,
                    pad,
                } => {
                    let take = usize::try_from(left).unwrap_or(usize::MAX).min(bytes.len());
                    body.extend_from_slice(&bytes[..take]);
                    bytes = &bytes[take..];
                    let left = left - take as u64;
                    if left > 0 {
                        Stage::Manifest { body, left, pad }
                    } else {
                        self.manifest = Some(body);
                        Stage::Pad { left: pad }
                    }
                }
                Stage::Pad { left } => {
                    let take = usize::try_from(left).unwrap_or(usize::MAX).min(bytes.len());
                    bytes = &bytes[take..];
                    let left = left - take as u64;
                    if left > 0 {
                        Stage::Pad { left }
                    } else {
                        Stage::Header {
                            entry: 1,
                            held: Vec::new(),
                        }
                    }
                }
                Stage::Files { left, mut list } => {
                    let take = usize::try_from(left).unwrap_or(usize::MAX).min(bytes.len());
                    let written = list.write_all(&bytes[..take]);
                    bytes = &bytes[take..];
                    let left = left - take as u64;
                    match written {
                        Err(_) => Stage::Done,
                        Ok(()) if left > 0 => Stage::Files { left, list },
                        Ok(()) => {
                            self.lacking = list.finish().ok().and_then(|lines| lines.finish().ok());
                            Stage::Done
                        }
                    }
                }
            };
        }
    }

    /// The files the archive names but does not carry, refused when there
    /// are any. An archive whose manifest or list of files cannot be read is
    /// refused too: the server writes them first, so a stream without them is
    /// not an archive this build reads.
    fn whole(&self) -> Result<(), CliError> {
        if !self.archive {
            return Ok(());
        }
        let unreadable =
            || CliError::Invalid("the archive's manifest.json could not be read".into());
        let _: serde_json::Map<String, Value> =
            serde_json::from_slice(self.manifest.as_deref().ok_or_else(unreadable)?)
                .map_err(|_| unreadable())?;
        let mut lacking = self.lacking.clone().ok_or_else(|| {
            CliError::Invalid("the archive's files.ndjson.gz could not be read".into())
        })?;
        if lacking.is_empty() {
            return Ok(());
        }
        lacking.sort();
        lacking.dedup();
        Err(CliError::ArchiveLacksBlobs(lacking))
    }
}

impl<R: Read> Read for ArchiveTap<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.see(&buffer[..read]);
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tar that begins as the server writes an archive: `manifest.json`,
    /// then `files.ndjson.gz` listing each file with its state, then an entry
    /// the tap must not need.
    fn archive(files: &[(&str, &str)]) -> Vec<u8> {
        let manifest = format!(
            r#"{{"version":1,"format":"marfa-archive","file_count":{}}}"#,
            files.len()
        );
        let mut list = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        for (hash, state) in files {
            writeln!(
                list,
                r#"{{"hash":"{hash}","mime_type":null,"size_bytes":null,"state":"{state}"}}"#
            )
            .unwrap();
        }
        let list = list.finish().unwrap();
        let mut tar = Vec::new();
        for (name, body) in [
            ("manifest.json", manifest.as_bytes()),
            ("files.ndjson.gz", list.as_slice()),
            ("instance.ndjson.gz", b"\x1f\x8b".as_slice()),
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
        tar
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
        let mut tap = ArchiveTap::new(Trickle(io::Cursor::new(bytes)), archive);
        let mut copied = Vec::new();
        io::copy(&mut tap, &mut copied).unwrap();
        tap.whole().map(|()| copied)
    }

    #[test]
    fn names_the_files_an_archive_does_not_carry_and_passes_the_bytes_on() {
        let bytes = archive(&[("sha256:bb", "not_carried"), ("sha256:aa", "lost")]);
        match tapped(bytes.clone(), true) {
            Err(CliError::ArchiveLacksBlobs(missing)) => {
                assert_eq!(missing, ["sha256:aa", "sha256:bb"]);
            }
            other => panic!("expected blobs_missing, got {other:?}"),
        }
        let whole = archive(&[("sha256:aa", "carried")]);
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
        let path = dir.join("backup.tar");
        // The witness: an earlier archive at the path is neither cut nor replaced.
        std::fs::write(&path, b"an earlier archive").unwrap();
        let error = write_whole(&path, &mut ArchiveTap::new(CutShort(100_000), false)).unwrap_err();
        assert!(matches!(error, CliError::Io(_)), "{error:?}");
        assert!(error.to_string().contains("nothing was written"), "{error}");
        assert!(error.to_string().contains("removed"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"an earlier archive");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(left.len(), 1, "a partial file is left: {left:?}");

        let written = write_whole(
            &path,
            &mut ArchiveTap::new(io::Cursor::new(b"whole".to_vec()), false),
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
            &mut ArchiveTap::new(io::Cursor::new(bytes.to_vec()), true),
        )
    }

    #[test]
    fn keeps_an_archive_that_lacks_blobs_beside_the_path_and_leaves_the_earlier_file() {
        let hashes: Vec<String> = (0..12).map(|n| format!("sha256:{n:02}")).collect();
        let listed: Vec<(&str, &str)> = hashes
            .iter()
            .map(|hash| (hash.as_str(), "not_carried"))
            .collect();
        let lacking = archive(&listed);
        let whole = archive(&[("sha256:aa", "carried")]);

        let dir = scratch();
        let path = dir.join("nightly.tar");
        let incomplete = dir.join("nightly.tar.incomplete");

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
        assert_eq!(names_in(&dir), ["nightly.tar", "nightly.tar.incomplete"]);

        // The witness: a whole archive replaces the path and leaves no
        // partial file; the earlier incomplete archive is not its to remove.
        let newer = archive(&[("sha256:bb", "carried")]);
        assert_eq!(written(&path, &newer).unwrap(), newer.len() as u64);
        assert_eq!(std::fs::read(&path).unwrap(), newer);
        assert_eq!(names_in(&dir), ["nightly.tar", "nightly.tar.incomplete"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_an_archive_that_lacks_blobs_beside_a_path_where_nothing_was_and_says_so() {
        let lacking = archive(&[("sha256:aa", "not_carried")]);
        let dir = scratch();
        let path = dir.join("first.tar");
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
            std::fs::read(dir.join("first.tar.incomplete")).unwrap(),
            lacking
        );
        assert_eq!(names_in(&dir), ["first.tar.incomplete"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reports_the_blobs_and_keeps_the_bytes_when_the_incomplete_name_cannot_be_taken() {
        let lacking = archive(&[("sha256:aa", "not_carried")]);
        let whole = archive(&[("sha256:bb", "carried")]);
        let dir = scratch();
        let path = dir.join("nightly.tar");
        let incomplete = dir.join("nightly.tar.incomplete");
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
        let path = dir.join("backup.tar");
        std::fs::write(&path, b"an earlier archive").unwrap();
        let error = written(&path, b"not a tar").unwrap_err();
        assert!(matches!(error, CliError::Invalid(_)), "{error:?}");
        assert!(error.to_string().contains("nothing was written"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"an earlier archive");
        assert_eq!(names_in(&dir), ["backup.tar"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_archive_whose_files_are_not_listed_after_its_manifest() {
        let mut no_list = archive(&[("sha256:aa", "not_carried")]);
        no_list[TAR_BLOCK * 2..TAR_BLOCK * 2 + FILES.len()].copy_from_slice(b"items.ndjson.gz");
        match tapped(no_list, true) {
            Err(CliError::Invalid(message)) => assert!(message.contains("files.ndjson.gz")),
            other => panic!("expected the list to be unreadable, got {other:?}"),
        }
        let mut damaged = archive(&[("sha256:aa", "not_carried")]);
        let list = TAR_BLOCK * 3;
        damaged[list + 12] ^= 0xff;
        assert!(matches!(tapped(damaged, true), Err(CliError::Invalid(_))));
    }

    #[test]
    fn refuses_an_archive_with_no_manifest_and_leaves_ndjson_alone() {
        assert!(matches!(
            tapped(b"not a tar".to_vec(), true),
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
                    "HTTP/1.1 200 OK\r\nContent-Type: application/x-tar\r\n{}: {}\r\nContent-Length: {claimed}\r\nConnection: close\r\n\r\n",
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
            format: ExportFormat::Archive,
            output: Some(path.to_path_buf()),
            ..ExportArgs::default()
        }
    }

    const QUIET: Printer = Printer { json: true };

    #[test]
    fn waits_for_an_archive_longer_than_the_usual_answer_budget() {
        let bytes = archive(&[]);
        let url = slow_server(Duration::from_millis(1_500), bytes.clone(), bytes.len(), 2);
        let dir = scratch();
        let path = dir.join("big.tar");
        let budget = Duration::from_millis(400);

        // The witness: the same server and the same budget end an NDJSON
        // export, which the server begins at once, before the first byte.
        let ndjson = ExportArgs {
            format: ExportFormat::Ndjson,
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
        assert_eq!(names_in(&dir), ["big.tar"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gives_up_on_an_archive_whose_first_byte_never_comes() {
        let url = slow_server(Duration::from_secs(8), Vec::new(), 0, 1);
        let dir = scratch();
        let path = dir.join("never.tar");
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
        let whole = archive(&[]);
        let url = slow_server(
            Duration::ZERO,
            whole[..whole.len() / 2].to_vec(),
            whole.len(),
            1,
        );
        let dir = scratch();
        let path = dir.join("cut.tar");
        std::fs::write(&path, b"an earlier archive").unwrap();
        let error = run(
            archive_to(&path),
            &answering_within(&url, Duration::from_secs(5)),
            &QUIET,
        )
        .unwrap_err();
        assert!(error.to_string().contains("nothing was written"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"an earlier archive");
        assert_eq!(names_in(&dir), ["cut.tar"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn gives_an_archive_thirty_minutes_to_begin_and_ndjson_the_ordinary_budget() {
        let archive = request(&ExportArgs {
            format: ExportFormat::Archive,
            ..ExportArgs::default()
        })
        .unwrap();
        assert_eq!(archive.wait, Some(Duration::from_secs(30 * 60)));
        let ndjson = request(&ExportArgs {
            format: ExportFormat::Ndjson,
            ..ExportArgs::default()
        })
        .unwrap();
        assert_eq!(ndjson.wait, None);
    }

    #[test]
    fn asks_for_the_whole_archive_unless_told_otherwise() {
        let plain = request(&ExportArgs::default()).unwrap();
        assert!(plain.query.contains(&("format".into(), "archive".into())));
        assert_eq!(plain.wait, Some(Duration::from_secs(30 * 60)));
        let items = request(&ExportArgs {
            format: ExportFormat::Ndjson,
            ..ExportArgs::default()
        })
        .unwrap();
        assert!(items.query.contains(&("format".into(), "ndjson".into())));
    }

    #[test]
    fn a_plain_archive_carries_the_bin_and_a_named_state_or_ndjson_leaves_it_to_the_server() {
        let state = |args: &ExportArgs| {
            request(args)
                .unwrap()
                .query
                .iter()
                .find(|(name, _)| name == "state")
                .map(|(_, value)| value.clone())
        };
        assert_eq!(state(&ExportArgs::default()).as_deref(), Some("any"));
        let named = ExportArgs {
            state: vec![StateFilter::Active],
            ..ExportArgs::default()
        };
        assert_eq!(state(&named).as_deref(), Some("active"));
        let items = ExportArgs {
            format: ExportFormat::Ndjson,
            ..ExportArgs::default()
        };
        assert_eq!(state(&items), None);
    }

    #[test]
    fn an_archive_is_not_written_to_a_terminal_and_says_how_to_save_it() {
        let archive = ExportArgs::default();
        let error = refuse_terminal(&archive, true).unwrap_err().to_string();
        assert!(error.contains("--output"), "{error}");
        assert!(error.contains("marfa-export.tar"), "{error}");
        // The witness: the same command goes ahead when its output is a file or a pipe, and
        // items as text may go to a terminal.
        assert!(refuse_terminal(&archive, false).is_ok());
        let to_file = ExportArgs {
            output: Some(PathBuf::from("x.tar")),
            ..ExportArgs::default()
        };
        assert!(refuse_terminal(&to_file, true).is_ok());
        let items = ExportArgs {
            format: ExportFormat::Ndjson,
            ..ExportArgs::default()
        };
        assert!(refuse_terminal(&items, true).is_ok());
    }

    #[test]
    fn remarks_first_at_five_seconds_and_then_every_fifteen() {
        assert_eq!(FIRST_REMARK, Duration::from_secs(5));
        assert_eq!(REMARK_EVERY, Duration::from_secs(15));

        // The same logic at a hundredth of the pace: 50 ms, then 150 ms apart.
        let said = Arc::new(Mutex::new(Vec::new()));
        let remarks = {
            let said = Arc::clone(&said);
            Remarks::every(FIRST_REMARK / 100, REMARK_EVERY / 100, move |waited| {
                said.lock().unwrap().push(waited)
            })
        };
        std::thread::sleep(Duration::from_millis(500));
        drop(remarks);
        let said = said.lock().unwrap();
        // A loaded runner can run the thread late, so only lower bounds hold:
        // never early, and never closer together than the pace.
        assert!(said.len() >= 2, "{said:?}");
        assert!(said[0] >= Duration::from_millis(50), "{said:?}");
        for pair in said.windows(2) {
            assert!(pair[1] - pair[0] >= Duration::from_millis(140), "{said:?}");
        }
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
