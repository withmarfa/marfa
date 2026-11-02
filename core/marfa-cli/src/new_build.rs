//! A running watch noticing that a new build of marfa is installed at the path
//! it was started by: Homebrew moves its link to a new folder and later
//! deletes the old one, while `cargo install` and a Linux package replace the
//! file in place. A watch a service manager runs ends, so the manager starts
//! the new build; one run by hand says so and goes on.

use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use marfa_core::folder::WatchRecord;
use serde::Serialize;
use serde_json::json;

use crate::autostart::RecordFile;
use crate::interrupt;
use crate::output;

/// How often the watch looks at the path it was started by. A look is a
/// `stat` while nothing changed. systemd waits 30 seconds before it starts the
/// watch again, so the new build runs within a minute of its install.
const CHECK: Duration = Duration::from_secs(10);

/// How long the new binary gets to say its version. The first run of a
/// binary just installed can wait on the system's scan of it.
const VERSION_WAIT: Duration = Duration::from_secs(10);

const POLL: Duration = Duration::from_millis(100);

/// Why a binary could not be run while something still holds it open for
/// writing, as an install that has not finished does.
const BUSY: &str = "it is still being written";

/// The option of `folders watch` that `folders autostart` writes into the
/// agent, so that the watch ends for a new build.
pub const FLAG: &str = "--exit-on-new-build";

/// Set before the stop is raised for a new build, so the command ends with
/// the status that has the service manager start the watch again.
static ENDED_FOR_NEW_BUILD: AtomicBool = AtomicBool::new(false);

/// Whether the watch ended because a new build is installed.
pub fn ended_for_it() -> bool {
    ENDED_FOR_NEW_BUILD.load(Ordering::SeqCst)
}

/// Starts looking at the path this binary was started by. With `ends`, the
/// watch's stop is raised once a new build is there, and a pass under way
/// finishes first.
pub fn look_out(ends: bool, json: bool) {
    let path = crate::autostart::invoked(
        std::env::args_os().next().as_deref(),
        std::env::var_os("PATH").as_deref(),
        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
        &match std::env::current_exe() {
            Ok(exe) => exe,
            Err(_) => return,
        },
    );
    // With nothing to compare with, nothing can be said to have changed.
    let Ok(started) = Identity::of(&path) else {
        return;
    };
    let mut tracker = Tracker::new(started, ends);
    let every = check_every();
    let stop = interrupt::stop();
    let _ = interrupt::spawn_apart("new-build", move || {
        loop {
            let next = Instant::now() + every;
            while Instant::now() < next {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(POLL.min(next.saturating_duration_since(Instant::now())));
            }
            let Some(notice) = tracker.look(Identity::of(&path), |binary| {
                version_of(binary, VERSION_WAIT)
            }) else {
                continue;
            };
            tell(&notice, &path, json);
            if let Notice::Restarting { .. } = notice {
                ENDED_FOR_NEW_BUILD.store(true, Ordering::SeqCst);
                stop.store(true, Ordering::SeqCst);
                return;
            }
        }
    });
}

fn check_every() -> Duration {
    // A fixture waits a moment, not ten seconds, for the watch to look.
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("MARFA_TEST_NEW_BUILD_CHECK_MS")
        .ok()
        .and_then(|ms| ms.parse().ok())
    {
        return Duration::from_millis(ms);
    }
    CHECK
}

/// The version this binary reports.
pub fn running() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// A current watch of a folder that runs a build other than this one.
#[derive(Debug, PartialEq, Serialize)]
pub struct OtherBuild {
    pub pid: u32,
    /// `None` for a build too early to write its version in the record.
    pub marfa_version: Option<String>,
    pub this_version: &'static str,
}

impl OtherBuild {
    pub fn describe(&self) -> String {
        let runs = match &self.marfa_version {
            Some(version) => format!("marfa {version}"),
            None => "an earlier build of marfa".to_string(),
        };
        format!(
            "the watch of this folder (process {}) runs {runs}, and this command is marfa {}; \
             a watch `marfa folders autostart on` set up moves to a new build installed at its path \
             within a minute, and any other watch moves once it is started again",
            self.pid, self.this_version
        )
    }
}

