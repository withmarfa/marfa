# marfa-enrichment

Reads the text and the size out of a file's bytes, so that search can find the file. The crate takes bytes and a MIME type. It knows nothing about items, a database, or HTTP.

The crate reads text, Office, OpenDocument, spreadsheet, HTML, and EPUB files, and the size of an image, all in pure Rust. With the `native` feature it also reads PDFs, and text from pictures with OCR, through PDFium and Tesseract linked into the program.

Every file is read in a process of its own, because PDFium and Tesseract are C and C++ reading untrusted bytes beside an owner's database. A program that uses the crate calls `serve_child_if_asked()` as the first line of `main`, then calls `read`:

```rust
fn main() {
    marfa_enrichment::serve_child_if_asked();
    // ...
    let reading = marfa_enrichment::read(&bytes, "application/pdf", &options);
}
```

`read` blocks until the child answers, so an async caller runs it on a blocking thread. Several threads can call it at once. A program that forgets `serve_child_if_asked` panics at its first `read`, and nothing is started or read.

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

`Options::time_budget` is soft. When it runs out, Tesseract stops inside the page, the lines read so far are kept, and `Reading::cut_short` is true. No later page is read by OCR. Unless set, the budget is three quarters of `Options::time_limit`, so a long scan returns the pages it reached instead of being ended. On a 12-page scan with a limit of 4 seconds, the reading came back with its first pages at 3.06 seconds.

## Limits

`Options::max_text_chars` is a count of UTF-16 code units, as the contract counts them. The text is cut between characters, is well-formed, and is trimmed. A reader stops once it holds enough, so a file with far more text costs no more.

`Options::max_inflated_bytes` bounds all the parts of a package together. The sum of the sizes the zip states is checked when the package opens, and the bytes that actually come out of each part are counted against one shared budget. A zip that states a smaller size than it inflates to is stopped at the size it states. XML is read as events: nesting is limited to 1,024 elements, a document type declaration is never read, and a reference to an entity the document declares is dropped, never expanded. A package is limited to 10,000 parts.

A page of HTML is read up to 8 MiB and 512 open elements.

A file the reader cannot take apart is `Refusal::Malformed`. A parser that panics is also `Malformed`: `calamine` panics on some damaged `.xls` files.

## Isolation

`read` decides what it can without a process: an unknown or overlong type, a PDF in a build without `native`, and a file larger than the memory limit. Anything else goes to a child, which is the same program started again:

1. The parent starts the program, from `/proc/self/exe` on Linux so that a new file installed over it changes nothing, with an empty environment, the working directory `/`, and a process group of its own. The limits are on the command line, so the child sets them before it reads a byte.
2. The child closes every inherited descriptor above 2, sets its limits, reads the request from stdin, turns on the sandbox, starts its watchdog, and then reads the file's bytes from stdin. No file path crosses from a caller to the child except the OCR data folder.
3. The child answers with one JSON document on stdout and ends. A child can only claim a reading or one of the refusals that a file earns; it cannot claim to have timed out or crashed.
4. The parent runs one `poll` loop on the calling thread, which feeds stdin and reads stdout and stderr, so no thread can be left behind. It kills the child's whole group at the deadline, when the child's memory passes the limit, and when stdout passes the size of the largest answer `max_text_chars` allows. It always reaps the child, and it does not wait for a pipe to close, so a descendant that holds one cannot hold up the caller.

### What holds on each platform

