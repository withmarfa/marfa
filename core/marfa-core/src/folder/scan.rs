use std::cell::RefCell;
use std::sync::atomic::Ordering;

use crate::Seen;

use super::beneath::PendingBeneath;
use super::default_edges::default_edges_of;
use super::push::{admission_hold, file_item_draft, new_document};
use super::scoped::{Guard, Inventory, Looked, Plan, Reading, linked_elsewhere};
use super::settings::OutsideQuery;
use super::{
    BTreeMap, BoundFiles, Captured, Carriers, Catalog, ControlFlow, CoreError, Duration, EdgeTypes,
    EdgeWork, Flagged, Folder, HashMap, HashSet, ID_FIELD, Item, ItemState, KEPT_LOOK,
    LOCAL_ADMISSION_REFUSAL, Lists, Look, Names, OnceCell, Path, PathBuf, Peers, RENAME_GRACE,
    Resolver, Result, ScanReport, Scanned, Settings, Unsure, Value, Waiting, Walked, bytes_of,
    bytes_type, captured_identities, carries_frontmatter, copy_refused, document, embeds,
    executable, fields, id_named, identity, is_document, landing, line_of, lines,
    local_admission_refusal, local_properties_refusal, named_by_its_file, near_limit, one_per_name,
    placement, stat_metadata, state, suited, swap_root, text_of, typed_title,
};

/// The text the scan keeps of a file. A document whose bytes are not UTF-8
/// is held as one whose frontmatter does not parse is: decoded, it would be
/// sent and written back with every byte that is not replaced. Any other file
/// is decoded only where a text item asks for its body (`Scanned::document`).
/// Neither is copied here, so a large file that is not text is never held in
/// memory twice.
fn kept_text(path: &Path, bytes: &[u8]) -> (String, Option<&'static str>) {
    if !is_document(path) {
        return (String::new(), None);
    }
    match text_of(bytes) {
        Ok(text) => (text.to_string(), None),
        Err(reason) => (String::new(), Some(reason)),
    }
}

#[derive(Debug, Clone)]
struct Claim {
    item_id: String,
    bound: Option<state::Bound>,
}

enum Arrival {
    Here,
    Copy,
    Waits(String),
}

/// Whether a scan may change a file in the directory.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Files {
    Write,
    Keep,
}

/// Whether a pass that read the whole folder goes on to let go of the
/// missing files past the grace, or only journals them for a confirmation
/// to decide.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Journal {
    Sweep,
    Hold,
}

/// What a pass has read from the copy before it walks the directory.
struct ScanStart {
    report: ScanReport,
    /// The registry, where the copy's own folder was lost from it.
    doubt: Option<String>,
    settings: Settings,
    guard: Guard,
    catalog: Catalog,
    edge_types: EdgeTypes,
    lists: Lists,
}

/// Set once the folder has read its documents' edges again under the rule
/// that an embed is a `references` edge, attaching only a file the query
/// does not hold (`folder-documents/embed-rederived`).
pub(super) const EMBEDS_REREAD: &str = "folder_embeds_references";

/// What a pass holds between its phases.
struct ScanState {
    /// When the pass began, before it captured any file's size and time.
    began: std::time::SystemTime,
    full: bool,
    journal: Journal,
    guard: Guard,
    scope: Option<Scoping>,
    skipped_keys: Vec<String>,
    /// A quick pass found a bound file missing that no journal row covers,
    /// which only a walk can tell no other file carries.
    walk_again: bool,
    /// Whether this pass reads every document's edges again
    /// (`EMBEDS_REREAD`).
    reread_embeds: bool,
    settle: Option<Duration>,
    mode: Files,
    report: ScanReport,
    doubt: Option<String>,
    settings: Settings,
    catalog: Catalog,
    edge_types: EdgeTypes,
    lists: Lists,
    walked: Walked,
    /// Whether the walk, or a read after it, left part of the folder unread.
    incomplete: bool,
    /// The copy's bindings as the pass began.
    snapshot: Vec<state::Bound>,
    /// Every file the walk found, whether or not it is pushed: leaving one
    /// out journals it missing and deletes the item bound to it.
    seen: HashSet<String>,
    paths: Vec<PathBuf>,
    keys: Vec<String>,
    /// Files a scan must not call unchanged.
    unanswered: HashSet<String>,
    /// Each file's size and time, taken before its read, so a change made
    /// during the read differs from what is recorded.
    stats: Vec<(String, String)>,
    /// Keys of the files a quick pass skips.
    unchanged: HashSet<String>,
    /// The bytes of the files read before the rest.
    early: HashMap<PathBuf, Vec<u8>>,
    shown: HashMap<String, Vec<(String, embeds::Target)>>,
    embedded: HashSet<String>,
    /// Files read only because an embed names them.
    only_embedded: HashSet<String>,
    files: Vec<Scanned>,
    /// Why each stale save waits, by path.
    stale: HashMap<String, String>,
    /// Each path whose file waits while another file carries the item bound
    /// there.
    held_carried: HashMap<String, HeldCarried>,
    /// Paths held for an unresolved removal, with the reason for each hold.
    removing: HashMap<String, String>,
}

/// The item bound at a path whose file waits, and the file that carries it.
struct HeldCarried {
    item_id: String,
    carrier: String,
    /// The carrier's identity, where only its path named it.
    identity: Option<String>,
}

/// What a pass that looked only at named paths keeps for its end.
struct Scoping {
    /// The last pass's inventory, its keys held in `seen`.
    inventory: Inventory,
    vanished: Vec<String>,
}

/// Why a file naming an id the copy does not hold waits, from the server's
/// answer to that id: none where the server holds the item, or shows none,
/// since an item the server will not show leaves a new item.
fn unheld_waits(answer: Result<bool>) -> Option<String> {
    match answer {
        Ok(_) | Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => None,
        Err(error) => Some(format!(
            "it carries the id of an item this copy does not hold, which cannot be read yet ({error}); it is taken at the next push"
        )),
    }
}

fn bound_by_path(snapshot: &[state::Bound]) -> HashMap<&str, &state::Bound> {
    snapshot
        .iter()
        .map(|bound| (bound.path.as_str(), bound))
        .collect()
}

/// Each path a claimed file embeds, folded, with the items the files that
/// embed it are.
fn embedded_by(
    files: &[Scanned],
    claims: &[Option<Claim>],
    shown: &HashMap<String, Vec<(String, embeds::Target)>>,
) -> HashMap<String, HashSet<String>> {
    let mut by_path: HashMap<String, HashSet<String>> = HashMap::new();
    for (host, claim) in files.iter().zip(claims) {
        let (Some(found), Some(claim)) = (shown.get(&host.key), claim) else {
            continue;
        };
        for (_, target) in found {
            if let embeds::Target::At(at) = target {
                by_path
                    .entry(marfa_rules::names::folded(at))
                    .or_default()
                    .insert(claim.item_id.clone());
            }
        }
    }
    by_path
}

pub(super) enum Missing {
    Moved,
    /// Still bound and journaled, until the folder it went to binds it.
    Arriving,
    Unsure(String),
    /// Changed elsewhere in what the file showed, so still bound and
    /// journaled for a pull to write back; or put back, so still bound and
    /// no longer journaled.
    Changed,
    Deleted,
    Gone,
    /// Still bound, while another file carries it.
    Carried,
}

/// Why a file at the path of an item another file carries is not sent.
pub(super) fn carried_path_waits(carrier: &str) -> String {
    format!(
        "Marfa still holds this path for an item that {carrier} carries. Move {carrier} to a name the folder sends, or delete it, and this file is sent"
    )
}

/// Bounded, so a row another device keeps changing ends the sweep's decision
/// with its file written back rather than holding the sweep.
const DECIDE_ATTEMPTS: usize = 3;

/// Read once for every missing file a sweep or a confirm lets go of.
#[derive(Default)]
pub(super) struct Sweep {
    members: OnceCell<HashSet<String>>,
    shown: OnceCell<(EdgeTypes, Names)>,
    /// Whether each missing file's item changed in what the file showed, with
    /// what the decision read of it, made before the sweep queued any delete.
    /// A delete the sweep queues takes its item out of the names and links
    /// other files render, so a file decided on afterwards would read as
    /// changed.
    decided: RefCell<HashMap<String, (Seen, bool)>>,
}

impl Sweep {
    fn shown(&self, folder: &Folder, catalog: &Catalog) -> Result<&(EdgeTypes, Names)> {
        if let Some(shown) = self.shown.get() {
            return Ok(shown);
        }
        let conn = folder.core.conn()?;
        let loaded = (
            EdgeTypes::load(&conn)?,
            Names::load(&conn, catalog, &BoundFiles)?,
        );
        Ok(self.shown.get_or_init(|| loaded))
    }
}

/// What a pass reads: every file where `every`, and `full` where it is the
/// full pass the caller asked for, not one that rereads every file once.
#[derive(Clone, Copy)]
struct Reads {
    every: bool,
    full: bool,
}

/// A time this cannot read has not passed, since a delete cannot be taken
/// back.
fn elapsed_past(since: &str, now_ms: i64, grace: Duration) -> bool {
    millis_of(since).is_some_and(|since| now_ms.saturating_sub(since) >= grace.as_millis() as i64)
}

fn millis_of(stamp: &str) -> Option<i64> {
    marfa_rules::time::read(stamp).ok()
}

impl Folder {
    /// Whether a missing file's grace had yet to run out at `at`, which only
    /// the passing of time moves on: the sweep acts on it once it has. A stamp
    /// this cannot read never runs out, so nothing waits on it.
    pub(super) fn grace_running(&self, at: std::time::SystemTime) -> Result<bool> {
        let now = crate::store::millis_at(at);
        let grace = RENAME_GRACE.as_millis() as i64;
        Ok(state::journaled(&*self.core.conn()?)?.iter().any(|row| {
            !row.carried()
                && millis_of(&row.missing_since)
                    .is_some_and(|since| now.saturating_sub(since) < grace)
        }))
    }

    pub fn scan(&self) -> Result<ScanReport> {
        self.refuse_while_paused()?;
        self.scan_as(true, None, Files::Write, Reading::Walk, Journal::Sweep)
    }

    /// A quick pass that journals each missing file and lets go of none, so
    /// a confirmation alone decides on the files it confirms. A renamed file
    /// is still found, since its new path has no binding and so is read.
    pub(super) fn scan_holding_missing(&self) -> Result<ScanReport> {
        self.scan_as(false, None, Files::Write, Reading::Walk, Journal::Hold)
    }

    /// `scan`, but no file in the directory is written, moved or removed: a
    /// rename is sent as the new title with its title line as it is, an old
    /// buffer saved where a pull moved the file from stays there, and a
    /// temporary file a crashed write left stays, all for a pass that writes
    /// files.
    pub(super) fn scan_keeping_files(&self) -> Result<ScanReport> {
        self.scan_as(true, None, Files::Keep, Reading::Walk, Journal::Sweep)
    }

    /// A watch's pass. Short of `full`, it skips a file whose size, time and
    /// identity are as the last read left them, which a full pass catches.
    /// Either way it leaves for a later pass a file that is not a document,
    /// or is a file item at a document name, and changed within `settle`,
    /// which a copy or a download may still be writing.
    pub fn scan_watching(&self, full: bool, settle: Duration) -> Result<ScanReport> {
        self.scan_watching_within(full, settle, Reading::Walk)
    }

    /// `scan_watching`, where `reading` says how a quick pass finds its files.
    pub(super) fn scan_watching_within(
        &self,
        full: bool,
        settle: Duration,
        reading: Reading<'_>,
    ) -> Result<ScanReport> {
        self.scan_as(full, Some(settle), Files::Write, reading, Journal::Sweep)
    }

    fn scan_as(
        &self,
        full: bool,
        settle: Option<Duration>,
        mode: Files,
        reading: Reading<'_>,
        journal: Journal,
    ) -> Result<ScanReport> {
        self.read_limit_if_holding();
        let start = match self.scan_root(mode)? {
            ControlFlow::Break(report) => return Ok(report),
            ControlFlow::Continue(start) => start,
        };
        // The first pass under the rule reads every file, so no document
        // is skipped as unchanged.
        let reread_embeds = crate::store::meta_get(&*self.core.conn()?, EMBEDS_REREAD)?.is_none();
        let watching = !full && !reread_embeds && mode == Files::Write && settle.is_some();
        let plan = match reading {
            Reading::Named(scope) if watching => {
                self.plan_scoped(&start.settings, &start.lists, scope)?
            }
            _ => {
                self.forget_inventory();
                None
            }
        };
        let keep = watching && !matches!(reading, Reading::Walk);
        let reads = Reads {
            every: full || reread_embeds,
            full,
        };
        let mut scan = match self.walk_for_scan(start, reads, settle, mode, plan)? {
            ControlFlow::Break(report) => return Ok(report),
            ControlFlow::Continue(scan) => scan,
        };
        scan.reread_embeds = reread_embeds;
        scan.journal = journal;
        if self.read_unchanged_and_documents(&mut scan)?.is_break() {
            // Nothing has been written yet, so a walk can take over.
            let again = if keep {
                Reading::Keeping
            } else {
                Reading::Walk
            };
            return self.scan_as(full, settle, mode, again, journal);
        }
        self.count_unchanged(&mut scan);
        self.read_rest(&mut scan)?;
        if self.root_left(&mut scan).is_break() {
            return Ok(scan.report);
        }
        scan.stale =
            self.fold_stale_saves(&mut scan.files, &scan.snapshot, &mut scan.seen, scan.mode)?;
        self.refresh_catalog(&mut scan)?;
        let peers = Peers::of(self, scan.doubt.take());
        let (claims, waiting) = self.claim_scanned(&mut scan, &peers)?;
        self.follow_embeds_of_documents(&mut scan, &claims)?;
        let work = match self.queue_scanned(&mut scan, claims, waiting)? {
            ControlFlow::Break(()) => return Ok(scan.report),
            ControlFlow::Continue(work) => work,
        };
        self.queue_edge_work(&mut scan, work)?;
        self.send_forms(
            &scan.files,
            &scan.snapshot,
            &scan.catalog,
            &scan.edge_types,
            &self.withheld()?,
        )?;
        self.settle_default_edges(&scan.settings)?;
        if scan.reread_embeds && !scan.incomplete {
            crate::store::meta_set(&*self.core.conn()?, EMBEDS_REREAD, "1")?;
        }
        self.record_stats(&scan)?;
        self.note_limit_holds(&scan.report, full)?;
        if self.root_left(&mut scan).is_break() {
            return Ok(scan.report);
        }
        if self.sweep(&mut scan, &peers)?.is_break() {
            return Ok(scan.report);
        }
        if scan.walk_again {
            self.forget_inventory();
            let mut walked = self.scan_as(full, settle, mode, Reading::Keeping, journal)?;
            walked.absorb_quick(scan.report);
            return Ok(walked);
        }
        scan.report.root_gone = scan.report.root_gone.or_else(|| self.root_gone());
        if keep && !scan.incomplete && scan.report.root_gone.is_none() {
            self.leave_inventory(&mut scan);
        }
        Ok(scan.report)
    }

