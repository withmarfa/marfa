//! Profiles: named servers, each with the place its key comes from, which a
//! person writes by hand in `profiles.toml` and picks with `--profile` or
//! `MARFA_PROFILE`. Not the owner's profile that `marfa profile` changes.

use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::error::CliError;

pub const FILE_NAME: &str = "profiles.toml";
pub const ENVIRONMENT: &str = "MARFA_PROFILE";

/// A file of profiles is a few lines for each server.
const FILE_LIMIT: u64 = 64 * 1024;

/// The most a key command may print. A key or a token is far shorter.
pub const KEY_LIMIT: usize = 16 * 1024;

/// How long a key command may run before it is stopped with everything it
/// started.
pub const KEY_COMMAND_LIMIT: Duration = Duration::from_secs(60);

/// How long the output of a key command that has exited is still read. A
/// process it started may hold the output open long after it.
const OUTPUT_GRACE: Duration = Duration::from_millis(250);

/// The most of a failed key command's last line of stderr a refusal shows.
const STDERR_SHOWN: usize = 200;

/// What a key command printed on stderr is kept only this far back.
const STDERR_KEPT: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChosenBy {
    Flag,
    Environment,
}

/// The profile a command line or `MARFA_PROFILE` names. The file is read the
/// first time a command asks for its server, so a command that asks for none
/// runs even when the file is missing or wrong.
#[derive(Clone)]
pub struct Chosen {
    pub name: String,
    pub by: ChosenBy,
    loaded: Arc<OnceLock<Result<Arc<Profile>, String>>>,
}

impl std::fmt::Debug for Chosen {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Chosen")
            .field("name", &self.name)
            .field("by", &self.by)
            .finish_non_exhaustive()
    }
}

impl Chosen {
    pub fn new(name: String, by: ChosenBy) -> Chosen {
        Chosen {
            name,
            by,
            loaded: Arc::new(OnceLock::new()),
        }
    }

    /// `MARFA_PROFILE`, where it is set and not empty.
    pub fn from_environment() -> Option<Chosen> {
        std::env::var(ENVIRONMENT)
            .ok()
            .filter(|name| !name.is_empty())
            .map(|name| Chosen::new(name, ChosenBy::Environment))
    }

    pub fn profile(&self) -> Result<Arc<Profile>, CliError> {
        self.loaded
            .get_or_init(|| self.load())
            .clone()
            .map_err(CliError::Usage)
    }

    fn load(&self) -> Result<Arc<Profile>, String> {
        if self.by == ChosenBy::Environment {
            let beside: Vec<&str> = ["MARFA_API_URL", "MARFA_API_KEY"]
                .into_iter()
                .filter(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()))
                .collect();
            if !beside.is_empty() {
                return Err(format!(
                    "{ENVIRONMENT} cannot be combined with {}: unset one of them, or pass --profile, --url or --key, which take precedence over all three",
                    beside.join(" or ")
                ));
            }
        }
        let path = path()?;
        let text = read(&path)?;
        let profile = parse(&path, &text, &self.name)?;
        crate::writing::chosen(&profile.origin, &profile.name);
        Ok(Arc::new(profile))
    }
}

/// A key, kept out of every `Debug` and message.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(..)")
    }
}

pub enum KeySource {
    /// The credential the keychain keeps for the profile's server.
    Keychain,
    /// The output of a program, run without a shell.
    Command(Vec<String>),
}

pub struct Profile {
    pub name: String,
    pub url: String,
    pub origin: String,
    pub key: KeySource,
    ran: OnceLock<Result<Secret, String>>,
}

impl std::fmt::Debug for Profile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Profile")
            .field("name", &self.name)
            .field("origin", &self.origin)
            .field("key_command", &self.program())
            .finish_non_exhaustive()
    }
}

impl Profile {
    pub fn has_key_command(&self) -> bool {
        matches!(self.key, KeySource::Command(_))
    }

    /// The program a key command runs, which is all a message names of it.
    pub fn program(&self) -> Option<&str> {
        match &self.key {
            KeySource::Command(argv) => argv.first().map(String::as_str),
            KeySource::Keychain => None,
        }
    }

    /// The key command's key, run the first time it is asked for and never
    /// again in this run, whatever it answered. `None` for a profile whose key
    /// is in the keychain.
    pub fn key_from_command(&self) -> Option<Result<Secret, CliError>> {
        let KeySource::Command(argv) = &self.key else {
            return None;
        };
        Some(
            self.ran
                .get_or_init(|| run_key_command(&self.name, argv, KEY_COMMAND_LIMIT))
                .clone()
                .map_err(CliError::KeyCommand),
        )
    }
}

#[cfg(test)]
pub fn for_test(name: &str, url: &str, key_command: Option<&[&str]>) -> Arc<Profile> {
    Arc::new(Profile {
        name: name.to_string(),
        url: url.to_string(),
        origin: marfa_core::http::origin_of(url).unwrap(),
        key: match key_command {
            Some(argv) => KeySource::Command(argv.iter().map(|word| word.to_string()).collect()),
            None => KeySource::Keychain,
        },
        ran: OnceLock::new(),
    })
}

