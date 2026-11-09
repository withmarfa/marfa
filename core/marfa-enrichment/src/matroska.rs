//! Reads Matroska and WebM duration and dimensions.

use std::io::{self, BufReader, ErrorKind, Read, Seek, SeekFrom};

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

/// The most element headers one walk reads.
const MOST_ELEMENTS: u32 = 1 << 20;

/// The most of the file's end searched for the last cluster.
const TAIL_SEARCH_BYTES: u64 = 32 << 20;

/// The size of one step of that search.
const TAIL_STEP_BYTES: u64 = 1 << 20;

/// A buffered view of the file, so byte-wise header reads make few system calls.
struct Input<'a, 'b> {
    reader: BufReader<&'b mut Source<'a>>,
    len: u64,
}

impl<'a, 'b> Input<'a, 'b> {
    fn new(source: &'b mut Source<'a>) -> Self {
        let len = source.len();
        Self {
            reader: BufReader::new(source),
            len,
        }
    }

    fn len(&self) -> u64 {
        self.len
    }

    /// Moves to `to`, keeping what is buffered when `to` is inside it.
    fn skip_to(&mut self, to: u64) -> io::Result<()> {
        let from = self.reader.stream_position()?;
        let distance = i64::try_from(to.abs_diff(from)).map_err(|_| invalid("a skip too long"))?;
        self.reader
            .seek_relative(if to >= from { distance } else { -distance })
    }
}

impl Read for Input<'_, '_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buffer)
    }
}

impl Seek for Input<'_, '_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.reader.seek(to)
    }

    fn stream_position(&mut self) -> io::Result<u64> {
        self.reader.stream_position()
    }
}

/// How a walk ended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Walked {
    /// It reached the end it was given, or a stop it was allowed.
    Done,
    /// It stopped at the header limit with more ahead.
    Cut,
}

/// An element's id and size; the size is none when unstated.
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
    /// The latest block start, or end where a block states its length, in ticks.
    latest: Option<i64>,
    /// Where the last cluster with a stated size holds its data, and where it ends.
    last_cluster: Option<(u64, u64)>,
    elements: u32,
}

