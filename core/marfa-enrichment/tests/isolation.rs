//! Each test here is the real thing: this program calls `serve_child_if_asked` as the
//! first line of `main`, so `read` starts this very program, as it starts the server.
//! The tests run one at a time, because they count this process's children and
//! descriptors.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use libtest_mimic::{Arguments, Failed, Trial};
use marfa_enrichment::{Options, Reading, Refusal, read, serve_child_if_asked};

const TEXT: &str = "text/plain";
/// Says that a run of this program is a scenario in a copy of it, not the tests.
const SCENARIO: &str = "MARFA_ISOLATION_SCENARIO";
const MIB: u64 = 1024 * 1024;

type Test = fn() -> Result<(), Failed>;

fn options() -> Options {
    Options {
        time_limit: Duration::from_secs(20),
        ..Options::default()
    }
}

fn read_text(words: &str) -> Result<Reading, Refusal> {
    read(words.as_bytes(), TEXT, &options())
}

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(name);
    std::fs::read(path).expect("a fixture of this crate")
}

fn check(condition: bool, problem: impl FnOnce() -> String) -> Result<(), Failed> {
    if condition {
        Ok(())
    } else {
        Err(problem().into())
    }
}

fn zombies_and_children() -> i32 {
    // SAFETY: only asks, and collects any child that has ended.
    unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) }
}

/// No child is left, running or ended, and the next file reads as it should.
fn parent_is_whole() -> Result<(), Failed> {
    let left = zombies_and_children();
    check(left == -1, || format!("a child was left behind: {left}"))?;
    let reading = read_text("the next file").map_err(|refusal| refusal.to_string())?;
    check(reading.text == "the next file", || {
        format!("read {:?}", reading.text)
    })
}

fn open_descriptors() -> usize {
    let listed = std::fs::read_dir("/dev/fd").expect("a list of descriptors");
    // Not counting the one the listing holds.
    listed.count() - 1
}

#[cfg(target_os = "linux")]
fn thread_count() -> usize {
    std::fs::read_dir("/proc/self/task")
        .expect("a list of threads")
        .count()
}

#[cfg(target_os = "macos")]
fn thread_count() -> usize {
    let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    let size = i32::try_from(size_of::<libc::proc_taskinfo>()).expect("a small struct");
    let pid = i32::try_from(std::process::id()).expect("a process id");
    // SAFETY: the buffer is the size of the flavor asked for.
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    assert_eq!(written, size);
    // SAFETY: the kernel filled the whole buffer, and any bits are valid integers.
    let threads = unsafe { info.assume_init() }.pti_threadnum;
    usize::try_from(threads).expect("a count")
}

fn reads_text() -> Result<(), Failed> {
    let reading = read_text("words in a file").map_err(|refusal| refusal.to_string())?;
    check(reading.text == "words in a file", || {
        format!("read {:?}", reading.text)
    })?;
    parent_is_whole()
}

fn reads_an_image_size() -> Result<(), Failed> {
    let reading = read(&fixture("sentence.png"), "image/png", &Options::default())
        .map_err(|refusal| refusal.to_string())?;
    let size = reading.dimensions.ok_or("no size")?;
    check(size.width > 0 && size.height > 0, || format!("{size:?}"))
}

fn an_empty_file_reads_as_nothing() -> Result<(), Failed> {
    let reading = read(b"", TEXT, &options()).map_err(|refusal| refusal.to_string())?;
    check(reading.text.is_empty(), || format!("{:?}", reading.text))
}

fn twenty_mebibytes_cross_the_pipe() -> Result<(), Failed> {
    let mut bytes = b"start ".repeat(1 << 20);
    bytes.resize(20 * MIB as usize, b'x');
    bytes.extend_from_slice(b" end");
    let limited = Options {
        max_text_chars: bytes.len() + 1,
        ..options()
    };
    let reading = read(&bytes, TEXT, &limited).map_err(|refusal| refusal.to_string())?;
    check(reading.text.len() == bytes.len(), || {
        format!("read {} of {} bytes", reading.text.len(), bytes.len())
    })?;
    check(reading.text.ends_with(" end"), || "the end is lost".into())
}

fn the_text_limit_holds_across_the_pipe() -> Result<(), Failed> {
    let limited = Options {
        max_text_chars: 10,
        ..options()
    };
    let reading = read(b"0123456789abcdef", TEXT, &limited).map_err(|r| r.to_string())?;
    check(reading.text == "0123456789" && reading.truncated, || {
        format!("{reading:?}")
    })
}

/// A time limit of zero would end any child, so an answer other than `TimedOut` shows
/// that none was started.
fn what_the_call_decides_starts_no_child() -> Result<(), Failed> {
    let no_time = Options {
        time_limit: Duration::ZERO,
        ..options()
    };
    check(read(b"x", TEXT, &no_time) == Err(Refusal::TimedOut), || {
        "the witness: a child that is started runs out of time".into()
    })?;
    for mime in ["application/x-unknown", "", "not a type", "text/rtf"] {
        let outcome = read(b"x", mime, &no_time);
        check(outcome == Err(Refusal::Unsupported), || {
            format!("{mime:?} gave {outcome:?}")
        })?;
    }
    let long = format!("text/plain;x={}", "y".repeat(2000));
    check(
        read(b"x", &long, &no_time) == Err(Refusal::Unsupported),
        || "a very long type".into(),
    )?;
    let small = Options {
        max_memory_bytes: 3,
        ..no_time
    };
    let outcome = read(b"four", TEXT, &small);
    check(matches!(outcome, Err(Refusal::OverLimit(_))), || {
        format!("a file over the memory limit gave {outcome:?}")
    })
}