/// `~/Library/Application Support/Marfa/profiles.toml` on macOS, and
/// `$XDG_CONFIG_HOME/marfa/profiles.toml`, else `~/.config/marfa/profiles.toml`,
/// elsewhere.
pub fn path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from);
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|config| !config.is_empty())
        .map(PathBuf::from);
    place(cfg!(target_os = "macos"), home, config)
        .ok_or_else(|| format!("HOME is not set, so there is no {FILE_NAME} to read"))
}

fn place(macos: bool, home: Option<PathBuf>, config: Option<PathBuf>) -> Option<PathBuf> {
    if macos {
        return Some(
            home?
                .join("Library")
                .join("Application Support")
                .join("Marfa")
                .join(FILE_NAME),
        );
    }
    // The XDG base directory specification ignores a relative path.
    let config = match config.filter(|config| config.is_absolute()) {
        Some(config) => config,
        None => home?.join(".config"),
    };
    Some(config.join("marfa").join(FILE_NAME))
}

/// The file's text. Refused, with the reason and never what it holds, for a
/// file another user owns or can change, or in a folder others can change, as
/// whoever can change it chooses the program that hands over a key.
fn read(path: &Path) -> Result<String, String> {
    let shown = path.display();
    // A named pipe opened for reading would wait for a writer.
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!(
                "no profile file at {shown}: write one with a section for each profile, such as [demo] with a url line"
            ),
            _ => format!("the profile file {shown} cannot be read: {error}"),
        })?;
    let opened = file
        .metadata()
        .map_err(|error| format!("the profile file {shown} cannot be read: {error}"))?;
    if !opened.is_file() {
        return Err(format!("the profile file {shown} is not a file"));
    }
    // SAFETY: `geteuid` cannot fail.
    permitted(path, opened.uid(), opened.mode(), unsafe {
        libc::geteuid()
    })?;
    if acl_lets_others_write(&file, opened.uid())
        .map_err(|error| format!("the profile file {shown} cannot be read: {error}"))?
    {
        return Err(format!(
            "the profile file {shown} has an access control entry that lets other users change it, so it is not read: run `chmod -N '{shown}'`"
        ));
    }
    // A link is followed, so the folder checked is the one that holds the
    // file it leads to, and that file must be the one opened.
    let target = std::fs::canonicalize(path)
        .map_err(|error| format!("the profile file {shown} cannot be read: {error}"))?;
    let named = std::fs::metadata(&target)
        .map_err(|error| format!("the profile file {shown} cannot be read: {error}"))?;
    if (named.dev(), named.ino()) != (opened.dev(), opened.ino()) {
        return Err(format!(
            "the profile file {shown} changed while it was read; run the command again"
        ));
    }
    if let Some(folder) = target.parent() {
        let unreadable = |error: std::io::Error| {
            format!(
                "the folder {} that holds the profile file cannot be read: {error}",
                folder.display()
            )
        };
        let opened_folder = std::fs::File::open(folder).map_err(unreadable)?;
        let held = opened_folder.metadata().map_err(unreadable)?;
        folder_permitted(folder, held.mode())?;
        if acl_lets_others_write(&opened_folder, held.uid()).map_err(unreadable)? {
            let shown = folder.display();
            return Err(format!(
                "the folder {shown} that holds the profile file has an access control entry that lets other users change it, so the file is not read: run `chmod -N '{shown}'`"
            ));
        }
    }
    if opened.len() > FILE_LIMIT {
        return Err(format!(
            "the profile file {shown} is larger than a profile file can be"
        ));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("the profile file {shown} cannot be read: {error}"))?;
    String::from_utf8(bytes).map_err(|_| format!("the profile file {shown} is not UTF-8 text"))
}

fn permitted(path: &Path, owner: u32, mode: u32, user: u32) -> Result<(), String> {
    let shown = path.display();
    if owner != user {
        return Err(format!(
            "the profile file {shown} belongs to another user, so it is not read: if it is yours, run `chown \"$USER\" '{shown}'`"
        ));
    }
    if mode & 0o022 != 0 {
        return Err(format!(
            "the profile file {shown} can be changed by other users (mode {:03o}), so it is not read: run `chmod go-w '{shown}'`",
            mode & 0o777
        ));
    }
    Ok(())
}

/// On macOS an extended ACL can let others write a file its mode keeps to its
/// owner. Elsewhere a POSIX ACL's mask shows in the group bits, which the mode
/// check reads.
#[cfg(target_os = "macos")]
fn acl_lets_others_write(file: &std::fs::File, owner: u32) -> std::io::Result<bool> {
    crate::acl::others_may_write(file, owner)
}

#[cfg(not(target_os = "macos"))]
fn acl_lets_others_write(_file: &std::fs::File, _owner: u32) -> std::io::Result<bool> {
    Ok(false)
}

