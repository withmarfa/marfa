//! Reads a tar a part at a time; only regular files are entries.

use super::super::tar::BLOCK;

/// What a part of the body held.
#[derive(Debug, PartialEq, Eq)]
pub enum Part<'a> {
    Begins {
        name: String,
        size: u64,
    },
    Bytes(&'a [u8]),
    Ends,
    /// The two zero blocks that close the archive.
    Closed,
}

#[derive(Debug)]
enum State {
    Header,
    Body {
        left: u64,
        padding: usize,
        file: bool,
    },
    Padding(usize),
    Closed,
}

/// A body that is not a tar.
#[derive(Debug, PartialEq, Eq)]
pub struct NotTar;

pub struct Reader {
    state: State,
    header: Vec<u8>,
    zero_blocks: u8,
}

fn octal(field: &[u8]) -> Option<u64> {
    if field.first().is_some_and(|byte| byte & 0x80 != 0) {
        let mut value: u64 = 0;
        for (at, byte) in field.iter().enumerate() {
            let byte = if at == 0 { byte & 0x7f } else { *byte };
            value = value.checked_mul(256)?.checked_add(u64::from(byte))?;
        }
        return Some(value);
    }
    let text: String = field
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| char::from(*byte))
        .collect();
    let text = text.trim();
    if text.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(text, 8).ok()
}

fn text(field: &[u8]) -> String {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

fn padding(size: u64) -> usize {
    let over = (size % BLOCK as u64) as usize;
    if over == 0 { 0 } else { BLOCK - over }
}

impl Default for Reader {
    fn default() -> Reader {
        Reader {
            state: State::Header,
            header: Vec::with_capacity(BLOCK),
            zero_blocks: 0,
        }
    }
}

impl Reader {
    /// Whether the archive's closing blocks have been read.
    pub fn closed(&self) -> bool {
        matches!(self.state, State::Closed)
    }

    /// Whether the bytes so far end between entries.
    pub fn between(&self) -> bool {
        matches!(self.state, State::Header | State::Closed) && self.header.is_empty()
    }

    /// Reads `bytes`, telling `each` what they hold, in order.
    pub fn feed<E>(
        &mut self,
        mut bytes: &[u8],
        mut each: impl FnMut(Part<'_>) -> Result<(), E>,
        not_tar: impl Fn(NotTar) -> E,
    ) -> Result<(), E> {
        while !bytes.is_empty() {
            match &mut self.state {
                State::Closed => return Ok(()),
                State::Header => {
                    let want = BLOCK - self.header.len();
                    let take = want.min(bytes.len());
                    self.header.extend_from_slice(&bytes[..take]);
                    bytes = &bytes[take..];
                    if self.header.len() < BLOCK {
                        continue;
                    }
                    let block = std::mem::take(&mut self.header);
                    if block.iter().all(|byte| *byte == 0) {
                        self.zero_blocks += 1;
                        if self.zero_blocks == 2 {
                            self.state = State::Closed;
                            each(Part::Closed)?;
                        }
                        continue;
                    }
                    if self.zero_blocks > 0 {
                        return Err(not_tar(NotTar));
                    }
                    let (name, size, file) = parse(&block).ok_or(NotTar).map_err(&not_tar)?;
                    if file {
                        each(Part::Begins { name, size })?;
                    }
                    self.state = if size == 0 {
                        if file {
                            each(Part::Ends)?;
                        }
                        State::Header
                    } else {
                        State::Body {
                            left: size,
                            padding: padding(size),
                            file,
                        }
                    };
                }
                State::Body {
                    left,
                    padding,
                    file,
                } => {
                    let take = usize::try_from(*left)
                        .unwrap_or(usize::MAX)
                        .min(bytes.len());
                    let (file, padding) = (*file, *padding);
                    if file {
                        each(Part::Bytes(&bytes[..take]))?;
                    }
                    *left -= take as u64;
                    bytes = &bytes[take..];
                    if *left == 0 {
                        if file {
                            each(Part::Ends)?;
                        }
                        self.state = if padding == 0 {
                            State::Header
                        } else {
                            State::Padding(padding)
                        };
                    }
                }
                State::Padding(left) => {
                    let take = (*left).min(bytes.len());
                    *left -= take;
                    bytes = &bytes[take..];
                    if *left == 0 {
                        self.state = State::Header;
                    }
                }
            }
        }
        Ok(())
    }
}

/// `None` for a block that is no tar header.
fn parse(block: &[u8]) -> Option<(String, u64, bool)> {
    let held = octal(&block[148..156])?;
    let sum: u64 = block
        .iter()
        .enumerate()
        .map(|(at, byte)| {
            if (148..156).contains(&at) {
                u64::from(b' ')
            } else {
                u64::from(*byte)
            }
        })
        .sum();
    if held != sum {
        return None;
    }
    let size = octal(&block[124..136])?;
    let kind = block[156];
    let mut name = text(&block[..100]);
    if &block[257..262] == b"ustar" {
        let prefix = text(&block[345..500]);
        if !prefix.is_empty() {
            name = format!("{prefix}/{name}");
        }
    }
    Some((name, size, kind == b'0' || kind == 0))
}

#[cfg(test)]
mod tests {
    use super::super::super::tar::{END, header, padding as pad};
    use super::*;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, body) in entries {
            out.extend_from_slice(&header(name, body.len() as u64, 0).unwrap());
            out.extend_from_slice(body);
            out.extend(std::iter::repeat_n(0, pad(body.len() as u64)));
        }
        out.extend_from_slice(&END);
        out
    }

    fn read(bytes: &[u8], step: usize) -> Result<Vec<(String, Vec<u8>)>, NotTar> {
        let mut reader = Reader::default();
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        for chunk in bytes.chunks(step) {
            reader.feed(
                chunk,
                |part| {
                    match part {
                        Part::Begins { name, .. } => entries.push((name, Vec::new())),
                        Part::Bytes(held) => {
                            if let Some(last) = entries.last_mut() {
                                last.1.extend_from_slice(held);
                            }
                        }
                        Part::Ends | Part::Closed => {}
                    }
                    Ok(())
                },
                |not| not,
            )?;
        }
        assert!(reader.closed());
        Ok(entries)
    }

    #[test]
    fn entries_read_whole_however_the_bytes_are_cut() {
        let big = vec![7u8; 1500];
        let bytes = archive(&[("manifest.json", b"{}"), ("empty", b""), ("blobs/x", &big)]);
        for step in [1, 7, 512, 513, 100_000] {
            let entries = read(&bytes, step).unwrap();
            assert_eq!(entries.len(), 3);
            assert_eq!(entries[0], ("manifest.json".into(), b"{}".to_vec()));
            assert_eq!(entries[1].1.len(), 0);
            assert_eq!(entries[2].1, big);
        }
    }

    #[test]
    fn a_body_that_is_no_tar_is_refused() {
        assert_eq!(read(&[b'x'; 2048], 512), Err(NotTar));
        let mut damaged = archive(&[("a", b"b")]);
        damaged[0] ^= 1;
        assert_eq!(read(&damaged, 512), Err(NotTar));
    }
}
