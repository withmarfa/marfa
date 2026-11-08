//! The first and only process of the verify VM (native/vm.sh): reads /plan, runs each
//! line as the user it names, and writes what each run did to the serial console. It
//! is built apart from the crate, with plain `rustc` for x86_64-unknown-linux-musl.
//!
//! A plan line is tab-separated: user id, group id, the case's name, the program and
//! its arguments. The first line, `timeout <seconds>`, is how long one case may take.
//! Each answer is one line, `@@marfa-vm <name> <exit code> <milliseconds> <stdout> <stderr>`,
//! with both streams in hex: the console would turn each newline into two bytes, and
//! the host has to know the exact bytes the program wrote. An end by signal N is exit
//! code 128 + N, as in a shell.

use std::ffi::CString;
use std::io::{Read, Write};
use std::os::raw::{c_char, c_int, c_long, c_ulong, c_void};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

unsafe extern "C" {
    fn mount(
        source: *const c_char,
        target: *const c_char,
        fstype: *const c_char,
        flags: c_ulong,
        data: *const c_void,
    ) -> c_int;
    fn reboot(cmd: c_int) -> c_int;
    fn sync();
    fn syscall(number: c_long, ...) -> c_long;
    fn prctl(option: c_int, ...) -> c_int;
    fn setgroups(size: usize, list: *const u32) -> c_int;
    fn setgid(gid: u32) -> c_int;
    fn setuid(uid: u32) -> c_int;
}

const MS_RDONLY: c_ulong = 1;
const MS_REMOUNT: c_ulong = 32;
const MS_BIND: c_ulong = 4096;
const LINUX_REBOOT_CMD_POWER_OFF: c_int = 0x4321_fedc_u32 as c_int;
const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
const PR_GET_SECCOMP: c_int = 21;

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn c(text: &str) -> CString {
    CString::new(text).expect("no NUL in a path")
}

fn mount_fs(source: &str, target: &str, fstype: &str, flags: c_ulong, data: &str) {
    let (source, target, fstype, data) = (c(source), c(target), c(fstype), c(data));
    // SAFETY: four NUL-ended strings that outlive the call.
    let status = unsafe {
        mount(
            source.as_ptr(),
            target.as_ptr(),
            fstype.as_ptr(),
            flags,
            data.as_ptr().cast(),
        )
    };
    if status != 0 {
        say(&format!(
            "vm: mount {fstype:?} on {target:?} failed: {}",
            std::io::Error::last_os_error()
        ));
    }
}

/// Makes a folder read-only by binding it onto itself, which a root file system of
/// RAM cannot be.
fn read_only(folder: &str) {
    mount_fs(folder, folder, "", MS_BIND, "");
    mount_fs("", folder, "", MS_BIND | MS_REMOUNT | MS_RDONLY, "");
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}

fn first_line(path: &str, key: &str) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with(key))
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

/// Facts the report keeps about the machine the programs ran on.
fn describe_machine() {
    say(&format!(
        "vm: {}",
        std::fs::read_to_string("/proc/version")
            .unwrap_or_default()
            .trim()
    ));
    say(&format!(
        "vm: {}",
        first_line("/proc/cpuinfo", "model name")
    ));
    say(&format!("vm: {}", first_line("/proc/meminfo", "MemTotal")));
    // SAFETY: asks the kernel for the newest rule set it knows; touches nothing.
    let landlock = unsafe { syscall(SYS_LANDLOCK_CREATE_RULESET, 0, 0, 1) };
    say(&if landlock > 0 {
        format!("vm: Landlock ABI version {landlock}")
    } else {
        format!(
            "vm: Landlock is not available: {}",
            std::io::Error::last_os_error()
        )
    });
    // SAFETY: only asks whether the mode is supported.
    let seccomp = unsafe { prctl(PR_GET_SECCOMP) };
    say(&if seccomp >= 0 {
        "vm: seccomp is available".to_owned()
    } else {
        format!(
            "vm: seccomp is not available: {}",
            std::io::Error::last_os_error()
        )
    });
}

