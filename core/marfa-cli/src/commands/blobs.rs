use std::io::{self, Write};
use std::path::{Path, PathBuf};

use clap::Subcommand;
use marfa_core::mime_type_for;
use serde_json::json;
use sha2::{Digest, Sha256};

use super::items::upload_request;
use super::owner_file::Partial;
use crate::error::CliError;
use crate::output::Printer;
use crate::remote::Remote;
use crate::remote::request::Request;

#[derive(Debug, Subcommand)]
pub enum BlobsCommand {
    /// Store a file's bytes by content hash.
    Upload {
        /// The file.
        file: PathBuf,
        /// The file's MIME type. Guessed from the extension when omitted.
        #[arg(long, value_name = "TYPE")]
        mime_type: Option<String>,
    },
    /// Fetch a blob's bytes.
    Download {
        /// The blob hash, `sha256:<hex>`.
        hash: String,
        /// Where to write the bytes. Omitted, they go to stdout.
        #[arg(long, value_name = "PATH")]
        output: Option<PathBuf>,
    },
    /// A time-limited link that fetches a blob without the API in between.
    Url {
        /// The blob hash, `sha256:<hex>`.
        hash: String,
        /// How long the link lives, in seconds.
        #[arg(long)]
        ttl: Option<u64>,
    },
    /// Every store the instance has attached, and the copies a blob keeps
    /// at the least. Requires `instance.read`.
    Stores,
    /// The copies of one blob: the stores recorded as holding its bytes, and
    /// when each copy was last found intact.
    Copies {
        /// The blob hash, `sha256:<hex>`.
        hash: String,
    },
    /// Delete one store's copy of a blob, where enough live copies remain.
    /// Requires `blobs.manage`.
    DeleteCopy {
        /// The blob hash, `sha256:<hex>`.
        hash: String,
        /// The store whose copy goes, as `blobs stores` names it.
        #[arg(long, value_name = "STORE")]
        store: String,
    },
    /// The blobs the last orphan sweep found nothing referencing. Requires
    /// `instance.read`.
    Orphans,
}

pub fn download_request(hash: &str) -> Request {
    Request::get(&["blobs", hash]).streamed()
}

pub fn url_request(hash: &str, ttl: Option<u64>) -> Request {
    Request::get(&["blobs", hash, "url"]).query_opt("ttl", ttl.map(|ttl| ttl.to_string()))
}

pub fn stores_request() -> Request {
    Request::get(&["blobs", "stores"])
}

pub fn copies_request(hash: &str) -> Request {
    Request::get(&["blobs", hash, "copies"])
}

pub fn delete_copy_request(hash: &str, store: &str) -> Request {
    Request::delete(&["blobs", hash, "copies", store])
}

pub fn orphans_request() -> Request {
    Request::get(&["blobs", "orphans"])
}

pub(super) fn save(
    reader: &mut impl io::Read,
    path: Option<&Path>,
    digest: Option<&str>,
) -> Result<u64, CliError> {
    match path {
        Some(path) => {
            let mut partial = Partial::beside(path)?;
            let mut hashing = HashingReader::new(reader);
            let written = match partial.copy_from(&mut hashing) {
                Ok(written) => written,
                Err(error) => {
                    return Err(CliError::Io(io::Error::new(
                        error.kind(),
                        format!(
                            "{error}: the transfer ended early, so nothing was written to {}, {}",
                            path.display(),
                            partial.discard()
                        ),
                    )));
                }
            };
            if let Some(digest) = digest {
                let found = hashing.digest();
                if !found.eq_ignore_ascii_case(digest) {
                    return Err(CliError::Invalid(format!(
                        "the bytes hash to {found}, not {digest}, so nothing was written to {}, {}",
                        path.display(),
                        partial.discard()
                    )));
                }
            }
            partial.publish()?;
            Ok(written)
        }
        None => {
            let mut stdout = crate::output::stdout_bytes();
            let written = io::copy(reader, &mut stdout)?;
            stdout.flush()?;
            Ok(written)
        }
    }
}

struct HashingReader<'a, R> {
    inner: &'a mut R,
    hash: Sha256,
}

impl<'a, R: io::Read> HashingReader<'a, R> {
    fn new(inner: &'a mut R) -> Self {
        HashingReader {
            inner,
            hash: Sha256::new(),
        }
    }

    fn digest(self) -> String {
        format!("sha256:{}", hex::encode(self.hash.finalize()))
    }
}

impl<R: io::Read> io::Read for HashingReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hash.update(&buffer[..read]);
        Ok(read)
    }
}

pub fn run(command: BlobsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        BlobsCommand::Upload { file, mime_type } => {
            let mime_type = mime_type_for(&file, mime_type.as_deref());
            let answer = remote.json(&upload_request(&file, &mime_type))?;
            out.report(&answer, || {
                let text = |name: &str| {
                    answer
                        .get(name)
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                };
                format!(
                    "stored {} ({} bytes, {})",
                    text("hash"),
                    answer
                        .get("size_bytes")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0),
                    text("mime_type")
                )
            })
        }
        BlobsCommand::Download { hash, output } => {
            let (content_type, mut reader) = remote.stream(&download_request(&hash))?;
            let written = save(&mut reader, output.as_deref(), Some(&hash))?;
            // Bytes to stdout are the answer; a report there would corrupt it.
            if let Some(path) = output {
                out.report(
                    &json!({ "hash": hash, "path": path, "size_bytes": written, "mime_type": content_type }),
                    || format!("{} byte(s) of {content_type} into {}", written, path.display()),
                )?;
            }
            Ok(())
        }
        BlobsCommand::Url { hash, ttl } => out.value(&remote.json(&url_request(&hash, ttl))?),
        BlobsCommand::Stores => out.value(&remote.json(&stores_request())?),
        BlobsCommand::Copies { hash } => out.value(&remote.json(&copies_request(&hash))?),
        BlobsCommand::DeleteCopy { hash, store } => {
            let answer = remote.json(&delete_copy_request(&hash, &store))?;
            out.report(&answer, || {
                format!("deleted the copy of {hash} in the store {store}")
            })
        }
        BlobsCommand::Orphans => out.value(&remote.json(&orphans_request())?),
    }
}
