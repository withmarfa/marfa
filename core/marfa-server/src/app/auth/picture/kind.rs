//! A picture's kind and size, read from its marks alone: no pixel is ever decoded.

use crate::app::refusal::Refusal;

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_SIDE: u32 = 4096;

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_FRAME: usize = 12;
const PNG_HEADER_LENGTH: usize = 13;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Png,
    Jpeg,
    Webp,
}

impl Kind {
    pub const fn mime_type(self) -> &'static str {
        match self {
            Kind::Png => "image/png",
            Kind::Jpeg => "image/jpeg",
            Kind::Webp => "image/webp",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Fault {
    Unknown,
    Damaged,
    Frame,
    Side(u32, u32),
}

impl From<Fault> for Refusal {
    fn from(fault: Fault) -> Refusal {
        let message = match fault {
            Fault::Unknown => "Use a PNG, JPEG or WebP picture.".to_string(),
            Fault::Damaged => "The picture is cut short or damaged.".to_string(),
            Fault::Frame => {
                "Only baseline, extended sequential and progressive JPEGs are taken.".to_string()
            }
            Fault::Side(width, height) => format!(
                "The picture is {width} by {height} pixels; each side must be 1 to {MAX_SIDE}."
            ),
        };
        Refusal::validation(message).with_detail("field", "body")
    }
}

type Found = Result<(u32, u32), Fault>;

fn at<const N: usize>(bytes: &[u8], from: usize) -> Option<[u8; N]> {
    bytes.get(from..from.checked_add(N)?)?.try_into().ok()
}

fn be32(bytes: &[u8], from: usize) -> Option<u32> {
    at(bytes, from).map(u32::from_be_bytes)
}

fn be16(bytes: &[u8], from: usize) -> Option<u16> {
    at(bytes, from).map(u16::from_be_bytes)
}

fn le32(bytes: &[u8], from: usize) -> Option<u32> {
    at(bytes, from).map(u32::from_le_bytes)
}

fn le16(bytes: &[u8], from: usize) -> Option<u16> {
    at(bytes, from).map(u16::from_le_bytes)
}

fn le24(bytes: &[u8], from: usize) -> Option<u32> {
    at::<3>(bytes, from).map(|[a, b, c]| u32::from_le_bytes([a, b, c, 0]))
}

fn png(bytes: &[u8]) -> Found {
    let (mut next, mut sides, mut data) = (PNG_SIGNATURE.len(), None, false);
    loop {
        let length = be32(bytes, next).ok_or(Fault::Damaged)?;
        let name: [u8; 4] = at(bytes, next + 4).ok_or(Fault::Damaged)?;
        let length = usize::try_from(length).map_err(|_| Fault::Damaged)?;
        let end = next
            .checked_add(PNG_FRAME)
            .and_then(|end| end.checked_add(length))
            .filter(|end| *end <= bytes.len())
            .ok_or(Fault::Damaged)?;
        match &name {
            b"IHDR" if sides.is_none() && length == PNG_HEADER_LENGTH => {
                let width = be32(bytes, next + 8).ok_or(Fault::Damaged)?;
                let height = be32(bytes, next + 12).ok_or(Fault::Damaged)?;
                sides = Some((width, height));
            }
            _ if sides.is_none() => return Err(Fault::Damaged),
            b"IHDR" => return Err(Fault::Damaged),
            b"IDAT" => data = true,
            b"IEND" => {
                return match sides {
                    Some(sides) if length == 0 && end == bytes.len() && data => Ok(sides),
                    _ => Err(Fault::Damaged),
                };
            }
            _ => {}
        }
        next = end;
    }
}

/// A frame header names the size; the marker says how the frame is coded.
fn jpeg_frame(marker: u8, segment: &[u8]) -> Found {
    if !matches!(marker, 0xc0..=0xc2) {
        return Err(Fault::Frame);
    }
    let height = be16(segment, 1).ok_or(Fault::Damaged)?;
    let width = be16(segment, 3).ok_or(Fault::Damaged)?;
    Ok((u32::from(width), u32::from(height)))
}

/// Steps over entropy-coded data to the marker that ends it.
fn after_scan(bytes: &[u8], mut next: usize) -> Option<usize> {
    loop {
        if *bytes.get(next)? != 0xff {
            next += 1;
            continue;
        }
        match bytes.get(next + 1)? {
            0x00 | 0xd0..=0xd7 => next += 2,
            0xff => next += 1,
            _ => return Some(next),
        }
    }
}

/// A frame, a first scan and the end-of-image marker as the file's last two bytes.
fn jpeg(bytes: &[u8]) -> Found {
    let (mut next, mut sides, mut scanned) = (2, None, false);
    loop {
        if *bytes.get(next).ok_or(Fault::Damaged)? != 0xff {
            return Err(Fault::Damaged);
        }
        while bytes.get(next + 1) == Some(&0xff) {
            next += 1;
        }
        let marker = *bytes.get(next + 1).ok_or(Fault::Damaged)?;
        next += 2;
        match marker {
            0xd9 => {
                return match sides {
                    Some(sides) if scanned && next == bytes.len() => Ok(sides),
                    _ => Err(Fault::Damaged),
                };
            }
            0x01 => continue,
            0x00 | 0xd0..=0xd8 => return Err(Fault::Damaged),
            _ => {}
        }
        let length = usize::from(be16(bytes, next).ok_or(Fault::Damaged)?);
        let end = next
            .checked_add(length)
            .filter(|end| length >= 2 && *end <= bytes.len())
            .ok_or(Fault::Damaged)?;
        let segment = bytes.get(next + 2..end).ok_or(Fault::Damaged)?;
        match marker {
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                if sides.is_some() {
                    return Err(Fault::Damaged);
                }
                sides = Some(jpeg_frame(marker, segment)?);
            }
            0xda => {
                if sides.is_none() {
                    return Err(Fault::Damaged);
                }
                scanned = true;
                next = after_scan(bytes, end).ok_or(Fault::Damaged)?;
                continue;
            }
            _ => {}
        }
        next = end;
    }
}

fn limited(sides: (u32, u32)) -> Found {
    let (width, height) = sides;
    if (1..=MAX_SIDE).contains(&width) && (1..=MAX_SIDE).contains(&height) {
        Ok(sides)
    } else {
        Err(Fault::Side(width, height))
    }
}

/// Walks sibling chunks to the end of `bytes`; each chunk and its padding byte must fit.
fn chunks<'a>(
    bytes: &'a [u8],
    mut visit: impl FnMut(&[u8; 4], &'a [u8]) -> Result<(), Fault>,
) -> Result<(), Fault> {
    let mut next = 0;
    while next < bytes.len() {
        let name: [u8; 4] = at(bytes, next).ok_or(Fault::Damaged)?;
        let size = usize::try_from(le32(bytes, next + 4).ok_or(Fault::Damaged)?)
            .map_err(|_| Fault::Damaged)?;
        let start = next + 8;
        let end = start.checked_add(size).ok_or(Fault::Damaged)?;
        let padded = end
            .checked_add(size & 1)
            .filter(|padded| *padded <= bytes.len())
            .ok_or(Fault::Damaged)?;
        visit(&name, bytes.get(start..end).ok_or(Fault::Damaged)?)?;
        next = padded;
    }
    Ok(())
}

/// Checks the RIFF boundary and every image against its canvas and the size limit.
fn webp(bytes: &[u8]) -> Found {
    let declared = le32(bytes, 4).ok_or(Fault::Damaged)?;
    if usize::try_from(declared).ok() != bytes.len().checked_sub(8) {
        return Err(Fault::Damaged);
    }
    let (mut canvas, mut extended, mut first, mut images) = (None, false, true, 0);
    chunks(bytes.get(12..).ok_or(Fault::Damaged)?, |name, data| {
        match name {
            b"VP8X" if first => {
                canvas = Some(limited(webp_canvas(data)?)?);
                extended = true;
            }
            b"VP8 " | b"VP8L" => {
                let sides = limited(webp_bitstream(name, data)?)?;
                if *canvas.get_or_insert(sides) != sides {
                    return Err(Fault::Damaged);
                }
                images += 1;
            }
            b"ANMF" if extended => {
                webp_frame(data, canvas.ok_or(Fault::Damaged)?)?;
                images += 1;
            }
            _ if first || matches!(name, b"VP8X" | b"ANMF") => return Err(Fault::Damaged),
            _ => {}
        }
        first = false;
        Ok(())
    })?;
    match canvas {
        Some(sides) if images > 0 => Ok(sides),
        _ => Err(Fault::Damaged),
    }
}

fn webp_canvas(data: &[u8]) -> Found {
    let width = le24(data, 4).ok_or(Fault::Damaged)? + 1;
    let height = le24(data, 7).ok_or(Fault::Damaged)? + 1;
    Ok((width, height))
}

fn webp_bitstream(name: &[u8; 4], data: &[u8]) -> Found {
    if name == b"VP8L" {
        if data.first() != Some(&0x2f) {
            return Err(Fault::Damaged);
        }
        let bits = le32(data, 1).ok_or(Fault::Damaged)?;
        return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
    }
    if at::<3>(data, 3) != Some([0x9d, 0x01, 0x2a]) {
        return Err(Fault::Damaged);
    }
    let width = le16(data, 6).ok_or(Fault::Damaged)? & 0x3fff;
    let height = le16(data, 8).ok_or(Fault::Damaged)? & 0x3fff;
    Ok((u32::from(width), u32::from(height)))
}

/// An animation frame holds one image, as large as the frame says, placed inside the canvas.
fn webp_frame(data: &[u8], canvas: (u32, u32)) -> Result<(), Fault> {
    let at24 = |from| le24(data, from).ok_or(Fault::Damaged);
    let (x, y) = (at24(0)? * 2, at24(3)? * 2);
    let sides = limited((at24(6)? + 1, at24(9)? + 1))?;
    let mut image = None;
    chunks(data.get(16..).ok_or(Fault::Damaged)?, |name, inner| {
        if matches!(name, b"VP8 " | b"VP8L") {
            if image.is_some() {
                return Err(Fault::Damaged);
            }
            image = Some(limited(webp_bitstream(name, inner)?)?);
        }
        Ok(())
    })?;
    if image != Some(sides) || x + sides.0 > canvas.0 || y + sides.1 > canvas.1 {
        return Err(Fault::Damaged);
    }
    Ok(())
}

fn kind_of(bytes: &[u8]) -> Option<Kind> {
    if bytes.starts_with(&PNG_SIGNATURE) {
        Some(Kind::Png)
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        Some(Kind::Jpeg)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(Kind::Webp)
    } else {
        None
    }
}

/// Checks container markers and dimensions without decoding pixels.
pub fn of(bytes: &[u8]) -> Result<Kind, Refusal> {
    let kind = kind_of(bytes).ok_or(Fault::Unknown)?;
    let sides = match kind {
        Kind::Png => png(bytes),
        Kind::Jpeg => jpeg(bytes),
        Kind::Webp => webp(bytes),
    }?;
    limited(sides)?;
    Ok(kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(name: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(data.len()).unwrap().to_be_bytes().to_vec();
        out.extend_from_slice(name);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0; 4]);
        out
    }

