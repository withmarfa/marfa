use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::{Folder, PullReport, StatusReport, elsewhere, state};
use crate::http::{Call, CallBody, Method};
use crate::{CoreError, Result, store};

const META: &str = "folder_health";
const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Code {
    Conflict,
    Refused,
    CredentialRefused,
    Unreadable,
    HeldFile,
    Unavailable,
    RootGone,
    SettingsInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Problem {
    pub(super) code: Code,
    pub(super) count: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Snapshot {
    pub(super) last_success_at: Option<String>,
    pub(super) pending_uploads: u64,
    pub(super) pending_downloads: u64,
    pub(super) paused_removals: u64,
    pub(super) first_sync_waiting: bool,
    pub(super) problems: Vec<Problem>,
}

#[cfg(test)]
impl Snapshot {
    pub(super) fn succeeded(at: &str) -> Snapshot {
        Snapshot {
            last_success_at: Some(at.into()),
            ..Snapshot::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Report {
    folder_store_id: String,
    sequence: u64,
    #[serde(flatten)]
    snapshot: Snapshot,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct State {
    sequence: u64,
    pending: Option<Report>,
    observed: Option<Snapshot>,
    last_success_at: Option<String>,
    downloads: u64,
    download_problems: Vec<Problem>,
    failures: u32,
    retry_at: u64,
}

#[derive(Debug, Deserialize)]
struct Ack {
    sequence: u64,
    received_at: String,
    accepted: bool,
}

impl State {
    fn load(conn: &rusqlite::Connection) -> Result<Self> {
        let state: Self = store::meta_get(conn, META)?
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default();
        if state.sequence > MAX_SAFE
            || state
                .pending
                .as_ref()
                .is_some_and(|report| report.sequence == 0 || report.sequence > state.sequence)
        {
            return Err(CoreError::Invalid(
                "invalid saved folder health sequence".into(),
            ));
        }
        Ok(state)
    }

    fn save(&self, conn: &rusqlite::Connection) -> Result<()> {
        store::meta_set(conn, META, &serde_json::to_string(self)?)
    }

    fn reserve(&mut self, id: &str, snapshot: Snapshot, refresh: bool) -> Result<()> {
        if !refresh
            && self.observed.as_ref() == Some(&snapshot)
            && self
                .pending
                .as_ref()
                .is_none_or(|pending| pending.sequence == self.sequence)
        {
            return Ok(());
        }
        let sequence = self
            .sequence
            .checked_add(1)
            .filter(|next| *next <= MAX_SAFE)
            .ok_or_else(|| CoreError::Invalid("folder health sequence is exhausted".into()))?;
        self.sequence = sequence;
        self.observed = Some(snapshot.clone());
        self.pending = Some(Report {
            folder_store_id: id.into(),
            sequence,
            snapshot,
        });
        Ok(())
    }

    fn acknowledge(&mut self, sent: &Report, ack: &Ack) -> Result<()> {
        if ack.sequence == 0
            || ack.sequence > MAX_SAFE
            || ack.sequence < sent.sequence
            || !valid_time(&ack.received_at)
            || (ack.accepted && ack.sequence != sent.sequence)
        {
            return Err(CoreError::Invalid("invalid folder health receipt".into()));
        }
        // Valid receipts retain server knowledge even when their payload has
        // been superseded. Only the current attempt may settle its outbox.
        self.sequence = self.sequence.max(ack.sequence);
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending.sequence != sent.sequence)
        {
            return Ok(());
        }
        if ack.accepted {
            self.pending = None;
        }
        self.failures = 0;
        self.retry_at = 0;
        Ok(())
    }

    fn failed(&mut self, error: &CoreError) {
        let backoff = 1_u64 << self.failures.min(5);
        let wait = error
            .retry_after()
            .unwrap_or(Duration::from_secs(backoff.min(30)));
        self.failures = self.failures.saturating_add(1);
        self.retry_at = millis().saturating_add(wait.as_millis().min(u64::MAX as u128) as u64);
    }
}

fn valid_time(time: &str) -> bool {
    time.len() == 24 && time.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(time).is_ok()
}

fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn count(value: usize) -> u64 {
    (value as u64).min(MAX_SAFE)
}

fn problem_of(flag: &str) -> Option<Code> {
    match flag {
        "removal" | "search" | "gone" => None,
        "refused" => Some(Code::Refused),
        "credential_refused" => Some(Code::CredentialRefused),
        "encoding" | "unreadable" => Some(Code::Unreadable),
        _ => Some(Code::HeldFile),
    }
}

fn local_snapshot(status: &StatusReport) -> Snapshot {
    let mut problems = BTreeMap::new();
    for file in &status.files {
        if file.flag == Some("unreadable")
            && status.directories.iter().any(|entry| {
                entry.flag == "unreadable"
                    && (entry.path.is_empty()
                        || file
                            .path
                            .strip_prefix(&entry.path)
                            .is_some_and(|rest| rest.starts_with('/')))
            })
        {
            continue;
        }
        if let Some(code) = file.flag.and_then(problem_of) {
            *problems.entry(code).or_insert(0) += 1;
        }
    }
    for directory in &status.directories {
        match directory.flag {
            "unreadable" => *problems.entry(Code::Unreadable).or_insert(0) += 1,
            "gone" => *problems.entry(Code::HeldFile).or_insert(0) += 1,
            _ => {}
        }
    }
    Snapshot {
        pending_uploads: count(
            status
                .files
                .iter()
                .filter(|file| file.status == "waiting")
                .count(),
        ),
        paused_removals: count(status.paused.disk.saturating_add(status.paused.pull)),
        first_sync_waiting: status.first_sync.is_some(),
        problems: problems
            .into_iter()
            .map(|(code, count)| Problem { code, count })
            .collect(),
        ..Snapshot::default()
    }
}

fn observed_downloads(pull: &PullReport) -> (u64, Vec<Problem>) {
    let mut pending = HashSet::new();
    let mut blocked = HashSet::new();
    for file in &pull.flagged {
        if matches!(file.flag, "unwritten" | "absent" | "outside" | "unsuited") {
            let identity = file.item.as_deref().unwrap_or(&file.path);
            pending.insert(identity);
            if file.flag != "absent" {
                blocked.insert(identity);
            }
        }
    }
    let problems = if blocked.is_empty() {
        Vec::new()
    } else {
        vec![Problem {
            code: Code::HeldFile,
            count: count(blocked.len()),
        }]
    };
    (count(pending.len()), problems)
}

impl Folder {
    /// The snapshot last observed for the report to the server, as saved in
    /// the folder's store.
    pub(super) fn observed_health(&self) -> Option<Snapshot> {
        State::load(&*self.core.conn().ok()?).ok()?.observed
    }

    /// Reporting is independent of the content queue. Its failure cannot
    /// turn a successful content operation into a failed one.
    pub(super) fn health_observe(
        &self,
        complete: bool,
        refresh: bool,
        pull: Option<&PullReport>,
        error: Option<&CoreError>,
        settings_problem: bool,
    ) {
        let _ = self.health_observe_inner(complete, refresh, pull, error, settings_problem);
    }

    fn health_observe_inner(
        &self,
        complete: bool,
        refresh: bool,
        pull: Option<&PullReport>,
        error: Option<&CoreError>,
        settings_problem: bool,
    ) -> Result<()> {
        let id = elsewhere::store_id(&self.core)?;
        let previous = State::load(&*self.core.conn()?)?.observed;
        let status = self.status();
        let known = status.is_ok();
        let inventory_complete = status.as_ref().is_ok_and(StatusReport::inventory_complete);
        let mut snapshot = match status {
            Ok(status) => local_snapshot(&status),
            Err(_) => {
                let mut snapshot = previous.clone().unwrap_or_default();
                snapshot.first_sync_waiting = self
                    .awaiting_confirmation()
                    .unwrap_or(snapshot.first_sync_waiting);
                let code = if self.root_gone().is_some() {
                    Code::RootGone
                } else {
                    Code::SettingsInvalid
                };
                snapshot.problems.retain(|problem| {
                    !matches!(problem.code, Code::RootGone | Code::SettingsInvalid)
                });
                snapshot.problems.push(Problem { code, count: 1 });
                snapshot
            }
        };
        if !inventory_complete && let Some(previous) = &previous {
            snapshot.pending_uploads = snapshot.pending_uploads.max(previous.pending_uploads);
        }
        if let Ok(conflicts) = self.current_conflicts() {
            snapshot
                .problems
                .retain(|problem| problem.code != Code::Conflict);
            if conflicts > 0 {
                snapshot.problems.push(Problem {
                    code: Code::Conflict,
                    count: conflicts,
                });
            }
        }
        let conn = self.core.conn()?;
        let mut state = State::load(&conn)?;
        if let Some(pull) = pull {
            if pull.root_gone.is_none() {
                (state.downloads, state.download_problems) = observed_downloads(pull);
            }
            if pull.root_gone.is_some()
                && !snapshot.problems.iter().any(|p| p.code == Code::RootGone)
            {
                snapshot.problems.push(Problem {
                    code: Code::RootGone,
                    count: 1,
                });
            }
        }
        snapshot.pending_downloads = state.downloads;
        if known {
            snapshot.problems.extend(state.download_problems.clone());
        }
        if settings_problem {
            snapshot.problems.push(Problem {
                code: Code::SettingsInvalid,
                count: 1,
            });
        }
        if let Some(error) = error {
            snapshot.problems.push(Problem {
                code: if matches!(error, CoreError::Unauthorized { .. }) {
                    Code::CredentialRefused
                } else {
                    Code::Unavailable
                },
                count: 1,
            });
        }
        if !complete
            && error.is_none()
            && let Some(previous) = &state.observed
        {
            snapshot.problems.extend(
                previous
                    .problems
                    .iter()
                    .filter(|p| matches!(p.code, Code::Unavailable | Code::CredentialRefused))
                    .cloned(),
            );
        }
        let mut problems = BTreeMap::new();
        for problem in snapshot.problems {
            let entry = problems.entry(problem.code).or_insert(0_u64);
            *entry = if matches!(
                problem.code,
                Code::Unavailable
                    | Code::CredentialRefused
                    | Code::RootGone
                    | Code::SettingsInvalid
            ) {
                1
            } else {
                entry.saturating_add(problem.count).min(MAX_SAFE)
            };
        }
        snapshot.problems = problems
            .into_iter()
            .map(|(code, count)| Problem { code, count })
            .collect();
        if complete
            && inventory_complete
            && snapshot.pending_uploads == 0
            && snapshot.pending_downloads == 0
            && snapshot.paused_removals == 0
            && !snapshot.first_sync_waiting
            && snapshot.problems.is_empty()
        {
            state.last_success_at = Some(store::now_iso());
        }
        snapshot.last_success_at = state.last_success_at.clone();
        state.reserve(&id, snapshot, refresh)?;
        state.save(&conn)
    }

    fn current_conflicts(&self) -> Result<u64> {
        let bounds = state::every_bound(&*self.core.conn()?)?;
        let mut copies = HashSet::new();
        for bound in bounds {
            if self
                .core
                .get(&bound.item_id)?
                .is_some_and(|item| item.state != crate::model::ItemState::Trashed)
                && self
                    .core
                    .original_of_conflicted_copy(&bound.item_id)?
                    .is_some()
            {
                copies.insert(bound.item_id.clone());
            }
            for copy in self.core.conflicted_copies_of(&bound.item_id)? {
                copies.insert(copy.id);
            }
        }
        Ok(count(copies.len()))
    }

    fn health_refresh_for_receipt(&self, floor: u64) -> Result<()> {
        let current = State::load(&*self.core.conn()?)?;
        if current
            .pending
            .as_ref()
            .is_none_or(|pending| pending.sequence > floor)
        {
            return Ok(());
        }
        let error = current.observed.as_ref().and_then(|snapshot| {
            snapshot.problems.iter().find_map(|p| match p.code {
                Code::Unavailable => Some(CoreError::Network("unavailable".into())),
                Code::CredentialRefused => Some(CoreError::Unauthorized {
                    code: "unauthorized".into(),
                    message: "credential refused".into(),
                }),
                _ => None,
            })
        });
        let settings = current.observed.as_ref().is_some_and(|snapshot| {
            snapshot
                .problems
                .iter()
                .any(|p| p.code == Code::SettingsInvalid)
        });
        self.health_observe_inner(false, true, None, error.as_ref(), settings)
    }

    pub(super) fn health_send(&self) {
        let _ = self.health_send_inner();
    }

    fn health_send_inner(&self) -> Result<()> {
        // An expired copy, whether another instance answered at its origin or
        // its reach changed, sends nothing until it is built again; the report
        // waits for that.
        if !store::hydrated(&*self.core.conn()?)? {
            return Ok(());
        }
        let current = State::load(&*self.core.conn()?)?;
        if current.retry_at > millis() {
            return Ok(());
        }
        if current
            .pending
            .as_ref()
            .is_some_and(|pending| pending.sequence < current.sequence)
        {
            self.health_refresh_for_receipt(current.sequence)?;
        }
        let sent = {
            let conn = self.core.conn()?;
            let state = State::load(&conn)?;
            if state.retry_at > millis() {
                return Ok(());
            }
            let Some(report) = state.pending else {
                return Ok(());
            };
            report
        };
        let result = (|| {
            let body = serde_json::to_string(&sent)?;
            let http = self.core.http()?.for_reporting()?;
            let reply = crate::catch_up::write_naming_instance(&self.core, &http, |http| {
                let reply = http.call(Call {
                    method: Method::Put,
                    segments: &["folders", &self.folder, "status"],
                    params: &[],
                    headers: &[],
                    body: CallBody::Json(&body),
                    credential: true,
                    stream: false,
                })?;
                if !(200..300).contains(&reply.status) {
                    return Err(http.refused(
                        reply.status,
                        reply.contract.is_some(),
                        &reply.body,
                        reply.retry_after_seconds,
                    ));
                }
                Ok(reply)
            })?;
            let ack: Ack = serde_json::from_str(&reply.body)?;
            {
                let conn = self.core.conn()?;
                let mut state = State::load(&conn)?;
                state.acknowledge(&sent, &ack)?;
                state.save(&conn)?;
            }
            if !ack.accepted {
                // Resequencing observes current disk and problem state after
                // persisting the floor; the in-flight body is never reused.
                self.health_refresh_for_receipt(ack.sequence)?;
            }
            Ok(())
        })();
        if let Err(error) = &result {
            let conn = self.core.conn()?;
            let mut state = State::load(&conn)?;
            state.failed(error);
            state.save(&conn)?;
        }
        result
    }

    pub(super) fn health_follow(&self, ended: &AtomicBool) {
        while !ended.load(Ordering::SeqCst) {
            self.health_send();
            for _ in 0..10 {
                if ended.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{FileStatus, Flagged, Paused};
    use super::*;

    fn receipt(sequence: u64, accepted: bool) -> Ack {
        Ack {
            sequence,
            accepted,
            received_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn pending_reports_survive_restart_and_coalesce_before_retry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("core.sqlite");
        let conn = store::open(&path).unwrap();
        let mut state = State::default();
        state
            .reserve(
                "opaque",
                Snapshot {
                    pending_uploads: 1,
                    ..Snapshot::default()
                },
                false,
            )
            .unwrap();
        let sent = state.pending.clone().unwrap();
        state
            .reserve(
                "opaque",
                Snapshot {
                    pending_uploads: 3,
                    ..Snapshot::default()
                },
                false,
            )
            .unwrap();
        state.save(&conn).unwrap();
        drop(conn);
        let conn = store::open(&path).unwrap();
        let mut recovered = State::load(&conn).unwrap();
        assert_eq!(
            recovered.pending.as_ref().unwrap().snapshot.pending_uploads,
            3
        );
        recovered.acknowledge(&sent, &receipt(1, true)).unwrap();
        assert_eq!(recovered.pending.as_ref().unwrap().sequence, 2);
        assert_eq!(sent.snapshot.pending_uploads, 1);
        let latest = recovered.pending.clone().unwrap();
        recovered.acknowledge(&latest, &receipt(2, true)).unwrap();
        assert!(recovered.pending.is_none());
    }

    #[test]
    fn a_restored_backup_resequences_the_latest_pending_intent() {
        let mut state = State::default();
        state.reserve("opaque", Snapshot::default(), false).unwrap();
        let sent = state.pending.clone().unwrap();
        state
            .reserve(
                "opaque",
                Snapshot {
                    pending_uploads: 4,
                    ..Snapshot::default()
                },
                false,
            )
            .unwrap();
        let newer = state.pending.clone().unwrap();
        state.acknowledge(&sent, &receipt(50, false)).unwrap();
        assert_eq!(state.pending.as_ref().unwrap().sequence, 2);
        assert_eq!(state.sequence, 50);
        state.acknowledge(&newer, &receipt(50, false)).unwrap();
        assert_eq!(state.pending.as_ref().unwrap().sequence, 2);
        // A fresh observation, even if unchanged, allocates above the floor.
        state
            .reserve(
                "opaque",
                Snapshot {
                    pending_uploads: 4,
                    ..Snapshot::default()
                },
                false,
            )
            .unwrap();
        let pending = state.pending.as_ref().unwrap();
        assert_eq!(pending.sequence, 51);
        assert_eq!(pending.snapshot.pending_uploads, 4);
        state.acknowledge(&sent, &receipt(1, true)).unwrap();
        assert_eq!(state.pending.as_ref().unwrap().sequence, 51);
    }

    #[test]
    fn reporting_failure_keeps_content_observations_and_caps_backoff() {
        let mut state = State::default();
        state
            .reserve(
                "opaque",
                Snapshot {
                    pending_uploads: 4,
                    ..Snapshot::default()
                },
                false,
            )
            .unwrap();
        let original = state.pending.clone();
        for _ in 0..20 {
            state.failed(&CoreError::Network("private reason".into()));
        }
        assert_eq!(state.pending, original);
        assert!(state.retry_at <= millis() + 30_000);
        assert!(state.retry_at >= millis() + 29_000);
        state.failed(&CoreError::RateLimited {
            retry_after_seconds: Some(90),
            code: "rate_limited".into(),
            message: "limited".into(),
        });
        assert!(state.retry_at >= millis() + 89_000);
    }

    #[test]
    fn aggregates_count_files_and_never_serialize_private_fields() {
        let file = |path: &str, flag, status| FileStatus {
            path: path.into(),
            item_id: Some("secret-item".into()),
            status,
            waits: vec!["edit", "tag", "upload"],
            flag,
            reason: Some("private content and /private/path".into()),
            warning: Some("private hash".into()),
        };
        let status = StatusReport {
            files: vec![
                file("secret.md", None, "waiting"),
                file("paused.md", Some("removal"), "held"),
                file("bad.md", Some("unreadable"), "held"),
            ],
            paused: Paused { disk: 1, pull: 2 },
            directories: Vec::new(),
            first_sync: None,
        };
        let snapshot = local_snapshot(&status);
        assert_eq!(snapshot.pending_uploads, 1);
        assert_eq!(snapshot.paused_removals, 3);
        assert_eq!(
            snapshot.problems,
            vec![Problem {
                code: Code::Unreadable,
                count: 1
            }]
        );
        let body = serde_json::to_string(&snapshot).unwrap();
        for private in ["secret", "private", "hash", "reason", "path", "waits"] {
            assert!(!body.contains(private));
        }
        let pull = PullReport {
            flagged: vec![Flagged {
                path: "secret.md".into(),
                flag: "absent",
                reason: "private".into(),
                item: Some("item".into()),
            }],
            ..PullReport::default()
        };
        assert_eq!(observed_downloads(&pull).0, 1);
    }

    #[test]
    fn a_document_the_scan_holds_for_its_type_is_a_refusal_not_an_upload_waiting() {
        let held = FileStatus {
            path: "unknown.md".into(),
            item_id: None,
            status: "held",
            waits: Vec::new(),
            flag: Some("refused"),
            reason: Some("example.unknown is not a type this copy holds".into()),
            warning: None,
        };
        let snapshot = local_snapshot(&StatusReport {
            files: vec![held],
            ..StatusReport::default()
        });
        assert_eq!(snapshot.pending_uploads, 0);
        assert_eq!(
            snapshot.problems,
            vec![Problem {
                code: Code::Refused,
                count: 1
            }]
        );
    }

    #[test]
    fn safe_integer_exhaustion_and_invalid_receipts_preserve_pending() {
        let mut state = State {
            sequence: MAX_SAFE,
            ..State::default()
        };
        assert!(state.reserve("opaque", Snapshot::default(), false).is_err());
        let mut state = State::default();
        state.reserve("opaque", Snapshot::default(), false).unwrap();
        let sent = state.pending.clone().unwrap();
        assert!(
            state
                .acknowledge(&sent, &receipt(MAX_SAFE + 1, true))
                .is_err()
        );
        assert_eq!(state.pending, Some(sent));
    }

    fn fixture(server: Option<crate::Server>) -> (tempfile::TempDir, Folder) {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let state_path = dir.path().join(super::super::STATE_DIR);
        std::fs::create_dir(&state_path).unwrap();
        let path = state_path.join("core.sqlite");
        let core = crate::Core::open(&path, server).unwrap();
        {
            let conn = core.conn().unwrap();
            for (key, value) in [
                (store::META_SLICE_TYPES, "[\"core.note\"]"),
                (store::META_SLICE_TIER, "library"),
                (store::META_EVENT_CURSOR, "1"),
                (crate::reach::FENCE, crate::scripted::FENCE),
                (store::META_INSTANCE_ID, crate::scripted::INSTANCE),
            ] {
                store::meta_set(&conn, key, value).unwrap();
            }
            store::upsert_item(
                &conn,
                &store::testing::wire_item(
                    "folder",
                    "system.folder",
                    "active",
                    "2026-01-01T00:00:00Z",
                    serde_json::json!({"search":{"types":["core.note"]}}),
                ),
                None,
                &crate::catalog::Indexing::default(),
            )
            .unwrap();
        }
        let root_dir = crate::directory::Directory::open(dir.path()).unwrap();
        let state_dir = crate::directory::Directory::open(&state_path).unwrap();
        let store_mark = state_dir
            .entry_identity(std::path::Path::new("core.sqlite"))
            .unwrap();
        let folder = Folder {
            root: dir.path().into(),
            folder: "folder".into(),
            core,
            key: std::sync::Mutex::new(None),
            unread_give_ways: std::sync::Mutex::new(Default::default()),
            permissions: std::sync::OnceLock::new(),
            refused_renames: std::sync::Mutex::new(Default::default()),
            root_dir,
            state_dir,
            store_mark,
        };
        (dir, folder)
    }

    #[test]
    fn an_offline_clean_copy_does_not_claim_a_full_success() {
        let (_dir, folder) = fixture(None);
        folder.health_observe(false, true, Some(&PullReport::default()), None, false);
        let state = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(state.last_success_at, None);
        folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        let successful = State::load(&folder.core.conn().unwrap()).unwrap();
        assert!(
            successful.last_success_at.is_some(),
            "a confirmed full pass is the witness"
        );
        folder.health_observe(
            false,
            true,
            None,
            Some(&CoreError::Network("private failure".into())),
            false,
        );
        folder.health_observe(false, false, Some(&PullReport::default()), None, false);
        let later = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(later.last_success_at, successful.last_success_at);
        assert!(
            later
                .observed
                .unwrap()
                .problems
                .iter()
                .any(|p| p.code == Code::Unavailable)
        );
    }

    #[test]
    fn kept_conflict_bytes_stop_counting_when_the_copy_is_resolved() {
        let (_dir, folder) = fixture(None);
        let note = |id| {
            store::testing::wire_item(
                id,
                "core.note",
                "active",
                "2026-01-01T00:00:00Z",
                serde_json::json!({"title":"Note"}),
            )
        };
        let copy = note("copy");
        {
            let conn = folder.core.conn().unwrap();
            store::upsert_item(
                &conn,
                &note("original"),
                None,
                &crate::catalog::Indexing::default(),
            )
            .unwrap();
            store::upsert_item(&conn, &copy, None, &crate::catalog::Indexing::default()).unwrap();
            store::add_tags(&conn, "copy", &[crate::CONFLICTED_COPY_TAG.into()]).unwrap();
            let edge = crate::wire::WireEdge {
                id: "derivation".into(),
                source_id: "copy".into(),
                target_id: "original".into(),
                edge_type: crate::CONFLICTED_COPY_EDGE.into(),
                properties: Default::default(),
                version: 1,
                created_at: "2026-01-01T00:00:00Z".into(),
                updated_at: "2026-01-01T00:00:00Z".into(),
            };
            store::upsert_edge(&conn, &edge).unwrap();
            state::bind(
                &conn,
                &state::Bound {
                    path: "note.md".into(),
                    item_id: "original".into(),
                    identity: None,
                    content_hash: "hash".into(),
                    presentation: None,
                    blob: None,
                    written_hash: None,
                    links: Vec::new(),
                    lines: Vec::new(),
                    edit_line: None,
                    held: None,
                    own: None,
                    writes: Default::default(),
                },
            )
            .unwrap();
        }
        assert_eq!(folder.current_conflicts().unwrap(), 1);
        let pull = PullReport {
            flagged: vec![super::super::Flagged {
                path: "pending.md".into(),
                item: Some("pending".into()),
                flag: "unwritten",
                reason: "private".into(),
            }],
            ..PullReport::default()
        };
        folder.health_observe(false, true, Some(&pull), None, false);
        let moved = _dir.path().with_extension("health-moved");
        std::fs::rename(_dir.path(), &moved).unwrap();
        folder.health_observe(false, true, None, None, false);
        let first = State::load(&folder.core.conn().unwrap())
            .unwrap()
            .observed
            .unwrap();
        for _ in 0..3 {
            folder.health_observe(false, true, None, None, false);
        }
        let repeated = State::load(&folder.core.conn().unwrap())
            .unwrap()
            .observed
            .unwrap();
        assert_eq!(
            repeated, first,
            "repeated failed status must retain components without counting them again"
        );
        assert!(
            first
                .problems
                .iter()
                .any(|problem| problem.code == Code::Conflict && problem.count == 1)
        );
        assert!(
            first
                .problems
                .iter()
                .any(|problem| problem.code == Code::HeldFile && problem.count == 1)
        );
        std::fs::rename(&moved, _dir.path()).unwrap();
        store::remove_tag(
            &folder.core.conn().unwrap(),
            "copy",
            crate::CONFLICTED_COPY_TAG,
        )
        .unwrap();
        store::upsert_item(
            &folder.core.conn().unwrap(),
            &copy,
            None,
            &crate::catalog::Indexing::default(),
        )
        .unwrap();
        assert!(
            folder.core.get("copy").unwrap().is_some(),
            "the user's saved conflict bytes remain"
        );
        assert_eq!(folder.current_conflicts().unwrap(), 0);
    }

    #[test]
    fn a_reporting_failure_does_not_change_a_sync_result_or_its_content_queue() {
        let (_dir, folder) = fixture(Some(crate::Server {
            url: "http://127.0.0.1:9".into(),
            key: "test".into(),
        }));
        let before = folder.core.queue().unwrap();
        folder.health_observe(
            false,
            true,
            None,
            Some(&CoreError::Network("content failure".into())),
            false,
        );
        let report = State::load(&folder.core.conn().unwrap())
            .unwrap()
            .pending
            .unwrap();
        folder.health_send();
        let after = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(after.pending, Some(report));
        assert_eq!(folder.core.queue().unwrap(), before);
        assert_eq!(after.failures, 1);
    }

    fn reporting_door(
        delay: Duration,
        status: u16,
    ) -> (crate::Server, std::sync::mpsc::Receiver<String>) {
        reporting_door_sequence(delay, status, 1)
    }

    fn reporting_door_sequence(
        delay: Duration,
        status: u16,
        sequence: u64,
    ) -> (crate::Server, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (started, waiting) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut bytes = [0; 4096];
            loop {
                let read = stream.read(&mut bytes).unwrap();
                request.extend_from_slice(&bytes[..read]);
                if read == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&request);
                if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|value| value.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break;
                    }
                }
            }
            started.send(String::from_utf8(request).unwrap()).unwrap();
            std::thread::sleep(delay);
            let body = if status == 200 {
                &serde_json::to_string(&serde_json::json!({"accepted":true,"sequence":sequence,"received_at":"2026-01-01T00:00:00.000Z"})).unwrap()
            } else {
                r#"{"error":{"code":"unauthorized","message":"refused"}}"#
            };
            let _ = write!(
                stream,
                "HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nX-Marfa-Contract: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                crate::contract::CONTRACT_VERSION,
                body.len()
            );
        });
        (
            crate::Server {
                url,
                key: "test".into(),
            },
            waiting,
        )
    }

    #[test]
    fn slow_reporting_releases_the_store_on_shutdown_without_holding_content() {
        let (server, waiting) = reporting_door(Duration::from_secs(3), 200);
        let (_dir, folder) = fixture(Some(server));
        folder.health_observe(false, true, None, None, false);
        let ended = AtomicBool::new(false);
        let start = std::time::Instant::now();
        std::thread::scope(|scope| {
            let reporter = scope.spawn(|| folder.health_follow(&ended));
            waiting.recv_timeout(Duration::from_secs(1)).unwrap();
            // Content can still read and commit while the report waits on its peer.
            assert!(folder.core.queue().unwrap().is_empty());
            store::meta_set(&folder.core.conn().unwrap(), "content-witness", "committed").unwrap();
            ended.store(true, Ordering::SeqCst);
            reporter.join().unwrap();
        });
        assert!(start.elapsed() < Duration::from_secs(3));
        let state = State::load(&folder.core.conn().unwrap()).unwrap();
        assert!(state.pending.is_some());
        assert_eq!(state.failures, 1);
        assert_eq!(
            store::meta_get(&folder.core.conn().unwrap(), "content-witness")
                .unwrap()
                .as_deref(),
            Some("committed")
        );
    }

    #[test]
    fn a_report_only_credential_refusal_never_starts_renewal() {
        let (server, waiting) = reporting_door(Duration::ZERO, 401);
        let (_dir, folder) = fixture(Some(server));
        let renewed = std::sync::Arc::new(AtomicBool::new(false));
        let called = std::sync::Arc::clone(&renewed);
        folder.core.renew_credential_with(Box::new(move |_| {
            called.store(true, Ordering::SeqCst);
            Ok("fresh".into())
        }));
        folder.health_observe(false, true, None, None, false);
        folder.health_send();
        waiting.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(!renewed.load(Ordering::SeqCst));
        let state = State::load(&folder.core.conn().unwrap()).unwrap();
        assert!(state.pending.is_some());
        assert!(
            !state
                .observed
                .unwrap()
                .problems
                .iter()
                .any(|problem| problem.code == Code::CredentialRefused)
        );
    }
    #[test]
    fn review_dead_current_write_must_prevent_success() {
        let (dir, folder) = fixture(None);
        let content = "local text\n";
        std::fs::write(dir.path().join("Note.md"), content).unwrap();
        {
            let conn = folder.core.conn().unwrap();
            store::upsert_item(
                &conn,
                &store::testing::wire_item(
                    "note",
                    "core.note",
                    "active",
                    "2026-01-01T00:00:00Z",
                    serde_json::json!({"title":"Note"}),
                ),
                None,
                &crate::catalog::Indexing::default(),
            )
            .unwrap();
            state::bind(
                &conn,
                &state::Bound {
                    path: "Note.md".into(),
                    item_id: "note".into(),
                    identity: None,
                    content_hash: state::hash(content.as_bytes()),
                    presentation: None,
                    blob: None,
                    written_hash: None,
                    links: vec![],
                    lines: vec![],
                    edit_line: None,
                    held: None,
                    own: None,
                    writes: Default::default(),
                },
            )
            .unwrap();
            conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,queued_at) VALUES ('edit','update_item','note','edit','{}',1,'2026-01-01T00:00:00Z')", []).unwrap();
        }
        folder.health_observe(false, true, Some(&PullReport::default()), None, false);
        let before = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(
            before.observed.unwrap().pending_uploads,
            1,
            "witness: current file write counts before terminal failure"
        );
        folder
            .core
            .conn()
            .unwrap()
            .execute("UPDATE queue SET verdict='dead' WHERE id='edit'", [])
            .unwrap();
        folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        let after = State::load(&folder.core.conn().unwrap()).unwrap();
        let dead_snapshot = after.observed.unwrap();
        assert_eq!(dead_snapshot.pending_uploads, 1);
        assert!(
            dead_snapshot
                .problems
                .iter()
                .any(|problem| problem.code == Code::HeldFile)
        );
        assert_eq!(
            std::fs::read(dir.path().join("Note.md")).unwrap(),
            content.as_bytes()
        );
        {
            let conn = folder.core.conn().unwrap();
            conn.execute(
                "UPDATE queue SET payload=?1 WHERE id='edit'",
                [r#"{"properties":{"title":"pending","body":"local text"},"properties_mode":"replace"}"#],
            )
            .unwrap();
            conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('later','update_item','note','later',?1,1,NULL,'2026-01-01T00:00:01Z')", [r#"{"properties":{"title":"confirmed"}}"#]).unwrap();
        }
        store::record_verdict(
            &folder.core.conn().unwrap(),
            "later",
            &store::Answered {
                verdict: crate::Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        let partial = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(
            partial.observed.unwrap().pending_uploads,
            1,
            "a newer confirmed title does not establish the dead body landed"
        );
        assert!(partial.last_success_at.is_none());
        {
            let conn = folder.core.conn().unwrap();
            conn.execute("INSERT INTO queue (id,kind,item_id,idempotency_key,payload,sent,verdict,queued_at) VALUES ('body','update_item','note','body',?1,1,NULL,'2026-01-01T00:00:02Z')", [r#"{"properties":{"body":"confirmed"}}"#]).unwrap();
        }
        store::record_verdict(
            &folder.core.conn().unwrap(),
            "body",
            &store::Answered {
                verdict: crate::Verdict::Accepted,
                reason: None,
                answer: None,
                conflicted_copy_id: None,
            },
        )
        .unwrap();
        folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        let recovered = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(recovered.observed.as_ref().unwrap().pending_uploads, 0);
        assert!(recovered.observed.as_ref().unwrap().problems.is_empty());
        assert!(recovered.last_success_at.is_some());
        assert_eq!(
            folder
                .core
                .queue()
                .unwrap()
                .iter()
                .find(|row| row.id == "edit")
                .unwrap()
                .verdict,
            Some(crate::Verdict::Dead)
        );
        assert!(
            after.last_success_at.is_none(),
            "a current dead write cannot establish success"
        );
    }

    #[test]
    fn review_unreadable_unbound_directory_must_prevent_success() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, folder) = fixture(None);
        let child = dir.path().join("unreadable");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("Note.md"), "unsynced note\n").unwrap();
        let readable = folder.status().unwrap();
        assert_eq!(
            readable.files.len(),
            1,
            "witness: the unbound file is present when readable"
        );
        folder.health_observe(false, true, None, None, false);
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o000)).unwrap();
        let scan = folder.scan().unwrap();
        assert!(
            scan.directories
                .iter()
                .any(|entry| entry.flag == "unreadable")
        );
        folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        let after = State::load(&folder.core.conn().unwrap()).unwrap();
        for _ in 0..3 {
            folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        }
        assert_eq!(
            State::load(&folder.core.conn().unwrap()).unwrap().observed,
            after.observed
        );
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            after.observed.as_ref().unwrap().pending_uploads,
            1,
            "retain the last observed upload instead of inferring absence"
        );
        assert_eq!(
            after.observed.as_ref().unwrap().problems,
            vec![Problem {
                code: Code::Unreadable,
                count: 1
            }]
        );
        // Make the next complete inventory empty, without discarding an unseen file.
        std::fs::remove_file(child.join("Note.md")).unwrap();
        folder.health_observe(true, true, Some(&PullReport::default()), None, false);
        let recovered = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(recovered.observed.as_ref().unwrap().pending_uploads, 0);
        assert!(recovered.observed.as_ref().unwrap().problems.is_empty());
        assert!(recovered.last_success_at.is_some());
        assert!(
            after.last_success_at.is_none(),
            "an incomplete inventory cannot establish success"
        );
    }
    #[test]
    fn review_coalescing_must_keep_server_sequence_floor() {
        let mut state = State::default();
        state.reserve("opaque", Snapshot::default(), false).unwrap();
        let sent = state.pending.clone().unwrap();
        state.failed(&CoreError::Network("newer retry".into()));
        let failures = (state.failures, state.retry_at);
        for count in 1..=4 {
            state
                .reserve(
                    "opaque",
                    Snapshot {
                        pending_uploads: count,
                        ..Snapshot::default()
                    },
                    false,
                )
                .unwrap();
            let pending = state.pending.clone();
            state.acknowledge(&sent, &receipt(10_000, false)).unwrap();
            assert_eq!(
                state.pending, pending,
                "obsolete receipt must preserve newer content"
            );
            assert_eq!((state.failures, state.retry_at), failures);
            assert_eq!(
                state.sequence,
                10_000.max(pending.unwrap().sequence),
                "obsolete receipt must retain server knowledge"
            );
        }
        assert!(state.pending.as_ref().unwrap().sequence > 10_000);
        assert_eq!(state.pending.as_ref().unwrap().snapshot.pending_uploads, 4);
        state.acknowledge(&sent, &receipt(1, true)).unwrap();
        assert!(state.pending.as_ref().unwrap().sequence > 10_000);
        assert_eq!((state.failures, state.retry_at), failures);
    }
    #[test]
    fn a_persisted_obsolete_floor_sends_a_fresh_snapshot_after_restart() {
        let (server, request) = reporting_door_sequence(Duration::ZERO, 200, 51);
        let (dir, folder) = fixture(Some(server));
        folder.health_observe(false, true, None, None, false);
        let mut state = State::load(&folder.core.conn().unwrap()).unwrap();
        let sent = state.pending.clone().unwrap();
        state
            .reserve(
                &sent.folder_store_id,
                Snapshot {
                    pending_uploads: 9,
                    ..Snapshot::default()
                },
                false,
            )
            .unwrap();
        let newer = state.pending.clone().unwrap();
        state.acknowledge(&sent, &receipt(50, false)).unwrap();
        assert_eq!(state.pending, Some(newer));
        state.save(&folder.core.conn().unwrap()).unwrap();
        // Disk changes after the rejected request and durable floor write.
        std::fs::write(dir.path().join("Fresh.md"), "current bytes\n").unwrap();
        let recovered = State::load(&folder.core.conn().unwrap()).unwrap();
        assert_eq!(recovered.sequence, 50);
        assert_eq!(recovered.pending.unwrap().snapshot.pending_uploads, 9);
        folder.health_send_inner().unwrap();
        let request = request.recv_timeout(Duration::from_secs(1)).unwrap();
        let report: Report =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(report.sequence, 51);
        assert_eq!(
            report.snapshot.pending_uploads, 1,
            "send must observe disk, not reuse either cached report"
        );
        let final_state = State::load(&folder.core.conn().unwrap()).unwrap();
        assert!(final_state.pending.is_none());
        assert_eq!(final_state.observed.unwrap().pending_uploads, 1);
    }

    #[test]
    fn an_equal_rejection_resnapshots_and_an_exhausted_floor_keeps_pending() {
        let (dir, folder) = fixture(None);
        folder.health_observe(false, true, None, None, false);
        let mut state = State::load(&folder.core.conn().unwrap()).unwrap();
        let sent = state.pending.clone().unwrap();
        state
            .acknowledge(&sent, &receipt(sent.sequence, false))
            .unwrap();
        assert_eq!(state.pending, Some(sent.clone()));
        state.save(&folder.core.conn().unwrap()).unwrap();
        std::fs::write(dir.path().join("Fresh.md"), "current bytes\n").unwrap();
        folder.health_refresh_for_receipt(sent.sequence).unwrap();
        let mut state = State::load(&folder.core.conn().unwrap()).unwrap();
        let latest = state.pending.clone().unwrap();
        assert_eq!(latest.sequence, sent.sequence + 1);
        assert_eq!(latest.snapshot.pending_uploads, 1);
        state.acknowledge(&sent, &receipt(MAX_SAFE, false)).unwrap();
        assert_eq!(state.pending, Some(latest.clone()));
        assert!(
            state
                .reserve(&latest.folder_store_id, latest.snapshot, true)
                .is_err()
        );
        assert_eq!(state.sequence, MAX_SAFE);
        assert!(state.pending.is_some());
    }
}
