//! The record of a self-update across the restarts that try the new release, which the server
//! and `marfa server run` both keep, and the moves of the programs it describes.
//!
//! The swap replaces only `marfa-server` and stages the new `marfa` as `.marfa.next`, so the
//! `marfa server run` of the running release supervises the new server's first starts.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const SERVER: &str = "marfa-server";
pub const MARFA: &str = "marfa";

/// Held while a server unpacks and swaps a release into the folder.
pub const LOCK: &str = ".marfa-update.lock";

/// Starts of a new release that ended unasked; the next start puts the old release back.
pub const UNFINISHED_STARTS: u32 = 2;

/// How long a program asked about its release or the database may take to answer.
pub const ASK_LIMIT: Duration = Duration::from_secs(20);

/// The most of a program's output kept from each of its streams.
const SAID_BYTES: u64 = 64 << 10;

const PENDING: &str = "pending.json";
const LAST: &str = "last.json";
const SUPERVISOR: &str = "supervisor.lock";
const UPGRADE: &str = "upgrade.json";

pub fn previous_of(programs: &Path, name: &str) -> PathBuf {
    programs.join(format!(".{name}.previous"))
}

/// The new release's `marfa`, which waits until the new server has settled.
pub fn next_marfa(programs: &Path) -> PathBuf {
    programs.join(".marfa.next")
}

/// A swap that has not settled. `starts` counts starts of the new release that have not ended
/// in a stop someone asked for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub from: String,
    pub to: String,
    pub schema: Option<u32>,
    pub starts: u32,
    pub programs: PathBuf,
    /// Tells this swap from an earlier one to the same release. A record kept by a release
    /// that wrote none reads as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<String>,
    /// Why the time limit last ended a start of the new release, for the reason of a put-back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_ended: Option<String>,
}

/// How far a start of the new release has come with upgrading the database, which the server
/// marks so that `marfa server run` does not time the upgrade as a start that will not settle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Upgrade {
    Began,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Succeeded,
    Failed,
    RolledBack,
}

impl Outcome {
    pub fn word(self) -> &'static str {
        match self {
            Outcome::Succeeded => "succeeded",
            Outcome::Failed => "failed",
            Outcome::RolledBack => "rolled_back",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Last {
    pub outcome: String,
    pub release: String,
    pub finished_at: String,
    pub reason: Option<String>,
    /// The [`Pending::attempt`] this outcome ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<String>,
}

impl Last {
    /// Whether this is the outcome of `pending`'s own attempt, not of an earlier one.
    pub fn ends(&self, pending: &Pending) -> bool {
        self.release == pending.to && self.attempt.is_some() && self.attempt == pending.attempt
    }
}

/// The `update` folder beside the database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder(PathBuf);

impl Folder {
    pub fn beside(database: &Path) -> Folder {
        let data = database
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        Folder(data.join("update"))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, name: &str, text: &str) -> io::Result<()> {
        fs::create_dir_all(&self.0)?;
        let temporary = self.0.join(format!("{name}.partial"));
        let mut file = File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, self.0.join(name))?;
        sync_folder(&self.0)
    }

    fn read<T: for<'a> Deserialize<'a>>(&self, name: &str) -> io::Result<Option<T>> {
        let path = self.0.join(name);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} does not read: {error}", path.display()),
            )
        })
    }

    pub fn pending(&self) -> io::Result<Option<Pending>> {
        self.read(PENDING)
    }

    pub fn keep_pending(&self, pending: &Pending) -> io::Result<()> {
        let text = serde_json::to_string(pending).map_err(io::Error::other)?;
        self.write(PENDING, &text)
    }

    /// Clears the record of a swap, and the mark of an upgrade that belonged to it.
    pub fn clear_pending(&self) -> io::Result<()> {
        match fs::remove_file(self.0.join(PENDING)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => {
                let _ = fs::remove_file(self.0.join(UPGRADE));
                sync_folder(&self.0).or(Ok(()))
            }
        }
    }

    pub fn mark_upgrade(&self, mark: Upgrade) -> io::Result<()> {
        let text = serde_json::to_string(&mark).map_err(io::Error::other)?;
        self.write(UPGRADE, &text)
    }

    pub fn upgrade(&self) -> io::Result<Option<Upgrade>> {
        self.read(UPGRADE)
    }

    /// Clears a mark an earlier start left, so that only this start's upgrade is timed.
    pub fn clear_upgrade(&self) -> io::Result<()> {
        match fs::remove_file(self.0.join(UPGRADE)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            Err(_) => Ok(()),
            Ok(()) => sync_folder(&self.0),
        }
    }

    pub fn last(&self) -> io::Result<Option<Last>> {
        self.read(LAST)
    }

    /// `at` is the time the update ended, as `time::written` gives it, and `attempt` the
    /// [`Pending::attempt`] it ends.
    pub fn end(
        &self,
        at: &str,
        outcome: Outcome,
        release: &str,
        reason: Option<String>,
        attempt: Option<&str>,
    ) -> io::Result<()> {
        let last = Last {
            outcome: outcome.word().to_string(),
            release: release.to_string(),
            finished_at: at.to_string(),
            reason,
            attempt: attempt.map(str::to_string),
        };
        let text = serde_json::to_string(&last).map_err(io::Error::other)?;
        self.write(LAST, &text)
    }

    /// The file a `marfa server run` locks while it supervises a try of the new release.
    pub fn supervisor_lock(&self) -> io::Result<File> {
        fs::create_dir_all(&self.0)?;
        File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.0.join(SUPERVISOR))
    }
}

