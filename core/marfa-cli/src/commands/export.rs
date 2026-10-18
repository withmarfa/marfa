use std::io::{self, Read, Write};
use std::path::PathBuf;

use clap::{Args, ValueEnum};
use flate2::write::GzDecoder;
use serde_json::{Value, json};

use super::StateFilter;
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
    /// Where to write. Omitted, the export goes to stdout.
    #[arg(long, value_name = "PATH")]
    pub output: Option<PathBuf>,
    /// A type identifier; its subtypes are included.
    #[arg(long = "type", value_name = "TYPE")]
    pub type_: Option<String>,
    /// One state, or `any`.
    #[arg(long)]
    pub state: Option<StateFilter>,
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

pub fn request(args: &ExportArgs) -> Request {
    Request::get(&["export"])
        .query_opt("format", args.format.map(ExportFormat::as_str))
        .query_opt("type", args.type_.clone())
        .query_opt("state", args.state.map(StateFilter::as_str))
        .query_opt("source", args.source.clone())
        .query_opt("occurred_after", args.occurred_after.clone())
        .query_opt("occurred_before", args.occurred_before.clone())
        .streamed()
}

pub fn run(args: ExportArgs, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    let (content_type, reader) = remote.stream(&request(&args))?;
    let mut reader = ManifestTap::new(reader, args.format == Some(ExportFormat::Archive));
    match &args.output {
        Some(path) => {
            let mut file = std::fs::File::create(path).map_err(|error| {
                CliError::Invalid(format!("cannot write {}: {error}", path.display()))
            })?;
            let written = io::copy(&mut reader, &mut file)?;
            reader.whole()?;
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
}