fn folder_permitted(folder: &Path, mode: u32) -> Result<(), String> {
    if mode & 0o022 != 0 {
        let shown = folder.display();
        return Err(format!(
            "the folder {shown} that holds the profile file can be changed by other users (mode {:03o}), so the file is not read: run `chmod go-w '{shown}'`",
            mode & 0o777
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    url: String,
    key_command: Option<Vec<String>>,
}

fn parse(path: &Path, text: &str, name: &str) -> Result<Profile, String> {
    let shown = path.display();
    let entries: BTreeMap<String, Entry> =
        toml::from_str(text).map_err(|error| malformed(path, text, &error))?;
    let Some(entry) = entries.get(name) else {
        let names = if entries.is_empty() {
            "it has none".to_string()
        } else {
            format!(
                "it has {}",
                entries.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        };
        return Err(format!("no profile named {name:?} in {shown}; {names}"));
    };
    let origin = marfa_core::http::origin_of(&entry.url).map_err(|_| {
        format!("the profile {name} in {shown} has a url that is not a server's address")
    })?;
    let key = match &entry.key_command {
        None => KeySource::Keychain,
        Some(argv) if argv.first().is_none_or(|program| program.trim().is_empty()) => {
            return Err(format!(
                "the profile {name} in {shown} has an empty key_command: name a program and its arguments, such as [\"secrets-tool\", \"get\", \"MARFA_API_KEY\"]"
            ));
        }
        Some(argv) => KeySource::Command(argv.clone()),
    };
    Ok(Profile {
        name: name.to_string(),
        url: entry.url.clone(),
        origin,
        key,
        ran: OnceLock::new(),
    })
}

/// The parser's own words and the line, never the rendered error, which
/// quotes the file. A value the words quote is left out too, since it can be
/// a key written in the wrong place.
fn malformed(path: &Path, text: &str, error: &toml::de::Error) -> String {
    let line = error
        .span()
        .map(|span| text[..span.start.min(text.len())].matches('\n').count() + 1);
    let mut said = String::new();
    let mut quoted = false;
    for character in error.message().chars() {
        if character == '"' {
            if !quoted {
                said.push_str("a value");
            }
            quoted = !quoted;
        } else if !quoted {
            said.push(character);
        }
    }
    let said = said.trim().trim_end_matches('.').replace('\n', "; ");
    match line {
        Some(line) => format!(
            "the profile file {} is not valid at line {line}: {said}",
            path.display()
        ),
        None => format!("the profile file {} is not valid: {said}", path.display()),
    }
}

/// What a reader thread has read so far, and whether it has reached the end.
#[derive(Default)]
struct Captured {
    bytes: Vec<u8>,
    over: bool,
}

/// Reads `source` to its end on a thread of its own, keeping its first or,
/// `from_end`, its last `keep` bytes, and says when it has ended.
fn capture(
    mut source: impl Read + Send + 'static,
    keep: usize,
    from_end: bool,
) -> (Arc<Mutex<Captured>>, mpsc::Receiver<()>) {
    let captured = Arc::new(Mutex::new(Captured::default()));
    let (ended, done) = mpsc::channel();
    let shared = Arc::clone(&captured);
    // Should no thread start, nothing reads the pipe, and the command fails
    // as one that printed nothing, or is stopped at its limit.
    let _ = crate::interrupt::spawn_apart("key command", move || {
        let mut buffer = [0u8; 4096];
        loop {
            match source.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let mut held = lock(&shared);
                    if from_end {
                        held.bytes.extend_from_slice(&buffer[..read]);
                        let extra = held.bytes.len().saturating_sub(keep);
                        held.bytes.drain(..extra);
                    } else {
                        let room = keep.saturating_sub(held.bytes.len());
                        held.bytes.extend_from_slice(&buffer[..read.min(room)]);
                        held.over |= read > room;
                    }
                }
            }
        }
        let _ = ended.send(());
    });
    (captured, done)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The signal that would end marfa while a key command runs. The command is
/// in a process group of its own, so the terminal's Ctrl-C never reaches it,
/// and marfa stops the group before the signal ends marfa.
static CAUGHT: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

const CAUGHT_SIGNALS: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];

extern "C" fn note_signal(signal: libc::c_int) {
    CAUGHT.store(signal, std::sync::atomic::Ordering::Relaxed);
}

/// Catches `CAUGHT_SIGNALS` until it is dropped, when each signal's own
/// disposition is put back and a signal that arrived is raised again, so it
/// ends marfa as it would have with no key command running. A signal the
/// process ignores stays ignored.
struct Interrupts {
    before: Vec<(libc::c_int, libc::sigaction)>,
}

impl Interrupts {
    fn catch() -> Interrupts {
        CAUGHT.store(0, std::sync::atomic::Ordering::Relaxed);
        let mut before = Vec::new();
        for signal in CAUGHT_SIGNALS {
            // SAFETY: both actions are initialized, and the handler only
            // stores to an atomic, which is async-signal-safe.
            unsafe {
                let mut old: libc::sigaction = std::mem::zeroed();
                if libc::sigaction(signal, std::ptr::null(), &mut old) != 0
                    || old.sa_sigaction == libc::SIG_IGN
                {
                    continue;
                }
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = note_signal as extern "C" fn(libc::c_int) as usize;
                action.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(signal, &action, std::ptr::null_mut()) == 0 {
                    before.push((signal, old));
                }
            }
        }
        Interrupts { before }
    }

    fn arrived(&self) -> bool {
        CAUGHT.load(std::sync::atomic::Ordering::Relaxed) != 0
    }
}

impl Drop for Interrupts {
    fn drop(&mut self) {
        for (signal, old) in &self.before {
            // SAFETY: `old` is the action `sigaction` handed back.
            unsafe { libc::sigaction(*signal, old, std::ptr::null_mut()) };
        }
        let signal = CAUGHT.swap(0, std::sync::atomic::Ordering::Relaxed);
        if signal != 0 {
            // SAFETY: raising a signal has no memory effects of its own.
            unsafe { libc::raise(signal) };
        }
    }
}

/// How often the key command's process group is searched for a stopped
/// member. Its own process is waited on more often.
const STOPPED_SCAN: Duration = Duration::from_millis(50);

const TERMINAL_STOP: &str = "tried to read from or write to the terminal, so it was stopped: a key command must print the key without asking for anything";

/// Whether a process in group `group` other than `except` is stopped. A
/// process the key command starts, such as one in a pipeline, stops on the
/// terminal as the command itself does, and the command then waits on it
/// for ever, unseen by `waitpid`.
#[cfg(target_os = "macos")]
fn another_is_stopped(group: libc::pid_t, except: libc::pid_t) -> bool {
    let mut pids: Vec<libc::pid_t> = vec![0; 64];
    let count = loop {
        let bytes = libc::c_int::try_from(std::mem::size_of_val(pids.as_slice()))
            .unwrap_or(libc::c_int::MAX);
        // SAFETY: the buffer holds `bytes` bytes of writable pids.
        let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), bytes) };
        let Ok(count) = usize::try_from(count) else {
            return false;
        };
        if count < pids.len() {
            break count;
        }
        pids.resize(pids.len() * 2, 0);
    };
    pids[..count]
        .iter()
        .filter(|&&pid| pid > 0 && pid != except)
        .any(|&pid| {
            // SAFETY: an all-zero `proc_bsdinfo` is valid, and the call
            // writes at most its size.
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            // SAFETY: `info` is `size` writable bytes.
            let written = unsafe {
                libc::proc_pidinfo(
                    pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    std::ptr::from_mut(&mut info).cast(),
                    size,
                )
            };
            // A pid that has gone, or been taken by a process in another
            // group, since it was listed is not a member.
            written == size
                && i64::from(info.pbi_pgid) == i64::from(group)
                && info.pbi_status == libc::SSTOP
        })
}

