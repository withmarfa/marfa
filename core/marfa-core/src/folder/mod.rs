//! A directory on a machine that holds a slice as files.
//!
//! A folder is a device like any other (`device.md`, `queue-and-verdicts.md`)
//! with a filesystem as its face. What is here is the translation between a
//! file and an item, and the state that translation keeps across a restart.

pub mod document;
pub mod identity;
pub mod state;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{BlockedReason, Draft, Edit, Item, Tier, WriteKind};
use crate::{Core, Result, Server};

/// Where a folder keeps what is its own (`folders.md` 20).
pub const STATE_DIR: &str = ".marfa";

/// How long a missing file is journaled before it becomes a delete
/// (`folders.md` 15): the window in which the other half of a rename can
/// arrive.
pub const RENAME_GRACE: Duration = Duration::from_secs(5);

/// What a folder is a view on, and what a new file becomes (`folders.md` 1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Slice {
    /// The types this folder holds. A file of any other type is not pushed
    /// and an item of any other type does not become a file.
    pub types: Vec<String>,
    pub tier: Tier,
    /// What a new file becomes when nothing in it says.
    pub default_type: String,
    /// Properties the type requires that a file cannot carry.
    #[serde(default)]
    pub defaults: Map<String, Value>,
    /// Tags every item in this folder carries.
    #[serde(default)]
    pub tags: Vec<String>,
}

impl Slice {
    fn check(&self) -> Result<()> {
        if self.types.is_empty() {
            return Err(CoreError::Invalid(
                "a folder with no types is a view on nothing; name at least one".into(),
            ));
        }
        if !self.types.iter().any(|held| held == &self.default_type) {
            return Err(CoreError::Invalid(format!(
                "this folder makes a new file a {} and does not hold that type, so every file it created would fall outside its own slice",
                self.default_type
            )));
        }
        Ok(())
    }
}

/// A directory, its slice, and the device underneath it.
pub struct Folder {
    root: PathBuf,
    slice: Slice,
    core: Core,
}

/// What a scan did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ScanReport {
    /// Files that became new items, copies among them.
    pub created: usize,
    /// Files whose changes were queued against the item they are.
    pub updated: usize,
    /// Files that moved and kept their item.
    pub renamed: usize,
    /// Files the folder already agreed with, so nothing was queued.
    pub unchanged: usize,
    /// Bound files that were not there, now journaled.
    pub missing: usize,
    /// Journaled files whose grace ran out, now queued as deletes.
    pub deleted: usize,
    /// Files outside the folder's slice, left alone.
    pub skipped: usize,
    /// Files bound to a row the copy lost, queued again as new items because
    /// they changed or moved (`folders.md` 30); counted in `created` too.
    pub requeued: usize,
    /// Files bound to a row the copy no longer holds and unchanged since, so
    /// nothing is sent for them (`folders.md` 30).
    pub lost: usize,
}

impl Folder {
    /// Writes a folder's slice into a directory and opens it. The directory
    /// need not exist (`folders.md` 3).
    pub fn add(root: impl AsRef<Path>, slice: Slice, server: Option<Server>) -> Result<Folder> {
        slice.check()?;
        let root = root.as_ref().to_path_buf();
        let state = root.join(STATE_DIR);
        std::fs::create_dir_all(&state).map_err(|error| {
            CoreError::Store(format!("cannot make {}: {error}", state.display()))
        })?;
        let json = serde_json::to_string_pretty(&slice)?;
        std::fs::write(state.join("folder.json"), json).map_err(|error| {
            CoreError::Store(format!("cannot write this folder's slice: {error}"))
        })?;
        Folder::open(root, server)
    }

    /// Opens a directory somebody has already made a folder.
    pub fn open(root: impl AsRef<Path>, server: Option<Server>) -> Result<Folder> {
        let root = root.as_ref().to_path_buf();
        let config = root.join(STATE_DIR).join("folder.json");
        let text = std::fs::read_to_string(&config).map_err(|error| {
            CoreError::Invalid(format!(
                "{} is not a folder ({error}); `folders add` makes one",
                root.display()
            ))
        })?;
        let slice = serde_json::from_str::<Slice>(&text)?;
        slice.check()?;
        let core = Core::open(root.join(STATE_DIR).join("core.sqlite"), server)?;
        Ok(Folder { root, slice, core })
    }

    pub fn slice(&self) -> &Slice {
        &self.slice
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Pulls the slice this folder is a view on.
    pub fn hydrate(&self) -> Result<crate::model::HydrateReport> {
        self.core.hydrate(&self.slice.types, self.slice.tier)
    }

    /// Hydrates where the copy cannot answer: never hydrated, cut short, or
    /// its cursor aged out (`device.md` 4). `None` where it can.
    pub fn resume(&self) -> Result<Option<crate::model::HydrateReport>> {
        if crate::store::hydrated(&*self.core.conn()?)? {
            return Ok(None);
        }
        self.hydrate().map(Some)
    }

    /// Takes in what the server has recorded since the copy's cursor, or
    /// hydrates again where the log has aged past it (`device.md` 16).
    pub fn catch_up(&self) -> Result<CaughtUp> {
        match self.core.catch_up() {
            Ok(report) => Ok(CaughtUp {
                caught_up: Some(report),
                hydrated: None,
            }),
            Err(CoreError::CatchUpTooOld { .. }) => Ok(CaughtUp {
                caught_up: None,
                hydrated: Some(self.hydrate()?),
            }),
            Err(error) => Err(error),
        }
    }

    /// Every file the folder watches, in a stable order. Dot-led directories
    /// are excluded at any depth, `.marfa/` with them (`folders.md` 19, 20).
    pub fn files(&self) -> Result<Vec<PathBuf>> {
        let mut found = Vec::new();
        walk(&self.root, &mut found)?;
        found.sort();
        Ok(found)
    }
}

/// Walks a directory, skipping anything dot-led at any depth.
fn walk(dir: &Path, into: &mut Vec<PathBuf>) -> Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Gone mid-walk: the scan that follows will not find its files either.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(CoreError::Store(format!(
                "cannot read {}: {error}",
                dir.display()
            )));
        }
    };
    for entry in entries {
        let entry = entry
            .map_err(|error| CoreError::Store(format!("cannot read {}: {error}", dir.display())))?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        // A symlink is neither: following one would give two paths one
        // identity on purpose.
        if metadata.is_dir() {
            walk(&path, into)?;
        } else if metadata.is_file() {
            into.push(path);
        }
    }
    Ok(())
}

