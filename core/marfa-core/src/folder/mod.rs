pub mod document;
pub mod edge_types;
mod elsewhere;
mod embeds;
mod executable;
pub mod fields;
pub mod identity;
mod lines;
pub mod lists;
mod names;
pub(crate) mod placement;
mod removal;
pub use removal::{Confirmed, Restored};
pub mod registry;
pub mod settings;
mod settings_file;
mod status;
pub use status::{FileStatus, Paused, StatusReport};
pub mod state;

use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{BlockedReason, Draft, Edit, Item, ItemState, WriteKind};
use crate::{Core, Result, Server};

use edge_types::EdgeTypes;
use elsewhere::{Look, Peers};
use embeds::ATTACHMENT_EDGE;
pub use fields::{ID_FIELD, Uncarried, VERSION_FIELD};
use lines::{EdgeWork, Names, Resolver};
use lists::{Lists, in_package, is_package};
pub use placement::PLACEMENT_EDGE;
use placement::{beside, cleaned, path_of, suited};
pub use registry::{REGISTRY_ENV, Registered, Registry};

pub use settings::{FOLDER_TYPE, Settings};
pub use settings_file::SettingsFileReport;

pub const STATE_DIR: &str = ".marfa";

/// The window in which the other half of a rename can arrive.
pub const RENAME_GRACE: Duration = Duration::from_secs(5);

pub const SETTINGS_FILE: &str = "folder.yaml";

/// The server's cap on a request's body unless its instance names another,
/// past which it answers `413 request_too_large`.
pub const REQUEST_LIMIT: usize = 1_048_576;

pub const NEAR_LIMIT: usize = REQUEST_LIMIT * 9 / 10;

/// Measured as the JSON string the text is sent in; a file item's bytes go up
/// outside the request.
fn near_limit(key: &str, text: &str) -> Option<Flagged> {
    if !is_document(Path::new(key)) || text.len().saturating_mul(6) < NEAR_LIMIT {
        return None;
    }
    let size = serde_json::to_string(text).map_or(text.len(), |sent| sent.len());
    (size >= NEAR_LIMIT).then(|| Flagged {
        path: key.to_string(),
        flag: "size",
        reason: format!(
            "is {size} bytes as it is sent, {}% of the {REQUEST_LIMIT} a request may carry; past that the server refuses it request_too_large and the file is held",
            size * 100 / REQUEST_LIMIT
        ),
    })
}

