use super::*;
use std::io::Cursor;

const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn docx_with_body(body: &[u8]) -> Vec<u8> {
    let head = format!(r#"<?xml version="1.0"?><w:document xmlns:w="{WORD}"><w:body>"#);
    let document = [head.as_bytes(), body, b"</w:body></w:document>"].concat();
    zip(&[
        (
            "_rels/.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        ("word/document.xml", &document),
    ])
}

fn paragraph_of(bytes: usize) -> Vec<u8> {
    [
        &b"<w:p><w:r><w:t>"[..],
        &vec![b'a'; bytes],
        b"</w:t></w:r></w:p>",
    ]
    .concat()
}

#[test]
fn a_bomb_is_over_the_limit_until_the_limit_is_raised() {
    let bomb = docx_with_body(&paragraph_of(80 * MIB as usize));
    assert!(bomb.len() < 200 * 1024, "small on the wire: {}", bomb.len());
    let mut limits = options();
    limits.max_inflated_bytes = 64 * MIB;
    assert!(matches!(
        refusal(&bomb, DOCX, &limits),
        Refusal::OverLimit(_)
    ));
    let reading = read_here(&bomb, DOCX, &options()).unwrap();
    assert_eq!(reading.text.len(), 100_000);
    assert!(reading.truncated);
}

#[test]
fn a_zip_that_lies_about_its_size_is_not_believed() {
    let bomb = docx_with_body(&paragraph_of(80 * MIB as usize));
    let mut limits = options();
    limits.max_inflated_bytes = 64 * MIB;
    // Claiming to be small does not let it inflate: it is stopped at the claim.
    assert!(matches!(
        refusal(&claiming(bomb, 100), DOCX, &limits),
        Refusal::Malformed(_)
    ));
    // Claiming to be large is taken at its word, and refused before it is read.
    let small = docx_with_body(&paragraph_of(10));
    assert!(matches!(
        refusal(&claiming(small, 1 << 30), DOCX, &limits),
        Refusal::OverLimit(_)
    ));
}

#[test]
fn every_part_counts_toward_the_limit_together() {
    // Twenty headers of a thousand bytes each, read one after another, pass
    // alone and not together.
    let part = format!(
        r#"<w:hdr xmlns:w="{WORD}">{}</w:hdr>"#,
        String::from_utf8(paragraph_of(1000)).unwrap()
    );
    let names: Vec<String> = (0..20).map(|n| format!("word/header{n}.xml")).collect();
    let relationship = |kind: &str, target: &str, id: String| {
        format!(
            r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>"#
        )
    };
    let headers: String = (0..20)
        .map(|n| relationship("header", &format!("header{n}.xml"), format!("h{n}")))
        .collect();
    let rels = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{headers}</Relationships>"#
    );
    let root = format!(
        r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{}</Relationships>"#,
        relationship("officeDocument", "word/document.xml", "r".into())
    );
    let document = format!(r#"<w:document xmlns:w="{WORD}"><w:body/></w:document>"#);
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("_rels/.rels", root.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
    ];
    parts.extend(names.iter().map(|n| (n.as_str(), part.as_bytes())));
    let many = zip(&parts);
    assert_eq!(read(&many, DOCX).text.len(), 20_019);
    let mut limits = options();
    limits.max_inflated_bytes = 5000;
    assert!(matches!(
        refusal(&many, DOCX, &limits),
        Refusal::OverLimit(_)
    ));
}

#[test]
fn too_many_parts_are_refused_not_read() {
    let names: Vec<String> = (0..10_001).map(|n| format!("extra/{n}.txt")).collect();
    let parts: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b""[..])).collect();
    assert!(matches!(
        refusal(&zip(&parts), DOCX, &options()),
        Refusal::OverLimit(_)
    ));
}

#[test]
fn xml_nested_past_the_limit_is_refused() {
    let deep = format!("{}x{}", "<w:sdt>".repeat(2000), "</w:sdt>".repeat(2000));
    assert!(matches!(
        refusal(&docx_with_body(deep.as_bytes()), DOCX, &options()),
        Refusal::OverLimit(_)
    ));
}

