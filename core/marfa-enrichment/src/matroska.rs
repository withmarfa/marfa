//! A Matroska or WebM file's length and picture size, from its element headers.
//!
//! The file is walked by element headers and each element it does not need is stepped
//! over. A walk reads at most `MOST_ELEMENTS` headers, so the cost does not grow with
//! the size of the file.

use std::io::{self, ErrorKind, Read, Seek, SeekFrom};

use crate::Refusal;
use crate::media::Media;
use crate::source::Source;

const EBML: u32 = 0x1A45_DFA3;
const SEGMENT: u32 = 0x1853_8067;
const INFO: u32 = 0x1549_A966;
const TIMECODE_SCALE: u32 = 0x2A_D7B1;
const DURATION: u32 = 0x4489;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const VIDEO: u32 = 0xE0;
const PIXEL_WIDTH: u32 = 0xB0;
const PIXEL_HEIGHT: u32 = 0xBA;
const CLUSTER: u32 = 0x1F43_B675;
const CLUSTER_TIMECODE: u32 = 0xE7;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK_GROUP: u32 = 0xA0;
const BLOCK: u32 = 0xA1;
const BLOCK_DURATION: u32 = 0x9B;

/// Nanoseconds in a timecode tick unless the file says otherwise.
const DEFAULT_TIMECODE_SCALE: u64 = 1_000_000;

/// The most element headers one walk reads. A real file has far fewer before its
/// clusters, and a hostile one is cut off here.
const MOST_ELEMENTS: u32 = 1 << 20;

/// An element's header: its id, and the size of what follows, or none when the size is
/// not stated.
struct Header {
    id: u32,
    size: Option<u64>,
    data: u64,
}

#[derive(Default)]
struct Found {
    /// Nanoseconds in one timecode tick.
    scale: Option<u64>,
    /// The duration the segment states, in ticks.
    duration: Option<f64>,
    width: Option<u32>,
    height: Option<u32>,
    cluster_time: i64,
    block_start: i64,
    /// The latest block start seen, or block end where a block states its length, in
    /// ticks.
    latest: Option<i64>,
    /// Where the last cluster with a stated size holds its data, and where it ends.
    last_cluster: Option<(u64, u64)>,
    elements: u32,
}

pub(crate) fn read(source: &mut Source) -> Result<Media, Refusal> {
    let malformed = |why: &str| Refusal::Malformed(why.to_owned());
    let start = header(source)
        .map_err(io_refusal)?
        .ok_or_else(|| malformed("not a Matroska file"))?;
    if start.id != EBML {
        return Err(malformed("not a Matroska file"));
    }
    skip(source, &start).map_err(io_refusal)?;
    let segment = header(source)
        .map_err(io_refusal)?
        .filter(|segment| segment.id == SEGMENT)
        .ok_or_else(|| malformed("a Matroska file with no segment"))?;

    let mut found = Found::default();
    let end = segment.size.map_or(source.len(), |size| {
        segment.data.saturating_add(size).min(source.len())
    });
    ending_early(walk(source, &mut found, end, true))?;
    if found.duration.is_none()
        && let Some((data, last_end)) = found.last_cluster
    {
        source.seek(SeekFrom::Start(data)).map_err(io_refusal)?;
        found.elements = 0;
        ending_early(walk(source, &mut found, last_end, false))?;
    }

    let scale = found.scale.unwrap_or(DEFAULT_TIMECODE_SCALE) as f64 / 1e9;
    let ticks = found
        .duration
        .or_else(|| found.latest.map(|latest| latest.max(0) as f64));
    let duration = ticks.map(|ticks| ticks * scale);
    let size = match (found.width, found.height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Some((width, height)),
        _ => None,
    };
    Ok(Media {
        duration: duration.map(crate::media::checked_duration).transpose()?,
        size,
    })
}

/// Reads elements up to `end`. With `first`, the walk stops at the first cluster once
/// the segment has said how long it is, and keeps the last cluster whose size it knows.
fn walk(source: &mut Source, found: &mut Found, end: u64, first: bool) -> io::Result<()> {
    while found.elements < MOST_ELEMENTS && source.stream_position()? < end {
        found.elements += 1;
        let Some(element) = header(source)? else {
            return Ok(());
        };
        match element.id {
            SEGMENT | INFO | TRACKS | TRACK_ENTRY | VIDEO | BLOCK_GROUP => {}
            CLUSTER if first => {
                if found.duration.is_some() {
                    return Ok(());
                }
                // Without a size a cluster cannot be stepped over, so its blocks are read
                // in place.
                if let Some(size) = element.size {
                    let last = element.data.saturating_add(size).min(source.len());
                    found.last_cluster = Some((element.data, last));
                    skip(source, &element)?;
                }
            }
            CLUSTER_TIMECODE => {
                found.cluster_time = i64::try_from(unsigned(source, &element)?).unwrap_or(0);
            }
            TIMECODE_SCALE => found.scale = Some(unsigned(source, &element)?).filter(|s| *s > 0),
            DURATION => found.duration = float(source, &element)?,
            PIXEL_WIDTH => {
                let width = u32::try_from(unsigned(source, &element)?).ok();
                found.width = found.width.or(width);
            }
            PIXEL_HEIGHT => {
                let height = u32::try_from(unsigned(source, &element)?).ok();
                found.height = found.height.or(height);
            }
            SIMPLE_BLOCK | BLOCK => block(source, &element, found)?,
            BLOCK_DURATION => {
                let length = i64::try_from(unsigned(source, &element)?).unwrap_or(0);
                let end = found.block_start.saturating_add(length);
                found.latest = Some(found.latest.map_or(end, |latest| latest.max(end)));
            }
            _ => skip(source, &element)?,
        }
    }
    Ok(())
}

