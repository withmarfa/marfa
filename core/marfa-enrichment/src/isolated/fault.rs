//! Faults on demand, for proving that the parent survives them. A file that starts
//! with `MARK`, then a fault's name, makes the child misbehave in that way. The feature
//! is never on in a shipped program; `build.rs` stops a release build that has it.

use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use super::confine::LimitKind;

const MARK: &[u8] = b"MARFA-ENRICHMENT-FAULT:";

/// The longest fault, in bytes. What follows a name on its first line is its argument.
const OPENING: usize = 256;

#[cfg(feature = "native")]
unsafe extern "C" {
    fn marfa_fault_new_fails();
}

fn parse(bytes: &[u8]) -> Option<(&str, &str)> {
    let rest = bytes.strip_prefix(MARK)?;
    let line = rest.split(|byte| *byte == b'\n').next()?;
    let line = std::str::from_utf8(line).ok()?;
    Some(line.split_once(' ').unwrap_or((line, "")))
}

/// Reads the start of the file. The one fault that cannot wait for the rest of it
/// happens here. Returns how much was read.
pub(super) fn read_opening(stdin: &mut File, bytes: &mut [u8]) -> usize {
    let len = bytes.len().min(OPENING);
    if stdin.read_exact(&mut bytes[..len]).is_err() {
        // SAFETY: ends the process.
        unsafe { libc::_exit(super::EXIT_PARENT_GONE) };
    }
    if let Some(("close-stdin", _)) = parse(&bytes[..len]) {
        // SAFETY: descriptor 0 is the pipe from the parent, and nothing reads it now.
        unsafe { libc::close(0) };
        std::thread::sleep(Duration::from_millis(200));
        // SAFETY: ends the process.
        unsafe { libc::_exit(0) };
    }
    len
}

