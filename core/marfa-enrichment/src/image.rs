//! An image's size, from its header.

use std::io::Cursor;

use image::ImageReader;

use crate::Dimensions;

/// The size an image's header states, or none when the bytes are not an image
/// this reads or the header is broken. A size read from a broken header would
/// be a size made up, so none is the answer then, not a guess.
pub(crate) fn dimensions(bytes: &[u8]) -> Option<Dimensions> {
    let (width, height) = if bytes.get(4..8) == Some(b"ftyp") {
        heif(bytes)?
    } else if bytes.starts_with(b"GIF8") && !gif_continues(bytes) {
        return None;
    } else {
        ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()?
    };
    (width > 0 && height > 0).then_some(Dimensions { width, height })
}

/// Whether a GIF's screen descriptor and global color table are whole and are
/// followed by an extension, an image or the trailer. The decoder takes the
/// size from the descriptor and goes no further, so bytes that only start like
/// a GIF would otherwise give whatever sits at those offsets.
fn gif_continues(bytes: &[u8]) -> bool {
    let Some(&flags) = bytes.get(10) else {
        return false;
    };
    let table = if flags & 0x80 == 0 {
        0
    } else {
        3 * (2usize << (flags & 0x07))
    };
    matches!(bytes.get(13 + table), Some(0x21 | 0x2c | 0x3b))
}

/// The brands of the files this reads: HEIC and HEIF, and AVIF.
const BRANDS: &[&[u8; 4]] = &[
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs", b"mif1", b"msf1",
    b"avif", b"avis",
];

/// One box of an ISO base media file: its type and what it holds.
struct Piece<'a> {
    kind: [u8; 4],
    body: &'a [u8],
}

/// The boxes laid end to end in `data`. A box that runs past the end, or states
/// a size too small to hold its own header, ends the list.
fn boxes(mut data: &[u8]) -> impl Iterator<Item = Piece<'_>> {
    std::iter::from_fn(move || {
        let size = u32::from_be_bytes(data.get(..4)?.try_into().ok()?) as u64;
        let kind: [u8; 4] = data.get(4..8)?.try_into().ok()?;
        let (header, size) = match size {
            0 => (8, data.len() as u64),
            1 => (16, u64::from_be_bytes(data.get(8..16)?.try_into().ok()?)),
            size => (8, size),
        };
        let size = usize::try_from(size).ok()?;
        if size < header || size > data.len() {
            return None;
        }
        let body = &data[header..size];
        data = &data[size..];
        Some(Piece { kind, body })
    })
}

fn find<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|b| &b.kind == kind).map(|b| b.body)
}

/// A HEIC, HEIF or AVIF image's size: the `ispe` property of its primary item.
fn heif(data: &[u8]) -> Option<(u32, u32)> {
    let ftyp = find(data, b"ftyp")?;
    // The major brand, then the version, then the compatible brands.
    let major = ftyp.first_chunk::<4>()?;
    let (compatible, _) = ftyp.get(8..)?.as_chunks::<4>();
    if !std::iter::once(major)
        .chain(compatible)
        .any(|brand| BRANDS.contains(&brand))
    {
        return None;
    }
    // `meta` is a full box: four bytes of version and flags come first.
    let meta = find(data, b"meta")?.get(4..)?;
    let primary = find(meta, b"pitm").and_then(|body| {
        let version = *body.first()?;
        if version == 0 {
            Some(u32::from(u16::from_be_bytes(
                body.get(4..6)?.try_into().ok()?,
            )))
        } else {
            Some(u32::from_be_bytes(body.get(4..8)?.try_into().ok()?))
        }
    });
    let properties = find(meta, b"iprp")?;
    let container = find(properties, b"ipco")?;
    let size_of = |ispe: &Piece<'_>| -> Option<(u32, u32)> {
        let body = ispe.body;
        Some((
            u32::from_be_bytes(body.get(4..8)?.try_into().ok()?),
            u32::from_be_bytes(body.get(8..12)?.try_into().ok()?),
        ))
    };
    let all: Vec<Piece<'_>> = boxes(container).collect();
    // Without a primary item, or an association for it, the first size stated.
    let associated = primary.and_then(|item| associated(properties, item));
    let wanted = match associated {
        Some(indices) => indices
            .into_iter()
            .filter_map(|index| all.get(usize::from(index).checked_sub(1)?))
            .find(|b| &b.kind == b"ispe"),
        None => all.iter().find(|b| &b.kind == b"ispe"),
    };
    size_of(wanted?)
}

/// The property indices `ipma` associates with `item`.
fn associated(properties: &[u8], item: u32) -> Option<Vec<u16>> {
    let body = find(properties, b"ipma")?;
    let version = *body.first()?;
    let wide = body.get(3)? & 1 == 1;
    let count = u32::from_be_bytes(body.get(4..8)?.try_into().ok()?);
    let mut at = 8;
    for _ in 0..count {
        let id = if version == 0 {
            let id = u32::from(u16::from_be_bytes(body.get(at..at + 2)?.try_into().ok()?));
            at += 2;
            id
        } else {
            let id = u32::from_be_bytes(body.get(at..at + 4)?.try_into().ok()?);
            at += 4;
            id
        };
        let n = usize::from(*body.get(at)?);
        at += 1;
        let mut indices = Vec::with_capacity(n);
        for _ in 0..n {
            if wide {
                indices.push(u16::from_be_bytes(body.get(at..at + 2)?.try_into().ok()?) & 0x7fff);
                at += 2;
            } else {
                indices.push(u16::from(*body.get(at)? & 0x7f));
                at += 1;
            }
        }
        if id == item {
            return Some(indices);
        }
    }
    None
}
