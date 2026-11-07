# marfa-enrichment

Reads the text and the size out of a file's bytes, so that search can find the file. The crate takes bytes and a MIME type. It knows nothing about items, a database, or HTTP.

This is the first step of the crate. It reads text, Office, OpenDocument, spreadsheet, HTML, and EPUB files, and the size of an image, all in pure Rust with no native dependency. PDF and OCR, and a process of its own for each file, come in later steps. Until then the reader is `pub(crate)`.

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

RTF is not read: its control words would be searched as words.

## Limits

`Options::max_text_chars` is a count of UTF-16 code units, as the contract counts them. The text is cut between characters, is well-formed, and is trimmed. A reader stops once it holds enough, so a file with far more text costs no more.

`Options::max_inflated_bytes` bounds all the parts of a package together. The sum of the sizes the zip states is checked when the package opens, and the bytes that actually come out of each part are counted against one shared budget. A zip that states a smaller size than it inflates to is stopped at the size it states. XML is read as events: nesting is limited to 1,024 elements, a document type declaration is never read, and a reference to an entity the document declares is dropped, never expanded. A package is limited to 10,000 parts.

A page of HTML is read up to 8 MiB and 512 open elements.

A file the reader cannot take apart is `Refusal::Malformed`. A parser that panics is also `Malformed`: `calamine` panics on some damaged `.xls` files.

## Testing

```sh
cargo test -p marfa-enrichment
```

The tests read the fixtures of the TypeScript server in place (`packages/server/src/enrichment/fixtures/`), and build the rest in the test. `fixtures/sample.xls` is the one file that nothing else here can write. No test covers `.xlsb`.
