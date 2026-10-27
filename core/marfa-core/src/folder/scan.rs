use std::cell::RefCell;

use crate::Seen;

use super::{
    BTreeMap, BoundFiles, Captured, Catalog, ControlFlow, CoreError, Directory, Duration,
    EdgeTypes, EdgeWork, Flagged, Folder, HashMap, HashSet, ID_FIELD, Item, ItemState,
    LOCAL_ADMISSION_REFUSAL, Lists, Look, Names, OnceCell, Path, PathBuf, Peers, RENAME_GRACE,
    Resolver, Result, ScanReport, Scanned, Settings, Unsure, Value, Waiting, Walked, beside,
    bytes_of, captured_identities, carries_frontmatter, changed_within, document, embeds,
    executable, fields, id_named, identity, is_document, landing, line_of, lines,
    local_properties_refusal, name_of, named_by_its_file, near_limit, one_per_name, placement,
    stat_metadata, state, suited, swap_root, text_of, typed_title,
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

/// What a pass has read from the copy before it walks the directory.
struct ScanStart {
    report: ScanReport,
    /// The registry, where the copy's own folder was lost from it.
    doubt: Option<String>,
    settings: Settings,
    catalog: Catalog,
    edge_types: EdgeTypes,
    lists: Lists,
}

/// What a pass holds between its phases.
struct ScanState {
    full: bool,
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
}

fn bound_by_path(snapshot: &[state::Bound]) -> HashMap<&str, &state::Bound> {
    snapshot
        .iter()
        .map(|bound| (bound.path.as_str(), bound))
        .collect()
}

pub(super) enum Missing {
    Moved,
    /// Still bound and journaled, until the folder it went to binds it.
    Arriving,
    Unsure(String),
    /// Changed elsewhere in what the file showed: still bound and journaled,
    /// for a pull to write back.
    Changed,
    Deleted,
    Gone,
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

/// A pair this cannot read has not passed, since a delete cannot be taken
/// back.
fn elapsed_past(since: &str, now: &str, grace: Duration) -> bool {
    let (Some(since), Some(now)) = (millis_of(since), millis_of(now)) else {
        return false;
    };
    now.saturating_sub(since) >= grace.as_millis() as i64
}

fn millis_of(stamp: &str) -> Option<i64> {
    i64::try_from(crate::store::instant_of(stamp)? / 1_000_000).ok()
}

impl Folder {
    pub fn scan(&self) -> Result<ScanReport> {
        self.scan_as(true, None, Files::Write)
    }

    /// `scan`, but no file in the directory is written, moved or removed: a
    /// rename is sent as the new title with its title line as it is, an old
    /// buffer saved where a pull moved the file from stays there, and a
    /// temporary file a crashed write left stays, all for a pass that writes
    /// files.
    pub(super) fn scan_keeping_files(&self) -> Result<ScanReport> {
        self.scan_as(true, None, Files::Keep)
    }

    /// A watch's pass. Short of `full`, it skips a file whose size, time and
    /// identity are as the last read left them, which a full pass catches.
    /// Either way it leaves for a later pass a file that is not a document,
    /// or is a file item at a document name, and changed within `settle`,
    /// which a copy or a download may still be writing.
    pub fn scan_watching(&self, full: bool, settle: Duration) -> Result<ScanReport> {
        self.scan_as(full, Some(settle), Files::Write)
    }

    fn scan_as(&self, full: bool, settle: Option<Duration>, mode: Files) -> Result<ScanReport> {
        let start = match self.scan_root()? {
            ControlFlow::Break(report) => return Ok(report),
            ControlFlow::Continue(start) => start,
        };
        let mut scan = match self.walk_for_scan(start, full, settle, mode)? {
            ControlFlow::Break(report) => return Ok(report),
            ControlFlow::Continue(scan) => scan,
        };
        self.read_unchanged_and_documents(&mut scan)?;
        self.count_unchanged(&mut scan);
        self.read_rest(&mut scan)?;
        if self.root_left(&mut scan).is_break() {
            return Ok(scan.report);
        }
        scan.stale =
            self.fold_stale_saves(&mut scan.files, &scan.snapshot, &mut scan.seen, scan.mode)?;
        self.refresh_catalog(&mut scan)?;
        let peers = Peers::of(self, scan.doubt.take());
        let (claims, waiting) = self.claim_scanned(&scan, &peers)?;
        self.follow_embeds_of_documents(&mut scan, &claims)?;
        let work = match self.queue_scanned(&mut scan, claims, waiting)? {
            ControlFlow::Break(()) => return Ok(scan.report),
            ControlFlow::Continue(work) => work,
        };
        self.queue_edge_work(&mut scan, work)?;
        self.record_stats(&scan)?;
        if self.root_left(&mut scan).is_break() {
            return Ok(scan.report);
        }
        if self.sweep(&mut scan, &peers)?.is_break() {
            return Ok(scan.report);
        }
        scan.report.root_gone = scan.report.root_gone.or_else(|| self.root_gone());
        Ok(scan.report)
    }

    /// The pass's first phase: that the folder's root is there, then what
    /// the pass reads from the copy.
    fn scan_root(&self) -> Result<ControlFlow<ScanReport, ScanStart>> {
        if let Some(gone) = self.root_gone() {
            return Ok(ControlFlow::Break(ScanReport {
                root_gone: Some(gone),
                ..ScanReport::default()
            }));
        }
        state::settle_landings(&*self.core.conn()?, &self.root_dir)?;
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
            (Catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let lists = settings.lists()?;
        Ok(ControlFlow::Continue(ScanStart {
            report,
            doubt,
            settings,
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
        full: bool,
        settle: Option<Duration>,
        mode: Files,
    ) -> Result<ControlFlow<ScanReport, ScanState>> {
        let ScanStart {
            mut report,
            doubt,
            settings,
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
        let walked = self.walked(&lists);
        let incomplete = walked.incomplete();
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
        report.directories = walked.directories.clone();
        report.secrets = walked.secrets.clone();
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
        let unanswered = crate::store::items_awaiting_their_write(&*self.core.conn()?)?;
        Ok(ControlFlow::Continue(ScanState {
            full,
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
        }))
    }

    /// With a quick pass (short of `full`), skips the files whose size, time
    /// and identity are as the last read left them, and reads the Markdown
    /// files first, so a file only an embed names is sent too. A file
    /// carrying the item id of a skipped file is read, and so is the skipped
    /// file, until no skipped file's item is named.
    fn read_unchanged_and_documents(&self, scan: &mut ScanState) -> Result<()> {
        let full = scan.full;
        let by_path = bound_by_path(&scan.snapshot);
        let (paths, keys, walked) = (&scan.paths, &scan.keys, &scan.walked);
        let (unchanged, stats) = (&mut scan.unchanged, &mut scan.stats);
        let (early, shown, embedded) = (&mut scan.early, &mut scan.shown, &mut scan.embedded);
        if !full {
            // Resolved over every file, so a hard link shares no mark.
            let marks = captured_identities(paths, walked);
            let conn = self.core.conn()?;
            for (path, key) in paths.iter().zip(keys) {
                if let Some(bound) = by_path.get(key.as_str())
                    && bound.held.is_none()
                    && bound.writes.refused.is_empty()
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
        let index = embeds::Files::of(keys);
        let mut reading: Vec<usize> = (0..paths.len()).collect();
        while !reading.is_empty() {
            let mut named: HashSet<String> = HashSet::new();
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
                    scan.incomplete = true;
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
                    if let Some(target) = embeds::on_disk(key, &embed, &index) {
                        if let embeds::Target::At(at) = &target {
                            embedded.insert(at.clone());
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
            reading = (0..paths.len())
                .filter(|at| {
                    unchanged.contains(&keys[*at])
                        && by_path
                            .get(keys[*at].as_str())
                            .is_some_and(|bound| named.contains(&bound.item_id))
                })
                .collect();
            for at in &reading {
                unchanged.remove(&keys[*at]);
            }
        }
        Ok(())
    }

    /// Counts the files left unread as unchanged, or as waiting where the
    /// server has not answered their item's write.
    fn count_unchanged(&self, scan: &mut ScanState) {
        let by_path = bound_by_path(&scan.snapshot);
        let (unchanged, unanswered) = (&scan.unchanged, &scan.unanswered);
        let waiting = unchanged
            .iter()
            .filter(|key| {
                by_path
                    .get(key.as_str())
                    .is_some_and(|bound| unanswered.contains(&bound.item_id))
            })
            .count();
        scan.report.waiting += waiting;
        scan.report.unchanged += unchanged.len() - waiting;
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
        let only_embedded = &mut scan.only_embedded;
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
            scan.catalog = Catalog::load(&conn)?;
            scan.edge_types = EdgeTypes::load(&conn)?;
        }
        Ok(())
    }

    /// Settles which item each read file belongs to, and holds the files
    /// that wait: a stale save, and what the claim cannot yet give.
    fn claim_scanned(
        &self,
        scan: &ScanState,
        peers: &Peers<'_>,
    ) -> Result<(Vec<Option<Claim>>, Waiting)> {
        let (files, snapshot, stale) = (&scan.files, &scan.snapshot, &scan.stale);
        let (settings, catalog) = (&scan.settings, &scan.catalog);
        let (mut claims, mut waiting) = self.claim(files, snapshot, settings, catalog, peers)?;
        for (at, file) in files.iter().enumerate() {
            if let Some(reason) = stale.get(&file.key) {
                claims[at] = None;
                waiting.insert(at, reason.clone());
            }
        }
        Ok((claims, waiting))
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
        let (mode, settle) = (scan.mode, scan.settle);
        let by_path = bound_by_path(&scan.snapshot);
        let (settings, catalog, edge_types) = (&scan.settings, &scan.catalog, &scan.edge_types);
        let (files, walked) = (&scan.files, &scan.walked);
        let (unanswered, embedded) = (&scan.unanswered, &scan.embedded);
        let only_embedded = &scan.only_embedded;
        let report = &mut scan.report;
        let withheld = self.withheld()?;
        let mut work: Vec<EdgeWork> = Vec::new();
        let mut unsettled: HashSet<String> = HashSet::new();

        for (at, (file, claim)) in files.iter().zip(claims).enumerate() {
            if let Some(gone) = self.root_gone() {
                report.root_gone = Some(gone);
                return Ok(ControlFlow::Break(()));
            }
            if only_embedded.contains(&file.key) && !embedded.contains(&file.key) {
                report.settling.retain(|path| *path != file.key);
                report.skipped += 1;
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
                    .is_some_and(|captured| changed_within(&captured.metadata.borrow(), settle))
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
                    // The server has answered these bytes already; the file of
                    // an item purged or in the bin, of the folder's own bytes,
                    // is the pull's to take away (35).
                    if bound.path == file.key && bound.content_hash == file.hash {
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
                None => {
                    match self.queue_create(
                        file,
                        (settings, embedded.contains(&file.key)),
                        catalog,
                        edge_types,
                        &withheld,
                        &mut work,
                    )? {
                        Some(flagged) => report.flagged.push(flagged),
                        None => {
                            report.created += 1;
                            report.warnings.extend(near_limit(&file.key, &file.text));
                        }
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
                        // Lines only the server can resolve are asked again
                        // at each scan that can ask it.
                        if bound
                            .held
                            .as_deref()
                            .is_some_and(|held| held.starts_with(state::EDGES_WAITING))
                        {
                            work.push(self.edge_work(file, &item_id, Some(&bound)));
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
                        });
                    }
                    let rewritten = retitle
                        .as_ref()
                        .filter(|_| mode == Files::Write)
                        .and_then(|retitle| self.retitle_file(file, retitle));
                    // Where the title line was not rewritten, the title goes
                    // beside the file's bytes.
                    let sent_title = retitle.as_ref().filter(|_| rewritten.is_none());
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
        // Without its stat, the next quick pass reads it again.
        scan.stats.retain(|(key, _)| !unsettled.contains(key));

        Ok(ControlFlow::Continue(work))
    }

    /// Sends the edges the files' links and lines ask for, once every file
    /// is bound. A failure is its file's alone: the file waits.
    fn queue_edge_work(&self, scan: &mut ScanState, mut work: Vec<EdgeWork>) -> Result<()> {
        let (catalog, edge_types) = (&scan.catalog, &scan.edge_types);
        let (shown, report) = (&mut scan.shown, &mut scan.report);
        // Every file is bound now, so a link or a line naming one that
        // arrived in the same scan resolves.
        let mut resolver = Resolver::new(&self.core, catalog, &BoundFiles);
        for pending in &mut work {
            pending.embeds = shown.remove(&pending.path).unwrap_or_default();
        }
        for pending in work {
            // A failure is this file's alone: it waits, and the scan goes on.
            let outcome = self
                .queue_edges(&pending, edge_types, catalog, &mut resolver)
                .unwrap_or_else(|error| lines::Outcome {
                    links: pending.had_links.clone(),
                    lines: pending.had_lines.clone(),
                    held: Some(format!("{}{error}", state::EDGES_WAITING)),
                    queued: Vec::new(),
                    embeds: Vec::new(),
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
                let held = outcome.held;
                let mut writes = bound.writes.clone();
                let save = writes.save;
                writes
                    .queued
                    .extend(outcome.queued.into_iter().map(|id| state::Queued {
                        id,
                        save,
                        line: None,
                    }));
                // A refused edge the file no longer asks for holds it no longer.
                writes.refused.retain(|refused| match &refused.change {
                    state::Change::Edge { line, shown } => outcome.lines.contains(line) == *shown,
                    _ => true,
                });
                state::bind(
                    &conn,
                    &state::Bound {
                        links: outcome.links,
                        lines: outcome.lines,
                        held,
                        writes,
                        ..bound
                    },
                )?;
            }
        }

        Ok(())
    }

    /// Records the size and time each file had before its read.
    fn record_stats(&self, scan: &ScanState) -> Result<()> {
        let conn = self.core.conn()?;
        state::set_stats(&conn, &scan.stats, scan.full)?;
        Ok(())
    }

    /// Journals the bound files the walk did not find, rather than deleting
    /// them, and sweeps the journal where the pass saw the whole folder.
    fn sweep(&self, scan: &mut ScanState, peers: &Peers<'_>) -> Result<ControlFlow<()>> {
        let (seen, lists, walked, settings) =
            (&scan.seen, &scan.lists, &scan.walked, &scan.settings);
        let (incomplete, report) = (scan.incomplete, &mut scan.report);
        // Journaled rather than deleted: the first half of a rename looks
        // exactly like a delete.
        let bound = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        // By path and item: another item's file at the path answers no delete.
        let journaled: HashSet<(String, String)> = {
            let conn = self.core.conn()?;
            state::journaled(&conn)?
                .into_iter()
                .map(|row| (row.path, row.item_id))
                .collect()
        };
        for row in bound {
            if let Some(gone) = self.root_gone() {
                report.root_gone = Some(gone);
                return Ok(ControlFlow::Break(()));
            }
            let held = journaled.contains(&(row.path.clone(), row.item_id.clone()));
            if seen.contains(&row.path) {
                // Back inside the grace, so the server never hears of it.
                if held {
                    let conn = self.core.conn()?;
                    state::journal_clear(&conn, &row.path)?;
                }
                continue;
            }
            // Not reached is not gone: the item of a file the lists stopped
            // taking, or one the walk could not read or passed over, is not trashed.
            if !self.reaches(lists, &row.path) || walked.passed_over(&row.path) {
                if held {
                    let conn = self.core.conn()?;
                    state::journal_clear(&conn, &row.path)?;
                }
                report.unreached += 1;
                continue;
            }
            // An unread part of the inventory may hold a file moved from
            // any other path, so no missing path proves a deletion this pass.
            if incomplete {
                continue;
            }
            let conn = self.core.conn()?;
            state::journal_missing(&conn, &row.path, &row.item_id)?;
            report.missing += 1;
        }
        if !incomplete && self.root_gone().is_none() {
            self.sweep_journal(settings, peers, scan.full, report)?;
        }
        Ok(ControlFlow::Continue(()))
    }

    /// An editor that did not follow a pull's move of a document saves its old
    /// buffer where the file was. In a scan that writes files, such a save,
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
                    crate::names::same(&from.path, &file.key)
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

    /// Why a save of an old buffer of `bound`'s file is held and not taken, as
    /// `take_stale_save` decides before it moves anything: the file holds a
    /// change of its own, or bytes the device has not read. Moves nothing.
    fn stale_save_refusal(&self, bound: &state::Bound) -> Option<String> {
        let own = |reason: &str| Some(format!("it is an old copy of {}, {reason}", bound.path));
        if bound.held.is_some() || !bound.writes.refused.is_empty() {
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
    /// nothing: the bound file aside, checked to hold the bytes it is bound
    /// to, the save in its place, and only then the bound file removed. Answers
    /// why not, where it did not.
    fn take_stale_save(
        &self,
        file: &Scanned,
        bound: &state::Bound,
    ) -> Result<std::result::Result<(), String>> {
        let own = |reason: &str| Err(format!("it is an old copy of {}, {reason}", bound.path));
        // A held or refused file holds the person's bytes, which the server
        // does not. Any other change read since the move is an earlier old
        // buffer, since an edit of the moved file ends its record.
        if bound.held.is_some() || !bound.writes.refused.is_empty() {
            return Ok(own("which holds a change of its own; keep one of the two"));
        }
        let target = self.root.join(&bound.path);
        let edited = || own("which holds an edit of its own; keep one of the two");
        let failed = |error: std::io::Error| own(&format!("which could not be replaced: {error}"));
        let (to_dir, to_name) = match self
            .inside(target.parent())
            .and_then(|()| self.location(&target, true))
        {
            Ok(found) => found,
            Err(error) => return Ok(failed(error)),
        };
        let (from_dir, from_name) = match self.location(&file.path, false) {
            Ok(found) => found,
            Err(error) => return Ok(failed(error)),
        };
        let to_name = Path::new(&to_name);
        let aside = match to_dir.read(to_name) {
            Ok(found) if state::hash(&found) != bound.content_hash => return Ok(edited()),
            Ok(_) => {
                landing::save_meanwhile(&to_dir, to_name);
                match landing::set_aside(&to_dir, to_name) {
                    Ok(aside) => {
                        landing::crash_if_named(to_name, "crash-after-aside");
                        Some(aside)
                    }
                    Err(error) => return Ok(failed(error)),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Ok(failed(error)),
        };
        if let Some(aside) = &aside
            && !to_dir
                .read(aside)
                .is_ok_and(|found| state::hash(&found) == bound.content_hash)
        {
            // Saved between the look and the rename: put back, or where
            // another file took the path meanwhile, left aside, whole.
            landing::appear_at(&to_dir, to_name, "create-before-put-back")
                .map_err(|error| CoreError::Io(error.to_string()))?;
            return Ok(
                match landing::rename_new_at(&to_dir, aside, &to_dir, to_name) {
                    Ok(()) => edited(),
                    Err(_) => match self.keep_beside(&to_dir, aside, &bound.path) {
                        Ok(kept) => own(&format!(
                            "which was saved meanwhile while another file took its name; that save is kept as {kept}"
                        )),
                        Err(error) => own(&format!(
                            "which was saved meanwhile and is kept as {}: {error}",
                            aside.display()
                        )),
                    },
                },
            );
        }
        let placed = landing::rename_new_at(&from_dir, Path::new(&from_name), &to_dir, to_name);
        if let Some(aside) = &aside {
            // Bytes the device read and sent, or the pull wrote.
            let back = placed
                .is_err()
                .then(|| landing::rename_new_at(&to_dir, aside, &to_dir, to_name));
            if !back.as_ref().is_some_and(std::result::Result::is_ok) {
                let _ = landing::remove_at(&to_dir, aside, |found| {
                    state::hash(found) == bound.content_hash
                });
            }
        }
        Ok(match placed {
            Ok(()) => Ok(()),
            Err(error) => failed(error),
        })
    }

    /// Moves a person's save left aside to the first free numbered name beside
    /// `path`, where it is a file of theirs the folder takes as any other.
    /// Answers that path.
    fn keep_beside(&self, dir: &Directory, aside: &Path, path: &str) -> std::io::Result<String> {
        loop {
            let kept = beside(path, |candidate| self.exists(self.root.join(candidate)));
            match landing::rename_new_at(dir, aside, dir, Path::new(name_of(&kept))) {
                Ok(()) => return Ok(kept),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
    }

    /// Held ids decide first; then the binding by identity across every file
    /// before any by path, so a path never takes an item another file is by
    /// identity.
    fn claim(
        &self,
        files: &[Scanned],
        snapshot: &[state::Bound],
        settings: &Settings,
        catalog: &Catalog,
        peers: &Peers<'_>,
    ) -> Result<(Vec<Option<Claim>>, Waiting)> {
        let by_mark: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .filter_map(|row| row.identity.as_deref().map(|mark| (mark, row)))
            .collect();
        let by_path: HashMap<&str, &state::Bound> = snapshot
            .iter()
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

        let mut contests: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
        let mut waiting = Waiting::new();
        let members = OnceCell::new();
        for (at, file) in files.iter().enumerate() {
            let Some(id) = file.id.as_deref() else {
                continue;
            };
            // A copy bound to its own item before its id line was rewritten
            // stays that item's file.
            if by_path
                .get(file.key.as_str())
                .is_some_and(|bound| bound.identity == file.mark && bound.item_id != id)
            {
                continue;
            }
            if named(file).is_none_or(|bound| bound.item_id != id) {
                match self.arrival(id, settings, peers, &members)? {
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
        // A file that carries no id and that no record here names, the
        // folder added again over its own files say, is the item this folder
        // holds that is placed where it sits and whose bytes it holds. An item
        // the query no longer holds, one another folder took in or one that
        // left by state, has a file elsewhere or none, and a copy of it is new.
        let mut placed: Option<HashMap<String, Vec<crate::model::Edge>>> = None;
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
                None => placed.insert(self.placed_here()?),
            };
            let Some(candidates) = placed.get(&crate::names::folded(&file.key)) else {
                continue;
            };
            for edge in candidates {
                if by_item.contains_key(edge.source_id.as_str())
                    || taken.contains(&edge.source_id)
                    || !self.holds(&edge.source_id, settings, &members)
                {
                    continue;
                }
                let Some(item) = self.core.get(&edge.source_id)? else {
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
                        lines: Vec::new(),
                        edit_line: None,
                        held: None,
                        own: None,
                        writes: state::Writes::default(),
                    }),
                });
                break;
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
            match self.read_moved(&theirs.item_id)? {
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
            near_limit(&file.key, &file.text)
        })
    }

    fn holds_bytes(&self, item: &Item, file: &Scanned, catalog: &Catalog) -> bool {
        if item.r#type.starts_with("system.") || !suited(item, &file.key, catalog) {
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
    ) -> Result<Arrival> {
        if peers.carry(id) {
            return Ok(if self.holds(id, settings, members) {
                Arrival::Here
            } else {
                Arrival::Copy
            });
        }
        if self.core.get(id)?.is_none() && peers.held_elsewhere(id) {
            return Ok(match self.read_moved(id)? {
                Some(reason) => Arrival::Waits(reason),
                None => Arrival::Here,
            });
        }
        Ok(Arrival::Here)
    }

    fn holds(&self, id: &str, settings: &Settings, members: &OnceCell<HashSet<String>>) -> bool {
        members
            .get_or_init(|| self.members(settings).unwrap_or_default())
            .contains(id)
    }

    /// `Some` with why where the item cannot be asked now. An item the server
    /// will not show leaves a new item.
    fn read_moved(&self, id: &str) -> Result<Option<String>> {
        if self.core.get(id)?.is_some() {
            return Ok(None);
        }
        match self.core.pin(id) {
            Ok(_) | Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => Ok(None),
            Err(error) => Ok(Some(format!(
                "it carries the id of an item moved from another folder on this machine, which cannot be read yet ({error}); it is taken at the next push"
            ))),
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
    /// in the other folders again only by a full pass, so a watch walks them
    /// at most once every full pass for it.
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
        // Counted over every missing file, not only those past the grace, so
        // files a watch meets a pass apart are one removal.
        if settings.removal_threshold.exceeded(journaled.len(), of) {
            let paths: Vec<String> = journaled.into_iter().map(|row| row.path).collect();
            state::set_paused(&*self.core.conn()?, state::Removal::Disk, &paths)?;
            report.paused = paths.len();
            return Ok(());
        }
        state::set_paused(&*self.core.conn()?, state::Removal::Disk, &[])?;
        let now = crate::store::iso_at(crate::clock::system_time());
        let sweep = Sweep::default();
        let mut due = Vec::new();
        for row in journaled {
            if !elapsed_past(&row.missing_since, &now, RENAME_GRACE) {
                continue;
            }
            match row.kept {
                Some(state::Kept::Unsure(reason)) if !full => {
                    report.unsure.push(Unsure {
                        path: row.path,
                        reason,
                    });
                    continue;
                }
                Some(state::Kept::Arriving) if !full => continue,
                _ => {}
            }
            due.push((row.path, row.item_id));
        }
        self.decide_changed(&due, settings, &sweep)?;
        for (path, item_id) in due {
            match self.let_go_missing(&path, &item_id, settings, peers, &sweep)? {
                Missing::Moved => report.moved_away += 1,
                Missing::Arriving | Missing::Changed => {}
                Missing::Unsure(reason) => report.unsure.push(Unsure { path, reason }),
                Missing::Deleted => {
                    report.deleted += 1;
                    report.trashed.push(path);
                }
                Missing::Gone => {}
            }
        }
        Ok(())
    }

    /// Decides for every file of `missing`, a path and its item, whether its
    /// item changed in what the file showed, before `let_go_missing` queues
    /// the first delete (`folders/missing-file-trashed`).
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
            let catalog = Catalog::load(&*self.core.conn()?)?;
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
            let catalog = Catalog::load(&*self.core.conn()?)?;
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
                    loop {
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
