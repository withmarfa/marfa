//! A gzip line file cut into segments that end on a line, each cut held to the disk reserve.

use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};

use flate2::Compression;
use flate2::write::GzEncoder;

use crate::app::blobs::{Room, Scratch, out_of_room};
use crate::app::refusal::{Refusal, Result};

/// How much line text a segment holds before it is cut.
const SEGMENT_BYTES: usize = 1024 * 1024;
const CHUNK: usize = 256 * 1024;

struct Counted<W> {
    inner: W,
    written: u64,
}

impl<W: Write> Write for Counted<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let count = self.inner.write(bytes)?;
        self.written += count as u64;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn written(error: io::Error) -> Refusal {
    out_of_room(&error).unwrap_or_else(|| {
        Refusal::internal(&format!("an export's spool was not written: {error}"))
    })
}

/// A line file being written, with what each segment's lines need of the reader.
pub struct Lines<N> {
    scratch: Scratch,
    room: Room,
    encoder: GzEncoder<Counted<BufWriter<File>>>,
    segments: Vec<(u64, N)>,
    open: N,
    pending: usize,
    pub lines: u64,
}

impl<N: Default> Lines<N> {
    pub fn new(mut scratch: Scratch, room: Room) -> Result<Lines<N>> {
        let file = scratch.file().try_clone().map_err(written)?;
        let counted = Counted {
            inner: BufWriter::with_capacity(CHUNK, file),
            written: 0,
        };
        Ok(Lines {
            scratch,
            room,
            encoder: GzEncoder::new(counted, Compression::default()),
            segments: Vec::new(),
            open: N::default(),
            pending: 0,
            lines: 0,
        })
    }

    /// Writes one line, adding what it needs of the reader to its segment's needs.
    pub fn push(&mut self, line: &str, need: impl FnOnce(&mut N)) -> Result<()> {
        self.encoder
            .write_all(line.as_bytes())
            .and_then(|()| self.encoder.write_all(b"\n"))
            .map_err(written)?;
        need(&mut self.open);
        self.pending += line.len() + 1;
        self.lines += 1;
        if self.pending >= SEGMENT_BYTES {
            self.cut()?;
        }
        Ok(())
    }

    fn cut(&mut self) -> Result<()> {
        self.encoder.flush().map_err(written)?;
        self.room.check()?;
        let end = self.encoder.get_ref().written;
        self.segments.push((end, std::mem::take(&mut self.open)));
        self.pending = 0;
        Ok(())
    }

    pub fn finish(mut self) -> Result<Spooled<N>> {
        if self.pending > 0 || self.segments.is_empty() {
            self.cut()?;
        }
        let mut counted = self.encoder.finish().map_err(written)?;
        counted.flush().map_err(written)?;
        let size = counted.written;
        if let Some(last) = self.segments.last_mut() {
            last.0 = size;
        }
        Ok(Spooled {
            scratch: self.scratch,
            size,
            segments: self.segments,
            lines: self.lines,
        })
    }
}

/// A finished line file: its size, and the end of each segment with what its lines need.
pub struct Spooled<N> {
    scratch: Scratch,
    pub size: u64,
    pub segments: Vec<(u64, N)>,
    pub lines: u64,
}

impl<N> Spooled<N> {
    /// Opens the file for reading from the start. It blocks.
    pub fn open(&self) -> io::Result<File> {
        let mut file = self.scratch.reopen()?;
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
}

/// Reads up to `CHUNK` bytes, but none past `end`, from where the file stands at `at`. It blocks.
pub fn read_chunk(file: &mut File, at: u64, end: u64) -> io::Result<Vec<u8>> {
    let want = usize::try_from(end.saturating_sub(at))
        .unwrap_or(CHUNK)
        .min(CHUNK);
    let mut buffer = vec![0; want];
    let mut filled = 0;
    while filled < want {
        let count = file.read(&mut buffer[filled..])?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        filled += count;
    }
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use flate2::read::MultiGzDecoder;

    use std::sync::Arc;

    use super::*;
    use crate::app::faults::Faults;
    use crate::app::refusal::Code;

    fn scratch(dir: &std::path::Path) -> Scratch {
        Scratch::at(dir.join("spool")).unwrap()
    }

    fn room(dir: &std::path::Path, faults: Arc<Faults>, reserve: u64) -> Room {
        Room::at(faults, dir.to_path_buf(), reserve)
    }

    fn unreserved(dir: &std::path::Path) -> Room {
        room(dir, Arc::default(), 0)
    }

    #[test]
    fn segments_end_on_lines_and_the_file_reads_back_whole() {
        let dir = tempfile::tempdir().unwrap();
        let mut lines: Lines<Vec<usize>> =
            Lines::new(scratch(dir.path()), unreserved(dir.path())).unwrap();
        let long = "x".repeat(400 * 1024);
        for at in 0..7 {
            lines
                .push(&format!("{at}{long}"), |need| need.push(at))
                .unwrap();
        }
        let spooled = lines.finish().unwrap();
        assert_eq!(spooled.lines, 7);
        assert!(spooled.segments.len() >= 2);
        assert_eq!(spooled.segments.last().unwrap().0, spooled.size);
        let needs: Vec<usize> = spooled
            .segments
            .iter()
            .flat_map(|(_, n)| n.clone())
            .collect();
        assert_eq!(needs, (0..7).collect::<Vec<_>>());
        let mut file = spooled.open().unwrap();
        let mut at = 0;
        for (end, _) in &spooled.segments {
            while at < *end {
                at += read_chunk(&mut file, at, *end).unwrap().len() as u64;
            }
        }
        assert_eq!(at, spooled.size);
        let mut whole = String::new();
        MultiGzDecoder::new(spooled.open().unwrap())
            .read_to_string(&mut whole)
            .unwrap();
        assert_eq!(whole.lines().count(), 7);
        assert!(whole.ends_with('\n'));
    }

    #[test]
    fn the_file_goes_with_the_spool() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("spool");
        let lines: Lines<()> =
            Lines::new(Scratch::at(path.clone()).unwrap(), unreserved(dir.path())).unwrap();
        let spooled = lines.finish().unwrap();
        assert!(path.exists());
        drop(spooled);
        assert!(!path.exists());
    }

    #[test]
    fn a_segment_cut_below_the_reserve_is_refused_507_naming_both() {
        let dir = tempfile::tempdir().unwrap();
        let faults = Arc::new(Faults::default());
        let mut lines: Lines<()> =
            Lines::new(scratch(dir.path()), room(dir.path(), faults.clone(), 4096)).unwrap();
        let long = "x".repeat(SEGMENT_BYTES);
        lines.push(&long, |_| ()).unwrap();
        faults.set("free:blobs", Some("4095")).unwrap();
        let refused = lines.push(&long, |_| ()).unwrap_err();
        assert_eq!(refused.code, Code::InsufficientStorage);
        let details = refused.details.unwrap();
        assert_eq!(details["reserve_bytes"], 4096);
        assert_eq!(details["available_bytes"], 4095);
    }

    #[test]
    fn a_full_volume_is_507() {
        let full = written(io::ErrorKind::StorageFull.into());
        assert_eq!(full.code, Code::InsufficientStorage);
        let other = written(io::ErrorKind::PermissionDenied.into());
        assert_eq!(other.code, Code::InternalError);
    }
}