    fn png_of(width: u32, height: u32) -> Vec<u8> {
        let mut header = width.to_be_bytes().to_vec();
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        [
            PNG_SIGNATURE.to_vec(),
            chunk(b"IHDR", &header),
            chunk(b"IDAT", &[0]),
            chunk(b"IEND", &[]),
        ]
        .concat()
    }

    fn jpeg_of(width: u16, height: u16, frame: u8) -> Vec<u8> {
        let mut out = vec![0xff, 0xd8, 0xff, frame, 0x00, 0x0b, 0x08];
        out.extend_from_slice(&height.to_be_bytes());
        out.extend_from_slice(&width.to_be_bytes());
        out.extend_from_slice(&[1, 1, 0x11, 0]);
        out.extend_from_slice(&[
            0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0xff, 0x00, 0xff, 0xd9,
        ]);
        out
    }

    fn webp_of(width: u32, height: u32) -> Vec<u8> {
        let bits = (width - 1) | ((height - 1) << 14);
        let mut data = vec![0x2f];
        data.extend_from_slice(&bits.to_le_bytes());
        let mut body = b"WEBPVP8L".to_vec();
        body.extend_from_slice(&5u32.to_le_bytes());
        body.extend_from_slice(&data);
        body.push(0);
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn takes_the_three_kinds_by_their_bytes() {
        assert_eq!(of(&png_of(4096, 1)).unwrap(), Kind::Png);
        assert_eq!(of(&jpeg_of(1, 4096, 0xc2)).unwrap(), Kind::Jpeg);
        assert_eq!(of(&webp_of(4096, 4096)).unwrap(), Kind::Webp);
    }

    #[test]
    fn refuses_a_side_of_none_or_past_the_limit() {
        for bytes in [
            png_of(0, 8),
            png_of(8, 4097),
            jpeg_of(0, 8, 0xc0),
            jpeg_of(4097, 1, 0xc0),
            webp_of(4097, 1),
        ] {
            assert!(of(&bytes).is_err());
        }
    }

    #[test]
    fn a_declared_size_costs_no_more_than_its_header() {
        let huge = png_of(60_000, 60_000);
        assert!(huge.len() < 100);
        assert!(of(&huge).is_err());
    }

    #[test]
    fn refuses_every_cut_and_every_extra_byte() {
        for whole in [png_of(8, 8), jpeg_of(8, 8, 0xc0), webp_of(8, 8)] {
            assert!(of(&whole).is_ok());
            for cut in 0..whole.len() {
                assert!(of(&whole[..cut]).is_err(), "cut at {cut}");
            }
            let mut longer = whole.clone();
            longer.push(0);
            assert!(of(&longer).is_err());
        }
    }

    #[test]
    fn refuses_a_jpeg_frame_that_is_not_baseline_extended_or_progressive() {
        for frame in [0xc3, 0xc5, 0xc9, 0xcf] {
            assert!(of(&jpeg_of(8, 8, frame)).is_err(), "{frame:x}");
        }
        for frame in [0xc0, 0xc1, 0xc2] {
            assert!(of(&jpeg_of(8, 8, frame)).is_ok(), "{frame:x}");
        }
    }

    #[test]
    fn refuses_what_is_not_a_picture() {
        for bytes in [
            &b""[..],
            b"GIF89a",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            b"<!doctype html>",
            &[
                0, 0, 0, 0x1c, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f',
            ],
        ] {
            assert!(of(bytes).is_err());
        }
    }

    fn riff(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        body.extend(chunks.concat());
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&u32::try_from(body.len()).unwrap().to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    fn riff_chunk(name: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = name.to_vec();
        out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_le_bytes());
        out.extend_from_slice(data);
        if data.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn lossless(width: u32, height: u32) -> Vec<u8> {
        let bits = (width - 1) | ((height - 1) << 14);
        let mut data = vec![0x2f];
        data.extend_from_slice(&bits.to_le_bytes());
        riff_chunk(b"VP8L", &data)
    }

    fn canvas(width: u32, height: u32) -> Vec<u8> {
        let mut data = vec![0; 4];
        data.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        data.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        riff_chunk(b"VP8X", &data)
    }

    fn frame(at: (u32, u32), width: u32, height: u32, inside: &[Vec<u8>]) -> Vec<u8> {
        let mut data = Vec::new();
        for value in [at.0 / 2, at.1 / 2, width - 1, height - 1, 0] {
            data.extend_from_slice(&value.to_le_bytes()[..3]);
        }
        data.push(0);
        data.extend(inside.concat());
        riff_chunk(b"ANMF", &data)
    }

    #[test]
    fn a_webp_canvas_and_every_image_in_it_agree_and_stay_within_the_limit() {
        assert!(of(&riff(&[canvas(8, 8), lossless(8, 8)])).is_ok());
        for bytes in [
            riff(&[canvas(1, 1), lossless(4097, 1)]),
            riff(&[canvas(8, 8), lossless(4, 4)]),
            riff(&[canvas(8, 8), lossless(8, 8), lossless(4097, 1)]),
            riff(&[canvas(8, 8)]),
            riff(&[lossless(8, 8), lossless(4, 4)]),
        ] {
            assert!(of(&bytes).is_err());
        }
    }

    #[test]
    fn every_webp_animation_frame_stays_inside_the_canvas() {
        let ok = frame((2, 0), 6, 8, &[lossless(6, 8)]);
        assert!(of(&riff(&[canvas(8, 8), ok.clone()])).is_ok());
        for bad in [
            frame((4, 0), 6, 8, &[lossless(6, 8)]),
            frame((0, 0), 6, 8, &[lossless(4097, 1)]),
            frame((0, 0), 6, 8, &[lossless(6, 7)]),
            frame((0, 0), 6, 8, &[]),
            frame((0, 0), 6, 8, &[lossless(6, 8), lossless(6, 8)]),
        ] {
            assert!(of(&riff(&[canvas(8, 8), ok.clone(), bad])).is_err());
        }
        assert!(of(&riff(&[ok])).is_err());
    }

    #[test]
    fn an_odd_final_webp_chunk_needs_its_padding_byte() {
        let mut data = vec![0x2f];
        data.extend_from_slice(&(7u32 | (7 << 14)).to_le_bytes());
        let padded = riff(&[riff_chunk(b"VP8L", &data)]);
        assert!(of(&padded).is_ok());
        let mut bytes = padded.clone();
        bytes.pop();
        let declared = u32::try_from(bytes.len() - 8).unwrap();
        bytes[4..8].copy_from_slice(&declared.to_le_bytes());
        assert!(of(&bytes).is_err());
    }

    #[test]
    fn a_webp_declaring_less_or_more_than_it_holds_is_damaged() {
        let whole = webp_of(8, 8);
        for declared in [whole.len() - 10, whole.len() - 6] {
            let mut bytes = whole.clone();
            bytes[4..8].copy_from_slice(&u32::try_from(declared).unwrap().to_le_bytes());
            assert!(of(&bytes).is_err());
        }
    }
}