#[test]
fn an_entity_the_document_declares_is_never_expanded() {
    let laugh = format!(
        r#"<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY a "{}"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><w:document xmlns:w="{WORD}"><w:body><w:p><w:r><w:t>before &b; after</w:t></w:r></w:p></w:body></w:document>"#,
        "lol".repeat(1000)
    );
    let file = zip(&[
        (
            "_rels/.rels",
            br#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        ("word/document.xml", laugh.as_bytes()),
    ]);
    assert_eq!(text(&file, DOCX), "before after");
}

#[test]
fn files_that_are_not_what_they_say_are_malformed_and_never_panic() {
    let good = fixture("sample.docx");
    for mime in [
        DOCX,
        XLSX,
        PPTX,
        ODT,
        ODS,
        ODP,
        "application/epub+zip",
        "application/vnd.ms-excel",
    ] {
        assert!(
            matches!(
                refusal(b"not a zip at all", mime, &options()),
                Refusal::Malformed(_)
            ),
            "{mime}"
        );
        assert!(
            matches!(refusal(b"", mime, &options()), Refusal::Malformed(_)),
            "{mime}"
        );
    }
    // Cut anywhere, a real document is refused or read, and nothing panics.
    for end in (0..good.len()).step_by(37) {
        let _ = read_here(&good[..end], DOCX, &options());
        let _ = read_here(&good[..end], XLSX, &options());
    }
    // A zip with none of a document's parts.
    let empty = zip(&[("readme.txt", b"hello")]);
    assert!(matches!(
        refusal(&empty, DOCX, &options()),
        Refusal::Malformed(_)
    ));
    assert!(matches!(
        refusal(&empty, XLSX, &options()),
        Refusal::Malformed(_)
    ));
}

#[test]
fn a_password_protected_file_is_named_before_it_is_read() {
    // Office wraps an encrypted package in a compound file holding
    // `EncryptionInfo` and `EncryptedPackage`.
    let mut compound = cfb::CompoundFile::create(Cursor::new(Vec::new())).unwrap();
    for name in ["/EncryptionInfo", "/EncryptedPackage"] {
        compound.create_stream(name).unwrap();
    }
    let wrapped = compound.into_inner().into_inner();
    for mime in [DOCX, PPTX, XLSX, "application/vnd.ms-excel"] {
        assert_eq!(
            refusal(&wrapped, mime, &options()),
            Refusal::Encrypted,
            "{mime}"
        );
    }
    // A compound file with no such stream is no password's business.
    let plain = cfb::CompoundFile::create(Cursor::new(Vec::new()))
        .unwrap()
        .into_inner()
        .into_inner();
    assert!(!matches!(
        refusal(&plain, DOCX, &options()),
        Refusal::Encrypted
    ));

    let manifest = br#"<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="x"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1"/></manifest:file-entry></manifest:manifest>"#;
    let protected = zip(&[
        ("META-INF/manifest.xml", manifest),
        ("content.xml", b"\0\x01 sealed"),
    ]);
    for mime in [ODT, ODP, ODS] {
        assert_eq!(
            refusal(&protected, mime, &options()),
            Refusal::Encrypted,
            "{mime}"
        );
    }
}

#[test]
fn a_cell_repeated_by_the_million_is_read_once() {
    // 600 bytes that `calamine` turns into a table of 90 million cells and
    // eight gigabytes.
    let content = r#"<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x"><office:body><office:spreadsheet><table:table table:name="T"><table:table-row table:number-rows-repeated="90000"><table:table-cell table:number-columns-repeated="1000" office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"#;
    let file = zip(&[("content.xml", content.as_bytes())]);
    assert_eq!(text(&file, ODS), "T\nx");
}

#[test]
fn damaged_files_are_refused_or_read_and_never_end_the_caller() {
    let files = [
        (fixture("sample.docx"), DOCX),
        (fixture("sample.xlsx"), XLSX),
        (own_fixture("sample.xls"), "application/vnd.ms-excel"),
        (fixture("sample.png"), "image/png"),
        (fixture("sample.webp"), "image/webp"),
        (fixture("sample.jpg"), "image/jpeg"),
        (fixture("sample.gif"), "image/gif"),
    ];
    let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for (original, mime) in &files {
        for _ in 0..150 {
            let mut bytes = original.clone();
            for _ in 0..=next() % 8 {
                let at = (next() % bytes.len() as u64) as usize;
                bytes[at] = next() as u8;
            }
            // `calamine` panics on some damaged `.xls` files, which `read_here`
            // turns into a refusal.
            let _ = read_here(&bytes, mime, &options());
        }
    }
}
