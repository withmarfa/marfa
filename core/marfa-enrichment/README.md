# marfa-enrichment

Reads the text, the size, and the length out of a file, so that search can find the file. The crate takes an open file and a MIME type. It knows nothing about items, a database, or HTTP.

It reads text, Office, OpenDocument, spreadsheet, HTML, and EPUB files, the size of an image, and the length of a sound or a video, in pure Rust. With the `native` feature it also reads PDFs, and text from pictures with OCR, through PDFium and Tesseract linked into the program.

## Use

Every file is read in a process of its own, because PDFium and Tesseract are C and C++ reading untrusted bytes. A program that uses the crate calls `serve_child_if_asked()` as the first line of `main`, then calls `read`:

```rust
fn main() {
    marfa_enrichment::serve_child_if_asked();
    // ...
    let file = std::fs::File::open("scan.pdf")?;
    let reading = marfa_enrichment::read(&file, "application/pdf", &options);
}
```

The file must be a regular file open for reading only. The child reads it by position through the descriptor it is given as stdin, so the offset the caller holds does not move, and the file is never copied into the child except for the formats that need all of it.

`read` blocks until the child answers, so an async caller runs it on a blocking thread. Several threads can call it at once. A program that forgets `serve_child_if_asked` panics at its first `read`, and nothing is started or read.

`Reading::sandbox` says how far the child was shut off from the system (`Full`, `Partial`, or `Off`). The reading is good in every state, so a caller that needs `Full` checks it.

## What it reads

| Type | How |
| --- | --- |
| `text/*`, JSON, XML, YAML, TOML, and `+json` and `+xml` types | Decoded as written. A byte order mark decides the encoding, then a declared UTF-16, then valid UTF-8, then the declared charset, then windows-1252. |
| `text/html`, `application/xhtml+xml` | `html5ever` tokenizer. Scripts, styles, and templates are dropped. |
| DOCX, PPTX, and their macro-enabled types | `zip` and `quick-xml`. Deleted text and `mc:Fallback` are skipped. |
| ODT, ODP | `content.xml`, and `styles.xml` for page headers and footers. |
| XLSX, XLSB, XLS | `calamine`, cell by cell, with dates as dates. |
| ODS | A reader of its own, because `calamine` turns 600 bytes of repeated cells into 8 GB. |
| EPUB | Chapters in spine order. |
| `image/*` | Width and height from the header. |
| MP3, WAV, FLAC, Ogg (Vorbis, Opus; an Ogg video gives its length only), MP4, M4A, M4B, MOV, 3GP | `symphonia`, container only: the length, and for a video the picture size, from the headers. Nothing is decoded and the file is not held in memory. An MP3 with no length header is sized from its bytes as constant bitrate. An AAC track states a few tens of milliseconds of encoder padding. |
| WebM, Matroska | A reader of its own, because `symphonia` states no length for them. The length is the stated duration, or the start of the last block when none is stated (its end, where a block states its length). |
| Pictures, with `native` and `Options::ocr` | Text, read by Tesseract. |
| PDF, with `native` | Text, page by page, through PDFium. A page with almost no text is drawn and read by OCR when `Options::ocr` is set. Without `native` a PDF is `Refusal::Unsupported`. |

RTF is not read: its control words would be searched as words. Other kinds of sound and video, among them AIFF, are `Refusal::Unsupported`. A sound or a video gives no text: `Reading::duration` holds its length in seconds and, for a video, `Reading::dimensions` its picture.

## Limits

`Options` holds the limits. The defaults are a text of 1,000,000 UTF-16 code units, 64 MiB inflated, 1 GiB of memory, and 60 seconds.

- `max_text_chars` cuts the text between characters. A reader stops once it holds enough.
- `max_inflated_bytes` bounds all the parts of a package together. The sum of the sizes the zip states is checked when the package opens, and the bytes that come out of each part are counted against one shared budget. XML is read as events, nests at most 1,024 elements, never reads a document type declaration, and never expands an entity. A package has at most 10,000 parts.
- `max_memory_bytes` bounds the child. A file larger than it is `OverLimit` for every format that is held whole, which is every format but a sound or a video. A picture may take three quarters of it, less the file's size, to decode and scale, and a picture past that is `OverLimit`. A picture larger than 12 million pixels is scaled down before OCR.
- `time_limit` kills the child. `time_budget` is soft: OCR stops inside the page, the text read so far is kept, and `Reading::cut_short` is true. Unset, it is three quarters of `time_limit`.