fn collect(mut pipe: impl Read + Send + 'static) -> (Arc<Mutex<Vec<u8>>>, thread::JoinHandle<()>) {
    let kept = Arc::new(Mutex::new(Vec::new()));
    let into = Arc::clone(&kept);
    let reader = thread::spawn(move || {
        let mut chunk = [0u8; 65536];
        while let Ok(read) = pipe.read(&mut chunk) {
            if read == 0 {
                break;
            }
            into.lock()
                .expect("the buffer")
                .extend_from_slice(&chunk[..read]);
        }
    });
    (kept, reader)
}

/// Runs one case and says how it ended.
fn run(line: &str, wait: Duration) {
    let mut fields = line.split('\t');
    let (Some(uid), Some(gid), Some(name), Some(program)) = (
        fields.next().and_then(|field| field.parse::<u32>().ok()),
        fields.next().and_then(|field| field.parse::<u32>().ok()),
        fields.next(),
        fields.next(),
    ) else {
        say(&format!("vm: a plan line is not one: {line:?}"));
        return;
    };
    let mut command = Command::new(program);
    command
        .args(fields)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: only calls that change this process's identity, in the child before exec.
    unsafe {
        command.pre_exec(move || {
            if setgroups(0, std::ptr::null()) != 0 || setgid(gid) != 0 || setuid(uid) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let started = Instant::now();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("vm: could not start {program}: {error}");
            say(&format!(
                "@@marfa-vm {name} 127 0 {} {}",
                "",
                hex(message.as_bytes())
            ));
            return;
        }
    };
    let (stdout, out_reader) = collect(child.stdout.take().expect("piped"));
    let (stderr, err_reader) = collect(child.stderr.take().expect("piped"));
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break status
                    .code()
                    .or_else(|| status.signal().map(|signal| 128 + signal))
                    .unwrap_or(255);
            }
            Ok(None) if started.elapsed() > wait => {
                let _ = child.kill();
                let _ = child.wait();
                stderr
                    .lock()
                    .expect("the buffer")
                    .extend_from_slice(b"\nvm: the case passed its time and was killed\n");
                break 124;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => break 255,
        }
    };
    // A program that left something running holds its pipes open; what it wrote by
    // now is what counts.
    let readers_wait = Instant::now();
    while !(out_reader.is_finished() && err_reader.is_finished())
        && readers_wait.elapsed() < Duration::from_secs(5)
    {
        thread::sleep(Duration::from_millis(10));
    }
    let out = stdout.lock().expect("the buffer").clone();
    let err = stderr.lock().expect("the buffer").clone();
    say(&format!(
        "@@marfa-vm {name} {code} {} {} {}",
        started.elapsed().as_millis(),
        hex(&out),
        hex(&err)
    ));
}

fn main() {
    mount_fs("proc", "/proc", "proc", 0, "");
    mount_fs("devtmpfs", "/dev", "devtmpfs", 0, "");
    // The one place a program may write, for the faults that try to.
    mount_fs("tmpfs", "/scratch", "tmpfs", 0, "mode=1777,size=64m");
    read_only("/files");
    read_only("/models");
    say("vm: init started");
    describe_machine();

    let plan = std::fs::read_to_string("/plan").unwrap_or_default();
    let mut lines = plan.lines();
    let wait = lines
        .next()
        .and_then(|line| line.strip_prefix("timeout "))
        .and_then(|seconds| seconds.parse().ok())
        .map_or(Duration::from_secs(1800), Duration::from_secs);
    let mut count = 0;
    for line in lines.filter(|line| !line.is_empty()) {
        run(line, wait);
        count += 1;
    }
    say(&format!("@@marfa-vm-done {count}"));
    // SAFETY: flushes and powers the machine off; nothing runs after it.
    unsafe {
        sync();
        reboot(LINUX_REBOOT_CMD_POWER_OFF);
    }
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}
