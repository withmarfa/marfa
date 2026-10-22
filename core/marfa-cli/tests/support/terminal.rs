//! Runs the `marfa` binary with chosen standard streams attached to a
//! pseudo-terminal, so a test can see what a person at a terminal would see.

use std::fs::File;
use std::io::Read as _;
use std::os::fd::{FromRawFd, OwnedFd};
use std::process::{Command, Stdio};

pub struct Ran {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Ran {
    pub fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn terminal() -> (File, OwnedFd) {
    let (mut master, mut slave) = (0, 0);
    // SAFETY: both descriptors are written by `openpty` on success and
    // owned by the values made from them.
    unsafe {
        assert_eq!(
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut()
            ),
            0,
            "no pseudo-terminal"
        );
        (File::from_raw_fd(master), OwnedFd::from_raw_fd(slave))
    }
}

fn drain(mut master: File) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    // The read ends with an error once the slave is closed everywhere.
    while let Ok(read) = master.read(&mut buffer) {
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    bytes
}

/// Runs `command` with standard output on a terminal where `stdout_tty` is
/// set, and standard error on one where `stderr_tty` is set; the other is a
/// pipe. Standard input is empty. Each is read apart.
pub fn run(command: &mut Command, stdout_tty: bool, stderr_tty: bool) -> Ran {
    run_holding(command, stdout_tty, stderr_tty, &std::sync::Mutex::new(()))
}

/// `run`, taking `lock` for the moment of the spawn alone, for a test file
/// that must not spawn while another thread makes a socket.
pub fn run_holding(
    command: &mut Command,
    stdout_tty: bool,
    stderr_tty: bool,
    lock: &std::sync::Mutex<()>,
) -> Ran {
    command.stdin(Stdio::null());
    let out = stdout_tty.then(terminal);
    let err = stderr_tty.then(terminal);
    match &out {
        Some((_, slave)) => command.stdout(slave.try_clone().unwrap()),
        None => command.stdout(Stdio::piped()),
    };
    match &err {
        Some((_, slave)) => command.stderr(slave.try_clone().unwrap()),
        None => command.stderr(Stdio::piped()),
    };
    let mut child = {
        let _held = lock.lock().unwrap();
        command.spawn().unwrap()
    };
    // The builder holds its copies of the slaves too.
    command.stdout(Stdio::null()).stderr(Stdio::null());
    // The command holds its copies of the slaves; ours must go, or the
    // masters never see the end.
    let out = out.map(|(master, _)| master);
    let err = err.map(|(master, _)| master);
    let read_out = out.map(|master| std::thread::spawn(move || drain(master)));
    let read_err = err.map(|master| std::thread::spawn(move || drain(master)));
    let mut piped_out = child.stdout.take();
    let mut piped_err = child.stderr.take();
    let piped = std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut err = Vec::new();
        if let Some(pipe) = piped_out.as_mut() {
            pipe.read_to_end(&mut out).unwrap();
        }
        if let Some(pipe) = piped_err.as_mut() {
            pipe.read_to_end(&mut err).unwrap();
        }
        (out, err)
    });
    let status = child.wait().unwrap();
    let (piped_out, piped_err) = piped.join().unwrap();
    Ran {
        code: status.code().unwrap(),
        stdout: read_out.map_or(piped_out, |read| read.join().unwrap()),
        stderr: read_err.map_or(piped_err, |read| read.join().unwrap()),
    }
}