#[cfg(target_os = "linux")]
fn another_is_stopped(group: libc::pid_t, except: libc::pid_t) -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<libc::pid_t>().ok())
            .filter(|&pid| pid != except)
            .and_then(|_| std::fs::read_to_string(entry.path().join("stat")).ok())
            .is_some_and(|stat| stopped_in(&stat, group))
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn another_is_stopped(_group: libc::pid_t, _except: libc::pid_t) -> bool {
    false
}

/// Whether a line of `/proc/<pid>/stat` is a process stopped by a signal in
/// group `group`. The name in parentheses may hold spaces and parentheses
/// itself, so the fields are read after the last `)`.
#[cfg(any(target_os = "linux", test))]
fn stopped_in(stat: &str, group: libc::pid_t) -> bool {
    let Some((_, after)) = stat.rsplit_once(')') else {
        return false;
    };
    let mut fields = after.split_whitespace();
    let state = fields.next();
    let pgrp = fields
        .nth(1)
        .and_then(|pgrp| pgrp.parse::<libc::pid_t>().ok());
    state == Some("T") && pgrp == Some(group)
}

/// Runs a profile's key command and hands back the key it printed. The
/// program is run without a shell, with nothing on stdin and in a process
/// group of its own, which is stopped whole if it outlasts `limit`, if it or
/// any process it started stops, as reading the terminal makes it, or if a
/// signal comes to end marfa. A refusal names the profile and the program,
/// and never shows what the command printed on stdout.
pub fn run_key_command(profile: &str, argv: &[String], limit: Duration) -> Result<Secret, String> {
    let program = argv.first().map(String::as_str).unwrap_or_default();
    let failed = |why: String| format!("the key command of profile {profile} ({program}) {why}");
    let interrupts = Interrupts::catch();
    let mut child = Command::new(program)
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|error| {
            failed(match error.kind() {
                std::io::ErrorKind::NotFound => "was not found".into(),
                std::io::ErrorKind::PermissionDenied => "cannot be run".into(),
                _ => format!("could not be started: {error}"),
            })
        })?;
    let pid = child.id() as libc::pid_t;
    // The child is reaped here with `waitpid`, never through `child`, which
    // cannot report a stopped process.
    let stop = || {
        // SAFETY: the group is the child's own, made by `process_group(0)`,
        // and `pid` is a child not yet reaped.
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
            let mut status = 0;
            while libc::waitpid(pid, &mut status, 0) == -1
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
            {
            }
        }
    };
    let (out, out_done) = match child.stdout.take() {
        Some(stdout) => capture(stdout, KEY_LIMIT, false),
        None => (Arc::default(), mpsc::channel().1),
    };
    let (err, err_done) = match child.stderr.take() {
        Some(stderr) => capture(stderr, STDERR_KEPT, true),
        None => (Arc::default(), mpsc::channel().1),
    };
    drop(child);
    let started = Instant::now();
    let mut scanned = started;
    let status = loop {
        let mut raw = 0;
        // SAFETY: `pid` is this process's child and `raw` is a valid int.
        let waited = unsafe { libc::waitpid(pid, &mut raw, libc::WNOHANG | libc::WUNTRACED) };
        if waited == pid {
            if libc::WIFSTOPPED(raw) {
                // Its process group is not the terminal's, so reading the
                // terminal stops it, and nobody is there to continue it.
                stop();
                return Err(failed(match libc::WSTOPSIG(raw) {
                    libc::SIGTTIN | libc::SIGTTOU => TERMINAL_STOP.into(),
                    signal => format!("was stopped by signal {signal}, so it was ended"),
                }));
            }
            break std::process::ExitStatus::from_raw(raw);
        }
        if scanned.elapsed() >= STOPPED_SCAN {
            scanned = Instant::now();
            // Which signal stopped another process is not known here; the
            // terminal is what stops one a key command starts.
            if another_is_stopped(pid, pid) {
                stop();
                return Err(failed(TERMINAL_STOP.into()));
            }
        }
        if waited == -1 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                stop();
                return Err(failed(format!("could not be waited for: {error}")));
            }
        }
        if interrupts.arrived() {
            stop();
            return Err(failed("was stopped by a signal to marfa".into()));
        }
        if crate::interrupt::asked_to_stop() {
            stop();
            return Err(failed("was stopped because marfa was asked to stop".into()));
        }
        if started.elapsed() >= limit {
            stop();
            return Err(failed(format!(
                "did not finish within {} seconds, so it was stopped",
                limit.as_secs().max(1)
            )));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // A process the command left running may hold the pipes open; what the
    // command wrote before it exited is read by now.
    let _ = out_done.recv_timeout(OUTPUT_GRACE);
    let _ = err_done.recv_timeout(OUTPUT_GRACE);
    if !status.success() {
        let why = match (status.code(), status.signal()) {
            (Some(code), _) => format!("exited with status {code}"),
            (None, Some(signal)) => format!("was ended by signal {signal}"),
            (None, None) => "failed".into(),
        };
        return Err(failed(match last_line(&lock(&err).bytes) {
            Some(line) => format!("{why}: {line}"),
            None => why,
        }));
    }
    let printed = std::mem::take(&mut *lock(&out));
    if printed.over {
        return Err(failed(format!(
            "printed more than {} KiB, which is no key",
            KEY_LIMIT / 1024
        )));
    }
    let text = String::from_utf8(printed.bytes)
        .map_err(|_| failed("printed something that is not UTF-8 text".into()))?;
    let key = text.trim();
    if key.is_empty() {
        return Err(failed("printed nothing".into()));
    }
    if key.contains(['\n', '\r']) {
        return Err(failed(
            "printed more than one line: it must print the key alone".into(),
        ));
    }
    Ok(Secret(key.to_string()))
}

