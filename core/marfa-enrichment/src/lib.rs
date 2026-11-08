//! Reads the text, the size and the length out of a file, so search can find the
//! file. It knows nothing of items, a database or HTTP: an open file and a MIME type
//! go in, and text, a size, a duration or the reason it could not read come out.
//!
//! Every file is read in a process of its own. A program that uses this crate calls
//! [`serve_child_if_asked`] as the first line of `main`, and then [`read`].

mod decode;
mod encrypted;
mod epub;
mod html;
mod image;
mod isolated;
mod kind;
mod matroska;
mod media;
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
mod source;
mod xml;

#[cfg(test)]
mod tests;

use std::fs::File;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use kind::{Document, Kind};
use serde::{Deserialize, Serialize};
use sink::Sink;
use source::Source;

pub use isolated::{read, serve_child_if_asked};

/// What one reading may use.
#[derive(Clone, Debug)]
pub struct Options {
    /// The text kept, counted in UTF-16 code units, so a character outside the Basic
    /// Multilingual Plane counts as two. A reader stops once it holds enough, so a
    /// file with far more text costs no more.
    pub max_text_chars: usize,
    /// The most bytes a document may inflate to, all of its parts together.
    pub max_inflated_bytes: u64,
    /// The most memory the process that reads may hold. A reading that needs more is
    /// `OverLimit`. A file is held whole except a sound or a video, which is read
    /// from the file by its headers, so a file larger than this is `OverLimit` unless
    /// it is one of those. A picture is read for text only if decoding and scaling it
    /// fit in three quarters of what is left here once the file is held.
    pub max_memory_bytes: u64,
    /// Reads text from pictures: images, and pages of a PDF that hold no text.
    /// `None` leaves OCR off, and an image then gives its size only. Without the
    /// `native` feature OCR is not built and this has no effect.
    pub ocr: Option<OcrOptions>,
    /// How long a reading may take. At this time its process is killed, whatever it
    /// was doing, and the reading is `TimedOut`.
    pub time_limit: Duration,
    /// How long a reading may spend before it stops reading pictures and returns
    /// what it has, marked `cut_short`. `None` sets it inside `time_limit`, with time
    /// left over for a long scan to answer instead of timing out with nothing.
    pub time_budget: Option<Duration>,
}

/// The share of `Options::time_limit` a reading spends before it stops reading
/// pictures, when `Options::time_budget` does not say.
const SOFT_SHARE_OF_LIMIT: f64 = 0.75;

impl Default for Options {
    fn default() -> Self {
        Self {
            max_text_chars: 1_000_000,
            max_inflated_bytes: 64 * 1024 * 1024,
            max_memory_bytes: 1024 * 1024 * 1024,
            ocr: None,
            time_limit: Duration::from_mins(1),
            time_budget: None,
        }
    }
}

/// The languages OCR reads when the owner names none: the four Latin-script
/// models the program carries that most files need.
pub const DEFAULT_OCR_LANGUAGES: &str = "eng+deu+fra+spa";

/// Whether this build can read text from pictures and PDFs.
pub const NATIVE: bool = cfg!(feature = "native");

/// Whether a file of this type is held whole in memory to be read, so that its size
/// matters. A sound or a video is read from its headers and is held in no memory.
pub fn loads_whole_file(mime: &str) -> bool {
    Kind::of(mime).is_none_or(Kind::loads_whole_file)
}

/// Whether OCR can give text for a file of this type: an image of a type it decodes, or
/// a PDF.
pub fn ocr_applies(mime: &str) -> bool {
    matches!(Kind::of(mime), Some(Kind::Image { ocr: true } | Kind::Pdf))
}

/// Whether the type is that of an image, whatever its bytes are.
pub fn is_image(mime: &str) -> bool {
    matches!(Kind::of(mime), Some(Kind::Image { .. }))
}

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
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    /// The text, trimmed and cut to `Options::max_text_chars` without splitting
    /// a character. Empty when the file holds none.
    pub text: String,
    /// Whether the file held more text than `text` does.
    pub truncated: bool,
    /// Whether `Options::time_budget` ran out before every picture was read, so
    /// that more text may be in the file than `text` holds.
    pub cut_short: bool,
    /// The size of an image, or of a video's picture.
    pub dimensions: Option<Dimensions>,
    /// The length in seconds of a sound or a video, when the file states it.
    pub duration: Option<f64>,
    /// Why OCR read nothing from an image whose size is in `dimensions`. The size is
    /// good and `text` is empty, and the file is to be treated as this refusal says.
    /// An image with no readable size is a plain refusal instead.
    pub text_refused: Option<Refusal>,
    /// How far the process that read the file was shut off from the system, as it said
    /// before it was given the file.
    pub sandbox: Sandbox,
}