/// Does what the marked bytes ask. A probe gives back the text to answer with.
pub(super) fn act(bytes: &Result<Vec<u8>, crate::Refusal>) -> Option<String> {
    let (fault, argument) = parse(bytes.as_ref().ok()?)?;
    match fault {
        "segfault" => {
            // SAFETY: not safe at all. Writing to address 1 is the fault.
            unsafe { std::ptr::write_volatile(std::ptr::dangling_mut::<u8>(), 1) };
            None
        }
        "abort" => std::process::abort(),
        "stack-overflow" => Some(deeper(0).to_string()),
        "hang" => loop {
            std::thread::sleep(Duration::from_secs(3600));
        },
        "spin" => loop {
            std::hint::spin_loop();
        },
        "eat-memory" => eat_memory(),
        "rust-alloc-fails" => {
            let size = 1usize << 62;
            let layout = std::alloc::Layout::from_size_align(size, 1).expect("a valid layout");
            // SAFETY: the layout has a size. The allocation is meant to fail.
            let pointer = std::hint::black_box(unsafe { std::alloc::alloc(layout) });
            // A release build removes an allocation whose result is only compared with
            // null, so the pointer is used where the optimizer cannot see it.
            if pointer.is_null() {
                fail(layout);
            }
            // SAFETY: a pointer from `alloc` for a layout of at least one byte.
            unsafe { std::ptr::write_volatile(pointer, 1) };
            None
        }
        #[cfg(feature = "native")]
        "cpp-new-fails" => {
            // SAFETY: takes nothing, and ends the process through the `new` handler.
            unsafe { marfa_fault_new_fails() };
            None
        }
        "flood-stdout" => flood(&mut std::io::stdout()),
        "flood-stderr" => flood(&mut std::io::stderr()),
        "garbage" => say(b"{\"reading\": not json at all\xff\xfe"),
        "silent" => {
            // SAFETY: ends the process.
            unsafe { libc::_exit(0) }
        }
        "too-much-text" => {
            let text = "x".repeat(argument.parse().unwrap_or(1_000));
            let answer = serde_json::json!({"reading": {"text": text, "truncated": false,
                "cut_short": false, "size": null, "text_refused": null}});
            say(answer.to_string().as_bytes())
        }
        "say" => say(argument.as_bytes()),
        "exit" => {
            // SAFETY: ends the process.
            unsafe { libc::_exit(argument.parse().unwrap_or(0)) }
        }
        "signal" => {
            // SAFETY: sends a signal to this process.
            unsafe { libc::raise(argument.parse().unwrap_or(0)) };
            std::thread::sleep(Duration::from_secs(1));
            None
        }
        "write-file" => {
            let outcome = std::fs::write(argument, b"x");
            Some(format!("{outcome:?}"))
        }
        "open" => Some(match File::open(argument) {
            Ok(_) => "opened".to_owned(),
            Err(error) => format!("refused: {error}"),
        }),
        "connect" => Some(match argument.parse::<SocketAddr>() {
            Ok(address) => match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
                Ok(_) => "connected".to_owned(),
                Err(error) => format!("refused: {error}"),
            },
            Err(error) => format!("bad address: {error}"),
        }),
        "udp" => Some(match UdpSocket::bind("127.0.0.1:0") {
            Ok(socket) => match socket.send_to(b"x", argument) {
                Ok(_) => "sent".to_owned(),
                Err(error) => format!("refused: {error}"),
            },
            Err(error) => format!("refused: {error}"),
        }),
        "unix" => Some(match UnixStream::connect(argument) {
            Ok(_) => "connected".to_owned(),
            Err(error) => format!("refused: {error}"),
        }),
        "chmod" => Some(
            match std::fs::set_permissions(argument, std::fs::Permissions::from_mode(0o000)) {
                Ok(()) => "changed".to_owned(),
                Err(error) => format!("refused: {error}"),
            },
        ),
        "chown" => Some(said(
            // SAFETY: the path is a NUL-terminated string for the length of the call.
            unsafe { libc::chown(path(argument).as_ptr(), libc::getuid(), libc::getgid()) },
        )),
        "utimes" => Some(said(
            // SAFETY: as above, and a null `times` means now.
            unsafe { libc::utimes(path(argument).as_ptr(), std::ptr::null()) },
        )),
        #[cfg(target_os = "linux")]
        "setxattr" => Some(said(
            // SAFETY: the name and the value are valid for the length of the call.
            unsafe {
                libc::setxattr(
                    path(argument).as_ptr(),
                    c"user.marfa".as_ptr(),
                    c"x".as_ptr().cast(),
                    1,
                    0,
                )
            },
        )),
        "execve" => {
            let script = format!("echo ran > {argument}");
            let script = std::ffi::CString::new(script).expect("a path without a NUL");
            let arguments = [
                c"sh".as_ptr(),
                c"-c".as_ptr(),
                script.as_ptr(),
                std::ptr::null(),
            ];
            let environment = [std::ptr::null()];
            // SAFETY: both lists end in a null, and the strings outlive the call.
            unsafe {
                libc::execve(
                    c"/bin/sh".as_ptr(),
                    arguments.as_ptr(),
                    environment.as_ptr(),
                )
            };
            Some(format!("refused: {}", std::io::Error::last_os_error()))
        }
        "kill" => Some(said(
            // SAFETY: a signal to the process the test named.
            unsafe { libc::kill(argument.parse().unwrap_or(0), libc::SIGTERM) },
        )),
        "fork" => {
            // SAFETY: the child side only ends itself.
            let pid = unsafe { libc::fork() };
            match pid {
                0 => {
                    // SAFETY: ends the process.
                    unsafe { libc::_exit(0) }
                }
                pid if pid > 0 => Some("forked".to_owned()),
                _ => Some(format!("refused: {}", std::io::Error::last_os_error())),
            }
        }
        "orphan" => {
            // SAFETY: the new process holds stdout and sleeps, and does nothing else.
            let pid = unsafe { libc::fork() };
            if pid == 0 {
                std::thread::sleep(Duration::from_secs(3600));
            }
            eprintln!("orphan {pid}");
            // SAFETY: ends the process, and the other one keeps the pipes open.
            unsafe { libc::_exit(0) }
        }
        "stopped" => {
            // SAFETY: stops every thread here, the watchdog with them.
            unsafe { libc::raise(libc::SIGSTOP) };
            None
        }
        "report" => Some(report()),
        _ => None,
    }
}