/// A file the scan read.
struct Scanned {
    /// The path inside the folder, which the binding is keyed by.
    key: String,
    path: PathBuf,
    text: String,
    hash: String,
    /// Device, inode and birth time, where the filesystem gave a usable
    /// three (`folders.md` 12).
    mark: Option<String>,
    born: Option<u128>,
    /// The `marfa_id` a Markdown file's frontmatter carries.
    id: Option<String>,
    /// The version its `marfa_version` line names, where that is one the
    /// server could have minted.
    line: Option<i64>,
}

impl Scanned {
    fn document(&self) -> document::Document {
        if carries_frontmatter(&self.path) {
            document::read(&self.text)
        } else {
            document::read_body(&self.text)
        }
    }
}

/// The item a file is, and the binding it had, if any.
#[derive(Debug, Clone)]
struct Claim {
    item_id: String,
    bound: Option<state::Bound>,
}

impl Folder {
    /// Reads the folder and queues what has changed. The watcher calls this
    /// too, so one rule decides identity (`folders.md` 13).
    pub fn scan(&self) -> Result<ScanReport> {
        let mut report = ScanReport::default();
        let catalog = {
            let conn = self.core.conn()?;
            Catalog::load(&conn)?
        };
        let paths = self.files()?;
        // Every file the walk found, whether or not it is pushed: leaving one
        // out journals it missing and deletes the item bound to it.
        let mut seen: HashSet<String> = HashSet::new();
        let mut held: Vec<PathBuf> = Vec::new();
        for path in &paths {
            seen.insert(identity::relative(&self.root, path)?);
            if self.pushes(path, &catalog) {
                held.push(path.clone());
            } else {
                report.skipped += 1;
            }
        }
        // Resolved over pushed files only, so a file the folder never touches
        // cannot withhold a note's identity by sharing it.
        let identities = identity::resolve(&held);
        let mut files = Vec::new();
        for path in held {
            // Unreadable now, a dataless placeholder say: the next scan reads
            // it, and the folder holds what it last agreed with meanwhile.
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            // No blob the server holds is empty (`folders.md` 28).
            if bytes.is_empty() && !is_document(&path) {
                report.skipped += 1;
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let header = carries_frontmatter(&path).then(|| document::read(&text).properties);
            let id = header.as_ref().and_then(|header| {
                header
                    .get(ID_FIELD)
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            let line = header.as_ref().and_then(line_of);
            files.push(Scanned {
                key: identity::relative(&self.root, &path)?,
                mark: identities.get(&path).map(|found| found.key()),
                born: std::fs::symlink_metadata(&path)
                    .ok()
                    .and_then(|metadata| identity::born(&metadata)),
                hash: state::hash(&bytes),
                text,
                id,
                line,
                path,
            });
        }
        let snapshot = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        let claims = self.claim(&files, &snapshot, &catalog)?;
        let mut unresolved: Vec<Unresolved> = Vec::new();

        for (file, claim) in files.iter().zip(claims) {
            // A binding to a row the copy no longer holds binds nothing
            // (`folders.md` 30).
            let claim = match claim {
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) if self.core.get(&item_id)?.is_none() => {
                    // The server has answered these bytes already.
                    if bound.path == file.key && bound.content_hash == file.hash {
                        report.lost += 1;
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
                    self.queue_create(file, &catalog, &mut unresolved)?;
                    report.created += 1;
                }
                Some(Claim {
                    item_id,
                    bound: None,
                }) => {
                    if self.queue_update(&item_id, None, file, &catalog, &mut unresolved)? {
                        report.updated += 1;
                    } else {
                        report.unchanged += 1;
                    }
                }
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) if bound.path == file.key => {
                    if bound.content_hash == file.hash {
                        // An editor's atomic save gives the same bytes a new
                        // inode, and a stale record would lose the next rename.
                        if bound.identity != file.mark {
                            let conn = self.core.conn()?;
                            state::bind(
                                &conn,
                                &state::Bound {
                                    identity: file.mark.clone(),
                                    ..bound
                                },
                            )?;
                        }
                        report.unchanged += 1;
                        continue;
                    }
                    if self.queue_update(&item_id, Some(&bound), file, &catalog, &mut unresolved)? {
                        report.updated += 1;
                    } else {
                        report.unchanged += 1;
                    }
                }
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) => {
                    self.unbind_if_still(&bound)?;
                    self.queue_update(&item_id, Some(&bound), file, &catalog, &mut unresolved)?;
                    report.renamed += 1;
                }
            }
        }

        // Every file is bound now, so a link naming one that arrived in the
        // same scan resolves (`folders.md` 25).
        for pending in unresolved {
            let (named, declined, _) = self.queue_links(
                &pending.item_id,
                &pending.links,
                &pending.had,
                &pending.declined,
            )?;
            let conn = self.core.conn()?;
            if let Some(bound) = state::bound_at(&conn, &pending.path)? {
                state::bind(
                    &conn,
                    &state::Bound {
                        links: named,
                        declined,
                        ..bound
                    },
                )?;
            }
        }

        // Journaled rather than deleted: the first half of a rename looks
        // exactly like a delete (`folders.md` 15, 16).
        let bound = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        let journaled: HashSet<String> = {
            let conn = self.core.conn()?;
            state::journaled(&conn)?
                .into_iter()
                .map(|(path, _, _)| path)
                .collect()
        };
        for row in bound {
            if seen.contains(&row.path) {
                // Back inside the grace, so the server never hears of it.
                if journaled.contains(&row.path) {
                    let conn = self.core.conn()?;
                    state::journal_clear(&conn, &row.path)?;
                }
                continue;
            }
            let conn = self.core.conn()?;
            state::journal_missing(&conn, &row.path, &row.item_id)?;
            report.missing += 1;
        }
        report.deleted = self.sweep_journal()?;
        Ok(report)
    }

    /// Which item each file is, or `None` for a new one (`folders.md` 8 to
    /// 12). Held ids decide first; then the binding by identity across every
    /// file before any by path, so a path never takes an item another file is
    /// by identity.
    fn claim(
        &self,
        files: &[Scanned],
        snapshot: &[state::Bound],
        catalog: &Catalog,
    ) -> Result<Vec<Option<Claim>>> {
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
        for (at, file) in files.iter().enumerate() {
            let Some(id) = file.id.as_deref() else {
                continue;
            };
            // A copy bound to its own item before its id line was rewritten
            // stays that item's file (`folders.md` 10).
            if by_path
                .get(file.key.as_str())
                .is_some_and(|bound| bound.identity == file.mark && bound.item_id != id)
            {
                continue;
            }
            // A file item's file is its bytes, never a document naming it.
            if self
                .core
                .get(id)?
                .is_some_and(|item| bytes_of(&item, catalog).is_none())
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
            if claims[at].is_some() {
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
        Ok(claims)
    }

    /// Takes a binding's old path away, unless another file has been bound
    /// there earlier in this scan.
    fn unbind_if_still(&self, bound: &state::Bound) -> Result<()> {
        let conn = self.core.conn()?;
        if state::bound_at(&conn, &bound.path)?.is_some_and(|row| row.item_id == bound.item_id) {
            state::unbind(&conn, &bound.path)?;
            state::journal_clear(&conn, &bound.path)?;
        }
        Ok(())
    }

    /// Sends the deletes whose grace has run out.
    fn sweep_journal(&self) -> Result<usize> {
        let journaled = {
            let conn = self.core.conn()?;
            state::journaled(&conn)?
        };
        let now = crate::store::now_iso();
        let mut sent = 0usize;
        for (path, item_id, missing_since) in journaled {
            if !elapsed_past(&missing_since, &now, RENAME_GRACE) {
                continue;
            }
            // A row already gone is the one excuse; anything else the store
            // says is an error, not a reason to skip the delete.
            let held = {
                let conn = self.core.conn()?;
                crate::store::item_held(&conn, &item_id)?
            };
            if held {
                self.core.delete_item(&item_id)?;
                sent += 1;
            }
            let conn = self.core.conn()?;
            state::journal_clear(&conn, &path)?;
            state::unbind(&conn, &path)?;
        }
        Ok(sent)
    }

    /// Whether this path is one the folder pushes (`folders.md` 21, 28): a
    /// document, or a file the slice holds a file type for.
    fn pushes(&self, path: &Path, catalog: &Catalog) -> bool {
        is_document(path) || self.file_type_of(path, catalog).is_some()
    }

    /// The type a file that is not a document becomes, where the slice holds
    /// it (`folders.md` 28).
    fn file_type_of(&self, path: &Path, catalog: &Catalog) -> Option<String> {
        if is_document(path) {
            return None;
        }
        let named = crate::blob::file_type_for(&crate::blob::mime_type_for(path, None), None);
        let file_type = if catalog.known(&named) {
            named
        } else {
            FILE_TYPE.to_string()
        };
        self.slice
            .types
            .iter()
            .any(|declared| catalog.matches(declared, &file_type))
            .then_some(file_type)
    }

    /// Queues a file as a new item under an id the device mints, with no
    /// natural key (`folders.md` 8).
    fn queue_create(
        &self,
        file: &Scanned,
        catalog: &Catalog,
        unresolved: &mut Vec<Unresolved>,
    ) -> Result<()> {
        if let Some(file_type) = self.file_type_of(&file.path, catalog) {
            return self.queue_create_file(file, file_type);
        }
        let document = file.document();
        let mut properties = sendable(document.properties);
        for (field, value) in &self.slice.defaults {
            properties.entry(field.clone()).or_insert(value.clone());
        }
        properties
            .entry(document::TITLE_FIELD)
            .or_insert(Value::String(title_of(&file.key)));
        let draft = Draft {
            r#type: self.slice.default_type.clone(),
            properties,
            tags: self.slice.tags.clone(),
            tier: Some(self.slice.tier),
            ..Default::default()
        };
        let item_id = named_item(self.core.create_item(&draft)?, &file.key)?;
        let (named, declined, resolved) = self.queue_links(&item_id, &document.links, &[], &[])?;
        if !resolved {
            unresolved.push(Unresolved {
                path: file.key.clone(),
                item_id: item_id.clone(),
                links: document.links.clone(),
                had: Vec::new(),
                declined: Vec::new(),
            });
        }
        self.bind_scanned(file, &item_id, named, declined, None)
    }

    /// A file that is not a document, as a file item: its bytes' upload, and
    /// the create waiting on it (`folders.md` 28).
    fn queue_create_file(&self, file: &Scanned, file_type: String) -> Result<()> {
        let mut properties = Map::new();
        properties.insert(
            document::TITLE_FIELD.into(),
            Value::String(name_of(&file.key).into()),
        );
        let draft = Draft {
            r#type: file_type,
            properties,
            tags: self.slice.tags.clone(),
            tier: Some(self.slice.tier),
            ..Default::default()
        };
        let item_id = named_item(self.core.create_file_item(&file.path, &draft)?, &file.key)?;
        self.bind_scanned(file, &item_id, Vec::new(), Vec::new(), None)
    }

    /// Queues what a file holds as an edit of its item, and answers whether
    /// anything went. `bound` is `None` for an id this folder has no file for.
    fn queue_update(
        &self,
        item_id: &str,
        bound: Option<&state::Bound>,
        file: &Scanned,
        catalog: &Catalog,
        unresolved: &mut Vec<Unresolved>,
    ) -> Result<bool> {
        let Some(held) = self.core.get(item_id)? else {
            return Err(CoreError::Invalid(format!(
                "{} is {item_id}, which this copy stopped holding during the scan; \
                 the file is left as it is and nothing is queued for it",
                file.key
            )));
        };
        // The item decides, not the extension: a file item pulled under a
        // name that reads as a document is still bytes.
        if bytes_of(&held, catalog).is_some()
            && let Some(bound) = bound
        {
            return self.queue_update_file(bound, file, &held);
        }
        let had = bound.map(|bound| bound.links.clone()).unwrap_or_default();
        let declined = bound
            .map(|bound| bound.declined.clone())
            .unwrap_or_default();
        let document = file.document();
        let properties = sendable(document.properties);
        // A save that changed only lines never sent, the id or the version,
        // changes nothing.
        let in_step = match bound {
            Some(bound) => {
                bound.content_hash == file.hash
                    || file.id.is_none() && properties == held.properties
                    || carries_frontmatter(&file.path)
                        && self.render(&held, &declined, true, file.line)?.0 == file.text
            }
            None => properties
                .iter()
                .all(|(field, value)| held.properties.get(field) == Some(value)),
        };
        let mut edit_line = bound.and_then(|bound| bound.edit_line);
        if !in_step {
            // Bytes set aside in a conflicted copy against this device's own
            // earlier save go on the version they were read at (`folders.md` 31).
            let untaken = bound.and_then(|bound| state::untaken_read_version(&bound.content_hash));
            // A line no newer than one an earlier edit went on is spent: this
            // edit was made against that one (`folders.md` 17).
            let line = file
                .line
                .filter(|line| *line < held.version && edit_line.is_none_or(|spent| *line > spent));
            let read_at = untaken.or(line);
            let edit = Edit {
                properties,
                base_version: Some(read_at.unwrap_or(held.version)),
                ..Edit::default()
            };
            if read_at.is_some() {
                self.core.update_item_as_read(item_id, &edit)?;
            } else {
                self.core.update_item(item_id, &edit)?;
            }
            edit_line = Some(edit_line.unwrap_or(0).max(file.line.unwrap_or(0)));
        }
        let (named, declined, resolved) =
            self.queue_links(item_id, &document.links, &had, &declined)?;
        if !resolved {
            unresolved.push(Unresolved {
                path: file.key.clone(),
                item_id: item_id.to_string(),
                links: document.links.clone(),
                had,
                declined: declined.clone(),
            });
        }
        self.bind_scanned(file, item_id, named, declined, edit_line)?;
        Ok(!in_step)
    }

    /// New bytes are an upload and an update naming them; a move carries the
    /// new name as the title where the old name was it (`folders.md` 28).
    fn queue_update_file(&self, bound: &state::Bound, file: &Scanned, held: &Item) -> Result<bool> {
        let read_at = state::untaken_read_version(&bound.content_hash);
        let based = if read_at.is_some() {
            crate::Based::AsRead
        } else {
            crate::Based::OnHeld
        };
        let mut edit = Edit {
            properties: Map::new(),
            base_version: Some(read_at.unwrap_or(held.version)),
            ..Edit::default()
        };
        let (old_name, new_name) = (name_of(&bound.path), name_of(&file.key));
        if old_name != new_name
            && held
                .properties
                .get(document::TITLE_FIELD)
                .and_then(Value::as_str)
                == Some(old_name)
        {
            edit.properties
                .insert(document::TITLE_FIELD.into(), Value::String(new_name.into()));
        }
        let queued = if bound.content_hash != file.hash {
            self.core
                .update_file_item(&held.id, &file.path, &edit, based)?;
            true
        } else if !edit.properties.is_empty() {
            match based {
                crate::Based::AsRead => self.core.update_item_as_read(&held.id, &edit)?,
                crate::Based::OnHeld => self.core.update_item(&held.id, &edit)?,
            };
            true
        } else {
            false
        };
        self.bind_scanned(file, &held.id, Vec::new(), Vec::new(), None)?;
        Ok(queued)
    }

    /// Binds a file as the scan read it.
    fn bind_scanned(
        &self,
        file: &Scanned,
        item_id: &str,
        links: Vec<String>,
        declined: Vec<String>,
        edit_line: Option<i64>,
    ) -> Result<()> {
        let conn = self.core.conn()?;
        state::bind(
            &conn,
            &state::Bound {
                path: file.key.clone(),
                item_id: item_id.to_string(),
                identity: file.mark.clone(),
                content_hash: file.hash.clone(),
                written_hash: None,
                links,
                declined,
                edit_line,
            },
        )
    }

    /// Links in the body become edges, and a lost link takes its edge
    /// (`folders.md` 7, 23). Answers the targets named, the targets declined
    /// (`folders.md` 27), and whether every link resolved.
    fn queue_links(
        &self,
        item_id: &str,
        links: &[String],
        had: &[String],
        declined: &[String],
    ) -> Result<(Vec<String>, Vec<String>, bool)> {
        if item_id.is_empty() {
            return Ok((Vec::new(), Vec::new(), true));
        }
        // An error here read as "no edges" would recreate every edge and
        // remove none.
        let edges = self.core.edges_from(item_id)?;
        let held: Vec<&str> = edges.iter().map(|edge| edge.target_id.as_str()).collect();
        let mut named: Vec<String> = Vec::new();
        let mut every_link_resolved = true;
        for target in links {
            let Some(resolved) = self.resolve_link(target)? else {
                // A link naming nothing looks like a link removed.
                every_link_resolved = false;
                continue;
            };
            if !held.contains(&resolved.as_str()) {
                self.core.create_edge(&crate::model::EdgeDraft {
                    source_id: item_id.to_string(),
                    target_id: resolved.clone(),
                    edge_type: LINK_EDGE.into(),
                    ..Default::default()
                })?;
            }
            if !named.contains(&resolved) {
                named.push(resolved);
            }
        }
        if !every_link_resolved {
            let mut kept = named;
            for target in had {
                if !kept.contains(target) {
                    kept.push(target.clone());
                }
            }
            return Ok((kept, declined.to_vec(), false));
        }
        let foreign: HashSet<&str> = edges
            .iter()
            .filter(|edge| edge.edge_type != LINK_EDGE)
            .map(|edge| edge.target_id.as_str())
            .collect();
        let mut still_declined: Vec<String> = declined
            .iter()
            .filter(|target| !named.contains(target))
            .cloned()
            .collect();
        for target in had {
            if foreign.contains(target.as_str())
                && !named.contains(target)
                && !still_declined.contains(target)
            {
                still_declined.push(target.clone());
            }
        }
        // An edge whose link the file never carried arrived from elsewhere
        // and is not yet rendered.
        for edge in edges {
            if edge.edge_type != LINK_EDGE
                || named.contains(&edge.target_id)
                || !had.contains(&edge.target_id)
            {
                continue;
            }
            self.core.delete_edge(&edge.id)?;
        }
        Ok((named, still_declined, true))
    }

    /// The item a link names: an id the copy holds, or a file in this folder.
    fn resolve_link(&self, target: &str) -> Result<Option<String>> {
        if self.core.get(target)?.is_some() {
            return Ok(Some(target.to_string()));
        }
        let conn = self.core.conn()?;
        for candidate in [target.to_string(), format!("{target}.md")] {
            if let Some(bound) = state::bound_at(&conn, &candidate)? {
                return Ok(Some(bound.item_id));
            }
        }
        Ok(None)
    }
}

/// The item a queued create made.
fn named_item(queued: crate::model::QueuedWrite, key: &str) -> Result<String> {
    queued
        .item_id
        .ok_or_else(|| CoreError::Invalid(format!("the create queued for {key} names no item")))
}

/// The last component of a path inside the folder.
fn name_of(key: &str) -> &str {
    key.rsplit('/').next().unwrap_or(key)
}

/// A file's name, without its extension, as the title a new item gets.
fn title_of(key: &str) -> String {
    let name = name_of(key);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/// Whether `grace` has passed between two instants in the wire's shape. A
/// pair this cannot read has not, since a delete cannot be taken back.
fn elapsed_past(since: &str, now: &str, grace: Duration) -> bool {
    let (Some(since), Some(now)) = (millis_of(since), millis_of(now)) else {
        return false;
    };
    now.saturating_sub(since) >= grace.as_millis() as i64
}

fn millis_of(stamp: &str) -> Option<i64> {
    // `YYYY-MM-DDTHH:MM:SS.mmmZ`, which is the one shape `now_iso` writes.
    let bytes = stamp.as_bytes();
    if bytes.len() < 24 {
        return None;
    }
    let number = |from: usize, to: usize| stamp.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let millis = number(20, 23)?;
    // Days since the epoch, by Howard Hinnant's algorithm run backwards.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

/// What a folder's drain did.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Drained {
    #[serde(flatten)]
    pub report: crate::DrainReport,
    /// Edits the server refused `ancestor_unavailable`, sent again on the
    /// version the copy holds (`folders.md` 17).
    pub rebased: usize,
}

impl Folder {
    /// Sends what the queue holds, and each edit whose base the server no
    /// longer holds again on the version the copy holds (`folders.md` 17).
    pub fn drain(&self) -> Result<Drained> {
        let mut report = self.core.drain()?;
        let mut rebased = 0;
        while report.stopped.is_none() {
            let now = self.rebase_thinned()?;
            if now == 0 {
                break;
            }
            rebased += now;
            let again = self.core.drain()?;
            report.sent += again.sent;
            report.held = again.held;
            report.verdicts.extend(again.verdicts);
            report.stopped = again.stopped;
            for source in again.unclaimed_sources {
                if !report.unclaimed_sources.contains(&source) {
                    report.unclaimed_sources.push(source);
                }
            }
            report.retry_after_seconds = report.retry_after_seconds.max(again.retry_after_seconds);
        }
        Ok(Drained { report, rebased })
    }

    /// Moves the first such edit of each row: the next was made against it,
    /// so it goes on its answer, a pass later.
    fn rebase_thinned(&self) -> Result<usize> {
        let queue = self.core.queue()?;
        let mut first: HashSet<&str> = HashSet::new();
        let mut rebased = 0;
        for row in &queue {
            let Some(item_id) = row.item_id.as_deref() else {
                continue;
            };
            if row.kind != WriteKind::UpdateItem
                || row.blocked_reason() != Some(BlockedReason::AncestorUnavailable)
                || !first.insert(item_id)
            {
                continue;
            }
            if self.core.rebase_on_held(&row.id)? {
                rebased += 1;
            }
        }
        Ok(rebased)
    }
}

impl Folder {
    /// Writes the slice out as files (`folders.md` 4), each bound before its
    /// bytes land so the scan never reads it back (`folders.md` 14).
    pub fn pull(&self) -> Result<PullReport> {
        let mut report = PullReport::default();
        let items = self.core.list(
            &crate::model::ListFilters {
                tier: Some(self.slice.tier),
                ..Default::default()
            },
            crate::model::Sort::default(),
        )?;
        let catalog = {
            let conn = self.core.conn()?;
            Catalog::load(&conn)?
        };
        // Paths already taken in this pass: two items resolving to one would
        // have the second steal the first's file.
        let mut taken: HashSet<String> = HashSet::new();
        // Every item this pass considered: the rest of the mapping is files of
        // items that have left the slice.
        let mut visited: HashSet<String> = HashSet::new();
        for item in &items {
            visited.insert(item.id.clone());
            // A type is held with its subtree (`device.md` 1).
            if !self
                .slice
                .types
                .iter()
                .any(|declared| catalog.matches(declared, &item.r#type))
            {
                report.skipped += 1;
                continue;
            }
            // This device's own create, not yet landed: the id goes back
            // only once it has (`folders.md` 8).
            if item.version == 0 {
                continue;
            }
            let bound = {
                let conn = self.core.conn()?;
                state::bound_to_item(&conn, &item.id)?
            };
            let want = self.path_for(item, bound.as_ref(), &catalog);
            if !plainly_inside(&self.root, &want) {
                report.outside += 1;
                continue;
            }
            let path = self.root.join(&want);
            let declined: Vec<String> = bound
                .as_ref()
                .map(|bound| bound.declined.clone())
                .unwrap_or_default();
            let (bytes, wrote) = match bytes_of(item, &catalog) {
                Some(blob) => {
                    // A file already holding these bytes needs no fetch.
                    let on_disk = bound
                        .as_ref()
                        .filter(|bound| bound.path == want)
                        .and_then(|bound| std::fs::read(self.root.join(&bound.path)).ok())
                        .filter(|found| {
                            crate::blob::named(blob)
                                .is_ok_and(|named| crate::blob::name_of(found) == named)
                        });
                    match on_disk {
                        Some(found) => (found, Vec::new()),
                        None => match self.core.blob(blob) {
                            Ok(held) => (
                                std::fs::read(&held).map_err(|error| {
                                    CoreError::Store(format!(
                                        "cannot read {}: {error}",
                                        held.display()
                                    ))
                                })?,
                                Vec::new(),
                            ),
                            // A refused credential refuses every file alike.
                            Err(error @ CoreError::Unauthorized { .. }) => return Err(error),
                            Err(_) => {
                                report.absent += 1;
                                continue;
                            }
                        },
                    }
                }
                None => {
                    let (text, wrote) = self.render(
                        item,
                        &declined,
                        carries_frontmatter(Path::new(&want)),
                        Some(item.version),
                    )?;
                    (text.into_bytes(), wrote)
                }
            };
            let hash = state::hash(&bytes);
            let ours = bound.as_ref().is_some_and(|bound| bound.path == want);

            if ours
                && bound
                    .as_ref()
                    .is_some_and(|bound| bound.content_hash == hash)
            {
                taken.insert(want);
                report.unchanged += 1;
                continue;
            }
            // The bytes on the disk, not the mapping's memory of them: a file
            // changed since the scan read it is the person's (`folders.md` 24).
            if let Some(bound) = &bound
                && std::fs::read(self.root.join(&bound.path))
                    .is_ok_and(|found| state::hash(&found) != bound.content_hash)
            {
                report.unwritten += 1;
                continue;
            }
            if ours
                && let Some(bound) = &bound
                && self.behind_by_its_line_alone(item, bound, &declined)?
            {
                taken.insert(want);
                report.unchanged += 1;
                continue;
            }
            // Something at the destination that is not this item's own file
            // (`folders.md` 24), unless it is byte for byte this item's render.
            if !ours && path.exists() {
                if bound.is_none() && std::fs::read(&path).is_ok_and(|found| found == bytes) {
                    let conn = self.core.conn()?;
                    state::bind(
                        &conn,
                        &state::Bound {
                            path: want.clone(),
                            item_id: item.id.clone(),
                            identity: None,
                            content_hash: hash.clone(),
                            written_hash: Some(hash),
                            links: wrote,
                            declined,
                            edit_line: None,
                        },
                    )?;
                    state::journal_clear(&conn, &want)?;
                    taken.insert(want);
                    report.unchanged += 1;
                    continue;
                }
                report.unwritten += 1;
                continue;
            }
            if !taken.insert(want.clone()) {
                report.collided += 1;
                continue;
            }

            if let Some(bound) = &bound
                && bound.path != want
            {
                // Unbound even where not removed: a bound path the walk cannot
                // reach is journaled and deleted.
                if plainly_inside(&self.root, &bound.path) {
                    let _ = std::fs::remove_file(self.root.join(&bound.path));
                }
                let conn = self.core.conn()?;
                state::unbind(&conn, &bound.path)?;
                state::journal_clear(&conn, &bound.path)?;
                report.moved += 1;
            }

            // Written over an edit still waiting, the line it writes is spent
            // too, since the file holds that edit (`folders.md` 17, 18).
            let spent = bound.as_ref().and_then(|bound| bound.edit_line);
            let edit_line = if carries_frontmatter(Path::new(&want))
                && crate::store::item_waits(&*self.core.conn()?, &item.id)?
            {
                Some(spent.unwrap_or(0).max(item.version))
            } else {
                spent
            };
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    CoreError::Store(format!("cannot make {}: {error}", parent.display()))
                })?;
            }
            {
                let conn = self.core.conn()?;
                state::bind(
                    &conn,
                    &state::Bound {
                        path: want.clone(),
                        item_id: item.id.clone(),
                        identity: None,
                        content_hash: hash.clone(),
                        written_hash: Some(hash.clone()),
                        links: wrote.clone(),
                        declined: declined.clone(),
                        edit_line,
                    },
                )?;
                // Counted, because one row this clears can be a person's own
                // delete still inside its grace.
                if state::journaled(&conn)?
                    .iter()
                    .any(|(path, _, _)| path == &want)
                {
                    report.revived += 1;
                }
                state::journal_clear(&conn, &want)?;
            }
            if let Err(error) = std::fs::write(&path, &bytes) {
                // Bound first, so it must come out again, or the scan would
                // take bytes that never landed as the folder's own.
                let conn = self.core.conn()?;
                state::unbind(&conn, &want)?;
                return Err(CoreError::Store(format!(
                    "cannot write {}: {error}",
                    path.display()
                )));
            }
            // Read after the write, because the file did not exist until now.
            if let Ok(metadata) = std::fs::symlink_metadata(&path)
                && let Some(found) = identity::of(&metadata)
            {
                let conn = self.core.conn()?;
                state::bind(
                    &conn,
                    &state::Bound {
                        path: want,
                        item_id: item.id.clone(),
                        identity: Some(found.key()),
                        content_hash: hash.clone(),
                        written_hash: Some(hash),
                        links: wrote,
                        declined,
                        edit_line,
                    },
                )?;
            }
            if bound.is_none() {
                report.written += 1;
            } else {
                report.rewritten += 1;
            }
        }
        self.remove_departed(&visited, &mut report)?;
        Ok(report)
    }

    /// Takes away the file of an item the pull no longer writes, where its
    /// bytes are the folder's own; nothing is journaled (`folders.md` 26).
    fn remove_departed(&self, visited: &HashSet<String>, report: &mut PullReport) -> Result<()> {
        let bound = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        for row in bound {
            if visited.contains(&row.item_id) {
                continue;
            }
            let path = self.root.join(&row.path);
            match std::fs::read(&path) {
                Ok(found) if row.written_hash.as_deref() != Some(state::hash(&found).as_str()) => {
                    report.kept += 1;
                    continue;
                }
                Ok(_) => {
                    if plainly_inside(&self.root, &row.path) {
                        std::fs::remove_file(&path).map_err(|error| {
                            CoreError::Store(format!("cannot remove {}: {error}", path.display()))
                        })?;
                    }
                }
                Err(_) => {}
            }
            let conn = self.core.conn()?;
            state::unbind(&conn, &row.path)?;
            state::journal_clear(&conn, &row.path)?;
            report.removed += 1;
        }
        Ok(())
    }

    /// Whether a file differs from its item's render in its version line
    /// alone, with no edit of its own landed since (`folders.md` 18).
    fn behind_by_its_line_alone(
        &self,
        item: &Item,
        bound: &state::Bound,
        declined: &[String],
    ) -> Result<bool> {
        if !carries_frontmatter(Path::new(&bound.path)) {
            return Ok(false);
        }
        let Ok(found) = std::fs::read_to_string(self.root.join(&bound.path)) else {
            return Ok(false);
        };
        let line = line_of(&document::read(&found).properties);
        // A line no newer than the one its own edit spent is rewritten once
        // that edit lands.
        if bound
            .edit_line
            .is_some_and(|spent| line.unwrap_or(0) <= spent)
            && !crate::store::item_waits(&*self.core.conn()?, &item.id)?
        {
            return Ok(false);
        }
        let (text, _) = self.render(item, declined, true, line)?;
        Ok(state::hash(text.as_bytes()) == bound.content_hash)
    }

    /// Where an item's file goes: the file it has, or else its title.
    fn path_for(&self, item: &Item, bound: Option<&state::Bound>, catalog: &Catalog) -> String {
        if let Some(bound) = bound {
            return bound.path.clone();
        }
        let title = item
            .properties
            .get(document::TITLE_FIELD)
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(&item.id);
        // A file item's title is a file's name already, extension and all.
        if bytes_of(item, catalog).is_some() {
            safe_name(title)
        } else {
            format!("{}.md", safe_name(title))
        }
    }

    /// An item as a file's bytes and its body's link targets, with the id and
    /// version line where the file carries frontmatter (`folders.md` 8, 17).
    fn render(
        &self,
        item: &Item,
        declined: &[String],
        frontmatter: bool,
        line: Option<i64>,
    ) -> Result<(String, Vec<String>)> {
        let mut body = item
            .properties
            .get(document::BODY_FIELD)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let held = document::links(&body);
        // The targets of the links in the file, whether the body carried them
        // already or this adds them, for `folders.md` 23.
        let mut wrote = Vec::new();
        for edge in self.core.edges_from(&item.id)? {
            let target = {
                let conn = self.core.conn()?;
                state::bound_to_item(&conn, &edge.target_id)?
                    .map(|bound| bound.path)
                    .unwrap_or_else(|| edge.target_id.clone())
            };
            let name = target.strip_suffix(".md").unwrap_or(&target).to_string();
            if held.iter().any(|link| link == &name || link == &target) {
                wrote.push(edge.target_id.clone());
                continue;
            }
            // A bare id the person could delete and the pull would write back.
            if self.core.get(&edge.target_id)?.is_none() {
                continue;
            }
            if edge.edge_type != LINK_EDGE && declined.contains(&edge.target_id) {
                continue;
            }
            wrote.push(edge.target_id.clone());
            if !body.ends_with('\n') && !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&document::render_link(&name));
            body.push('\n');
        }
        if !frontmatter {
            return Ok((body, wrote));
        }
        let mut properties = item.properties.clone();
        properties.insert(ID_FIELD.into(), Value::String(item.id.clone()));
        if let Some(line) = line {
            properties.insert(VERSION_FIELD.into(), Value::from(line));
        }
        properties.insert(document::BODY_FIELD.into(), Value::String(body));
        Ok((document::write(&properties)?, wrote))
    }
}

/// A file whose links the scan could not all resolve on the way past,
/// asked again once every file is bound (`folders.md` 25).
struct Unresolved {
    path: String,
    item_id: String,
    links: Vec<String>,
    had: Vec<String>,
    declined: Vec<String>,
}

/// The extension of a path, lowercased.
fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
}

/// Whether a file carries frontmatter, and with it a `marfa_id`: a Markdown
/// file (`folders.md` 8).
fn carries_frontmatter(path: &Path) -> bool {
    matches!(extension_of(path).as_deref(), Some("md" | "markdown"))
}

/// Whether a file is a document, which a folder reads as an item's fields
/// rather than sending as bytes (`folders.md` 21).
fn is_document(path: &Path) -> bool {
    carries_frontmatter(path) || extension_of(path).as_deref() == Some("txt")
}

/// The hash a file item names its bytes by: an item of a file type carrying
/// a `blob_ref`, whose file is those bytes rather than a document.
fn bytes_of<'a>(item: &'a Item, catalog: &Catalog) -> Option<&'a str> {
    if !catalog.matches(FILE_TYPE, &item.r#type) {
        return None;
    }
    item.properties.get("blob_ref").and_then(Value::as_str)
}

