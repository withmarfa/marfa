//! Faults a test harness sets on a running server, each named for where it acts.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::watch;

use super::housekeeping;
use crate::db::Pulse;

const MAX_NTH: u32 = 1_000_000;
const MAX_FREE_BYTES: u64 = 9_007_199_254_740_991;
const MAX_DEADLINE_MS: u64 = 2_147_483_647;

const BEAT: Duration = Duration::from_millis(25);
const JOB_POINT: &str = "housekeeping:";
/// What a `free` fault holds for a volume whose free space cannot be read.
const FREE_UNKNOWN: u64 = u64::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Hold,
    Fail,
    Refuse,
}

impl Kind {
    const fn prefix(self) -> &'static str {
        match self {
            Kind::Hold => "hold",
            Kind::Fail => "fail",
            Kind::Refuse => "refuse",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Argument {
    None,
    Nth,
    Write,
}

#[derive(Debug)]
pub struct Point {
    pub kind: Kind,
    pub name: &'static str,
    pub argument: Argument,
}

macro_rules! points {
    ($($constant:ident = $kind:ident $name:literal $argument:ident;)*) => {
        $(pub const $constant: &Point = &Point {
            kind: Kind::$kind,
            name: $name,
            argument: Argument::$argument,
        };)*
        const POINTS: &[&Point] = &[$($constant),*];
    };
}

points! {
    HOLD_WRITE = Hold "write" Write;
    HOLD_READ_HYDRATION = Hold "read-hydration" None;
    HOLD_READ_SNAPSHOT = Hold "read-snapshot" None;
    HOLD_THINNING_ITEM = Hold "version-thinning:item" None;
    HOLD_BULK_PAGE = Hold "bulk-page" Nth;
    HOLD_STREAM_OPEN = Hold "stream-open" None;
    HOLD_STREAM_HEAD = Hold "stream-head" None;
    HOLD_STREAM_REPLAY = Hold "stream-replay" None;
    FAIL_STREAM_HEAD = Fail "stream-head" Nth;
    FAIL_STREAM_REPLAY = Fail "stream-replay" Nth;
    FAIL_STREAM_CREDENTIAL = Fail "stream-credential" Nth;
    FAIL_STREAM_REPLAY_ROW = Fail "stream-replay-row" Nth;
    FAIL_STREAM_REPLAY_UNTYPED = Fail "stream-replay-untyped" Nth;
    FAIL_LOCK = Fail "lock" Nth;
    FAIL_AUDIT = Fail "audit" Write;
    FAIL_COMMIT = Fail "commit" Write;
    FAIL_COMMIT_FULL = Fail "commit-full" Write;
    FAIL_COMMIT_ACK = Fail "commit-ack" Write;
    FAIL_BLOB_WRITE = Fail "blob-write" Nth;
    FAIL_HEALTH_WRITE = Fail "health-write" Nth;
    REFUSE_READ = Refuse "read" None;
    REFUSE_WRITE = Refuse "write" None;
    REFUSE_WRITE_LOCK = Refuse "write-lock" None;
    REFUSE_BLOB_STORE = Refuse "blob-store" None;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Volume {
    Database,
    Blobs,
}

impl Volume {
    const fn name(self) -> &'static str {
        match self {
            Volume::Database => "free:database",
            Volume::Blobs => "free:blobs",
        }
    }
}

const FAIL_JOB: &Point = &Point {
    kind: Kind::Fail,
    name: "housekeeping:<job>",
    argument: Argument::Nth,
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Aim {
    action: Option<String>,
    nth: u32,
}

#[derive(Debug)]
struct Armed {
    name: String,
    arg: Option<String>,
    aim: Option<Aim>,
    seen: u32,
    fired: u32,
    number: Option<u64>,
    gate: watch::Sender<bool>,
    waiting: Arc<AtomicU64>,
    held_when_answered: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Listed {
    pub name: String,
    pub arg: Option<String>,
    pub waiting: u64,
    pub fired: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held_when_answered: Option<Vec<String>>,
}

#[must_use]
pub struct Released {
    names: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Faults {
    armed: Mutex<Vec<Armed>>,
}

fn point(kind: Kind, name: &str) -> Option<&'static Point> {
    POINTS
        .iter()
        .find(|point| point.kind == kind && point.name == name)
        .copied()
}

fn nth(text: &str) -> Option<u32> {
    let plain = text.bytes().all(|byte| byte.is_ascii_digit()) && !text.starts_with('0');
    plain
        .then(|| text.parse::<u32>().ok())
        .flatten()
        .filter(|value| (1..=MAX_NTH).contains(value))
}

fn is_action(text: &str) -> bool {
    let mut bytes = text.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_.-".contains(&byte)
        })
}

fn aim(point: &Point, arg: Option<&str>) -> Result<Option<Aim>, String> {
    let name = point.name;
    let Some(arg) = arg else {
        return Ok((point.argument != Argument::None).then_some(Aim {
            action: None,
            nth: 1,
        }));
    };
    if point.argument == Argument::None {
        return Err(format!("{name} takes no argument"));
    }
    if let Some(whole) = nth(arg) {
        return Ok(Some(Aim {
            action: None,
            nth: whole,
        }));
    }
    if point.argument != Argument::Write {
        return Err(format!(
            "{name} takes the number of the time it acts, from 1"
        ));
    }
    let (action, count) = match arg.rsplit_once('@') {
        Some((action, count)) => (action, nth(count)),
        None => (arg, Some(1)),
    };
    match count.filter(|_| is_action(action)) {
        Some(whole) => Ok(Some(Aim {
            action: Some(action.to_string()),
            nth: whole,
        })),
        None => Err(format!("{name} takes <n>, <action> or <action>@<n>")),
    }
}

fn judge_job(
    kind: &str,
    job: &str,
    arg: Option<&str>,
) -> Result<(Option<Aim>, Option<u64>), String> {
    if !housekeeping::is_job(job) {
        return Err(format!("no job is named {job}"));
    }
    match (kind, arg) {
        ("fail", _) if !housekeeping::runs_statements(job) => {
            Err(format!("{job} runs no database statement"))
        }
        ("fail", _) => Ok((aim(FAIL_JOB, arg)?, None)),
        ("hold" | "release", None) => Ok((None, None)),
        ("hold" | "release", Some(_)) => Err(format!("{kind}:{JOB_POINT}{job} takes no argument")),
        _ => Err(format!("{kind} is not a fault on a job")),
    }
}

fn deadline_of(job: &str, arg: Option<&str>) -> Result<u64, String> {
    if !housekeeping::is_job(job) {
        return Err(format!("no job is named {job}"));
    }
    arg.filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|ms| (1..=MAX_DEADLINE_MS).contains(ms))
        .ok_or_else(|| {
            format!("a deadline takes a whole number of ms, from 1 to {MAX_DEADLINE_MS}")
        })
}

fn judge(name: &str, arg: Option<&str>) -> Result<(Option<Aim>, Option<u64>), String> {
    let (kind, rest) = name.split_once(':').unwrap_or((name, ""));
    if let Some(job) = rest.strip_prefix(JOB_POINT) {
        return judge_job(kind, job, arg);
    }
    match kind {
        "hold" | "fail" | "refuse" => {
            let kind = match kind {
                "hold" => Kind::Hold,
                "fail" => Kind::Fail,
                _ => Kind::Refuse,
            };
            let found = point(kind, rest)
                .ok_or_else(|| format!("no {} point is named {rest}", kind.prefix()))?;
            Ok((aim(found, arg)?, None))
        }
        "release" => {
            point(Kind::Hold, rest).ok_or_else(|| format!("no hold point is named {rest}"))?;
            match arg {
                None => Ok((None, None)),
                Some(_) => Err("a release fault takes no argument".to_string()),
            }
        }
        "free" => {
            if rest != "database" && rest != "blobs" {
                return Err(format!("{rest} is not a volume: database or blobs"));
            }
            if arg == Some("unknown") {
                return Ok((None, Some(FREE_UNKNOWN)));
            }
            let bytes = arg
                .filter(|text| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|text| text.parse::<u64>().ok())
                .filter(|bytes| *bytes <= MAX_FREE_BYTES)
                .ok_or("a free fault takes a whole number of bytes, or unknown")?;
            Ok((None, Some(bytes)))
        }
        "deadline" => deadline_of(rest, arg).map(|ms| (None, Some(ms))),
        _ => Err(
            "a fault is named hold:<point>, fail:<point>, refuse:<point>, release:<point>, \
             deadline:<job> or free:<volume>"
                .to_string(),
        ),
    }
}

struct Waiting(Arc<AtomicU64>);

impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Faults {
    fn armed(&self) -> MutexGuard<'_, Vec<Armed>> {
        self.armed.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Re-arming starts a fault again; a hold's waiters stay held. A refused fault is never armed.
    pub fn set(&self, name: &str, arg: Option<&str>) -> Result<(), String> {
        let (aim, number) = judge(name, arg)?;
        let mut armed = self.armed();
        let arg = arg.map(str::to_string);
        if let Some(fault) = armed.iter_mut().find(|fault| fault.name == name) {
            fault.arg = arg;
            fault.aim = aim;
            fault.number = number;
            fault.seen = 0;
            fault.fired = 0;
            fault.held_when_answered = None;
        } else {
            armed.push(Armed {
                name: name.to_string(),
                arg,
                aim,
                seen: 0,
                fired: 0,
                number,
                gate: watch::Sender::new(false),
                waiting: Arc::default(),
                held_when_answered: None,
            });
        }
        Ok(())
    }

    pub fn clear(&self, name: Option<&str>) {
        self.armed().retain(|fault| {
            let keep = name.is_some_and(|name| fault.name != name);
            if !keep {
                fault.gate.send_replace(true);
            }
            keep
        });
    }

    pub fn list(&self) -> Vec<Listed> {
        self.armed()
            .iter()
            .map(|fault| Listed {
                name: fault.name.clone(),
                arg: fault.arg.clone(),
                waiting: fault.waiting.load(Ordering::SeqCst),
                fired: fault.fired,
                held_when_answered: fault.held_when_answered.clone(),
            })
            .collect()
    }

    /// An uncounted hold selects every caller.
    fn selected(
        &self,
        point: &str,
        action: Option<&str>,
    ) -> Option<(watch::Receiver<bool>, Waiting)> {
        let name = format!("hold:{point}");
        let mut armed = self.armed();
        let fault = armed.iter_mut().find(|fault| fault.name == name)?;
        if let Some(aim) = &fault.aim {
            if aim
                .action
                .as_deref()
                .is_some_and(|aimed| Some(aimed) != action)
            {
                return None;
            }
            fault.seen += 1;
            if fault.seen != aim.nth {
                return None;
            }
        }
        fault.waiting.fetch_add(1, Ordering::SeqCst);
        Some((fault.gate.subscribe(), Waiting(fault.waiting.clone())))
    }

    pub async fn hold(&self, point: &Point, action: Option<&str>) {
        if let Some((mut gate, _waiting)) = self.selected(point.name, action) {
            let _ = gate.wait_for(|open| *open).await;
        }
    }

    pub async fn hold_job(&self, job: &str) {
        let point = format!("{JOB_POINT}{job}");
        if let Some((mut gate, _waiting)) = self.selected(&point, None) {
            let _ = gate.wait_for(|open| *open).await;
        }
    }

    /// Holds a write that has an open transaction, beating so queued writes keep waiting.
    pub fn hold_beating(&self, point: &Point, pulse: &Pulse) {
        if let Some((gate, _waiting)) = self.selected(point.name, None) {
            while !*gate.borrow() {
                pulse.tick();
                std::thread::sleep(BEAT);
            }
        }
    }

    pub fn hold_blocking(&self, point: &Point) {
        if let Some((mut gate, _waiting)) = self.selected(point.name, None) {
            let _ = tokio::runtime::Handle::current()
                .block_on(gate.wait_for(|open| *open))
                .map(|_| ());
        }
    }

    pub fn fail(&self, point: &Point, action: Option<&str>) -> bool {
        self.fail_named(point.name, action)
    }

    pub fn fail_job(&self, job: &str) -> bool {
        self.fail_named(&format!("{JOB_POINT}{job}"), None)
    }

    fn fail_named(&self, point: &str, action: Option<&str>) -> bool {
        let name = format!("fail:{point}");
        let mut armed = self.armed();
        let Some(fault) = armed.iter_mut().find(|fault| fault.name == name) else {
            return false;
        };
        let Some(aim) = &fault.aim else {
            return false;
        };
        if aim
            .action
            .as_deref()
            .is_some_and(|aimed| Some(aimed) != action)
        {
            return false;
        }
        fault.seen += 1;
        if fault.seen != aim.nth {
            return false;
        }
        fault.fired += 1;
        true
    }

    pub fn deadline(&self, job: &str) -> Option<Duration> {
        let name = format!("deadline:{job}");
        self.armed()
            .iter()
            .find(|fault| fault.name == name)
            .and_then(|fault| fault.number)
            .map(Duration::from_millis)
    }

    /// What a `free` fault sets for the volume: its bytes, or `None` for free space that cannot be read.
    pub fn free(&self, volume: Volume) -> Option<Option<u64>> {
        self.armed()
            .iter()
            .find(|fault| fault.name == volume.name())
            .and_then(|fault| fault.number)
            .map(|bytes| (bytes != FREE_UNKNOWN).then_some(bytes))
    }

    /// Whether `refuse:<point>` is armed, without counting a refusal.
    pub fn is_refusing(&self, point: &Point) -> bool {
        let name = format!("refuse:{}", point.name);
        self.armed().iter().any(|fault| fault.name == name)
    }

    /// Whether `refuse:<point>` is armed. Each call that finds it counts one refusal.
    pub fn refusing(&self, point: &Point) -> bool {
        let name = format!("refuse:{}", point.name);
        let mut armed = self.armed();
        let Some(fault) = armed.iter_mut().find(|fault| fault.name == name) else {
            return false;
        };
        fault.fired += 1;
        true
    }

    pub fn health_admitted(&self) -> Option<Released> {
        let mut armed = self.armed();
        let mut names = Vec::new();
        let mut holds = Vec::new();
        for fault in armed.iter_mut() {
            if let Some(point) = fault.name.strip_prefix("release:")
                && fault.fired == 0
            {
                fault.fired = 1;
                names.push(fault.name.clone());
                holds.push(format!("hold:{point}"));
            }
        }
        armed.retain(|fault| {
            let keep = !holds.contains(&fault.name);
            if !keep {
                fault.gate.send_replace(true);
            }
            keep
        });
        (!names.is_empty()).then_some(Released { names })
    }

    pub fn health_answered(&self, released: Released) {
        let mut armed = self.armed();
        let held: Vec<String> = armed
            .iter()
            .filter(|fault| {
                fault.name.starts_with("hold:") && fault.waiting.load(Ordering::SeqCst) > 0
            })
            .map(|fault| fault.name.clone())
            .collect();
        for fault in armed.iter_mut() {
            if released.names.contains(&fault.name) {
                fault.held_when_answered = Some(held.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn refused(name: &str, arg: Option<&str>) -> bool {
        let faults = Faults::default();
        let refused = faults.set(name, arg).is_err();
        assert_eq!(faults.list().is_empty(), refused, "{name}");
        refused
    }

    #[test]
    fn refuses_what_is_not_registered_and_arms_nothing() {
        assert!(refused("hold:nowhere", None));
        assert!(refused("fail:nowhere", None));
        assert!(refused("release:nowhere", None));
        assert!(refused("deadline:no-such-job", Some("1")));
        assert!(refused("free:elsewhere", Some("1")));
        assert!(refused("free:database", Some("9007199254740992")));
        assert!(refused("free:database", None));
        assert!(refused("something", None));
        assert!(refused("refuse:nowhere", None));
        assert!(refused("refuse:read", Some("1")));
        assert!(refused("free:database", Some("lots")));
        assert!(refused("hold:read-snapshot", Some("1")));
        assert!(refused("fail:lock", Some("item.create")));
        assert!(refused("fail:lock", Some("0")));
        assert!(refused("fail:lock", Some("01")));
        assert!(refused("fail:lock", Some("1000001")));
        assert!(refused("hold:write", Some("<action>@<n>")));
        assert!(refused("hold:write", Some("Item@1")));
        assert!(refused("hold:write", Some("item@")));
    }

    #[test]
    fn takes_a_job_only_by_a_name_this_build_runs() {
        assert!(refused("hold:housekeeping:no-such-job", None));
        assert!(refused("release:housekeeping:no-such-job", None));
        assert!(refused("fail:housekeeping:no-such-job", None));
        assert!(refused("fail:housekeeping:heartbeat", None));
        assert!(refused("deadline:trash-purge", None));
        assert!(refused("deadline:trash-purge", Some("0")));
        assert!(refused("deadline:trash-purge", Some("2147483648")));
        assert!(!refused("hold:housekeeping:trash-purge", None));
        assert!(!refused("release:housekeeping:trash-purge", None));
        assert!(!refused("fail:housekeeping:trash-purge", Some("2")));
        assert!(!refused("deadline:trash-purge", Some("300")));
    }

    #[test]
    fn a_refusal_stays_until_cleared_and_counts_each_refusal() {
        let faults = Faults::default();
        faults.set("refuse:read", None).unwrap();
        assert!(faults.refusing(REFUSE_READ));
        assert!(faults.refusing(REFUSE_READ));
        assert!(!faults.refusing(REFUSE_WRITE));
        assert_eq!(faults.list()[0].fired, 2);
        faults.clear(None);
        assert!(!faults.refusing(REFUSE_READ));
    }

    #[test]
    fn free_space_is_set_in_bytes_or_unknown() {
        let faults = Faults::default();
        assert_eq!(faults.free(Volume::Blobs), None);
        faults.set("free:blobs", Some("2048")).unwrap();
        assert_eq!(faults.free(Volume::Blobs), Some(Some(2048)));
        faults.set("free:blobs", Some("unknown")).unwrap();
        assert_eq!(faults.free(Volume::Blobs), Some(None));
    }

    #[test]
    fn takes_the_points_the_fixtures_arm() {
        for (name, arg) in [
            ("hold:bulk-page", Some("2")),
            ("fail:health-write", None),
            ("refuse:read", None),
            ("refuse:write", None),
            ("refuse:write-lock", None),
            ("refuse:blob-store", None),
            ("free:database", Some("unknown")),
        ] {
            assert!(!refused(name, arg), "{name}");
        }
        assert!(refused("hold:bulk-page", Some("two")));
    }

    #[test]
    fn takes_every_form_of_a_write_argument() {
        for arg in [None, Some("3"), Some("item.create"), Some("item.create@2")] {
            assert!(!refused("fail:commit", arg));
        }
    }

    #[test]
    fn a_fail_acts_once_on_the_reach_it_is_aimed_at() {
        let faults = Faults::default();
        faults.set("fail:commit", Some("item.create@2")).unwrap();
        assert!(!faults.fail(FAIL_COMMIT, Some("item.update")));
        assert!(!faults.fail(FAIL_COMMIT, Some("item.create")));
        assert!(faults.fail(FAIL_COMMIT, Some("item.create")));
        assert!(!faults.fail(FAIL_COMMIT, Some("item.create")));
        assert_eq!(faults.list()[0].fired, 1);
    }

    #[tokio::test]
    async fn a_hold_waits_until_it_is_cleared_and_counts_who_waits() {
        let faults = Arc::new(Faults::default());
        faults.set("hold:write", Some("key.create")).unwrap();
        let held = {
            let faults = faults.clone();
            tokio::spawn(async move { faults.hold(HOLD_WRITE, Some("key.create")).await })
        };
        while faults.list()[0].waiting == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        faults.hold(HOLD_WRITE, Some("key.create")).await;
        assert!(!held.is_finished());
        faults.clear(None);
        held.await.unwrap();
    }

    #[tokio::test]
    async fn a_release_clears_its_hold_when_health_is_admitted() {
        let faults = Faults::default();
        faults.set("hold:read-snapshot", None).unwrap();
        faults.set("hold:read-hydration", None).unwrap();
        faults.set("release:read-snapshot", None).unwrap();
        let released = faults.health_admitted().unwrap();
        assert!(faults.health_admitted().is_none());
        faults.health_answered(released);
        let listed = faults.list();
        let names: Vec<&str> = listed.iter().map(|fault| fault.name.as_str()).collect();
        assert_eq!(names, ["hold:read-hydration", "release:read-snapshot"]);
        assert_eq!(listed[1].fired, 1);
        assert_eq!(listed[1].held_when_answered, Some(Vec::new()));
    }
}
