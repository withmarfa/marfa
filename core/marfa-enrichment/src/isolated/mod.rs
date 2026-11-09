//! Reads a file in a process of its own, because PDFium and Tesseract are C and C++ reading untrusted bytes.

#[cfg(target_os = "linux")]
mod calls;
mod child;
mod confine;
#[cfg(feature = "fault-injection")]
mod fault;
mod footprint;
mod parent;
mod wire;

use std::ffi::OsStr;
use std::fs::File;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::{Options, Reading, Refusal};

/// The first argument of a child: what tells a start of the program from a reader.
const CHILD_ARG: &str = "--marfa-enrichment-child";

/// A child that hit its memory limit in C++ ends with this, through the shim's
/// `new` handler.
const EXIT_OVER_MEMORY: i32 = 71;
/// A child's watchdog ended it at the deadline.
const EXIT_DEADLINE: i32 = 72;
/// A child found its parent gone.
const EXIT_PARENT_GONE: i32 = 73;
/// A child was started with arguments or a request it cannot read.
const EXIT_BAD_REQUEST: i32 = 74;

/// A child that could not confine itself ends with this before it reads the file.
const EXIT_NOT_CONFINED: i32 = 75;

/// Added to a signal's number, the exit code of a child on macOS that a signal would
/// have ended.
const EXIT_BY_SIGNAL: i32 = 128;

/// Where the program starts itself from, set by `serve_child_if_asked`. `None` inside
/// means that the call was made and the program could not find itself.
static PROGRAM: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Makes this program able to read files. Call it as the first line of `main`: in a
/// child it reads one file and never returns, and in any other start it returns at
/// once.
pub fn serve_child_if_asked() {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next().as_deref() == Some(OsStr::new(CHILD_ARG)) {
        child::serve(arguments);
    }
    PROGRAM.get_or_init(own_path);
}

/// Reads `file` by the MIME type `mime`, in a process of its own; its parameters and
/// letter case do not matter, but a `charset` parameter is read as a hint for text.
///
/// The file must be a regular file open for reading only, used for this reading alone.
///
/// This blocks until the child answers or `Options::time_limit` passes, so an async
/// caller runs it on a blocking thread. Several threads may call it at once.
///
/// # Panics
///
/// If the program did not call `serve_child_if_asked` first. Nothing is started or
/// read then.
pub fn read(file: &File, mime: &str, options: &Options) -> Result<Reading, Refusal> {
    let Some(program) = PROGRAM.get() else {
        panic!(
            "marfa_enrichment::read needs marfa_enrichment::serve_child_if_asked() as the \
             first line of the program's main"
        );
    };
    parent::read(program.as_ref(), file, mime, options)
}

/// `/proc/self/exe` opens the program that is running, so a new file installed over
/// it changes nothing. Without `/proc` the path the program was started by is what
/// is left.
#[cfg(target_os = "linux")]
fn own_path() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;

    let link = PathBuf::from("/proc/self/exe");
    if link.symlink_metadata().is_ok() {
        return Some(link);
    }
    // SAFETY: a nonzero AT_EXECFN points at a NUL-terminated string the kernel put
    // on this process's stack, which lives as long as the process.
    let name = unsafe {
        let name = libc::getauxval(libc::AT_EXECFN) as *const libc::c_char;
        if name.is_null() {
            return None;
        }
        CStr::from_ptr(name)
    };
    std::path::absolute(OsStr::from_bytes(name.to_bytes())).ok()
}

#[cfg(not(target_os = "linux"))]
fn own_path() -> Option<PathBuf> {
    std::env::current_exe().ok()
}