pub(crate) fn read(file: &mut Source) -> Result<Media, Refusal> {
    let source = &mut Input::new(file);
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
    let mut walked = ending_early(walk(source, &mut found, end, true))?;
    let first_cut = walked == Walked::Cut;
    if found.duration.is_none() {
        let (from, until) = match walked {
            Walked::Done => found.last_cluster.unzip(),
            // A cut-off walk has not seen the file's end.
            Walked::Cut => {
                found.latest = None;
                (
                    last_cluster_from_the_end(source, segment.data, end)?,
                    Some(end),
                )
            }
        };
        if let Some(from) = from {
            found.elements = 0;
            found.cluster_time = 0;
            found.block_start = 0;
            source.seek(SeekFrom::Start(from)).map_err(io_refusal)?;
            walked = match walk(source, &mut found, until.unwrap_or(end), false) {
                Err(error) if error.kind() == ErrorKind::InvalidData => Walked::Cut,
                other => ending_early(other)?,
            };
        }
    }
    // A walk cut before the header gave its scale cannot turn ticks into time.
    if walked == Walked::Cut || (first_cut && found.scale.is_none()) {
        // Only part of the file was seen, and a length from part of it is wrong.
        found.latest = None;
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

/// Reads elements up to `end`; `first` stops at the first cluster once the segment's length is known.
fn walk(source: &mut Input, found: &mut Found, end: u64, first: bool) -> io::Result<Walked> {
    while source.stream_position()? < end {
        if found.elements >= MOST_ELEMENTS {
            return Ok(Walked::Cut);
        }
        found.elements += 1;
        let Some(element) = header(source)? else {
            return Ok(Walked::Done);
        };
        match element.id {
            SEGMENT | INFO | TRACKS | TRACK_ENTRY | VIDEO | BLOCK_GROUP => {}
            CLUSTER if first => {
                if found.duration.is_some() {
                    return Ok(Walked::Done);
                }
                // A cluster of unstated size is read in place.
                if let Some(size) = element.size {
                    let last = element.data.saturating_add(size).min(source.len());
                    found.last_cluster = Some((element.data, last));
                    skip(source, &element)?;
                }
            }
            // Reading from the last cluster on, whatever follows is read in place.
            CLUSTER => {}
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
    Ok(Walked::Done)
}

/// Where the last cluster's data starts, searched back from `end` within `TAIL_SEARCH_BYTES`.
fn last_cluster_from_the_end(
    source: &mut Input,
    floor: u64,
    end: u64,
) -> Result<Option<u64>, Refusal> {
    let id = CLUSTER.to_be_bytes();
    let stop = end.saturating_sub(TAIL_SEARCH_BYTES).max(floor);
    let mut step_end = end;
    while step_end > stop {
        let step_start = step_end.saturating_sub(TAIL_STEP_BYTES).max(stop);
        // A little further on, for an id that begins inside this step and ends past it.
        let read_to = (step_end + id.len() as u64 - 1).min(end);
        let mut bytes = vec![0u8; usize::try_from(read_to - step_start).unwrap_or(0)];
        source
            .seek(SeekFrom::Start(step_start))
            .and_then(|_| source.read_exact(&mut bytes))
            .map_err(io_refusal)?;
        for at in bytes
            .windows(id.len())
            .enumerate()
            .filter(|(_, window)| *window == id)
            .map(|(at, _)| at)
            .rev()
        {
            // The step before this one holds the starts of the ids that end here.
            if step_start + at as u64 >= step_end {
                continue;
            }
            if let Some(data) =
                opens_a_cluster(source, step_start + at as u64).map_err(io_refusal)?
            {
                return Ok(Some(data));
            }
        }
        step_end = step_start;
    }
    Ok(None)
}

/// Where the data of the cluster at `at` starts, if it opens with a timecode.
fn opens_a_cluster(source: &mut Input, at: u64) -> io::Result<Option<u64>> {
    source.seek(SeekFrom::Start(at))?;
    let Ok(Some(cluster)) = header(source) else {
        return Ok(None);
    };
    if cluster.id != CLUSTER {
        return Ok(None);
    }
    let Ok(Some(timecode)) = header(source) else {
        return Ok(None);
    };
    Ok((timecode.id == CLUSTER_TIMECODE
        && timecode.size.is_some_and(|size| (1..=8).contains(&size)))
    .then_some(cluster.data))
}

/// A block starts with its track number, then its time from the start of its cluster.
fn block(source: &mut Input, element: &Header, found: &mut Found) -> io::Result<()> {
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

/// Reads an element id, then its size; `None` at the end of the file.
fn header(source: &mut Input) -> io::Result<Option<Header>> {
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
fn vint(source: &mut Input) -> io::Result<Option<(u64, u32)>> {
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

fn skip(source: &mut Input, element: &Header) -> io::Result<()> {
    let size = element
        .size
        .ok_or_else(|| invalid("an element of no stated size"))?;
    let to = element.data.saturating_add(size);
    if to > source.len() {
        return Err(ErrorKind::UnexpectedEof.into());
    }
    source.skip_to(to)
}

fn unsigned(source: &mut Input, element: &Header) -> io::Result<u64> {
    let size = element.size.unwrap_or(u64::MAX);
    if size > 8 {
        return Err(invalid("a number of more than eight bytes"));
    }
    let mut bytes = [0u8; 8];
    source.read_exact(&mut bytes[8 - size as usize..])?;
    Ok(u64::from_be_bytes(bytes))
}

fn float(source: &mut Input, element: &Header) -> io::Result<Option<f64>> {
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
fn ending_early(walked: io::Result<Walked>) -> Result<Walked, Refusal> {
    match walked {
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(Walked::Done),
        other => other.map_err(io_refusal),
    }
}

fn io_refusal(error: io::Error) -> Refusal {
    Refusal::Malformed(format!("the file cannot be read: {error}"))
}
