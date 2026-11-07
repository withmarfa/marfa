use super::*;

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

/// A relationships part with one relationship per `(id, kind, target)`.
fn rels(items: &[(&str, &str, &str)]) -> String {
    let each: String = items
        .iter()
        .map(|(id, kind, target)| {
            format!(r#"<Relationship Id="{id}" Type="{REL}/{kind}" Target="{target}"/>"#)
        })
        .collect();
    format!(r#"<Relationships xmlns="{RELS}">{each}</Relationships>"#)
}

fn word(body: &str) -> String {
    format!(r#"<w:document xmlns:w="{W}" xmlns:mc="m"><w:body>{body}</w:body></w:document>"#)
}

fn paragraph(text: &str) -> String {
    format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
}

#[test]
fn the_fixture_documents_give_their_markers() {
    assert!(text(&fixture("sample.docx"), DOCX).contains("quokkadocx"));
    assert!(text(&fixture("sample.xlsx"), XLSX).contains("quokkaxlsx"));
}

#[test]
fn a_word_document_gives_every_place_it_keeps_text() {
    let document = word(&format!(
        "{}{}{}<w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>\
         <w:p><w:r><w:t>one</w:t><w:tab/><w:t>two</w:t></w:r></w:p>\
         <mc:AlternateContent><mc:Choice><w:p><w:r><w:t>chosen</w:t></w:r></w:p></mc:Choice>\
         <mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>",
        paragraph("body"),
        paragraph("second"),
        "",
    ));
    let part = |name: &str, tag: &str, inner: &str| {
        (
            name.to_owned(),
            format!(r#"<w:{tag} xmlns:w="{W}">{}</w:{tag}>"#, paragraph(inner)),
        )
    };
    let extras = [
        part("word/header1.xml", "hdr", "quokkaheader"),
        part("word/footer1.xml", "ftr", "quokkafooter"),
        part("word/footnotes.xml", "footnotes", "quokkafootnote"),
        part("word/endnotes.xml", "endnotes", "quokkaendnote"),
        part("word/comments.xml", "comments", "quokkacomment"),
    ];
    let relationships = rels(&[
        ("a", "header", "header1.xml"),
        ("b", "footer", "footer1.xml"),
        ("c", "footnotes", "footnotes.xml"),
        ("d", "endnotes", "endnotes.xml"),
        ("e", "comments", "comments.xml"),
    ]);
    let root = rels(&[("rId1", "officeDocument", "word/document.xml")]);
    let mut parts: Vec<(&str, &[u8])> = vec![
        ("_rels/.rels", root.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", relationships.as_bytes()),
    ];
    parts.extend(extras.iter().map(|(n, c)| (n.as_str(), c.as_bytes())));
    let shown = text(&zip(&parts), DOCX);
    for wanted in [
        "body",
        "kept",
        "one two",
        "chosen",
        "quokkaheader",
        "quokkafooter",
        "quokkafootnote",
        "quokkaendnote",
        "quokkacomment",
    ] {
        assert!(shown.contains(wanted), "{wanted} in {shown:?}");
    }
    for unwanted in ["deleted", "fallback"] {
        assert!(!shown.contains(unwanted), "{unwanted} in {shown:?}");
    }
}

#[test]
fn a_presentation_gives_its_slides_in_order_with_notes_comments_and_diagrams() {
    let slide = |text: &str| {
        format!(
            r#"<p:sld xmlns:p="p" xmlns:a="{A}"><a:p><a:r><a:t>{text}</a:t></a:r><a:fld type="slidenum"><a:t>77</a:t></a:fld></a:p></p:sld>"#
        )
    };
    let presentation = format!(
        r#"<p:presentation xmlns:p="p" xmlns:r="{REL}"><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>"#
    );
    let root = rels(&[("rId1", "officeDocument", "ppt/presentation.xml")]);
    let deck = rels(&[
        ("rA", "slide", "slides/slide1.xml"),
        ("rB", "slide", "slides/slide2.xml"),
    ]);
    let first = rels(&[
        ("n", "notesSlide", "../notesSlides/notes1.xml"),
        ("d", "diagramData", "../diagrams/data1.xml"),
        ("c", "comments", "../comments/comment1.xml"),
    ]);
    let (a, b) = (slide("quokkafirstfile"), slide("quokkasecondfile"));
    let notes = format!(r#"<p:notes xmlns:p="p" xmlns:a="{A}"><a:t>quokkanotes</a:t></p:notes>"#);
    let diagram = format!(
        r#"<dgm:dataModel xmlns:dgm="d" xmlns:a="{A}"><a:t>quokkasmart</a:t></dgm:dataModel>"#
    );
    let comment = r#"<p:cmLst xmlns:p="p"><p:cm><p:text>quokkaremark</p:text></p:cm></p:cmLst>"#;
    let file = zip(&[
        ("_rels/.rels", root.as_bytes()),
        ("ppt/presentation.xml", presentation.as_bytes()),
        ("ppt/_rels/presentation.xml.rels", deck.as_bytes()),
        ("ppt/slides/slide1.xml", a.as_bytes()),
        ("ppt/slides/slide2.xml", b.as_bytes()),
        ("ppt/slides/_rels/slide1.xml.rels", first.as_bytes()),
        ("ppt/notesSlides/notes1.xml", notes.as_bytes()),
        ("ppt/diagrams/data1.xml", diagram.as_bytes()),
        ("ppt/comments/comment1.xml", comment.as_bytes()),
    ]);
    // The presentation lists slide2 first, which is the order it is shown in.
    assert_eq!(
        text(&file, PPTX),
        "quokkasecondfile\nquokkafirstfile\nquokkasmart\nquokkanotes\nquokkaremark"
    );
}

const ODF: &str =
    r#"xmlns:office="o" xmlns:text="t" xmlns:table="b" xmlns:style="s" xmlns:dc="dc""#;

#[test]
fn an_opendocument_text_gives_its_body_and_its_page_headers() {
    let content = format!(
        r#"<office:document-content {ODF}><office:body><office:text><text:h>Heading</text:h><text:p>one<text:s/>two<text:line-break/>three</text:p><text:tracked-changes><text:p>quokkatracked</text:p></text:tracked-changes></office:text></office:body></office:document-content>"#
    );
    let styles = format!(
        r#"<office:document-styles {ODF}><office:master-styles><style:master-page><style:header><text:p>quokkahead</text:p></style:header><style:footer><text:p>quokkafoot</text:p></style:footer></style:master-page></office:master-styles></office:document-styles>"#
    );
    let shown = text(
        &zip(&[
            ("content.xml", content.as_bytes()),
            ("styles.xml", styles.as_bytes()),
        ]),
        ODT,
    );
    assert_eq!(shown, "Heading\none two\nthree\nquokkahead\nquokkafoot");
}

#[test]
fn an_opendocument_presentation_and_spreadsheet_give_their_cells_and_slides() {
    let slides = format!(
        r#"<office:document-content {ODF}><office:body><office:presentation><draw:page xmlns:draw="d"><text:p>slideone</text:p></draw:page><draw:page xmlns:draw="d"><text:p>slidetwo</text:p></draw:page></office:presentation></office:body></office:document-content>"#
    );
    assert_eq!(
        text(&zip(&[("content.xml", slides.as_bytes())]), ODP),
        "slideone\nslidetwo"
    );

    let sheet = format!(
        r#"<office:document-content {ODF}><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row><table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="12.50"><text:p>12.5</text:p></table:table-cell><table:table-cell office:value-type="date" office:date-value="2018-09-20"><text:p>20/09/18</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>"#
    );
    assert_eq!(
        text(&zip(&[("content.xml", sheet.as_bytes())]), ODS),
        "Budget\nItem 12.5 2018-09-20"
    );
}

#[test]
fn a_workbook_gives_its_cells_dates_and_print_headers() {
    let workbook = format!(
        r#"<workbook xmlns="m" xmlns:r="{REL}"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>"#
    );
    let root = rels(&[("rId1", "officeDocument", "xl/workbook.xml")]);
    let book = rels(&[
        ("rId1", "worksheet", "worksheets/sheet1.xml"),
        ("rId2", "sharedStrings", "sharedStrings.xml"),
        ("rId3", "styles", "styles.xml"),
    ]);
    let strings = r#"<sst xmlns="m" count="1" uniqueCount="1"><si><t>Quokka total</t></si></sst>"#;
    let styles = r#"<styleSheet xmlns="m"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>"#;
    let sheet = r#"<worksheet xmlns="m"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42.5</v></c><c r="C1" s="1"><v>43363</v></c></row><row r="2"><c r="A2"><v>7</v></c></row></sheetData><headerFooter><oddHeader>&amp;L&amp;"Arial,Bold"&amp;12quokkaprinthead&amp;RPage &amp;P</oddHeader></headerFooter></worksheet>"#;
    let file = zip(&[
        ("_rels/.rels", root.as_bytes()),
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", book.as_bytes()),
        ("xl/sharedStrings.xml", strings.as_bytes()),
        ("xl/styles.xml", styles.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ]);
    assert_eq!(
        text(&file, XLSX),
        "Sales\nQuokka total 42.5 2018-09-20\n7\nquokkaprinthead Page"
    );
}

#[test]
fn a_book_gives_its_chapters_in_the_order_of_its_spine() {
    let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
    let package = r#"<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="two.xhtml" media-type="application/xhtml+xml"/><item id="c" href="cover.png" media-type="image/png"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>"#;
    let file = zip(&[
        ("META-INF/container.xml", container.as_bytes()),
        ("OEBPS/content.opf", package.as_bytes()),
        (
            "OEBPS/one.xhtml",
            b"<html><body><p>chapter one</p></body></html>",
        ),
        (
            "OEBPS/two.xhtml",
            b"<html><body><p>chapter two</p></body></html>",
        ),
    ]);
    assert_eq!(
        text(&file, "application/epub+zip"),
        "chapter two\nchapter one"
    );
}
