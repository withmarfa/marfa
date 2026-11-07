# marfa-enrichment

Reads the text and the size out of a file's bytes, so that search can find the file. The crate takes bytes and a MIME type. It knows nothing about items, a database, or HTTP.

The crate reads text, Office, OpenDocument, spreadsheet, HTML, and EPUB files, and the size of an image, all in pure Rust. With the `native` feature it also reads PDFs, and text from pictures with OCR, through PDFium and Tesseract linked into the program. A process of its own for each file comes in a later step. Until then the reader is `pub(crate)`.

## What it reads

| Type | How |
| --- | --- |
| `text/*`, JSON, XML, YAML, TOML, and `+json` and `+xml` types | Decoded as written. A byte order mark decides the encoding, then a declared UTF-16, then valid UTF-8, then the declared charset, then windows-1252. |
| `text/html`, `application/xhtml+xml` | `html5ever` tokenizer. Scripts, styles, and templates are dropped. Block elements separate lines. |
| DOCX, PPTX, and their macro-enabled types | `zip` and `quick-xml`. Word reads headers, footers, footnotes, endnotes, and comments. Deleted text and `mc:Fallback` are skipped. PowerPoint reads slides in presentation order, then notes, comments, and SmartArt. |
| ODT, ODP | `content.xml`, and for text `styles.xml` for page headers and footers. |
| XLSX, XLSB, XLS | `calamine`, cell by cell, with dates as dates. XLSX also reads each sheet's print headers and footers. |
| ODS | A reader of its own, because `calamine` turns 600 bytes of repeated cells into 8 GB. |
| EPUB | Chapters in spine order. |
| `image/*` | Width and height from the header (`image` crate, and a header reader for HEIC and AVIF). |
| PNG, JPEG, WebP, BMP, TIFF, GIF, with `native` and `Options::ocr` | Text, read by Tesseract. See [OCR](#ocr). |
| PDF, with `native` | Text, page by page, through PDFium. A page with a picture and almost no text is drawn and read by OCR when `Options::ocr` is set. Without `native` a PDF is `Refusal::Unsupported`. |

RTF is not read: its control words would be searched as words.

## PDF and OCR

The `native` feature is off by default, so `cargo check --workspace` needs no extra tool. A build with it needs PDFium, Tesseract, Leptonica, and the models, built once per target by the scripts in `native/`.

### Building the native readers

`native/manifest.txt` pins every source by URL and SHA-256 hash (or git commit), and the scripts stop on the first mismatch. Nothing is downloaded by `cargo build`.

```sh
MARFA_NATIVE_ROOT=/path/to/cache native/build.sh aarch64-apple-darwin
MARFA_NATIVE_PREFIX=/path/to/cache/prefix/aarch64-apple-darwin cargo test -p marfa-enrichment --features native
```

`build.sh` runs `models.sh`, `tesseract.sh` and `pdfium.sh`, which you can also run alone. Each takes the target as its argument:

| Target | Status |
| --- | --- |
| `aarch64-apple-darwin` | Built and tested. |
| `aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl` | Scripts written, not yet run. |

You need `cmake`, `ninja`, `git`, `curl`, and Python 3 on the path, plus Xcode's command line tools on macOS. The scripts put downloads, work folders, and the finished `prefix/<target>/` (`lib/`, `include/`, `tessdata/`, `licenses/`) under `MARFA_NATIVE_ROOT`. PDFium takes about 4 GB of checkout and a few minutes on an M4 Pro; delete `work/<target>/` after the build.

- **Leptonica and Tesseract** build static, with no image codecs, no OpenMP, no training tools, and no legacy engine.
- **PDFium** builds from `bblanchon/pdfium-binaries` with its own `build.sh`, static, with no V8 and no XFA. The script stops before the build if the PDFium branch of the pinned release no longer resolves to the pinned commit. To apply a patch to PDFium's build steps, put it in `native/patches/pdfium-*.patch`.
- **Models** are the six `tessdata_fast` files (English, German, French, Spanish, Japanese, simplified Chinese) at one commit. They are fetched, not committed, and `build.rs` embeds them in the program.

`build.rs` reads `MARFA_NATIVE_PREFIX`, stops with a message that names what is missing, compiles the C++ shim in `native/shim.cc`, and links everything statically. To move a pin, change the URL and hash in the manifest together.

### OCR

`Options::ocr` is `None` for no OCR, and an image then gives its size only. `OcrOptions::languages` defaults to `eng+deu+fra+spa`. All six models are inside the program, and `OcrOptions::data_dir` names an optional folder of `<language>.traineddata` files. A model in that folder is used in place of the program's own for that language, and a language only the folder has can be named too, so an owner adds a language or a larger model by dropping in a file. Nothing is written to disk: the shim hands Tesseract a file reader that serves each model from the folder or from the program's memory.

A language with no model, a model that does not load, and an engine that does not start are `Refusal::OcrUnavailable`, which names the cause. A model in the folder that cannot be read is never replaced silently by the program's own.

Pictures are decoded through the `image` crate with limits, turned upright by their EXIF orientation, laid on white where transparent, and reduced to gray. A picture larger than 12 million pixels is scaled down to that. On a 300 dpi letter-size scan (8.4 million pixels), 6 million lost accuracy (26 of 80 lines read differently), and 12 million and no cap read the same text; a larger cap only costs time and memory. A picture that needs more memory decoded than `max_inflated_bytes` is `Refusal::OverLimit` without being decoded, and one that cannot be decoded is `Refusal::Malformed`. A TIFF or GIF with more than one page or frame reads its first.

A PDF page is read from its text layer. A page with fewer than 50 visible characters is drawn at 200 dpi and read by OCR when it holds an image that covers a quarter of the page, or when it has no text and something else is drawn. Chosen on scans, 200 dpi read the same words as 300, and below that accuracy fell. A few words over a blank page are not read as a picture. The drawn page is capped at the same 12 million pixels. Where OCR reads a page, its text replaces the text layer's few characters. PDFium's `U+0002` mark at a hyphenated line end is removed and the word joined. A password-protected PDF is `Refusal::Encrypted`, and one PDFium cannot open is `Refusal::Malformed`.

`Options::time_budget` is soft. When it runs out, Tesseract stops inside the page, the lines read so far are kept, and `Reading::cut_short` is true. No later page is read by OCR. The caller still ends a reader that does not return.

## Limits

`Options::max_text_chars` is a count of UTF-16 code units, as the contract counts them. The text is cut between characters, is well-formed, and is trimmed. A reader stops once it holds enough, so a file with far more text costs no more.

`Options::max_inflated_bytes` bounds all the parts of a package together. The sum of the sizes the zip states is checked when the package opens, and the bytes that actually come out of each part are counted against one shared budget. A zip that states a smaller size than it inflates to is stopped at the size it states. XML is read as events: nesting is limited to 1,024 elements, a document type declaration is never read, and a reference to an entity the document declares is dropped, never expanded. A package is limited to 10,000 parts.

A page of HTML is read up to 8 MiB and 512 open elements.

A file the reader cannot take apart is `Refusal::Malformed`. A parser that panics is also `Malformed`: `calamine` panics on some damaged `.xls` files.

## Testing

```sh
cargo test -p marfa-enrichment
```

The tests read the fixtures of the TypeScript server in place (`packages/server/src/enrichment/fixtures/`), and build the rest in the test. The files in `fixtures/` are ones nothing else here can write: a binary workbook, a password-protected PDF from PDFium's own test files, and four generated pictures (a sentence in three languages, and an upright sentence as a CMYK JPEG, an EXIF-rotated JPEG, and a two-page TIFF). No test covers `.xlsb`.

With the native build, run the same command with `--features native` and `MARFA_NATIVE_PREFIX` set. Those tests are gated on the feature, and one ignored test, `measure`, reads the file named by `MARFA_MEASURE_FILE` and prints the text and the time, for use under `/usr/bin/time -l`.