#[cfg(not(feature = "native"))]
fn a_pdf_without_native_is_unsupported() -> Result<(), Failed> {
    let no_time = Options {
        time_limit: Duration::ZERO,
        ..options()
    };
    check(
        read(b"%PDF-", "application/pdf", &no_time) == Err(Refusal::Unsupported),
        || "a PDF in a build with no PDF reader".into(),
    )
}

/// Under load nothing grows: not descriptors, not threads, not children.
fn two_hundred_reads_eight_at_a_time() -> Result<(), Failed> {
    const READS: usize = 200;
    const AT_ONCE: usize = 8;
    let (descriptors, threads) = (open_descriptors(), thread_count());
    let next = AtomicUsize::new(0);
    let wrong = AtomicUsize::new(0);
    let most_descriptors = AtomicUsize::new(0);
    // Joined by hand: the end of a scope waits for the closures, not for the threads
    // to be gone, and they are counted next.
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..AT_ONCE)
            .map(|_| {
                scope.spawn(|| {
                    loop {
                        let index = next.fetch_add(1, Ordering::SeqCst);
                        if index >= READS {
                            break;
                        }
                        let words = format!("file number {index}");
                        match read_text(&words) {
                            Ok(reading) if reading.text == words => {}
                            _ => {
                                wrong.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        most_descriptors.fetch_max(open_descriptors(), Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().expect("a worker");
        }
    });
    check(wrong.load(Ordering::SeqCst) == 0, || {
        format!("{} reads went wrong", wrong.load(Ordering::SeqCst))
    })?;
    let (after, threads_after) = (open_descriptors(), thread_count());
    println!(
        "descriptors {descriptors} -> {after} (most {}), threads {threads} -> {threads_after}",
        most_descriptors.load(Ordering::SeqCst)
    );
    check(after == descriptors, || {
        format!("descriptors went from {descriptors} to {after}")
    })?;
    check(threads_after == threads, || {
        format!("threads went from {threads} to {threads_after}")
    })?;
    check(zombies_and_children() == -1, || "a child was left".into())
}

/// Runs a copy of this program as `scenario`, which it does on its own file.
fn in_a_copy(scenario: &str) -> Result<(), Failed> {
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let copy = folder.path().join("copy");
    let this = std::env::current_exe().map_err(|error| error.to_string())?;
    std::fs::copy(this, &copy).map_err(|error| error.to_string())?;
    let run = Command::new(&copy)
        .env(SCENARIO, scenario)
        .output()
        .map_err(|error| error.to_string())?;
    check(run.status.success(), || {
        format!(
            "{}{}",
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr)
        )
    })
}

fn the_program_replaced_on_disk() -> Result<(), Failed> {
    in_a_copy("replaced")
}

fn the_program_removed_from_disk() -> Result<(), Failed> {
    in_a_copy("removed")
}

/// Runs in the copy.
fn replaced() {
    let me = std::env::current_exe().expect("this program's path");
    let replacement = me.with_extension("new");
    std::fs::write(&replacement, b"#!/bin/sh\necho not the reader\n").expect("a file");
    set_executable(&replacement);
    assert_eq!(read_text("before").expect("a first read").text, "before");
    std::fs::rename(&replacement, &me).expect("the swap an upgrade makes");
    let after = read_text("after");
    if cfg!(target_os = "linux") {
        assert_eq!(after.expect("a read after the swap").text, "after");
    } else {
        // The path is all macOS has, and what is there now gives no answer to believe.
        assert!(matches!(after, Err(Refusal::Crashed(_))), "{after:?}");
    }
    assert_eq!(zombies_and_children(), -1);
}

/// Runs in the copy.
fn removed() {
    let me = std::env::current_exe().expect("this program's path");
    std::fs::remove_file(&me).expect("the removal");
    let after = read_text("after");
    if cfg!(target_os = "linux") {
        assert_eq!(after.expect("a read after the removal").text, "after");
    } else {
        assert!(
            matches!(after, Err(Refusal::ReaderUnavailable(_))),
            "{after:?}"
        );
    }
    // For a moment after a `posix_spawn` that failed, macOS still lists the process it
    // built and is taking down, though no one can wait for it.
    let started = Instant::now();
    while zombies_and_children() != -1 {
        assert!(started.elapsed() < Duration::from_secs(1), "a child stayed");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn set_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("permissions");
}

fn run_read(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_marfa-enrichment-read"))
        .args(arguments)
        .output()
        .expect("the program starts")
}

fn the_program_prints_what_it_read() -> Result<(), Failed> {
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let file = folder.path().join("note.txt");
    std::fs::write(&file, "from the command line").map_err(|error| error.to_string())?;
    let run = run_read(&["read", file.to_str().ok_or("a path")?]);
    check(run.status.success(), || format!("{run:?}"))?;
    check(
        String::from_utf8_lossy(&run.stdout).trim() == "from the command line",
        || format!("{run:?}"),
    )
}

fn the_program_exits_non_zero_on_a_refusal() -> Result<(), Failed> {
    let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
    let file = folder.path().join("note.bin");
    std::fs::write(&file, "x").map_err(|error| error.to_string())?;
    let path = file.to_str().ok_or("a path")?;
    let refused = run_read(&["read", path, "--type", "application/x-unknown"]);
    check(refused.status.code() == Some(1), || format!("{refused:?}"))?;
    check(
        String::from_utf8_lossy(&refused.stderr).contains("refused:"),
        || format!("{refused:?}"),
    )?;
    let unguessed = run_read(&["read", path]);
    check(unguessed.status.code() == Some(2), || {
        format!("{unguessed:?}")
    })?;
    let misused = run_read(&["nonsense"]);
    check(misused.status.code() == Some(2), || format!("{misused:?}"))
}

/// Someone who starts a child by hand gets a process that stops, not one that waits.
fn a_child_started_by_hand_reads_nothing() -> Result<(), Failed> {
    let run = run_read(&["--marfa-enrichment-child"]);
    check(run.status.code() == Some(74), || format!("{run:?}"))?;
    let run = run_read(&["--marfa-enrichment-child", "soon", "much"]);
    check(run.status.code() == Some(74), || format!("{run:?}"))
}

#[cfg(feature = "native")]
mod native {
    use std::path::PathBuf;

    use marfa_enrichment::OcrOptions;

    use super::*;

    fn ocr_options(data_dir: Option<PathBuf>, languages: &str) -> Options {
        Options {
            ocr: Some(OcrOptions {
                languages: languages.to_owned(),
                data_dir,
            }),
            ..options()
        }
    }

    pub(super) fn reads_a_picture() -> Result<(), Failed> {
        let options = ocr_options(None, "eng");
        let reading = read(&fixture("sentence.png"), "image/png", &options)
            .map_err(|refusal| refusal.to_string())?;
        check(reading.text.contains("upright"), || {
            format!("{:?}", reading.text)
        })
    }

    /// A PDF of one page drawn by `content`, using `resources`, with `extra` objects
    /// numbered from 5.
    fn pdf(content: &str, resources: &str, extra: &[Vec<u8>]) -> Vec<u8> {
        let mut objects = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 750 70] /Contents 4 0 R \
                 /Resources << {resources} >> >>"
            )
            .into_bytes(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            )
            .into_bytes(),
        ];
        objects.extend_from_slice(extra);
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend(body);
            out.extend(b"\nendobj\n");
        }
        let table = out.len();
        let size = objects.len() + 1;
        out.extend(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
        for offset in offsets {
            out.extend(format!("{offset:010} 00000 n \n").as_bytes());
        }
        out.extend(
            format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{table}\n%%EOF\n")
                .as_bytes(),
        );
        out
    }

    pub(super) fn reads_a_text_pdf() -> Result<(), Failed> {
        let bytes = pdf(
            "BT /F1 18 Tf 10 30 Td (Words a PDF holds) Tj ET",
            "/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>",
            &[],
        );
        let reading =
            read(&bytes, "application/pdf", &options()).map_err(|refusal| refusal.to_string())?;
        check(reading.text.contains("Words a PDF holds"), || {
            format!("{:?}", reading.text)
        })
    }

    /// PDFium draws the page and Tesseract reads the drawing, all under the sandbox.
    pub(super) fn reads_a_scanned_pdf() -> Result<(), Failed> {
        let picture = image::load_from_memory(&fixture("sentence.png"))
            .map_err(|error| error.to_string())?
            .into_luma8();
        let (width, height) = picture.dimensions();
        let pixels = picture.into_raw();
        let mut image = format!(
            "<< /Type /XObject /Subtype /Image /Width {width} /Height {height} \
             /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {} >>\nstream\n",
            pixels.len()
        )
        .into_bytes();
        image.extend(pixels);
        image.extend(b"\nendstream");
        let bytes = pdf(
            "q 750 0 0 70 0 0 cm /Im1 Do Q",
            "/XObject << /Im1 5 0 R >>",
            &[image],
        );
        let options = ocr_options(None, "eng");
        let reading =
            read(&bytes, "application/pdf", &options).map_err(|refusal| refusal.to_string())?;
        check(reading.text.contains("upright"), || {
            format!("{:?}", reading.text)
        })
    }

    pub(super) fn a_damaged_pdf_is_malformed() -> Result<(), Failed> {
        let outcome = read(b"%PDF-1.4\nnothing else", "application/pdf", &options());
        check(matches!(outcome, Err(Refusal::Malformed(_))), || {
            format!("{outcome:?}")
        })
    }

    pub(super) fn an_encrypted_pdf_is_named() -> Result<(), Failed> {
        let outcome = read(&fixture("encrypted.pdf"), "application/pdf", &options());
        check(outcome == Err(Refusal::Encrypted), || {
            format!("{outcome:?}")
        })
    }

    /// Languages are the one way a caller's text reaches a path, and it may not walk
    /// out of the folder.
    pub(super) fn a_language_cannot_name_a_path() -> Result<(), Failed> {
        let options = ocr_options(None, "../../../../etc/passwd");
        let outcome = read(&fixture("sentence.png"), "image/png", &options);
        check(matches!(outcome, Err(Refusal::OcrUnavailable(_))), || {
            format!("{outcome:?}")
        })
    }

    /// A model the owner added loads from inside the sandbox, after it is up: the
    /// models load lazily, on the first picture. The copy has a name the program
    /// does not carry, so reading with it proves the folder was read.
    pub(super) fn a_model_in_the_data_folder_loads_inside_the_sandbox() -> Result<(), Failed> {
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let prefix = std::env::var_os("MARFA_NATIVE_PREFIX").ok_or("no native prefix")?;
        std::fs::copy(
            Path::new(&prefix).join("tessdata/eng.traineddata"),
            folder.path().join("mine.traineddata"),
        )
        .map_err(|error| error.to_string())?;
        let with_folder = ocr_options(Some(folder.path().to_owned()), "mine");
        let reading = read(&fixture("sentence.png"), "image/png", &with_folder)
            .map_err(|refusal| refusal.to_string())?;
        check(reading.text.contains("upright"), || {
            format!("{:?}", reading.text)
        })?;
        let without = ocr_options(None, "mine");
        let outcome = read(&fixture("sentence.png"), "image/png", &without);
        check(matches!(outcome, Err(Refusal::OcrUnavailable(_))), || {
            format!("the witness: without the folder {outcome:?}")
        })
    }

    /// A link in the folder to a file outside it is not a way out.
    pub(super) fn a_link_in_the_data_folder_does_not_leave_it() -> Result<(), Failed> {
        let outside = tempfile::tempdir().map_err(|error| error.to_string())?;
        let inside = tempfile::tempdir().map_err(|error| error.to_string())?;
        let prefix = std::env::var_os("MARFA_NATIVE_PREFIX").ok_or("no native prefix")?;
        let model = outside.path().join("eng.traineddata");
        std::fs::copy(Path::new(&prefix).join("tessdata/eng.traineddata"), &model)
            .map_err(|error| error.to_string())?;
        std::os::unix::fs::symlink(&model, inside.path().join("mine.traineddata"))
            .map_err(|error| error.to_string())?;
        let options = ocr_options(Some(inside.path().to_owned()), "mine");
        let outcome = read(&fixture("sentence.png"), "image/png", &options);
        match outcome {
            Err(Refusal::OcrUnavailable(_)) => Ok(()),
            Ok(reading) if reading.sandbox != marfa_enrichment::Sandbox::Full => Ok(()),
            other => Err(format!("{other:?}").into()),
        }
    }
}

#[cfg(feature = "fault-injection")]
mod faults {
    use std::io::Read as _;
    use std::net::TcpListener;
    use std::os::fd::AsRawFd;

    use marfa_enrichment::Sandbox;

    use super::*;

    fn fault(name: &str) -> Vec<u8> {
        format!("MARFA-ENRICHMENT-FAULT:{name}\nand the rest of the file").into_bytes()
    }

    fn short() -> Options {
        Options {
            time_limit: Duration::from_secs(2),
            ..Options::default()
        }
    }

    fn crashes_naming(name: &str, signal: &str) -> Result<(), Failed> {
        let outcome = read(&fault(name), TEXT, &short());
        match &outcome {
            Err(Refusal::Crashed(reason)) if reason.contains(signal) => parent_is_whole(),
            other => Err(format!("{other:?}").into()),
        }
    }

    pub(super) fn a_segfault_is_a_crash_named_by_its_signal() -> Result<(), Failed> {
        // Linux gives SIGSEGV for address 1. macOS may give SIGBUS for the same write.
        let signal = if cfg!(target_os = "linux") {
            "SIGSEGV"
        } else {
            "SIG"
        };
        crashes_naming("segfault", signal)
    }

    pub(super) fn an_abort_is_a_crash_named_by_its_signal() -> Result<(), Failed> {
        crashes_naming("abort", "SIGABRT")
    }

    fn times_out_on_time(name: &str) -> Result<(), Failed> {
        let limit = Duration::from_millis(400);
        let options = Options {
            time_limit: limit,
            ..Options::default()
        };
        let started = Instant::now();
        let outcome = read(&fault(name), TEXT, &options);
        let took = started.elapsed();
        println!("{name}: limit {limit:?}, ended after {took:?}");
        check(outcome == Err(Refusal::TimedOut), || format!("{outcome:?}"))?;
        check(took >= limit, || format!("ended early, at {took:?}"))?;
        check(took < limit + Duration::from_millis(300), || {
            format!("ended late, at {took:?}")
        })?;
        parent_is_whole()
    }

    pub(super) fn a_hang_times_out_on_time() -> Result<(), Failed> {
        times_out_on_time("hang")
    }

    pub(super) fn a_spin_times_out_on_time() -> Result<(), Failed> {
        times_out_on_time("spin")
    }

    pub(super) fn a_stderr_flood_times_out_on_time() -> Result<(), Failed> {
        times_out_on_time("flood-stderr")
    }

    pub(super) fn an_orphan_holding_the_pipes_does_not_hold_the_parent() -> Result<(), Failed> {
        let started = Instant::now();
        let outcome = read(&fault("orphan"), TEXT, &short());
        check(started.elapsed() < Duration::from_secs(1), || {
            format!("took {:?}", started.elapsed())
        })?;
        // On macOS the sandbox refused the fork, and the child ended the same way.
        check(matches!(outcome, Err(Refusal::Crashed(_))), || {
            format!("{outcome:?}")
        })?;
        parent_is_whole()
    }

    pub(super) fn a_stdout_flood_is_a_crash_and_ends_early() -> Result<(), Failed> {
        let started = Instant::now();
        let outcome = read(
            &fault("flood-stdout"),
            TEXT,
            &Options {
                max_text_chars: 1000,
                ..short()
            },
        );
        check(matches!(outcome, Err(Refusal::Crashed(_))), || {
            format!("{outcome:?}")
        })?;
        check(started.elapsed() < Duration::from_secs(1), || {
            format!("took {:?}", started.elapsed())
        })?;
        parent_is_whole()
    }

    pub(super) fn garbage_is_a_crash() -> Result<(), Failed> {
        crashes_naming("garbage", "answer")
    }

    pub(super) fn an_empty_answer_is_a_crash() -> Result<(), Failed> {
        crashes_naming("silent", "answer")
    }

    pub(super) fn an_answer_over_the_text_limit_is_a_crash() -> Result<(), Failed> {
        let outcome = read(
            &fault("too-much-text 2000"),
            TEXT,
            &Options {
                max_text_chars: 1000,
                ..short()
            },
        );
        check(matches!(outcome, Err(Refusal::Crashed(_))), || {
            format!("{outcome:?}")
        })?;
        parent_is_whole()
    }

    pub(super) fn a_child_that_closes_stdin_early_does_not_hold_the_parent() -> Result<(), Failed> {
        let mut bytes = fault("close-stdin");
        bytes.resize(20 * MIB as usize, b'x');
        let started = Instant::now();
        let outcome = read(&bytes, TEXT, &short());
        check(started.elapsed() < Duration::from_secs(1), || {
            format!("took {:?}", started.elapsed())
        })?;
        check(matches!(outcome, Err(Refusal::Crashed(_))), || {
            format!("{outcome:?}")
        })?;
        parent_is_whole()
    }

    fn over_memory(name: &str) -> Result<(), Failed> {
        let limit = 256 * MIB;
        let options = Options {
            max_memory_bytes: limit,
            time_limit: Duration::from_secs(10),
            ..Options::default()
        };
        let started = Instant::now();
        let outcome = read(&fault(name), TEXT, &options);
        println!("{name}: {outcome:?} after {:?}", started.elapsed());
        check(matches!(outcome, Err(Refusal::OverLimit(_))), || {
            format!("{outcome:?}")
        })?;
        parent_is_whole()
    }

    pub(super) fn memory_over_the_limit_is_over_limit() -> Result<(), Failed> {
        over_memory("eat-memory")
    }

    pub(super) fn a_rust_allocation_that_fails_is_over_limit() -> Result<(), Failed> {
        over_memory("rust-alloc-fails")
    }

    #[cfg(feature = "native")]
    pub(super) fn a_cpp_allocation_that_fails_is_over_limit() -> Result<(), Failed> {
        over_memory("cpp-new-fails")
    }

    fn report() -> Result<String, Failed> {
        Ok(read(&fault("report"), TEXT, &short())
            .map_err(|refusal| refusal.to_string())?
            .text)
    }

    fn word<'a>(report: &'a str, name: &str) -> Result<&'a str, Failed> {
        report
            .split_ascii_whitespace()
            .find_map(|word| word.strip_prefix(name)?.strip_prefix('='))
            .ok_or_else(|| format!("no {name} in {report}").into())
    }

    /// The witnesses are this process: it holds the variable and the descriptor, so a
    /// child that kept what it inherited would show them.
    pub(super) fn a_child_holds_only_what_it_was_given() -> Result<(), Failed> {
        // SAFETY: tests run one at a time, and nothing else here reads the environment.
        unsafe { std::env::set_var("MARFA_NOT_FOR_A_CHILD", "secret") };
        let file = tempfile::tempfile().map_err(|error| error.to_string())?;
        // SAFETY: clears the close-on-exec flag of a descriptor this test owns.
        let inheritable = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, 0) };
        check(inheritable == 0, || "the witness descriptor".into())?;

        let report = report()?;
        println!("{report}");
        // SAFETY: as above.
        unsafe { std::env::remove_var("MARFA_NOT_FOR_A_CHILD") };

        check(word(&report, "descriptors")? == "0,1,2", || report.clone())?;
        // CoreFoundation, when linked, sets this one in its own process as it starts.
        let inherited = word(&report, "environment")?
            .split(',')
            .filter(|name| !name.is_empty() && *name != "__CF_USER_TEXT_ENCODING")
            .count();
        check(inherited == 0, || report.clone())?;
        // The sandbox on macOS refuses `getcwd` itself.
        if cfg!(target_os = "linux") {
            check(word(&report, "directory")? == "/", || report.clone())?;
        }
        check(word(&report, "core")? == "0/0", || report.clone())?;
        check(word(&report, "fsize")? == "0/0", || report.clone())?;
        check(word(&report, "nofile")? == "16/16", || report.clone())?;
        let cpu = word(&report, "cpu")?;
        let (soft, hard) = cpu.split_once('/').ok_or("a limit")?;
        check(
            soft.parse::<u64>().is_ok_and(|seconds| seconds <= 4),
            || format!("processor limit {cpu}"),
        )?;
        check(
            hard.parse::<u64>().is_ok_and(|seconds| seconds <= 5),
            || format!("processor limit {cpu}"),
        )?;
        if cfg!(target_os = "linux") {
            check(word(&report, "no_new_privs")? == "1", || report.clone())?;
            let space = word(&report, "as")?;
            check(!space.contains("18446744073709551615"), || {
                format!("no address space limit: {space}")
            })?;
        }
        Ok(())
    }

    fn sandbox_of(name: &str) -> Result<(String, Sandbox), Failed> {
        let reading = read(&fault(name), TEXT, &short()).map_err(|refusal| refusal.to_string())?;
        Ok((reading.text, reading.sandbox))
    }

    /// A kernel with no sandbox still reads, and has to say so: the file then opens,
    /// which is the same fact seen from the other side.
    fn refused_when_sandboxed(what: &str, name: &str, unconfined: &str) -> Result<(), Failed> {
        let (text, sandbox) = sandbox_of(name)?;
        println!("{what}: {sandbox:?}: {text}");
        match sandbox {
            Sandbox::Full => check(text.starts_with("refused") || text.contains("Err"), || {
                format!("{what}: {text}")
            }),
            Sandbox::Partial | Sandbox::Off => check(
                text.contains(unconfined) || text.starts_with("refused"),
                || format!("{what}: {text}"),
            ),
        }
    }

    pub(super) fn a_child_cannot_open_a_file_it_should_not() -> Result<(), Failed> {
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let secret = folder.path().join("owner.db");
        std::fs::write(&secret, "the owner's data").map_err(|error| error.to_string())?;
        let mut witness = String::new();
        std::fs::File::open(&secret)
            .and_then(|mut file| file.read_to_string(&mut witness))
            .map_err(|error| error.to_string())?;
        check(!witness.is_empty(), || "the witness read nothing".into())?;
        let path = secret.to_str().ok_or("a path")?;
        refused_when_sandboxed("open", &format!("open {path}"), "opened")?;
        refused_when_sandboxed("open /etc/passwd", "open /etc/passwd", "opened")
    }

    pub(super) fn a_child_can_open_the_data_folder() -> Result<(), Failed> {
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        // The path that reached the child is the real one, as `read` resolves it.
        let real = folder.path().canonicalize().map_err(|e| e.to_string())?;
        let model = real.join("a.traineddata");
        std::fs::write(&model, "x").map_err(|error| error.to_string())?;
        let options = Options {
            ocr: Some(marfa_enrichment::OcrOptions {
                languages: "eng".into(),
                data_dir: Some(folder.path().to_owned()),
            }),
            ..short()
        };
        let name = format!("open {}", model.to_str().ok_or("a path")?);
        let reading = read(&fault(&name), TEXT, &options).map_err(|r| r.to_string())?;
        check(reading.text == "opened", || format!("{reading:?}"))
    }

    /// The path holds what would end a string in the macOS profile.
    pub(super) fn a_data_folder_with_a_quote_in_its_name_still_sandboxes() -> Result<(), Failed> {
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let dir = folder.path().join("a\"b\\c");
        std::fs::create_dir(&dir).map_err(|error| error.to_string())?;
        let real = dir.canonicalize().map_err(|error| error.to_string())?;
        let model = real.join("a.traineddata");
        std::fs::write(&model, "x").map_err(|error| error.to_string())?;
        let options = Options {
            ocr: Some(marfa_enrichment::OcrOptions {
                languages: "eng".into(),
                data_dir: Some(dir),
            }),
            ..short()
        };
        let name = format!("open {}", model.to_str().ok_or("a path")?);
        let reading = read(&fault(&name), TEXT, &options).map_err(|r| r.to_string())?;
        check(reading.text == "opened", || format!("{reading:?}"))?;
        let denied = read(&fault("open /etc/passwd"), TEXT, &options)
            .map_err(|refusal| refusal.to_string())?;
        check(
            denied.sandbox != Sandbox::Full || denied.text.starts_with("refused"),
            || format!("{denied:?}"),
        )
    }

    pub(super) fn a_child_cannot_write_a_file() -> Result<(), Failed> {
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let path = folder.path().join("left-behind");
        let name = format!("write-file {}", path.to_str().ok_or("a path")?);
        // RLIMIT_FSIZE ends a process that writes, so a crash by SIGXFSZ is as good as
        // the sandbox's refusal. Either way nothing is written.
        let outcome = read(&fault(&name), TEXT, &short());
        println!("write: {outcome:?}");
        let written = std::fs::read(&path).unwrap_or_default();
        check(written.is_empty(), || "the child wrote a file".into())
    }

    pub(super) fn a_child_cannot_connect() -> Result<(), Failed> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        std::net::TcpStream::connect(address).map_err(|error| error.to_string())?;
        refused_when_sandboxed("connect", &format!("connect {address}"), "connected")
    }

    pub(super) fn a_child_that_is_not_root_cannot_fork() -> Result<(), Failed> {
        let (text, _) = sandbox_of("fork")?;
        println!("fork: {text}");
        // SAFETY: a plain query.
        let root = unsafe { libc::getuid() } == 0;
        if cfg!(target_os = "linux") && root {
            return Ok(());
        }
        check(text.starts_with("refused"), || text.clone())
    }

    /// A parent that dies does not leave a reader running.
    pub(super) fn a_child_ends_when_its_parent_dies() -> Result<(), Failed> {
        let folder = tempfile::tempdir().map_err(|error| error.to_string())?;
        let file = folder.path().join("hang.txt");
        std::fs::write(&file, fault("hang")).map_err(|error| error.to_string())?;
        let mut parent = Command::new(env!("CARGO_BIN_EXE_marfa-enrichment-read"))
            .args(["read", file.to_str().ok_or("a path")?, "--time-limit", "60"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let parent_id = i32::try_from(parent.id()).map_err(|error| error.to_string())?;
        let started = Instant::now();
        let child = loop {
            if let Some(child) = child_of(parent_id) {
                break child;
            }
            check(started.elapsed() < Duration::from_secs(5), || {
                "the reader did not start".into()
            })?;
            std::thread::sleep(Duration::from_millis(5));
        };
        // It has to be past its setup, or stdin's close says nothing of the watchdog.
        std::thread::sleep(Duration::from_millis(200));
        check(is_running(child), || "the witness: it runs".into())?;
        parent.kill().map_err(|error| error.to_string())?;
        parent.wait().map_err(|error| error.to_string())?;

        let killed = Instant::now();
        while is_running(child) {
            check(killed.elapsed() < Duration::from_secs(2), || {
                "the reader outlived its parent".into()
            })?;
            std::thread::sleep(Duration::from_millis(5));
        }
        println!("ended {:?} after its parent", killed.elapsed());
        Ok(())
    }

    /// Whether the process exists and has not ended. A zombie waiting for init has
    /// ended, though `kill` would still find it.
    fn is_running(pid: i32) -> bool {
        // SAFETY: signal 0 delivers nothing.
        unsafe { libc::kill(pid, 0) == 0 && !is_zombie(pid) }
    }

    #[cfg(target_os = "linux")]
    fn is_zombie(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
            stat.rsplit(')')
                .next()
                .is_some_and(|rest| rest.trim_start().starts_with('Z'))
        })
    }

    #[cfg(target_os = "macos")]
    fn is_zombie(pid: i32) -> bool {
        const SZOMB: u32 = 5;
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = i32::try_from(size_of::<libc::proc_bsdinfo>()).expect("a small struct");
        // SAFETY: the buffer is the size of the flavor asked for.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        // A process whose information is gone has been reaped.
        // SAFETY: when the whole buffer was written its integers are valid.
        written != size || unsafe { info.assume_init() }.pbi_status == SZOMB
    }

    #[cfg(target_os = "linux")]
    fn child_of(parent: i32) -> Option<i32> {
        let entries = std::fs::read_dir("/proc").ok()?;
        entries.flatten().find_map(|entry| {
            let pid: i32 = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            let fields = stat.rsplit(')').next()?;
            let ppid: i32 = fields.split_ascii_whitespace().nth(1)?.parse().ok()?;
            (ppid == parent).then_some(pid)
        })
    }

    #[cfg(target_os = "macos")]
    fn child_of(parent: i32) -> Option<i32> {
        let mut pids = [0i32; 8];
        let size = i32::try_from(size_of_val(&pids)).expect("a small array");
        // SAFETY: the buffer holds `size` bytes.
        let found = unsafe { libc::proc_listchildpids(parent, pids.as_mut_ptr().cast(), size) };
        (found > 0).then_some(pids[0])
    }
}

