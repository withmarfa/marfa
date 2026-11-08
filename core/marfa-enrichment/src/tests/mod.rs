//! Behaviour tests: a file goes in by `read_here`, and the text, the size, the length
//! or the refusal come out.

mod formats;
mod html;
mod limits;
mod media;
#[cfg(feature = "native")]
mod native;
mod text;

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::{Options, Reading, Refusal};

pub(super) const MIB: u64 = 1024 * 1024;

pub(super) const DOCX: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
pub(super) const PPTX: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
pub(super) const XLSX: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
pub(super) const ODT: &str = "application/vnd.oasis.opendocument.text";
pub(super) const ODP: &str = "application/vnd.oasis.opendocument.presentation";
pub(super) const ODS: &str = "application/vnd.oasis.opendocument.spreadsheet";

pub(super) fn options() -> Options {
    Options {
        max_text_chars: 100_000,
        max_inflated_bytes: 256 * MIB,
        ..Options::default()
    }
}

/// A file of this crate's `fixtures` folder.
pub(super) fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

/// `crate::read_here` on a file that holds `bytes`.
pub(super) fn read_here(bytes: &[u8], mime: &str, options: &Options) -> Result<Reading, Refusal> {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(bytes).unwrap();
    crate::read_here(&file, bytes.len() as u64, mime, options)
}

pub(super) fn read(bytes: &[u8], mime: &str) -> Reading {
    read_here(bytes, mime, &options()).unwrap_or_else(|refusal| panic!("refused: {refusal}"))
}

pub(super) fn text(bytes: &[u8], mime: &str) -> String {
    read(bytes, mime).text
}

pub(super) fn refusal(bytes: &[u8], mime: &str, options: &Options) -> Refusal {
    read_here(bytes, mime, options).expect_err("the file should have been refused")
}

/// A zip of `parts`, each deflated.
pub(super) fn zip(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, data) in parts {
        writer.start_file(*name, options).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// The same zip, with every part claiming to inflate to `claimed` bytes in both
/// places the zip says so.
pub(super) fn claiming(mut zip: Vec<u8>, claimed: u32) -> Vec<u8> {
    for at in 0..zip.len().saturating_sub(46) {
        let offset = match zip[at..at + 4] {
            [b'P', b'K', 3, 4] => 22,
            [b'P', b'K', 1, 2] => 24,
            _ => continue,
        };
        zip[at + offset..at + offset + 4].copy_from_slice(&claimed.to_le_bytes());
    }
    zip
}
