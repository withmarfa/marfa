//! The file a reading is given, as a seekable reader.

use std::fs::File;
use std::io::{self, ErrorKind, Read, Seek, SeekFrom};
use std::os::unix::fs::FileExt;

use symphonia::core::io::MediaSource;

/// A file read by position with `pread`, so the caller's offset does not move.
pub(crate) struct Source<'a> {
    file: &'a File,
    position: u64,
    len: u64,
}

impl<'a> Source<'a> {
    /// `len` caps every read, so a file that grows is not followed.
    pub(crate) fn new(file: &'a File, len: u64) -> Self {
        Self {
            file,
            position: 0,
            len,
        }
    }

    pub(crate) fn len(&self) -> u64 {
        self.len
    }

    /// All of the file, or `None` when memory for it cannot be had.
    pub(crate) fn read_all(&self) -> io::Result<Option<Vec<u8>>> {
        let Ok(len) = usize::try_from(self.len) else {
            return Ok(None);
        };
        let mut bytes = Vec::new();
        if bytes.try_reserve_exact(len).is_err() {
            return Ok(None);
        }
        bytes.resize(len, 0);
        self.file.read_exact_at(&mut bytes, 0)?;
        Ok(Some(bytes))
    }
}

impl Read for Source<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let left = self.len.saturating_sub(self.position);
            let wanted = buffer
                .len()
                .min(usize::try_from(left).unwrap_or(usize::MAX));
            match self.file.read_at(&mut buffer[..wanted], self.position) {
                Ok(read) => {
                    self.position += read as u64;
                    return Ok(read);
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

impl Seek for Source<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(position) => Some(position),
            SeekFrom::End(offset) => self.len.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        };
        self.position = target
            .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "a seek to before the start"))?;
        Ok(self.position)
    }
}

impl MediaSource for Source<'_> {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}
