use super::*;
use crate::Dimensions;

#[test]
fn plain_text_is_read_whole() {
    assert_eq!(
        text(&fixture("sample.txt"), "text/plain; charset=utf-8"),
        "Enrichment fixture plain text marker quokkatxt."
    );
    assert_eq!(text(b"# Title\n\nbody", "text/markdown"), "# Title\n\nbody");
}

#[test]
fn text_in_a_legacy_encoding_is_decoded_not_replaced() {
    // "café" in windows-1252, which is not valid UTF-8.
    assert_eq!(text(b"caf\xe9", "text/plain"), "café");
    // A declared charset decides among the encodings a guess cannot tell.
    assert_eq!(
        text(b"\x93hi\x94", "text/plain; charset=windows-1252"),
        "\u{201c}hi\u{201d}"
    );
}

#[test]
fn utf_16_is_read_with_or_without_a_byte_order_mark() {
    let units: Vec<u8> = "quokka é"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let marked = [&[0xff, 0xfe][..], &units].concat();
    assert_eq!(text(&marked, "text/plain"), "quokka é");
    assert_eq!(text(&units, "text/plain; charset=utf-16le"), "quokka é");
}

#[test]
fn text_is_cut_between_characters_and_says_so() {
    let source = format!("{}\u{1f600}tail", "a".repeat(9));
    let mut limits = options();
    // The emoji is two UTF-16 units and would straddle the limit of ten.
    limits.max_text_chars = 10;
    let reading = read_here(source.as_bytes(), "text/plain", &limits).unwrap();
    assert_eq!(reading.text, "aaaaaaaaa");
    assert!(reading.truncated);
    limits.max_text_chars = 11;
    let reading = read_here(source.as_bytes(), "text/plain", &limits).unwrap();
    assert_eq!(reading.text, "aaaaaaaaa\u{1f600}");
    assert!(reading.truncated);
    limits.max_text_chars = 100;
    assert!(
        !read_here(source.as_bytes(), "text/plain", &limits)
            .unwrap()
            .truncated
    );
}

/// Without the `native` feature the program has no PDF reader.
#[cfg(not(feature = "native"))]
#[test]
fn a_pdf_is_unsupported_without_the_native_feature() {
    assert_eq!(
        refusal(b"%PDF-1.4", "application/pdf", &options()),
        Refusal::Unsupported
    );
}

#[test]
fn a_type_with_no_reader_is_unsupported() {
    for mime in ["application/octet-stream", "audio/mpeg"] {
        assert_eq!(
            refusal(b"MZ", mime, &options()),
            Refusal::Unsupported,
            "{mime}"
        );
    }
    assert_eq!(
        text(br#"{"quokka": 1}"#, "application/json"),
        r#"{"quokka": 1}"#
    );
    assert_eq!(
        refusal(b"{\\rtf1", "text/rtf", &options()),
        Refusal::Unsupported
    );
}

#[test]
fn image_sizes_come_from_the_header() {
    let size = |name: &str, mime: &str| read(&fixture(name), mime).dimensions;
    let of = |width, height| Some(Dimensions { width, height });
    assert_eq!(size("sample.png", "image/png"), of(1700, 2200));
    assert_eq!(size("sample.jpg", "image/jpeg"), of(30, 20));
    assert_eq!(size("sample.gif", "image/gif"), of(30, 20));
    assert_eq!(size("sample.webp", "image/webp"), of(30, 20));
    assert!(size("sample-lossless.webp", "image/webp").is_some());
    assert!(size("sample-extended.webp", "image/webp").is_some());
}

#[test]
fn a_signature_over_garbage_gives_no_size() {
    let garbage = [
        0x5au8, 0xa5, 0x33, 0x99, 0x01, 0xfe, 0x42, 0x17, 0x80, 0x00, 0x63, 0xc3,
    ];
    for (signature, mime) in [
        (&b"GIF89a"[..], "image/gif"),
        (&[0xff, 0xd8, 0xff, 0xe0][..], "image/jpeg"),
        (&b"RIFF\x20\0\0\0WEBPVP8 "[..], "image/webp"),
        (&b"\x89PNG\r\n\x1a\n"[..], "image/png"),
    ] {
        let bytes = [signature, &garbage].concat();
        assert_eq!(read(&bytes, mime).dimensions, None, "{mime}");
    }
}

#[test]
fn an_avif_or_heic_size_comes_from_its_primary_item() {
    // ftyp, then meta holding pitm (item 2), and iprp with two ispe boxes of
    // which only the second belongs to item 2.
    fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }
    fn ispe(width: u32, height: u32) -> Vec<u8> {
        let mut body = vec![0; 4];
        body.extend_from_slice(&width.to_be_bytes());
        body.extend_from_slice(&height.to_be_bytes());
        boxed(b"ispe", &body)
    }
    let ipco = boxed(b"ipco", &[ispe(64, 48), ispe(4032, 3024)].concat());
    // Version 0, flags 0, one entry: item 2, one association, property 2.
    let ipma = boxed(b"ipma", &[0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 2]);
    let iprp = boxed(b"iprp", &[ipco, ipma].concat());
    let pitm = boxed(b"pitm", &[0, 0, 0, 0, 0, 2]);
    let meta = boxed(b"meta", &[&[0u8; 4][..], &pitm, &iprp].concat());
    let ftyp = boxed(b"ftyp", b"avif\0\0\0\0avifmif1");
    let file = [ftyp, meta].concat();
    assert_eq!(
        read(&file, "image/avif").dimensions,
        Some(Dimensions {
            width: 4032,
            height: 3024
        })
    );
    // Cut short anywhere, it gives nothing and does not panic.
    for end in 0..file.len() {
        let _ = read(&file[..end], "image/avif");
    }
}
