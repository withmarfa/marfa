//! An EPUB book: its chapters in reading order, each an XHTML page.

use quick_xml::events::Event;

use crate::Refusal;
use crate::html;
use crate::package::{Package, resolve};
use crate::sink::Sink;
use crate::xml::attribute;

const CONTAINER: &str = "META-INF/container.xml";

pub(crate) fn read(package: &mut Package<'_>, sink: &mut Sink) -> Result<(), Refusal> {
    let package_file = root_file(package)?
        .ok_or_else(|| Refusal::Malformed("the book names no package file".into()))?;
    for chapter in spine(package, &package_file)? {
        if sink.is_full() {
            break;
        }
        if let Some(bytes) = package.read(&chapter)? {
            sink.break_line();
            html::read(&bytes, "application/xhtml+xml", true, sink);
        }
    }
    Ok(())
}

/// The package file the container names.
fn root_file(package: &mut Package<'_>) -> Result<Option<String>, Refusal> {
    let Some(mut xml) = package.xml(CONTAINER)? else {
        return Ok(None);
    };
    loop {
        match xml.next()? {
            Event::Eof => return Ok(None),
            Event::Start(e) | Event::Empty(e) if e.local_name().into_inner() == "rootfile" => {
                if let Some(path) = attribute(&e, "full-path") {
                    return Ok(Some(path));
                }
            }
            _ => {}
        }
    }
}

/// The parts of the book's pages, in the order the spine gives.
fn spine(package: &mut Package<'_>, package_file: &str) -> Result<Vec<String>, Refusal> {
    let Some(mut xml) = package.xml(package_file)? else {
        return Err(Refusal::Malformed("the book has no package file".into()));
    };
    let mut items = Vec::new();
    let mut order = Vec::new();
    loop {
        match xml.next()? {
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) => match e.local_name().into_inner() {
                "item" => {
                    let page = attribute(&e, "media-type")
                        .is_some_and(|kind| kind == "application/xhtml+xml" || kind == "text/html");
                    if let (true, Some(id), Some(href)) =
                        (page, attribute(&e, "id"), attribute(&e, "href"))
                    {
                        items.push((id, resolve(package_file, &href)));
                    }
                }
                "itemref" => order.extend(attribute(&e, "idref")),
                _ => {}
            },
            _ => {}
        }
    }
    Ok(order
        .into_iter()
        .filter_map(|id| {
            items
                .iter()
                .find(|(item, _)| *item == id)
                .map(|(_, part)| part.clone())
        })
        .collect())
}
