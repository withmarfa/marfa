//! A zip package opened for reading with a budget on what it may inflate to.

use std::cell::Cell;
use std::io::{self, BufReader, Cursor, Read};

use zip::ZipArchive;
use zip::read::ZipFile;
use zip::result::ZipError;

use crate::Refusal;
use crate::xml::{Xml, attribute};
use quick_xml::events::Event;

/// Parts a package may hold. A package of more is refused rather than read:
/// no real document comes near it, and a central directory this long is a way
/// to spend time.
const MAX_ENTRIES: usize = 10_000;

/// The bytes still allowed to inflate, across every part read.
pub(crate) struct Budget {
    left: Cell<u64>,
}

/// The error a read returns when the budget runs out, so a caller can tell it
/// from a corrupt stream.
#[derive(Debug)]
struct OutOfBudget;

impl std::fmt::Display for OutOfBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the document inflates past the limit")
    }
}

impl std::error::Error for OutOfBudget {}

/// Counts the bytes that actually come out of `inner`, whatever the zip said
/// they would be.
pub(crate) struct Metered<'b, R> {
    inner: R,
    budget: &'b Budget,
}

impl<R: Read> Read for Metered<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        let left = self.budget.left.get();
        if read as u64 > left {
            self.budget.left.set(0);
            return Err(io::Error::other(OutOfBudget));
        }
        self.budget.left.set(left - read as u64);
        Ok(read)
    }
}

/// The refusal for an I/O error met while reading a part.
pub(crate) fn from_io(error: &io::Error) -> Refusal {
    if error
        .get_ref()
        .is_some_and(|inner| inner.is::<OutOfBudget>())
    {
        Refusal::OverLimit(OutOfBudget.to_string())
    } else {
        Refusal::Malformed(error.to_string())
    }
}

fn from_zip(error: ZipError) -> Refusal {
    match error {
        ZipError::Io(error) => from_io(&error),
        ZipError::UnsupportedArchive(reason) if reason == ZipError::PASSWORD_REQUIRED => {
            Refusal::Encrypted
        }
        ZipError::InvalidPassword => Refusal::Encrypted,
        other => Refusal::Malformed(other.to_string()),
    }
}

pub(crate) struct Package<'a> {
    zip: ZipArchive<Cursor<&'a [u8]>>,
    budget: Budget,
}

impl<'a> Package<'a> {
    pub(crate) fn open(bytes: &'a [u8], max_inflated_bytes: u64) -> Result<Self, Refusal> {
        let mut zip = ZipArchive::new(Cursor::new(bytes)).map_err(from_zip)?;
        if zip.len() > MAX_ENTRIES {
            return Err(Refusal::OverLimit(format!(
                "the package holds more than {MAX_ENTRIES} parts"
            )));
        }
        let budget = Budget {
            left: Cell::new(max_inflated_bytes),
        };
        // The parts together, as the contract counts them, whether or not the
        // reader goes near all of them. A part cannot inflate past the size it
        // states, since the reader stops it there, so this bounds the package.
        match zip.decompressed_size() {
            Some(total) if total > u128::from(max_inflated_bytes) => {
                return Err(Refusal::OverLimit(OutOfBudget.to_string()));
            }
            Some(_) => {}
            // Parts that state no size are counted by inflating them.
            None => {
                for index in 0..zip.len() {
                    let part = zip.by_index(index).map_err(from_zip)?;
                    let mut part = Metered {
                        inner: part,
                        budget: &budget,
                    };
                    io::copy(&mut part, &mut io::sink()).map_err(|error| from_io(&error))?;
                }
                budget.left.set(max_inflated_bytes);
            }
        }
        Ok(Self { zip, budget })
    }

    pub(crate) fn has(&self, name: &str) -> bool {
        self.zip.index_for_name(name).is_some()
    }

    fn open_part(&mut self, name: &str) -> Result<Option<OpenPart<'_, 'a>>, Refusal> {
        let Self { zip, budget } = self;
        let part = match zip.by_name(name) {
            Ok(part) => part,
            Err(ZipError::FileNotFound) => return Ok(None),
            Err(error) => return Err(from_zip(error)),
        };
        // The zip says what it will inflate to, so a part that says more than
        // is left is refused before any of it is. What it says is not trusted:
        // the bytes that come out are counted as well.
        if part.size() > budget.left.get() {
            return Err(Refusal::OverLimit(
                "the document inflates past the limit".into(),
            ));
        }
        Ok(Some(Metered {
            inner: part,
            budget,
        }))
    }

    /// A part's bytes, or none when the package has no such part. Meant for
    /// small parts: a relationships file, a manifest.
    pub(crate) fn read(&mut self, name: &str) -> Result<Option<Vec<u8>>, Refusal> {
        let Some(mut part) = self.open_part(name)? else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        part.read_to_end(&mut bytes)
            .map_err(|error| from_io(&error))?;
        Ok(Some(bytes))
    }

    /// A part as XML events, or none when the package has no such part.
    pub(crate) fn xml(&mut self, name: &str) -> Result<Option<PartXml<'_, 'a>>, Refusal> {
        Ok(self
            .open_part(name)?
            .map(|part| Xml::new(BufReader::new(part))))
    }

    /// The relationships a part declares, with each target resolved to a part
    /// name in the package. An external target is left out.
    pub(crate) fn relationships(&mut self, part: &str) -> Result<Vec<Relationship>, Refusal> {
        let Some(mut xml) = self.xml(&relationships_name(part))? else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        loop {
            match xml.next()? {
                Event::Eof => return Ok(found),
                Event::Start(e) | Event::Empty(e)
                    if e.local_name().into_inner() == "Relationship" =>
                {
                    if attribute(&e, "TargetMode").is_some_and(|mode| mode == "External") {
                        continue;
                    }
                    if let (Some(id), Some(kind), Some(target)) = (
                        attribute(&e, "Id"),
                        attribute(&e, "Type"),
                        attribute(&e, "Target"),
                    ) {
                        found.push(Relationship {
                            id,
                            kind: kind.rsplit('/').next().unwrap_or_default().to_owned(),
                            target: resolve(part, &target),
                        });
                    }
                }
                _ => {}
            }
        }
    }
}

type OpenPart<'p, 'a> = Metered<'p, ZipFile<'p, Cursor<&'a [u8]>>>;

type PartXml<'p, 'a> = Xml<BufReader<OpenPart<'p, 'a>>>;

/// One relationship of a part.
pub(crate) struct Relationship {
    pub(crate) id: String,
    /// The last segment of the relationship's type, such as `header`.
    pub(crate) kind: String,
    pub(crate) target: String,
}

pub(crate) fn relationships_name(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/_rels/{file}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

/// The part name a relationship from `part` reaches by `target`.
pub(crate) fn resolve(part: &str, target: &str) -> String {
    let mut path: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        part.split('/').collect::<Vec<_>>()[..part.split('/').count() - 1].to_vec()
    };
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                path.pop();
            }
            other => path.push(other),
        }
    }
    path.join("/")
}