/// Writes `bytes` as all the child has to say, and ends.
fn say(bytes: &[u8]) -> ! {
    let _ = std::io::stdout().write_all(bytes);
    let _ = std::io::stdout().flush();
    // SAFETY: ends the process.
    unsafe { libc::_exit(0) }
}

fn path(argument: &str) -> std::ffi::CString {
    std::ffi::CString::new(Path::new(argument).as_os_str().as_bytes()).expect("no NUL in a path")
}

/// What a libc call's result means, in the words the tests read.
fn said(result: libc::c_int) -> String {
    if result == 0 {
        "done".to_owned()
    } else {
        format!("refused: {}", std::io::Error::last_os_error())
    }
}

fn deeper(depth: u64) -> u64 {
    if depth == u64::MAX {
        return 0;
    }
    let frame = std::hint::black_box([depth; 512]);
    deeper(std::hint::black_box(depth + 1)) + frame[1]
}

fn fail(layout: std::alloc::Layout) -> ! {
    std::alloc::handle_alloc_error(layout)
}

/// Fills memory for as long as it is given.
fn eat_memory() -> ! {
    const CHUNK: usize = 16 * 1024 * 1024;
    let mut held: Vec<Vec<u8>> = Vec::new();
    loop {
        held.push(vec![1u8; CHUNK]);
    }
}

fn flood(out: &mut impl Write) -> ! {
    let chunk = [b'x'; 64 * 1024];
    loop {
        if out.write_all(&chunk).is_err() {
            // SAFETY: ends the process.
            unsafe { libc::_exit(0) };
        }
    }
}

/// What the child holds, for the tests to judge: `name=value` words.
fn report() -> String {
    let mut words = Vec::new();
    for (name, resource) in limits() {
        let mut limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: `limit` is a valid buffer.
        unsafe { libc::getrlimit(resource, &raw mut limit) };
        words.push(format!("{name}={}/{}", limit.rlim_cur, limit.rlim_max));
    }
    let open: Vec<String> = (0..1024)
        // SAFETY: F_GETFD only reads a descriptor's flags.
        .filter(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } >= 0)
        .map(|fd: libc::c_int| fd.to_string())
        .collect();
    words.push(format!("descriptors={}", open.join(",")));
    let variables: Vec<String> = std::env::vars_os()
        .map(|(name, _)| name.to_string_lossy().into_owned())
        .collect();
    words.push(format!("environment={}", variables.join(",")));
    let directory = std::env::current_dir()
        .map_or_else(|error| error.to_string(), |dir| dir.display().to_string());
    words.push(format!("directory={directory}"));
    #[cfg(target_os = "linux")]
    {
        // SAFETY: this prctl takes no pointer.
        let flag = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) };
        words.push(format!("no_new_privs={flag}"));
    }
    words.join(" ")
}

#[cfg(target_os = "linux")]
fn limits() -> [(&'static str, LimitKind); 5] {
    [
        ("core", libc::RLIMIT_CORE),
        ("cpu", libc::RLIMIT_CPU),
        ("fsize", libc::RLIMIT_FSIZE),
        ("nofile", libc::RLIMIT_NOFILE),
        ("as", libc::RLIMIT_AS),
    ]
}

#[cfg(not(target_os = "linux"))]
fn limits() -> [(&'static str, LimitKind); 4] {
    [
        ("core", libc::RLIMIT_CORE),
        ("cpu", libc::RLIMIT_CPU),
        ("fsize", libc::RLIMIT_FSIZE),
        ("nofile", libc::RLIMIT_NOFILE),
    ]
}