pub fn sync_folder(folder: &Path) -> io::Result<()> {
    File::open(folder)?.sync_all()
}

/// Some file systems and Linux's `protected_hardlinks` refuse the link, so a copy stands in.
pub fn keep_aside(
    live: &Path,
    kept: &Path,
    link: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    match fs::remove_file(kept) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    if link(live, kept).is_ok() {
        return Ok(());
    }
    fs::copy(live, kept)?;
    fs::set_permissions(kept, fs::Permissions::from_mode(0o755))?;
    File::open(kept)?.sync_all()
}

/// Puts `.marfa.next` in place as `marfa`, keeping the old `marfa` beside it.
/// Nothing to do when it is already in place.
pub fn finish_swap(programs: &Path) -> io::Result<()> {
    let next = next_marfa(programs);
    if !next.exists() {
        return Ok(());
    }
    let live = programs.join(MARFA);
    keep_aside(&live, &previous_of(programs, MARFA), |from, to| {
        fs::hard_link(from, to)
    })?;
    fs::rename(&next, &live)?;
    sync_folder(programs)
}

/// Puts the old `marfa-server` back, and the old `marfa` too where `marfa` was replaced, and
/// drops a `.marfa.next` that waited.
pub fn put_back(programs: &Path, marfa_replaced: bool) -> io::Result<()> {
    let names: &[&str] = if marfa_replaced {
        &[SERVER, MARFA]
    } else {
        &[SERVER]
    };
    if let Some(missing) = names
        .iter()
        .map(|name| previous_of(programs, name))
        .find(|kept| !kept.is_file())
    {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is missing", missing.display()),
        ));
    }
    for name in names {
        fs::rename(previous_of(programs, name), programs.join(name))?;
    }
    match fs::remove_file(next_marfa(programs)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    sync_folder(programs)
}

