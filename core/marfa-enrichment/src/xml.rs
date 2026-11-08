//! A bounded way through an XML part: events in order, never an entity
//! expanded, and a stop when it nests too deep.

use std::io::BufRead;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::Refusal;
use crate::package::from_io;

/// Elements open at once. Reading is by events and takes no stack, so this is
/// not for the reader's sake: no real document nests near it.
const MAX_DEPTH: usize = 1024;

pub(crate) struct Xml<R> {
    reader: Reader<R>,
    buf: Vec<u8>,
    depth: usize,
}

impl<R: BufRead> Xml<R> {
    pub(crate) fn new(source: R) -> Self {
        Self {
            reader: Reader::from_reader(source),
            buf: Vec::new(),
            depth: 0,
        }
    }

    /// The next event. A document type declaration comes through as an event
    /// and is never read for the entities it declares, and a reference to one
    /// is handed on unexpanded.
    pub(crate) fn next(&mut self) -> Result<Event<'_>, Refusal> {
        self.buf.clear();
        let event = self
            .reader
            .read_event_into(&mut self.buf)
            .map_err(|error| match &error {
                quick_xml::Error::Io(io) => from_io(io),
                other => Refusal::Malformed(other.to_string()),
            })?;
        match &event {
            Event::Start(_) => {
                self.depth += 1;
                if self.depth > MAX_DEPTH {
                    return Err(Refusal::OverLimit(format!(
                        "the document nests deeper than {MAX_DEPTH} elements"
                    )));
                }
            }
            Event::End(_) => self.depth = self.depth.saturating_sub(1),
            _ => {}
        }
        Ok(event)
    }
}

/// The value of the attribute named `name`, without its prefix.
pub(crate) fn attribute(start: &BytesStart<'_>, name: &str) -> Option<String> {
    start
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| attribute.key.local_name().into_inner() == name)
        .map(|attribute| unescape(&attribute.value))
}

/// Text with its predefined and numeric references replaced. A reference to an
/// entity the document declares is dropped.
pub(crate) fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        match rest.find(';') {
            Some(end) => {
                if let Some(c) = reference(&rest[1..end]) {
                    out.push(c);
                }
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The character a reference names: one of the five predefined entities or a
/// number.
pub(crate) fn reference(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}
