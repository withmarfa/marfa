#!/usr/bin/env python3
"""Writes the test files that the repository does not hold, into the folder named by
the first argument (the second, if given, is the folder of the crate's pictures, for
the scanned PDF): one small file of each format the reader takes, each with a marker
word that verify.sh looks for, and the damaged files. Needs Python 3 only. The large
picture for the memory test needs Pillow (`uv run --with pillow`), and is skipped
without it.
"""
import os
import struct
import sys
import zipfile

out = sys.argv[1]
pictures = sys.argv[2] if len(sys.argv) > 2 else None
os.makedirs(out, exist_ok=True)

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
RELS = "http://schemas.openxmlformats.org/package/2006/relationships"


def write(name, data):
    mode = "wb" if isinstance(data, bytes) else "w"
    with open(os.path.join(out, name), mode) as handle:
        handle.write(data)


def package(name, parts):
    with zipfile.ZipFile(os.path.join(out, name), "w", zipfile.ZIP_DEFLATED) as archive:
        for part, data in parts:
            archive.writestr(part, data)


def rels(items):
    each = "".join(f'<Relationship Id="{i}" Type="{REL}/{k}" Target="{t}"/>' for i, k, t in items)
    return f'<Relationships xmlns="{RELS}">{each}</Relationships>'


# Plain text and markup.
write("generated.html", "<html><body><script>var x = 'notshown';</script><p>Verify html marker quokkahtml.</p></body></html>")
write("generated.csv", "name,note\nitem,quokkacsv\n")
write("generated.json", '{"note": "quokkajson"}')
write("generated.xml", "<root><note>quokkaxml</note></root>")
write("generated.md", "# Verify\n\nMarker quokkamd.\n")
write("generated.yaml", "note: quokkayaml\n")

# PowerPoint: two slides, listed in reverse, with notes.
slide = lambda text: f'<p:sld xmlns:p="p" xmlns:a="{A}"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>'
package("generated.pptx", [
    ("_rels/.rels", rels([("rId1", "officeDocument", "ppt/presentation.xml")])),
    ("ppt/presentation.xml", f'<p:presentation xmlns:p="p" xmlns:r="{REL}"><p:sldIdLst><p:sldId id="256" r:id="rB"/><p:sldId id="257" r:id="rA"/></p:sldIdLst></p:presentation>'),
    ("ppt/_rels/presentation.xml.rels", rels([("rA", "slide", "slides/slide1.xml"), ("rB", "slide", "slides/slide2.xml")])),
    ("ppt/slides/slide1.xml", slide("quokkapptxfirst")),
    ("ppt/slides/slide2.xml", slide("quokkapptxsecond")),
])

# OpenDocument text, presentation and spreadsheet.
ODF = 'xmlns:office="o" xmlns:text="t" xmlns:table="b" xmlns:style="s" xmlns:dc="dc" xmlns:draw="d"'
package("generated.odt", [("content.xml", f'<office:document-content {ODF}><office:body><office:text><text:h>Heading</text:h><text:p>quokkaodt</text:p></office:text></office:body></office:document-content>')])
package("generated.odp", [("content.xml", f'<office:document-content {ODF}><office:body><office:presentation><draw:page><text:p>quokkaodp</text:p></draw:page></office:presentation></office:body></office:document-content>')])
package("generated.ods", [("content.xml", f'<office:document-content {ODF}><office:body><office:spreadsheet><table:table table:name="Budget"><table:table-row><table:table-cell office:value-type="string"><text:p>quokkaods</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="12.50"><text:p>12.5</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>')])

# EPUB: two chapters, the spine puts the second first.
package("generated.epub", [
    ("META-INF/container.xml", '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    ("OEBPS/content.opf", '<package><manifest><item id="a" href="one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>'),
    ("OEBPS/one.xhtml", "<html><body><p>quokkaepubone</p></body></html>"),
    ("OEBPS/two.xhtml", "<html><body><p>quokkaepubtwo</p></body></html>"),
])

# A 30 x 20 BMP, 24 bits: the reader gives its size and OCR finds no text.
width, height = 30, 20
row = (b"\xff\xff\xff" * width)
row += b"\x00" * (-len(row) % 4)
pixels = row * height
header = b"BM" + struct.pack("<IHHI", 54 + len(pixels), 0, 0, 54)
header += struct.pack("<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
write("generated.bmp", header + pixels)

# Damaged files.
write("empty.pdf", b"")
write("not-a-pdf.pdf", b"%PDF-1.7\nthis is not a pdf at all\n" * 3)
write("random.png", bytes((i * 131 + 17) % 251 for i in range(4096)))
write("not-a-zip.docx", b"PK\x03\x04" + b"\x00" * 64)
write("not-a-workbook.xls", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 120)
write("deep.xml", "<a>" * 5000 + "quokkadeep" + "</a>" * 5000)
write("truncated-package.docx", b"PK\x03\x04" + bytes(range(200)))

# The picture for the memory test: 64 million pixels, gray, full of text, which is the
# densest read the decode limit allows.
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("make-fixtures: Pillow is missing, so big-text.png is not made", file=sys.stderr)
else:
    if pictures:
        # A scanned PDF: one page that is a picture of text and has no text layer.
        page = Image.open(os.path.join(pictures, "languages.png")).convert("L")
        page.save(os.path.join(out, "scanned.pdf"), "PDF", resolution=200.0)
    size = 8000
    image = Image.new("L", (size, size), 255)
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=26)
    words = "the quick brown fox jumps over a lazy dog while reading tiny pages of dense printed text".split()
    y, line = 10, 0
    while y < size - 40:
        text = " ".join(words[(line + k) % len(words)] for k in range(0, 16)) * 6
        draw.text((10, y), text[:260], fill=0, font=font)
        y += 34
        line += 3
    image.save(os.path.join(out, "big-text.png"), optimize=False, compress_level=1)
print(f"make-fixtures: wrote {len(os.listdir(out))} files to {out}")
