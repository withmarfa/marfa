//! Behaviour tests: bytes go in by `read_here`, and the text, the size or the
//! refusal come out.

mod formats;
mod html;
mod limits;
#[cfg(feature = "native")]
mod native;
mod text;

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::{Options, Reading, Refusal, read_here};

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
        ocr: None,
        time_budget: None,
    }
}

/// What the fixtures the TypeScript server tests with hold, read where they lie.
pub(super) fn fixture(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../packages/server/src/enrichment/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
}

/// A fixture of this crate's own: a binary workbook, which nothing else here
/// can write.
pub(super) fn own_fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|error| panic!("{path}: {error}"))
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