/// What a program said and how it ended.
#[derive(Debug)]
pub struct Ran {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `command` for at most `limit`, killing it after that with a `TimedOut` error. A
/// program that leaves its output open to a process of its own still answers in time.
pub fn run_within(mut command: Command, limit: Duration) -> io::Result<Ran> {
    let began = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let read = |from: Option<Box<dyn Read + Send>>| {
        let (said, heard) = mpsc::channel();
        if let Some(from) = from {
            std::thread::spawn(move || {
                let mut kept = Vec::new();
                let mut from = from;
                let _ = (&mut from).take(SAID_BYTES).read_to_end(&mut kept);
                let _ = io::copy(&mut from, &mut io::sink());
                let _ = said.send(String::from_utf8_lossy(&kept).into_owned());
            });
        }
        heard
    };
    let stdout = read(
        child
            .stdout
            .take()
            .map(|out| Box::new(out) as Box<dyn Read + Send>),
    );
    let stderr = read(
        child
            .stderr
            .take()
            .map(|err| Box::new(err) as Box<dyn Read + Send>),
    );
    let timed_out = || io::Error::new(io::ErrorKind::TimedOut, "it did not answer in time");
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if began.elapsed() >= limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err(timed_out());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let heard = |from: mpsc::Receiver<String>| {
        from.recv_timeout(limit.saturating_sub(began.elapsed()))
            .unwrap_or_default()
    };
    Ok(Ran {
        status,
        stdout: heard(stdout),
        stderr: heard(stderr),
    })
}

/// The release a program reports with `--version`: the last word it prints.
pub fn release_of(program: &Path, limit: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command.arg("--version");
    let ran = run_within(command, limit).map_err(|error| {
        format!(
            "{} could not be asked its release: {error}",
            program.display()
        )
    })?;
    ran.stdout
        .split_whitespace()
        .last()
        .filter(|_| ran.status.success())
        .map(str::to_string)
        .ok_or_else(|| format!("{} did not say which release it is", program.display()))
}

/// Why release `pending.from` cannot run again, or `None` when it can: its server, kept aside,
/// must open `database` as it stands now at the schema it had before the swap. `environment`
/// adds to this process's own, as the server is started with it.
pub fn cannot_put_back(
    pending: &Pending,
    database: &Path,
    environment: &[(String, String)],
) -> Option<String> {
    let old = previous_of(&pending.programs, SERVER);
    if !old.is_file() {
        return Some(format!("{} is missing", old.display()));
    }
    let mut command = Command::new(&old);
    command
        .arg("--can-open")
        .arg(database)
        .envs(environment.iter().map(|(name, value)| (name, value)));
    let from = &pending.from;
    let ran = match run_within(command, ASK_LIMIT) {
        Ok(ran) => ran,
        Err(error) if error.kind() == io::ErrorKind::TimedOut => {
            return Some(format!(
                "release {from} did not say within {} seconds whether it opens the database",
                ASK_LIMIT.as_secs()
            ));
        }
        Err(error) => return Some(format!("release {from} could not be asked: {error}")),
    };
    if !ran.status.success() {
        let said = ran.stderr.trim();
        return Some(match said.is_empty() {
            true => format!("release {from} will not open the database"),
            false => format!("release {from} will not open the database: {said}"),
        });
    }
    #[derive(Deserialize)]
    struct Said {
        schema: Option<u32>,
    }
    let text = |schema: Option<u32>| schema.map_or_else(|| "none".to_string(), |s| s.to_string());
    match serde_json::from_str::<Said>(ran.stdout.trim()) {
        Ok(said) if said.schema == pending.schema => None,
        Ok(said) => Some(format!(
            "release {} has changed the database's schema from {} to {}",
            pending.to,
            text(pending.schema),
            text(said.schema)
        )),
        Err(_) => Some(format!(
            "release {from} answered about the database in words that do not read"
        )),
    }
}

/// The file beside `database` that names the release of the last server to serve on it.
pub fn release_record(database: &Path) -> PathBuf {
    let mut path = database.as_os_str().to_owned();
    path.push(".release");
    PathBuf::from(path)
}

/// The release [`release_record`] names, or `None` when no server that keeps it has served on
/// `database`.
pub fn served_release(database: &Path) -> io::Result<Option<String>> {
    let path = release_record(database);
    let mut text = String::new();
    match File::open(&path) {
        Ok(file) => file.take(RELEASE_BYTES + 1).read_to_string(&mut text)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let release = text.trim_end_matches('\n');
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+');
    if release.is_empty() || text.len() as u64 > RELEASE_BYTES || !release.chars().all(plain) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} does not name a release", path.display()),
        ));
    }
    Ok(Some(release.to_string()))
}