/// How far a reading's process was shut off from the system. The reading is good
/// either way: a system that cannot confine a process still reads, and this is how its
/// owner can learn that.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Sandbox {
    /// It could read only the OCR data folder, reach no socket, start no process and
    /// change nothing on disk. On Linux this is the seccomp filter, with Landlock of
    /// any version for a reading that has a data folder. On macOS it is `sandbox_init`.
    Full,
    /// Linux only: one of the two held. Either Landlock held and the filter did not,
    /// so files are closed but `chmod`, UDP and Unix sockets are open; or the filter
    /// held without Landlock on a reading with a data folder, so it could read any
    /// file.
    Partial,
    /// Nothing held it but its resource limits.
    Off,
}

/// A picture's size in pixels, as the file's header states it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

/// Which limit a file was past, so that only raising that one can let it read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    /// `Options::max_inflated_bytes`.
    Inflated,
    /// `Options::max_memory_bytes`.
    Memory,
    /// A bound of the readers themselves, which no option raises.
    Fixed,
}

/// Why a file was not read. The kinds are told apart because a caller treats them
/// differently: `Unsupported`, `Encrypted` and `Malformed` are about the file,
/// `OverLimit` and `TimedOut` about the limits it met, and `OcrUnavailable` and
/// `ReaderUnavailable` about the system, which says nothing about the file.
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
    #[error("the file is past a limit: {1}")]
    OverLimit(Limit, String),
    /// OCR is on, and cannot start: a language that neither the data folder nor the
    /// program holds, or a model that does not load. The file may be fine, and
    /// fixing the setting lets it read. The reason is for the person who sets OCR
    /// up.
    #[error("OCR cannot start: {0}")]
    OcrUnavailable(String),
    /// The reading did not finish in time, so its process was ended.
    #[error("reading the file took too long")]
    TimedOut,
    /// The process that read the file ended by a signal or gave an answer that cannot
    /// be believed. The reason, which names the signal, is for a log.
    #[error("the reader failed: {0}")]
    Crashed(String),
    /// No reader could start: the system is short of something, or the program's file
    /// has gone. The file was not tried, so this says nothing about it.
    #[error("no reader could start: {0}")]
    ReaderUnavailable(String),
}

/// Reads `file`, which holds `len` bytes, in this process, by the MIME type `mime`; its
/// parameters and letter case do not matter, but a `charset` parameter is read as a
/// hint for text.
///
/// A parser that panics on a file it was not built for is a malformed file, not
/// a reason to end the caller.
pub(crate) fn read_here(
    file: &File,
    len: u64,
    mime: &str,
    options: &Options,
) -> Result<Reading, Refusal> {
    let clock = Clock::start(options.time_budget);
    catch_unwind(AssertUnwindSafe(|| {
        read_file(file, len, mime, options, &clock)
    }))
    .unwrap_or_else(|_| Err(panicked()))
}

fn panicked() -> Refusal {
    Refusal::Malformed("the reader failed on this file".into())
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

fn read_file(
    file: &File,
    len: u64,
    mime: &str,
    options: &Options,
    clock: &Clock,
) -> Result<Reading, Refusal> {
    let kind = Kind::of(mime).ok_or(Refusal::Unsupported)?;
    let source = Source::new(file, len);
    if let Kind::Media { matroska } = kind {
        let media = media::read(source, matroska)?;
        return Ok(Reading {
            text: String::new(),
            truncated: false,
            cut_short: false,
            dimensions: media
                .size
                .map(|(width, height)| Dimensions { width, height }),
            duration: media.duration,
            text_refused: None,
            sandbox: Sandbox::Off,
        });
    }
    let bytes = source
        .read_all()
        .map_err(|error| Refusal::Malformed(format!("the file cannot be read: {error}")))?
        .ok_or_else(|| {
            Refusal::OverLimit(
                Limit::Memory,
                format!("no memory to hold a file of {len} bytes"),
            )
        })?;
    read_bytes(&bytes, kind, mime, options, clock)
}

fn read_bytes(
    bytes: &[u8],
    kind: Kind,
    mime: &str,
    options: &Options,
    clock: &Clock,
) -> Result<Reading, Refusal> {
    let mut sink = Sink::new(options.max_text_chars);
    let mut dimensions = None;
    let mut cut_short = false;
    let mut text_refused = None;
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
                // A panic here is a refusal like any other, and leaves the size good.
                let read = catch_unwind(AssertUnwindSafe(|| {
                    image::read_text(bytes, options, clock, &mut sink)
                }))
                .unwrap_or_else(|_| Err(panicked()));
                match read {
                    Ok(short) => cut_short = short,
                    Err(refusal) if dimensions.is_some() => text_refused = Some(refusal),
                    Err(refusal) => return Err(refusal),
                }
            }
        }
        Kind::Pdf => cut_short = pdf::read(bytes, options, clock, &mut sink)?,
        Kind::Media { .. } => return Err(Refusal::Unsupported),
    }
    let (text, truncated) = sink.finish(options.max_text_chars);
    Ok(Reading {
        text,
        truncated,
        cut_short,
        dimensions,
        duration: None,
        text_refused,
        sandbox: Sandbox::Off,
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