/// The watch of `dir` that the record beside the folder registry lists as
/// current, if it runs another build.
pub fn other_build_watching(dir: &Path) -> Option<OtherBuild> {
    let record = WatchRecord::located()?;
    let file = RecordFile::read(record.path())?;
    other_build_in(&file, dir, SystemTime::now(), running())
}

fn other_build_in(
    file: &RecordFile,
    dir: &Path,
    now: SystemTime,
    this_version: &'static str,
) -> Option<OtherBuild> {
    let same = |listed: &str| {
        let listed = Path::new(listed);
        listed == dir
            || matches!(
                (std::fs::canonicalize(listed), std::fs::canonicalize(dir)),
                (Ok(a), Ok(b)) if a == b
            )
    };
    let process = file.processes.iter().find(|process| {
        process.current(now)
            && process
                .folders
                .iter()
                .any(|folder| folder.watching && same(&folder.dir))
    })?;
    (process.marfa_version.as_deref() != Some(this_version)).then(|| OtherBuild {
        pid: process.pid,
        marfa_version: process.marfa_version.clone(),
        this_version,
    })
}

fn tell(notice: &Notice, path: &Path, json: bool) {
    let running = running();
    let (value, human) = match notice {
        Notice::Restarting { version } => (
            json!({ "new_build": version, "running": running, "restarting": true }),
            format!(
                "restarting for a new build: marfa {running} to {version}; the watch ends once the passes under way finish, and the service manager starts {}",
                path.display()
            ),
        ),
        Notice::Installed { version } => (
            json!({ "new_build": version, "running": running, "restarting": false }),
            format!(
                "a new build of marfa is installed at {}: {version}, and this watch runs {running}; start the watch again to use it",
                path.display()
            ),
        ),
        Notice::Gone { reason } => (
            json!({ "new_build": null, "binary": path, "usable": false, "reason": reason }),
            format!(
                "{}, which this watch was started by, cannot be found ({reason}); the watch goes on, and looks for a new build there",
                path.display()
            ),
        ),
        Notice::Unusable { reason } => (
            json!({ "new_build": null, "binary": path, "usable": false, "reason": reason }),
            format!(
                "{} was replaced by a file that does not report a marfa version ({reason}); the watch goes on, and looks again",
                path.display()
            ),
        ),
    };
    let _ = output::line_of(&value, json, || human);
}

/// What a binary is on disk: the file a path leads to, links followed, and
/// that file's own identity, which an install that writes the file in place
/// changes as one that moves a link does.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Identity {
    target: PathBuf,
    device: u64,
    inode: u64,
    size: u64,
    modified: Option<SystemTime>,
}

