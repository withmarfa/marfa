//! A directory on a machine that holds, as files, what its search matches.
//!
//! A folder is a device like any other (`device.md`, `queue-and-verdicts.md`)
//! with a filesystem as its face. What is here is the translation between a
//! file and an item, and the state that translation keeps across a restart.

pub mod document;
pub mod fields;
pub mod identity;
mod placement;
pub mod settings;
mod settings_file;
pub mod state;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{BlockedReason, Draft, Edit, Item, ItemState, WriteKind};
use crate::{Core, Result, Server};

pub use fields::{ID_FIELD, Uncarried, VERSION_FIELD};
pub use placement::PLACEMENT_EDGE;
use placement::{beside, cleaned, path_of, suited};
pub use settings::{FOLDER_TYPE, Settings};
pub use settings_file::SettingsFileReport;

/// Where a folder keeps what is its own (`folders.md` 25).
pub const STATE_DIR: &str = ".marfa";

/// How long a missing file is journaled before it becomes a delete
/// (`folders.md` 20): the window in which the other half of a rename can
/// arrive.
pub const RENAME_GRACE: Duration = Duration::from_secs(5);

/// The folder's settings written out, the one file under `.marfa/` a folder
/// reads and watches (`folders.md` 1, 25).
pub const SETTINGS_FILE: &str = "folder.yaml";

/// A record of settings kept on this machine alone, which a folder refuses
/// (`folders.md` 1).
const OLD_RECORD: &str = "folder.json";

/// A directory, the `system.folder` it is bound to, and the device
/// underneath it.
pub struct Folder {
    root: PathBuf,
    folder: String,
    core: Core,
    /// The key the credential is, once asked.
    key: std::sync::OnceLock<placement::KeyState>,
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
    /// Files of a type the search does not hold, left alone.
    pub skipped: usize,
    /// Files bound to a row the copy lost, queued again as new items because
    /// they changed or moved (`folders.md` 36); counted in `created` too.
    pub requeued: usize,
    /// Files bound to a row the copy no longer holds and unchanged since, so
    /// nothing is sent for them (`folders.md` 36).
    pub lost: usize,
    /// Files this scan read and holds rather than sends (`folders.md` 9, 10).
    pub flagged: Vec<Flagged>,
}

/// A file the folder holds rather than sends, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Flagged {
    pub path: String,
    /// `unreadable` for frontmatter that does not parse as an item's, and
    /// `refused` for an edit the server or this copy would not take.
    pub flag: &'static str,
    pub reason: String,
}

impl Flagged {
    fn of(path: &str, held: &str) -> Flagged {
        let (flag, reason) = match held.strip_prefix(state::UNREADABLE) {
            Some(reason) => ("unreadable", reason),
            None => ("refused", held.strip_prefix(state::REFUSED).unwrap_or(held)),
        };
        Flagged {
            path: path.to_string(),
            flag,
            reason: reason.to_string(),
        }
    }
}

impl Folder {
    /// Binds a directory to the `system.folder` whose settings it follows,
    /// read from the server now. The directory need not exist
    /// (`folders.md` 5).
    pub fn add(root: impl AsRef<Path>, folder: &str, server: Option<Server>) -> Result<Folder> {
        let server = server.ok_or(CoreError::NoServer)?;
        let root = root.as_ref().to_path_buf();
        let state = root.join(STATE_DIR);
        // A refused add leaves only what was there before it.
        let made = if !root.exists() {
            Some(root.clone())
        } else if !state.exists() {
            Some(state.clone())
        } else {
            None
        };
        std::fs::create_dir_all(&state).map_err(|error| {
            CoreError::Store(format!("cannot make {}: {error}", state.display()))
        })?;
        let added = Folder::bind(root, folder, server);
        if added.is_err()
            && let Some(made) = made
        {
            let _ = std::fs::remove_dir_all(made);
        }
        added
    }

    fn bind(root: PathBuf, folder: &str, server: Server) -> Result<Folder> {
        let state = root.join(STATE_DIR);
        let core = Core::open(state.join("core.sqlite"), Some(server))?;
        if let Some(bound) = settings_file::bound(&core)?
            && bound != folder
        {
            return Err(CoreError::Invalid(format!(
                "{} already follows the folder {bound}; a directory follows one",
                root.display()
            )));
        }
        let added = Folder {
            root,
            folder: folder.to_string(),
            core,
            key: std::sync::OnceLock::new(),
        };
        let row = added.row_on_server()?;
        // The catalog the hydration would read, so a default type the
        // search does not hold is refused before anything is bound.
        {
            let types = added.core.http()?.types()?;
            let conn = added.core.conn()?;
            crate::store::replace_types(&conn, &types)?;
            Settings::of_wire(&row.item)?.check_types(&Catalog::load(&conn)?)?;
        }
        // A key that cannot place its files would lay the folder out on this
        // machine alone; a credential that is not a key is not asked.
        if let Some(key) = added.core.http()?.current_key()?
            && !placement::places(&key)
        {
            return Err(CoreError::Forbidden {
                code: "edge_permission_denied".into(),
                message: format!(
                    "this key cannot write the {PLACEMENT_EDGE} edges that say where each file sits, so the folder cannot place its files: it needs `edge.{PLACEMENT_EDGE}:write`"
                ),
            });
        }
        settings_file::bind(&added.core, folder)?;
        added.write_settings_file(&row.item.properties, row.item.version)?;
        let old = state.join(OLD_RECORD);
        if old.exists() {
            std::fs::remove_file(&old).map_err(|error| {
                CoreError::Store(format!("cannot remove {}: {error}", old.display()))
            })?;
        }
        Ok(added)
    }

    /// Opens a directory somebody has already made a folder.
    pub fn open(root: impl AsRef<Path>, server: Option<Server>) -> Result<Folder> {
        let root = root.as_ref().to_path_buf();
        let state = root.join(STATE_DIR);
        // Refused, never read: settings kept on one machine are ones no other
        // machine sees change (`folders.md` 1).
        if state.join(OLD_RECORD).exists() {
            return Err(CoreError::Invalid(format!(
                "{dir} keeps its settings on this machine, and a folder's settings live in a {FOLDER_TYPE} on the server: make one with `folders create` and add the folder again with `folders add {dir} --folder <id>`",
                dir = root.display()
            )));
        }
        let not_a_folder = || {
            CoreError::Invalid(format!(
                "{} is not a folder; `folders add` makes one",
                root.display()
            ))
        };
        if !state.join("core.sqlite").exists() {
            return Err(not_a_folder());
        }
        let core = Core::open(state.join("core.sqlite"), server)?;
        let folder = settings_file::bound(&core)?.ok_or_else(not_a_folder)?;
        Ok(Folder {
            root,
            folder,
            core,
            key: std::sync::OnceLock::new(),
        })
    }