const RELEASE_BYTES: u64 = 64;

/// Names `release` in [`release_record`], whole or not at all.
pub fn keep_served_release(database: &Path, release: &str) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = release_record(database);
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".partial");
    let temporary = PathBuf::from(temporary);
    match fs::remove_file(&temporary) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(format!("{release}\n").as_bytes())?;
    file.sync_all()?;
    fs::rename(&temporary, &path)?;
    sync_folder(
        path.parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
}

/// Drops a `.marfa.next` left by an update that ended without it.
pub fn drop_next(programs: &Path) -> io::Result<()> {
    match fs::remove_file(next_marfa(programs)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2030-01-02T03:04:05.678Z";

    fn scratch(name: &str) -> (PathBuf, Folder) {
        let dir = std::env::temp_dir().join(format!("marfa-record-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("bin")).unwrap();
        let folder = Folder::beside(&dir.join("data/marfa.db"));
        (dir, folder)
    }

    fn pending(bin: &Path) -> Pending {
        Pending {
            from: "0.0.74".into(),
            to: "0.0.75".into(),
            schema: Some(1),
            starts: 0,
            programs: bin.to_path_buf(),
            attempt: Some("second".into()),
            limit_ended: None,
        }
    }

    #[test]
    fn the_record_reads_what_was_kept_and_a_missing_one_reads_as_none() {
        let (dir, record) = scratch("kept");
        assert_eq!(record.path(), dir.join("data/update"));
        assert_eq!(record.pending().unwrap(), None);
        assert_eq!(record.last().unwrap(), None);
        let kept = pending(&dir.join("bin"));
        record.keep_pending(&kept).unwrap();
        assert_eq!(record.pending().unwrap(), Some(kept.clone()));
        record.clear_pending().unwrap();
        record.clear_pending().unwrap();
        assert_eq!(record.pending().unwrap(), None);
        record
            .end(
                AT,
                Outcome::RolledBack,
                "0.0.75",
                Some("why".into()),
                kept.attempt.as_deref(),
            )
            .unwrap();
        let last = record.last().unwrap().unwrap();
        assert_eq!(
            (
                last.outcome.as_str(),
                last.release.as_str(),
                last.finished_at.as_str()
            ),
            ("rolled_back", "0.0.75", AT)
        );
        assert!(last.ends(&kept));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_outcome_ends_only_its_own_attempt() {
        let bin = PathBuf::from("/bin");
        let this = pending(&bin);
        let last = |attempt: Option<&str>, release: &str| Last {
            outcome: "rolled_back".into(),
            release: release.into(),
            finished_at: AT.into(),
            reason: None,
            attempt: attempt.map(str::to_string),
        };
        assert!(last(Some("second"), "0.0.75").ends(&this), "the witness");
        assert!(!last(Some("first"), "0.0.75").ends(&this));
        assert!(!last(None, "0.0.75").ends(&this));
        assert!(!last(Some("second"), "0.0.76").ends(&this));
        let unnamed = Pending {
            attempt: None,
            ..this
        };
        assert!(!last(None, "0.0.75").ends(&unnamed));
    }

    #[test]
    fn a_record_kept_without_an_attempt_reads_as_none() {
        let (dir, record) = scratch("no-attempt");
        fs::create_dir_all(record.path()).unwrap();
        fs::write(
            record.path().join(PENDING),
            r#"{"from":"0.0.74","to":"0.0.75","schema":1,"starts":1,"programs":"/bin"}"#,
        )
        .unwrap();
        assert_eq!(record.pending().unwrap().unwrap().attempt, None);
        let _ = fs::remove_dir_all(&dir);
    }

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        command
    }

    #[test]
    fn a_program_run_within_a_limit_gives_its_status_and_what_it_said() {
        let ran = run_within(shell("echo out; echo err >&2; exit 3"), ASK_LIMIT).unwrap();
        assert_eq!(ran.status.code(), Some(3));
        assert_eq!(
            (ran.stdout.as_str(), ran.stderr.as_str()),
            ("out\n", "err\n")
        );
    }

    #[test]
    fn a_program_that_does_not_answer_in_time_is_ended() {
        let began = Instant::now();
        let error = run_within(shell("exec sleep 30"), Duration::from_millis(300)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(began.elapsed() < Duration::from_secs(5));

        let began = Instant::now();
        let ran = run_within(shell("sleep 3 & exit 0"), Duration::from_millis(500)).unwrap();
        assert!(ran.status.success());
        assert!(
            began.elapsed() < Duration::from_secs(2),
            "a process left holding its output does not hold up the answer"
        );
    }

    #[test]
    fn the_release_is_the_last_word_a_program_prints_and_only_when_it_succeeds() {
        let dir = std::env::temp_dir().join(format!("marfa-record-{}-release", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let program = |name: &str, body: &str| {
            let path = dir.join(name);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let limit = Duration::from_millis(500);
        assert_eq!(
            release_of(&program("says", "echo marfa-server 0.0.70"), limit).unwrap(),
            "0.0.70"
        );
        assert!(release_of(&program("silent", "exit 0"), limit).is_err());
        assert!(release_of(&program("fails", "echo marfa-server 0.0.70; exit 1"), limit).is_err());
        let hangs = release_of(&program("hangs", "exec sleep 30"), limit).unwrap_err();
        assert!(hangs.contains("in time"), "{hangs}");
        assert!(release_of(&dir.join("absent"), limit).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_old_release_comes_back_only_when_its_server_opens_the_database_at_the_old_schema() {
        let (dir, _) = scratch("can-open");
        let bin = dir.join("bin");
        let pending = pending(&bin);
        let database = dir.join("data/marfa.db");
        let environment = [("MARFA_ASKED".to_string(), "yes".to_string())];
        let old = |body: &str| {
            let path = previous_of(&bin, SERVER);
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        };
        let asked = || cannot_put_back(&pending, &database, &environment);
        let missing = asked().unwrap();
        assert!(missing.contains("is missing"), "{missing}");
        let opens = |schema: &str| {
            format!(
                r#"[ "$1" = --can-open ] && [ "$2" = "{}" ] && [ "$MARFA_ASKED" = yes ] || exit 9
echo '{{"schema":{schema},"standing":"current"}}'"#,
                database.display()
            )
        };
        old(&opens("1"));
        assert_eq!(asked(), None, "the witness");
        old(&opens("2"));
        let moved = asked().unwrap();
        assert!(moved.contains("schema from 1 to 2"), "{moved}");
        old("echo 'the database is newer' >&2; exit 78");
        let refused = asked().unwrap();
        assert!(
            refused.contains("0.0.74 will not open the database: the database is newer"),
            "{refused}"
        );
        old("echo something else");
        assert!(asked().unwrap().contains("do not read"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_upgrade_mark_reads_as_kept_and_goes_with_the_record() {
        let (dir, record) = scratch("upgrade");
        assert_eq!(record.upgrade().unwrap(), None);
        record.clear_upgrade().unwrap();
        record.mark_upgrade(Upgrade::Began).unwrap();
        assert_eq!(record.upgrade().unwrap(), Some(Upgrade::Began));
        record.mark_upgrade(Upgrade::Ended).unwrap();
        assert_eq!(record.upgrade().unwrap(), Some(Upgrade::Ended));
        record.clear_upgrade().unwrap();
        assert_eq!(record.upgrade().unwrap(), None);
        record.mark_upgrade(Upgrade::Began).unwrap();
        record.keep_pending(&pending(&dir.join("bin"))).unwrap();
        record.clear_pending().unwrap();
        assert_eq!(record.upgrade().unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_record_that_does_not_read_is_an_error_and_not_nothing() {
        let (dir, record) = scratch("unreadable");
        fs::create_dir_all(record.path()).unwrap();
        fs::write(record.path().join(PENDING), "{\"from\":").unwrap();
        let error = record.pending().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("pending.json"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    fn programs(dir: &Path) -> PathBuf {
        let bin = dir.join("bin");
        for (name, text) in [
            (SERVER, "new server"),
            (MARFA, "old marfa"),
            (".marfa-server.previous", "old server"),
            (".marfa.next", "new marfa"),
        ] {
            fs::write(bin.join(name), text).unwrap();
        }
        bin
    }

    fn text(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn finishing_the_swap_puts_the_new_marfa_in_place_and_keeps_the_old_one() {
        let (dir, _) = scratch("finish");
        let bin = programs(&dir);
        fs::write(previous_of(&bin, MARFA), "a copy from an earlier update").unwrap();
        finish_swap(&bin).unwrap();
        assert_eq!(text(bin.join(MARFA)), "new marfa");
        assert_eq!(text(previous_of(&bin, MARFA)), "old marfa");
        assert!(!next_marfa(&bin).exists());
        finish_swap(&bin).unwrap();
        assert_eq!(
            text(previous_of(&bin, MARFA)),
            "old marfa",
            "a second finish changes nothing"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn putting_back_restores_the_server_and_drops_the_waiting_marfa() {
        let (dir, _) = scratch("back");
        let bin = programs(&dir);
        fs::write(previous_of(&bin, MARFA), "a copy from an earlier update").unwrap();
        put_back(&bin, false).unwrap();
        assert_eq!(text(bin.join(SERVER)), "old server");
        assert_eq!(
            text(bin.join(MARFA)),
            "old marfa",
            "a marfa that was never replaced is left alone"
        );
        assert!(!next_marfa(&bin).exists());
        assert!(!previous_of(&bin, SERVER).exists());

        let bin = programs(&dir);
        finish_swap(&bin).unwrap();
        put_back(&bin, true).unwrap();
        assert_eq!(text(bin.join(SERVER)), "old server");
        assert_eq!(text(bin.join(MARFA)), "old marfa");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn putting_back_with_no_old_server_kept_says_so() {
        let (dir, _) = scratch("nothing-kept");
        let bin = programs(&dir);
        fs::remove_file(previous_of(&bin, SERVER)).unwrap();
        let error = put_back(&bin, false).unwrap_err();
        assert!(
            error.to_string().contains(".marfa-server.previous"),
            "{error}"
        );
        assert_eq!(text(bin.join(SERVER)), "new server");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_release_served_is_kept_whole_beside_the_database_and_read_back() {
        let (dir, _) = scratch("served");
        let database = dir.join("data/marfa.db");
        fs::create_dir_all(dir.join("data")).unwrap();
        assert_eq!(release_record(&database), dir.join("data/marfa.db.release"));
        assert_eq!(served_release(&database).unwrap(), None);
        keep_served_release(&database, "0.0.85").unwrap();
        keep_served_release(&database, "0.0.86").unwrap();
        assert_eq!(
            served_release(&database).unwrap().as_deref(),
            Some("0.0.86")
        );
        assert_eq!(text(release_record(&database)), "0.0.86\n");
        assert!(!dir.join("data/marfa.db.release.partial").exists());
        // A partial file a crash left is replaced, not appended to.
        fs::write(dir.join("data/marfa.db.release.partial"), "0.0.8").unwrap();
        keep_served_release(&database, "0.0.87").unwrap();
        assert_eq!(
            served_release(&database).unwrap().as_deref(),
            Some("0.0.87")
        );
        for unreadable in ["", "\n", "0.0.86\n0.0.87\n", "0.0.86 or so\n"] {
            fs::write(release_record(&database), unreadable).unwrap();
            let error = served_release(&database).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{unreadable:?}");
        }
        fs::write(release_record(&database), "9".repeat(100)).unwrap();
        assert!(served_release(&database).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
