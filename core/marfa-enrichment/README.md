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
| DOCX, PPTX, and their macro-enabled types | `zip` and `quick-xml`. Word reads headers, footers, footnotes, endnotes, comments, and diagrams. Deleted text and `mc:Fallback` are skipped. PowerPoint reads slides in presentation order, then notes, comments, and SmartArt. |
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

For a program that ships, run one script per target. It goes from an empty folder to a checked program:

```sh
MARFA_NATIVE_ROOT=/path/to/cache native/release.sh aarch64-apple-darwin
MARFA_NATIVE_ROOT=/path/to/cache native/release.sh aarch64-unknown-linux-musl
MARFA_NATIVE_ROOT=/path/to/cache native/release.sh x86_64-unknown-linux-musl --full
```

`release.sh` fetches and verifies every source, builds PDFium, Leptonica and Tesseract, builds and links the program, checks what it made, gathers the licences, and reads a picture with the finished program and nothing else installed. `--full` adds the whole matrix of `native/verify.sh`, and `--needs` prints what the runner must have. A second run builds only what changed. To build against the libraries in a test run instead:

```sh
MARFA_NATIVE_ROOT=/path/to/cache native/build.sh aarch64-apple-darwin
MARFA_NATIVE_PREFIX=/path/to/cache/prefix/aarch64-apple-darwin cargo test -p marfa-enrichment --features native
```

`build.sh` runs `models.sh`, `tesseract.sh` and `pdfium.sh`, which you can also run alone. Each takes the target as its argument.

