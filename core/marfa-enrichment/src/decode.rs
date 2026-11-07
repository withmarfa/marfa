//! Turning a file's bytes into characters.

use encoding_rs::{Encoding, REPLACEMENT, UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1252};

use crate::sink::Sink;

/// Bytes decoded between checks that the sink still has room.
const CHUNK: usize = 64 * 1024;

/// Bytes looked at to tell UTF-8 from a legacy encoding.
const SNIFF: usize = 1024 * 1024;

/// The encoding a MIME type's `charset` parameter names, when it names one that
/// decodes text.
pub(crate) fn declared_charset(mime: &str) -> Option<&'static Encoding> {
    mime.split(';').skip(1).find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        if !name.trim().eq_ignore_ascii_case("charset") {
            return None;
        }
        usable(Encoding::for_label(
            value.trim().trim_matches('"').as_bytes(),
        )?)
    })
}

/// The replacement encoding stands in for a few legacy ones that are unsafe to
/// decode, and gives only U+FFFD.
fn usable(encoding: &'static Encoding) -> Option<&'static Encoding> {
    (encoding != REPLACEMENT).then_some(encoding)
}

/// The encoding named by a `<meta>` or XML declaration in the start of a page.
/// A page that says it is UTF-16 is read as UTF-8, since it could not have
/// said so in UTF-16.
pub(crate) fn declared_in_markup(bytes: &[u8]) -> Option<&'static Encoding> {
    let head = &bytes[..bytes.len().min(1024)];
    let lower = head.to_ascii_lowercase();
    for key in [&b"charset"[..], &b"encoding"[..]] {
        let mut from = 0;
        while let Some(found) = find(&lower[from..], key) {
            let mut at = from + found + key.len();
            from = at;
            while lower.get(at).is_some_and(|b| b.is_ascii_whitespace()) {
                at += 1;
            }
            if lower.get(at) != Some(&b'=') {
                continue;
            }
            at += 1;
            while lower
                .get(at)
                .is_some_and(|b| b.is_ascii_whitespace() || matches!(b, b'"' | b'\''))
            {
                at += 1;
            }
            let end = lower[at..]
                .iter()
                .position(|b| {
                    !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
                })
                .map_or(lower.len(), |n| at + n);
            if let Some(encoding) = Encoding::for_label(&lower[at..end]).and_then(usable) {
                return Some(if encoding == UTF_16LE || encoding == UTF_16BE {
                    UTF_8
                } else {
                    encoding
                });
            }
        }
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// The encoding to read `bytes` in, and how many bytes of byte order mark to
/// skip. A byte order mark decides. So does a declared UTF-16, which valid
/// UTF-8 cannot rule out, since ASCII text in UTF-16 is valid UTF-8 with NULs.
/// Otherwise bytes that are valid UTF-8 are UTF-8, then the declared encoding,
/// and last windows-1252, which gives every byte a character.
pub(crate) fn choose(
    bytes: &[u8],
    declared: Option<&'static Encoding>,
) -> (&'static Encoding, usize) {
    if let Some((encoding, length)) = Encoding::for_bom(bytes) {
        return (encoding, length);
    }
    if let Some(encoding) = declared
        && (encoding == UTF_16LE || encoding == UTF_16BE)
    {
        return (encoding, 0);
    }
    let head = &bytes[..bytes.len().min(SNIFF)];
    match std::str::from_utf8(head) {
        Ok(_) => (UTF_8, 0),
        // A character cut off by the end of the bytes looked at, which is not
        // the end of the file.
        Err(error) if error.error_len().is_none() && head.len() < bytes.len() => (UTF_8, 0),
        Err(_) => (declared.unwrap_or(WINDOWS_1252), 0),
    }
}

/// Decodes `bytes` into `sink` as written, stopping once it is full.
pub(crate) fn decode_into(bytes: &[u8], encoding: &'static Encoding, sink: &mut Sink) {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let mut chunks = bytes.chunks(CHUNK).peekable();
    let mut out = String::new();
    while let Some(chunk) = chunks.next() {
        out.clear();
        out.reserve(decoder.max_utf8_buffer_length(chunk.len()).unwrap_or(0));
        let (_result, _read, _errors) =
            decoder.decode_to_string(chunk, &mut out, chunks.peek().is_none());
        sink.push_raw(&out);
        if sink.is_full() {
            return;
        }
    }
}