    /// Keeps what the pass found for the next quick pass, but not where it set
    /// a save aside or folded a name, which only a walk follows, nor where the
    /// walk entered another volume, which may change with no event heard.
    fn leave_inventory(&self, scan: &mut ScanState) {
        if scan.walked.crossed {
            self.forget_inventory();
            return;
        }
        if !scan.stale.is_empty()
            || scan.files.iter().any(|file| file.folded)
            || scan.seen.len() != scan.keys.len() && scan.scope.is_none()
            || scan.keys.iter().any(|key| !scan.seen.contains(key))
            || scan
                .walked
                .opened
                .values()
                .any(|captured| linked_elsewhere(&captured.metadata.borrow()))
        {
            return;
        }
        let skipped: HashSet<&str> = scan.skipped_keys.iter().map(String::as_str).collect();
        let settled = |key: &String| scan.unchanged.contains(key) || skipped.contains(key.as_str());
        let inventory = match scan.scope.take() {
            Some(Scoping {
                mut inventory,
                vanished,
            }) => {
                for key in vanished.iter().chain(&scan.keys) {
                    inventory.dirty.remove(key);
                    inventory.skipped.remove(key);
                }
                for key in &scan.keys {
                    if skipped.contains(key.as_str()) {
                        inventory.skipped.insert(key.clone());
                    } else if !settled(key) {
                        inventory.dirty.insert(key.clone());
                    }
                }
                inventory.keys = std::mem::take(&mut scan.seen);
                inventory
            }
            None => Inventory {
                guard: scan.guard.clone(),
                dirty: scan
                    .keys
                    .iter()
                    .filter(|key| !settled(key))
                    .cloned()
                    .collect(),
                skipped: scan.skipped_keys.iter().cloned().collect(),
                index: embeds::Files::of(&scan.keys),
                keys: std::mem::take(&mut scan.seen),
                directories: scan.walked.directories.clone(),
                secrets: scan.walked.secrets.clone(),
            },
        };
        self.keep_inventory(inventory);
    }

    /// Reads the root where a file is held over the limit it last named, so a
    /// limit raised since lets the file go in this pass, with nothing else
    /// waiting to send. A root that does not answer leaves the limit as it was.
    fn read_limit_if_holding(&self) {
        let holding = self
            .core
            .conn()
            .is_ok_and(|conn| matches!(crate::store::limit_marked(&conn), Ok(true)));
        if holding && let Ok(http) = self.core.http() {
            let _ = crate::catch_up::refuse_another_instance(&self.core, http);
        }
    }

    /// Only a full pass reads every file, so only it can say none is held.
    fn note_limit_holds(&self, report: &ScanReport, full: bool) -> Result<()> {
        let held = report.flagged.iter().any(Flagged::over_limit);
        if held || full {
            crate::store::note_limit_held(&*self.core.conn()?, held)?;
        }
        Ok(())
    }