pub struct Folder {
    root: PathBuf,
    folder: String,
    core: Core,
    key: std::sync::Mutex<Option<placement::KeyRead>>,
    permissions: std::sync::OnceLock<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ScanReport {
    pub created: usize,
    pub updated: usize,
    pub renamed: usize,
    pub unchanged: usize,
    pub missing: usize,
    pub deleted: usize,
    pub trashed: Vec<String>,
    pub moved_away: usize,
    pub unsure: Vec<Unsure>,
    pub registry: Option<String>,
    pub skipped: usize,
    /// Counted in `created` too.
    pub requeued: usize,
    pub lost: usize,
    pub flagged: Vec<Flagged>,
    pub embeds: Vec<Flagged>,
    pub unreached: usize,
    pub directories: Vec<Flagged>,
    pub secrets: Vec<String>,
    pub paused: usize,
    pub warnings: Vec<Flagged>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Unsure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Flagged {
    pub path: String,
    pub flag: &'static str,
    pub reason: String,
}

impl Flagged {
    fn of(path: &str, held: &str) -> Flagged {
        let (flag, reason) = if let Some(reason) = held.strip_prefix(state::UNREADABLE) {
            ("unreadable", reason)
        } else if let Some(reason) = held
            .strip_prefix(state::EDGES)
            .or_else(|| held.strip_prefix(state::EDGES_WAITING))
        {
            ("edges", reason)
        } else {
            ("refused", held.strip_prefix(state::REFUSED).unwrap_or(held))
        };
        Flagged {
            path: path.to_string(),
            flag,
            reason: reason.to_string(),
        }
    }
}

impl Folder {
    /// The directory need not exist.
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
            key: std::sync::Mutex::new(None),
            permissions: std::sync::OnceLock::new(),
        };
        let row = added.row_on_server()?;
        // The catalog the hydration would read, so a default type the
        // search does not hold is refused before anything is bound.
        {
            let catalog = added.core.http()?.catalog()?;
            let conn = added.core.conn()?;
            crate::store::replace_catalog(&conn, &catalog)?;
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
        // Unlisted, its moves would read as deletes to the others.
        if let Some(registry) = Registry::located() {
            let store = elsewhere::store_id(&added.core)?;
            registry.add(&added.root, folder, Some(&store))?;
            elsewhere::listed_in(&added.core, &registry);
        }
        Ok(added)
    }

    pub fn open(root: impl AsRef<Path>, server: Option<Server>) -> Result<Folder> {
        let root = root.as_ref().to_path_buf();
        let state = root.join(STATE_DIR);
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
        let opened = Folder {
            root,
            folder,
            core,
            key: std::sync::Mutex::new(None),
            permissions: std::sync::OnceLock::new(),
        };
        // A lost registry is the scan's to notice before listing again.
        if let Some(registry) = Registry::located()
            && !elsewhere::lost(&opened.core, &registry)
        {
            let _ = opened.register();
        }
        Ok(opened)
    }

    /// Answers whether the directory was listed.
    pub fn forget(dir: impl AsRef<Path>) -> Result<bool> {
        match Registry::located() {
            Some(registry) => registry.unregister(dir.as_ref()),
            None => Ok(false),
        }
    }

    /// Answers what to report, and whether the registry was lost, which leaves
    /// this pass unable to tell a move.
    fn register(&self) -> (Option<String>, bool) {
        let Some(registry) = Registry::located() else {
            return (None, false);
        };
        let lost = elsewhere::lost(&self.core, &registry);
        let store = elsewhere::store_id(&self.core).ok();
        match registry.register(&self.root, &self.folder, store.as_deref()) {
            Ok(()) => {
                elsewhere::listed_in(&self.core, &registry);
                let said = lost.then(|| {
                    format!(
                        "the folder registry {} was gone, so no missing file is trashed this pass; it lists this folder again",
                        registry.path().display()
                    )
                });
                (said, lost)
            }
            Err(error) => (Some(error.to_string()), lost),
        }
    }

    /// Leaves the folder's files; refused while it is held or writes wait.
    pub fn remove(self) -> Result<()> {
        if self.core.handle() != crate::Handle::Writer {
            return Err(CoreError::Invalid(format!(
                "{} is held by another process, a `folders watch` say; stop it and remove the folder then",
                self.root.display()
            )));
        }
        let waiting = self
            .core
            .queue()?
            .iter()
            .filter(|write| matches!(write.verdict, None | Some(crate::model::Verdict::Blocked)))
            .count();
        if waiting > 0 {
            return Err(CoreError::Invalid(format!(
                "{} has {waiting} write(s) not yet sent; push it first, or they are lost with the folder",
                self.root.display()
            )));
        }
        if let Some(registry) = Registry::located() {
            registry.unregister(&self.root)?;
        }
        let Folder { root, core, .. } = self;
        drop(core);
        let state = root.join(STATE_DIR);
        std::fs::remove_dir_all(&state).map_err(|error| {
            CoreError::Store(format!("cannot remove {}: {error}", state.display()))
        })
    }

    pub fn folder_id(&self) -> &str {
        &self.folder
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Read from the copy, not the server.
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

    fn row_on_server(&self) -> Result<crate::wire::WireItemWithMetadata> {
        let cannot_read = || CoreError::Forbidden {
            code: "type_not_permitted".into(),
            message: format!(
                "this key cannot read {FOLDER_TYPE}, so the folder cannot follow its settings: it needs `{FOLDER_TYPE}:read`"
            ),
        };
        let http = self.core.http()?;
        let read =
            crate::hydrate::read_with_edges(http, &self.folder).map_err(|error| match error {
                CoreError::Forbidden { code, .. } if code == "type_not_permitted" => cannot_read(),
                other => other,
            })?;
        let Some((row, _)) = read else {
            // The server answers a folder the key cannot read as no folder at
            // all, so the key's own map says which of the two this is.
            let message = match http.current_key()? {
                Some(key) if !placement::reads(&key, FOLDER_TYPE) => return Err(cannot_read()),
                Some(_) => format!(
                    "the server holds no folder {}; `folders create` makes one",
                    self.folder
                ),
                // A credential that is not a key cannot read its own map.
                None => format!(
                    "the server holds no folder {} that this credential may read: it needs `{FOLDER_TYPE}:read`, or `folders create` makes one",
                    self.folder
                ),
            };
            return Err(CoreError::NotFound {
                code: "item_not_found".into(),
                message,
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

    pub fn hydrate(&self) -> Result<crate::model::HydrateReport> {
        let row = self.row_on_server()?;
        let settings = Settings::of_wire(&row.item)?;
        self.core.lock.refuse_unless_writer()?;
        let catalog = self.core.http()?.catalog()?;
        crate::store::replace_catalog(&*self.core.conn()?, &catalog)?;
        let edge_types = EdgeTypes::load(&*self.core.conn()?)?;
        crate::store::pin(&*self.core.conn()?, &self.folder)?;
        let catalog = Catalog::load(&*self.core.conn()?)?;
        let whole = whole_edge_types(&settings, &edge_types, &catalog);
        self.core
            .hydrate_every_type_or(settings.types(), settings.tier(), &whole)
    }

    /// `None` where the copy already answers for the slice the settings ask.
    pub fn resume(&self) -> Result<Option<crate::model::HydrateReport>> {
        if crate::store::hydrated(&*self.core.conn()?)? && !self.slice_moved()? {
            return Ok(None);
        }
        self.hydrate().map(Some)
    }

    /// Settings the copy cannot read count as moved, so the hydration that
    /// follows says why.
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
        let Ok(edge_types) = EdgeTypes::load(&conn) else {
            return Ok(true);
        };
        let whole: HashSet<String> = crate::store::whole_edge_types(&conn)?.into_iter().collect();
        let wanted: HashSet<String> =
            whole_edge_types(&settings, &edge_types, &Catalog::load(&conn)?)
                .into_iter()
                .collect();
        Ok(held != asked || tier != settings.tier() || whole != wanted)
    }

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

    fn walked(&self, lists: &Lists) -> Walked {
        let mut walked = Walked::default();
        walk(&self.root, &self.root, lists, &mut walked);
        walked.files.sort();
        walked
    }

    fn writes_at(&self, lists: &Lists, path: &str) -> bool {
        plainly_inside(&self.root, path)
            && lists.takes(path)
            && !in_package(&self.root, path)
            && !in_nested_folder(&self.root, path)
    }
}

fn in_nested_folder(root: &Path, relative: &str) -> bool {
    let mut here = root.to_path_buf();
    let mut names = relative.split('/').peekable();
    while let Some(name) = names.next() {
        if names.peek().is_none() {
            break;
        }
        here.push(name);
        if here.join(STATE_DIR).is_dir() {
            return true;
        }
    }
    false
}

/// Held whole, since their other ends may lie outside the slice.
fn whole_edge_types(settings: &Settings, edge_types: &EdgeTypes, catalog: &Catalog) -> Vec<String> {
    let mut whole = edge_types.written_at_targets();
    // `beneath` walks `parent-of` from rows the slice may not hold.
    if settings.search.beneath.is_some() {
        whole.push(crate::filter::PARENT_OF.into());
    }
    // A search of files alone holds no document to embed one.
    let documents = settings.types().is_empty()
        || settings
            .types()
            .iter()
            .any(|named| !catalog.matches(FILE_TYPE, named.trim()));
    if documents && edge_types.get(ATTACHMENT_EDGE).is_some() {
        whole.push(ATTACHMENT_EDGE.into());
    }
    whole.sort();
    whole.dedup();
    whole
}

#[derive(Default)]
struct Walked {
    files: Vec<PathBuf>,
    directories: Vec<Flagged>,
    secrets: Vec<String>,
}

impl Walked {
    fn passed_over(&self, relative: &str) -> bool {
        self.directories.iter().any(|dir| {
            dir.path.is_empty()
                || relative
                    .strip_prefix(&dir.path)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
    }

    fn unreadable(&mut self, root: &Path, dir: &Path, error: &std::io::Error) {
        self.directories.push(Flagged {
            path: identity::relative(root, dir).unwrap_or_default(),
            flag: "unreadable",
            reason: format!("cannot be read ({error}), so the files bound in it are held"),
        });
    }
}

/// A directory it cannot read is reported and passed over, so one does not
/// stop the scan of every other.
fn walk(root: &Path, dir: &Path, lists: &Lists, walked: &mut Walked) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Gone mid-walk: the scan that follows will not find its files either.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => return walked.unreadable(root, dir, &error),
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => return walked.unreadable(root, dir, &error),
        };
        let path = entry.path();
        let Ok(relative) = identity::relative(root, &path) else {
            continue;
        };
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        // A symlink is neither: following one would give two paths one
        // identity on purpose.
        if metadata.is_dir() {
            // A folder inside is that folder's, its files never this one's.
            if !lists.enters(&relative) || path.join(STATE_DIR).is_dir() {
                continue;
            }
            if is_package(&path) {
                walked.directories.push(Flagged {
                    path: relative,
                    flag: "package",
                    reason: "is a package, which macOS opens as one thing, so the folder does not walk into it".into(),
                });
            } else {
                walk(root, &path, lists, walked);
            }
        } else if metadata.is_file() {
            if lists.takes(&relative) {
                walked.files.push(path);
            } else if lists.secret(&relative) {
                walked.secrets.push(relative);
            }
        }
    }
}

fn one_per_name(
    paths: &[PathBuf],
    keys: Vec<String>,
    snapshot: &[state::Bound],
    report: &mut ScanReport,
) -> (Vec<PathBuf>, Vec<String>) {
    let bound: HashSet<&str> = snapshot.iter().map(|row| row.path.as_str()).collect();
    let holders = names::holders(&keys, |key| bound.contains(key));
    let mut kept = (Vec::new(), Vec::new());
    for (at, (path, key)) in paths.iter().zip(&keys).enumerate() {
        let held = holders[at];
        if held == at {
            kept.0.push(path.clone());
            kept.1.push(key.clone());
        } else {
            report.flagged.push(Flagged {
                path: key.clone(),
                flag: "name",
                reason: format!(
                    "differs from {} only in case or Unicode form, which a folder reads as one name, so it is held until one of them is renamed",
                    keys[held]
                ),
            });
        }
    }
    kept
}

struct Scanned {
    key: String,
    path: PathBuf,
    text: String,
    hash: String,
    /// Device, inode and birth time, where the filesystem gave a usable
    /// three.
    mark: Option<String>,
    born: Option<u128>,
    id: Option<String>,
    /// The version its `marfa_version` line names, where that is one the
    /// server could have minted.
    line: Option<i64>,
    unreadable: Option<String>,
    /// `None` on a volume that keeps no permission.
    executable: Option<bool>,
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

#[derive(Debug, Clone)]
struct Claim {
    item_id: String,
    bound: Option<state::Bound>,
}

/// Keyed by the file's place in the scan.
type Waiting = HashMap<usize, String>;

enum Arrival {
    Here,
    Copy,
    Waits(String),
}

enum Missing {
    Moved,
    Unsure(String),
    Deleted,
    Gone,
}

impl Folder {
    pub fn scan(&self) -> Result<ScanReport> {
        self.scan_as(true)
    }

    /// Skips a file whose size, time and identity are as the last read left
    /// them; a full pass catches what that misses.
    pub fn scan_quick(&self) -> Result<ScanReport> {
        self.scan_as(false)
    }

    fn scan_as(&self, full: bool) -> Result<ScanReport> {
        // Every pass, so a watch lists its folder again too.
        let (registry, lost) = self.register();
        let doubt = registry.clone().filter(|_| lost);
        let mut report = ScanReport {
            registry,
            ..ScanReport::default()
        };
        let settings = self.settings()?;
        let (catalog, mut edge_types) = {
            let conn = self.core.conn()?;
            (Catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let lists = settings.lists()?;
        let walked = self.walked(&lists);
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
        // Every file the walk found, whether or not it is pushed: leaving one
        // out journals it missing and deletes the item bound to it.
        let seen: HashSet<String> = found.iter().cloned().collect();
        let (paths, keys) = one_per_name(&walked.files, found, &snapshot, &mut report);
        let by_path: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .map(|bound| (bound.path.as_str(), bound))
            .collect();
        // Each file's size and time, taken before its read, so a change made
        // during the read differs from what is recorded.
        let mut stats: Vec<(String, String)> = Vec::new();
        let mut unchanged: HashSet<String> = HashSet::new();
        if !full {
            // Resolved over every file, so a hard link shares no mark.
            let marks = identity::resolve(&paths);
            let conn = self.core.conn()?;
            for (path, key) in paths.iter().zip(&keys) {
                if let Some(bound) = by_path.get(key.as_str())
                    && bound.held.is_none()
                    && bound.writes.refused.is_empty()
                    // A save set aside is sent again by the next scan.
                    && state::untaken_read_version(&bound.content_hash).is_none()
                    && bound.identity.is_some()
                    && marks.get(path).map(|found| found.key()) == bound.identity
                    && let Some(stat) = stat_of(path)
                    && state::stat_of(&conn, key)?.as_deref() == Some(stat.as_str())
                    // A file whose item the copy lost is said to be at every pass.
                    && crate::store::held_version(&conn, &bound.item_id)?.is_some()
                {
                    unchanged.insert(key.clone());
                }
            }
        }
        // Markdown files first, so a file only an embed names is sent too.
        let mut early: HashMap<PathBuf, Vec<u8>> = HashMap::new();
        let mut shown: HashMap<String, Vec<(String, embeds::Target)>> = HashMap::new();
        let mut embedded: HashSet<String> = HashSet::new();
        let index = embeds::Files::of(&keys);
        let mut reading: Vec<usize> = (0..paths.len()).collect();
        while !reading.is_empty() {
            let mut named: HashSet<String> = HashSet::new();
            for at in reading {
                let (path, key) = (&paths[at], &keys[at]);
                if !carries_frontmatter(path) || unchanged.contains(key) {
                    continue;
                }
                let stat = stat_of(path);
                let Ok(bytes) = std::fs::read(path) else {
                    continue;
                };
                if let Some(stat) = stat {
                    stats.push((key.clone(), stat));
                }
                let text = String::from_utf8_lossy(&bytes);
                let read = document::read(&text);
                named.extend(
                    read.front
                        .get(ID_FIELD)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| document::id_line(&text)),
                );
                let mut found = Vec::new();
                for embed in document::embeds(&read.body) {
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
        report.unchanged += unchanged.len();
        // A file already a file item is read whatever the search says, so one
        // no longer embedded, or moved, is followed rather than journaled.
        let files_bound: Vec<&state::Bound> = snapshot
            .iter()
            .filter(|row| !is_document(Path::new(&row.path)))
            .collect();
        let bound_paths: HashSet<&str> = files_bound.iter().map(|row| row.path.as_str()).collect();
        let bound_marks: HashSet<&str> = files_bound
            .iter()
            .filter_map(|row| row.identity.as_deref())
            .collect();
        let bound = |path: &Path, key: &str| {
            bound_paths.contains(key)
                || std::fs::symlink_metadata(path)
                    .ok()
                    .and_then(|metadata| identity::of(&metadata))
                    .is_some_and(|found| bound_marks.contains(found.key().as_str()))
        };
        let mut held: Vec<PathBuf> = Vec::new();
        for (path, key) in paths.iter().zip(&keys) {
            if unchanged.contains(key) {
                continue;
            }
            if self.pushes(path, &settings, &catalog) || embedded.contains(key) || bound(path, key)
            {
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
            let bytes = match early.remove(&path) {
                Some(bytes) => bytes,
                None => {
                    let stat = stat_of(&path);
                    let Ok(bytes) = std::fs::read(&path) else {
                        continue;
                    };
                    if let Some(stat) = stat {
                        stats.push((identity::relative(&self.root, &path)?, stat));
                    }
                    bytes
                }
            };
            // No blob the server holds is empty.
            if bytes.is_empty() && !is_document(&path) {
                report.skipped += 1;
                continue;
            }
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let read = carries_frontmatter(&path).then(|| document::read(&text));
            let unreadable = read.as_ref().and_then(|read| {
                read.unreadable
                    .clone()
                    .or_else(|| fields::read(&read.front, &edge_types).err())
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
            let metadata = std::fs::symlink_metadata(&path).ok();
            files.push(Scanned {
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
                path,
            });
        }
        // A file read against an old list would send a new type's line as a
        // property; where the list cannot be read, the one kept stands.
        let changed = files.iter().any(|file| {
            !snapshot
                .iter()
                .any(|bound| bound.path == file.key && bound.content_hash == file.hash)
        });
        if changed
            && let Ok(http) = self.core.http()
            && let Ok(fresh) = http.catalog()
        {
            crate::store::replace_catalog(&*self.core.conn()?, &fresh)?;
            edge_types = EdgeTypes::load(&*self.core.conn()?)?;
        }
        let peers = Peers::of(self, doubt);
        let (claims, mut waiting) = self.claim(&files, &snapshot, &settings, &catalog, &peers)?;
        let withheld = self.withheld()?;
        let mut work: Vec<EdgeWork> = Vec::new();

        for (at, (file, claim)) in files.iter().zip(claims).enumerate() {
            if let Some(reason) = waiting.remove(&at) {
                report.flagged.push(Flagged {
                    path: file.key.clone(),
                    flag: "waiting",
                    reason,
                });
                continue;
            }
            if let Some(reason) = &file.unreadable {
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
                        (&settings, embedded.contains(&file.key)),
                        &catalog,
                        &edge_types,
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
                        &catalog,
                        &edge_types,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report.updated += 1;
                        report.warnings.extend(near_limit(&file.key, &file.text));
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
                        // A permission changed alone leaves the bytes as they
                        // were.
                        if let Some(runs) = file.executable
                            && let Some(held) = self.core.get(&item_id)?
                            && bytes_of(&held, &catalog).is_some()
                            && executable::held(&held) != runs
                        {
                            self.queue_update_file(&bound, file, &held, &catalog)?;
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
                        &edge_types,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report.updated += 1;
                        report.warnings.extend(near_limit(&file.key, &file.text));
                    } else {
                        report.unchanged += 1;
                    }
                }
                Some(Claim {
                    item_id,
                    bound: Some(bound),
                }) => {
                    self.unbind_if_still(&bound)?;
                    if self.queue_update(
                        &item_id,
                        Some(&bound),
                        file,
                        &catalog,
                        &edge_types,
                        &mut work,
                        &mut report.flagged,
                    )? {
                        report.warnings.extend(near_limit(&file.key, &file.text));
                    }
                    self.place(&item_id, &file.key, &withheld)?;
                    report.renamed += 1;
                }
            }
        }

        // Every file is bound now, so a link or a line naming one that
        // arrived in the same scan resolves.
        let mut resolver = Resolver::new(self, &catalog);
        for pending in &mut work {
            pending.embeds = shown.remove(&pending.path).unwrap_or_default();
        }
        for pending in work {
            // A failure is this file's alone: it waits, and the scan goes on.
            let outcome = self
                .queue_edges(&pending, &edge_types, &catalog, &mut resolver)
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

        {
            let conn = self.core.conn()?;
            state::set_stats(&conn, &stats, full)?;
        }

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
                .map(|(path, item_id, _)| (path, item_id))
                .collect()
        };
        for row in bound {
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
            if !lists.takes(&row.path)
                || walked.passed_over(&row.path)
                || in_nested_folder(&self.root, &row.path)
            {
                if held {
                    let conn = self.core.conn()?;
                    state::journal_clear(&conn, &row.path)?;
                }
                report.unreached += 1;
                continue;
            }
            let conn = self.core.conn()?;
            state::journal_missing(&conn, &row.path, &row.item_id)?;
            report.missing += 1;
        }
        self.sweep_journal(&settings, &peers, &mut report)?;
        Ok(report)
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
        // A file that cannot carry an id, moved here from another folder on
        // this machine, is the item that folder bound it to.
        for (at, file) in files.iter().enumerate() {
            if claims[at].is_some()
                || waiting.contains_key(&at)
                || file.id.is_some()
                || carries_frontmatter(&file.path)
            {
                continue;
            }
            let Some(theirs) = peers.left_behind(file.mark.as_deref(), &file.hash) else {
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

    fn sweep_journal(
        &self,
        settings: &Settings,
        peers: &Peers<'_>,
        report: &mut ScanReport,
    ) -> Result<()> {
        let (journaled, of) = {
            let conn = self.core.conn()?;
            (state::journaled(&conn)?, state::bound_count(&conn)?)
        };
        // Counted over every missing file, not only those past the grace, so
        // files a watch meets a pass apart are one removal.
        if settings.removal_threshold.exceeded(journaled.len(), of) {
            let paths: Vec<String> = journaled.into_iter().map(|(path, _, _)| path).collect();
            state::set_paused(&*self.core.conn()?, state::Removal::Disk, &paths)?;
            report.paused = paths.len();
            return Ok(());
        }
        state::set_paused(&*self.core.conn()?, state::Removal::Disk, &[])?;
        let now = crate::store::now_iso();
        let members = OnceCell::new();
        for (path, item_id, missing_since) in journaled {
            if !elapsed_past(&missing_since, &now, RENAME_GRACE) {
                continue;
            }
            match self.let_go_missing(&path, &item_id, settings, peers, &members)? {
                Missing::Moved => report.moved_away += 1,
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

    fn let_go_missing(
        &self,
        path: &str,
        item_id: &str,
        settings: &Settings,
        peers: &Peers<'_>,
        members: &OnceCell<HashSet<String>>,
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
        let missing = if held.is_some_and(|item| item.state != ItemState::Trashed) {
            let look = match &bound {
                Some(bound) => peers.moved_to(bound, self.holds(item_id, settings, members)),
                None => Look::Nowhere,
            };
            match look {
                Look::Moved => Missing::Moved,
                // Held as a delete is while offline, until it can be told.
                Look::Unsure(reason) => return Ok(Missing::Unsure(reason)),
                Look::Nowhere => {
                    self.core.delete_item(item_id)?;
                    Missing::Deleted
                }
            }
        } else {
            Missing::Gone
        };
        let conn = self.core.conn()?;
        state::journal_clear(&conn, path)?;
        state::unbind(&conn, path)?;
        Ok(missing)
    }

    fn peers(&self) -> Peers<'_> {
        let (registry, lost) = self.register();
        Peers::of(self, registry.filter(|_| lost))
    }

    fn pushes(&self, path: &Path, settings: &Settings, catalog: &Catalog) -> bool {
        is_document(path) || self.file_type_of(path, settings, catalog).is_some()
    }

    fn file_type_of(&self, path: &Path, settings: &Settings, catalog: &Catalog) -> Option<String> {
        let file_type = bytes_type(path, catalog)?;
        let types = settings.types();
        (types.is_empty()
            || types
                .iter()
                .any(|declared| catalog.matches(declared, &file_type)))
        .then_some(file_type)
    }

    /// A file naming a type no document can be is flagged instead.
    fn queue_create(
        &self,
        file: &Scanned,
        (settings, embedded): (&Settings, bool),
        catalog: &Catalog,
        edge_types: &EdgeTypes,
        withheld: &placement::Withheld,
        work: &mut Vec<EdgeWork>,
    ) -> Result<Option<Flagged>> {
        // An embedded file goes as its bytes' type whatever the search holds.
        let file_type = self
            .file_type_of(&file.path, settings, catalog)
            .or_else(|| embedded.then(|| bytes_type(&file.path, catalog)).flatten());
        if let Some(file_type) = file_type {
            self.queue_create_file(file, file_type, settings, catalog, withheld)?;
            return Ok(None);
        }
        let document = file.document();
        let read = fields::read(&document.front, edge_types).unwrap_or_default();
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
        let mut writes = state::Writes {
            save: 1,
            ..state::Writes::default()
        };
        if read.lines.state == Some(ItemState::Archived) {
            let id = self.core.transition_item(&item_id, ItemState::Archived)?.id;
            writes.queued.push(state::Queued {
                id,
                save: 1,
                line: None,
            });
        }
        // Before the links, so a link naming a default's target adds no
        // second edge; a line the file writes fills that blank itself.
        self.queue_default_edges(&item_id, settings, Some((&document.front, edge_types)))?;
        self.place(&item_id, &file.key, withheld)?;
        self.bind_scanned(
            file,
            &item_id,
            Vec::new(),
            Vec::new(),
            Kept {
                writes,
                ..Kept::default()
            },
        )?;
        work.push(self.edge_work(file, &item_id, None));
        Ok(None)
    }

    /// A document's links and lines, to read once every file is bound.
    fn edge_work(&self, file: &Scanned, item_id: &str, bound: Option<&state::Bound>) -> EdgeWork {
        let document = file.document();
        EdgeWork {
            path: file.key.clone(),
            item_id: item_id.to_string(),
            links: document.links,
            front: document.front,
            had_links: bound.map(|bound| bound.links.clone()).unwrap_or_default(),
            had_lines: bound.map(|bound| bound.lines.clone()).unwrap_or_default(),
            embeds: Vec::new(),
        }
    }

    /// Its type is its bytes', so of the defaults it takes only the tier, the
    /// tags and the edges.
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
        if file.executable == Some(true) {
            properties.insert(executable::FIELD.into(), Value::Bool(true));
        }
        let draft = Draft {
            r#type: file_type,
            properties,
            tags: settings.defaults.tags.clone(),
            tier: Some(settings.new_tier()),
            ..Default::default()
        };
        let item_id = named_item(self.core.create_file_item(&file.path, &draft)?, &file.key)?;
        self.queue_default_edges(&item_id, settings, None)?;
        self.place(&item_id, &file.key, withheld)?;
        self.bind_scanned(file, &item_id, Vec::new(), Vec::new(), Kept::default())
    }

    /// The defaults' edges for a new item. A `parent-of` default names the
    /// parent, as the child's file writes it, so a new file lands beneath
    /// what the search follows. A type the file's own frontmatter writes a
    /// line for is no blank.
    fn queue_default_edges(
        &self,
        item_id: &str,
        settings: &Settings,
        front: Option<(&Map<String, Value>, &EdgeTypes)>,
    ) -> Result<()> {
        for (edge_type, targets) in &settings.defaults.edges {
            let end = if edge_type == crate::filter::PARENT_OF {
                crate::catalog::End::Target
            } else {
                crate::catalog::End::Source
            };
            if let Some((front, types)) = front
                && let Some(name) = types.get(edge_type).and_then(|def| def.name_at(end))
                && front.contains_key(name)
            {
                continue;
            }
            for target in targets {
                let (source_id, target_id) = match end {
                    crate::catalog::End::Target => (target.clone(), item_id.to_string()),
                    crate::catalog::End::Source => (item_id.to_string(), target.clone()),
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

    /// Whole only where the file's version line is the copy's.
    #[allow(clippy::too_many_arguments)]
    fn queue_update(
        &self,
        item_id: &str,
        bound: Option<&state::Bound>,
        file: &Scanned,
        catalog: &Catalog,
        edge_types: &EdgeTypes,
        work: &mut Vec<EdgeWork>,
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
        let document = file.document();
        let read = fields::read(&document.front, edge_types).unwrap_or_default();
        let spent = bound.and_then(state::Bound::spent);
        // Bytes set aside in a conflicted copy against this device's own
        // earlier save go on the version they were read at.
        let untaken = bound.and_then(|bound| state::untaken_read_version(&bound.content_hash));
        // The file's last bytes showed the item as the server last answered
        // it, but for their line: a version step no file shows, or its own edit.
        let current_but_line = untaken.is_none()
            && file.line.is_some_and(|line| line != held.version)
            && !crate::store::item_waits(&*self.core.conn()?, item_id)?
            && match bound {
                Some(bound) => {
                    let names = Names::load(self, catalog)?;
                    let rendered = self.render(
                        &held,
                        &file.key,
                        file.line,
                        catalog,
                        edge_types,
                        (&names, Some(&document.front), &bound.lines),
                    )?;
                    state::hash(rendered.text.as_bytes()) == bound.content_hash
                }
                None => false,
            };
        let standing = match file.line {
            _ if untaken.is_some() => Standing::Spent,
            Some(line) if line == held.version || current_but_line => Standing::Current,
            // Behind only by the file's own edit, which it holds.
            Some(line) if line < held.version && spent.is_some_and(|spent| line <= spent) => {
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
                if fields::reserved(field, edge_types) {
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
        let mut writes = bound.map(|bound| bound.writes.clone()).unwrap_or_default();
        let fresh = bound.is_none_or(|bound| bound.content_hash != file.hash);
        if fresh {
            writes.save += 1;
        }
        let save = writes.save;
        let mut queued: Vec<(String, Option<i64>)> = Vec::new();
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
                let id = if read_at.is_some() {
                    self.core.update_item_as_read(item_id, &edit)?.id
                } else {
                    self.core.update_item(item_id, &edit)?.id
                };
                queued.push((id, Some(file.line.unwrap_or(0))));
            }
            for tag in &changes.added {
                queued.push((self.core.add_tag(item_id, tag)?.id, None));
            }
            for tag in &changes.removed {
                queued.push((self.core.remove_tag(item_id, tag)?.id, None));
            }
            if let Some(state) = changes.state {
                queued.push((self.core.transition_item(item_id, state)?.id, None));
            }
        }
        writes.queued.extend(
            queued
                .into_iter()
                .map(|(id, line)| state::Queued { id, save, line }),
        );
        // A refused change the file no longer carries holds it no longer.
        let agrees = unchanged && changes.r#type.is_none() && changes.tier.is_none();
        writes.refused.retain(|refused| match &refused.change {
            state::Change::Edit => !agrees,
            state::Change::AddTag(tag) => own.tags.as_ref().is_none_or(|tags| tags.contains(tag)),
            state::Change::RemoveTag(tag) => {
                own.tags.as_ref().is_none_or(|tags| !tags.contains(tag))
            }
            state::Change::State(state) => own.state.is_none_or(|shown| shown == *state),
            // The file's edge work decides these.
            state::Change::Edge { .. } => true,
        });
        let (links, lines) = bound
            .map(|bound| (bound.links.clone(), bound.lines.clone()))
            .unwrap_or_default();
        self.bind_scanned(
            file,
            item_id,
            links,
            lines,
            Kept {
                edit_line: bound.and_then(|bound| bound.edit_line),
                own: own.base,
                held: None,
                writes,
            },
        )?;
        work.push(self.edge_work(file, item_id, bound));
        Ok(!in_step)
    }

    fn bind_held(
        &self,
        file: &Scanned,
        item_id: &str,
        bound: Option<&state::Bound>,
        held: String,
    ) -> Result<()> {
        let links = bound.map(|bound| bound.links.clone()).unwrap_or_default();
        let lines = bound.map(|bound| bound.lines.clone()).unwrap_or_default();
        let kept = Kept {
            edit_line: bound.and_then(|bound| bound.edit_line),
            own: bound.and_then(|bound| bound.own.clone()),
            held: Some(held),
            writes: bound.map(|bound| bound.writes.clone()).unwrap_or_default(),
        };
        self.bind_scanned(file, item_id, links, lines, kept)
    }

    /// A move carries the new name as the title where the old name was it.
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
        if let Some(runs) = file.executable
            && executable::held(held) != runs
        {
            edit.properties
                .insert(executable::FIELD.into(), Value::Bool(runs));
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
        let kept = Kept {
            writes: bound.writes.clone(),
            ..Kept::default()
        };
        self.bind_scanned(file, &held.id, Vec::new(), Vec::new(), kept)?;
        Ok(queued)
    }

    fn bind_scanned(
        &self,
        file: &Scanned,
        item_id: &str,
        links: Vec<String>,
        lines: Vec<state::Line>,
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
                lines,
                edit_line: kept.edit_line,
                held: kept.held,
                own: kept.own,
                writes: kept.writes,
            },
        )
    }

    /// An id the copy holds, or a file in this folder, its path compared as
    /// names are.
    fn resolve_link(&self, target: &str) -> Result<Option<String>> {
        if self.core.get(target)?.is_some() {
            return Ok(Some(target.to_string()));
        }
        let conn = self.core.conn()?;
        let candidates = [target.to_string(), format!("{target}.md")];
        for candidate in &candidates {
            if let Some(bound) = state::bound_at(&conn, candidate)? {
                return Ok(Some(bound.item_id));
            }
        }
        let wanted: Vec<String> = candidates.iter().map(|name| names::folded(name)).collect();
        Ok(state::bound_paths(&conn)?
            .into_iter()
            .find(|(path, _)| wanted.contains(&names::folded(path)))
            .map(|(_, item_id)| item_id))
    }
}

fn journaled_for(conn: &rusqlite::Connection, path: &str, item_id: &str) -> Result<bool> {
    Ok(state::journaled(conn)?
        .iter()
        .any(|(at, id, _)| at == path && id == item_id))
}

/// Whether a move was answered that another machine deleted its edge first.
fn gone_before_its_move(row: &crate::model::QueuedWrite) -> bool {
    row.kind == WriteKind::UpdateEdge
        && row.verdict == Some(crate::model::Verdict::Refused)
        && row.reason.as_deref() == Some("edge_not_found")
}

/// Kept with the end it named before, so a refusal can point the record back
/// there.
struct MovedLine {
    from: String,
    to: state::Line,
}

/// Read from the row, since the copy may no longer hold the edge once the
/// server has answered.
fn moved_line(
    conn: &rusqlite::Connection,
    row: &crate::model::QueuedWrite,
    bound: &state::Bound,
) -> Result<Option<MovedLine>> {
    let (Some(source), Some(target), Some(edge_id)) = (&row.item_id, &row.target_id, &row.edge_id)
    else {
        return Ok(None);
    };
    let body: Value = serde_json::from_str(&crate::store::payload_of(conn, &row.id)?)?;
    let (end, from, to) = match (body["source_id"].as_str(), body["target_id"].as_str()) {
        (None, Some(to)) if source == &bound.item_id => (crate::catalog::End::Source, target, to),
        (Some(to), None) if target == &bound.item_id => (crate::catalog::End::Target, source, to),
        _ => return Ok(None),
    };
    let edge_type = match crate::store::edge_by_id(conn, edge_id)? {
        Some(edge) => edge.edge_type,
        None => match bound
            .lines
            .iter()
            .find(|line| line.end == end && line.other == to)
        {
            Some(line) => line.edge_type.clone(),
            None => return Ok(None),
        },
    };
    Ok(Some(MovedLine {
        from: from.clone(),
        to: state::Line {
            edge_type,
            end,
            other: to.to_string(),
        },
    }))
}

fn edge_change(
    conn: &rusqlite::Connection,
    row: &crate::model::QueuedWrite,
    item_id: &str,
) -> Result<Option<state::Change>> {
    let (Some(source), Some(target)) = (&row.item_id, &row.target_id) else {
        return Ok(None);
    };
    let body: Value = serde_json::from_str(&crate::store::payload_of(conn, &row.id)?)?;
    let Some(edge_type) = body["edge_type"].as_str() else {
        return Ok(None);
    };
    let (end, other) = if source == item_id {
        (crate::catalog::End::Source, target)
    } else {
        (crate::catalog::End::Target, source)
    };
    Ok(Some(state::Change::Edge {
        line: state::Line {
            edge_type: edge_type.to_string(),
            end,
            other: other.clone(),
        },
        shown: row.kind == WriteKind::CreateEdge,
    }))
}

fn named_item(queued: crate::model::QueuedWrite, key: &str) -> Result<String> {
    queued
        .item_id
        .ok_or_else(|| CoreError::Invalid(format!("the create queued for {key} names no item")))
}

fn name_of(key: &str) -> &str {
    key.rsplit('/').next().unwrap_or(key)
}

fn title_of(key: &str) -> String {
    let name = name_of(key);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
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
    // `YYYY-MM-DDTHH:MM:SS.mmmZ`, which is the one shape `now_iso` writes.
    let bytes = stamp.as_bytes();
    if bytes.len() < 24 {
        return None;
    }
    let number = |from: usize, to: usize| stamp.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let millis = number(20, 23)?;
    // Days since the epoch, by the days-from-civil algorithm run backwards.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Drained {
    #[serde(flatten)]
    pub report: crate::DrainReport,
    pub rebased: usize,
    pub gave_way: usize,
}

impl Folder {
    pub fn drain(&self) -> Result<Drained> {
        let mut report = self.core.drain()?;
        let mut rebased = 0;
        while report.stopped.is_none() {
            let now = self.rebase_thinned()? + self.make_edges_gone_before_their_move()?;
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
        // Queued even where the drain stopped, so the copy holds the edge the line asks for.
        self.make_edges_gone_before_their_move()?;
        let gave_way = self.settle_placements(&mut report)?;
        self.hold_refused()?;
        Ok(Drained {
            report,
            rebased,
            gave_way,
        })
    }

    /// Read from the queue rather than this drain's report, so a refusal a plain
    /// device drain was answered holds its file too.
    fn hold_refused(&self) -> Result<()> {
        let queue = self.core.queue()?;
        let conn = self.core.conn()?;
        for mut bound in state::every_bound(&conn)? {
            let was = (bound.writes.clone(), bound.lines.clone(), bound.edit_line);
            for verdict in &queue {
                let Some(at) = bound.writes.queued.iter().position(|q| q.id == verdict.id) else {
                    continue;
                };
                let save = bound.writes.queued[at].save;
                let row = verdict;
                let mut moved: Option<MovedLine> = None;
                let change = match row.kind {
                    WriteKind::UpdateItem => state::Change::Edit,
                    WriteKind::AddTag => state::Change::AddTag(row.tag.clone().unwrap_or_default()),
                    WriteKind::RemoveTag => {
                        state::Change::RemoveTag(row.tag.clone().unwrap_or_default())
                    }
                    WriteKind::TransitionItem => {
                        let body: Value =
                            serde_json::from_str(&crate::store::payload_of(&conn, &row.id)?)?;
                        match body["state"].as_str().and_then(|state| state.parse().ok()) {
                            Some(state) => state::Change::State(state),
                            None => continue,
                        }
                    }
                    WriteKind::CreateEdge | WriteKind::DeleteEdge => {
                        match edge_change(&conn, row, &bound.item_id)? {
                            Some(change) => change,
                            None => continue,
                        }
                    }
                    WriteKind::UpdateEdge => match moved_line(&conn, row, &bound)? {
                        Some(line) => {
                            let change = state::Change::Edge {
                                line: line.to.clone(),
                                shown: true,
                            };
                            moved = Some(line);
                            change
                        }
                        None => continue,
                    },
                    _ => continue,
                };
                // Left for the next drain that is not stopped to make the edge it asks for.
                if moved.is_some() && gone_before_its_move(row) {
                    continue;
                }
                // A delete of an edge already gone did what it was asked.
                let gone = row.kind == WriteKind::DeleteEdge
                    && verdict.reason.as_deref() == Some("edge_not_found");
                match verdict.verdict {
                    Some(crate::model::Verdict::Refused) if !gone => {
                        let code = verdict.reason.clone().unwrap_or_default();
                        let message = row
                            .answer
                            .as_deref()
                            .and_then(|answer| serde_json::from_str::<Value>(answer).ok())
                            .and_then(|answer| {
                                answer["error"]["message"].as_str().map(str::to_string)
                            });
                        // A refused move left the edge where it was, so the record names it there again.
                        if let Some(moved) = &moved {
                            for line in &mut bound.lines {
                                if *line == moved.to {
                                    line.other = moved.from.clone();
                                }
                            }
                        }
                        let refused = state::Refused {
                            change,
                            save,
                            reason: match message {
                                Some(message) => format!("{code}: {message}"),
                                None => code,
                            },
                        };
                        if !bound.writes.refused.contains(&refused) {
                            bound.writes.refused.push(refused);
                        }
                    }
                    Some(
                        crate::model::Verdict::Accepted
                        | crate::model::Verdict::Merged
                        | crate::model::Verdict::Refused,
                    ) => {
                        bound.writes.refused.retain(|refused| {
                            refused.save >= save || !change.supersedes(&refused.change)
                        });
                    }
                    // Answered, its own value set aside in a copy beside the row.
                    Some(crate::model::Verdict::Conflicted) => {}
                    // Kept with its line spent, since it may have landed;
                    // released, it is answered here again.
                    Some(crate::model::Verdict::Dead) => continue,
                    _ => continue,
                }
                // A refused edit spends no line.
                let spent = bound.writes.queued.remove(at).line;
                if verdict.verdict != Some(crate::model::Verdict::Refused)
                    && let Some(line) = spent
                {
                    bound.edit_line = Some(bound.edit_line.unwrap_or(0).max(line));
                }
            }
            if (&bound.writes, &bound.lines, bound.edit_line) != (&was.0, &was.1, was.2) {
                state::bind(&conn, &bound)?;
            }
        }
        Ok(())
    }

    /// Makes the edge a line names where its move was answered that another
    /// machine deleted the edge first: the line still asks for it.
    fn make_edges_gone_before_their_move(&self) -> Result<usize> {
        let queue = self.core.queue()?;
        let mut made = 0;
        let bounds = state::every_bound(&*self.core.conn()?)?;
        for mut bound in bounds {
            let mut changed = false;
            for at in 0..bound.writes.queued.len() {
                let Some(row) = queue
                    .iter()
                    .find(|row| row.id == bound.writes.queued[at].id)
                else {
                    continue;
                };
                if !gone_before_its_move(row) {
                    continue;
                }
                let Some(moved) = moved_line(&*self.core.conn()?, row, &bound)? else {
                    continue;
                };
                let body: Value =
                    serde_json::from_str(&crate::store::payload_of(&*self.core.conn()?, &row.id)?)?;
                let (source_id, target_id) = match moved.to.end {
                    crate::catalog::End::Source => (bound.item_id.clone(), moved.to.other.clone()),
                    crate::catalog::End::Target => (moved.to.other.clone(), bound.item_id.clone()),
                };
                let created = self.core.create_edge(&crate::model::EdgeDraft {
                    source_id,
                    target_id,
                    edge_type: moved.to.edge_type.clone(),
                    properties: body["properties"].as_object().cloned().unwrap_or_default(),
                    id: None,
                })?;
                bound.writes.queued[at].id = created.id;
                changed = true;
                made += 1;
            }
            if changed {
                state::bind(&*self.core.conn()?, &bound)?;
            }
        }
        Ok(made)
    }

    /// Only the first `ancestor_unavailable` edit of each item: the next was
    /// made against it, so it goes on its answer, a pass later.
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
    /// Each file is bound before its bytes land, so the scan never reads it
    /// back.
    pub fn pull(&self) -> Result<PullReport> {
        let mut report = PullReport::default();
        let settings = self.settings()?;
        let lists = settings.lists()?;
        let mut members = self.members(&settings)?;
        let items = self.core.list(
            &crate::model::ListFilters {
                tier: Some(settings.tier()),
                all_states: true,
                ..Default::default()
            },
            crate::model::Sort::default(),
        )?;
        let (catalog, edge_types) = {
            let conn = self.core.conn()?;
            (Catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let bound_items: HashSet<String> = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
                .into_iter()
                .map(|bound| bound.item_id)
                .collect()
        };
        let mut work: Vec<(Item, bool)> = Vec::new();
        let mut skipped: Vec<String> = Vec::new();
        for item in items {
            if members.contains(&item.id) {
                work.push((item, false));
            } else if !bound_items.contains(&item.id) && item.r#type != FOLDER_TYPE {
                skipped.push(item.id);
            }
        }
        // A bound file whose item left the search, but not by state or the
        // bin, is kept current as a member's is and flagged; it never gets a
        // new file.
        let outside: Vec<String> = bound_items
            .into_iter()
            .filter(|id| !members.contains(id))
            .collect();
        let held = crate::store::items_by_ids(&*self.core.conn()?, &outside)?;
        let peers = Peers::of(self, None);
        for item in held {
            if !settings.holds_state(item.state) {
                continue;
            }
            if !self.let_go(&item.id, &peers, &mut report)? {
                work.push((item, true));
            }
        }
        self.hold_edge_ends(&work, &edge_types, &catalog)?;
        let withheld = self.withheld()?;
        // After the pins, so an embed names an attachment the copy now holds;
        // an item a file here embeds is that file's, never unmatched.
        let embedded = {
            let mut hosts = Vec::new();
            for (item, _) in &work {
                if item.version == 0 || bytes_of(item, &catalog).is_some() {
                    continue;
                }
                let bound = state::bound_to_item(&*self.core.conn()?, &item.id)?;
                let placed = self.placement(&item.id)?;
                if let Some(path) = self.path_for(
                    item,
                    placed.as_ref(),
                    bound.as_ref(),
                    &withheld,
                    &settings,
                    &catalog,
                ) {
                    hosts.push((item, path));
                }
            }
            self.embedded(&hosts, &catalog, &lists)?
        };
        report.embeds = embedded.reports;
        let missing: Vec<String> = embedded
            .at
            .keys()
            .filter(|id| !work.iter().any(|(item, _)| &item.id == *id))
            .cloned()
            .collect();
        let found = crate::store::items_by_ids(&*self.core.conn()?, &missing)?;
        for (item, unmatched) in &mut work {
            *unmatched &= !embedded.at.contains_key(&item.id);
        }
        // Held by the file embedding it whatever state the search narrows to;
        // a trashed one's file goes as any trashed item's does.
        work.extend(
            found
                .into_iter()
                .filter(|item| matches!(item.state, ItemState::Active | ItemState::Archived))
                .map(|item| (item, false)),
        );
        members.extend(
            work.iter()
                .filter(|(item, _)| embedded.at.contains_key(&item.id))
                .map(|(item, _)| item.id.clone()),
        );
        report.skipped = skipped.iter().filter(|id| !members.contains(*id)).count();
        // After the pins, so a line names a target the copy now holds.
        let names = Names::load(self, &catalog)?;
        report.unplaced = withheld.len();
        let mut placing: Vec<Placing> = Vec::new();
        let unmatched_ids: Vec<String> = work
            .iter()
            .filter(|(_, unmatched)| *unmatched)
            .map(|(item, _)| item.id.clone())
            .collect();
        report.unmatched = unmatched_ids.len();
        state::set_unmatched(&*self.core.conn()?, &unmatched_ids)?;
        for (item, unmatched) in &work {
            // This device's own create, not yet landed: the id goes back
            // only once it has.
            if item.version == 0 {
                continue;
            }
            let bound = {
                let conn = self.core.conn()?;
                state::bound_to_item(&conn, &item.id)?
            };
            // Bytes the server or this copy did not take are the person's to
            // mend, so the file stays as they wrote it.
            if bound
                .as_ref()
                .is_some_and(|bound| bound.held.is_some() || !bound.writes.refused.is_empty())
            {
                continue;
            }
            // Gone from the disk it is the scan's to journal; written back,
            // a file another folder took in would return.
            if *unmatched
                && bound
                    .as_ref()
                    .is_some_and(|bound| !self.root.join(&bound.path).exists())
            {
                continue;
            }
            // Moved to another folder here and not yet taken there, written
            // anew it would make the moved file read as a copy.
            if bound.is_none() && peers.arriving(&item.id) {
                report.elsewhere += 1;
                continue;
            }
            let taken = match &bound {
                None if !*unmatched => peers.let_go(&item.id),
                _ => None,
            };
            let placed = self.placement(&item.id)?;
            // An embedded file goes where its link says, and its placement
            // follows.
            let Some(want) = embedded
                .at
                .get(&item.id)
                .cloned()
                .or_else(|| {
                    self.path_for(
                        item,
                        placed.as_ref(),
                        bound.as_ref(),
                        &withheld,
                        &settings,
                        &catalog,
                    )
                })
                // A name its file already has in another case or form is that
                // file's, which keeps its own name.
                .map(|want| match &bound {
                    Some(bound) if names::same(&bound.path, &want) => bound.path.clone(),
                    _ => want,
                })
                .filter(|want| self.writes_at(&lists, want))
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
                taken,
            });
        }
        // Ranked by what the server holds, so every machine gives a shared
        // path to the same item; stable, so the listing orders the rest.
        placing.sort_by(|a, b| a.rank.cmp(&b.rank));
        // Compared as a folder compares names, so two items never get paths
        // one disk holds as one file.
        let wanted: HashSet<String> = placing
            .iter()
            .map(|entry| names::folded(&entry.want))
            .collect();
        let mut taken: HashSet<String> = HashSet::new();
        for entry in &mut placing {
            if taken.contains(&names::folded(&entry.want)) {
                let own = entry.bound.as_ref().map(|bound| bound.path.as_str());
                let free = |candidate: &str| {
                    let name = names::folded(candidate);
                    !taken.contains(&name)
                        && self.writes_at(&lists, candidate)
                        && (own == Some(candidate)
                            || !wanted.contains(&name) && !self.root.join(candidate).exists())
                };
                entry.want = beside(&entry.want, |candidate| !free(candidate));
                report.beside += 1;
            }
            taken.insert(names::folded(&entry.want));
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
            .map(|bound| names::folded(&bound.path))
            .collect();
        let mut waiting = Vec::new();
        let rendering = Rendering {
            catalog: &catalog,
            edge_types: &edge_types,
            names: &names,
        };
        for entry in placing {
            if self.write_placed(&entry, &rendering, &withheld, Some(&leaving), &mut report)? {
                waiting.push(entry);
            }
        }
        for entry in waiting {
            self.write_placed(&entry, &rendering, &withheld, None, &mut report)?;
        }
        self.remove_departed(&members, &settings, &lists, &mut report)?;
        report.flagged = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
                .into_iter()
                // A file held and refused both says both.
                .flat_map(|bound| {
                    let held = bound
                        .held
                        .as_deref()
                        .map(|held| Flagged::of(&bound.path, held));
                    let refused = bound.writes.refused.last().map(|refused| Flagged {
                        path: bound.path.clone(),
                        flag: "refused",
                        reason: refused.reason.clone(),
                    });
                    held.into_iter().chain(refused)
                })
                .collect()
        };
        report.uncarried = fields::uncarried(&catalog, &edge_types, |r#type| {
            settings.holds_type(&catalog, r#type)
        });
        report.settings = self.write_settings_if_moved()?;
        Ok(report)
    }

    /// Leaves a file changed since the scan read it alone: the permission is
    /// then the person's.
    fn keep_executable(&self, item: &Item, want: &str) -> Result<()> {
        let path = self.root.join(want);
        let wanted = executable::held(item);
        if !self.keeps_permissions()
            || std::fs::symlink_metadata(&path).is_ok_and(|found| executable::of(&found) == wanted)
        {
            return Ok(());
        }
        let read = state::stat_of(&*self.core.conn()?, want)?;
        if read.is_some() && read == stat_of(&path) {
            // As a write's is: a refused permission is not the pull's to fail.
            let _ = executable::set(&path, wanted);
        }
        Ok(())
    }

    fn keeps_permissions(&self) -> bool {
        *self
            .permissions
            .get_or_init(|| executable::kept(&self.root.join(STATE_DIR)))
    }

    /// Answers whether it waits for the file at that path to move away first.
    fn write_placed(
        &self,
        entry: &Placing<'_>,
        rendering: &Rendering<'_>,
        withheld: &placement::Withheld,
        leaving: Option<&HashSet<String>>,
        report: &mut PullReport,
    ) -> Result<bool> {
        let Placing {
            item,
            bound,
            want,
            taken,
            ..
        } = entry;
        let (item, want) = (*item, want.clone());
        let catalog = rendering.catalog;
        if let Some((from, theirs)) = taken
            && self.take_in(item, &want, from, theirs, withheld, report)?
        {
            return Ok(false);
        }
        let path = self.root.join(&want);
        let (bytes, wrote, lines) = match bytes_of(item, catalog) {
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
                    Some(found) => {
                        self.core.let_go_blob(blob);
                        (found, Vec::new(), Vec::new())
                    }
                    None => match self.core.blob(blob).map(std::fs::read) {
                        Ok(Ok(found)) => (found, Vec::new(), Vec::new()),
                        // A refused credential refuses every file alike.
                        Err(error @ CoreError::Unauthorized { .. }) => return Err(error),
                        // A held copy that cannot be read is one file's failure too.
                        Ok(Err(_)) | Err(_) => {
                            report.absent += 1;
                            return Ok(false);
                        }
                    },
                }
            }
            None => {
                // The lines the person typed, where they still name their
                // items, are left as typed.
                let typed = bound
                    .as_ref()
                    .filter(|bound| carries_frontmatter(Path::new(&bound.path)))
                    .and_then(|bound| std::fs::read_to_string(self.root.join(&bound.path)).ok())
                    .map(|text| document::read(&text).front);
                let rendered = self.render(
                    item,
                    &want,
                    Some(item.version),
                    catalog,
                    rendering.edge_types,
                    (
                        rendering.names,
                        typed.as_ref(),
                        bound.as_ref().map_or(&[][..], |bound| &bound.lines),
                    ),
                )?;
                (rendered.text.into_bytes(), rendered.links, rendered.lines)
            }
        };
        let hash = state::hash(&bytes);
        let ours = bound.as_ref().is_some_and(|bound| bound.path == want);
        // A file the person deleted whose item moved on in nothing it shows is
        // the scan's, and its journaled delete stands.
        if let Some(bound) = &bound
            && bytes_of(item, catalog).is_none()
            && self.deleted_as_agreed(item, bound, rendering)?
        {
            return Ok(false);
        }

        // The bytes on the disk, not the mapping's memory of them: a file
        // changed since the scan read it is the person's.
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
            Some(bound) if ours => self.behind_by_its_line_alone(item, bound, rendering)?,
            _ => false,
        };
        // Something at the destination that is not this item's own file,
        // unless it is byte for byte this item's render.
        let occupied = !in_place && !ours && path.exists();
        let rebound =
            occupied && bound.is_none() && std::fs::read(&path).is_ok_and(|found| found == bytes);
        if occupied && !rebound {
            if leaving.is_some_and(|leaving| leaving.contains(&names::folded(&want))) {
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
                    lines,
                    edit_line: None,
                    held: None,
                    own,
                    writes: state::Writes::default(),
                },
            )?;
            state::journal_clear(&conn, &want)?;
            report.unchanged += 1;
            return Ok(false);
        }
        if in_place {
            if bytes_of(item, catalog).is_some() {
                self.keep_executable(item, &want)?;
            }
            report.placed += usize::from(self.place(&item.id, &want, withheld)?);
            report.unchanged += 1;
            return Ok(false);
        }

        // Written over an edit still waiting, the line it writes is spent
        // too, since the file holds that edit.
        let mut writes = bound
            .as_ref()
            .map(|bound| bound.writes.clone())
            .unwrap_or_default();
        let mut edit_line = bound.as_ref().and_then(|bound| bound.edit_line);
        let waiting: HashSet<String> =
            crate::store::waiting_writes_for_item(&*self.core.conn()?, &item.id)?
                .into_iter()
                .map(|write| write.id)
                .collect();
        if carries_frontmatter(Path::new(&want)) && !waiting.is_empty() {
            let mut lifted = false;
            // An answered or dead edit's entry is no edit the file holds unanswered.
            for line in writes
                .queued
                .iter_mut()
                .filter(|queued| waiting.contains(&queued.id))
                .filter_map(|queued| queued.line.as_mut())
            {
                *line = (*line).max(item.version);
                lifted = true;
            }
            // An edit queued outside this file has no entry here to carry it.
            if !lifted {
                edit_line = Some(edit_line.unwrap_or(0).max(item.version));
            }
        }
        let binding = |identity: Option<String>| state::Bound {
            path: want.clone(),
            item_id: item.id.clone(),
            identity,
            content_hash: hash.clone(),
            written_hash: Some(hash.clone()),
            links: wrote.clone(),
            lines: lines.clone(),
            edit_line,
            held: None,
            own: own.clone(),
            writes: writes.clone(),
        };
        // Bound before the write, so the scan never reads it back; a path the
        // filesystem refuses leaves the old file, and every other, as it was.
        state::bind(&*self.core.conn()?, &binding(None))?;
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, &bytes));
        if written.is_ok() && bytes_of(item, catalog).is_some() && self.keeps_permissions() {
            // The bytes are written and bound whatever the permission does.
            let _ = executable::set(&path, executable::held(item));
        }
        if written.is_err() {
            // A file of its own here keeps the binding it had, or a scan that
            // can reach it again would make it a new item.
            let conn = self.core.conn()?;
            match bound.as_ref().filter(|bound| bound.path == want) {
                Some(bound) => state::bind(&conn, bound)?,
                None => state::unbind(&conn, &want)?,
            }
            report.unwritten += 1;
            return Ok(false);
        }
        if let Some(blob) = bytes_of(item, catalog) {
            self.core.let_go_blob(blob);
        }
        {
            let conn = self.core.conn()?;
            // Only this item's row: another's is a delete this write does not answer.
            if journaled_for(&conn, &want, &item.id)? {
                report.revived += 1;
                state::journal_clear_for(&conn, &want, &item.id)?;
            }
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
            if journaled_for(&conn, &bound.path, &item.id)? {
                report.revived += 1;
            }
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

    /// Bound before it lands. Answers whether it did.
    fn take_in(
        &self,
        item: &Item,
        want: &str,
        from: &Path,
        theirs: &state::Bound,
        withheld: &placement::Withheld,
        report: &mut PullReport,
    ) -> Result<bool> {
        let path = self.root.join(want);
        if path.exists() {
            return Ok(false);
        }
        // Read again, since fetching other files' bytes since the pull chose
        // it leaves time for an edit its folder has yet to send.
        if !std::fs::read(from).is_ok_and(|bytes| state::hash(&bytes) == theirs.content_hash) {
            return Ok(false);
        }
        let binding = |identity: Option<String>| state::Bound {
            path: want.to_string(),
            item_id: item.id.clone(),
            identity,
            content_hash: theirs.content_hash.clone(),
            written_hash: Some(theirs.content_hash.clone()),
            links: theirs.links.clone(),
            lines: theirs.lines.clone(),
            edit_line: None,
            held: None,
            own: theirs.own.clone(),
            writes: state::Writes::default(),
        };
        state::bind(&*self.core.conn()?, &binding(None))?;
        let moved = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| {
                // Copied where a rename cannot cross volumes; a source left
                // behind is still its folder's, which lets it go later.
                std::fs::rename(from, &path).or_else(|_| {
                    std::fs::copy(from, &path).map(|_| {
                        let _ = std::fs::remove_file(from);
                    })
                })
            });
        if moved.is_err() {
            state::unbind(&*self.core.conn()?, want)?;
            return Ok(false);
        }
        state::journal_clear(&*self.core.conn()?, want)?;
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && let Some(found) = identity::of(&metadata)
        {
            state::bind(&*self.core.conn()?, &binding(Some(found.key())))?;
        }
        report.placed += usize::from(self.place(&item.id, want, withheld)?);
        report.taken += 1;
        Ok(true)
    }

    /// Trashes nothing. Answers whether it did.
    fn let_go(&self, item_id: &str, peers: &Peers<'_>, report: &mut PullReport) -> Result<bool> {
        let Some(bound) = state::bound_to_item(&*self.core.conn()?, item_id)? else {
            return Ok(false);
        };
        let path = self.root.join(&bound.path);
        let own = std::fs::read(&path)
            .is_ok_and(|found| bound.written_hash.as_deref() == Some(state::hash(&found).as_str()));
        if !own || !plainly_inside(&self.root, &bound.path) || !peers.filed_elsewhere(item_id) {
            return Ok(false);
        }
        std::fs::remove_file(&path).map_err(|error| {
            CoreError::Store(format!("cannot remove {}: {error}", path.display()))
        })?;
        let conn = self.core.conn()?;
        state::unbind(&conn, &bound.path)?;
        state::journal_clear(&conn, &bound.path)?;
        report.let_go += 1;
        Ok(true)
    }

    /// Answered by the local list so the folder and a list read one grammar
    /// alike.
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

    fn remove_departed(
        &self,
        members: &HashSet<String>,
        settings: &Settings,
        lists: &Lists,
        report: &mut PullReport,
    ) -> Result<()> {
        let (bound, of) = {
            let conn = self.core.conn()?;
            (state::every_bound(&conn)?, state::bound_count(&conn)?)
        };
        let mut going: Vec<state::Bound> = Vec::new();
        for row in bound {
            match self.departing(&row, members, settings, lists)? {
                Departing::No => {}
                Departing::Kept => report.kept += 1,
                Departing::Unread => report.unwritten += 1,
                Departing::Yes => going.push(row),
            }
        }
        // Many files taken away at once is more often a mistake made elsewhere
        // than a wish, so they stay until confirmed.
        let paths: Vec<String> = going.iter().map(|row| row.path.clone()).collect();
        if settings.removal_threshold.exceeded(going.len(), of) {
            state::set_paused(&*self.core.conn()?, state::Removal::Pull, &paths)?;
            report.paused = going.len();
            return Ok(());
        }
        state::set_paused(&*self.core.conn()?, state::Removal::Pull, &[])?;
        for row in going {
            self.take_away(&row)?;
            report.removed += 1;
        }
        Ok(())
    }

    fn departing(
        &self,
        row: &state::Bound,
        members: &HashSet<String>,
        settings: &Settings,
        lists: &Lists,
    ) -> Result<Departing> {
        // A file the lists no longer take is neither read nor written.
        if members.contains(&row.item_id) || !self.writes_at(lists, &row.path) {
            return Ok(Departing::No);
        }
        let held = {
            let conn = self.core.conn()?;
            crate::store::items_by_ids(&conn, std::slice::from_ref(&row.item_id))?.pop()
        };
        // A row the copy lost is the scan's to report.
        let Some(item) = held else {
            return Ok(Departing::No);
        };
        if settings.holds_state(item.state) {
            return Ok(Departing::No);
        }
        Ok(match std::fs::read(self.root.join(&row.path)) {
            Ok(found) if row.written_hash.as_deref() != Some(state::hash(&found).as_str()) => {
                Departing::Kept
            }
            Ok(_) => Departing::Yes,
            // The person's delete is newer than the departure: the scan journals
            // it, and sends it unless the item is in the bin.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Departing::No,
            // Bytes it cannot read are not shown to be the folder's own.
            Err(_) => Departing::Unread,
        })
    }

    /// A journal row here is a file put back since its scan, so it asks for
    /// nothing now.
    fn take_away(&self, row: &state::Bound) -> Result<()> {
        let path = self.root.join(&row.path);
        if path.exists() && plainly_inside(&self.root, &row.path) {
            std::fs::remove_file(&path).map_err(|error| {
                CoreError::Store(format!("cannot remove {}: {error}", path.display()))
            })?;
        }
        let conn = self.core.conn()?;
        state::unbind(&conn, &row.path)?;
        state::journal_clear(&conn, &row.path)
    }

    fn deleted_as_agreed(
        &self,
        item: &Item,
        bound: &state::Bound,
        rendering: &Rendering<'_>,
    ) -> Result<bool> {
        if self.root.join(&bound.path).exists()
            || !journaled_for(&*self.core.conn()?, &bound.path, &item.id)?
        {
            return Ok(false);
        }
        let line = carries_frontmatter(Path::new(&bound.path))
            .then(|| bound.own.as_ref().map(|own| own.line))
            .flatten();
        let rendered = self.render(
            item,
            &bound.path,
            line,
            rendering.catalog,
            rendering.edge_types,
            (rendering.names, None, &bound.lines),
        )?;
        Ok(state::hash(rendered.text.as_bytes()) == bound.content_hash)
    }

    /// Whether a file differs from its item's render in its version line
    /// alone, with no edit of its own landed since.
    fn behind_by_its_line_alone(
        &self,
        item: &Item,
        bound: &state::Bound,
        rendering: &Rendering<'_>,
    ) -> Result<bool> {
        if !carries_frontmatter(Path::new(&bound.path)) {
            return Ok(false);
        }
        let Ok(found) = std::fs::read_to_string(self.root.join(&bound.path)) else {
            return Ok(false);
        };
        let front = document::read(&found).front;
        let line = line_of(&front);
        // A line no newer than the one its own edit spent is rewritten once
        // that edit lands.
        if bound
            .spent()
            .is_some_and(|spent| line.unwrap_or(0) <= spent)
            && !crate::store::item_waits(&*self.core.conn()?, &item.id)?
        {
            return Ok(false);
        }
        let rendered = self.render(
            item,
            &bound.path,
            line,
            rendering.catalog,
            rendering.edge_types,
            (rendering.names, Some(&front), &bound.lines),
        )?;
        Ok(state::hash(rendered.text.as_bytes()) == bound.content_hash)
    }

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

    fn render(
        &self,
        item: &Item,
        path: &str,
        line: Option<i64>,
        catalog: &Catalog,
        edge_types: &EdgeTypes,
        lines: LinesBy<'_>,
    ) -> Result<Rendered> {
        let body_field = fields::body_field(catalog, &item.r#type);
        let body = item
            .properties
            .get(body_field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let mut links = Vec::new();
        for text in document::links(&body) {
            if let Some(id) = self.resolve_link(&text)?
                && !links.contains(&id)
            {
                links.push(id);
            }
        }
        if !carries_frontmatter(Path::new(path)) {
            return Ok(Rendered {
                text: body,
                links,
                lines: Vec::new(),
            });
        }
        let embedded: Vec<String> = self
            .shown_in(item, path, &body, catalog)?
            .into_iter()
            .filter_map(|shown| shown.item)
            .collect();
        let mut front = fields::lines_of(item);
        for (field, value) in &item.properties {
            if field != body_field && !fields::reserved(field, edge_types) {
                front.insert(field.clone(), value.clone());
            }
        }
        let (names, typed, recorded) = lines;
        let (entries, written) = self.lines_for(
            item,
            edge_types,
            catalog,
            names,
            typed,
            (&links, &embedded),
            recorded,
        )?;
        front.extend(entries);
        front.insert(ID_FIELD.into(), Value::String(item.id.clone()));
        if let Some(line) = line {
            front.insert(VERSION_FIELD.into(), Value::from(line));
        }
        Ok(Rendered {
            text: document::write(&front, &body)?,
            links,
            lines: written,
        })
    }

    /// Pins the other end of every edge a file here writes, so its line has a
    /// title to show, and every attachment of a document, so an embed can name
    /// it; the record of them holds each such pin.
    fn hold_edge_ends(
        &self,
        work: &[(Item, bool)],
        edge_types: &EdgeTypes,
        catalog: &Catalog,
    ) -> Result<()> {
        let mut wanted: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for (item, _) in work {
            if bytes_of(item, catalog).is_none() {
                let recorded = state::bound_to_item(&*self.core.conn()?, &item.id)?
                    .map(|bound| bound.lines)
                    .unwrap_or_default();
                wanted.extend(self.written_ends(item, edge_types, catalog, &recorded)?);
                wanted.extend(
                    self.core
                        .edges_to(&item.id)?
                        .into_iter()
                        .filter(|edge| edge.edge_type == ATTACHMENT_EDGE)
                        .map(|edge| edge.source_id),
                );
            }
        }
        let recorded: HashMap<String, bool> =
            state::edge_ends(&*self.core.conn()?)?.into_iter().collect();
        for id in &wanted {
            if recorded.contains_key(id) {
                continue;
            }
            let (held, pinned) = {
                let conn = self.core.conn()?;
                (
                    crate::store::item_held(&conn, id)?,
                    crate::store::pinned(&conn, id)?,
                )
            };
            // Another holder's pin is held, never taken as the folder's own.
            let made = if pinned {
                false
            } else if held {
                crate::store::pin(&*self.core.conn()?, id)?
            } else {
                // Unreadable now, offline or gone: the line names it by id.
                match self.core.pin(id) {
                    Ok(_) => true,
                    Err(
                        CoreError::NoServer
                        | CoreError::NotFound { .. }
                        | CoreError::Forbidden { .. },
                    ) => continue,
                    Err(error) if error.is_environmental() => continue,
                    Err(error) => return Err(error),
                }
            };
            state::hold_edge_end(&*self.core.conn()?, id, made)?;
        }
        let conn = self.core.conn()?;
        for (id, made) in recorded {
            if !wanted.contains(&id) {
                state::release_edge_end(&conn, &id, made)?;
            }
        }
        Ok(())
    }
}

/// What a render writes lines by: the copy's names, the file's own lines,
/// and the edges its record says it carried.
type LinesBy<'a> = (&'a Names, Option<&'a Map<String, Value>>, &'a [state::Line]);

struct Rendering<'a> {
    catalog: &'a Catalog,
    edge_types: &'a EdgeTypes,
    names: &'a Names,
}

struct Rendered {
    text: String,
    links: Vec<String>,
    lines: Vec<state::Line>,
}

#[derive(Default)]
struct Kept {
    edit_line: Option<i64>,
    own: Option<fields::OwnBase>,
    held: Option<String>,
    writes: state::Writes,
}

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

#[derive(Debug, Clone, Copy, PartialEq)]
enum Standing {
    /// The version the copy holds: sent whole, own lines and all.
    Current,
    /// Behind only by an edit of its own, which it holds.
    Spent,
    /// An older version: merged against it, with no own-field change.
    Behind(i64),
    /// No version line, or one newer than the copy's.
    Lineless,
}

struct OwnRead {
    changes: OwnChanges,
    base: Option<fields::OwnBase>,
    flag: Option<String>,
    tags: Option<Vec<String>>,
    state: Option<ItemState>,
}

/// Three-way against the folder's own last write of the file.
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
            tags: lines.tags.clone(),
            state: lines.state,
            flag: (!differ.is_empty()).then(|| {
                let why = match file_line {
                    None => "the file has no version line",
                    Some(line) if line > held.version => {
                        "its version line names a version this copy does not hold"
                    }
                    Some(_) => "the file is behind the item",
                };
                format!(
                    "{} not sent: {why}, so its own-field lines cannot be told from an old buffer's; reload it",
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
    let tags = lines.tags.clone().or_else(|| clears.then(Vec::new));
    if let Some(tags) = &tags {
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
        tags,
        state,
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

fn blank(value: &Value) -> bool {
    value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
}

fn unsuited_type(r#type: &str, catalog: &Catalog) -> Option<String> {
    if !catalog.known(r#type) {
        return Some(format!("{type} is not a type this copy holds"));
    }
    catalog
        .matches(FILE_TYPE, r#type)
        .then(|| format!("{type} is a file type, whose items are bytes rather than documents"))
}

enum Departing {
    No,
    Kept,
    Unread,
    Yes,
}

struct Placing<'a> {
    item: &'a Item,
    bound: Option<state::Bound>,
    want: String,
    rank: placement::Rank,
    taken: Option<(PathBuf, state::Bound)>,
}

fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_lowercase)
}

fn carries_frontmatter(path: &Path) -> bool {
    matches!(extension_of(path).as_deref(), Some("md" | "markdown"))
}

/// What a quick pass compares with what its last read recorded.
fn stat_of(path: &Path) -> Option<String> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!(
        "{}:{modified}:{}",
        metadata.len(),
        executable::of(&metadata)
    ))
}

fn is_document(path: &Path) -> bool {
    carries_frontmatter(path) || extension_of(path).as_deref() == Some("txt")
}

fn bytes_of<'a>(item: &'a Item, catalog: &Catalog) -> Option<&'a str> {
    if !catalog.matches(FILE_TYPE, &item.r#type) {
        return None;
    }
    item.properties.get("blob_ref").and_then(Value::as_str)
}

fn bytes_type(path: &Path, catalog: &Catalog) -> Option<String> {
    if is_document(path) {
        return None;
    }
    let named = crate::blob::file_type_for(&crate::blob::mime_type_for(path, None), None);
    Some(if catalog.known(&named) {
        named
    } else {
        FILE_TYPE.to_string()
    })
}

const FILE_TYPE: &str = "core.file";

pub const LINK_EDGE: &str = "references";

/// Only a version the server could have minted.
fn line_of(front: &Map<String, Value>) -> Option<i64> {
    version_named(front.get(VERSION_FIELD)?)
}

fn version_named(line: &Value) -> Option<i64> {
    // An editor typing the line as text writes it quoted.
    let number = match line {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        other => other.as_f64()?,
    };
    // `1.0` is the version 1; `1.5` names none.
    (number.fract() == 0.0 && number >= 1.0 && number <= i64::MAX as f64).then_some(number as i64)
}

/// `hydrated` where the log had aged past the cursor or the settings ask for
/// another slice.
#[derive(Debug, Clone, Serialize)]
pub struct CaughtUp {
    pub caught_up: Option<crate::model::CatchUpReport>,
    pub hydrated: Option<crate::model::HydrateReport>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PullReport {
    pub written: usize,
    pub rewritten: usize,
    pub moved: usize,
    pub unchanged: usize,
    pub skipped: usize,
    pub absent: usize,
    pub unwritten: usize,
    pub revived: usize,
    pub outside: usize,
    pub beside: usize,
    pub unsuited: usize,
    pub unplaced: usize,
    pub placed: usize,
    pub removed: usize,
    pub kept: usize,
    pub paused: usize,
    pub unmatched: usize,
    pub taken: usize,
    pub elsewhere: usize,
    pub let_go: usize,
    pub settings: SettingsFileReport,
    pub flagged: Vec<Flagged>,
    pub uncarried: Vec<Uncarried>,
    pub embeds: Vec<Flagged>,
}

/// A guard, not a boundary: the write resolves the path again.
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