| Target | Program | Where it builds |
| --- | --- | --- |
| `aarch64-apple-darwin` | Built, checked and run on its own machine. | A Mac with Apple silicon, Xcode's command line tools, cmake and ninja, and Rust 1.98.1. |
| `aarch64-unknown-linux-musl` | Built, checked and run in `FROM scratch` containers. Fully static (no interpreter, no shared library). | Any machine with Docker. |
| `x86_64-unknown-linux-musl` | Built and checked. Run only under emulation on an Apple silicon Mac (see [Checking a program](#checking-a-program)). Static-pie, with no interpreter and no shared library. | Any machine with Docker. |

On macOS the scripts build with the Xcode on the machine and the Rust the manifest names. On Linux they run in an image that the script makes from `native/linux/Dockerfile`: Ubuntu 24.04 by digest, its packages from the archive as it stood on one day, and Rust from standalone installers pinned by hash. The image is `linux/amd64` for both Linux targets, because Google's build tools and the musl.cc cross compilers are x86_64 programs, so on an Apple silicon Mac it runs emulated. `release.sh` keeps PDFium's checkout (6 GB) on a Docker volume (`<MARFA_RELEASE_PREFIX>-work`, default `marfa-release-work`), which tells `A` from `a` and holds many small files, and deletes it once the library is saved. Remove the image and volume by name when you are done.

- **Leptonica and Tesseract** build static, with no image codecs, no OpenMP, no training tools, and no legacy engine.
- **PDFium** builds from `bblanchon/pdfium-binaries` with its own `build.sh`, static, with no V8 and no XFA. `gclient` syncs at the pinned commit, not at the branch, and the build stops before it compiles if the checkout's `HEAD` is any other commit or a git dependency is not at the commit that commit's `DEPS` names. The `cipd` and `gcs` dependencies are left to their own tools, which fetch what `DEPS` names. The archive's `pdfium-commit` file holds what `git rev-parse` said of the checkout. The Linux libraries use the musl.cc cross compiler (GCC 11.2.1, musl 1.2.2), pinned by hash and kept in a folder named for that hash, so a new pin never finds an earlier compiler. Leptonica, Tesseract, the C++ shim and the program are built with the same compiler, so a program holds one C++ library. To change PDFium's build steps, put a patch in `native/patches/pdfium-*.patch`: it is applied to the verified archive before anything runs. The finished library is kept in `archives/pdfium-<target>-<recipe>.tgz`, named for a hash of the pins and patches, so a later run with the same recipe builds nothing. depot_tools can stop a run under emulation with `LockError ... gsutil_5.35`; `pdfium.sh` resumes the checkout up to four times.
- **Models** are the six `tessdata_fast` files (English, German, French, Spanish, Japanese, simplified Chinese) at one commit. They are fetched, not committed, and `build.rs` embeds them in the program.

`build.rs` reads `MARFA_NATIVE_PREFIX`, stops with a message that names what is missing, compiles the C++ shim in `native/shim.cc`, and emits the link directives. On Linux it links the compiler's own `libstdc++` and `libgcc_eh` statically (the compiler is the linker, with `-C link-self-contained=no`). To move a pin, change the URL and hash in the manifest together.

### The programs

`native/program.sh` builds three programs per target with `cargo build --release --features native`, stripped, into `out/<target>/`:

- `marfa-enrichment-read` is what ships.
- `marfa-enrichment-read-proof` is the same with `fault-injection` (`MARFA_ENRICHMENT_ALLOW_FAULTS` allows it in a release build) so that `verify.sh` can make a reader crash, hang, spin, run out of memory and flood its output. It never ships.
- `marfa-enrichment-fuzz` reads mutated files through the real reader. It never ships.

It then checks them. On Linux, `file` must say the program is statically linked, with no `NEEDED` entry and no interpreter. On macOS, `otool -L` must list only system libraries, the deployment target must be the one built for (`MACOSX_DEPLOYMENT_TARGET`, 13.0 unless `MARFA_MACOS_DEPLOYMENT_TARGET` says otherwise), and the ad hoc signature the linker makes must verify. Where the program can run on the builder, a file that names a fault must be read as plain text by the shipped program and crash the proof program.

`native/licenses.sh` writes `out/<target>/NOTICES.txt`, which ships beside the program: for each part its name, version, licence and where the text came from. The texts are PDFium's own list, the Leptonica and Tesseract sources, the models' licence, the Rust distribution's `COPYRIGHT-library.html`, the licence file of each Rust crate the program holds (`cargo metadata`, normal dependencies), and for Linux the musl and GCC runtime texts that the manifest pins.

### Checking a program

`native/verify.sh <target>` runs the programs on real files with nothing else installed. On Linux that is a `FROM scratch` image holding only the programs and the test files, run `--read-only`, with no `/tmp`, as a user that is not root and as root. On macOS it is `env -i`. The cases:

- one file of every format, and OCR in `eng+deu+fra+spa` from the program's memory, in `jpn` and `chi_sim`, with an owner's model in a read-only data folder, and in a scanned PDF;
- encrypted, damaged and unsupported files, which must be refused with the right reason;
- the proof program's faults, each followed by a good read by the same parent;
- a reader that has been taken over (write a file, open a file, connect, send on UDP, fork) and what it is told;
- the memory limit against a dense 64 million pixel page, and on Linux what a reader's address space reaches against `RLIMIT_AS`.

`MARFA_VERIFY_CORPUS` adds a folder of real PDFs and pictures. `native/verify.sh compare <a> <b>` compares the OCR text of two targets byte for byte. `native/fuzz.sh <target> <seconds>` mutates the same files and reads them, and keeps each file that harms a reader.

An x86_64 program cannot be run natively on an Apple silicon Mac. Docker there runs it under Rosetta, which cannot start a process whose address space is limited to the reader's default (`RLIMIT_AS`, 1 GiB plus 256 MiB plus the program), cannot satisfy an allocation too large for it, reports no Landlock, and cannot run under a seccomp filter: its own calls are not x86_64 calls, so the filter would end the process. The child tries the filter in a forked process first and goes on without it, so `Reading::sandbox` is `Off`. Run it there with `MARFA_VERIFY_MEMORY=2147483648` (and `--max-memory 2147483648` for `fuzz.sh`), expect the cases that depend on those and on the sandbox to differ, and run the whole matrix on an x86_64 Linux machine to see them hold.

### OCR

`Options::ocr` is `None` for no OCR, and an image then gives its size only. `OcrOptions::languages` defaults to `eng+deu+fra+spa`. All six models are inside the program, and `OcrOptions::data_dir` names an optional folder of `<language>.traineddata` files. A model in that folder is used in place of the program's own for that language, and a language only the folder has can be named too, so an owner adds a language or a larger model by dropping in a file. Nothing is written to disk: the shim hands Tesseract a file reader that serves each model from the folder or from the program's memory.

A language with no model, a model that does not load, and an engine that does not start are `Refusal::OcrUnavailable`, which names the cause: beside the size for a picture, and on its own for a PDF. A model in the folder that cannot be read is never replaced silently by the program's own.

Pictures are decoded through the `image` crate with limits, turned upright by their EXIF orientation, laid on white where transparent, and reduced to gray. A picture larger than 12 million pixels is scaled down to that. On a 300 dpi letter-size scan (8.4 million pixels), 6 million lost accuracy (26 of 80 lines read differently), and 12 million and no cap read the same text; a larger cap only costs time and memory. A picture may take three quarters of `max_memory_bytes`, less the size of the file, to decode and scale, and the sum is worked out from its header before anything is decoded. Under the default limits that admits an RGB picture of about 66 million pixels and a gray one of about 90 million. A picture past that is `OverLimit`, one that cannot be decoded is `Malformed`, and a language that does not load is `OcrUnavailable`. Each of these leaves the size in `Reading::dimensions`, with the refusal in `Reading::text_refused`, because the header gave the size before the text failed. Bytes with no readable header are a plain `Refusal::Malformed`. A child that crashes or runs out of time gives no size, because it gives no answer. A TIFF or GIF with more than one page or frame reads its first.

A PDF page is read from its text layer. A page with fewer than 50 visible characters is drawn at 200 dpi and read by OCR when it holds an image that covers a quarter of the page, or when it has no text and something else is drawn. Chosen on scans, 200 dpi read the same words as 300, and below that accuracy fell. A few words over a blank page are not read as a picture. The drawn page is capped at the same 12 million pixels. Where OCR reads a page, its text replaces the text layer's few characters. PDFium's `U+0002` mark at a hyphenated line end is removed and the word joined. On a page with more of these marks than spaces, each mark is read as a space. A password-protected PDF is `Refusal::Encrypted`, and one PDFium cannot open is `Refusal::Malformed`.

`Options::time_budget` is soft. When it runs out, Tesseract stops inside the page, the lines read so far are kept, and `Reading::cut_short` is true. No later page is read by OCR. Unless set, the budget is three quarters of `Options::time_limit`, so a long scan returns the pages it reached instead of being ended. On a 12-page scan with a limit of 4 seconds, the reading came back with its first pages at 3.06 seconds.

## Limits

`Options::max_text_chars` is a count of UTF-16 code units, as the contract counts them. The text is cut between characters, is well-formed, and is trimmed. A reader stops once it holds enough, so a file with far more text costs no more.

`Options::max_inflated_bytes` bounds all the parts of a package together. The sum of the sizes the zip states is checked when the package opens, and the bytes that actually come out of each part are counted against one shared budget. A zip that states a smaller size than it inflates to is stopped at the size it states. XML is read as events: nesting is limited to 1,024 elements, a document type declaration is never read, and a reference to an entity the document declares is dropped, never expanded. A package is limited to 10,000 parts.

A page of HTML is read up to 8 MiB and 512 open elements.

A file the reader cannot take apart is `Refusal::Malformed`. A parser that panics is also `Malformed`: `calamine` panics on some damaged `.xls` files.

## Isolation

`read` decides what it can without a process: an unknown or overlong type, a PDF in a build without `native`, and a file larger than the memory limit. Anything else goes to a child, which is the same program started again:

1. The parent starts the program, from `/proc/self/exe` on Linux so that a new file installed over it changes nothing, with an empty environment, the working directory `/`, and a process group of its own. The limits are on the command line, so the child sets them before it reads a byte.
2. The child closes every inherited descriptor above 2, sets its limits, reads the request from stdin, turns on Landlock or `sandbox_init`, starts its watchdog, loads the seccomp filter on Linux, and states in a first frame on stdout which sandbox holds. No file path crosses from a caller to the child except the OCR data folder.
3. The parent sends the file's bytes only after that frame, and keeps what the frame said. Nothing the child writes later can change `Reading::sandbox`, so code that a file takes over cannot claim a stronger sandbox than the one it ran under.
4. The child answers with one JSON document on stdout and ends. The parent checks the answer against what was asked: a size only for a picture, text from a picture only with OCR, and only the refusals that kind of file can earn. A reason is cleaned of control and direction characters and shortened, as stderr is for a log.
5. The parent runs one `poll` loop on the calling thread, which feeds stdin and reads stdout and stderr, so no thread can be left behind. It kills the child's whole group at the deadline, when the child's memory passes the limit, and when stdout passes the size of the largest answer `max_text_chars` allows. It always reaps the child, and it does not wait for a pipe to close, so a descendant that holds one cannot hold up the caller.

### What holds on each platform

| Measure | Linux | macOS |
| --- | --- | --- |
| Hard deadline | Parent kills the group. The child's watchdog and `RLIMIT_CPU` stand behind it. | The same. |
| Parent gone | The watchdog sees the parent's id change and ends the child, within 50 ms. | The same. |
| No core file, no file written, few descriptors | `RLIMIT_CORE`, `RLIMIT_FSIZE`, `RLIMIT_NOFILE`. | The same, and a crash writes no report in the owner's logs: the signals the crash reporter watches end the child with `128` plus the signal as its exit code, which the parent reads as the signal. |
| Memory | Parent reads resident memory less shared pages from `/proc` every 10 ms. `RLIMIT_AS` stands behind it, at `max_memory_bytes` plus 256 MiB plus the program's size, and still holds when `/proc` is not mounted. | Parent reads the physical footprint every 10 ms. Nothing stands behind it: `setrlimit(RLIMIT_AS)` fails with `EINVAL`. |
| Files | Landlock: read-only to the OCR data folder, nothing else. The filter allows no `open` at all without a data folder, and with one only `open` for reading. | `sandbox_init`: read-only to the data folder, nothing else. |
| What a file says of itself (`chmod`, `chown`, `utimes`, extended attributes) | The filter denies every such call. | `sandbox_init` denies them. |
| Network, and Unix sockets | The filter denies every socket call. | `sandbox_init` denies all of it. |
| New processes | The filter denies `execve`, `fork`, and `clone`, and the watchdog thread starts before it loads. `RLIMIT_NPROC` 0 stands behind it, except for root. | `sandbox_init` denies them. |
| Signals | The filter allows a signal only to the child itself. | `sandbox_init` denies a signal to another process. |
| New privileges | `PR_SET_NO_NEW_PRIVS`. | No such setting. |
| Program file replaced during a run | No effect while `/proc` is mounted. | The new file runs. If it sends no first frame, the reading is `Refusal::ReaderUnavailable`. |

The seccomp filter is an allow-list, for the aarch64 and x86_64 tables, in `src/isolated/calls.rs`. A reader makes about 25 calls, measured with `strace` on Linux arm64 and `qemu-x86_64 -strace` on x86_64 over text, Office, PDF, and OCR files. A deny-list would have to name every call a later kernel adds, including `io_uring` and `bpf`. A call off the list returns `ENOSYS` at once: it never runs, cannot hang, and looks to the C library like a call an older kernel does not have. A call from another architecture's table ends the process. The filter covers every thread of the child, and it allows `openat` only when a data folder was given.

The sandbox is best effort. A machine that cannot hold a reader still reads the file, and `Reading::sandbox` says what held:

| State | Linux | macOS |
| --- | --- | --- |
| `Full` | The filter is loaded, and files are held too: by Landlock of any version, or without a data folder by the filter alone, which then allows no `open`. | `sandbox_init` is on. |
| `Partial` | One of the two is missing. Landlock without the filter leaves sockets, `chmod`, and the others in the rows above open. The filter without Landlock, with a data folder, leaves any file the user can read open to the reader. | Not used. |
| `Off` | Neither holds. Only the limits and the process stand between the reader and the machine. Rosetta is one such case. | `sandbox_init` failed. |

Links in the OCR data folder that lead outside it are not followed.

Code that a file takes over can still do these things, on both platforms:

- Use what the reader needs: its own memory and code, the clock, random bytes, and threads' waits. A flaw in the kernel behind one of those calls is outside the sandbox's reach.
- Write anything on stdout and stderr, within their caps, so it can make up the text of its own file or refuse it for any reason that kind of file can earn.
- Use its time and memory up to the limits, for that file only.
- Read the OCR data folder.

On macOS, memory has no limit behind the parent's polling, and `sandbox_init` is a deprecated interface that Apple can change.

A polled limit can be passed for the length of a poll. Memory written as fast as a process can write it reached 393 MB under a limit of 268 MB on macOS before the kill.

### Default limits

| Option | Default | Why |
| --- | --- | --- |
| `time_limit` | 60 seconds | The TypeScript server's item timeout. The densest page the decode limit allows took 11 seconds. |
| `time_budget` | Three quarters of `time_limit` | Leaves room to answer with what was read. |
| `max_memory_bytes` | 1 GiB | Holds a 64 million pixel photo, at 807 MB on macOS. A picture's decode limit is three quarters of it, and `max_inflated_bytes` does not touch pictures. |

Measured on macOS with the release build:

| Read | Peak footprint |
| --- | --- |
| Letter-size page, OCR with four languages | 108 MB |
| One scanned page in a PDF | 134 MB |
| 12-page scanned PDF | 142 MB |
| 12 million pixels, RGB | 182 MB |
| 6000 x 4000 RGB photo, JPEG | 465 MB |
| 8000 x 6000 RGB photo, JPEG | 681 MB |
| 8000 x 6000 RGB photo, 96 MB PNG | 767 MB |
| 8000 x 8000 RGB photo, JPEG, near the decode limit | 807 MB |
| 64 million pixels, gray, blank | 584 MB |
| 64 million pixels, gray, full of text | 803 MB |

macOS keeps a freed block of this size resident, so the picture, its gray copy, and the buffer that scales it add up there. The decode limit counts all three.

On Linux, with the static musl program, the highest address space of a child (`VmPeak`) stayed 13 to 31 MB above its highest resident memory (`VmHWM`) on real pages, against an `RLIMIT_AS` of 1.37 GB, so the limit does not bind before the footprint does:

| Read | `VmHWM` | `VmPeak` |
| --- | --- | --- |
| Letter-size page, OCR with four languages | 44 MB | 57 MB |
| 6000 x 4000 RGB photo, JPEG | 313 MB | 336 MB |
| 8000 x 6000 RGB photo, JPEG | 453 MB | 476 MB |
| 8000 x 6000 RGB photo, 96 MB PNG | 534 MB | 557 MB |
| 8000 x 8000 RGB photo, JPEG | 526 MB | 549 MB |
| 64 million pixels, gray, full of text | 516 MB | 539 MB |
| Scanned, multi-page PDF | 186 MB | 199 MB |
| Text PDF, a research paper | 13 MB | 44 MB |

A whole run of `marfa-enrichment-read` on a small text file, parent and child together, took 16 ms on macOS and 5 ms on Linux arm64.

### How the sweep treats a refusal

| Kind | Comes from | Sweep |
| --- | --- | --- |
| `Unsupported` | An unknown type, or a PDF without `native`. No child is started. | Skipped, final. |
| `Encrypted` | A password-protected file. | Skipped, final. |
| `OverLimit` | A limit on text, parts, or decoding, a file larger than `max_memory_bytes`, or a child over its memory limit, including a failed Rust allocation and a failed C++ `new`. | Skipped until a limit is raised (`housekeeping/enrichment-document-memory`, `enrichment-document-inflated`, `enrichment-document-left`, `enrichment-document-limit-raised`). |
| `Malformed` | A file that does not parse. | Failed, counted against its attempts (`housekeeping/enrichment-failure-counted`). |
| `TimedOut` | A child ended at the deadline, or by its watchdog or `SIGXCPU` once the deadline had passed. | Failed, counted against its attempts. A quieter machine may read it. |
| `Crashed` | A child that had sent its first frame ended by any other signal, by an unknown exit code, by a timeout's exit code before the deadline, by a code that says it could not start, or with an answer that is over the cap, not one JSON document, or not one that file can earn. | Failed, counted against its attempts, so a file that kills every reader stops being offered. |
| `OcrUnavailable` | A language or model that does not load. | Not counted: the fault is the setting's. Left unread until the setting changes. |
| `ReaderUnavailable` | No child could start, or a child ended before its first frame or sent a bad one. The file was not sent to it. | Not counted, and the run stops: otherwise a fault of the machine would use up the attempts of a whole library. |

A picture whose text is refused still gives a `Reading`, so the sweep can keep its size and treat `Reading::text_refused` as the table says.

Code that a file takes over can only speak after the first frame, and after it nothing stops the run: a child cannot claim `ReaderUnavailable`, and it cannot claim `TimedOut` before the deadline. It can still choose the outcome of its own file. It can answer with an `OverLimit`, `Malformed`, or `Encrypted` that kind of file can earn, or leave with the exit code or abort message of a failed allocation, which is `OverLimit`, and the sweep then skips or counts that one file. A child can do no worse by these than by answering, so they are left as they are.

Memory that C code fails to get may show as `Crashed`: PDFium and Leptonica can end by `SIGSEGV` or `SIGABRT` after a `malloc` returns nothing, and that cannot be told from any other crash. It only happens on Linux, where `RLIMIT_AS` makes `malloc` fail, and only if a read passes the watched footprint between two polls. The attempts count bounds it.

## A program to try it

`marfa-enrichment-read` reads one file through the same path the server uses, prints the text, and exits non-zero on a refusal, including a refusal beside a picture's size. It guesses the type from the extension unless given one:

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

The `fault-injection` feature makes a child misbehave on marked bytes: `fault.rs` lists the faults, among them each call the sandbox must refuse and each thing a taken-over child could say. On Linux these tests need a kernel with seccomp, and they require `Sandbox::Full` where it has it. `build.rs` stops a release build that has it, unless `MARFA_ENRICHMENT_ALLOW_FAULTS` is set for a build that exists to prove the child.

Start `cargo` from under `core/`, so that `scripts/test-limits.sh` is the runner.

The tests read the fixtures of the TypeScript server in place (`packages/server/src/enrichment/fixtures/`), and build the rest in the test. The files in `fixtures/` are ones nothing else here can write: a binary workbook, a password-protected PDF from PDFium's own test files, and four generated pictures (a sentence in three languages, and an upright sentence as a CMYK JPEG, an EXIF-rotated JPEG, and a two-page TIFF). No test covers `.xlsb`.

With the native build, run the same command with `--features native` and `MARFA_NATIVE_PREFIX` set. Those tests are gated on the feature, and one ignored test, `measure`, reads the file named by `MARFA_MEASURE_FILE` and prints the text and the time, for use under `/usr/bin/time -l`.