fn main() {
    serve_child_if_asked();

    match std::env::var(SCENARIO).as_deref() {
        Ok("replaced") => return replaced(),
        Ok("removed") => return removed(),
        _ => {}
    }

    let mut arguments = Arguments::from_args();
    arguments.test_threads = Some(1);
    let mut trials: Vec<(&str, Test)> = vec![
        ("reads_text", reads_text),
        ("reads_an_image_size", reads_an_image_size),
        (
            "an_empty_file_reads_as_nothing",
            an_empty_file_reads_as_nothing,
        ),
        (
            "twenty_mebibytes_cross_the_pipe",
            twenty_mebibytes_cross_the_pipe,
        ),
        (
            "the_text_limit_holds_across_the_pipe",
            the_text_limit_holds_across_the_pipe,
        ),
        (
            "what_the_call_decides_starts_no_child",
            what_the_call_decides_starts_no_child,
        ),
        (
            "two_hundred_reads_eight_at_a_time",
            two_hundred_reads_eight_at_a_time,
        ),
        ("the_program_replaced_on_disk", the_program_replaced_on_disk),
        (
            "the_program_removed_from_disk",
            the_program_removed_from_disk,
        ),
        (
            "the_program_prints_what_it_read",
            the_program_prints_what_it_read,
        ),
        (
            "the_program_exits_non_zero_on_a_refusal",
            the_program_exits_non_zero_on_a_refusal,
        ),
        (
            "a_child_started_by_hand_reads_nothing",
            a_child_started_by_hand_reads_nothing,
        ),
    ];
    #[cfg(not(feature = "native"))]
    trials.push((
        "a_pdf_without_native_is_unsupported",
        a_pdf_without_native_is_unsupported,
    ));
    #[cfg(feature = "native")]
    trials.extend([
        ("reads_a_picture", native::reads_a_picture as Test),
        (
            "an_encrypted_pdf_is_named",
            native::an_encrypted_pdf_is_named,
        ),
        ("reads_a_text_pdf", native::reads_a_text_pdf),
        ("reads_a_scanned_pdf", native::reads_a_scanned_pdf),
        (
            "a_damaged_pdf_is_malformed",
            native::a_damaged_pdf_is_malformed,
        ),
        (
            "a_language_cannot_name_a_path",
            native::a_language_cannot_name_a_path,
        ),
        (
            "a_model_in_the_data_folder_loads_inside_the_sandbox",
            native::a_model_in_the_data_folder_loads_inside_the_sandbox,
        ),
        (
            "a_link_in_the_data_folder_does_not_leave_it",
            native::a_link_in_the_data_folder_does_not_leave_it,
        ),
    ]);
    #[cfg(feature = "fault-injection")]
    trials.extend([
        (
            "a_segfault_is_a_crash_named_by_its_signal",
            faults::a_segfault_is_a_crash_named_by_its_signal as Test,
        ),
        (
            "an_abort_is_a_crash_named_by_its_signal",
            faults::an_abort_is_a_crash_named_by_its_signal,
        ),
        ("a_hang_times_out_on_time", faults::a_hang_times_out_on_time),
        ("a_spin_times_out_on_time", faults::a_spin_times_out_on_time),
        (
            "a_stderr_flood_times_out_on_time",
            faults::a_stderr_flood_times_out_on_time,
        ),
        (
            "an_orphan_holding_the_pipes_does_not_hold_the_parent",
            faults::an_orphan_holding_the_pipes_does_not_hold_the_parent,
        ),
        (
            "a_stdout_flood_is_a_crash_and_ends_early",
            faults::a_stdout_flood_is_a_crash_and_ends_early,
        ),
        ("garbage_is_a_crash", faults::garbage_is_a_crash),
        (
            "an_empty_answer_is_a_crash",
            faults::an_empty_answer_is_a_crash,
        ),
        (
            "an_answer_over_the_text_limit_is_a_crash",
            faults::an_answer_over_the_text_limit_is_a_crash,
        ),
        (
            "a_child_that_closes_stdin_early_does_not_hold_the_parent",
            faults::a_child_that_closes_stdin_early_does_not_hold_the_parent,
        ),
        (
            "memory_over_the_limit_is_over_limit",
            faults::memory_over_the_limit_is_over_limit,
        ),
        (
            "a_rust_allocation_that_fails_is_over_limit",
            faults::a_rust_allocation_that_fails_is_over_limit,
        ),
        (
            "a_child_holds_only_what_it_was_given",
            faults::a_child_holds_only_what_it_was_given,
        ),
        (
            "a_child_cannot_open_a_file_it_should_not",
            faults::a_child_cannot_open_a_file_it_should_not,
        ),
        (
            "a_child_can_open_the_data_folder",
            faults::a_child_can_open_the_data_folder,
        ),
        (
            "a_data_folder_with_a_quote_in_its_name_still_sandboxes",
            faults::a_data_folder_with_a_quote_in_its_name_still_sandboxes,
        ),
        (
            "a_child_cannot_write_a_file",
            faults::a_child_cannot_write_a_file,
        ),
        ("a_child_cannot_connect", faults::a_child_cannot_connect),
        (
            "a_child_that_is_not_root_cannot_fork",
            faults::a_child_that_is_not_root_cannot_fork,
        ),
        (
            "a_child_ends_when_its_parent_dies",
            faults::a_child_ends_when_its_parent_dies,
        ),
    ]);
    #[cfg(all(feature = "fault-injection", feature = "native"))]
    trials.push((
        "a_cpp_allocation_that_fails_is_over_limit",
        faults::a_cpp_allocation_that_fails_is_over_limit,
    ));

    let trials = trials
        .into_iter()
        .map(|(name, test)| Trial::test(name, test))
        .collect();
    libtest_mimic::run(&arguments, trials).exit();
}