/// A block starts with its track number, then its time from the start of its cluster.
fn block(source: &mut Source, element: &Header, found: &mut Found) -> io::Result<()> {
    let size = element.size.unwrap_or(0);
    let (_, track_length) = vint(source)?.ok_or(ErrorKind::UnexpectedEof)?;
    let mut offset = [0u8; 2];
    source.read_exact(&mut offset)?;
    if size >= u64::from(track_length) + 3 {
        let start = found
            .cluster_time
            .saturating_add(i64::from(i16::from_be_bytes(offset)));
        found.block_start = start;
        found.latest = Some(found.latest.map_or(start, |latest| latest.max(start)));
    }
    skip(source, element)
}

/// Reads an element id, then its size. `None` at the end of the file, and an error for
/// bytes that are no header.
fn header(source: &mut Source) -> io::Result<Option<Header>> {
    let Some((id, id_length)) = vint(source)? else {
        return Ok(None);
    };
    if id_length > 4 {
        return Err(invalid("an element id of more than four bytes"));
    }
    let Some((size, size_length)) = vint(source)? else {
        return Ok(None);
    };
    let unknown = (1u64 << (7 * size_length)) - 1;
    // `vint` kept the length marker of an id and dropped it from a size.
    let marker_free = size & unknown;
    Ok(Some(Header {
        id: u32::try_from(id).map_err(|_| invalid("an element id too long"))?,
        size: (marker_free != unknown).then_some(marker_free),
        data: source.stream_position()?,
    }))
}

/// A variable-length integer: its value with the length marker still in, and its length.
fn vint(source: &mut Source) -> io::Result<Option<(u64, u32)>> {
    let mut first = [0u8; 1];
    if source.read(&mut first)? == 0 {
        return Ok(None);
    }
    let length = first[0].leading_zeros() + 1;
    if length > 8 {
        return Err(invalid("a bad variable-length integer"));
    }
    let mut value = u64::from(first[0]);
    for _ in 1..length {
        let mut next = [0u8; 1];
        source.read_exact(&mut next)?;
        value = value << 8 | u64::from(next[0]);
    }
    Ok(Some((value, length)))
}

fn skip(source: &mut Source, element: &Header) -> io::Result<()> {
    let size = element
        .size
        .ok_or_else(|| invalid("an element of no stated size"))?;
    let to = element.data.saturating_add(size);
    if to > source.len() {
        return Err(ErrorKind::UnexpectedEof.into());
    }
    source.seek(SeekFrom::Start(to)).map(drop)
}

fn unsigned(source: &mut Source, element: &Header) -> io::Result<u64> {
    let size = element.size.unwrap_or(u64::MAX);
    if size > 8 {
        return Err(invalid("a number of more than eight bytes"));
    }
    let mut bytes = [0u8; 8];
    source.read_exact(&mut bytes[8 - size as usize..])?;
    Ok(u64::from_be_bytes(bytes))
}

fn float(source: &mut Source, element: &Header) -> io::Result<Option<f64>> {
    Ok(match element.size {
        Some(4) => {
            let mut bytes = [0u8; 4];
            source.read_exact(&mut bytes)?;
            Some(f64::from(f32::from_be_bytes(bytes)))
        }
        Some(8) => {
            let mut bytes = [0u8; 8];
            source.read_exact(&mut bytes)?;
            Some(f64::from_be_bytes(bytes))
        }
        _ => {
            skip(source, element)?;
            None
        }
    })
}

fn invalid(why: &str) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, why.to_owned())
}

/// A file that ends early is read as far as it goes.
fn ending_early(walked: io::Result<()>) -> Result<(), Refusal> {
    match walked {
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(()),
        other => other.map_err(io_refusal),
    }
}

fn io_refusal(error: io::Error) -> Refusal {
    Refusal::Malformed(format!("the file cannot be read: {error}"))
}