A file the reader cannot take apart is `Refusal::Malformed`, and so is one that makes a parser panic.

## Isolation

`read` decides what it can without a process: an unknown or overlong type, a PDF in a build without `native`, a file that is not a regular file open for reading only, and a file larger than the memory limit when its format is held whole. Anything else goes to a child, which is the same program started again.

1. The parent starts the program with an empty environment, the working directory `/`, and a process group of its own. The file is the child's stdin, and the limits and the request are on the command line, so the child sets the limits before it reads a byte.
2. The child closes every inherited descriptor above 2, turns on Landlock or `sandbox_init`, starts a watchdog, loads the seccomp filter on Linux, and states in a first frame on stdout which sandbox holds.
3. The child reads the file only after that frame, with `pread` and the length from the request, so it asks the file for nothing else. The parent keeps what the frame said. Nothing the child writes later can change `Reading::sandbox`.
4. The child answers with one JSON document and ends. The parent checks the answer against what was asked.
5. The parent runs one `poll` loop on the calling thread. It kills the child's whole group at the deadline, when the child's memory passes the limit, and when stdout passes the largest answer `max_text_chars` allows. It always reaps the child.

| Measure | Linux | macOS |
| --- | --- | --- |
| Memory | The parent reads resident memory from `/proc` every 10 ms. `RLIMIT_AS` stands behind it. | The parent reads the physical footprint every 10 ms. Nothing stands behind it. |
| Files | Landlock allows read-only access to the OCR data folder and nothing else. Without a data folder the filter allows no `open`. | `sandbox_init` allows read-only access to the data folder and nothing else. |
| Network, processes, signals | The seccomp allow-list in `src/isolated/calls.rs` refuses them. | `sandbox_init` refuses them. |
| Crash | No core file. | No core file and no crash report: the signals the reporter watches end the child with `128` plus the signal. |

`Sandbox::Full` needs the filter and files held: on Linux the seccomp filter plus Landlock, or the filter alone when there is no data folder; on macOS `sandbox_init`. `Partial` is Linux only, with one of the two missing. `Off` means only the limits stand between the reader and the machine. Rosetta is one such case, since its calls are not x86_64 calls and the filter cannot run there.

## Refusals

| Kind | Meaning |
| --- | --- |
| `Unsupported` | An unknown type, or a PDF without `native`. No child is started. |
| `Encrypted` | A password-protected file. |
| `Malformed` | A file that does not parse. |
| `OverLimit` | A limit on text, parts, or decoding, a file larger than `max_memory_bytes` that is held whole, or a child over its memory limit. Raising the limit may let it read. |
| `TimedOut` | The child ended at the deadline. |
| `Crashed` | The child ended by a signal, or gave an answer that cannot be believed. |
| `OcrUnavailable` | A language or model that does not load. The setting is at fault, not the file. |
| `ReaderUnavailable` | No child could start, or the file given is not a regular file open for reading only. The file was not tried. |

A picture whose text is refused still gives a `Reading`, with its size in `Reading::dimensions` and the refusal in `Reading::text_refused`.

## OCR

`Options::ocr` is `None` for no OCR. `OcrOptions::languages` defaults to `eng+deu+fra+spa`. The six `tessdata_fast` models (English, German, French, Spanish, Japanese, simplified Chinese) are inside the program, and `OcrOptions::data_dir` names an optional folder of `<language>.traineddata` files. A model in that folder replaces the program's own for that language, and a language only the folder has can be named too. Nothing is written to disk.

## Try it

`marfa-enrichment-read` reads files through the same path, prints the text, the size, and the length, and exits non-zero on a refusal:

```sh
cargo run -p marfa-enrichment --bin marfa-enrichment-read --features native -- read scan.pdf --languages eng+deu
```

Its options are `--type <mime>`, `--languages <a+b>`, `--data-dir <folder>`, `--no-ocr`, `--time-limit <seconds>`, and `--max-memory <bytes>`.

## Build the native readers

The `native` feature is off by default, so `cargo check --workspace` needs no extra tool. A build with it needs PDFium, Tesseract, Leptonica, and the models, built once per target by the scripts in `native/`. `native/manifest.txt` pins every source by hash, commit, or digest, and the scripts stop on the first mismatch. `cargo build` downloads nothing. To move a pin, change its URL and hash together.