/// The last line of stderr that says anything, with control characters made
/// spaces and cut to `STDERR_SHOWN` characters.
fn last_line(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let line = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let mut shown: String = line
        .chars()
        .take(STDERR_SHOWN)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    if line.chars().count() > STDERR_SHOWN {
        shown.push('…');
    }
    Some(shown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "macos")]
    use std::process::Command;

    const KEY: &str = "marfa_k1_profile_witness_7f3a";

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "marfa-profiles-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700)).unwrap();
        folder
    }

    fn file(folder: &Path, mode: u32, text: &str) -> PathBuf {
        let path = folder.join(FILE_NAME);
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    fn quick(words: &[&str]) -> Result<Secret, String> {
        run_key_command("demo", &argv(words), Duration::from_secs(1))
    }

    const DEMO: &str = "[demo]\nurl = \"http://127.0.0.1:8600\"\n";

    #[test]
    fn the_file_is_in_application_support_on_macos_and_in_the_config_folder_elsewhere() {
        let home = Some(PathBuf::from("/home/someone"));
        assert_eq!(
            place(true, home.clone(), Some("/config".into())).unwrap(),
            Path::new("/home/someone/Library/Application Support/Marfa/profiles.toml")
        );
        assert_eq!(
            place(false, home.clone(), Some("/config".into())).unwrap(),
            Path::new("/config/marfa/profiles.toml")
        );
        assert_eq!(
            place(false, home.clone(), None).unwrap(),
            Path::new("/home/someone/.config/marfa/profiles.toml")
        );
        assert_eq!(
            place(false, home, Some("relative".into())).unwrap(),
            Path::new("/home/someone/.config/marfa/profiles.toml")
        );
        assert_eq!(place(true, None, None), None);
        assert_eq!(place(false, None, None), None);
        assert_eq!(
            place(false, None, Some("/config".into())).unwrap(),
            Path::new("/config/marfa/profiles.toml")
        );
    }

    #[test]
    fn a_file_others_cannot_change_is_read_and_one_they_can_is_refused() {
        let at = folder("modes");
        for mode in [0o600, 0o644, 0o400] {
            let path = file(&at, mode, DEMO);
            assert!(read(&path).is_ok(), "{mode:o}");
        }
        for mode in [0o664, 0o646, 0o666, 0o620] {
            let path = file(&at, mode, DEMO);
            let refused = read(&path).unwrap_err();
            assert!(
                refused.contains("can be changed by other users"),
                "{refused}"
            );
            assert!(refused.contains("chmod go-w"), "{refused}");
            assert!(!refused.contains("127.0.0.1"), "{refused}");
        }
        std::fs::remove_dir_all(at).unwrap();
    }

    #[test]
    fn a_file_another_user_owns_is_refused() {
        let path = Path::new("/somewhere/profiles.toml");
        assert!(permitted(path, 501, 0o100600, 501).is_ok());
        let refused = permitted(path, 0, 0o100600, 501).unwrap_err();
        assert!(refused.contains("belongs to another user"), "{refused}");
        assert!(refused.contains("chown"), "{refused}");
    }

    #[test]
    fn a_file_in_a_folder_others_can_change_is_refused() {
        let at = folder("open-folder");
        let path = file(&at, 0o600, DEMO);
        assert!(read(&path).is_ok());
        std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o770)).unwrap();
        let refused = read(&path).unwrap_err();
        assert!(refused.contains("folder"), "{refused}");
        assert!(refused.contains("chmod go-w"), "{refused}");
        std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o707)).unwrap();
        assert!(read(&path).is_err());
        std::fs::set_permissions(&at, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(read(&path).is_ok());
        std::fs::remove_dir_all(at).unwrap();
    }

    #[test]
    fn a_link_is_followed_and_the_folder_of_the_file_it_leads_to_is_checked() {
        let real = folder("link-target");
        let target = file(&real, 0o600, DEMO);
        let linked = folder("link-name");
        let link = linked.join(FILE_NAME);
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read(&link).is_ok());
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o777)).unwrap();
        let refused = read(&link).unwrap_err();
        assert!(refused.contains(&real.display().to_string()), "{refused}");
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(
            read(&link)
                .unwrap_err()
                .contains("can be changed by other users")
        );
        std::fs::remove_dir_all(real).unwrap();
        std::fs::remove_dir_all(linked).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_access_control_entry_that_lets_others_write_is_refused_and_one_that_denies_is_not() {
        let chmod = |entry: &str, path: &Path| {
            let status = Command::new("/bin/chmod")
                .args(["+a", entry])
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success(), "{entry}");
        };
        let clear = |path: &Path| {
            let status = Command::new("/bin/chmod")
                .arg("-N")
                .arg(path)
                .status()
                .unwrap();
            assert!(status.success());
        };
        let at = folder("acl");
        let path = file(&at, 0o600, DEMO);
        // Witness: macOS ships `~/Library` with a deny entry like these.
        chmod("everyone deny delete", &path);
        chmod("everyone deny delete", &at);
        assert!(read(&path).is_ok());
        chmod("everyone allow write", &path);
        let refused = read(&path).unwrap_err();
        assert!(refused.contains("access control entry"), "{refused}");
        assert!(refused.contains("profile file"), "{refused}");
        assert!(refused.contains("chmod -N"), "{refused}");
        assert!(!refused.contains("127.0.0.1"), "{refused}");
        clear(&path);
        assert!(read(&path).is_ok());
        chmod("everyone allow add_file,delete_child", &at);
        let refused = read(&path).unwrap_err();
        assert!(refused.contains("folder"), "{refused}");
        assert!(refused.contains("access control entry"), "{refused}");
        // The deny entry keeps even the owner from deleting.
        clear(&at);
        std::fs::remove_dir_all(at).unwrap();
    }

    #[test]
    fn a_missing_file_is_named() {
        let at = folder("missing");
        let refused = read(&at.join(FILE_NAME)).unwrap_err();
        assert!(refused.starts_with("no profile file at "), "{refused}");
        assert!(refused.contains(FILE_NAME), "{refused}");
        std::fs::remove_dir_all(at).unwrap();
    }

    #[test]
    fn a_profile_names_a_server_and_where_its_key_comes_from() {
        let path = Path::new("/somewhere/profiles.toml");
        let text = "# test servers\n[demo]\nurl = \"http://127.0.0.1:8600\"\n\n[example]\nurl = \"https://marfa.example/\"\nkey_command = [\"secrets-tool\", \"get\", \"MARFA_API_KEY\", \"--plain\"]\n";
        let demo = parse(path, text, "demo").unwrap();
        assert_eq!(demo.origin, "http://127.0.0.1:8600");
        assert!(!demo.has_key_command());
        assert!(demo.key_from_command().is_none());
        let example = parse(path, text, "example").unwrap();
        assert_eq!(example.origin, "https://marfa.example");
        assert_eq!(example.program(), Some("secrets-tool"));
        let debug = format!("{example:?}");
        assert!(!debug.contains("MARFA_API_KEY"), "{debug}");
    }

    #[test]
    fn an_unknown_profile_is_refused_with_the_names_the_file_has() {
        let path = Path::new("/somewhere/profiles.toml");
        let text = "[demo]\nurl = \"http://127.0.0.1:8600\"\n[example]\nurl = \"https://marfa.example\"\nkey_command = [\"tool\", \"marfa_k1_never_shown\"]\n";
        let refused = parse(path, text, "other").unwrap_err();
        assert_eq!(
            refused,
            "no profile named \"other\" in /somewhere/profiles.toml; it has demo, example"
        );
        let refused = parse(path, "", "demo").unwrap_err();
        assert!(refused.ends_with("it has none"), "{refused}");
    }

    #[test]
    fn a_misspelled_field_is_refused_with_its_line_and_never_a_value() {
        let path = Path::new("/somewhere/profiles.toml");
        let text = "[demo]\nurl = \"http://127.0.0.1:8600\"\nkey_comand = [\"tool\"]\n";
        let refused = parse(path, text, "demo").unwrap_err();
        assert!(refused.contains("line 3"), "{refused}");
        assert!(refused.contains("key_comand"), "{refused}");
        // A key written where a list belongs is a value the error would quote.
        let text = format!("[demo]\nurl = \"http://127.0.0.1:8600\"\nkey_command = \"{KEY}\"\n");
        let refused = parse(path, &text, "demo").unwrap_err();
        assert!(refused.contains("line 3"), "{refused}");
        assert!(!refused.contains(KEY), "{refused}");
        // Witness: the parser's own rendering quotes the line.
        let rendered = toml::from_str::<BTreeMap<String, Entry>>(&text)
            .err()
            .unwrap()
            .to_string();
        assert!(rendered.contains(KEY), "{rendered}");
        let refused = parse(path, "[demo\nurl = 1", "demo").unwrap_err();
        assert!(refused.contains("line 1"), "{refused}");
    }

    #[test]
    fn a_bad_url_or_an_empty_key_command_is_refused() {
        let path = Path::new("/somewhere/profiles.toml");
        assert!(
            parse(path, "[demo]\nurl = \"not a url\"\n", "demo")
                .unwrap_err()
                .contains("not a server's address")
        );
        for empty in ["[]", "[\"\"]", "[\" \"]"] {
            let text = format!("[demo]\nurl = \"https://marfa.example\"\nkey_command = {empty}\n");
            assert!(
                parse(path, &text, "demo")
                    .unwrap_err()
                    .contains("empty key_command"),
                "{empty}"
            );
        }
        assert!(
            parse(path, "[demo]\n", "demo")
                .unwrap_err()
                .contains("line")
        );
    }

    #[test]
    fn a_key_command_hands_over_its_output_trimmed() {
        let key = quick(&["printf", "  marfa_k1_abc \n"]).unwrap();
        assert_eq!(key.expose(), "marfa_k1_abc");
        assert_eq!(format!("{key:?}"), "Secret(..)");
    }

    #[test]
    fn a_key_command_reads_no_stdin_and_runs_no_shell() {
        // `cat` with nothing on stdin prints nothing.
        assert!(quick(&["cat"]).unwrap_err().contains("printed nothing"));
        let key = quick(&["echo", "$HOME;", "x"]).unwrap();
        assert_eq!(key.expose(), "$HOME; x");
    }

    #[test]
    fn every_way_a_key_command_fails_is_refused_naming_the_profile_and_program_alone() {
        let cases: &[(&[&str], &str)] = &[
            (&["marfa-test-no-such-program"], "was not found"),
            (&["/dev/null"], "cannot be run"),
            (
                &["sh", "-c", &format!("printf {KEY}; echo bad >&2; exit 3")],
                "exited with status 3: bad",
            ),
            (
                &["sh", "-c", &format!("printf {KEY}; kill -9 $$")],
                "was ended by signal 9",
            ),
            (&["printf", "  \n\t"], "printed nothing"),
            (&["printf", &format!("{KEY}\nsecond")], "more than one line"),
            (&["printf", &format!("{KEY}\rsecond")], "more than one line"),
            (&["head", "-c", "20000", "/dev/zero"], "more than 16 KiB"),
            (&["printf", "\\377\\376"], "not UTF-8"),
        ];
        for (words, said) in cases {
            let refused = quick(words).unwrap_err();
            assert!(refused.contains(said), "{words:?}: {refused}");
            assert!(
                refused.starts_with(&format!("the key command of profile demo ({}) ", words[0])),
                "{refused}"
            );
            assert!(!refused.contains(KEY), "{refused}");
        }
        // Witness: the same output from a command that succeeds is the key.
        assert_eq!(quick(&["printf", KEY]).unwrap().expose(), KEY);
    }

    #[test]
    fn only_the_last_line_of_stderr_is_shown_and_it_is_cut_short() {
        let long = "y".repeat(400);
        let refused = quick(&[
            "sh",
            "-c",
            &format!("echo first >&2; printf '{long}\\033[31m\\n\\n' >&2; exit 1"),
        ])
        .unwrap_err();
        assert!(!refused.contains("first"), "{refused}");
        assert!(refused.contains(&"y".repeat(STDERR_SHOWN)), "{refused}");
        assert!(
            !refused.contains(&"y".repeat(STDERR_SHOWN + 1)),
            "{refused}"
        );
        assert!(!refused.contains('\u{1b}'), "{refused}");
    }

    #[test]
    fn a_key_command_that_hangs_is_stopped_with_everything_it_started() {
        let at = folder("hang");
        let marker = at.join("still-running");
        let started = Instant::now();
        let refused = quick(&[
            "sh",
            "-c",
            &format!("(sleep 3; touch '{}') & sleep 30", marker.display()),
        ])
        .unwrap_err();
        assert!(
            refused.contains("did not finish within 1 seconds"),
            "{refused}"
        );
        assert!(started.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(3500));
        assert!(
            !marker.exists(),
            "a process the command started outlived it"
        );
        std::fs::remove_dir_all(at).unwrap();
    }

    #[test]
    fn a_key_command_that_reaches_for_the_terminal_is_refused_at_once_with_everything_it_started() {
        // A program reading or writing the terminal from a process group that
        // is not the terminal's gets these signals, and stops. Where it is
        // one the command started, the command waits on it, never stopping.
        let cases = [
            ("TTIN", format!("kill -TTIN $$; printf {KEY}")),
            ("TTOU", format!("kill -TTOU $$; printf {KEY}")),
            ("child-TTIN", format!("sh -c 'kill -TTIN $$'; printf {KEY}")),
            ("child-TTOU", format!("sh -c 'kill -TTOU $$'; printf {KEY}")),
            (
                "pipeline",
                format!("sh -c 'kill -TTIN $$; printf {KEY}' | tr -d '\\n'"),
            ),
        ];
        for (name, script) in cases {
            let at = folder(&format!("terminal-{name}"));
            let marker = at.join("still-running");
            let group = at.join("group");
            let started = Instant::now();
            let refused = run_key_command(
                "demo",
                &argv(&[
                    "sh",
                    "-c",
                    &format!(
                        "echo $$ > '{}'; (sleep 2; touch '{}') & {script}",
                        group.display(),
                        marker.display()
                    ),
                ]),
                Duration::from_secs(10),
            )
            .unwrap_err();
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{name}: {:?}: {refused}",
                started.elapsed()
            );
            assert!(
                refused.contains("tried to read from or write to the terminal"),
                "{name}: {refused}"
            );
            assert!(refused.contains("without asking"), "{refused}");
            assert!(!refused.contains(KEY), "{refused}");
            let group: libc::pid_t = std::fs::read_to_string(&group)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            // Witness: the group was there to be found.
            assert!(group > 1);
            // A killed process another parent has yet to reap is still in
            // the group for a moment.
            let gone = Instant::now();
            // SAFETY: signal 0 only asks whether the group has a member.
            while unsafe { libc::killpg(group, 0) } == 0 {
                assert!(
                    gone.elapsed() < Duration::from_secs(1),
                    "{name}: a process of the command's group is left"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            std::thread::sleep(Duration::from_millis(2500));
            assert!(
                !marker.exists(),
                "{name}: a process the command started outlived it"
            );
            std::fs::remove_dir_all(at).unwrap();
        }
    }

    #[test]
    fn a_stopped_process_is_read_from_proc_by_its_state_and_group() {
        let stat = |state: &str, pgrp: &str| {
            format!("4242 (a (tricky) name) {state} 4200 {pgrp} 4200 0 -1 4194560 0")
        };
        assert!(stopped_in(&stat("T", "4200"), 4200));
        assert!(!stopped_in(&stat("S", "4200"), 4200));
        assert!(!stopped_in(&stat("t", "4200"), 4200));
        assert!(!stopped_in(&stat("T", "4201"), 4200));
        assert!(!stopped_in("4242 no name T 4200 4200", 4200));
        assert!(!stopped_in("", 4200));
    }

    #[test]
    fn a_process_left_holding_the_output_does_not_hold_the_command() {
        let started = Instant::now();
        let key = run_key_command(
            "demo",
            &argv(&["sh", "-c", &format!("printf {KEY}; sleep 5 &")]),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(key.expose(), KEY);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_key_command_runs_once_in_a_run_whatever_it_answered() {
        let at = folder("once");
        let count = at.join("count");
        let text = format!(
            "[example]\nurl = \"https://marfa.example\"\nkey_command = [\"sh\", \"-c\", \"echo x >> '{}'; printf {KEY}\"]\n",
            count.display()
        );
        let profile = parse(Path::new("/somewhere/profiles.toml"), &text, "example").unwrap();
        for _ in 0..3 {
            assert_eq!(profile.key_from_command().unwrap().unwrap().expose(), KEY);
        }
        assert_eq!(std::fs::read_to_string(&count).unwrap(), "x\n");
        let text = format!(
            "[example]\nurl = \"https://marfa.example\"\nkey_command = [\"sh\", \"-c\", \"echo x >> '{}'; exit 1\"]\n",
            count.display()
        );
        let profile = parse(Path::new("/somewhere/profiles.toml"), &text, "example").unwrap();
        for _ in 0..3 {
            assert!(matches!(
                profile.key_from_command(),
                Some(Err(CliError::KeyCommand(_)))
            ));
        }
        assert_eq!(std::fs::read_to_string(&count).unwrap(), "x\nx\n");
        std::fs::remove_dir_all(at).unwrap();
    }
}
