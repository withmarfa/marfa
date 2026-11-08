//! Spreadsheets: workbooks read cell by cell with `calamine`, and OpenDocument
//! ones through the OpenDocument reader.

use std::io::Cursor;

use calamine::{DataRef, ExcelDateTime, Reader, SheetType, Xls, Xlsb, Xlsx};
use quick_xml::events::Event;

use crate::kind::Sheet;
use crate::ooxml::qualified_id;
use crate::package::{Package, from_io};
use crate::sink::Sink;
use crate::xml::{attribute, reference};
use crate::{Limit, Options, Refusal, encrypted, odf};

pub(crate) fn read(
    sheet: Sheet,
    bytes: &[u8],
    options: &Options,
    sink: &mut Sink,
) -> Result<(), Refusal> {
    encrypted::refuse_if_wrapped(bytes)?;
    match sheet {
        Sheet::Ods => {
            odf::read_spreadsheet(&mut Package::open(bytes, options.max_inflated_bytes)?, sink)
        }
        Sheet::Xlsx => read_xlsx(bytes, options, sink),
        Sheet::Xlsb => read_xlsb(bytes, options, sink),
        Sheet::Xls => read_xls(bytes, options, sink),
    }
}

/// A number as a person would write it: `23`, not `23.0`.
pub(crate) fn number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

/// A date as `2018-09-20`, with the time after it when there is one, and a time
/// of day alone as `10:30:00`.
fn date(value: &ExcelDateTime) -> String {
    if value.is_duration() {
        let seconds = (value.as_f64() * 86_400.0).round() as i64;
        return format!(
            "{}:{:02}:{:02}",
            seconds / 3600,
            seconds % 3600 / 60,
            seconds % 60
        );
    }
    let (year, month, day, hour, minute, second, _) = value.to_ymd_hms_milli();
    if value.as_f64() >= 0.0 && value.as_f64() < 1.0 {
        format!("{hour:02}:{minute:02}:{second:02}")
    } else if (hour, minute, second) == (0, 0, 0) {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
    }
}

/// A cell's text: strings, numbers and dates. Booleans and errors say nothing a
/// search would look for.
fn cell_text(value: &DataRef<'_>) -> Option<String> {
    match value {
        DataRef::String(text) => Some(text.clone()),
        DataRef::SharedString(text) => Some((*text).to_owned()),
        DataRef::Int(value) => Some(value.to_string()),
        DataRef::Float(value) => Some(number(*value)),
        DataRef::DateTime(value) => Some(date(value)),
        DataRef::DateTimeIso(text) | DataRef::DurationIso(text) => Some(text.clone()),
        DataRef::Bool(_) | DataRef::Error(_) | DataRef::Empty => None,
    }
}

/// Writes one cell, a line break before the first of a row and a space between
/// the others.
struct Rows {
    row: Option<u32>,
}

impl Rows {
    fn push(&mut self, sink: &mut Sink, at: (u32, u32), value: &str) {
        if self.row == Some(at.0) {
            sink.separate();
        } else {
            sink.break_line();
            self.row = Some(at.0);
        }
        sink.push_words(value, false);
    }
}

fn start_sheet(sink: &mut Sink, name: &str) -> Rows {
    sink.break_line();
    sink.push_words(name, false);
    sink.break_line();
    Rows { row: None }
}

/// The names of the sheets of an Open XML or binary 2007 workbook that hold
/// cells. Reading a chart sheet as cells fails the whole workbook. A legacy
/// workbook reads one without a fault, and its cells are the chart's data.
fn cell_sheets<RS: std::io::Read + std::io::Seek, R: Reader<RS>>(workbook: &R) -> Vec<String> {
    workbook
        .sheets_metadata()
        .iter()
        .filter(|sheet| !matches!(sheet.typ, SheetType::ChartSheet | SheetType::Vba))
        .map(|sheet| sheet.name.clone())
        .collect()
}

fn refusal<E: std::fmt::Display>(error: &E) -> Refusal {
    Refusal::Malformed(error.to_string())
}

fn read_xlsx(bytes: &[u8], options: &Options, sink: &mut Sink) -> Result<(), Refusal> {
    // The package is opened first for the size of everything in it, which
    // `calamine` does not limit.
    let mut package = Package::open(bytes, options.max_inflated_bytes)?;
    let parts = worksheet_parts(&mut package)?;
    let mut workbook: Xlsx<_> = Xlsx::new(Cursor::new(bytes)).map_err(|error| match error {
        calamine::XlsxError::Password => Refusal::Encrypted,
        calamine::XlsxError::Io(error) => from_io(&error),
        other => refusal(&other),
    })?;
    for name in cell_sheets(&workbook) {
        if sink.is_full() {
            break;
        }
        let mut rows = start_sheet(sink, &name);
        let mut reader = workbook
            .worksheet_cells_reader(&name)
            .map_err(|e| refusal(&e))?;
        while let Some(cell) = reader.next_cell().map_err(|e| refusal(&e))? {
            if sink.is_full() {
                break;
            }
            if let Some(shown) = cell_text(cell.get_value()) {
                rows.push(sink, cell.get_position(), &shown);
            }
        }
        let part = parts.iter().find(|(sheet, _)| *sheet == name);
        if let (Some((_, part)), false) = (part, sink.is_full())
            && let Some(printed) = print_text(&mut package, part)?
        {
            sink.break_line();
            sink.push_words(&printed, false);
        }
    }
    Ok(())
}