impl Identity {
    fn of(path: &Path) -> std::io::Result<Identity> {
        let target = std::fs::canonicalize(path)?;
        let metadata = std::fs::metadata(&target)?;
        Ok(Identity {
            target,
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Notice {
    /// The watch ends for the new build.
    Restarting { version: String },
    /// A watch run by hand goes on.
    Installed { version: String },
    Gone { reason: String },
    Unusable { reason: String },
}

/// The last thing said, so each is said once.
#[derive(Debug, PartialEq, Eq)]
enum Said {
    Gone,
    Unusable(Identity),
    Installed(Identity),
}

struct Tracker {
    started: Identity,
    ends: bool,
    said: Option<Said>,
}

impl Tracker {
    fn new(started: Identity, ends: bool) -> Tracker {
        Tracker {
            started,
            ends,
            said: None,
        }
    }

    /// What there is to say of the path now, given what it leads to and how
    /// to ask the binary there its version. A binary that cannot say its
    /// version, as one half written or broken, is asked again at each look.
    fn look(
        &mut self,
        now: std::io::Result<Identity>,
        version_of: impl FnOnce(&Path) -> Result<String, String>,
    ) -> Option<Notice> {
        let now = match now {
            Ok(now) => now,
            Err(error) => {
                if self.said == Some(Said::Gone) {
                    return None;
                }
                self.said = Some(Said::Gone);
                return Some(Notice::Gone {
                    reason: error.to_string(),
                });
            }
        };
        if now == self.started {
            self.said = None;
            return None;
        }
        if self.said == Some(Said::Installed(now.clone())) {
            return None;
        }
        match version_of(&now.target) {
            Ok(version) if self.ends => Some(Notice::Restarting { version }),
            Ok(version) => {
                self.said = Some(Said::Installed(now));
                Some(Notice::Installed { version })
            }
            Err(_) if self.said == Some(Said::Unusable(now.clone())) => None,
            Err(reason) => {
                self.said = Some(Said::Unusable(now));
                Some(Notice::Unusable { reason })
            }
        }
    }
}

/// The version the binary at `binary` reports for `--version`, as
/// `marfa 0.0.56`, within `wait`. One that takes longer is stopped.
fn version_of(binary: &Path, wait: Duration) -> Result<String, String> {
    let mut child = Command::new(binary)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::ExecutableFileBusy => BUSY.to_string(),
            _ => error.to_string(),
        })?;
    let until = Instant::now() + wait;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "it did not say its version within {} seconds",
                    wait.as_secs_f32()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.to_string());
            }
        }
    };
    let mut said = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        stdout
            .read_to_string(&mut said)
            .map_err(|error| error.to_string())?;
    }
    if !status.success() {
        return Err(format!("`--version` ended with {status}"));
    }
    said.lines()
        .next()
        .and_then(|line| line.strip_prefix("marfa "))
        .map(str::trim)
        .filter(|version| !version.is_empty() && !version.contains(char::is_whitespace))
        .map(str::to_string)
        .ok_or_else(|| "it does not say a marfa version for `--version`".into())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// `version_of`, again while the file is busy: another test's process
    /// started between the write of the script and its close keeps it open
    /// for writing until that process runs its own program, and Linux will
    /// not run a file open for writing.
    fn asked(binary: &Path, wait: Duration) -> Result<String, String> {
        for _ in 0..100 {
            match version_of(binary, wait) {
                Err(reason) if reason == BUSY => std::thread::sleep(Duration::from_millis(10)),
                other => return other,
            }
        }
        version_of(binary, wait)
    }

    fn never(_: &Path) -> Result<String, String> {
        panic!("the binary was asked its version though nothing changed")
    }

    fn says(version: &str) -> impl FnOnce(&Path) -> Result<String, String> {
        let version = version.to_string();
        move |_| Ok(version)
    }

    #[test]
    fn a_link_moved_to_another_build_is_a_new_build() {
        let temp = tempfile::tempdir().unwrap();
        let old = script(temp.path(), "old", "echo marfa 0.0.55");
        let new = script(temp.path(), "new", "echo marfa 0.0.56");
        let link = temp.path().join("marfa");
        std::os::unix::fs::symlink(&old, &link).unwrap();
        let mut tracker = Tracker::new(Identity::of(&link).unwrap(), true);
        assert_eq!(tracker.look(Identity::of(&link), never), None);

        let moved = temp.path().join("marfa.new");
        std::os::unix::fs::symlink(&new, &moved).unwrap();
        std::fs::rename(&moved, &link).unwrap();
        // The old build is still there, as Homebrew leaves it until a cleanup.
        assert!(old.exists());
        assert_eq!(
            tracker.look(Identity::of(&link), says("0.0.56")),
            Some(Notice::Restarting {
                version: "0.0.56".into()
            })
        );
    }

    #[test]
    fn a_file_replaced_in_place_is_a_new_build() {
        let temp = tempfile::tempdir().unwrap();
        let binary = script(temp.path(), "marfa", "echo marfa 0.0.55");
        let mut tracker = Tracker::new(Identity::of(&binary).unwrap(), true);
        // Written over, keeping the file: the same inode, another size.
        std::fs::write(&binary, "#!/bin/sh\necho marfa 0.0.56 # a longer build\n").unwrap();
        assert_eq!(
            tracker.look(Identity::of(&binary), says("0.0.56")),
            Some(Notice::Restarting {
                version: "0.0.56".into()
            })
        );

        // Renamed over, as `cargo install` and a package manager do: another
        // inode, though the size may be the same.
        let mut tracker = Tracker::new(Identity::of(&binary).unwrap(), true);
        let staged = script(temp.path(), "staged", "echo marfa 0.0.57 # a longer build");
        std::fs::rename(&staged, &binary).unwrap();
        assert_eq!(
            tracker.look(Identity::of(&binary), says("0.0.57")),
            Some(Notice::Restarting {
                version: "0.0.57".into()
            })
        );
    }

    #[test]
    fn a_binary_gone_is_said_once_and_the_watch_ends_once_a_build_is_back() {
        let temp = tempfile::tempdir().unwrap();
        let old = script(temp.path(), "old", "echo marfa 0.0.55");
        let link = temp.path().join("marfa");
        std::os::unix::fs::symlink(&old, &link).unwrap();
        let mut tracker = Tracker::new(Identity::of(&link).unwrap(), true);

        // Mid-upgrade, or uninstalled: the link leads nowhere.
        std::fs::remove_file(&old).unwrap();
        assert!(matches!(
            tracker.look(Identity::of(&link), never),
            Some(Notice::Gone { .. })
        ));
        assert_eq!(tracker.look(Identity::of(&link), never), None);
        assert_eq!(tracker.look(Identity::of(&link), never), None);

        script(temp.path(), "old", "echo marfa 0.0.56 # the new build");
        assert_eq!(
            tracker.look(Identity::of(&link), says("0.0.56")),
            Some(Notice::Restarting {
                version: "0.0.56".into()
            })
        );
    }

    #[test]
    fn a_binary_that_does_not_say_its_version_is_said_once_and_asked_again() {
        let temp = tempfile::tempdir().unwrap();
        let binary = script(temp.path(), "marfa", "echo marfa 0.0.55");
        let mut tracker = Tracker::new(Identity::of(&binary).unwrap(), true);
        std::fs::write(&binary, "half a build").unwrap();
        assert_eq!(
            tracker.look(Identity::of(&binary), |_| Err("exec format error".into())),
            Some(Notice::Unusable {
                reason: "exec format error".into()
            })
        );
        let mut asked = false;
        assert_eq!(
            tracker.look(Identity::of(&binary), |_| {
                asked = true;
                Err("exec format error".into())
            }),
            None
        );
        assert!(asked, "a binary that could not say is asked again");
        // Once it can say, the watch ends for it.
        assert_eq!(
            tracker.look(Identity::of(&binary), says("0.0.56")),
            Some(Notice::Restarting {
                version: "0.0.56".into()
            })
        );
    }

    #[test]
    fn a_binary_put_back_as_it_was_is_no_new_build() {
        let temp = tempfile::tempdir().unwrap();
        let old = script(temp.path(), "old", "echo marfa 0.0.55");
        let link = temp.path().join("marfa");
        std::os::unix::fs::symlink(&old, &link).unwrap();
        let mut tracker = Tracker::new(Identity::of(&link).unwrap(), true);
        std::fs::remove_file(&link).unwrap();
        assert!(matches!(
            tracker.look(Identity::of(&link), never),
            Some(Notice::Gone { .. })
        ));
        std::os::unix::fs::symlink(&old, &link).unwrap();
        assert_eq!(tracker.look(Identity::of(&link), never), None);
        // Gone again after it came back is said again.
        std::fs::remove_file(&link).unwrap();
        assert!(matches!(
            tracker.look(Identity::of(&link), never),
            Some(Notice::Gone { .. })
        ));
    }

    #[test]
    fn the_same_version_installed_again_is_a_new_build() {
        let temp = tempfile::tempdir().unwrap();
        let binary = script(temp.path(), "marfa", "echo marfa 0.0.55");
        let mut tracker = Tracker::new(Identity::of(&binary).unwrap(), true);
        let staged = script(temp.path(), "staged", "echo marfa 0.0.55 # rebuilt");
        std::fs::rename(&staged, &binary).unwrap();
        assert_eq!(
            tracker.look(Identity::of(&binary), says("0.0.55")),
            Some(Notice::Restarting {
                version: "0.0.55".into()
            })
        );
    }

    #[test]
    fn a_watch_run_by_hand_says_a_new_build_once_and_goes_on() {
        let temp = tempfile::tempdir().unwrap();
        let binary = script(temp.path(), "marfa", "echo marfa 0.0.55");
        let mut tracker = Tracker::new(Identity::of(&binary).unwrap(), false);
        let staged = script(temp.path(), "staged", "echo marfa 0.0.56 # new");
        std::fs::rename(&staged, &binary).unwrap();
        assert_eq!(
            tracker.look(Identity::of(&binary), says("0.0.56")),
            Some(Notice::Installed {
                version: "0.0.56".into()
            })
        );
        assert_eq!(tracker.look(Identity::of(&binary), never), None);
        assert_eq!(tracker.look(Identity::of(&binary), never), None);
        // A build after that one is said too.
        let staged = script(temp.path(), "staged", "echo marfa 0.0.57 # newer");
        std::fs::rename(&staged, &binary).unwrap();
        assert_eq!(
            tracker.look(Identity::of(&binary), says("0.0.57")),
            Some(Notice::Installed {
                version: "0.0.57".into()
            })
        );
    }

    #[test]
    fn a_binary_is_asked_its_version_and_one_that_cannot_say_it_is_not_a_build() {
        let temp = tempfile::tempdir().unwrap();
        let wait = Duration::from_secs(5);
        let good = script(temp.path(), "good", "echo marfa 0.0.56");
        assert_eq!(asked(&good, wait), Ok("0.0.56".into()));
        let failing = script(temp.path(), "failing", "echo marfa 0.0.56; exit 1");
        assert!(asked(&failing, wait).is_err());
        let other = script(temp.path(), "other", "echo something 1.2.3");
        assert!(asked(&other, wait).is_err());
        let silent = script(temp.path(), "silent", "true");
        assert!(asked(&silent, wait).is_err());
        assert!(asked(&temp.path().join("missing"), wait).is_err());
        let plain = temp.path().join("plain");
        std::fs::write(&plain, "not a program").unwrap();
        assert!(asked(&plain, wait).is_err());
    }

    #[test]
    fn a_binary_that_hangs_is_given_up_on_and_stopped() {
        let temp = tempfile::tempdir().unwrap();
        let marker = temp.path().join("still running");
        let hangs = script(
            temp.path(),
            "hangs",
            &format!("sleep 2; touch '{}'", marker.display()),
        );
        let started = Instant::now();
        assert!(asked(&hangs, Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
        std::thread::sleep(Duration::from_secs(3));
        assert!(!marker.exists(), "the binary asked was left running");
    }

    #[test]
    fn status_names_a_current_watch_of_the_folder_that_runs_another_build() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("notes");
        std::fs::create_dir(&folder).unwrap();
        let now = SystemTime::now();
        let beat = chrono::DateTime::<chrono::Utc>::from(now).to_rfc3339();
        let old = chrono::DateTime::<chrono::Utc>::from(now - Duration::from_secs(60)).to_rfc3339();
        let entry = |pid: u32, version: Option<&str>, beat: &str, dir: &Path, watching: bool| {
            let mut entry = json!({
                "pid": pid,
                "heartbeat_at": beat,
                "heartbeat_interval_seconds": 5,
                "ended_at": null,
                "folders": [{ "dir": dir, "watching": watching, "reason": null }],
            });
            if let Some(version) = version {
                entry["marfa_version"] = json!(version);
            }
            entry
        };
        let file = |processes: Vec<serde_json::Value>| -> RecordFile {
            serde_json::from_value(json!({ "version": 1, "processes": processes })).unwrap()
        };
        let other = |file: &RecordFile, dir: &Path| other_build_in(file, dir, now, "0.0.56");

        // The witness: a current watch of the folder on 0.0.55 is named.
        let older = file(vec![entry(7, Some("0.0.55"), &beat, &folder, true)]);
        assert_eq!(
            other(&older, &folder),
            Some(OtherBuild {
                pid: 7,
                marfa_version: Some("0.0.55".into()),
                this_version: "0.0.56",
            })
        );
        // The same folder named through another path is the same folder.
        assert!(other(&older, &dir.path().join("notes/../notes")).is_some());
        assert!(
            other(&older, &folder)
                .unwrap()
                .describe()
                .contains("runs marfa 0.0.55, and this command is marfa 0.0.56")
        );
        // A build that wrote no version is an earlier one.
        let unnamed = file(vec![entry(7, None, &beat, &folder, true)]);
        assert_eq!(other(&unnamed, &folder).unwrap().marfa_version, None);

        let same = file(vec![entry(7, Some("0.0.56"), &beat, &folder, true)]);
        assert_eq!(other(&same, &folder), None);
        let stale = file(vec![entry(7, Some("0.0.55"), &old, &folder, true)]);
        assert_eq!(other(&stale, &folder), None);
        let not_watching = file(vec![entry(7, Some("0.0.55"), &beat, &folder, false)]);
        assert_eq!(other(&not_watching, &folder), None);
        let elsewhere = file(vec![entry(7, Some("0.0.55"), &beat, dir.path(), true)]);
        assert_eq!(other(&elsewhere, &folder), None);
    }
}
