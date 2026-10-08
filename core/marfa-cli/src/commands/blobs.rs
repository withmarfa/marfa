use std::io::{self, Write};
use std::path::PathBuf;

use clap::Subcommand;
use marfa_core::mime_type_for;
use serde_json::json;

use super::items::upload_request;
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
    /// at the least. Requires `blobs.manage`.
    Stores,
    /// The stores recorded as holding one blob's bytes, and when each copy
    /// was last found intact.
    Locations {
        /// The blob hash, `sha256:<hex>`.
        hash: String,
    },
    /// Remove one store's copy of a blob, where enough live copies remain.
    /// Requires `blobs.manage`.
    DeleteLocation {
        /// The blob hash, `sha256:<hex>`.
        hash: String,
        /// The store whose copy goes, as `blobs stores` names it.
        #[arg(long, value_name = "STORE")]
        store: String,
    },
    /// The blobs the last orphan sweep found nothing referencing. Requires
    /// `blobs.manage`.
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

pub fn locations_request(hash: &str) -> Request {
    Request::get(&["blobs", hash, "locations"])
}

pub fn delete_location_request(hash: &str, store: &str) -> Request {
    Request::delete(&["blobs", hash, "locations", store])
}

pub fn orphans_request() -> Request {
    Request::get(&["blobs", "orphans"])
}

pub fn run(command: BlobsCommand, remote: &Remote, out: &Printer) -> Result<(), CliError> {
    match command {
        BlobsCommand::Upload { file, mime_type } => {
            let mime_type = mime_type_for(&file, mime_type.as_deref());
            out.value(&remote.json(&upload_request(&file, &mime_type))?)
        }
        BlobsCommand::Download { hash, output } => {
            let (content_type, mut reader) = remote.stream(&download_request(&hash))?;
            let written = match &output {
                Some(path) => {
                    let mut file = std::fs::File::create(path).map_err(|error| {
                        CliError::Invalid(format!("cannot write {}: {error}", path.display()))
                    })?;
                    io::copy(&mut reader, &mut file)?
                }
                None => {
                    let mut stdout = io::stdout().lock();
                    let written = io::copy(&mut reader, &mut stdout)?;
                    stdout.flush()?;
                    written
                }
            };
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
        BlobsCommand::Locations { hash } => out.value(&remote.json(&locations_request(&hash))?),
        BlobsCommand::DeleteLocation { hash, store } => {
            out.value(&remote.json(&delete_location_request(&hash, &store))?)
        }
        BlobsCommand::Orphans => out.value(&remote.json(&orphans_request())?),
    }
}
