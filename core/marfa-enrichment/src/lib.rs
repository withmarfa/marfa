//! Reads the text and the size out of a file's bytes, so search can find the
//! file. It knows nothing of items, a database or HTTP: bytes and a MIME type
//! go in, and text, a size or the reason it could not read come out.

mod decode;
mod encrypted;
mod epub;
mod html;
mod image;
mod kind;
mod odf;
mod ooxml;
mod package;
mod sheet;
mod sink;
mod xml;

#[cfg(test)]
mod tests;

use kind::{Document, Kind};
use sink::Sink;

/// What one reading may use.
#[derive(Clone, Debug)]
pub struct Options {
    /// The text kept, in UTF-16 code units, as the contract counts it. A reader
    /// stops once it holds enough, so a file with far more text costs no more.
    pub max_text_chars: usize,
    /// The most bytes a document may inflate to, all of its parts together.
    pub max_inflated_bytes: u64,
}

/// What a file held.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    /// The text, trimmed and cut to `Options::max_text_chars` without splitting
    /// a character. Empty when the file holds none.
    pub text: String,
    /// Whether the file held more text than `text` does.
    pub truncated: bool,
    /// The size of an image.
    pub dimensions: Option<Dimensions>,
}

/// An image's size in pixels, as its header states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

/// Why a file was not read. The kinds are told apart because the sweep treats
/// them differently.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    /// No reader takes this type of file.
    #[error("no reader takes this type of file")]
    Unsupported,
    /// The file needs a password to open.
    #[error("the file is password-protected")]
    Encrypted,
    /// The file is not the kind of file its type says. The reason is for a log.
    #[error("the file is malformed: {0}")]
    Malformed(String),
    /// Reading the file would use more than a limit allows. Raising the limit
    /// may let it read. The reason is for a log.
    #[error("the file is past a limit: {0}")]
    OverLimit(String),
    /// The reading did not finish in time.
    #[error("reading the file took too long")]
    TimedOut,
    /// The reader failed, and ended its process.
    #[error("the reader failed")]
    Crashed,
}

/// Reads `bytes` in this process, by the MIME type `mime`; its parameters and
/// letter case do not matter, but a `charset` parameter is read as a hint for
/// text.
///
/// A parser that panics on a file it was not built for is a malformed file, not
/// a reason to end the caller.
// Nothing outside the tests calls this until the entry point that reads in a
// process of its own is added.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn read_here(bytes: &[u8], mime: &str, options: &Options) -> Result<Reading, Refusal> {
    std::panic::catch_unwind(|| read_kind(bytes, mime, options))
        .unwrap_or_else(|_| Err(Refusal::Malformed("the reader failed on this file".into())))
}

fn read_kind(bytes: &[u8], mime: &str, options: &Options) -> Result<Reading, Refusal> {
    let kind = Kind::of(mime).ok_or(Refusal::Unsupported)?;
    let mut sink = Sink::new(options.max_text_chars);
    let mut dimensions = None;
    match kind {
        Kind::Text => {
            let declared = decode::declared_charset(mime);
            let (encoding, skip) = decode::choose(bytes, declared);
            decode::decode_into(&bytes[skip..], encoding, &mut sink);
        }
        Kind::Html { xhtml } => html::read(bytes, mime, xhtml, &mut sink),
        Kind::Document(document) => read_document(document, bytes, options, &mut sink)?,
        Kind::Sheet(sheet) => sheet::read(sheet, bytes, options, &mut sink)?,
        Kind::Image => dimensions = image::dimensions(bytes),
    }
    let (text, truncated) = sink.finish(options.max_text_chars);
    Ok(Reading {
        text,
        truncated,
        dimensions,
    })
}

fn read_document(
    document: Document,
    bytes: &[u8],
    options: &Options,
    sink: &mut Sink,
) -> Result<(), Refusal> {
    encrypted::refuse_if_wrapped(bytes)?;
    let mut package = package::Package::open(bytes, options.max_inflated_bytes)?;
    match document {
        Document::Docx => ooxml::read_docx(&mut package, sink),
        Document::Pptx => ooxml::read_pptx(&mut package, sink),
        Document::Odt => odf::read_text(&mut package, sink),
        Document::Odp => odf::read_presentation(&mut package, sink),
        Document::Epub => epub::read(&mut package, sink),
    }
}