```sh
MARFA_NATIVE_ROOT=/path/to/cache native/release.sh aarch64-apple-darwin
MARFA_NATIVE_ROOT=/path/to/cache native/release.sh x86_64-unknown-linux-musl --full
```

`release.sh` fetches and verifies every source, builds the libraries and the programs, checks what it made, writes `out/<target>/NOTICES.txt` with the licences, and reads a picture with the finished program and nothing else installed. `--full` adds the whole matrix of `native/verify.sh`, and `--needs` prints what the runner must have. A second run builds only what changed.

| Target | Where it builds |
| --- | --- |
| `aarch64-apple-darwin` | A Mac with Apple silicon, Xcode's command line tools, cmake and ninja. |
| `aarch64-unknown-linux-musl` | Any machine with Docker. |
| `x86_64-unknown-linux-musl` | Any machine with Docker. |

On Linux the scripts run in an image that `native/linux/Dockerfile` defines: Ubuntu 24.04 by digest, packages from the archive as it stood on one day, and Rust from installers pinned by hash. The Linux programs are static, with no interpreter and no shared library.

To run a test against the libraries instead:

```sh
MARFA_NATIVE_ROOT=/path/to/cache native/build.sh aarch64-apple-darwin
MARFA_NATIVE_PREFIX=/path/to/cache/prefix/aarch64-apple-darwin cargo test -p marfa-enrichment --features native
```

To change PDFium's build steps, add a patch named `native/patches/pdfium-*.patch`. It is applied to the verified archive before anything runs.

### The programs

`native/program.sh` builds three programs per target into `out/<target>/`:

- `marfa-enrichment-read` is what ships.
- `marfa-enrichment-read-proof` is the same with `fault-injection`, so that `verify.sh` can make a reader crash, hang, spin, run out of memory, and flood its output. It never ships.
- `marfa-enrichment-fuzz` reads mutated files through the real reader. It never ships.

### Check a program

`native/verify.sh <target>` runs the programs on real files with nothing else installed: on Linux a `FROM scratch` image run `--read-only` as a user that is not root and as root, on macOS `env -i`. It checks:

- one file of every format, the length of each sound and video, and OCR in each language;
- encrypted, damaged, and unsupported files, which must be refused with the right reason;
- the proof program's faults, each followed by a good read by the same parent;
- a reader that has been taken over (write a file, open a file, connect, send on UDP, fork);
- the memory limit against a dense 64 million pixel page.

`native/verify.sh <target> --vm` runs the matrix for `x86_64-unknown-linux-musl` on a real kernel in QEMU, when no x86_64 machine is at hand. An x86_64 program run under Rosetta on an Apple silicon Mac reports `Sandbox::Off` and fails the cases that depend on the sandbox. `native/fuzz.sh <target> <seconds>` mutates the same files, reads them, and keeps each file that harms a reader.

## Test

Start `cargo` from under `core/`, so that `scripts/test-limits.sh` is the runner:

```sh
cargo nextest run -p marfa-enrichment
cargo nextest run -p marfa-enrichment --features fault-injection
```

`tests/isolation.rs` is a program of its own that calls `serve_child_if_asked` first, so every test starts the real child and can count this process's children, descriptors, and threads. `tests/forgotten.rs` is a program that does not call it.

The `fault-injection` feature makes a child misbehave on marked bytes. `src/isolated/fault.rs` lists the faults, among them each call the sandbox must refuse and each thing a taken-over child could say. On Linux these tests need a kernel with seccomp and require `Sandbox::Full`. `build.rs` stops a release build that has the feature, unless `MARFA_ENRICHMENT_ALLOW_FAULTS` is set for a build that exists to prove the child.

`fixtures/` holds the files the tests read, among them a short sound and video of each format. `sample.ogv` is `sample.ogg` behind the first header of a Theora stream, since no encoder for Theora was at hand: it shows that a video stream the reader does not read does not stop the sound beside it from being measured. Four generated pictures (a sentence in three languages, an upright sentence as a CMYK JPEG, an EXIF-rotated JPEG, and a two-page TIFF), a binary workbook, and a password-protected PDF from PDFium's own test files are ones nothing else here can write. No test covers `.xlsb`.

With the native build, add `--features native` and set `MARFA_NATIVE_PREFIX`. One ignored test, `measure`, reads the file named by `MARFA_MEASURE_FILE` and prints the text and the time, for use under `/usr/bin/time -l`.