    /// The pass's first phase: that the folder's root is there, then what
    /// the pass reads from the copy.
    fn scan_root(&self, mode: Files) -> Result<ControlFlow<ScanReport, ScanStart>> {
        if let Some(gone) = self.root_gone() {
            return Ok(ControlFlow::Break(ScanReport {
                root_gone: Some(gone),
                ..ScanReport::default()
            }));
        }
        if mode == Files::Write {
            self.settle_displaced()?;
            self.settle_retained()?;
        }
        self.settle_landings()?;
        // Every pass, so a watch lists its folder again too.
        let (registry, lost) = self.register();
        let doubt = registry.clone().filter(|_| lost);
        let report = ScanReport {
            registry,
            ..ScanReport::default()
        };
        let settings = self.settings()?;
        let (catalog, edge_types) = {
            let conn = self.core.conn()?;
            (crate::catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let lists = settings.lists()?;
        let guard = self.guard_of(&settings)?;
        Ok(ControlFlow::Continue(ScanStart {
            report,
            doubt,
            settings,
            guard,
            catalog,
            edge_types,
            lists,
        }))
    }

    /// Walks the directory, clears what a crashed write left behind, and
    /// takes the copy's bindings and the file list the later phases work
    /// through.
    fn walk_for_scan(
        &self,
        start: ScanStart,
        reads: Reads,
        settle: Option<Duration>,
        mode: Files,
        plan: Option<Plan>,
    ) -> Result<ControlFlow<ScanReport, ScanState>> {
        let ScanStart {
            mut report,
            doubt,
            settings,
            guard,
            catalog,
            edge_types,
            lists,
        } = start;
        if crate::fault::named("replace-root-before-scan-walk").is_some() {
            std::fs::rename(&self.root, self.root.with_extension("original"))
                .expect("move original root for fault");
            std::fs::rename(self.root.with_extension("replacement"), &self.root)
                .expect("install replacement root for fault");
        }
        let began = plan
            .as_ref()
            .map_or_else(std::time::SystemTime::now, |plan| plan.began);
        let (walked, scoped) = match plan {
            Some(plan) => {
                let Plan {
                    inventory,
                    found,
                    opened,
                    vanished,
                    snapshot,
                    ..
                } = plan;
                let walked = Walked {
                    files: found.iter().map(|(path, _)| path.clone()).collect(),
                    opened,
                    directories: inventory.directories.clone(),
                    secrets: inventory.secrets.clone(),
                    ..Walked::default()
                };
                let keys = found.into_iter().map(|(_, key)| key).collect();
                (walked, Some((inventory, vanished, keys, snapshot)))
            }
            None => {
                let mut walked = self.walked(&lists);
                if mode == Files::Write && self.settle_found(&walked.kept)? {
                    self.settle_retained()?;
                    walked = self.walked(&lists);
                }
                (walked, None)
            }
        };
        let incomplete = walked.incomplete();
        // Only a complete walk of the whole folder shows a reserved name is
        // in none of it.
        if scoped.is_none() && reads.full && !incomplete {
            self.clear_unfound(&walked.kept)?;
        }
        self.settle_landings()?;
        swap_root(&self.root, "replace-root-before-capture");
        if let Some(gone) = self.root_gone() {
            report.root_gone = Some(gone);
            return Ok(ControlFlow::Break(report));
        }
        let state_left = self
            .state_dir
            .entries()
            .unwrap_or_default()
            .into_iter()
            .map(PathBuf::from)
            .filter(|name| landing::left_behind(name));
        if mode == Files::Write {
            for (route, left) in &walked.left {
                if let Ok(directory) = route.open() {
                    let _ = directory.unlink(left);
                }
            }
        }
        for left in state_left {
            let _ = self.state_dir.unlink(&left);
        }
        report.flagged.extend(self.kept_report(&walked.kept)?);
        report.directories = walked.directories.clone();
        report.secrets = walked.secrets.clone();
        let unanswered = crate::store::items_awaiting_their_write(&*self.core.conn()?)?;
        let (snapshot, seen, paths, keys, scope) = match scoped {
            Some((mut inventory, vanished, keys, snapshot)) => {
                let seen = std::mem::take(&mut inventory.keys);
                let paths = walked.files.clone();
                (
                    snapshot,
                    seen,
                    paths,
                    keys,
                    Some(Scoping {
                        inventory,
                        vanished,
                    }),
                )
            }
            None => {
                let snapshot = {
                    let conn = self.core.conn()?;
                    state::every_bound(&conn)?
                };
                let found = walked
                    .files
                    .iter()
                    .map(|path| identity::relative(&self.root, path))
                    .collect::<Result<Vec<String>>>()?;
                let seen: HashSet<String> = found.iter().cloned().collect();
                let (paths, keys) = one_per_name(&walked.files, found, &snapshot, &mut report);
                (snapshot, seen, paths, keys, None)
            }
        };
        Ok(ControlFlow::Continue(ScanState {
            began,
            full: reads.every,
            journal: Journal::Sweep,
            guard,
            scope,
            skipped_keys: Vec::new(),
            walk_again: false,
            reread_embeds: false,
            settle,
            mode,
            report,
            doubt,
            settings,
            catalog,
            edge_types,
            lists,
            walked,
            incomplete,
            snapshot,
            seen,
            paths,
            keys,
            unanswered,
            stats: Vec::new(),
            unchanged: HashSet::new(),
            early: HashMap::new(),
            shown: HashMap::new(),
            embedded: HashSet::new(),
            only_embedded: HashSet::new(),
            files: Vec::new(),
            stale: HashMap::new(),
            held_carried: HashMap::new(),
            removing: HashMap::new(),
        }))
    }

    /// With a quick pass (short of `full`), skips the files whose size, time
    /// and identity are as the last read left them, and reads the Markdown
    /// files first, so a file only an embed names is sent too. A file
    /// carrying the item id of a skipped file is read, and so is the skipped
    /// file, until no skipped file's item is named. A quick pass over named
    /// paths looks at such a file outside them too, or breaks where it cannot.
    fn read_unchanged_and_documents(&self, scan: &mut ScanState) -> Result<ControlFlow<()>> {
        let full = scan.full;
        let by_path = bound_by_path(&scan.snapshot);
        let by_item: HashMap<&str, &str> = if scan.scope.is_some() {
            scan.snapshot
                .iter()
                .map(|bound| (bound.item_id.as_str(), bound.path.as_str()))
                .collect()
        } else {
            HashMap::new()
        };
        let ScanState {
            paths,
            keys,
            walked,
            unchanged,
            stats,
            early,
            shown,
            embedded,
            scope,
            seen,
            lists,
            incomplete,
            ..
        } = scan;
        if !full {
            // Resolved over every file, so a hard link shares no mark.
            let marks = captured_identities(paths, walked);
            let conn = self.core.conn()?;
            for (path, key) in paths.iter().zip(keys.iter()) {
                if let Some(bound) = by_path.get(key.as_str())
                    && bound.held.is_none()
                    && !bound.holds_refusal()
                    // A save set aside is sent again by the next scan.
                    && state::untaken_read_version(&bound.content_hash).is_none()
                    && bound.identity.is_some()
                    && marks.get(path).map(|found| found.key()) == bound.identity
                    && let Some(stat) = walked.opened.get(path).and_then(|captured| stat_metadata(&captured.metadata.borrow()))
                    && state::stat_of(&conn, key)?.as_deref() == Some(stat.as_str())
                    // A file whose item the copy lost is said to be at every pass.
                    && crate::store::held_version(&conn, &bound.item_id)?.is_some()
                {
                    unchanged.insert(key.clone());
                }
            }
        }
        // Markdown files first, so a file only an embed names is sent too.
        let walking_index;
        let index: &embeds::Files = match &*scope {
            Some(scoping) => &scoping.inventory.index,
            None => {
                walking_index = embeds::Files::of(keys);
                &walking_index
            }
        };
        let mut in_scope: HashSet<String> = if scope.is_some() {
            keys.iter().cloned().collect()
        } else {
            HashSet::new()
        };
        let mut reading: Vec<usize> = (0..paths.len()).collect();
        while !reading.is_empty() {
            let mut named: HashSet<String> = HashSet::new();
            let mut targets: HashSet<String> = HashSet::new();
            for at in reading {
                let (path, key) = (&paths[at], &keys[at]);
                if !carries_frontmatter(path) || unchanged.contains(key) {
                    continue;
                }
                let Ok(bytes) = walked
                    .opened
                    .get(path)
                    .ok_or_else(|| std::io::Error::other("file not opened"))
                    .and_then(Captured::read)
                else {
                    *incomplete = true;
                    continue;
                };
                if let Some(stat) = walked
                    .opened
                    .get(path)
                    .and_then(|captured| stat_metadata(&captured.metadata.borrow()))
                {
                    stats.push((key.clone(), stat));
                }
                // Held below; its id line, which is ASCII, still names its item.
                let Ok(text) = text_of(&bytes) else {
                    named.extend(document::id_line_of(&bytes));
                    early.insert(path.clone(), bytes);
                    continue;
                };
                let read = document::read(text);
                named.extend(
                    read.front
                        .get(ID_FIELD)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| document::id_line(text)),
                );
                let mut found = Vec::new();
                for embed in crate::body::text::embeds(&read.body) {
                    if let Some(target) = embeds::on_disk(key, &embed, index) {
                        if let embeds::Target::At(at) = &target {
                            embedded.insert(at.clone());
                            targets.insert(at.clone());
                        }
                        found.push((embed.raw().to_string(), target));
                    }
                }
                if !found.is_empty() {
                    shown.insert(key.clone(), found);
                }
                early.insert(path.clone(), bytes);
            }
            // A file carrying the id of a skipped file's item may be its copy,
            // and which keeps the id is decided with both read.
            let mut next: Vec<usize> = (0..paths.len())
                .filter(|at| {
                    unchanged.contains(&keys[*at])
                        && by_path
                            .get(keys[*at].as_str())
                            .is_some_and(|bound| named.contains(&bound.item_id))
                })
                .collect();
            for at in &next {
                unchanged.remove(&keys[*at]);
            }
            if let Some(scoping) = scope.as_ref() {
                // Files outside the pass that a file read names.
                let outside = named
                    .iter()
                    .filter_map(|id| by_item.get(id.as_str()).copied())
                    .chain(
                        targets
                            .iter()
                            .map(String::as_str)
                            .filter(|key| scoping.inventory.skipped.contains(*key)),
                    )
                    .filter(|key| seen.contains(*key) && !in_scope.contains(*key))
                    .map(str::to_string)
                    .collect::<std::collections::BTreeSet<String>>();
                for key in outside {
                    let Some(Looked::File(path, captured)) =
                        self.look_at(lists, &scoping.inventory, &key)
                    else {
                        return Ok(ControlFlow::Break(()));
                    };
                    next.push(paths.len());
                    walked.opened.insert(path.clone(), *captured);
                    walked.files.push(path.clone());
                    paths.push(path);
                    in_scope.insert(key.clone());
                    keys.push(key);
                }
            }
            reading = next;
        }
        if scope.is_some() {
            let mut both: Vec<(PathBuf, String)> = std::mem::take(paths)
                .into_iter()
                .zip(std::mem::take(keys))
                .collect();
            both.sort();
            (*paths, *keys) = both.into_iter().unzip();
        }
        Ok(ControlFlow::Continue(()))
    }

    /// Counts the files left unread as unchanged, or as waiting where the
    /// server has not answered their item's write.
    fn count_unchanged(&self, scan: &mut ScanState) {
        let by_path = bound_by_path(&scan.snapshot);
        let unanswered = &scan.unanswered;
        let waits = |key: &str| {
            by_path
                .get(key)
                .is_some_and(|bound| unanswered.contains(&bound.item_id))
        };
        let mut unchanged = scan.unchanged.len();
        let mut waiting = scan.unchanged.iter().filter(|key| waits(key)).count();
        if let Some(scoping) = &scan.scope {
            let looked: HashSet<&str> = scan.keys.iter().map(String::as_str).collect();
            for key in scan
                .seen
                .iter()
                .filter(|key| !looked.contains(key.as_str()))
            {
                if scoping.inventory.skipped.contains(key) {
                    scan.report.skipped += 1;
                    continue;
                }
                unchanged += 1;
                waiting += usize::from(waits(key));
            }
        }
        scan.report.waiting += waiting;
        scan.report.unchanged += unchanged - waiting;
    }

    /// Reads every file the pass has not skipped or read, and holds what the
    /// folder pushes, what an embed names and what is already a file item.
    fn read_rest(&self, scan: &mut ScanState) -> Result<()> {
        let settle = scan.settle;
        let (settings, catalog, edge_types) = (&scan.settings, &scan.catalog, &scan.edge_types);
        let (snapshot, walked, paths, keys) =
            (&scan.snapshot, &scan.walked, &scan.paths, &scan.keys);
        let (unchanged, embedded) = (&scan.unchanged, &scan.embedded);
        let (early, stats, report) = (&mut scan.early, &mut scan.stats, &mut scan.report);
        let (only_embedded, skipped_keys) = (&mut scan.only_embedded, &mut scan.skipped_keys);
        // A file already a file item is read whatever the query says, so one
        // no longer embedded, or moved, is followed rather than journaled. A
        // file item may be bound at a document name, which the item says.
        let bound_paths: HashSet<&str> = snapshot
            .iter()
            .map(|row| row.path.as_str())
            .filter(|path| !is_document(Path::new(path)))
            .collect();
        let by_mark: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .filter_map(|row| Some((row.identity.as_deref()?, row)))
            .collect();
        let bound = |path: &Path, key: &str| -> Result<bool> {
            if bound_paths.contains(key) {
                return Ok(true);
            }
            let Some(row) = walked
                .opened
                .get(path)
                .map(|captured| captured.metadata.borrow().clone())
                .and_then(|metadata| identity::of(&metadata))
                .or_else(|| walked.unread.get(path).copied())
                .and_then(|found| by_mark.get(found.key().as_str()))
            else {
                return Ok(false);
            };
            Ok(!is_document(Path::new(&row.path)) || self.file_item(&row.item_id, catalog)?)
        };
        let mut held: Vec<PathBuf> = Vec::new();
        for (path, key) in paths.iter().zip(keys) {
            if unchanged.contains(key) {
                continue;
            }
            if self.pushes(path, settings, catalog) || bound(path, key)? {
                held.push(path.clone());
            } else if embedded.contains(key) {
                only_embedded.insert(key.clone());
                held.push(path.clone());
            } else {
                report.skipped += 1;
                skipped_keys.push(key.clone());
            }
        }
        // Resolved over pushed files only, so a file the folder never touches
        // cannot withhold a note's identity by sharing it.
        let identities = captured_identities(&held, walked);
        let mut files = Vec::new();
        for path in held {
            // Unread bytes still claim their file's identity before another
            // file at its old path can take its item.
            let deferred = || {
                Scanned::deferred(
                    &self.root,
                    &path,
                    identities.get(&path).map(|mark| mark.key()),
                    walked.opened.get(&path),
                )
            };
            // Unreadable now, a dataless placeholder say: the next scan reads
            // it, and the folder holds what it last agreed with meanwhile.
            let bytes = match early.remove(&path) {
                Some(bytes) => bytes,
                None => {
                    let read = walked
                        .opened
                        .get(&path)
                        .ok_or_else(|| std::io::Error::other("file not opened"))
                        .and_then(|captured| {
                            captured.read_settled(settle.filter(|_| !is_document(&path)))
                        });
                    let bytes = match read {
                        Ok(Some(bytes)) => bytes,
                        Ok(None) => {
                            files.push(deferred()?);
                            report.settling.push(identity::relative(&self.root, &path)?);
                            continue;
                        }
                        Err(_) => {
                            scan.incomplete = true;
                            files.push(deferred()?);
                            continue;
                        }
                    };
                    if let Some(stat) = walked
                        .opened
                        .get(&path)
                        .and_then(|captured| stat_metadata(&captured.metadata.borrow()))
                    {
                        stats.push((identity::relative(&self.root, &path)?, stat));
                    }
                    bytes
                }
            };
            // No blob the server holds is empty.
            if bytes.is_empty() && !is_document(&path) {
                files.push(deferred()?);
                report.skipped += 1;
                continue;
            }
            let (text, not_text) = kept_text(&path, &bytes);
            let decodes = not_text.is_none();
            let read = (decodes && carries_frontmatter(&path)).then(|| document::read(&text));
            let unreadable = match not_text {
                None => read.as_ref().and_then(|read| {
                    read.unreadable
                        .clone()
                        .or_else(|| fields::read(&read.front, edge_types).err())
                }),
                Some(reason) => Some(reason.to_string()),
            };
            // An unreadable file still names its item, so a move keeps it.
            let id = id_named(&path, &bytes, read.as_ref());
            let line = read
                .as_ref()
                .filter(|read| read.unreadable.is_none())
                .and_then(|read| line_of(&read.front));
            let metadata = walked
                .opened
                .get(&path)
                .map(|captured| captured.metadata.borrow().clone());
            files.push(Scanned {
                folded: false,
                key: identity::relative(&self.root, &path)?,
                mark: identities.get(&path).map(|found| found.key()),
                born: metadata.as_ref().and_then(identity::born),
                executable: self
                    .keeps_permissions()
                    .then(|| metadata.as_ref().is_some_and(executable::of)),
                hash: state::hash(&bytes),
                text,
                id,
                line,
                unreadable,
                deferred: false,
                source: Some(bytes),
                path,
            });
        }
        scan.files = files;
        Ok(())
    }

    /// Whether the root has gone, said on the report.
    fn root_left(&self, scan: &mut ScanState) -> ControlFlow<()> {
        match self.root_gone() {
            Some(gone) => {
                scan.report.root_gone = Some(gone);
                ControlFlow::Break(())
            }
            None => ControlFlow::Continue(()),
        }
    }

    /// Reloads the catalog from the server where a file changed, so a file
    /// read against an old list is not sent against it.
    fn refresh_catalog(&self, scan: &mut ScanState) -> Result<()> {
        let (files, snapshot) = (&scan.files, &scan.snapshot);
        // A file read against an old list would send a new type's line as a
        // property; where the list cannot be read, the one kept stands.
        let changed = files.iter().filter(|file| !file.deferred).any(|file| {
            !snapshot
                .iter()
                .any(|bound| bound.path == file.key && bound.content_hash == file.hash)
        });
        if changed
            && let Ok(http) = self.core.http()
            && let Ok(fresh) = http.catalog()
        {
            let conn = self.core.conn()?;
            crate::store::replace_catalog(&conn, &fresh)?;
            scan.catalog = crate::catalog::load(&conn)?;
            scan.edge_types = EdgeTypes::load(&conn)?;
        }
        Ok(())
    }

    /// Settles which item each read file belongs to, and holds the files
    /// that wait: a stale save, and what the claim cannot yet give.
    fn claim_scanned(
        &self,
        scan: &mut ScanState,
        peers: &Peers<'_>,
    ) -> Result<(Vec<Option<Claim>>, Waiting)> {
        let carried = self.still_carried(scan)?;
        let (mut claims, mut waiting) = self.claim(scan, peers, &carried)?;
        let (files, stale) = (&scan.files, &scan.stale);
        for (at, file) in files.iter().enumerate() {
            if let Some(reason) = stale.get(&file.key) {
                claims[at] = None;
                waiting.insert(at, reason.clone());
            }
        }
        // Not the carried item's file, so its record stands.
        scan.held_carried = carried
            .into_iter()
            .filter(|(path, held)| {
                files.iter().zip(&claims).any(|(file, claim)| {
                    file.key == *path
                        && claim
                            .as_ref()
                            .is_none_or(|claim| claim.item_id != held.item_id)
                })
            })
            .collect();
        Ok((claims, waiting))
    }

    /// Each binding whose path a read file with another identity stands at,
    /// or that the journal records another file carrying, while a file the
    /// pass holds or skips carries it, by path. A quick pass, which walks
    /// when it touches a recorded carrier, keeps the record's where it did
    /// not look at the carrier; so does a walk that could not read every file
    /// that may carry it.
    fn still_carried(&self, scan: &ScanState) -> Result<HashMap<String, HeldCarried>> {
        let recorded: HashMap<String, (String, String)> = state::journaled(&*self.core.conn()?)?
            .into_iter()
            .filter_map(|row| match row.kept {
                Some(state::Kept::Carried(carrier)) => Some((row.path, (row.item_id, carrier))),
                _ => None,
            })
            .collect();
        let read: HashMap<&str, &Scanned> = scan
            .files
            .iter()
            .map(|file| (file.key.as_str(), file))
            .collect();
        let recorded_for = |bound: &state::Bound| {
            recorded
                .get(&bound.path)
                .filter(|(item_id, _)| *item_id == bound.item_id)
                .map(|(_, carrier)| carrier.as_str())
        };
        let candidates: Vec<&state::Bound> = scan
            .snapshot
            .iter()
            .filter(|bound| {
                read.get(bound.path.as_str()).is_some_and(|file| {
                    file.mark != bound.identity || recorded_for(bound).is_some()
                })
            })
            .collect();
        let mut carried = HashMap::new();
        if candidates.is_empty() {
            return Ok(carried);
        }
        let carriers = self
            .carriers(&scan.walked, &scan.paths, &scan.skipped_keys)?
            .ok();
        let unsure = scan.scope.is_some() || carriers.is_none();
        for bound in candidates {
            let recorded = recorded_for(bound);
            let held = match carriers
                .as_ref()
                .and_then(|carriers| carriers.carrying(bound, recorded))
            {
                Some(found) => HeldCarried {
                    item_id: bound.item_id.clone(),
                    carrier: found.key.to_string(),
                    identity: found.identity.map(str::to_string),
                },
                None if unsure && let Some(carrier) = recorded => HeldCarried {
                    item_id: bound.item_id.clone(),
                    carrier: carrier.to_string(),
                    identity: None,
                },
                None => continue,
            };
            carried.insert(bound.path.clone(), held);
        }
        Ok(carried)
    }

    /// Embeds are read by name, before the claim says whose each file is. A
    /// file item's bytes are no document, so the embeds of a file the claim
    /// gives a file item are dropped, with the files only they named.
    fn follow_embeds_of_documents(
        &self,
        scan: &mut ScanState,
        claims: &[Option<Claim>],
    ) -> Result<()> {
        if scan.shown.is_empty() {
            return Ok(());
        }
        for (file, claim) in scan.files.iter().zip(claims) {
            if let Some(claim) = claim
                && scan.shown.contains_key(&file.key)
                && self.file_item(&claim.item_id, &scan.catalog)?
            {
                scan.shown.remove(&file.key);
            }
        }
        scan.embedded = scan
            .shown
            .values()
            .flatten()
            .filter_map(|(_, target)| match target {
                embeds::Target::At(at) => Some(at.clone()),
                _ => None,
            })
            .collect();
        Ok(())
    }

    /// Sends each read file to its item: a create, an update, a rename or a
    /// follow of an unread file, or flags it. Collects the edge work the
    /// files leave for the end. Ends the pass where the root goes.
    fn queue_scanned(
        &self,
        scan: &mut ScanState,
        claims: Vec<Option<Claim>>,
        mut waiting: Waiting,
    ) -> Result<ControlFlow<(), Vec<EdgeWork>>> {
        scan.removing = self.settle_taken()?;
        let (mode, settle) = (scan.mode, scan.settle);
        let reread_embeds = scan.reread_embeds;
        let held_outside = self.hold_outside(scan, &claims, &waiting)?;
        let held_back = self.hold_additions(scan, &claims, &waiting, &held_outside)?;
        let by_path = bound_by_path(&scan.snapshot);
        let (settings, catalog, edge_types) = (&scan.settings, &scan.catalog, &scan.edge_types);
        let (files, walked) = (&scan.files, &scan.walked);
        let (unanswered, embedded) = (&scan.unanswered, &scan.embedded);
        let (only_embedded, shown) = (&scan.only_embedded, &scan.shown);
        let (report, skipped_keys) = (&mut scan.report, &mut scan.skipped_keys);
        let withheld = self.withheld()?;
        let mut work: Vec<EdgeWork> = Vec::new();
        let mut moved_since: Vec<(String, EdgeWork)> = Vec::new();
        let mut unsettled: HashSet<String> = HashSet::new();

        for (at, (file, claim)) in files.iter().zip(claims).enumerate() {
            if let Some(gone) = self.root_gone() {
                report.root_gone = Some(gone);
                return Ok(ControlFlow::Break(()));
            }
            if only_embedded.contains(&file.key) && !embedded.contains(&file.key) {
                report.settling.retain(|path| *path != file.key);
                report.skipped += 1;
                skipped_keys.push(file.key.clone());
                continue;
            }
            if let Some(reason) = waiting.remove(&at) {
                report.flagged.push(Flagged {
                    path: file.key.clone(),
                    flag: "waiting",
                    reason,
                    item: None,
                });
                continue;
            }
            if let Some(why) = scan.removing.get(&file.key) {
                report.flagged.push(Flagged {
                    path: file.key.clone(),
                    flag: super::pull::REMOVING,
                    reason: why.clone(),
                    item: by_path
                        .get(file.key.as_str())
                        .map(|bound| bound.item_id.clone()),
                });
                continue;
            }
            if file.deferred {
                self.follow_unread(file, claim, catalog, &withheld, report)?;
                continue;
            }
            // A file item's file is its bytes, whatever its name says.
            let bytes_item = || -> Result<bool> {
                match &claim {
                    Some(claim) => self.file_item(&claim.item_id, catalog),
                    None => Ok(false),
                }
            };
            // A file at a document name is read at once, since the claim needs
            // its id line, so only the claim says whether it is a file item's,
            // which a copy or a download may still be writing.
            let settling = settle.is_some_and(|settle| {
                walked
                    .opened
                    .get(&file.path)
                    .is_some_and(|captured| captured.changed_within(settle))
            });
            // No blob the server holds is empty, so a file item emptied in
            // place, as an editor does before it writes, keeps its bytes until
            // there are some. The item decides, not the name: a note may be
            // empty.
            let emptied = file.source.as_deref().is_some_and(<[u8]>::is_empty);
            if (settling || emptied) && bytes_item()? {
                let unread = Scanned::deferred(
                    &self.root,
                    &file.path,
                    file.mark.clone(),
                    walked.opened.get(&file.path),
                )?;
                self.follow_unread(&unread, claim, catalog, &withheld, report)?;
                if settling {
                    report.settling.push(file.key.clone());
                    unsettled.insert(file.key.clone());
                } else {
                    report.skipped += 1;
                }
                continue;
            }
            if let Some(reason) = &file.unreadable
                && !bytes_item()?
            {
                self.hold_unreadable(file, claim.as_ref(), reason, &withheld)?;
                report.flagged.push(Flagged::of(
                    &file.key,
                    &format!("{}{reason}", state::UNREADABLE),
                ));
                continue;
            }
            // A binding to a row the copy no longer holds binds nothing.
            let claim = match claim {
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) if self.core.get(&item_id)?.is_none() => {
                    if let Some(refused) = bound
                        .writes
                        .refused
                        .iter()
                        .find(|refused| matches!(refused.change, state::Change::State(_)))
                    {
                        report.flagged.push(Flagged {
                            path: file.key.clone(),
                            flag: "refused",
                            reason: refused.reason.clone(),
                            item: Some(item_id.clone()),
                        });
                        if bound.path != file.key || bound.identity != file.mark {
                            let mut conn = self.core.conn()?;
                            let tx = conn.transaction()?;
                            state::bind(
                                &tx,
                                &state::Bound {
                                    path: file.key.clone(),
                                    identity: file.mark.clone(),
                                    ..bound.clone()
                                },
                            )?;
                            if bound.path != file.key {
                                if state::bound_at(&tx, &bound.path)?
                                    .is_some_and(|row| row.item_id == item_id)
                                {
                                    state::unbind(&tx, &bound.path)?;
                                    state::journal_clear(&tx, &bound.path)?;
                                }
                                report.renamed += 1;
                            }
                            tx.commit()?;
                        }
                        continue;
                    }
                    // The server has answered these bytes already; the file of
                    // an item purged or in the bin, of the folder's own bytes,
                    // is the pull's to take away (35).
                    if bound.path == file.key
                        && bound.content_hash == file.hash
                        && self.create_over_limit(&item_id)?.is_none()
                    {
                        let pulls = bound.written_hash.as_deref() == Some(file.hash.as_str()) && {
                            let conn = self.core.conn()?;
                            crate::store::purged(&conn, &item_id)?
                                || crate::store::item_held(&conn, &item_id)?
                        };
                        report.lost += usize::from(!pulls);
                        continue;
                    }
                    self.unbind_if_still(&bound)?;
                    report.requeued += 1;
                    None
                }
                other => other,
            };
            match claim {
                None if held_outside.contains(&at) || held_back.contains(&at) => {
                    // Read again by the next pass, which counts the drop anew.
                    unsettled.insert(file.key.clone());
                }
                None => {
                    if self.queue_create(
                        file,
                        (settings, embedded.contains(&file.key)),
                        catalog,
                        edge_types,
                        &withheld,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report.created += 1;
                        report.warnings.extend(near_limit(
                            &file.key,
                            &file.text,
                            catalog.request_limit(),
                        ));
                    }
                }
                Some(Claim {
                    item_id,
                    bound: None,
                }) => {
                    if self.queue_update(
                        &item_id,
                        None,
                        file,
                        None,
                        catalog,
                        edge_types,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report.updated += 1;
                        report
                            .warnings
                            .extend(self.size_warning(file, &item_id, catalog)?);
                    } else {
                        report.unchanged += 1;
                    }
                    self.place(&item_id, &file.key, &withheld)?;
                }
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) if bound.path == file.key => {
                    if bound.content_hash == file.hash && !local_properties_refusal(&bound) {
                        let waiting = unanswered.contains(&item_id);
                        // A permission changed alone leaves the bytes as they
                        // were.
                        if let Some(runs) = file.executable
                            && let Some(held) = self.core.get(&item_id)?
                            && bytes_of(&held, catalog).is_some()
                            && executable::held(&held) != runs
                        {
                            self.queue_update_file(&bound, file, &held, catalog)?;
                            report.updated += 1;
                            continue;
                        }
                        // Under the earlier rule an embed attached its file
                        // and recorded it so; read once more, it references
                        // the file and attaches only one the query does not
                        // hold.
                        let reread = reread_embeds
                            && (shown.contains_key(&file.key)
                                || bound.lines.iter().any(|line| {
                                    line.edge_type == embeds::ATTACHMENT_EDGE
                                        && line.end == marfa_rules::catalog::End::To
                                }));
                        let unchanged = || {
                            let mut pending = self.edge_work(file, &item_id, Some(&bound));
                            pending.refused_lookups = bound.writes.refused_lookups.clone();
                            pending
                        };
                        match edges_again(&bound) {
                            Again::Now => work.push(unchanged()),
                            _ if reread => work.push(unchanged()),
                            Again::IfMoved(at) => moved_since.push((at, unchanged())),
                            Again::No => {}
                        }
                        // An editor's atomic save gives the same bytes a new
                        // inode, and a stale record would lose the next rename;
                        // and a file taken back by its bytes has no record yet.
                        if bound.identity != file.mark || !by_path.contains_key(file.key.as_str()) {
                            let conn = self.core.conn()?;
                            state::bind(
                                &conn,
                                &state::Bound {
                                    identity: file.mark.clone(),
                                    ..bound
                                },
                            )?;
                        }
                        if waiting {
                            report.waiting += 1;
                        } else {
                            report.unchanged += 1;
                        }
                        continue;
                    }
                    if self.queue_update(
                        &item_id,
                        Some(&bound),
                        file,
                        None,
                        catalog,
                        edge_types,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report.updated += 1;
                        report
                            .warnings
                            .extend(self.size_warning(file, &item_id, catalog)?);
                        // Edited where the pull moved it, it is no longer
                        // the file an old buffer was read from.
                        if !file.folded {
                            state::clear_moved_from(&*self.core.conn()?, &item_id)?;
                        }
                    } else {
                        report.unchanged += 1;
                    }
                }
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) => {
                    self.unbind_if_still(&bound)?;
                    state::note_left(&*self.core.conn()?, &self.folder, &item_id, &bound.path)?;
                    state::clear_moved_from(&*self.core.conn()?, &item_id)?;
                    // A file item's bytes are no document, whatever its name now.
                    let document = (carries_frontmatter(&file.path)
                        && !self.file_item(&item_id, catalog)?)
                    .then(|| file.document());
                    let retitle =
                        self.renamed_title(&item_id, &bound, file, document.as_ref(), catalog)?;
                    // A title typed in the line in the same pass goes first,
                    // so the item's history holds it as well as the name's.
                    let typed = retitle
                        .as_ref()
                        .zip(document.as_ref())
                        .and_then(|(retitle, document)| typed_title(&bound, document, retitle));
                    // A title the copy would refuse leaves the file as the
                    // person wrote it, held, and only its placement moves.
                    if let Some(error) = retitle.as_ref().and_then(|retitle| {
                        typed
                            .iter()
                            .chain([&retitle.title])
                            .find_map(|title| retitle.refusal(title, catalog))
                    }) {
                        let held_for = format!("{LOCAL_ADMISSION_REFUSAL}{error}");
                        report.flagged.push(Flagged::of(&file.key, &held_for));
                        self.bind_held(file, &item_id, Some(&bound), held_for, None)?;
                        self.place(&item_id, &file.key, &withheld)?;
                        report.renamed += 1;
                        continue;
                    }
                    let mut bound = bound;
                    if let Some(retitle) = &retitle
                        && let Some(typed) = &typed
                        && let Some(id) = self.queue_title(&item_id, retitle, typed, file.line)?
                    {
                        bound.writes.queued.push(state::Queued {
                            id,
                            save: bound.writes.save + 1,
                            line: None,
                            default: false,
                        });
                    }
                    let rewritten = retitle
                        .as_ref()
                        .filter(|_| mode == Files::Write)
                        .and_then(|retitle| self.retitle_file(file, retitle));
                    // Where the title line was not rewritten, the title goes
                    // beside the file's bytes.
                    let sent_title = retitle.as_ref().filter(|_| rewritten.is_none());
                    // The title line it now says is not what this pass read.
                    if rewritten.is_some() {
                        unsettled.insert(file.key.clone());
                    }
                    let file = rewritten.as_ref().unwrap_or(file);
                    if self.queue_update(
                        &item_id,
                        Some(&bound),
                        file,
                        sent_title,
                        catalog,
                        edge_types,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report
                            .warnings
                            .extend(self.size_warning(file, &item_id, catalog)?);
                    }
                    self.place(&item_id, &file.key, &withheld)?;
                    report.renamed += 1;
                }
            }
        }
        // After every create of the pass, so a name made in it resolves.
        let now = state::copy_moment(&*self.core.conn()?)?;
        work.extend(
            moved_since
                .into_iter()
                .filter(|(at, _)| *at != now)
                .map(|(_, pending)| pending),
        );
        // Without its stat, the next quick pass reads it again.
        scan.stats.retain(|(key, _)| !unsettled.contains(key));

        Ok(ControlFlow::Continue(work))
    }

    /// File-level errors hold the affected file for a later scan.
    fn queue_edge_work(&self, scan: &mut ScanState, mut work: Vec<EdgeWork>) -> Result<()> {
        let (catalog, edge_types) = (&scan.catalog, &scan.edge_types);
        let (shown, report) = (&mut scan.shown, &mut scan.report);
        // Every file is bound now, so a link or a line naming one that
        // arrived in the same scan resolves.
        let mut resolver = Resolver::new(&self.core, catalog, &BoundFiles, &crate::NEVER_STOPPED);
        let now = state::copy_moment(&*self.core.conn()?)?;
        for pending in &mut work {
            pending.embeds = shown.remove(&pending.path).unwrap_or_default();
        }
        // The names of every file go to the server together, so a folder of
        // many links costs a few calls and not several for each link. A name
        // this leaves out is asked for alone where its file asks, and a
        // failure here is judged there, file by file, so it is not raised.
        let names: Vec<String> = work
            .iter()
            .flat_map(|pending| pending.lookup_names(edge_types))
            .collect();
        let _ = resolver.prefetch(names.iter().map(String::as_str));
        for pending in work {
            // A failed edge batch leaves the file waiting with its previous
            // link record, while the scan continues with the other files.
            let mut queued = Vec::new();
            let judged = self.queue_edges(
                &pending,
                edge_types,
                catalog,
                &mut resolver,
                &mut queued,
                None,
            );
            if let Err(error) = &judged
                && error.is_copy_wide()
            {
                return judged.map(|_| ());
            }
            let rejudged = judged.is_ok();
            let outcome = judged.unwrap_or_else(|error| lines::Outcome {
                links: pending.had_links.clone(),
                embedded: pending.had_embeds.clone(),
                unattached: pending.had_unattached.clone(),
                lines: pending.had_lines.clone(),
                held: Some(format!("{}{error}", state::EDGES_WAITING)),
                refused: Vec::new(),
                embeds: Vec::new(),
                refused_lookups: pending.refused_lookups.clone(),
                unmatched: false,
            });
            report.embeds.extend(
                outcome
                    .embeds
                    .iter()
                    .map(|reason| embeds::reported(&pending.path, reason.clone())),
            );
            let conn = self.core.conn()?;
            if let Some(bound) = state::bound_at(&conn, &pending.path)? {
                if let Some(held) = &outcome.held {
                    report.flagged.push(Flagged::of(&pending.path, held));
                }
                let mut writes = bound.writes.clone();
                writes.rejudge = outcome.held.as_ref().map(|_| {
                    if outcome.unmatched {
                        state::Rejudge::Moved(now.clone())
                    } else {
                        state::Rejudge::FileChanged
                    }
                });
                writes.refused_lookups = outcome.refused_lookups;
                writes.unattached = outcome.unattached;
                let held = outcome.held;
                let save = writes.save;
                writes
                    .queued
                    .extend(queued.into_iter().map(|id| state::Queued {
                        id,
                        save,
                        line: None,
                        default: false,
                    }));
                // A refused edge the file no longer asks for holds it no longer,
                // and one the copy refused was judged again in this pass.
                writes.refused.retain(|refused| match &refused.change {
                    state::Change::Edge { .. } if rejudged && copy_refused(refused) => false,
                    state::Change::Edge { line, shown } => outcome.lines.contains(line) == *shown,
                    _ => true,
                });
                // Refused by the copy, a line is held as one the server refused.
                for (line, reason) in outcome.refused {
                    report.flagged.push(Flagged {
                        path: pending.path.clone(),
                        flag: "refused",
                        reason: reason.clone(),
                        item: None,
                    });
                    let change = state::Change::Edge { line, shown: true };
                    writes
                        .refused
                        .retain(|refused| !change.supersedes(&refused.change));
                    writes.refused.push(state::Refused {
                        change,
                        save,
                        reason,
                    });
                }
                state::bind(
                    &conn,
                    &state::Bound {
                        links: outcome.links,
                        embeds: outcome.embedded,
                        lines: outcome.lines,
                        held,
                        writes,
                        ..bound
                    },
                )?;
            }
        }
        report.lookup_refused = resolver.refused_call().map(str::to_string);
        report.lookup_answered = resolver.answered();

        Ok(())
    }

    /// Records the size and time each file had before its read, and keeps
    /// them with the hash of the bytes read, for health.
    fn record_stats(&self, scan: &ScanState) -> Result<()> {
        let conn = self.core.conn()?;
        state::set_stats(&conn, &scan.stats, scan.full)?;
        if !scan.incomplete {
            state::prune_unheld(&conn, &scan.seen)?;
        }
        let stats: HashMap<&str, &str> = scan
            .stats
            .iter()
            .map(|(key, stat)| (key.as_str(), stat.as_str()))
            .collect();
        let mut last = self.last_reads.lock().expect("last reads lock");
        if scan.full {
            last.clear();
        }
        for file in &scan.files {
            last.remove(&file.key);
            if file.deferred || file.folded {
                continue;
            }
            if let Some(stat) = stats.get(file.key.as_str())
                && let Some(captured) = scan.walked.opened.get(&file.path)
                && let Some(read) =
                    super::health::LastRead::of(captured, stat, &file.hash, scan.began)
            {
                last.insert(file.key.clone(), read);
            }
        }
        Ok(())
    }

    /// Journals the bound files the walk did not find, rather than deleting
    /// them, and sweeps the journal where the pass saw the whole folder.
    fn sweep(&self, scan: &mut ScanState, peers: &Peers<'_>) -> Result<ControlFlow<()>> {
        let removing = std::mem::take(&mut scan.removing);
        let (seen, lists, walked, settings) =
            (&scan.seen, &scan.lists, &scan.walked, &scan.settings);
        let (mut incomplete, report) = (scan.incomplete, &mut scan.report);
        let quick = scan.scope.is_some();
        let mut carriers: Option<Carriers> = None;
        // Journaled rather than deleted: the first half of a rename looks
        // exactly like a delete.
        let bound = state::bound_paths(&*self.core.conn()?)?;
        // By path and item: another item's file at the path answers no delete.
        let journaled: HashMap<(String, String), Option<state::Kept>> = {
            let conn = self.core.conn()?;
            state::journaled(&conn)?
                .into_iter()
                .map(|row| ((row.path, row.item_id), row.kept))
                .collect()
        };
        let present: HashSet<String> = bound
            .iter()
            .filter(|(path, _)| seen.contains(path))
            .map(|(_, item_id)| item_id.clone())
            .collect();
        for ((path, item_id), kept) in &journaled {
            if matches!(kept, Some(state::Kept::Carried(_)))
                && !bound.contains(&(path.clone(), item_id.clone()))
            {
                state::journal_clear_for(&*self.core.conn()?, path, item_id)?;
            }
        }
        for (path, item_id) in bound {
            let row = journaled.get(&(path.clone(), item_id.clone()));
            let held = row.is_some();
            let was_carried = matches!(row, Some(Some(state::Kept::Carried(_))));
            let stands = seen.contains(&path);
            if stands && !held && !scan.held_carried.contains_key(&path) {
                continue;
            }
            if let Some(gone) = self.root_gone() {
                report.root_gone = Some(gone);
                return Ok(ControlFlow::Break(()));
            }
            if let Some(why) = removing.get(&path) {
                if held {
                    state::journal_clear(&*self.core.conn()?, &path)?;
                }
                report.flagged.push(Flagged {
                    path: path.clone(),
                    flag: super::pull::REMOVING,
                    reason: why.clone(),
                    item: Some(item_id.clone()),
                });
                continue;
            }
            if stands {
                let conn = self.core.conn()?;
                if let Some(carried) = scan.held_carried.get(&path) {
                    let identity = carried.identity.as_deref();
                    state::journal_carried(&conn, &path, &item_id, &carried.carrier, identity)?;
                    report.carried += 1;
                    continue;
                }
                // Back inside the grace, so the server never hears of it.
                state::journal_clear(&conn, &path)?;
                continue;
            }
            // Not reached is not gone: the item of a file the lists stopped
            // taking, or one the walk could not read or passed over, is not trashed.
            if !self.reaches(lists, &path) || walked.passed_over(&path) {
                if held {
                    let conn = self.core.conn()?;
                    state::journal_clear(&conn, &path)?;
                }
                report.unreached += 1;
                continue;
            }
            // An interrupted move can leave a binding at its missing source path.
            if present.contains(&item_id) {
                let conn = self.core.conn()?;
                state::unbind(&conn, &path)?;
                state::journal_clear(&conn, &path)?;
                continue;
            }
            // An unread part of the inventory may hold a file moved from
            // any other path, so no missing path proves a deletion this pass.
            if incomplete {
                continue;
            }
            let carriers = match carriers {
                Some(ref carriers) => carriers,
                None => match self.carriers(walked, &scan.paths, &scan.skipped_keys)? {
                    Ok(found) => carriers.insert(found),
                    // Unread, it may carry this item or any other.
                    Err((key, error)) => {
                        report.flagged.push(Flagged {
                            path: key,
                            flag: "unreadable",
                            reason: format!(
                                "{error}, so this pass journals no missing file until it can be read"
                            ),
                            item: None,
                        });
                        incomplete = true;
                        continue;
                    }
                },
            };
            let conn = self.core.conn()?;
            let recorded = match row {
                Some(Some(state::Kept::Carried(carrier))) => Some(carrier.as_str()),
                _ => None,
            };
            let carrier = state::bound_at(&conn, &path)?
                .filter(|row| row.item_id == item_id)
                .and_then(|row| {
                    carriers
                        .carrying(&row, recorded)
                        .map(|found| (found.key.to_string(), found.identity.map(str::to_string)))
                });
            if let Some((carrier, identity)) = carrier {
                state::journal_carried(&conn, &path, &item_id, &carrier, identity.as_deref())?;
                report.carried += 1;
                continue;
            }
            // A quick pass that touched a carrier walks instead, so this one
            // did not look at the file that carries it.
            if quick && was_carried {
                report.carried += 1;
                continue;
            }
            if quick && !held {
                scan.walk_again = true;
                continue;
            }
            if was_carried {
                state::journal_uncarried(&conn, &path, &item_id)?;
            } else {
                state::journal_missing(&conn, &path, &item_id)?;
            }
            report.missing += 1;
        }
        if scan.walk_again {
            return Ok(ControlFlow::Continue(()));
        }
        if !incomplete && self.root_gone().is_none() {
            report.swept = true;
            if scan.journal == Journal::Sweep {
                self.sweep_journal(settings, peers, scan.full, report)?;
            }
        } else {
            self.note_kept_look_passed()?;
        }
        Ok(ControlFlow::Continue(()))
    }

    /// The files `one_per_name` held and those the pass skipped, which are no
    /// documents and so carry no id line.
    fn carriers(
        &self,
        walked: &Walked,
        paths: &[PathBuf],
        skipped: &[String],
    ) -> Result<std::result::Result<Carriers, (String, std::io::Error)>> {
        let read: HashSet<&PathBuf> = paths.iter().collect();
        let mut files = Vec::new();
        for path in walked.files.iter().filter(|path| !read.contains(path)) {
            files.push((path.clone(), identity::relative(&self.root, path)?, true));
        }
        files.extend(
            skipped
                .iter()
                .map(|key| (self.root.join(key), key.clone(), false)),
        );
        Ok(Carriers::of(
            walked,
            files
                .iter()
                .map(|(path, key, read_id)| (path.as_path(), key.as_str(), *read_id)),
        ))
    }

    /// An editor that did not follow a pull's move of a document saves its old
    /// buffer where the file was. In a scan that writes files, such a save at
    /// that name as the volume compares names, never one held for its name,
    /// naming the item and a version line no newer than the item's when it
    /// moved, takes the place of the item's file where that file holds nothing
    /// the device has not read and sent. Otherwise it waits, keyed by path
    /// with why. A scan that keeps the files takes none and holds the saves
    /// a scan that writes would hold. Never a new item, and never a byte of
    /// the item's file lost: that file is renamed aside, checked there, and
    /// only then removed.
    fn fold_stale_saves(
        &self,
        files: &mut Vec<Scanned>,
        snapshot: &[state::Bound],
        seen: &mut HashSet<String>,
        mode: Files,
    ) -> Result<HashMap<String, String>> {
        let mut waiting = HashMap::new();
        let (moved, mut held) = {
            let conn = self.core.conn()?;
            (state::moved_from(&conn)?, state::stale_waits(&conn)?)
        };
        // Held until the person changes or removes the old buffer itself.
        for path in held.keys() {
            if !self.exists(self.root.join(path)) {
                state::clear_stale_wait(&*self.core.conn()?, path)?;
            }
        }
        held.retain(|path, _| self.exists(self.root.join(path)));
        if moved.is_empty() && held.is_empty() {
            return Ok(waiting);
        }
        let mut at = 0;
        while at < files.len() {
            let file = &files[at];
            if let Some(wait) = held.get(&file.key) {
                if wait.hash == file.hash {
                    waiting.insert(file.key.clone(), wait.reason.clone());
                    at += 1;
                    continue;
                }
                state::clear_stale_wait(&*self.core.conn()?, &file.key)?;
            }
            let Some(bound) = file
                .id
                .as_deref()
                .filter(|_| {
                    !file.deferred && file.unreadable.is_none() && carries_frontmatter(&file.path)
                })
                .and_then(|id| Some((moved.get(id)?, id)))
                .filter(|(from, _)| {
                    self.one_name_on_volume(&from.path, &file.key)
                        && file.line.is_some_and(|line| line <= from.version)
                })
                .and_then(|(_, id)| snapshot.iter().find(|row| row.item_id == id))
                .filter(|bound| {
                    bound.path != file.key
                        && (bound.identity.is_none() || bound.identity != file.mark)
                })
            else {
                at += 1;
                continue;
            };
            // Moving files is writing them: a scan that keeps the files
            // leaves the save where it is for a scan that writes. A save
            // that scan would hold is held now, in the state alone, since
            // reading the moved file below ends what makes it an old buffer.
            if mode == Files::Keep {
                let reason = match self.stale_save_refusal(bound) {
                    Some(reason) => {
                        state::set_stale_wait(
                            &*self.core.conn()?,
                            &file.key,
                            &state::StaleWait {
                                hash: file.hash.clone(),
                                reason: reason.clone(),
                            },
                        )?;
                        reason
                    }
                    None => format!(
                        "it is an old copy of {}, which a push that writes files takes",
                        bound.path
                    ),
                };
                waiting.insert(file.key.clone(), reason);
                at += 1;
                continue;
            }
            match self.take_stale_save(file, bound)? {
                Err(reason) => {
                    state::set_stale_wait(
                        &*self.core.conn()?,
                        &file.key,
                        &state::StaleWait {
                            hash: file.hash.clone(),
                            reason: reason.clone(),
                        },
                    )?;
                    waiting.insert(file.key.clone(), reason);
                    at += 1;
                }
                Ok(()) => {
                    let path = bound.path.clone();
                    seen.insert(path.clone());
                    let mut file = files.remove(at);
                    file.path = self.root.join(&path);
                    file.key = path;
                    file.folded = true;
                    match files.iter().position(|other| other.key == file.key) {
                        Some(other) => files[other] = file,
                        None => files.insert(at, file),
                    }
                }
            }
        }
        Ok(waiting)
    }

    /// Whether the volume reads `moved` and `key` as one name: the same bytes,
    /// or another case or form of it that the volume finds the same file by.
    fn one_name_on_volume(&self, moved: &str, key: &str) -> bool {
        moved == key
            || (marfa_rules::names::same(moved, key)
                && matches!(
                    (
                        self.root_dir.entry_identity(Path::new(moved)),
                        self.root_dir.entry_identity(Path::new(key)),
                    ),
                    (Ok(one), Ok(other)) if one == other
                ))
    }

    /// Why a save of an old buffer of `bound`'s file is held and not taken, as
    /// `take_stale_save` decides before it moves anything: the file holds a
    /// change of its own, or bytes the device has not read. Moves nothing.
    fn stale_save_refusal(&self, bound: &state::Bound) -> Option<String> {
        let own = |reason: &str| Some(format!("it is an old copy of {}, {reason}", bound.path));
        if bound.held.is_some() || bound.holds_refusal() {
            return own("which holds a change of its own; keep one of the two");
        }
        match self.read(self.root.join(&bound.path)) {
            Ok(found) if state::hash(&found) != bound.content_hash => {
                own("which holds an edit of its own; keep one of the two")
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                own(&format!("which could not be replaced: {error}"))
            }
            _ => None,
        }
    }

    /// Moves `file` to `bound`'s path, every step a rename that replaces
    /// nothing: the bound file aside, checked to be the file read with the
    /// bytes it is bound to, the save in its place, and only then the bound
    /// file removed. Answers why not, where it did not.
    fn take_stale_save(
        &self,
        file: &Scanned,
        bound: &state::Bound,
    ) -> Result<std::result::Result<(), String>> {
        let own = |reason: &str| Err(format!("it is an old copy of {}, {reason}", bound.path));
        // A held or refused file holds the person's bytes, which the server
        // does not. Any other change read since the move is an earlier old
        // buffer, since an edit of the moved file ends its record.
        if bound.held.is_some() || bound.holds_refusal() {
            return Ok(own("which holds a change of its own; keep one of the two"));
        }
        let target = self.root.join(&bound.path);
        let edited = || own("which holds an edit of its own; keep one of the two");
        let failed = |error: std::io::Error| own(&format!("which could not be replaced: {error}"));
        let (from_dir, from_name) = match self.location(&file.path, false) {
            Ok(found) => found,
            Err(error) => return Ok(failed(error)),
        };
        let conn = self.core.conn()?;
        let place = match self
            .inside(target.parent())
            .and_then(|()| self.guarded(&conn, &target, true))
        {
            Ok(place) => place,
            Err(error) => return Ok(failed(error)),
        };
        let to_name = Path::new(&place.name);
        let place_save =
            || landing::rename_new_at(&from_dir, Path::new(&from_name), &place.directory, to_name);
        let withdrawn = landing::withdraw_at(
            &place.directory,
            place.guard(),
            to_name,
            |found| state::hash(found) == bound.content_hash,
            place_save,
        );
        Ok(match withdrawn {
            Ok(landing::Withdrawal::Absent) => match place_save() {
                Ok(()) => Ok(()),
                Err(error) => failed(error),
            },
            Ok(landing::Withdrawal::Removed) => Ok(()),
            Ok(landing::Withdrawal::Kept(None)) => edited(),
            Ok(landing::Withdrawal::Kept(Some(kept))) => own(&format!(
                "which was saved meanwhile while another file took its name; that save is kept as {}",
                super::joined(
                    &Path::new(&bound.path)
                        .parent()
                        .map(|parent| parent.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    &kept.to_string_lossy()
                )
            )),
            Ok(landing::Withdrawal::Undone(error)) => failed(error),
            Err(landing::RemoveError::Read(error) | landing::RemoveError::Remove(error)) => {
                failed(error)
            }
        })
    }

    /// Held ids decide first; then the binding by identity across every file
    /// before any by path, so a path never takes an item another file is by
    /// identity.
    fn claim(
        &self,
        scan: &ScanState,
        peers: &Peers<'_>,
        carried: &HashMap<String, HeldCarried>,
    ) -> Result<(Vec<Option<Claim>>, Waiting)> {
        let (files, snapshot, shown) = (&scan.files, &scan.snapshot, &scan.shown);
        let (settings, catalog) = (&scan.settings, &scan.catalog);
        let by_mark: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .filter_map(|row| row.identity.as_deref().map(|mark| (mark, row)))
            .collect();
        // Another file carries such a binding, so a file at its path is not
        // its item's.
        let by_path: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .filter(|row| !carried.contains_key(&row.path))
            .map(|row| (row.path.as_str(), row))
            .collect();
        let by_item: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .map(|row| (row.item_id.as_str(), row))
            .collect();
        let named = |file: &Scanned| -> Option<&state::Bound> {
            match file.mark.as_deref().and_then(|mark| by_mark.get(mark)) {
                Some(bound) => Some(bound),
                None => by_path.get(file.key.as_str()).copied(),
            }
        };

        // A copy bound to its own item before its id line was rewritten stays
        // that item's file.
        let kept_by_path = |file: &Scanned, id: &str| {
            by_path
                .get(file.key.as_str())
                .is_some_and(|bound| bound.identity == file.mark && bound.item_id != id)
        };
        let arriving = |file: &Scanned, id: &str| {
            !kept_by_path(file, id) && named(file).is_none_or(|bound| bound.item_id != id)
        };
        let unheld = self.read_arrivals(
            files,
            &files
                .iter()
                .enumerate()
                .filter_map(|(at, file)| {
                    file.id
                        .as_deref()
                        .filter(|id| arriving(file, id))
                        .map(|id| (at, id))
                })
                .collect::<Vec<_>>(),
            peers,
        )?;

        let mut contests: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        let mut waiting = Waiting::new();
        let members = OnceCell::new();
        for (at, file) in files.iter().enumerate() {
            let Some(id) = file.id.as_deref() else {
                continue;
            };
            if kept_by_path(file, id) {
                continue;
            }
            if arriving(file, id) {
                match self.arrival(id, settings, peers, &members, &unheld) {
                    Arrival::Copy => continue,
                    Arrival::Waits(reason) => {
                        waiting.insert(at, reason);
                        continue;
                    }
                    Arrival::Here => {}
                }
            }
            if self
                .core
                .get(id)?
                .is_some_and(|item| named_by_its_file(&item, catalog))
            {
                contests.entry(id).or_default().push(at);
            }
        }
        for (at, file) in files.iter().enumerate() {
            if file
                .id
                .as_deref()
                .is_some_and(|id| contests.contains_key(id))
            {
                continue;
            }
            if let Some(bound) = named(file)
                && let Some(members) = contests.get_mut(bound.item_id.as_str())
            {
                members.push(at);
            }
        }

        let mut claims: Vec<Option<Claim>> = vec![None; files.len()];
        let mut taken: HashSet<String> = HashSet::new();
        for (id, members) in &contests {
            let bound = by_item.get(id).copied();
            let keeper = bound
                .and_then(|bound| {
                    members
                        .iter()
                        .find(|at| bound.identity.is_some() && files[**at].mark == bound.identity)
                        .or_else(|| members.iter().find(|at| files[**at].key == bound.path))
                })
                .or_else(|| {
                    members.iter().min_by(|a, b| {
                        let (a, b) = (&files[**a], &files[**b]);
                        // No birth time sorts after any.
                        (a.born.is_none(), a.born, &a.key).cmp(&(b.born.is_none(), b.born, &b.key))
                    })
                });
            if let Some(at) = keeper {
                claims[*at] = Some(Claim {
                    item_id: (*id).to_string(),
                    bound: bound.cloned(),
                });
                taken.insert((*id).to_string());
            }
        }
        for (at, file) in files.iter().enumerate() {
            if claims[at].is_some() {
                continue;
            }
            if let Some(bound) = file.mark.as_deref().and_then(|mark| by_mark.get(mark))
                && taken.insert(bound.item_id.clone())
            {
                claims[at] = Some(Claim {
                    item_id: bound.item_id.clone(),
                    bound: Some((*bound).clone()),
                });
            }
        }
        for (at, file) in files.iter().enumerate() {
            if claims[at].is_some() || waiting.contains_key(&at) {
                continue;
            }
            if let Some(bound) = by_path.get(file.key.as_str())
                && taken.insert(bound.item_id.clone())
            {
                claims[at] = Some(Claim {
                    item_id: bound.item_id.clone(),
                    bound: Some((*bound).clone()),
                });
            }
        }
        // Sent as new, it would take the path and so the carried item's
        // binding, its identity and what the folder agreed with the server.
        for (at, file) in files.iter().enumerate() {
            if claims[at].is_some() || waiting.contains_key(&at) {
                continue;
            }
            if let Some(held) = carried.get(&file.key) {
                waiting.insert(at, carried_path_waits(&held.carrier));
            }
        }
        // A directory added again can recognize its own ID-less files by placement and bytes.
        let mut placed: Option<HashMap<String, Vec<crate::model::Edge>>> = None;
        // Each path a Markdown file here embeds, with the items those files are.
        let mut embedders: Option<HashMap<String, HashSet<String>>> = None;
        // Each attachment the scan could not read, with why.
        let mut unread: HashMap<String, String> = HashMap::new();
        for (at, file) in files.iter().enumerate() {
            if file.deferred
                || claims[at].is_some()
                || waiting.contains_key(&at)
                || file.id.is_some()
            {
                continue;
            }
            let placed = match &mut placed {
                Some(placed) => placed,
                None => {
                    // Before a folder's first pull, its copy holds no
                    // attachment outside the query, nor where it is placed.
                    unread = self.hold_attachments(
                        members.get_or_init(|| self.members(settings).unwrap_or_default()),
                    )?;
                    placed.insert(self.placed_here()?)
                }
            };
            let candidates = placed
                .get(&marfa_rules::names::folded(&file.key))
                .map(Vec::as_slice)
                .unwrap_or_default();
            for edge in candidates {
                if by_item.contains_key(edge.from_id.as_str()) || taken.contains(&edge.from_id) {
                    continue;
                }
                if !self.holds(&edge.from_id, settings, &members) {
                    let embedders =
                        embedders.get_or_insert_with(|| embedded_by(files, &claims, shown));
                    let Some(hosts) = embedders.get(&marfa_rules::names::folded(&file.key)) else {
                        continue;
                    };
                    let attached = self.core.edges_from(&edge.from_id)?.iter().any(|to| {
                        to.edge_type == embeds::ATTACHMENT_EDGE
                            && hosts.contains(&to.to_id)
                            && self.holds(&to.to_id, settings, &members)
                    });
                    if !attached {
                        continue;
                    }
                }
                let Some(item) = self.core.get(&edge.from_id)? else {
                    continue;
                };
                // A note's Markdown file carries its id line, so one without
                // it is only ever a file item's.
                if carries_frontmatter(&file.path) && bytes_of(&item, catalog).is_none()
                    || !self.holds_bytes(&item, file, catalog)
                {
                    continue;
                }
                taken.insert(item.id.clone());
                let blob = bytes_of(&item, catalog).map(str::to_string);
                claims[at] = Some(Claim {
                    item_id: item.id.clone(),
                    bound: Some(state::Bound {
                        path: file.key.clone(),
                        item_id: item.id,
                        identity: None,
                        content_hash: file.hash.clone(),
                        presentation: None,
                        blob,
                        // The item's own bytes, as a pull would have written
                        // them, so the file is the folder's to take away.
                        written_hash: Some(file.hash.clone()),
                        links: Vec::new(),
                        embeds: Vec::new(),
                        lines: Vec::new(),
                        edit_line: None,
                        held: None,
                        own: None,
                        writes: state::Writes::default(),
                    }),
                });
                break;
            }
            // Neither new nor that item until it can be read, since a pull
            // writes that item's file beside the new one's as a second copy.
            if claims[at].is_none() && !unread.is_empty() {
                let embedders = embedders.get_or_insert_with(|| embedded_by(files, &claims, shown));
                for host in embedders
                    .get(&marfa_rules::names::folded(&file.key))
                    .into_iter()
                    .flatten()
                {
                    if !self.holds(host, settings, &members) {
                        continue;
                    }
                    let edges = self.core.edges_to(host)?;
                    let Some(error) = edges
                        .iter()
                        .filter(|edge| edge.edge_type == embeds::ATTACHMENT_EDGE)
                        .find_map(|edge| unread.get(&edge.from_id))
                    else {
                        continue;
                    };
                    waiting.insert(
                        at,
                        format!(
                            "a document here embeds it and has an attached file that cannot be read yet ({error}), which may be this file's item; it is taken once that file can be read"
                        ),
                    );
                    break;
                }
            }
        }
        // A file that carries no id, moved here from another folder on this
        // machine, is the item that folder bound it to.
        for (at, file) in files.iter().enumerate() {
            if file.deferred
                || claims[at].is_some()
                || waiting.contains_key(&at)
                || file.id.is_some()
            {
                continue;
            }
            let Some(theirs) = peers.left_behind(
                file.mark.as_deref(),
                &file.hash,
                carries_frontmatter(&file.path),
            ) else {
                continue;
            };
            if by_item.contains_key(theirs.item_id.as_str()) || taken.contains(&theirs.item_id) {
                continue;
            }
            match self.read_unheld(&theirs.item_id)? {
                Some(reason) => {
                    waiting.insert(at, reason);
                }
                None if self.core.get(&theirs.item_id)?.is_some() => {
                    taken.insert(theirs.item_id.clone());
                    claims[at] = Some(Claim {
                        item_id: theirs.item_id.clone(),
                        // What that folder's binding says of the bytes, and
                        // nothing of its queue.
                        bound: Some(state::Bound {
                            edit_line: None,
                            held: None,
                            writes: state::Writes::default(),
                            ..theirs
                        }),
                    });
                }
                None => {}
            }
        }
        Ok((claims, waiting))
    }

    /// A file the scan did not read, its bytes still settling or empty or
    /// unreadable now: its item follows it by identity, or by name, and the
    /// folder holds what it last agreed with meanwhile.
    fn follow_unread(
        &self,
        file: &Scanned,
        claim: Option<Claim>,
        catalog: &Catalog,
        withheld: &placement::Withheld,
        report: &mut ScanReport,
    ) -> Result<()> {
        let Some(Claim {
            bound: Some(bound), ..
        }) = claim
        else {
            return Ok(());
        };
        let mut writes = bound.writes.clone();
        if bound.path != file.key {
            self.unbind_if_still(&bound)?;
            state::note_left(
                &*self.core.conn()?,
                &self.folder,
                &bound.item_id,
                &bound.path,
            )?;
            // The name alone says the title; the unread line is the pull's
            // to rewrite.
            let shown = bound
                .presentation
                .as_ref()
                .and_then(|agreed| line_of(agreed.front()));
            if let Some(retitle) =
                self.renamed_title(&bound.item_id, &bound, file, None, catalog)?
                && retitle.refusal(&retitle.title, catalog).is_none()
                && let Some(id) =
                    self.queue_title(&bound.item_id, &retitle, &retitle.title, shown)?
            {
                writes.queued.push(state::Queued {
                    id,
                    save: writes.save,
                    line: None,
                    default: false,
                });
            }
            self.place(&bound.item_id, &file.key, withheld)?;
            report.renamed += 1;
        }
        if bound.path != file.key || bound.identity != file.mark {
            let conn = self.core.conn()?;
            state::bind(
                &conn,
                &state::Bound {
                    path: file.key.clone(),
                    identity: file.mark.clone(),
                    writes,
                    ..bound
                },
            )?;
            state::journal_clear(&conn, &file.key)?;
        }
        Ok(())
    }

    fn size_warning(
        &self,
        file: &Scanned,
        item_id: &str,
        catalog: &Catalog,
    ) -> Result<Option<Flagged>> {
        Ok(if self.file_item(item_id, catalog)? {
            None
        } else {
            near_limit(&file.key, &file.text, catalog.request_limit())
        })
    }

    fn holds_bytes(&self, item: &Item, file: &Scanned, catalog: &Catalog) -> bool {
        if marfa_rules::folder::is_hidden(&item.r#type) || !suited(item, &file.key, catalog) {
            return false;
        }
        match bytes_of(item, catalog) {
            Some(blob) => crate::blob::named(blob).is_ok_and(|named| {
                file.source
                    .as_ref()
                    .is_some_and(|bytes| crate::blob::name_of(bytes) == named)
            }),
            None => {
                file.unreadable.is_none()
                    && state::hash(
                        item.properties
                            .get(fields::body_field(catalog, &item.r#type))
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .as_bytes(),
                    ) == file.hash
            }
        }
    }

    fn arrival(
        &self,
        id: &str,
        settings: &Settings,
        peers: &Peers<'_>,
        members: &OnceCell<HashSet<String>>,
        unheld: &HashMap<String, Option<String>>,
    ) -> Arrival {
        if peers.carry(id) {
            return if self.holds(id, settings, members) {
                Arrival::Here
            } else {
                Arrival::Copy
            };
        }
        match unheld.get(id) {
            Some(Some(reason)) => Arrival::Waits(reason.clone()),
            _ => Arrival::Here,
        }
    }

    /// Reads together (`folder-files/narrowed-arrival-read-batched`) each id of
    /// `arriving` that the copy does not hold and the server may: a narrowed
    /// copy leaves out items the folder does not show, so such an id may
    /// still name an item on the server, read before the file makes a new one
    /// (`folder-files/narrowed-arrival-read`). Answers each id read with why its
    /// file waits, if it does. A file whose id the server answered it does
    /// not show is not asked again until its bytes or its id change
    /// (`folder-files/narrowed-arrival-read-once`), and the bin is not asked,
    /// since an item there leaves a new item too.
    fn read_arrivals(
        &self,
        files: &[Scanned],
        arriving: &[(usize, &str)],
        peers: &Peers<'_>,
    ) -> Result<HashMap<String, Option<String>>> {
        let (narrowed, known) = {
            let conn = self.core.conn()?;
            (
                crate::store::slice_query(&conn)?.is_some(),
                state::unheld(&conn)?,
            )
        };
        let mut answers: HashMap<String, Option<String>> = HashMap::new();
        let mut remembered: HashMap<&str, (&str, &str)> = HashMap::new();
        let mut asks: Vec<(&Scanned, &str)> = Vec::new();
        let mut wanted: Vec<String> = Vec::new();
        for &(at, id) in arriving {
            let file = &files[at];
            if peers.carry(id) {
                continue;
            }
            // Peers read this copy's store as they load, so its lock is let go
            // before they are asked.
            let held = crate::store::item_held(&*self.core.conn()?, id)?;
            if held || !(narrowed || peers.held_elsewhere(id)) {
                continue;
            }
            if known
                .get(&file.key)
                .is_some_and(|(known_id, hash)| known_id == id && *hash == file.hash)
            {
                remembered.insert(&file.key, (id, &file.hash));
                answers.entry(id.to_string()).or_insert(None);
                continue;
            }
            asks.push((file, id));
            if !answers.contains_key(id) {
                answers.insert(id.to_string(), None);
                wanted.push(id.to_string());
            }
        }
        let mut not_shown: HashSet<String> = HashSet::new();
        for (id, answer) in self.core.pin_many(&wanted) {
            if matches!(answer, Ok(false)) {
                not_shown.insert(id.clone());
            }
            answers.insert(id, unheld_waits(answer));
        }
        for (file, id) in asks {
            if not_shown.contains(id) {
                remembered.insert(&file.key, (id, &file.hash));
            }
        }
        let read: Vec<&str> = files
            .iter()
            .filter(|file| !file.deferred)
            .map(|file| file.key.as_str())
            .collect();
        state::set_unheld(&*self.core.conn()?, &known, &read, &remembered)?;
        Ok(answers)
    }

    fn holds(&self, id: &str, settings: &Settings, members: &OnceCell<HashSet<String>>) -> bool {
        members
            .get_or_init(|| self.members(settings).unwrap_or_default())
            .contains(id)
    }

    /// `Some` with why where the item cannot be asked now. An item the server
    /// will not show leaves a new item.
    fn read_unheld(&self, id: &str) -> Result<Option<String>> {
        if crate::store::item_held(&*self.core.conn()?, id)? {
            return Ok(None);
        }
        Ok(self
            .core
            .pin_many(&[id.to_string()])
            .pop()
            .and_then(|(_, answer)| unheld_waits(answer)))
    }

    /// The new files of this pass that wait for the person: those of a pass
    /// that, with the new files the folder sent in the last ten minutes,
    /// come to more than `addition_threshold` allows. The threshold judges
    /// how fast files arrive, so a note saved now and then is never held and
    /// a large directory is held however it is copied in. A held file stays
    /// unbound and unsent and is counted again by every pass, so deleting
    /// some of them, or raising the threshold, lets the rest go at the next
    /// scan.
    fn hold_additions(
        &self,
        scan: &mut ScanState,
        claims: &[Option<Claim>],
        waiting: &Waiting,
        outside: &HashSet<usize>,
    ) -> Result<HashSet<usize>> {
        let conn = self.core.conn()?;
        let confirmed = state::additions_allowed(&conn)?;
        state::set_additions_allowed(&conn, &[])?;
        let every = self.every_addition.swap(false, Ordering::AcqRel);
        let first_scan = !state::additions_gated(&conn)?;
        if first_scan && !super::first::waiting(&conn)? {
            // The first sync's scan takes in what the directory holds, which
            // the first sync's own gate asked about.
            state::gate_additions(&conn)?;
        }
        drop(conn);
        let new: Vec<usize> = self
            .new_files(scan, claims, waiting)
            .into_iter()
            .filter(|at| !outside.contains(at))
            .filter(|at| self.would_send(&scan.files[*at], scan))
            .collect();
        let conn = self.core.conn()?;
        // A file a person let through is not a drop to count, now or against
        // the next one.
        let counted: Vec<usize> = new
            .iter()
            .copied()
            .filter(|at| !every && !confirmed.contains(&scan.files[*at].key))
            .collect();
        let now_ms = crate::store::millis_at(crate::clock::system_time());
        let mut sent = state::additions_sent(&conn)?;
        let lately = state::within_window(&mut sent, now_ms);
        let mut held = HashSet::new();
        let mut paths = Vec::new();
        if !first_scan && !counted.is_empty() {
            // While a pause stands the files that arrive join it and the set
            // is judged against the window as it was when the pause began,
            // so the window emptying never lets it go. A pause stands only
            // while a file it held is still here.
            let standing = {
                let held = state::paused_additions(&conn)?;
                counted.iter().any(|at| held.contains(&scan.files[*at].key))
            };
            if !standing {
                state::clear_paused_base(&conn)?;
            }
            let base = if standing {
                state::paused_base(&conn)?
            } else {
                lately
            };
            let exceeded = scan
                .settings
                .addition_threshold
                .exceeded(base + counted.len(), state::bound_count(&conn)?);
            if exceeded {
                for at in &counted {
                    paths.push(scan.files[*at].key.clone());
                    held.insert(*at);
                }
                state::set_paused_base(&conn, base)?;
            } else {
                // Held files are not sent, so they are not recorded as sent.
                state::record_sent(&mut sent, now_ms, counted.len());
            }
        }
        // Written only where it changed, which a watch at rest would
        // otherwise see at every pass.
        state::set_additions_sent(&conn, &sent)?;
        paths.sort();
        state::set_paused_additions(&conn, &paths)?;
        scan.report.paused_additions = held.len();
        Ok(held)
    }

    /// The files with no item yet that this pass may send: the ones a person
    /// could be asked about, not those that wait, are read later or cannot be
    /// read.
    fn new_files(
        &self,
        scan: &ScanState,
        claims: &[Option<Claim>],
        waiting: &Waiting,
    ) -> Vec<usize> {
        scan.files
            .iter()
            .enumerate()
            .filter(|(at, file)| {
                claims[*at].is_none()
                    && !waiting.contains_key(at)
                    && !file.deferred
                    && file.unreadable.is_none()
                    && !(scan.only_embedded.contains(&file.key)
                        && !scan.embedded.contains(&file.key))
            })
            .map(|(at, _)| at)
            .collect()
    }

    /// The new files this pass holds on disk because the folder's
    /// `outside_query` is `hold` and the query would not hold what they
    /// become. A held file has no item and no binding, so a pass judges it
    /// again: it is sent once it matches, or once the setting says `send`.
    /// An embedded file is an attachment of a note and goes with it, and a
    /// file that is not a document and whose type the query does not hold is
    /// never sent, held or not.
    fn hold_outside(
        &self,
        scan: &mut ScanState,
        claims: &[Option<Claim>],
        waiting: &Waiting,
    ) -> Result<HashSet<usize>> {
        let mut held = HashSet::new();
        let mut kept_back = HashSet::new();
        let mut paths = Vec::new();
        if scan.settings.outside_query == OutsideQuery::Hold {
            let pending = self.pending_beneath_of(&scan.settings)?;
            for at in self.new_files(scan, claims, waiting) {
                match self.is_outside(&scan.files[at], scan, &pending)? {
                    Some(false) => {}
                    Some(true) => {
                        paths.push(scan.files[at].key.clone());
                        held.insert(at);
                    }
                    None => {
                        kept_back.insert(at);
                    }
                }
            }
        }
        paths.sort();
        state::set_held_outside(&*self.core.conn()?, &paths)?;
        scan.report.held_outside = held.len();
        held.extend(kept_back);
        Ok(held)
    }

    /// Whether the query would not hold the item a new file becomes, or
    /// `None` where that cannot be told. What the copy would refuse to make
    /// is not judged here: it is flagged where it is made.
    fn is_outside(
        &self,
        file: &Scanned,
        scan: &ScanState,
        pending: &PendingBeneath,
    ) -> Result<Option<bool>> {
        let (catalog, edge_types) = (&scan.catalog, &scan.edge_types);
        let settings = match pending {
            PendingBeneath::Unbound(named) if named.as_deref() != Some(file.key.as_str()) => {
                return Ok(Some(true));
            }
            PendingBeneath::Bound(named) => &**named,
            _ => &scan.settings,
        };
        if let Some(file_type) = self.file_type_of(&file.path, settings, catalog) {
            let draft = file_item_draft(file, file_type, settings, catalog);
            let edges = default_edges_of(settings, None);
            return Ok(self.judge_outside(settings, catalog, &draft, ItemState::Active, &edges));
        }
        if scan.embedded.contains(&file.key) && bytes_type(&file.path, catalog).is_some() {
            return Ok(Some(false));
        }
        let document = file.document();
        let Ok(made) = new_document(&file.key, &document, (settings, catalog, edge_types)) else {
            return Ok(Some(false));
        };
        if admission_hold(catalog, &file.key, &made.draft).is_some() {
            return Ok(Some(false));
        }
        let state = made.read.lines.state.unwrap_or(ItemState::Active);
        let mut edges = default_edges_of(settings, Some((&document.front, edge_types)));
        let mut resolver = Resolver::new(&self.core, catalog, &BoundFiles, &crate::NEVER_STOPPED);
        match self.own_edges(&document.front, edge_types, catalog, &mut resolver) {
            Ok(own) => edges.extend(own),
            Err(error) if error.is_copy_wide() => return Err(error),
            Err(_) => return Ok(None),
        }
        Ok(self.judge_outside(settings, catalog, &made.draft, state, &edges))
    }

    /// `None` where the dry run failed: a file is never sent on an answer
    /// that is not known, and is judged again by the next pass.
    fn judge_outside(
        &self,
        settings: &Settings,
        catalog: &Catalog,
        draft: &crate::model::Draft,
        made: ItemState,
        edges: &[(marfa_rules::catalog::End, String, String)],
    ) -> Option<bool> {
        self.core
            .would_be_held_by(
                settings,
                catalog,
                draft,
                made,
                edges,
                local_admission_refusal,
            )
            .ok()
            .map(|held| !held)
    }

    /// Whether a new file would be sent as an item: not one the scan holds
    /// as a document the copy would refuse, which no threshold need ask about.
    fn would_send(&self, file: &Scanned, scan: &ScanState) -> bool {
        let (settings, catalog, edge_types) = (&scan.settings, &scan.catalog, &scan.edge_types);
        let embedded = scan.embedded.contains(&file.key);
        let file_type = self
            .file_type_of(&file.path, settings, catalog)
            .or_else(|| embedded.then(|| bytes_type(&file.path, catalog)).flatten());
        if file_type.is_some() {
            return true;
        }
        match new_document(&file.key, &file.document(), (settings, catalog, edge_types)) {
            Ok(made) => admission_hold(catalog, &file.key, &made.draft).is_none(),
            Err(_) => false,
        }
    }

    /// Sends only a move's placement, so a pull leaves the file and a move
    /// keeps its item.
    fn hold_unreadable(
        &self,
        file: &Scanned,
        claim: Option<&Claim>,
        reason: &str,
        withheld: &placement::Withheld,
    ) -> Result<()> {
        let Some(Claim {
            bound: Some(bound), ..
        }) = claim
        else {
            return Ok(());
        };
        if bound.path != file.key {
            self.unbind_if_still(bound)?;
            self.place(&bound.item_id, &file.key, withheld)?;
        }
        let conn = self.core.conn()?;
        state::bind(
            &conn,
            &state::Bound {
                path: file.key.clone(),
                identity: file.mark.clone(),
                content_hash: file.hash.clone(),
                written_hash: None,
                held: Some(format!("{}{reason}", state::UNREADABLE)),
                ..bound.clone()
            },
        )?;
        state::journal_clear(&conn, &file.key)
    }

    /// Leaves the old path to another file bound there earlier in this scan.
    fn unbind_if_still(&self, bound: &state::Bound) -> Result<()> {
        let conn = self.core.conn()?;
        if state::bound_at(&conn, &bound.path)?.is_some_and(|row| row.item_id == bound.item_id) {
            state::unbind(&conn, &bound.path)?;
            state::journal_clear(&conn, &bound.path)?;
        }
        Ok(())
    }

    /// Past the grace, a file whose binding the last sweep kept is looked for
    /// in the other folders again by a full pass, and by a quick pass once
    /// `KEPT_LOOK` has passed since the last look, so that looking walks the
    /// other folders at most once each `KEPT_LOOK` however often the watch
    /// scans, and a kept file does not wait for the full pass.
    fn sweep_journal(
        &self,
        settings: &Settings,
        peers: &Peers<'_>,
        full: bool,
        report: &mut ScanReport,
    ) -> Result<()> {
        let (journaled, of) = {
            let conn = self.core.conn()?;
            (state::journaled(&conn)?, state::bound_count(&conn)?)
        };
        let journaled: Vec<state::Journaled> =
            journaled.into_iter().filter(|row| !row.carried()).collect();
        // Counted over every missing file, not only those past the grace, so
        // files a watch meets a pass apart are one removal.
        if settings.removal_threshold.exceeded(journaled.len(), of) {
            let paths: Vec<String> = journaled.into_iter().map(|row| row.path).collect();
            state::set_paused(&*self.core.conn()?, state::Removal::Disk, &paths)?;
            report.paused = paths.len();
            self.note_kept_look_passed()?;
            return Ok(());
        }
        state::set_paused(&*self.core.conn()?, state::Removal::Disk, &[])?;
        let look = full || self.kept_look_due()?;
        let now = crate::store::millis_at(crate::clock::system_time());
        let sweep = Sweep::default();
        let mut due = Vec::new();
        for row in journaled {
            if !elapsed_past(&row.missing_since, now, RENAME_GRACE) {
                continue;
            }
            match row.kept {
                Some(state::Kept::Unsure(reason)) if !look => {
                    report.unsure.push(Unsure {
                        path: row.path,
                        reason,
                    });
                    continue;
                }
                Some(state::Kept::Arriving) if !look => continue,
                Some(state::Kept::Carried(_)) => continue,
                _ => {}
            }
            due.push((row.path, row.item_id));
        }
        self.decide_changed(&due, settings, &sweep)?;
        let mut kept = false;
        for (path, item_id) in due {
            match self.let_go_missing(&path, &item_id, settings, peers, &sweep)? {
                Missing::Moved => report.moved_away += 1,
                Missing::Arriving => kept = true,
                Missing::Changed => {}
                Missing::Unsure(reason) => {
                    kept = true;
                    report.unsure.push(Unsure { path, reason });
                }
                Missing::Deleted => {
                    report.deleted += 1;
                    report.trashed.push(path);
                }
                Missing::Gone | Missing::Carried => {}
            }
        }
        if kept && look {
            *self
                .kept_looked
                .lock()
                .map_err(|_| CoreError::Store("the kept look's record was poisoned".into()))? =
                Some(crate::clock::now());
        }
        Ok(())
    }

    /// Counts a pass that could not sweep, or stopped at the removal
    /// threshold, as the look at the files a sweep kept, once one is due, so
    /// the next look is `KEPT_LOOK` off and a watch at rest wakes no sooner.
    fn note_kept_look_passed(&self) -> Result<()> {
        if self.kept_look_due()?
            && state::journaled(&*self.core.conn()?)?
                .iter()
                .any(state::Journaled::looked_for)
        {
            *self
                .kept_looked
                .lock()
                .map_err(|_| CoreError::Store("the kept look's record was poisoned".into()))? =
                Some(crate::clock::now());
        }
        Ok(())
    }

    /// Whether a quick pass looks again for the files a sweep kept: none has
    /// looked yet, or `KEPT_LOOK` has passed since one did.
    fn kept_look_due(&self) -> Result<bool> {
        let looked = *self
            .kept_looked
            .lock()
            .map_err(|_| CoreError::Store("the kept look's record was poisoned".into()))?;
        Ok(looked.is_none_or(|at| crate::clock::now() >= at + KEPT_LOOK))
    }

    /// When a watch at rest scans to look again for a kept file, or `None`
    /// where the sweep keeps none: nothing in the folder or the copy tells
    /// that the other folder took the file, or can be read again.
    pub(super) fn kept_look_at(&self) -> Result<Option<std::time::Instant>> {
        if !state::journaled(&*self.core.conn()?)?
            .iter()
            .any(state::Journaled::looked_for)
        {
            return Ok(None);
        }
        // A watch that has not looked yet, as one just started over a kept
        // file, counts from now, so it never wakes each tick for a look due
        // in the past.
        let mut looked = self
            .kept_looked
            .lock()
            .map_err(|_| CoreError::Store("the kept look's record was poisoned".into()))?;
        let at = *looked.get_or_insert_with(crate::clock::now);
        Ok(Some(at + KEPT_LOOK))
    }

    /// Lets `by` pass on the clock a kept file's look is counted by.
    #[cfg(test)]
    pub(super) fn age_kept_look(&self, by: Duration) {
        if let Some(at) = self.kept_looked.lock().unwrap().as_mut() {
            *at = at.checked_sub(by).expect("an instant that far back");
        }
    }

    /// Decides for every file of `missing`, a path and its item, whether its
    /// item changed in what the file showed, before `let_go_missing` queues
    /// the first delete (`folder-files/missing-file-trashed`).
    pub(super) fn decide_changed(
        &self,
        missing: &[(String, String)],
        settings: &Settings,
        sweep: &Sweep,
    ) -> Result<()> {
        for (path, item_id) in missing {
            let (held, bound) = {
                let conn = self.core.conn()?;
                (
                    crate::store::items_by_ids(&conn, std::slice::from_ref(item_id))?.pop(),
                    state::bound_at(&conn, path)?.filter(|bound| &bound.item_id == item_id),
                )
            };
            let (Some(item), Some(bound)) = (held, bound) else {
                continue;
            };
            if item.state == ItemState::Trashed || !self.holds(item_id, settings, &sweep.members) {
                continue;
            }
            let catalog = crate::catalog::load(&*self.core.conn()?)?;
            // Read first, so a change after it is one the delete finds.
            let Some(seen) = self.core.seen(item_id)? else {
                continue;
            };
            let (edge_types, names) = sweep.shown(self, &catalog)?;
            let changed =
                self.changed_while_missing(seen.item(), &bound, (&catalog, edge_types, names))?;
            sweep
                .decided
                .borrow_mut()
                .insert(item_id.clone(), (seen, changed));
        }
        Ok(())
    }

    pub(super) fn let_go_missing(
        &self,
        path: &str,
        item_id: &str,
        settings: &Settings,
        peers: &Peers<'_>,
        sweep: &Sweep,
    ) -> Result<Missing> {
        // Only a row gone or in the bin sends nothing; anything else the store
        // says is an error, not a reason to skip the delete.
        let (held, bound) = {
            let conn = self.core.conn()?;
            if state::journal_is_carried(&conn, path, item_id)? {
                return Ok(Missing::Carried);
            }
            (
                crate::store::items_by_ids(&conn, &[item_id.to_string()])?.pop(),
                state::bound_at(&conn, path)?.filter(|bound| bound.item_id == item_id),
            )
        };
        // An item already in the bin is where the delete would put it, and the
        // server refuses a second delete `404`.
        let mut leaves = true;
        let missing = if let Some(item) = held.filter(|item| item.state != ItemState::Trashed) {
            let holds = self.holds(item_id, settings, &sweep.members);
            let catalog = crate::catalog::load(&*self.core.conn()?)?;
            let look = match &bound {
                Some(bound) => peers.moved_to(bound, holds, bytes_of(&item, &catalog).is_some()),
                None => Look::Nowhere,
            };
            match look {
                // A folder that still holds the item writes its file again.
                Look::Moved => {
                    leaves = !holds;
                    Missing::Moved
                }
                // That folder knows the file as the item only by this
                // binding, so it stays, and a pull writes no file over it.
                Look::Arriving => {
                    state::journal_keep(
                        &*self.core.conn()?,
                        path,
                        item_id,
                        Some(&state::Kept::Arriving),
                    )?;
                    return Ok(Missing::Arriving);
                }
                // Held as a delete is while offline, until it can be told.
                Look::Unsure(reason) => {
                    let kept = state::Kept::Unsure(reason.clone());
                    state::journal_keep(&*self.core.conn()?, path, item_id, Some(&kept))?;
                    return Ok(Missing::Unsure(reason));
                }
                Look::Nowhere => {
                    let mut decided = sweep.decided.borrow_mut().remove(item_id);
                    let mut attempts = 0;
                    // A file at a path another item's binding holds is that
                    // item's, and answers nothing for this one.
                    let put_back = || -> Result<Option<Missing>> {
                        if bound.is_none() {
                            return Ok(None);
                        }
                        match self.file_at(&self.root.join(path)) {
                            Ok(false) => Ok(None),
                            Ok(true) => {
                                // No longer missing, so a scan that moves the
                                // file elsewhere finds no row to delete the
                                // item by.
                                state::journal_clear_for(&*self.core.conn()?, path, item_id)?;
                                Ok(Some(Missing::Changed))
                            }
                            Err(error) => {
                                let reason = format!("its path cannot be checked ({error})");
                                let kept = state::Kept::Unsure(reason.clone());
                                state::journal_keep(
                                    &*self.core.conn()?,
                                    path,
                                    item_id,
                                    Some(&kept),
                                )?;
                                Ok(Some(Missing::Unsure(reason)))
                            }
                        }
                    };
                    loop {
                        // Neither a decision made earlier in the sweep nor the
                        // file-item read looks at the disk.
                        if let Some(missing) = put_back()? {
                            return Ok(missing);
                        }
                        let (seen, changed) = match decided.take() {
                            Some(decided) => decided,
                            None => {
                                // Read first, so a change after it is one the
                                // delete finds.
                                let Some(seen) = self.core.seen(item_id)? else {
                                    break Missing::Gone;
                                };
                                if seen.item().state == ItemState::Trashed {
                                    break Missing::Gone;
                                }
                                // No pull writes the file of an item the query
                                // no longer holds, so the person's delete of it
                                // stands.
                                let changed = match bound.as_ref().filter(|_| holds) {
                                    Some(bound) => {
                                        let (edge_types, names) = sweep.shown(self, &catalog)?;
                                        self.changed_while_missing(
                                            seen.item(),
                                            bound,
                                            (&catalog, edge_types, names),
                                        )?
                                    }
                                    None => false,
                                };
                                (seen, changed)
                            }
                        };
                        // A row that goes on moving while the sweep decides is
                        // as good as changed.
                        if changed || attempts == DECIDE_ATTEMPTS {
                            // Unkept, so the pull reaches it.
                            state::journal_keep(&*self.core.conn()?, path, item_id, None)?;
                            return Ok(Missing::Changed);
                        }
                        #[cfg(debug_assertions)]
                        crate::fault::hold(|| format!("folder-sweep-decided:{item_id}"));
                        // Restoring a file changes neither its item nor its
                        // edges, so the queued delete would not notice.
                        if let Some(missing) = put_back()? {
                            return Ok(missing);
                        }
                        state::note_left(&*self.core.conn()?, &self.folder, item_id, path)?;
                        // Queued only while the item is as the decision read
                        // it, so a change heard meanwhile is decided again
                        // rather than trashed.
                        if self.core.delete_item_at(item_id, &seen)?.is_some() {
                            break Missing::Deleted;
                        }
                        attempts += 1;
                    }
                }
            }
        } else {
            Missing::Gone
        };
        // Before the binding goes, so a failure leaves it for the next pass.
        if leaves {
            self.end_placement(item_id, path)?;
        }
        let conn = self.core.conn()?;
        state::journal_clear(&conn, path)?;
        state::unbind(&conn, path)?;
        Ok(missing)
    }
}

/// Whether an unchanged file's links and lines are judged again.
enum Again {
    Now,
    /// Once the copy has moved from where it stood when the file was held.
    IfMoved(String),
    No,
}

/// Lines only the server can resolve are asked again at each scan that can
/// ask it, and so are lines the copy refused, since what refused them can
/// change without the file. Names that matched no item, or several, are
/// asked again once the copy has changed. A name whose lookup the server
/// refused is answered with that refusal until the file changes.
fn edges_again(bound: &state::Bound) -> Again {
    let held = bound.held.as_deref().unwrap_or_default();
    if held.starts_with(state::EDGES_WAITING)
        || bound.writes.refused.iter().any(|refused| {
            matches!(refused.change, state::Change::Edge { .. }) && copy_refused(refused)
        })
    {
        return Again::Now;
    }
    if !held.starts_with(state::EDGES) {
        return Again::No;
    }
    match &bound.writes.rejudge {
        Some(state::Rejudge::Moved(at)) => Again::IfMoved(at.clone()),
        Some(state::Rejudge::FileChanged) => Again::No,
        // Held before any judgment recorded when to judge it again.
        None => Again::Now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::{HOLDS_NUL, NOT_UTF8};

    #[test]
    fn the_scan_keeps_no_text_of_a_document_that_is_not_text() {
        // Lone continuation bytes, none of them UTF-8.
        let binary: Vec<u8> = (0..4096).map(|at| 0x80 | (at % 64) as u8).collect();
        let wide = "wide\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        for name in ["a.md", "a.markdown", "a.txt"] {
            let (text, reason) = kept_text(Path::new(name), &binary);
            assert_eq!((text.as_str(), reason), ("", Some(NOT_UTF8)), "{name}");
            let (text, reason) = kept_text(Path::new(name), &wide);
            assert_eq!((text.as_str(), reason), ("", Some(HOLDS_NUL)), "{name}");
            // The witness: the same name with text in it keeps the text.
            let (text, reason) = kept_text(Path::new(name), b"a note\n");
            assert_eq!((text.as_str(), reason), ("a note\n", None), "{name}");
        }
        // A file that is no document is decoded by no one but a text item.
        let (text, reason) = kept_text(Path::new("a.bin"), &binary);
        assert_eq!((text.as_str(), reason), ("", None));
    }
}