| Measure | Linux | macOS |
| --- | --- | --- |
| Hard deadline | Parent kills the group. The child's watchdog and `RLIMIT_CPU` stand behind it. | The same. |
| Parent gone | The watchdog sees the parent's id change and ends the child, within 50 ms. | The same. |
| No core file, no file written, few descriptors | `RLIMIT_CORE`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`. | The same, and a crash writes no report in the owner's logs: the signals the crash reporter watches end the child with `128` plus the signal as its exit code, which the parent reads as the signal, and its exception ports are cleared for a stack overflow, which leaves no stack for a handler. |
| Memory | Parent reads resident memory less shared pages from `/proc` every 10 ms. `RLIMIT_AS` stands behind it, at `max_memory_bytes` plus 256 MiB plus the program's size, and still holds when `/proc` is not mounted. | Parent reads the physical footprint every 10 ms. Nothing stands behind it: `setrlimit(RLIMIT_AS)` fails with `EINVAL`. |
| Files | Landlock: read-only to the OCR data folder, nothing else. | `sandbox_init`: the same. |
| Network | Landlock denies TCP from ABI 4. UDP stays open: Landlock has no rule for it. | `sandbox_init` denies all of it. |
| New processes | `RLIMIT_NPROC` 0, which does not hold for root. | `sandbox_init` denies them. |
| New privileges | `PR_SET_NO_NEW_PRIVS`. | No such setting. |
| Program file replaced during a run | No effect while `/proc` is mounted. | The new file runs. An answer it cannot give is `Refusal::Crashed`. |

The sandbox is best effort. A kernel without Landlock still reads the file, and `Reading::sandbox` says what held: `Full`, `Partial` (an older Landlock that enforced part of the rules), or `Off`. Links in the OCR data folder that lead outside it are not followed.

A polled limit can be passed for the length of a poll. Memory written as fast as a process can write it reached 393 MB under a limit of 268 MB on macOS before the kill.

### Default limits

| Option | Default | Why |
| --- | --- | --- |
| `time_limit` | 60 seconds | The TypeScript server's item timeout. The densest page the decode limit allows took 11 seconds. |
| `time_budget` | Three quarters of `time_limit` | Leaves room to answer with what was read. |
| `max_memory_bytes` | 1 GiB | The densest page the decode limit allows peaked at 803 MB. The limit follows `max_inflated_bytes`: raise them together. |

Measured on macOS with the release build:

| Read | Peak footprint |
| --- | --- |
| Letter-size page, OCR with four languages | 108 MB |
| One scanned page in a PDF | 134 MB |
| 12-page scanned PDF | 142 MB |
| 12 million pixels, RGB | 182 MB |
| 21 million pixels, RGB, at the decode limit | 519 MB |
| 64 million pixels, gray, at the decode limit, blank | 584 MB |
| 64 million pixels, gray, at the decode limit, full of text | 803 MB |

On Linux, address space peaked 4 to 7 MiB above resident memory for Tesseract and PDFium, so `RLIMIT_AS` does not bind before the footprint does. A child costs about 10 ms to start.

### How the sweep treats a refusal

| Kind | Comes from | Sweep |
| --- | --- | --- |
| `Unsupported` | An unknown type, or a PDF without `native`. No child is started. | Skipped, final. |
| `Encrypted` | A password-protected file. | Skipped, final. |
| `OverLimit` | A limit on text, parts, or decoding, a file larger than `max_memory_bytes`, or a child over its memory limit, including a failed Rust allocation and a failed C++ `new`. | Skipped until a limit is raised (`housekeeping/enrichment-document-memory`, `enrichment-document-inflated`, `enrichment-document-left`, `enrichment-document-limit-raised`). |
| `Malformed` | A file that does not parse. | Failed, counted against its attempts (`housekeeping/enrichment-failure-counted`). |
| `TimedOut` | A child ended at the deadline, by its watchdog, or by `SIGXCPU`. | Failed, counted against its attempts. A quieter machine may read it. |
| `Crashed` | A child ended by any other signal, by an unknown exit code, or with an answer that is over the cap, not one JSON document, or of the wrong shape. | Failed, counted against its attempts, so a file that kills every reader stops being offered. |
| `OcrUnavailable` | A language or model that does not load. | Not counted: the fault is the setting's. Left unread until the setting changes. |
| `ReaderUnavailable` | No child could start. The file was not tried. | Not counted, and the run stops: otherwise a fault of the machine would use up the attempts of a whole library. |

Memory that C code fails to get may show as `Crashed`: PDFium and Leptonica can end by `SIGSEGV` or `SIGABRT` after a `malloc` returns nothing, and that cannot be told from any other crash. It only happens on Linux, where `RLIMIT_AS` makes `malloc` fail, and only if a read passes the watched footprint between two polls. The attempts count bounds it.

## A program to try it

`marfa-enrichment-read` reads one file through the same path the server uses, prints the text, and exits non-zero on a refusal. It guesses the type from the extension unless given one:

```sh
cargo run -p marfa-enrichment --features native -- read scan.pdf --languages eng+deu
```

Its options are `--type <mime>`, `--languages <a+b>`, `--data-dir <folder>`, `--no-ocr`, `--time-limit <seconds>`, and `--max-memory <bytes>`.

## Testing

```sh
cargo test -p marfa-enrichment
cargo test -p marfa-enrichment --features fault-injection
```

`tests/isolation.rs` is a program of its own that calls `serve_child_if_asked` first, so every test starts the real child and can count this process's children, descriptors, and threads. `tests/forgotten.rs` is a program that does not call it.

The `fault-injection` feature makes a child misbehave on marked bytes: `fault.rs` lists the faults. `build.rs` stops a release build that has it, unless `MARFA_ENRICHMENT_ALLOW_FAULTS` is set for a build that exists to prove the child.

Start `cargo` from under `core/`, so that `scripts/test-limits.sh` is the runner.

The tests read the fixtures of the TypeScript server in place (`packages/server/src/enrichment/fixtures/`), and build the rest in the test. The files in `fixtures/` are ones nothing else here can write: a binary workbook, a password-protected PDF from PDFium's own test files, and four generated pictures (a sentence in three languages, and an upright sentence as a CMYK JPEG, an EXIF-rotated JPEG, and a two-page TIFF). No test covers `.xlsb`.

With the native build, run the same command with `--features native` and `MARFA_NATIVE_PREFIX` set. Those tests are gated on the feature, and one ignored test, `measure`, reads the file named by `MARFA_MEASURE_FILE` and prints the text and the time, for use under `/usr/bin/time -l`.