fn read_xlsb(bytes: &[u8], options: &Options, sink: &mut Sink) -> Result<(), Refusal> {
    // The package is opened for the size of everything in it, which `calamine`
    // does not limit.
    Package::open(bytes, options.max_inflated_bytes)?;
    let mut workbook: Xlsb<_> = Xlsb::new(Cursor::new(bytes)).map_err(|error| match error {
        calamine::XlsbError::Password => Refusal::Encrypted,
        calamine::XlsbError::Io(error) => from_io(&error),
        other => refusal(&other),
    })?;
    for name in cell_sheets(&workbook) {
        if sink.is_full() {
            break;
        }
        let mut rows = start_sheet(sink, &name);
        let mut reader = workbook
            .worksheet_cells_reader(&name)
            .map_err(|e| refusal(&e))?;
        while let Some(cell) = reader.next_cell().map_err(|e| refusal(&e))? {
            if sink.is_full() {
                break;
            }
            if let Some(shown) = cell_text(cell.get_value()) {
                rows.push(sink, cell.get_position(), &shown);
            }
        }
    }
    Ok(())
}

fn read_xls(bytes: &[u8], options: &Options, sink: &mut Sink) -> Result<(), Refusal> {
    // A binary workbook has no zip to count. Its cells are held in memory
    // whole, so its size stands in for what the limit bounds.
    if bytes.len() as u64 > options.max_inflated_bytes {
        return Err(Refusal::OverLimit(
            Limit::Inflated,
            "the workbook is larger than the limit".into(),
        ));
    }
    let mut workbook: Xls<_> = Xls::new(Cursor::new(bytes)).map_err(|error| match error {
        calamine::XlsError::Password => Refusal::Encrypted,
        calamine::XlsError::Io(error) => from_io(&error),
        other => refusal(&other),
    })?;
    for name in workbook.sheet_names() {
        if sink.is_full() {
            break;
        }
        let mut rows = start_sheet(sink, &name);
        let range = workbook.worksheet_range(&name).map_err(|e| refusal(&e))?;
        for (row, column, value) in range.cells() {
            if sink.is_full() {
                break;
            }
            let shown = match value {
                calamine::Data::String(text) => text.clone(),
                calamine::Data::Int(value) => value.to_string(),
                calamine::Data::Float(value) => number(*value),
                calamine::Data::DateTime(value) => date(value),
                calamine::Data::DateTimeIso(text) | calamine::Data::DurationIso(text) => {
                    text.clone()
                }
                calamine::Data::Bool(_) | calamine::Data::Error(_) | calamine::Data::Empty => {
                    continue;
                }
            };
            rows.push(sink, (row as u32, column as u32), &shown);
        }
    }
    Ok(())
}

/// The part of each worksheet, by the worksheet's name.
fn worksheet_parts(package: &mut Package<'_>) -> Result<Vec<(String, String)>, Refusal> {
    let workbook = package
        .relationships("")?
        .into_iter()
        .find(|r| r.kind == "officeDocument")
        .map_or_else(|| "xl/workbook.xml".to_owned(), |r| r.target);
    let relationships = package.relationships(&workbook)?;
    let Some(mut xml) = package.xml(&workbook)? else {
        return Err(Refusal::Malformed("the package has no workbook".into()));
    };
    let mut parts = Vec::new();
    loop {
        match xml.next()? {
            Event::Eof => return Ok(parts),
            Event::Start(e) | Event::Empty(e) if e.local_name().into_inner() == "sheet" => {
                let part = qualified_id(&e).and_then(|id| {
                    relationships
                        .iter()
                        .find(|r| r.id == id && r.kind == "worksheet")
                });
                if let (Some(name), Some(part)) = (attribute(&e, "name"), part) {
                    parts.push((name, part.target.clone()));
                }
            }
            _ => {}
        }
    }
}

/// The words in a worksheet's print headers and footers.
fn print_text(package: &mut Package<'_>, part: &str) -> Result<Option<String>, Refusal> {
    let Some(mut xml) = package.xml(part)? else {
        return Ok(None);
    };
    let mut found = String::new();
    let mut raw = String::new();
    let mut inside = false;
    loop {
        match xml.next()? {
            Event::Eof => break,
            Event::Start(e) => {
                inside = matches!(
                    e.local_name().into_inner(),
                    "oddHeader"
                        | "oddFooter"
                        | "evenHeader"
                        | "evenFooter"
                        | "firstHeader"
                        | "firstFooter"
                );
            }
            Event::Text(t) if inside => raw.push_str(&t),
            Event::GeneralRef(r) if inside => raw.extend(reference(&r)),
            Event::End(_) if inside => {
                inside = false;
                found.push_str(&print_words(&raw));
                found.push(' ');
                raw.clear();
            }
            _ => {}
        }
    }
    Ok((!found.trim().is_empty()).then(|| found.trim().to_owned()))
}

/// A header or footer string without the codes Excel puts in it: `&L`, `&C` and
/// `&R` name the section, `&P` the page number, `&"Arial,Bold"` a font and `&12`
/// a size. `&&` is an ampersand.
fn print_words(code: &str) -> String {
    let mut out = String::new();
    let mut chars = code.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '&' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('&') => out.push('&'),
            Some('L' | 'C' | 'R') => out.push(' '),
            Some('"') => {
                for c in chars.by_ref() {
                    if c == '"' {
                        break;
                    }
                }
            }
            Some('K') => {
                for _ in 0..6 {
                    chars.next_if(char::is_ascii_hexdigit);
                }
            }
            Some(c) if c.is_ascii_digit() => while chars.next_if(char::is_ascii_digit).is_some() {},
            _ => {}
        }
    }
    out
}
