//! Reads the text and the size out of a file's bytes, so search can find the
//! file. It knows nothing of items, a database or HTTP: bytes and a MIME type
//! go in, and text, a size or the reason it could not read come out.

mod decode;
mod encrypted;
mod epub;
mod html;
mod image;
mod kind;
#[cfg(feature = "native")]
mod ocr;
mod odf;
mod ooxml;
mod package;
mod pdf;
#[cfg(feature = "native")]
mod pixels;
mod sheet;
mod sink;
mod xml;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use kind::{Document, Kind};
use sink::Sink;

/// What one reading may use.
#[derive(Clone, Debug)]
pub struct Options {
    /// The text kept, in UTF-16 code units, as the contract counts it. A reader
    /// stops once it holds enough, so a file with far more text costs no more.
    pub max_text_chars: usize,
    /// The most bytes a document may inflate to, all of its parts together, and the
    /// most memory a picture may take once decoded.
    pub max_inflated_bytes: u64,
    /// Reads text from pictures: images, and pages of a PDF that hold no text.
    /// `None` leaves OCR off, and an image then gives its size only. Without the
    /// `native` feature OCR is not built and this has no effect.
    pub ocr: Option<OcrOptions>,
    /// How long a reading may spend before it stops reading pictures and returns
    /// what it has, marked `cut_short`. It is soft: the caller still ends a reader
    /// that does not return. `None` sets no budget.
    pub time_budget: Option<Duration>,
}

/// The languages OCR reads when the owner names none: the four Latin-script
/// models the program carries that most files need.
pub const DEFAULT_OCR_LANGUAGES: &str = "eng+deu+fra+spa";

/// Whether this build can read text from pictures and PDFs.
pub const NATIVE: bool = cfg!(feature = "native");

/// How OCR reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OcrOptions {
    /// The languages to read, as Tesseract names them, joined by `+`. A model for
    /// each is in `data_dir` or in the program.
    pub languages: String,
    /// A folder of `<language>.traineddata` files. A model in it is used in place
    /// of the program's own for that language, so an owner can add a language or
    /// a larger model. The folder is only read, and may be absent.
    pub data_dir: Option<PathBuf>,
}

impl Default for OcrOptions {
    fn default() -> Self {
        Self {
            languages: DEFAULT_OCR_LANGUAGES.to_owned(),
            data_dir: None,
        }
    }
}

/// What a file held.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reading {
    /// The text, trimmed and cut to `Options::max_text_chars` without splitting
    /// a character. Empty when the file holds none.
    pub text: String,
    /// Whether the file held more text than `text` does.
    pub truncated: bool,
    /// Whether `Options::time_budget` ran out before every picture was read, so
    /// that more text may be in the file than `text` holds.
    pub cut_short: bool,
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
    /// OCR is on, and cannot start: a language that neither the data folder nor the
    /// program holds, or a model that does not load. The file may be fine, and
    /// fixing the setting lets it read. The reason is for the person who sets OCR
    /// up.
    #[error("OCR cannot start: {0}")]
    OcrUnavailable(String),
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
    let clock = Clock::start(options.time_budget);
    std::panic::catch_unwind(|| read_kind(bytes, mime, options, &clock))
        .unwrap_or_else(|_| Err(Refusal::Malformed("the reader failed on this file".into())))
}

/// The time budget of one reading.
pub(crate) struct Clock {
    end: Option<Instant>,
}

impl Clock {
    fn start(budget: Option<Duration>) -> Self {
        Self {
            end: budget.map(|budget| Instant::now() + budget),
        }
    }

    /// The time left, or none when there is no budget. Zero when it has run out.
    #[cfg_attr(not(feature = "native"), allow(dead_code))]
    pub(crate) fn remaining(&self) -> Option<Duration> {
        self.end
            .map(|end| end.saturating_duration_since(Instant::now()))
    }
}

fn read_kind(
    bytes: &[u8],
    mime: &str,
    options: &Options,
    clock: &Clock,
) -> Result<Reading, Refusal> {
    let kind = Kind::of(mime).ok_or(Refusal::Unsupported)?;
    let mut sink = Sink::new(options.max_text_chars);
    let mut dimensions = None;
    let mut cut_short = false;
    match kind {
        Kind::Text => {
            let declared = decode::declared_charset(mime);
            let (encoding, skip) = decode::choose(bytes, declared);
            decode::decode_into(&bytes[skip..], encoding, &mut sink);
        }
        Kind::Html { xhtml } => html::read(bytes, mime, xhtml, &mut sink),
        Kind::Document(document) => read_document(document, bytes, options, &mut sink)?,
        Kind::Sheet(sheet) => sheet::read(sheet, bytes, options, &mut sink)?,
        Kind::Image { ocr } => {
            dimensions = image::dimensions(bytes);
            if ocr {
                cut_short = image::read_text(bytes, options, clock, &mut sink)?;
            }
        }
        Kind::Pdf => cut_short = pdf::read(bytes, options, clock, &mut sink)?,
    }
    let (text, truncated) = sink.finish(options.max_text_chars);
    Ok(Reading {
        text,
        truncated,
        cut_short,
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
