//! Word and PowerPoint documents, which are zip packages of XML parts.

use std::collections::HashSet;

use quick_xml::events::{BytesStart, Event};

use crate::Refusal;
use crate::package::{Package, Relationship};
use crate::sink::Sink;
use crate::xml::{attribute, reference};

/// The element names whose character data is text.
const WORD_TEXT: &[&str] = &["t"];
/// A legacy PowerPoint comment holds its text as the content of `p:text`, and a
/// modern one as DrawingML runs.
const COMMENT_TEXT: &[&str] = &["text", "t"];

/// Whether the element and everything in it is left unread.
fn skipped(start: &BytesStart<'_>) -> bool {
    match start.local_name().into_inner() {
        // Text a reviewer deleted or moved away, and what a field computes
        // its result from.
        "del" | "moveFrom" | "delText" | "instrText" | "delInstrText" => true,
        // The second copy of what `mc:Choice` holds, for readers that do not
        // know the first.
        "Fallback" => true,
        // The number of the slide the note or the slide itself is on.
        "fld" => attribute(start, "type").is_some_and(|kind| kind == "slidenum"),
        _ => false,
    }
}

/// Reads the character data of the elements named in `names` from one part.
fn read_part(
    package: &mut Package<'_>,
    name: &str,
    names: &[&str],
    sink: &mut Sink,
) -> Result<(), Refusal> {
    let Some(mut xml) = package.xml(name)? else {
        return Ok(());
    };
    let mut depth = 0usize;
    // The depth of the element being skipped, or 0.
    let mut skipping = 0usize;
    let mut in_text = false;
    while !sink.is_full() {
        match xml.next()? {
            Event::Eof => break,
            Event::Start(e) => {
                depth += 1;
                if skipping == 0 {
                    if skipped(&e) {
                        skipping = depth;
                    } else if names.contains(&e.local_name().into_inner()) {
                        in_text = true;
                    }
                }
            }
            Event::Empty(e) if skipping == 0 => match e.local_name().into_inner() {
                "tab" | "ptab" => sink.separate(),
                "br" | "cr" => sink.break_line(),
                "noBreakHyphen" => sink.push_words("-", false),
                _ => {}
            },
            Event::Text(t) if skipping == 0 && in_text => sink.push_words(&t, false),
            Event::CData(t) if skipping == 0 && in_text => sink.push_words(&t, false),
            Event::GeneralRef(r) if skipping == 0 && in_text => {
                if let Some(c) = reference(&r) {
                    sink.push_words(c.encode_utf8(&mut [0; 4]), false);
                }
            }
            Event::End(e) => {
                if skipping != 0 {
                    if depth == skipping {
                        skipping = 0;
                    }
                } else if names.contains(&e.local_name().into_inner()) {
                    in_text = false;
                } else if e.local_name().into_inner() == "p" {
                    sink.break_line();
                }
                depth = depth.saturating_sub(1);
            }
            _ => {}
        }
    }
    // The next part starts on a line of its own.
    sink.break_line();
    Ok(())
}

/// The package's main part, which its root relationships name.
fn main_part(package: &mut Package<'_>, conventional: &str) -> Result<String, Refusal> {
    Ok(package
        .relationships("")?
        .into_iter()
        .find(|r| r.kind == "officeDocument")
        .map_or_else(|| conventional.to_owned(), |r| r.target))
}

fn targets<'r>(
    relationships: &'r [Relationship],
    kind: &'r str,
) -> impl Iterator<Item = &'r str> + 'r {
    relationships
        .iter()
        .filter(move |r| r.kind == kind)
        .map(|r| r.target.as_str())
}

/// Word: the body, then footnotes, endnotes, comments, headers, footers and the
/// text of diagrams.
pub(crate) fn read_docx(package: &mut Package<'_>, sink: &mut Sink) -> Result<(), Refusal> {
    let main = main_part(package, "word/document.xml")?;
    if !package.has(&main) {
        return Err(Refusal::Malformed("the package has no document".into()));
    }
    let relationships = package.relationships(&main)?;
    read_part(package, &main, WORD_TEXT, sink)?;
    let mut read = HashSet::new();
    for kind in [
        "footnotes",
        "endnotes",
        "comments",
        "header",
        "footer",
        "diagramData",
    ] {
        for target in targets(&relationships, kind) {
            if read.insert(target) {
                read_part(package, target, WORD_TEXT, sink)?;
            }
        }
    }
    Ok(())
}

/// PowerPoint: each slide in the order the presentation puts them, followed by
/// that slide's diagrams, notes and comments.
pub(crate) fn read_pptx(package: &mut Package<'_>, sink: &mut Sink) -> Result<(), Refusal> {
    let main = main_part(package, "ppt/presentation.xml")?;
    let order = {
        let Some(mut xml) = package.xml(&main)? else {
            return Err(Refusal::Malformed("the package has no presentation".into()));
        };
        let mut order = Vec::new();
        loop {
            match xml.next()? {
                Event::Eof => break order,
                Event::Start(e) | Event::Empty(e) if e.local_name().into_inner() == "sldId" => {
                    if let Some(id) = qualified_id(&e) {
                        order.push(id);
                    }
                }
                _ => {}
            }
        }
    };
    let relationships = package.relationships(&main)?;
    for id in order {
        let Some(slide) = relationships
            .iter()
            .find(|r| r.id == id && r.kind == "slide")
            .map(|r| r.target.clone())
        else {
            continue;
        };
        read_part(package, &slide, WORD_TEXT, sink)?;
        let attached = package.relationships(&slide)?;
        for target in targets(&attached, "diagramData") {
            read_part(package, target, WORD_TEXT, sink)?;
        }
        for target in targets(&attached, "notesSlide") {
            read_part(package, target, WORD_TEXT, sink)?;
        }
        for target in targets(&attached, "comments") {
            read_part(package, target, COMMENT_TEXT, sink)?;
        }
    }
    Ok(())
}

/// The `r:id` of a sheet or slide entry, which shares its local name with the
/// entry's own numeric `id`.
pub(crate) fn qualified_id(start: &BytesStart<'_>) -> Option<String> {
    start
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|a| a.key.prefix().is_some() && a.key.local_name().into_inner() == "id")
        .map(|a| a.value.to_string())
}