/// The type every file item is, with its subtree.
const FILE_TYPE: &str = "core.file";

/// The kind of edge a link becomes, and the only kind a folder removes.
pub const LINK_EDGE: &str = "references";

/// The frontmatter field that names the item a Markdown file is.
pub const ID_FIELD: &str = "marfa_id";

/// The frontmatter field that names the version a Markdown file was written
/// from, which an edit from it is based on (`folders.md` 17).
pub const VERSION_FIELD: &str = "marfa_version";

/// The version a file's line names, where it is one the server could have
/// minted (`versions.md` 18).
fn line_of(header: &Map<String, Value>) -> Option<i64> {
    header
        .get(VERSION_FIELD)
        .and_then(Value::as_i64)
        .filter(|line| *line > 0)
}

/// What a folder's catch-up did: a catch-up from the cursor or, where the
/// log had aged past it, a fresh hydration.
#[derive(Debug, Clone, Serialize)]
pub struct CaughtUp {
    pub caught_up: Option<crate::model::CatchUpReport>,
    pub hydrated: Option<crate::model::HydrateReport>,
}

/// What a pull did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PullReport {
    pub written: usize,
    pub rewritten: usize,
    pub moved: usize,
    pub unchanged: usize,
    pub skipped: usize,
    /// File items whose bytes could not be had (`folders.md` 29).
    pub absent: usize,
    /// Files the pull would not write over: one the person changed since
    /// the folder last wrote it, and one at a path the mapping does not hold.
    pub unwritten: usize,
    /// Journal rows cleared by writing the file back, a person's own delete
    /// inside its grace among them.
    pub revived: usize,
    /// Items whose file would land outside the folder (`folders.md` 22).
    pub outside: usize,
    /// Items whose path another item in the same pass had already taken.
    pub collided: usize,
    /// Files of items that left the slice, taken away (`folders.md` 26).
    pub removed: usize,
    /// Files of items that left the slice, kept because the person changed
    /// them.
    pub kept: usize,
}

/// A file's frontmatter as a write's properties, without `marfa_id` and
/// `marfa_version`, which name the item and version rather than fields.
fn sendable(mut properties: Map<String, Value>) -> Map<String, Value> {
    // `shift_remove`: `remove` moves the last field into the hole, which
    // reorders the frontmatter (`folders.md` 5).
    properties.shift_remove(ID_FIELD);
    properties.shift_remove(VERSION_FIELD);
    properties
}

/// Whether every component of a path is a plain name inside the folder, with
/// no symlink on the way (`folders.md` 22). A guard, not a boundary: the write
/// resolves the path again.
fn plainly_inside(root: &Path, relative: &str) -> bool {
    let mut here = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return false;
        }
        here.push(part);
        if std::fs::symlink_metadata(&here).is_ok_and(|found| found.is_symlink()) {
            return false;
        }
    }
    true
}

/// A title as a file name, with the separators and the dot-lead taken out.
fn safe_name(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|glyph| match glyph {
            '/' | '\\' | ':' | '\0' => '-',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".into()
    } else {
        trimmed.to_string()
    }
}
