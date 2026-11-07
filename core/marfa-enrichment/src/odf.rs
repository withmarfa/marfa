//! OpenDocument text, presentations and spreadsheets: zip packages whose text
//! is in `content.xml`, with the page headers and footers of a text document
//! or a spreadsheet in `styles.xml`.

use std::io::BufRead;

use quick_xml::events::{BytesStart, Event};

use crate::Refusal;
use crate::package::Package;
use crate::sheet;
use crate::sink::Sink;
use crate::xml::{Xml, attribute, reference};

/// Elements, by their full names, that are not text: who wrote a comment and
/// when, deleted text a tracked change keeps, a footnote's number, an embedded
/// image's bytes.
const SKIPPED: &[&str] = &[
    "dc:creator",
    "dc:date",
    "meta:date-string",
    "meta:creator-initials",
    "text:tracked-changes",
    "text:note-citation",
    "office:binary-data",
];

/// Whether the document encrypts its content, which its manifest says.
fn encrypted(package: &mut Package<'_>) -> Result<bool, Refusal> {
    let Some(mut xml) = package.xml("META-INF/manifest.xml")? else {
        return Ok(false);
    };
    let mut entry = None;
    loop {
        match xml.next()? {
            Event::Eof => return Ok(false),
            Event::Start(e) if e.local_name().into_inner() == "file-entry" => {
                entry = attribute(&e, "full-path")
            }
            Event::End(e) if e.local_name().into_inner() == "file-entry" => entry = None,
            Event::Start(e) | Event::Empty(e)
                if e.local_name().into_inner() == "encryption-data"
                    && entry.as_deref() == Some("content.xml") =>
            {
                return Ok(true);
            }
            _ => {}
        }
    }
}

fn open(package: &mut Package<'_>) -> Result<(), Refusal> {
    if encrypted(package)? {
        return Err(Refusal::Encrypted);
    }
    if !package.has("content.xml") {
        return Err(Refusal::Malformed("the package has no content".into()));
    }
    Ok(())
}

pub(crate) fn read_text(package: &mut Package<'_>, sink: &mut Sink) -> Result<(), Refusal> {
    open(package)?;
    walk_part(package, "content.xml", sink, false)?;
    walk_part(package, "styles.xml", sink, false)
}

pub(crate) fn read_presentation(package: &mut Package<'_>, sink: &mut Sink) -> Result<(), Refusal> {
    open(package)?;
    walk_part(package, "content.xml", sink, false)
}

pub(crate) fn read_spreadsheet(package: &mut Package<'_>, sink: &mut Sink) -> Result<(), Refusal> {
    open(package)?;
    walk_part(package, "content.xml", sink, true)?;
    walk_part(package, "styles.xml", sink, false)
}

fn walk_part(
    package: &mut Package<'_>,
    name: &str,
    sink: &mut Sink,
    sheet: bool,
) -> Result<(), Refusal> {
    match package.xml(name)? {
        Some(xml) => Walker::new(sink, sheet).run(xml),
        None => Ok(()),
    }
}

struct Walker<'s> {
    sink: &'s mut Sink,
    sheet: bool,
    depth: usize,
    /// The depth of the element being skipped, or 0.
    skipping: usize,
    /// The depth of the cell whose displayed text is left out because its value
    /// is read instead, or 0.
    valued: usize,
    paragraphs: usize,
}

impl<'s> Walker<'s> {
    fn new(sink: &'s mut Sink, sheet: bool) -> Self {
        Self {
            sink,
            sheet,
            depth: 0,
            skipping: 0,
            valued: 0,
            paragraphs: 0,
        }
    }

    fn run<R: BufRead>(&mut self, mut xml: Xml<R>) -> Result<(), Refusal> {
        while !self.sink.is_full() {
            match xml.next()? {
                Event::Eof => break,
                Event::Start(e) => {
                    self.depth += 1;
                    self.open(&e, false);
                }
                Event::Empty(e) => {
                    self.depth += 1;
                    self.open(&e, true);
                    if self.skipping == self.depth {
                        self.skipping = 0;
                    }
                    self.depth -= 1;
                }
                Event::End(e) => {
                    self.close(e.local_name().into_inner());
                    self.depth = self.depth.saturating_sub(1);
                }
                Event::Text(t) => self.words(&t),
                Event::CData(t) => self.words(&t),
                Event::GeneralRef(r) => {
                    if let Some(c) = reference(&r) {
                        self.words(c.encode_utf8(&mut [0; 4]));
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn words(&mut self, text: &str) {
        if self.skipping == 0 && self.valued == 0 && self.paragraphs > 0 {
            self.sink.push_words(text, false);
        }
    }

    fn open(&mut self, e: &BytesStart<'_>, empty: bool) {
        if self.skipping != 0 {
            return;
        }
        if SKIPPED.contains(&e.name().as_ref()) {
            self.skipping = self.depth;
            return;
        }
        match e.local_name().into_inner() {
            "p" | "h" if !empty => self.paragraphs += 1,
            "s" => self.sink.separate(),
            "tab" => self.sink.separate(),
            "line-break" => self.sink.break_line(),
            "table" if self.sheet => {
                if let Some(name) = attribute(e, "name") {
                    self.sink.push_words(&name, false);
                    self.sink.break_line();
                }
            }
            "table-cell" | "covered-table-cell" if self.sheet && self.read_value(e) && !empty => {
                self.valued = self.depth;
            }
            _ => {}
        }
        if empty {
            self.close_known(e.local_name().into_inner());
        }
    }

    /// Writes a cell's stored value in place of its displayed text, as a
    /// spreadsheet reader would: a number as a number and a date as a date.
    /// True when the displayed text is to be left out.
    fn read_value(&mut self, cell: &BytesStart<'_>) -> bool {
        let Some(kind) = attribute(cell, "value-type") else {
            return false;
        };
        match kind.as_str() {
            "float" | "percentage" | "currency" => {
                if let Some(value) = attribute(cell, "value") {
                    let shown = value.parse().map_or(value, sheet::number);
                    self.sink.push_words(&shown, false);
                }
                true
            }
            "date" => {
                if let Some(value) = attribute(cell, "date-value") {
                    let day = value.strip_suffix("T00:00:00").unwrap_or(&value);
                    self.sink.push_words(day, false);
                }
                true
            }
            "boolean" => true,
            _ => false,
        }
    }

    fn close(&mut self, name: &str) {
        if self.skipping != 0 {
            if self.depth == self.skipping {
                self.skipping = 0;
            }
            return;
        }
        if self.valued == self.depth {
            self.valued = 0;
        }
        match name {
            "p" | "h" => {
                self.paragraphs = self.paragraphs.saturating_sub(1);
                if self.sheet {
                    self.sink.separate();
                } else {
                    self.sink.break_line();
                }
            }
            _ => self.close_known(name),
        }
    }

    fn close_known(&mut self, name: &str) {
        match name {
            "table-row" | "page" => self.sink.break_line(),
            "table-cell" | "covered-table-cell" => self.sink.separate(),
            _ => {}
        }
    }
}