    /// The id of the `system.folder` this directory follows.
    pub fn folder_id(&self) -> &str {
        &self.folder
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The settings every pass reads: the folder's row in the copy, pinned
    /// so catch-up keeps it current (`folders.md` 1).
    pub fn settings(&self) -> Result<Settings> {
        match self.core.get(&self.folder)? {
            Some(item) => {
                let settings = Settings::of(&item)?;
                settings.check_types(&Catalog::load(&*self.core.conn()?)?)?;
                Ok(settings)
            }
            None => Err(CoreError::Invalid(format!(
                "this folder's copy does not hold its settings, the {FOLDER_TYPE} {}; hydrate it again with a key holding `{FOLDER_TYPE}:read`",
                self.folder
            ))),
        }
    }

    /// The folder's row as the server holds it now, refused where its
    /// settings are not ones this folder can follow.
    fn row_on_server(&self) -> Result<crate::wire::WireItemWithMetadata> {
        let read = crate::hydrate::read_with_edges(self.core.http()?, &self.folder).map_err(
            |error| match error {
                CoreError::Forbidden { code, .. } if code == "type_not_permitted" => {
                    CoreError::Forbidden {
                        code,
                        message: format!(
                            "this key cannot read {FOLDER_TYPE}, so the folder cannot follow its settings: it needs `{FOLDER_TYPE}:read`"
                        ),
                    }
                }
                other => other,
            },
        )?;
        let Some((row, _)) = read else {
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message: format!(
                    "the server holds no folder {}; `folders create` makes one",
                    self.folder
                ),
            });
        };
        Settings::read(
            &row.item.id,
            &row.item.r#type,
            &row.item.state,
            &row.item.properties,
        )?;
        Ok(row)
    }

    /// Hydrates the slice the folder's search needs, with its settings
    /// pinned so every hydration and catch-up keeps them.
    pub fn hydrate(&self) -> Result<crate::model::HydrateReport> {
        let row = self.row_on_server()?;
        let settings = Settings::of_wire(&row.item)?;
        self.core.lock.refuse_unless_writer()?;
        crate::store::pin(&*self.core.conn()?, &self.folder)?;
        self.core.hydrate_every_type_or(
            settings.types(),
            settings.tier(),
            &settings.whole_edge_types(),
        )
    }

    /// Hydrates where the copy cannot answer: never hydrated, cut short, or
    /// its cursor aged out (`device.md` 4); or where the settings now ask
    /// for another slice. `None` where it can.
    pub fn resume(&self) -> Result<Option<crate::model::HydrateReport>> {
        if crate::store::hydrated(&*self.core.conn()?)? && !self.slice_moved()? {
            return Ok(None);
        }
        self.hydrate().map(Some)
    }

    /// Whether the settings ask for a slice other than the one the copy
    /// holds. Settings the copy cannot read count as moved, so the
    /// hydration that follows says why.
    fn slice_moved(&self) -> Result<bool> {
        let Ok(settings) = self.settings() else {
            return Ok(true);
        };
        let conn = self.core.conn()?;
        let Some((types, tier)) = crate::store::slice(&conn)? else {
            return Ok(true);
        };
        let held: HashSet<&str> = types.iter().map(String::as_str).collect();
        let asked: HashSet<&str> = if settings.types().is_empty() {
            HashSet::from([crate::store::EVERY_TYPE])
        } else {
            settings.types().iter().map(|name| name.trim()).collect()
        };
        let whole: HashSet<String> = crate::store::whole_edge_types(&conn)?.into_iter().collect();
        let wanted: HashSet<String> = settings.whole_edge_types().into_iter().collect();
        Ok(held != asked || tier != settings.tier() || whole != wanted)
    }

    /// Takes in what the server has recorded since the copy's cursor, or
    /// hydrates again where the log has aged past it (`device.md` 16).
    pub fn catch_up(&self) -> Result<CaughtUp> {
        match self.core.catch_up() {
            // Settings changed elsewhere can ask for another slice.
            Ok(report) if self.slice_moved()? => Ok(CaughtUp {
                caught_up: Some(report),
                hydrated: Some(self.hydrate()?),
            }),
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
    /// are excluded at any depth, `.marfa/` with them (`folders.md` 24, 25).
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
    /// three (`folders.md` 16).
    mark: Option<String>,
    born: Option<u128>,
    /// The `marfa_id` a Markdown file's frontmatter carries.
    id: Option<String>,
    /// The version its `marfa_version` line names, where that is one the
    /// server could have minted.
    line: Option<i64>,
    /// Why its frontmatter cannot be read as an item's, where it cannot.
    unreadable: Option<String>,
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
    /// too, so one rule decides identity (`folders.md` 17).
    pub fn scan(&self) -> Result<ScanReport> {
        let mut report = ScanReport::default();
        let settings = self.settings()?;
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
            if self.pushes(path, &settings, &catalog) {
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
            // No blob the server holds is empty (`folders.md` 34).
            if bytes.is_empty() && !is_document(&path) {
                report.skipped += 1;
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let read = carries_frontmatter(&path).then(|| document::read(&text));
            let unreadable = read.as_ref().and_then(|read| {
                read.unreadable
                    .clone()
                    .or_else(|| fields::read(&read.front).err())
            });
            // An unreadable file still names its item, so a move keeps it.
            let id = match &read {
                Some(read) if read.unreadable.is_some() => document::id_line(&text),
                Some(read) => read
                    .front
                    .get(ID_FIELD)
                    .and_then(Value::as_str)
                    .map(str::to_string),
                None => None,
            };
            let line = read
                .as_ref()
                .filter(|read| read.unreadable.is_none())
                .and_then(|read| line_of(&read.front));
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
                unreadable,
                path,
            });
        }
        let snapshot = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        let claims = self.claim(&files, &snapshot, &catalog)?;
        let withheld = self.withheld()?;
        let mut unresolved: Vec<Unresolved> = Vec::new();

        for (file, claim) in files.iter().zip(claims) {
            if let Some(reason) = &file.unreadable {
                self.hold_unreadable(file, claim.as_ref(), reason, &withheld)?;
                report.flagged.push(Flagged::of(
                    &file.key,
                    &format!("{}{reason}", state::UNREADABLE),
                ));
                continue;
            }
            // A binding to a row the copy no longer holds binds nothing
            // (`folders.md` 36).
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
                    match self.queue_create(
                        file,
                        &settings,
                        &catalog,
                        &withheld,
                        &mut unresolved,
                    )? {
                        Some(flagged) => report.flagged.push(flagged),
                        None => report.created += 1,
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
                        &catalog,
                        &mut unresolved,
                        &mut report.flagged,
                    )? {
                        report.updated += 1;
                    } else {
                        report.unchanged += 1;
                    }
                    self.place(&item_id, &file.key, &withheld)?;
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
                    if self.queue_update(
                        &item_id,
                        Some(&bound),
                        file,
                        &catalog,
                        &mut unresolved,
                        &mut report.flagged,
                    )? {
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
                    self.queue_update(
                        &item_id,
                        Some(&bound),
                        file,
                        &catalog,
                        &mut unresolved,
                        &mut report.flagged,
                    )?;
                    self.place(&item_id, &file.key, &withheld)?;
                    report.renamed += 1;
                }
            }
        }

        // Every file is bound now, so a link naming one that arrived in the
        // same scan resolves (`folders.md` 30).
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
        // exactly like a delete (`folders.md` 20, 21).
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

    /// Which item each file is, or `None` for a new one (`folders.md` 12 to
    /// 16). Held ids decide first; then the binding by identity across every
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
            // stays that item's file (`folders.md` 14).
            if by_path
                .get(file.key.as_str())
                .is_some_and(|bound| bound.identity == file.mark && bound.item_id != id)
            {
                continue;
            }
            // A file item's file is its bytes, never a document naming it, and
            // no `system.*` row is a file's item.
            if self.core.get(id)?.is_some_and(|item| {
                bytes_of(&item, catalog).is_none() && !item.r#type.starts_with("system.")
            }) {
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

    /// Keeps an unreadable file bound where it now is, sending only a move's
    /// placement, so a pull leaves it and a move keeps its item (`folders.md` 10).
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
                queued: Vec::new(),
                ..bound.clone()
            },
        )?;
        state::journal_clear(&conn, &file.key)
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

    /// Whether this path is one the folder pushes (`folders.md` 26, 34): a
    /// document, or a file whose type the search holds.
    fn pushes(&self, path: &Path, settings: &Settings, catalog: &Catalog) -> bool {
        is_document(path) || self.file_type_of(path, settings, catalog).is_some()
    }

    /// The type a file that is not a document becomes, where the search
    /// holds it (`folders.md` 34).
    fn file_type_of(&self, path: &Path, settings: &Settings, catalog: &Catalog) -> Option<String> {
        if is_document(path) {
            return None;
        }
        let named = crate::blob::file_type_for(&crate::blob::mime_type_for(path, None), None);
        let file_type = if catalog.known(&named) {
            named
        } else {
            FILE_TYPE.to_string()
        };
        let types = settings.types();
        (types.is_empty()
            || types
                .iter()
                .any(|declared| catalog.matches(declared, &file_type)))
        .then_some(file_type)
    }

    /// Queues a file as a new item under an id the device mints (`folders.md`
    /// 12); one naming a type no document can be is flagged instead.
    fn queue_create(
        &self,
        file: &Scanned,
        settings: &Settings,
        catalog: &Catalog,
        withheld: &placement::Withheld,
        unresolved: &mut Vec<Unresolved>,
    ) -> Result<Option<Flagged>> {
        if let Some(file_type) = self.file_type_of(&file.path, settings, catalog) {
            self.queue_create_file(file, file_type, settings, catalog, withheld)?;
            return Ok(None);
        }
        let document = file.document();
        let read = fields::read(&document.front).unwrap_or_default();
        let r#type = read
            .lines
            .r#type
            .clone()
            .unwrap_or_else(|| settings.new_type(catalog));
        if let Some(reason) = unsuited_type(&r#type, catalog) {
            return Ok(Some(Flagged::of(
                &file.key,
                &format!("{}{reason}", state::REFUSED),
            )));
        }
        let mut properties = read.properties;
        properties.insert(
            fields::body_field(catalog, &r#type).into(),
            Value::String(document.body.clone()),
        );
        for (field, value) in &settings.defaults.properties {
            properties.entry(field.clone()).or_insert(value.clone());
        }
        properties
            .entry(fields::title_field(catalog, &r#type))
            .or_insert(Value::String(title_of(&file.key)));
        let draft = Draft {
            r#type,
            properties,
            tags: read
                .lines
                .tags
                .unwrap_or_else(|| settings.defaults.tags.clone()),
            tier: Some(read.lines.tier.unwrap_or_else(|| settings.new_tier())),
            ..Default::default()
        };
        let item_id = named_item(self.core.create_item(&draft)?, &file.key)?;
        let mut queued = Vec::new();
        if read.lines.state == Some(ItemState::Archived) {
            queued.push(self.core.transition_item(&item_id, ItemState::Archived)?.id);
        }
        // Before the links, so a link naming a default's target adds no
        // second edge.
        self.queue_default_edges(&item_id, settings)?;
        self.place(&item_id, &file.key, withheld)?;
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
        self.bind_scanned(
            file,
            &item_id,
            named,
            declined,
            Kept {
                queued,
                ..Kept::default()
            },
        )?;
        Ok(None)
    }

    /// A file that is not a document, as a file item: its bytes' upload, and
    /// the create waiting on it (`folders.md` 34). Its type is its bytes', so
    /// of the defaults it takes the tier, the tags and the edges.
    fn queue_create_file(
        &self,
        file: &Scanned,
        file_type: String,
        settings: &Settings,
        catalog: &Catalog,
        withheld: &placement::Withheld,
    ) -> Result<()> {
        let mut properties = Map::new();
        properties.insert(
            fields::title_field(catalog, &file_type).into(),
            Value::String(name_of(&file.key).into()),
        );
        let draft = Draft {
            r#type: file_type,
            properties,
            tags: settings.defaults.tags.clone(),
            tier: Some(settings.new_tier()),
            ..Default::default()
        };
        let item_id = named_item(self.core.create_file_item(&file.path, &draft)?, &file.key)?;
        self.queue_default_edges(&item_id, settings)?;
        self.place(&item_id, &file.key, withheld)?;
        self.bind_scanned(file, &item_id, Vec::new(), Vec::new(), Kept::default())
    }

    /// The defaults' edges for a new item. A `parent-of` default names the
    /// parent, as the child's file writes it, so a new file lands beneath
    /// what the search follows.
    fn queue_default_edges(&self, item_id: &str, settings: &Settings) -> Result<()> {
        for (edge_type, targets) in &settings.defaults.edges {
            for target in targets {
                let (source_id, target_id) = if edge_type == crate::filter::PARENT_OF {
                    (target.clone(), item_id.to_string())
                } else {
                    (item_id.to_string(), target.clone())
                };
                self.core.create_edge(&crate::model::EdgeDraft {
                    source_id,
                    target_id,
                    edge_type: edge_type.clone(),
                    ..Default::default()
                })?;
            }
        }
        Ok(())
    }

    /// Queues what a file holds as an edit of its item, whole only where its
    /// version line is the copy's (`folders.md` 7); `bound` is `None` if unbound.
    fn queue_update(
        &self,
        item_id: &str,
        bound: Option<&state::Bound>,
        file: &Scanned,
        catalog: &Catalog,
        unresolved: &mut Vec<Unresolved>,
        flagged: &mut Vec<Flagged>,
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
            return self.queue_update_file(bound, file, &held, catalog);
        }
        let had = bound.map(|bound| bound.links.clone()).unwrap_or_default();
        let declined = bound
            .map(|bound| bound.declined.clone())
            .unwrap_or_default();
        let document = file.document();
        let read = fields::read(&document.front).unwrap_or_default();
        let mut edit_line = bound.and_then(|bound| bound.edit_line);
        // Bytes set aside in a conflicted copy against this device's own
        // earlier save go on the version they were read at (`folders.md` 37).
        let untaken = bound.and_then(|bound| state::untaken_read_version(&bound.content_hash));
        let standing = match file.line {
            _ if untaken.is_some() => Standing::Spent,
            Some(line) if line == held.version => Standing::Current,
            // Behind only by the file's own edit, which it holds (`folders.md` 22).
            Some(line) if line < held.version && edit_line.is_some_and(|spent| line <= spent) => {
                Standing::Spent
            }
            Some(line) if line < held.version => Standing::Behind(line),
            _ => Standing::Lineless,
        };
        let whole = standing == Standing::Current;
        let own = own_changes(&read.lines, standing, &held, bound, file.line);
        if let Some(reason) = &own.flag {
            flagged.push(Flagged {
                path: file.key.clone(),
                flag: "behind",
                reason: reason.clone(),
            });
        }
        let changes = own.changes;
        let mut properties = read.properties;
        let body = Value::String(document.body.clone());
        let into = fields::body_field(catalog, changes.r#type.as_deref().unwrap_or(&held.r#type));
        let from = fields::body_field(catalog, &held.r#type);
        if into != from {
            // A retype drops no text: the file's line for the new body field
            // wins where it holds any, and the old body field keeps the body.
            if properties.get(into).is_none_or(blank) {
                properties.insert(into.into(), body.clone());
            }
            properties.insert(from.into(), body);
        } else {
            properties.insert(into.into(), body);
        }
        if whole {
            // No file can carry these, so leaving them out is no clear.
            for (field, value) in &held.properties {
                if fields::reserved(field) {
                    properties.insert(field.clone(), value.clone());
                }
            }
        }
        let unchanged = if whole {
            properties == held.properties
        } else {
            properties
                .iter()
                .all(|(field, value)| held.properties.get(field) == Some(value))
        };
        // A save that changes nothing the item holds, a reformatting or only
        // the id or version line, sends nothing.
        let in_step = unchanged && changes.is_empty()
            || bound.is_some_and(|bound| bound.content_hash == file.hash);
        let mut queued = Vec::new();
        if !in_step {
            if let Some(reason) = changes
                .r#type
                .as_deref()
                .and_then(|to| unsuited_type(to, catalog))
            {
                let held_for = format!("{}{reason}", state::REFUSED);
                flagged.push(Flagged::of(&file.key, &held_for));
                return self
                    .bind_held(file, item_id, bound, held_for)
                    .map(|()| false);
            }
            // Tags and a state are writes of their own, and need no edit.
            if !unchanged || changes.r#type.is_some() || changes.tier.is_some() {
                let read_at = untaken.or(match standing {
                    Standing::Behind(line) => Some(line),
                    _ => None,
                });
                let edit = Edit {
                    properties,
                    base_version: Some(read_at.unwrap_or(held.version)),
                    r#type: changes.r#type.clone(),
                    tier: changes.tier,
                    replace_properties: whole,
                    ..Edit::default()
                };
                queued.push(if read_at.is_some() {
                    self.core.update_item_as_read(item_id, &edit)?.id
                } else {
                    self.core.update_item(item_id, &edit)?.id
                });
                edit_line = Some(edit_line.unwrap_or(0).max(file.line.unwrap_or(0)));
            }
            for tag in &changes.added {
                queued.push(self.core.add_tag(item_id, tag)?.id);
            }
            for tag in &changes.removed {
                queued.push(self.core.remove_tag(item_id, tag)?.id);
            }
            if let Some(state) = changes.state {
                queued.push(self.core.transition_item(item_id, state)?.id);
            }
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
        self.bind_scanned(
            file,
            item_id,
            named,
            declined,
            Kept {
                edit_line,
                own: own.base,
                held: None,
                queued,
            },
        )?;
        Ok(!in_step)
    }

    /// Binds a file whose bytes are held rather than sent, where it sits.
    fn bind_held(
        &self,
        file: &Scanned,
        item_id: &str,
        bound: Option<&state::Bound>,
        held: String,
    ) -> Result<()> {
        let links = bound.map(|bound| bound.links.clone()).unwrap_or_default();
        let declined = bound
            .map(|bound| bound.declined.clone())
            .unwrap_or_default();
        let kept = Kept {
            edit_line: bound.and_then(|bound| bound.edit_line),
            own: bound.and_then(|bound| bound.own.clone()),
            held: Some(held),
            queued: Vec::new(),
        };
        self.bind_scanned(file, item_id, links, declined, kept)
    }

    /// New bytes are an upload and an update naming them; a move carries the
    /// new name as the title where the old name was it (`folders.md` 34).
    fn queue_update_file(
        &self,
        bound: &state::Bound,
        file: &Scanned,
        held: &Item,
        catalog: &Catalog,
    ) -> Result<bool> {
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
        let title = fields::title_field(catalog, &held.r#type);
        if old_name != new_name
            && held.properties.get(title).and_then(Value::as_str) == Some(old_name)
        {
            edit.properties
                .insert(title.into(), Value::String(new_name.into()));
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
        self.bind_scanned(file, &held.id, Vec::new(), Vec::new(), Kept::default())?;
        Ok(queued)
    }

    /// Binds a file as the scan read it.
    fn bind_scanned(
        &self,
        file: &Scanned,
        item_id: &str,
        links: Vec<String>,
        declined: Vec<String>,
        kept: Kept,
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
                edit_line: kept.edit_line,
                held: kept.held,
                own: kept.own,
                queued: kept.queued,
            },
        )
    }

    /// Links in the body become edges, and a lost link takes its edge
    /// (`folders.md` 11, 28). Answers the targets named, the targets declined
    /// (`folders.md` 33), and whether every link resolved.
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
    /// version the copy holds (`folders.md` 22).
    pub rebased: usize,
    /// Placements another machine made first, withdrawn for the server's
    /// (`folders.md` 18).
    pub gave_way: usize,
}

impl Folder {
    /// Sends what the queue holds, and each edit whose base the server no
    /// longer holds again on the version the copy holds (`folders.md` 22).
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
        let gave_way = self.settle_placements(&mut report)?;
        self.hold_refused(&report)?;
        Ok(Drained {
            report,
            rebased,
            gave_way,
        })
    }

    /// Holds a file whose bytes made a write the server refused, so the pull
    /// leaves the person's text as it is (`folders.md` 9).
    fn hold_refused(&self, report: &crate::DrainReport) -> Result<()> {
        let queue = self.core.queue()?;
        for verdict in &report.verdicts {
            let from_file = matches!(
                verdict.kind,
                WriteKind::UpdateItem
                    | WriteKind::TransitionItem
                    | WriteKind::AddTag
                    | WriteKind::RemoveTag
            );
            let reason = match verdict.verdict {
                Some(crate::model::Verdict::Refused) if from_file => {
                    let code = verdict.reason.clone().unwrap_or_default();
                    let message = queue
                        .iter()
                        .find(|row| row.id == verdict.id)
                        .and_then(|row| row.answer.as_deref())
                        .and_then(|answer| serde_json::from_str::<Value>(answer).ok())
                        .and_then(|answer| answer["error"]["message"].as_str().map(str::to_string));
                    match message {
                        Some(message) => format!("{}{code}: {message}", state::REFUSED),
                        None => format!("{}{code}", state::REFUSED),
                    }
                }
                _ => continue,
            };
            state::hold_for(&*self.core.conn()?, &verdict.id, &reason)?;
        }
        Ok(())
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
    /// Writes what the search matches out as files (`folders.md` 2 and 6),
    /// each where its placement says (`folders.md` 18) and bound before its
    /// bytes land so the scan never reads it back (`folders.md` 19).
    pub fn pull(&self) -> Result<PullReport> {
        let mut report = PullReport::default();
        let settings = self.settings()?;
        let members = self.members(&settings)?;
        let items = self.core.list(
            &crate::model::ListFilters {
                tier: Some(settings.tier()),
                all_states: true,
                ..Default::default()
            },
            crate::model::Sort::default(),
        )?;
        let catalog = {
            let conn = self.core.conn()?;
            Catalog::load(&conn)?
        };
        let bound_items: HashSet<String> = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
                .into_iter()
                .map(|bound| bound.item_id)
                .collect()
        };
        let mut work: Vec<(Item, bool)> = Vec::new();
        for item in items {
            if members.contains(&item.id) {
                work.push((item, false));
            } else if !bound_items.contains(&item.id) && item.r#type != FOLDER_TYPE {
                report.skipped += 1;
            }
        }
        // A bound file whose item left the search, but not by state or the
        // bin, is kept current as a member's is and flagged; it never gets a
        // new file (`folders.md` 32).
        let outside: Vec<String> = bound_items
            .into_iter()
            .filter(|id| !members.contains(id))
            .collect();
        let held = crate::store::items_by_ids(&*self.core.conn()?, &outside)?;
        work.extend(
            held.into_iter()
                .filter(|item| settings.holds_state(item.state))
                .map(|item| (item, true)),
        );
        let withheld = self.withheld()?;
        report.unplaced = withheld.len();
        let mut placing: Vec<Placing> = Vec::new();
        for (item, unmatched) in &work {
            if *unmatched {
                report.unmatched += 1;
            }
            // This device's own create, not yet landed: the id goes back
            // only once it has (`folders.md` 12).
            if item.version == 0 {
                continue;
            }
            let bound = {
                let conn = self.core.conn()?;
                state::bound_to_item(&conn, &item.id)?
            };
            // Bytes the server or this copy did not take are the person's to
            // mend, so the file stays as they wrote it (`folders.md` 9, 10).
            if bound.as_ref().is_some_and(|bound| bound.held.is_some()) {
                continue;
            }
            let placed = self.placement(&item.id)?;
            let Some(want) = self
                .path_for(
                    item,
                    placed.as_ref(),
                    bound.as_ref(),
                    &withheld,
                    &settings,
                    &catalog,
                )
                .filter(|want| plainly_inside(&self.root, want))
            else {
                report.outside += 1;
                continue;
            };
            if !suited(item, &want, &catalog) {
                report.unsuited += 1;
                continue;
            }
            let rank = match &placed {
                Some(edge) => placement::rank_of(edge),
                None => {
                    placement::unplaced_rank(bound.as_ref().is_some_and(|bound| bound.path == want))
                }
            };
            placing.push(Placing {
                item,
                bound,
                want,
                rank,
            });
        }
        // Ranked by what the server holds, so every machine gives a shared
        // path to the same item; stable, so the listing orders the rest.
        placing.sort_by(|a, b| a.rank.cmp(&b.rank));
        let wanted: HashSet<String> = placing.iter().map(|entry| entry.want.clone()).collect();
        let mut taken: HashSet<String> = HashSet::new();
        for entry in &mut placing {
            if taken.contains(&entry.want) {
                let own = entry.bound.as_ref().map(|bound| bound.path.as_str());
                let free = |candidate: &str| {
                    !taken.contains(candidate)
                        && plainly_inside(&self.root, candidate)
                        && (own == Some(candidate)
                            || !wanted.contains(candidate) && !self.root.join(candidate).exists())
                };
                entry.want = beside(&entry.want, |candidate| !free(candidate));
                report.beside += 1;
            }
            taken.insert(entry.want.clone());
        }
        // Paths whose file moves away in this pass: an item wanting one waits
        // until it has.
        let leaving: HashSet<String> = placing
            .iter()
            .filter_map(|entry| {
                entry
                    .bound
                    .as_ref()
                    .filter(|bound| bound.path != entry.want)
            })
            .map(|bound| bound.path.clone())
            .collect();
        let mut waiting = Vec::new();
        for entry in placing {
            if self.write_placed(&entry, &catalog, &withheld, Some(&leaving), &mut report)? {
                waiting.push(entry);
            }
        }
        for entry in waiting {
            self.write_placed(&entry, &catalog, &withheld, None, &mut report)?;
        }
        self.remove_departed(&members, &settings, &mut report)?;
        report.flagged = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
                .into_iter()
                .filter_map(|bound| Some(Flagged::of(&bound.path, bound.held.as_deref()?)))
                .collect()
        };
        report.uncarried =
            fields::uncarried(&catalog, |r#type| settings.holds_type(&catalog, r#type));
        report.settings = self.write_settings_if_moved()?;
        Ok(report)
    }

    /// Writes one item's file where its pull placed it, and answers whether
    /// it waits for the file at that path to move away first.
    fn write_placed(
        &self,
        entry: &Placing<'_>,
        catalog: &Catalog,
        withheld: &placement::Withheld,
        leaving: Option<&HashSet<String>>,
        report: &mut PullReport,
    ) -> Result<bool> {
        let Placing {
            item, bound, want, ..
        } = entry;
        let (item, want) = (*item, want.clone());
        let path = self.root.join(&want);
        let declined: Vec<String> = bound
            .as_ref()
            .map(|bound| bound.declined.clone())
            .unwrap_or_default();
        let (bytes, wrote) = match bytes_of(item, catalog) {
            Some(blob) => {
                // A file already holding these bytes needs no fetch, a
                // file moving to its placement included.
                let on_disk = bound
                    .as_ref()
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
                                CoreError::Store(format!("cannot read {}: {error}", held.display()))
                            })?,
                            Vec::new(),
                        ),
                        // A refused credential refuses every file alike.
                        Err(error @ CoreError::Unauthorized { .. }) => return Err(error),
                        Err(_) => {
                            report.absent += 1;
                            return Ok(false);
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
                    catalog,
                )?;
                (text.into_bytes(), wrote)
            }
        };
        let hash = state::hash(&bytes);
        let ours = bound.as_ref().is_some_and(|bound| bound.path == want);

        // The bytes on the disk, not the mapping's memory of them: a file
        // changed since the scan read it is the person's (`folders.md` 29).
        let changed = |bound: &state::Bound| {
            std::fs::read(self.root.join(&bound.path))
                .is_ok_and(|found| state::hash(&found) != bound.content_hash)
        };
        // What this file's own-field lines say at this version, for an old
        // buffer of it saved later.
        let own = carries_frontmatter(Path::new(&want)).then(|| {
            fields::OwnBase::written(
                bound.as_ref().and_then(|bound| bound.own.as_ref()),
                item.version,
                fields::Own::of(item),
            )
        });
        let in_place = match &bound {
            Some(bound) if ours && bound.content_hash == hash => true,
            Some(bound) if changed(bound) => {
                report.unwritten += 1;
                return Ok(false);
            }
            Some(bound) if ours => {
                self.behind_by_its_line_alone(item, bound, &declined, catalog)?
            }
            _ => false,
        };
        // Something at the destination that is not this item's own file
        // (`folders.md` 29), unless it is byte for byte this item's render.
        let occupied = !in_place && !ours && path.exists();
        let rebound =
            occupied && bound.is_none() && std::fs::read(&path).is_ok_and(|found| found == bytes);
        if occupied && !rebound {
            if leaving.is_some_and(|leaving| leaving.contains(&want)) {
                return Ok(true);
            }
            report.unwritten += 1;
            return Ok(false);
        }
        if rebound {
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
                    held: None,
                    own,
                    queued: Vec::new(),
                },
            )?;
            state::journal_clear(&conn, &want)?;
            report.unchanged += 1;
            return Ok(false);
        }
        if in_place {
            report.placed += usize::from(self.place(&item.id, &want, withheld)?);
            report.unchanged += 1;
            return Ok(false);
        }

        // Written over an edit still waiting, the line it writes is spent
        // too, since the file holds that edit (`folders.md` 22, 23).
        let spent = bound.as_ref().and_then(|bound| bound.edit_line);
        let edit_line = if carries_frontmatter(Path::new(&want))
            && crate::store::item_waits(&*self.core.conn()?, &item.id)?
        {
            Some(spent.unwrap_or(0).max(item.version))
        } else {
            spent
        };
        let binding = |identity: Option<String>| state::Bound {
            path: want.clone(),
            item_id: item.id.clone(),
            identity,
            content_hash: hash.clone(),
            written_hash: Some(hash.clone()),
            links: wrote.clone(),
            declined: declined.clone(),
            edit_line,
            held: None,
            own: own.clone(),
            queued: Vec::new(),
        };
        // Bound before the write, so the scan never reads it back; a path the
        // filesystem refuses leaves the old file, and every other, as it was.
        state::bind(&*self.core.conn()?, &binding(None))?;
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, &bytes));
        if written.is_err() {
            state::unbind(&*self.core.conn()?, &want)?;
            report.unwritten += 1;
            return Ok(false);
        }
        {
            let conn = self.core.conn()?;
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
        report.placed += usize::from(self.place(&item.id, &want, withheld)?);
        // Read after the write, because the file did not exist until now.
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && let Some(found) = identity::of(&metadata)
        {
            state::bind(&*self.core.conn()?, &binding(Some(found.key())))?;
        }
        if bound.is_none() {
            report.written += 1;
        } else {
            report.rewritten += 1;
        }
        Ok(false)
    }

    /// The ids the search matches in the copy (`folders.md` 2), answered by
    /// the local list so the folder and a list read one grammar alike.
    fn members(&self, settings: &Settings) -> Result<HashSet<String>> {
        let types: Vec<Option<String>> = if settings.types().is_empty() {
            vec![None]
        } else {
            settings.types().iter().cloned().map(Some).collect()
        };
        let mut members = HashSet::new();
        for declared in types {
            let found = self.core.list(
                &crate::model::ListFilters {
                    r#type: declared,
                    tier: Some(settings.tier()),
                    all_states: true,
                    filter: settings.search.filter.clone(),
                    beneath: settings.search.beneath.clone(),
                    ..Default::default()
                },
                crate::model::Sort::default(),
            )?;
            members.extend(
                found
                    .into_iter()
                    .filter(|item| {
                        !item.r#type.starts_with("system.") && settings.holds_state(item.state)
                    })
                    .map(|item| item.id),
            );
        }
        Ok(members)
    }

    /// A file whose item the search no longer matches (`folders.md` 32). One
    /// that left by state or was trashed is taken away where its bytes are the
    /// folder's own, and nothing is journaled; any other stays, flagged
    /// `unmatched`.
    fn remove_departed(
        &self,
        members: &HashSet<String>,
        settings: &Settings,
        report: &mut PullReport,
    ) -> Result<()> {
        let bound = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        for row in bound {
            if members.contains(&row.item_id) {
                continue;
            }
            let held = {
                let conn = self.core.conn()?;
                crate::store::items_by_ids(&conn, std::slice::from_ref(&row.item_id))?.pop()
            };
            // A row the copy lost is the scan's to report (`folders.md` 36).
            let Some(item) = held else {
                continue;
            };
            if settings.holds_state(item.state) {
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
    /// alone, with no edit of its own landed since (`folders.md` 23).
    fn behind_by_its_line_alone(
        &self,
        item: &Item,
        bound: &state::Bound,
        declined: &[String],
        catalog: &Catalog,
    ) -> Result<bool> {
        if !carries_frontmatter(Path::new(&bound.path)) {
            return Ok(false);
        }
        let Ok(found) = std::fs::read_to_string(self.root.join(&bound.path)) else {
            return Ok(false);
        };
        let line = line_of(&document::read(&found).front);
        // A line no newer than the one its own edit spent is rewritten once
        // that edit lands.
        if bound
            .edit_line
            .is_some_and(|spent| line.unwrap_or(0) <= spent)
            && !crate::store::item_waits(&*self.core.conn()?, &item.id)?
        {
            return Ok(false);
        }
        let (text, _) = self.render(item, declined, true, line, catalog)?;
        Ok(state::hash(text.as_bytes()) == bound.content_hash)
    }

    /// Where an item's file goes (`folders.md` 18): where its placement says,
    /// or else the file it has, or else by its title under its type's first
    /// placement. `None` for a path the folder does not write.
    fn path_for(
        &self,
        item: &Item,
        placed: Option<&crate::model::Edge>,
        bound: Option<&state::Bound>,
        withheld: &placement::Withheld,
        settings: &Settings,
        catalog: &Catalog,
    ) -> Option<String> {
        // A placement the server refused never moved the file away from it.
        if let Some(bound) = bound
            && withheld.contains_key(&item.id)
        {
            return Some(bound.path.clone());
        }
        if let Some(placed) = placed {
            return path_of(placed).and_then(cleaned);
        }
        if let Some(bound) = bound {
            return Some(bound.path.clone());
        }
        let title = item
            .properties
            .get(fields::title_field(catalog, &item.r#type))
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(&item.id);
        // A file item's title is a file's name already, extension and all.
        let name = if bytes_of(item, catalog).is_some() {
            safe_name(title)
        } else {
            format!("{}.md", safe_name(title))
        };
        match settings.first_placement_for(&item.r#type, catalog) {
            Some(dir) => cleaned(&format!("{dir}/{name}")),
            None => Some(name),
        }
    }

    /// An item as a file's bytes and its body's link targets (`folders.md` 7,
    /// 12, 22); a property no file can carry is left out.
    fn render(
        &self,
        item: &Item,
        declined: &[String],
        frontmatter: bool,
        line: Option<i64>,
        catalog: &Catalog,
    ) -> Result<(String, Vec<String>)> {
        let body_field = fields::body_field(catalog, &item.r#type);
        let mut body = item
            .properties
            .get(body_field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let held = document::links(&body);
        // The targets of the links in the file, whether the body carried them
        // already or this adds them, for `folders.md` 28.
        let mut wrote = Vec::new();
        for edge in self.core.edges_from(&item.id)? {
            if edge.edge_type == PLACEMENT_EDGE {
                continue;
            }
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
        let mut front = fields::lines_of(item);
        for (field, value) in &item.properties {
            if field != body_field && !fields::reserved(field) {
                front.insert(field.clone(), value.clone());
            }
        }
        front.insert(ID_FIELD.into(), Value::String(item.id.clone()));
        if let Some(line) = line {
            front.insert(VERSION_FIELD.into(), Value::from(line));
        }
        Ok((document::write(&front, &body)?, wrote))
    }
}

/// What a scan keeps on a file's binding beside its bytes.
#[derive(Default)]
struct Kept {
    edit_line: Option<i64>,
    own: Option<fields::OwnBase>,
    held: Option<String>,
    queued: Vec<String>,
}

/// What a file's own-field lines ask of its item, each already told apart
/// from what the copy holds.
#[derive(Debug, Default)]
struct OwnChanges {
    r#type: Option<String>,
    tier: Option<crate::model::Tier>,
    added: Vec<String>,
    removed: Vec<String>,
    state: Option<ItemState>,
}

impl OwnChanges {
    fn is_empty(&self) -> bool {
        self.r#type.is_none()
            && self.tier.is_none()
            && self.added.is_empty()
            && self.removed.is_empty()
            && self.state.is_none()
    }
}

/// How a file's version line stands against the copy's (`folders.md` 7, 22).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Standing {
    /// The version the copy holds: sent whole, own lines and all.
    Current,
    /// Behind only by an edit of its own, which it holds.
    Spent,
    /// An older version: merged against it, with no own-field change.
    Behind(i64),
    /// No version line, or one the copy never held.
    Lineless,
}

/// A file's own-field changes, what the folder then holds as the file's own
/// fields, and why a change went unsent, where one did.
struct OwnRead {
    changes: OwnChanges,
    base: Option<fields::OwnBase>,
    flag: Option<String>,
}

/// Reads a file's own-field lines three-way against the folder's own last
/// write of the file (`folders.md` 7).
fn own_changes(
    lines: &fields::Lines,
    standing: Standing,
    held: &Item,
    bound: Option<&state::Bound>,
    file_line: Option<i64>,
) -> OwnRead {
    let now = fields::Own::of(held);
    let was = bound.and_then(|bound| bound.own.as_ref());
    let written = was.filter(|was| Some(was.line) == file_line);
    // An own line is told from an old buffer's only against a write of this
    // line, or where the line is the copy's own.
    let unknown = match standing {
        Standing::Current => false,
        Standing::Spent => written.is_none(),
        Standing::Behind(_) | Standing::Lineless => true,
    };
    if unknown {
        let shown = was.map_or(&now, |was| &was.agreed);
        let differ = differing(lines, shown);
        return OwnRead {
            changes: OwnChanges::default(),
            base: was.cloned(),
            flag: (!differ.is_empty()).then(|| {
                format!(
                    "{} not sent: the file is behind the item, so its own-field lines cannot be told from an old buffer's; reload it",
                    differ.join(", ")
                )
            }),
        };
    }
    let base = written.map_or_else(|| now.clone(), |written| written.agreed.clone());
    let moved = written
        .map(|written| written.moved.clone())
        .unwrap_or_default();
    // Only where the folder wrote this line's own lines is an absent one empty.
    let clears = written.is_some();
    let mut changes = OwnChanges::default();
    let mut agreed = base.clone();
    let mut unsent = Vec::new();
    if let Some(named) = lines.r#type.clone().filter(|named| *named != base.r#type) {
        agreed.r#type = named.clone();
        changes.r#type = (named != now.r#type).then_some(named);
    }
    if let Some(tier) = lines.tier.filter(|tier| Some(*tier) != base.tier) {
        agreed.tier = Some(tier);
        changes.tier = (Some(tier) != now.tier).then_some(tier);
    }
    if let Some(tags) = lines.tags.clone().or_else(|| clears.then(Vec::new)) {
        for tag in tags.iter().filter(|tag| !base.tags.contains(tag)) {
            if moved.tags_removed.contains(tag) {
                unsent.push(format!("tag {tag}"));
            } else {
                agreed.tags.push(tag.clone());
                if !now.tags.contains(tag) {
                    changes.added.push(tag.clone());
                }
            }
        }
        for tag in base.tags.iter().filter(|tag| !tags.contains(tag)) {
            if moved.tags_added.contains(tag) {
                unsent.push(format!("tag {tag}"));
            } else {
                agreed.tags.retain(|held| held != tag);
                if now.tags.contains(tag) {
                    changes.removed.push(tag.clone());
                }
            }
        }
        agreed.tags.sort();
    }
    let state = lines.state.or_else(|| clears.then_some(ItemState::Active));
    if let Some(state) = state.filter(|state| *state != base.state) {
        if moved.states.contains(&state) {
            unsent.push("state".into());
        } else {
            agreed.state = state;
            changes.state = (state != now.state
                && matches!(now.state, ItemState::Active | ItemState::Archived))
            .then_some(state);
        }
    }
    OwnRead {
        changes,
        base: match written {
            Some(written) => Some(fields::OwnBase {
                line: written.line,
                agreed,
                moved,
            }),
            None => was.cloned(),
        },
        flag: (!unsent.is_empty()).then(|| {
            format!(
                "{} not sent: changed elsewhere at this file's version, so it cannot be told from an old buffer's; reload it",
                unsent.join(", ")
            )
        }),
    }
}

/// The own fields whose lines a file shows other than `shown`.
fn differing(lines: &fields::Lines, shown: &fields::Own) -> Vec<String> {
    let mut differ = Vec::new();
    if lines
        .r#type
        .as_ref()
        .is_some_and(|named| *named != shown.r#type)
    {
        differ.push("type".to_string());
    }
    if lines.tier.is_some_and(|tier| Some(tier) != shown.tier) {
        differ.push("tier".into());
    }
    if lines.tags.as_ref().is_some_and(|tags| {
        let mut tags = tags.clone();
        tags.sort();
        tags != shown.tags
    }) {
        differ.push("tags".into());
    }
    if lines.state.is_some_and(|state| state != shown.state) {
        differ.push("state".into());
    }
    differ
}

/// Whether a frontmatter value holds nothing.
fn blank(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
}

/// Why a document cannot be of a type, where it cannot: one the copy does
/// not hold, or a file type, whose items are bytes.
fn unsuited_type(r#type: &str, catalog: &Catalog) -> Option<String> {
    if !catalog.known(r#type) {
        return Some(format!("{type} is not a type this copy holds"));
    }
    catalog
        .matches(FILE_TYPE, r#type)
        .then(|| format!("{type} is a file type, whose items are bytes rather than documents"))
}

/// An item a pull writes, with the path it settled on.
struct Placing<'a> {
    item: &'a Item,
    bound: Option<state::Bound>,
    want: String,
    rank: placement::Rank,
}

/// A file whose links the scan could not all resolve on the way past,
/// asked again once every file is bound (`folders.md` 30).
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
/// file (`folders.md` 12).
fn carries_frontmatter(path: &Path) -> bool {
    matches!(extension_of(path).as_deref(), Some("md" | "markdown"))
}

/// Whether a file is a document, which a folder reads as an item's fields
/// rather than sending as bytes (`folders.md` 26).
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

/// The version a file's line names, where it is one the server could have
/// minted (`versions.md` 18).
fn line_of(front: &Map<String, Value>) -> Option<i64> {
    // An editor typing the line as text writes it quoted.
    let line = front.get(VERSION_FIELD)?;
    line.as_i64()
        .or_else(|| line.as_str().and_then(|text| text.trim().parse().ok()))
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
    /// File items whose bytes could not be had (`folders.md` 35).
    pub absent: usize,
    /// Files the pull would not write over: one the person changed since
    /// the folder last wrote it, and one at a path the mapping does not hold.
    pub unwritten: usize,
    /// Journal rows cleared by writing the file back, a person's own delete
    /// inside its grace among them.
    pub revived: usize,
    /// Items whose file would land outside the folder (`folders.md` 27).
    pub outside: usize,
    /// Items whose placement another item holds, written at a free path
    /// beside it, which becomes their placement (`folders.md` 18).
    pub beside: usize,
    /// Items whose placement would make them another kind of file, left
    /// unwritten (`folders.md` 18).
    pub unsuited: usize,
    /// Placements the server refused, not sent again until the key or the
    /// settings change (`folders.md` 18).
    pub unplaced: usize,
    /// Placements written: an `in-folder` edge made, or its `path` moved to
    /// where the file is (`folders.md` 18).
    pub placed: usize,
    /// Files of items that left by state or were trashed, taken away
    /// (`folders.md` 32).
    pub removed: usize,
    /// The same, kept because the person changed them.
    pub kept: usize,
    /// Files whose item the search no longer matches for any other reason,
    /// left where they are (`folders.md` 32).
    pub unmatched: usize,
    /// The settings file, rewritten where the settings moved on (`folders.md`
    /// 1).
    pub settings: SettingsFileReport,
    /// Files the pull left as the person wrote them, because their bytes
    /// were not taken (`folders.md` 9, 10).
    pub flagged: Vec<Flagged>,
    /// Properties the types this folder holds declare under a name a file
    /// reads as something else, so no file carries them (`folders.md` 7).
    pub uncarried: Vec<Uncarried>,
}

/// Whether every component of a path is a plain name inside the folder, with
/// no symlink on the way (`folders.md` 27). A guard, not a boundary: the write
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
