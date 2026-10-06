pub mod document;
pub mod edge_types;
mod elsewhere;
mod embeds;
mod executable;
mod fault;
pub mod fields;
mod first;
pub mod identity;
mod landing;
mod lines;
pub mod lists;
mod names;
pub(crate) mod placement;
mod preserve;
mod removal;
pub(crate) use first::waiting;
pub use first::{FirstSync, Synced};
pub use removal::{Confirmed, Restored};
pub mod registry;
pub mod settings;
mod settings_file;
mod status;
mod sync;
mod transfer;
mod watch;
pub use status::{FileStatus, FirstSyncStatus, Paused, StatusReport};
pub use sync::SyncReport;
pub use watch::{RETRY_MOST, WatchError, WatchEvent, WatchPass};
pub mod state;

use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::model::{BlockedReason, Draft, Edit, Item, ItemState, WriteKind};
use crate::{Core, Result, Server};

use crate::body::embed::{FILE_TYPE, bytes_of, carries_frontmatter, is_document};
use crate::body::resolve::{Names, Resolver};
use crate::names::{name_of, title_of};
use edge_types::EdgeTypes;
use elsewhere::{Look, Peers};
use embeds::ATTACHMENT_EDGE;
pub use fields::{ID_FIELD, Uncarried, VERSION_FIELD};
use lines::{BoundFiles, EdgeWork};
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

/// Each held as `encoding`, by the same binding an `unreadable` file is.
const NOT_UTF8: &str = "it is not UTF-8 text; saved as UTF-8, it is sent";
const HOLDS_NUL: &str = "it holds a NUL byte, as UTF-16 text does, so it is not read as text; saved as UTF-8 with no NUL, it is sent";

fn encoding(reason: &str) -> bool {
    reason == NOT_UTF8 || reason == HOLDS_NUL
}

/// UTF-8 holding no NUL, or why not: UTF-16 with no byte-order mark decodes
/// as UTF-8 where its letters are ASCII, each beside a NUL.
fn text_of(bytes: &[u8]) -> std::result::Result<&str, &'static str> {
    let text = std::str::from_utf8(bytes).map_err(|_| NOT_UTF8)?;
    if text.contains('\0') {
        return Err(HOLDS_NUL);
    }
    Ok(text)
}

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
        item: None,
    })
}

pub struct Folder {
    root: PathBuf,
    folder: String,
    core: Core,
    key: std::sync::Mutex<Option<placement::KeyRead>>,
    permissions: std::sync::OnceLock<bool>,
    /// The identity of the store this handle opened, which a directory
    /// put in the folder's place does not hold.
    store_mark: Option<String>,
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
    /// Files that are not documents left for a later pass, still changing.
    pub settling: Vec<String>,
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
    /// Why the pass read nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
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
    /// The item whose file this is, where a pull did not write it or could
    /// not let it go to another folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
}

/// A scan's flagged files and then a pull's, each once: two items a pull did
/// not write at one path are two entries.
pub fn merged_flagged<'a>(
    scan: &[Flagged],
    pull: impl IntoIterator<Item = &'a Flagged>,
) -> Vec<Flagged> {
    let mut flagged = scan.to_vec();
    for file in pull {
        if !flagged
            .iter()
            .any(|seen| seen.path == file.path && seen.item == file.item)
        {
            flagged.push(file.clone());
        }
    }
    flagged
}

impl Flagged {
    fn of(path: &str, held: &str) -> Flagged {
        let (flag, reason) = if let Some(reason) = held.strip_prefix(state::UNREADABLE) {
            (
                if encoding(reason) {
                    "encoding"
                } else {
                    "unreadable"
                },
                reason,
            )
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
            item: None,
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
        let core = working(Core::open(state.join("core.sqlite"), Some(server))?)?;
        let fresh = settings_file::bound(&core)?.is_none();
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
            store_mark: store_mark(&state),
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
        // Only a store made now has never synced: one added again over its
        // own state keeps what it was asked.
        if fresh {
            added.wait_for_confirmation()?;
        }
        if let settings_file::Wrote::Failed(reason) =
            added.write_settings_file(&row.item.properties, row.item.version, None)?
        {
            return Err(CoreError::Store(reason));
        }
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
        if !state.join("core.sqlite").exists() {
            return Err(not_a_folder(&root));
        }
        let core = working(Core::open(state.join("core.sqlite"), server)?)?;
        let folder = settings_file::bound(&core)?.ok_or_else(|| not_a_folder(&root))?;
        let opened = Folder {
            root,
            folder,
            core,
            key: std::sync::Mutex::new(None),
            permissions: std::sync::OnceLock::new(),
            store_mark: store_mark(&state),
        };
        // A lost registry is the scan's to notice before listing again.
        if let Some(registry) = Registry::located()
            && !elsewhere::lost(&opened.core, &registry)
        {
            let _ = opened.register();
        }
        Ok(opened)
    }

    /// Reads the store without claiming it, so it answers beside a running
    /// watch and never keeps one from starting.
    pub fn status_of(root: impl AsRef<Path>) -> Result<StatusReport> {
        let root = root.as_ref().to_path_buf();
        let state = root.join(STATE_DIR);
        if !state.join("core.sqlite").exists() {
            return Err(not_a_folder(&root));
        }
        let core = Core::open_reader(state.join("core.sqlite"))?;
        let folder = settings_file::bound(&core)?.ok_or_else(|| not_a_folder(&root))?;
        Folder {
            root,
            folder,
            core,
            key: std::sync::Mutex::new(None),
            permissions: std::sync::OnceLock::new(),
            store_mark: store_mark(&state),
        }
        .status()
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

    /// Leaves the folder's files; refused while writes wait, unless the first
    /// sync still waits to be confirmed.
    pub fn remove(self) -> Result<()> {
        // A first sync still waiting has sent nothing, so its queue holds
        // only what the scan read from files that stay.
        let waiting = if self.awaiting_confirmation()? {
            0
        } else {
            self.core
                .queue()?
                .iter()
                .filter(|write| {
                    matches!(write.verdict, None | Some(crate::model::Verdict::Blocked))
                })
                .count()
        };
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

    /// The path, from the folder's root, of the file bound to the item, if
    /// one is.
    pub fn file_of(&self, item_id: &str) -> Result<Option<String>> {
        Ok(state::bound_to_item(&*self.core.conn()?, item_id)?.map(|bound| bound.path))
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
        self.hydrate_until(&crate::NEVER_STOPPED)
    }

    fn hydrate_until(&self, stop: &AtomicBool) -> Result<crate::model::HydrateReport> {
        let row = self.row_on_server()?;
        let settings = Settings::of_wire(&row.item)?;
        let fetched = self.core.http()?.catalog()?;
        let planning = crate::store::open_in_memory()?;
        crate::store::replace_catalog(&planning, &fetched)?;
        let edge_types = EdgeTypes::load(&planning)?;
        crate::store::pin(&*self.core.conn()?, &self.folder)?;
        let catalog = Catalog::load(&planning)?;
        let whole = whole_edge_types(&settings, &edge_types, &catalog);
        self.core
            .hydrate_every_type_or(settings.types(), settings.tier().into(), &whole, stop)
    }

    /// `None` where the copy already answers for the slice the settings ask.
    pub fn resume(&self) -> Result<Option<crate::model::HydrateReport>> {
        self.resume_until(&crate::NEVER_STOPPED)
    }

    /// `resume`, ended with `Canceled` soon after `stop` is raised.
    fn resume_until(&self, stop: &AtomicBool) -> Result<Option<crate::model::HydrateReport>> {
        if crate::store::hydrated(&*self.core.conn()?)? && !self.slice_moved()? {
            return Ok(None);
        }
        self.hydrate_until(stop).map(Some)
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
        Ok(held != asked || tier != settings.tier().into() || whole != wanted)
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
            Err(CoreError::CopyExpired { .. }) => Ok(CaughtUp {
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
        self.not_writing_at(lists, path).is_none()
    }

    /// Why the folder does not write at `path`, where it does not.
    fn not_writing_at(&self, lists: &Lists, path: &str) -> Option<&'static str> {
        if !plainly_inside(&self.root, path) {
            Some("the path leads out of the folder")
        } else if !lists.takes(path) {
            Some("the folder's lists do not take the path")
        } else if in_package(&self.root, path) {
            Some("the path is inside a package")
        } else if in_nested_folder(&self.root, path) {
            Some("the path is inside another folder")
        } else {
            None
        }
    }
}

fn not_a_folder(root: &Path) -> CoreError {
    CoreError::Invalid(format!(
        "{} is not a folder; `folders add` makes one",
        root.display()
    ))
}

/// One process works a folder at a time: every working path starts from a
/// `Folder` this makes, so a second opener is refused before it reads or
/// writes a file, a binding or the server.
fn working(core: Core) -> Result<Core> {
    core.lock.refuse_unless_writer()?;
    Ok(core)
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

impl Folder {
    /// Writes a file into the folder, through `inside`, which every write
    /// and every rename into the folder passes: refused where the folder's
    /// directory is gone, so a pull never makes it anew.
    fn land(
        &self,
        path: &Path,
        fill: impl FnOnce(&mut std::fs::File, &Path) -> std::io::Result<()>,
        still: impl FnOnce(Option<&[u8]>) -> bool,
    ) -> std::result::Result<(), landing::Unlanded> {
        self.inside(path.parent())?;
        landing::land(path, fill, still)
    }

    /// Makes the directories from the folder's root down to `dir`, never the
    /// root itself, and fails where the folder's directory is gone.
    fn inside(&self, dir: Option<&Path>) -> std::io::Result<()> {
        if let Some(gone) = self.root_gone() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, gone));
        }
        let Some(below) = dir.and_then(|dir| dir.strip_prefix(&self.root).ok()) else {
            return Ok(());
        };
        let mut here = self.root.clone();
        for part in below.components() {
            here.push(part);
            match std::fs::create_dir(&here) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

/// The store's inode and birth time, and not its device: a volume mounted
/// again can come back under another device number, while the two its
/// filesystem keeps for the file stay.
#[cfg(unix)]
fn store_mark(state: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(state.join("core.sqlite")).ok()?;
    let born = identity::born(&metadata)?;
    Some(format!("{}:{born}", metadata.ino()))
}

#[cfg(not(unix))]
fn store_mark(_state: &Path) -> Option<String> {
    None
}

impl Folder {
    /// `Some` with why where the folder's directory is not where this handle
    /// found it: moved, renamed, on a volume no longer mounted, or another
    /// directory put in its place. Every file would then read as deleted, so
    /// a pass reads and writes nothing until it is back.
    fn root_gone(&self) -> Option<String> {
        let state = self.root.join(STATE_DIR);
        match std::fs::metadata(state.join("core.sqlite")) {
            Ok(_) if self.store_mark.is_none() || store_mark(&state) == self.store_mark => None,
            Ok(_) => Some(format!(
                "{} is no longer the directory this folder opened, so nothing in it is read or written; open the folder again where it now is",
                self.root.display()
            )),
            Err(_) => Some(format!(
                "{} cannot be found: moved, renamed or on a volume no longer mounted, so nothing is read, written or deleted until it is back",
                self.root.display()
            )),
        }
    }

    /// For a command that has nothing to report a gone directory in.
    fn refuse_if_gone(&self) -> Result<()> {
        match self.root_gone() {
            Some(gone) => Err(CoreError::Invalid(gone)),
            None => Ok(()),
        }
    }
}

/// Bounded, so a copy that keeps changing ends the pull with
/// `local_copy_changed` rather than holding it for good.
const PULL_ATTEMPTS: usize = 3;

/// Called with the connection held until the bind, since a catch-up applies
/// its events under the same lock: a row purged or gone from the slice since
/// the pull read it is not given a file, and the pull reads again.
fn refuse_unless_held(conn: &rusqlite::Connection, item_id: &str) -> Result<()> {
    if crate::store::item_held(conn, item_id)? {
        Ok(())
    } else {
        Err(crate::read_view::Context::changed())
    }
}

pub fn copy_changed(error: &CoreError) -> bool {
    matches!(error, CoreError::StreamIncomplete { reason } if reason == "local_copy_changed")
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
    /// Files a crashed write left beside their target.
    left: Vec<PathBuf>,
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
        // Gone while the walk read it: moved or renamed, its files are
        // somewhere this walk did not look.
        let (flag, reason) = if error.kind() == std::io::ErrorKind::NotFound {
            (
                "gone",
                "went away while the walk read it, so this pass journals no missing file".into(),
            )
        } else {
            (
                "unreadable",
                format!("cannot be read ({error}), so the files bound in it are held"),
            )
        };
        let path = identity::relative(root, dir).unwrap_or_default();
        if !self.directories.iter().any(|dir| dir.path == path) {
            self.directories.push(Flagged {
                path,
                flag,
                reason,
                item: None,
            });
        }
    }

    fn vanished(&self) -> bool {
        self.directories.iter().any(|dir| dir.flag == "gone")
    }
}

/// A directory it cannot read is reported and passed over, so one does not
/// stop the scan of every other.
fn walk(root: &Path, dir: &Path, lists: &Lists, walked: &mut Walked) {
    if let Some(gone) = fault::named("vanish-while-walking")
        && identity::relative(root, dir).is_ok_and(|relative| relative == gone)
    {
        let _ = std::fs::rename(dir, root.join(format!("{gone}.vanished")));
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
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
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            // A file deleted since the listing is gone, as the scan finds it;
            // a directory's files may only have moved.
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && !entry.file_type().is_ok_and(|kind| kind.is_dir()) =>
            {
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                walked.unreadable(root, &path, &error);
                continue;
            }
            Err(error) => {
                walked.unreadable(root, dir, &error);
                continue;
            }
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
                    item: None,
                });
            } else {
                walk(root, &path, lists, walked);
            }
        } else if metadata.is_file() {
            if landing::left_behind(&path) {
                walked.left.push(path);
            } else if lists.takes(&relative) {
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
                item: None,
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
    deferred: bool,
    /// `None` on a volume that keeps no permission.
    executable: Option<bool>,
}

impl Scanned {
    fn deferred(root: &Path, path: &Path, mark: Option<String>) -> Result<Self> {
        Ok(Self {
            key: identity::relative(root, path)?,
            path: path.to_path_buf(),
            mark,
            born: std::fs::symlink_metadata(path)
                .ok()
                .as_ref()
                .and_then(identity::born),
            text: String::new(),
            hash: String::new(),
            id: None,
            line: None,
            unreadable: None,
            deferred: true,
            executable: None,
        })
    }

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
        self.scan_as(true, None)
    }

    /// A watch's pass. Short of `full`, it skips a file whose size, time and
    /// identity are as the last read left them, which a full pass catches.
    /// Either way it leaves for a later pass a file that is not a document
    /// and changed within `settle`, which a copy or a download may still be
    /// writing.
    pub fn scan_watching(&self, full: bool, settle: Duration) -> Result<ScanReport> {
        self.scan_as(full, Some(settle))
    }

    fn scan_as(&self, full: bool, settle: Option<Duration>) -> Result<ScanReport> {
        if let Some(gone) = self.root_gone() {
            return Ok(ScanReport {
                root_gone: Some(gone),
                ..ScanReport::default()
            });
        }
        state::settle_landings(&*self.core.conn()?, &self.root)?;
        // Every pass, so a watch lists its folder again too.
        let (registry, lost) = self.register();
        let doubt = registry.clone().filter(|_| lost);
        let mut report = ScanReport {
            registry,
            ..ScanReport::default()
        };
        let settings = self.settings()?;
        let (mut catalog, mut edge_types) = {
            let conn = self.core.conn()?;
            (Catalog::load(&conn)?, EdgeTypes::load(&conn)?)
        };
        let lists = settings.lists()?;
        let walked = self.walked(&lists);
        // And under `.marfa/`, which no walk enters, the settings file's.
        let state_dir = std::fs::read_dir(self.root.join(STATE_DIR))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| landing::left_behind(path));
        for left in walked.left.iter().cloned().chain(state_dir) {
            let _ = std::fs::remove_file(left);
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
                // Held below; its id line, which is ASCII, still names its item.
                let Ok(text) = text_of(&bytes) else {
                    named.extend(document::id_line(&String::from_utf8_lossy(&bytes)));
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
            // Unread bytes still claim their file's identity before another
            // file at its old path can take its item.
            let deferred = || {
                Scanned::deferred(
                    &self.root,
                    &path,
                    identities.get(&path).map(|mark| mark.key()),
                )
            };
            if let Some(settle) = settle
                && !is_document(&path)
                && changed_within(&path, settle)
            {
                files.push(deferred()?);
                report.settling.push(identity::relative(&self.root, &path)?);
                continue;
            }
            // Unreadable now, a dataless placeholder say: the next scan reads
            // it, and the folder holds what it last agreed with meanwhile.
            let bytes = match early.remove(&path) {
                Some(bytes) => bytes,
                None => {
                    let stat = stat_of(&path);
                    let Ok(bytes) = std::fs::read(&path) else {
                        files.push(deferred()?);
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
                files.push(deferred()?);
                report.skipped += 1;
                continue;
            }
            // A document whose bytes are not UTF-8 is held as one whose
            // frontmatter does not parse is: decoded, it would be sent and
            // written back with every byte that is not replaced.
            let (text, not_text) = match text_of(&bytes) {
                Ok(text) => (text.to_string(), None),
                Err(reason) => (
                    String::from_utf8_lossy(&bytes).into_owned(),
                    is_document(&path).then_some(reason),
                ),
            };
            let decodes = not_text.is_none();
            let read = (decodes && carries_frontmatter(&path)).then(|| document::read(&text));
            let unreadable = match not_text {
                None => read.as_ref().and_then(|read| {
                    read.unreadable
                        .clone()
                        .or_else(|| fields::read(&read.front, &edge_types).err())
                }),
                Some(reason) => Some(reason.to_string()),
            };
            // An unreadable file still names its item, so a move keeps it.
            let id = match &read {
                _ if !decodes && carries_frontmatter(&path) => document::id_line(&text),
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
                deferred: false,
                path,
            });
        }
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
            catalog = Catalog::load(&conn)?;
            edge_types = EdgeTypes::load(&conn)?;
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
                    item: None,
                });
                continue;
            }
            if file.deferred {
                if let Some(Claim {
                    bound: Some(bound), ..
                }) = claim
                {
                    if bound.path != file.key {
                        self.unbind_if_still(&bound)?;
                        self.place(&bound.item_id, &file.key, &withheld)?;
                        report.renamed += 1;
                    }
                    if bound.path != file.key || bound.identity != file.mark {
                        let conn = self.core.conn()?;
                        state::bind(
                            &conn,
                            &state::Bound {
                                path: file.key.clone(),
                                identity: file.mark.clone(),
                                ..bound
                            },
                        )?;
                        state::journal_clear(&conn, &file.key)?;
                    }
                }
                continue;
            }
            // A file item's file is its bytes, whatever its name says.
            let bytes_item = || -> Result<bool> {
                Ok(match &claim {
                    Some(claim) => self
                        .core
                        .get(&claim.item_id)?
                        .is_some_and(|item| bytes_of(&item, &catalog).is_some()),
                    None => false,
                })
            };
            if let Some(reason) = &file.unreadable
                && (!encoding(reason) || !bytes_item()?)
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
                    if bound.content_hash == file.hash && !local_properties_refusal(&bound) {
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
        let mut resolver = Resolver::new(&self.core, &catalog, &BoundFiles);
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
            // A directory that went away during the walk may have taken any
            // file with it, so this pass trusts no absence.
            if walked.vanished() {
                continue;
            }
            let conn = self.core.conn()?;
            state::journal_missing(&conn, &row.path, &row.item_id)?;
            report.missing += 1;
        }
        if !walked.vanished() {
            self.sweep_journal(&settings, &peers, &mut report)?;
        }
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
        // A file that cannot carry an id and that no record here names, the
        // folder added again over its own files say, is the item this folder
        // holds that is placed where it sits and whose bytes it holds. An item
        // the search no longer holds, one another folder took in or one that
        // left by state, has a file elsewhere or none, and a copy of it is new.
        let mut placed: Option<HashMap<String, Vec<crate::model::Edge>>> = None;
        for (at, file) in files.iter().enumerate() {
            if file.deferred
                || claims[at].is_some()
                || waiting.contains_key(&at)
                || file.id.is_some()
                || carries_frontmatter(&file.path)
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
                if !self.holds_bytes(&item, file, catalog) {
                    continue;
                }
                taken.insert(item.id.clone());
                claims[at] = Some(Claim {
                    item_id: item.id.clone(),
                    bound: Some(state::Bound {
                        path: file.key.clone(),
                        item_id: item.id,
                        identity: None,
                        content_hash: file.hash.clone(),
                        presentation: None,
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
        // A file that cannot carry an id, moved here from another folder on
        // this machine, is the item that folder bound it to.
        for (at, file) in files.iter().enumerate() {
            if file.deferred
                || claims[at].is_some()
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

    fn holds_bytes(&self, item: &Item, file: &Scanned, catalog: &Catalog) -> bool {
        if item.r#type.starts_with("system.") || !suited(item, &file.key, catalog) {
            return false;
        }
        match bytes_of(item, catalog) {
            Some(blob) => crate::blob::named(blob).is_ok_and(|named| {
                std::fs::read(&file.path).is_ok_and(|bytes| crate::blob::name_of(&bytes) == named)
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
        let mut leaves = true;
        let missing = if held.is_some_and(|item| item.state != ItemState::Trashed) {
            let holds = self.holds(item_id, settings, members);
            let look = match &bound {
                Some(bound) => peers.moved_to(bound, holds),
                None => Look::Nowhere,
            };
            match look {
                // A folder that still holds the item writes its file again.
                Look::Moved => {
                    leaves = !holds;
                    Missing::Moved
                }
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
        drop(conn);
        if leaves {
            self.end_placement(item_id)?;
        }
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
            occurred_at: read.lines.occurred_at,
            ..Default::default()
        };
        let created = match self.core.write_create(&draft, crate::Body::Folder) {
            Err(error) if local_admission_refusal(&error) => {
                return Ok(Some(Flagged::of(
                    &file.key,
                    &format!("{LOCAL_ADMISSION_REFUSAL}{error}"),
                )));
            }
            other => other?,
        };
        let item_id = named_item(created, &file.key)?;
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
                    let names = Names::load(&*self.core.conn()?, catalog, &BoundFiles)?;
                    let rendered = self.render(
                        &held,
                        &file.key,
                        file.line,
                        catalog,
                        edge_types,
                        (&names, Some(&document), &bound.lines),
                    )?;
                    rendered.text.as_ref().is_ok_and(|text| {
                        bound.presentation.as_ref().is_some_and(|agreed| {
                            agreed.agrees(&document::read(text).presentation(), edge_types)
                        })
                    })
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
                item: None,
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
        let unchanged = (!whole || properties.len() == held.properties.len())
            && properties.iter().all(|(field, value)| {
                held.properties
                    .get(field)
                    .is_some_and(|held| document::same_value(value, held))
            });
        // A save that changes nothing the item holds, a reformatting or only
        // the id or version line, sends nothing.
        let in_step = unchanged && changes.is_empty()
            || bound.is_some_and(|bound| {
                bound.content_hash == file.hash && !local_properties_refusal(bound)
            });
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
                let prefix = if changes
                    .r#type
                    .as_deref()
                    .is_some_and(|to| !catalog.known(to))
                {
                    LOCAL_ADMISSION_REFUSAL
                } else {
                    state::REFUSED
                };
                let held_for = format!("{prefix}{reason}");
                flagged.push(Flagged::of(&file.key, &held_for));
                return self
                    .bind_held(file, item_id, bound, held_for)
                    .map(|()| false);
            }
            // The tags are checked before the edit is queued, so a tag the
            // server would refuse leaves no write of the file half queued.
            if let Err(error) = crate::validation::tags(&changes.added) {
                let held_for = format!("{LOCAL_ADMISSION_REFUSAL}{error}");
                flagged.push(Flagged::of(&file.key, &held_for));
                return self
                    .bind_held(file, item_id, bound, held_for)
                    .map(|()| false);
            }
            // Tags and a state are writes of their own, and need no edit.
            if !unchanged
                || changes.r#type.is_some()
                || changes.tier.is_some()
                || changes.occurred_at.is_some()
            {
                let read_at = untaken.or(match standing {
                    Standing::Behind(line) => Some(line),
                    _ => None,
                });
                let edit = Edit {
                    properties,
                    base_version: Some(read_at.unwrap_or(held.version)),
                    r#type: changes.r#type.clone(),
                    tier: changes.tier,
                    occurred_at: changes.occurred_at.clone(),
                    replace_properties: whole,
                    ..Edit::default()
                };
                let updated = if read_at.is_some() {
                    self.core.write_update(
                        item_id,
                        &edit,
                        crate::Based::AsRead,
                        crate::Body::Folder,
                    )
                } else {
                    self.core.write_update(
                        item_id,
                        &edit,
                        crate::Based::OnHeld,
                        crate::Body::Folder,
                    )
                };
                let id = match updated {
                    Err(error) if local_admission_refusal(&error) => {
                        let held_for = format!("{LOCAL_ADMISSION_REFUSAL}{error}");
                        flagged.push(Flagged::of(&file.key, &held_for));
                        return self
                            .bind_held(file, item_id, bound, held_for)
                            .map(|()| false);
                    }
                    other => other?.id,
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
        let agrees = unchanged
            && changes.r#type.is_none()
            && changes.tier.is_none()
            && changes.occurred_at.is_none();
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
                crate::Based::AsRead => self.core.write_update(
                    &held.id,
                    &edit,
                    crate::Based::AsRead,
                    crate::Body::Folder,
                )?,
                crate::Based::OnHeld => self.core.write_update(
                    &held.id,
                    &edit,
                    crate::Based::OnHeld,
                    crate::Body::Folder,
                )?,
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
                presentation: file
                    .unreadable
                    .is_none()
                    .then(|| file.document().presentation()),
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
}

const LOCAL_ADMISSION_REFUSAL: &str = "refused: local item validation: ";

/// What the copy refuses a write for before queueing it: a field the type
/// does not take, a type it does not hold, and a tag or property name the
/// server would refuse.
fn local_admission_refusal(error: &CoreError) -> bool {
    matches!(error, CoreError::Validation {code, ..}
        if code == "invalid_properties" || code == "validation_error")
        || matches!(error, CoreError::UnknownType { .. })
}

fn local_properties_refusal(bound: &state::Bound) -> bool {
    bound
        .held
        .as_deref()
        .is_some_and(|reason| reason.starts_with(LOCAL_ADMISSION_REFUSAL))
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Drained {
    #[serde(flatten)]
    pub report: crate::DrainReport,
    pub rebased: usize,
    pub gave_way: usize,
}

impl Drained {
    /// Takes in a later drain of the same sync, so the two read as one.
    pub(crate) fn absorb(&mut self, later: Drained) {
        self.report.absorb(later.report);
        self.rebased += later.rebased;
        self.gave_way += later.gave_way;
    }
}

impl Folder {
    /// Its passes are one drain: another on the store waits for all of them.
    pub fn drain(&self) -> Result<Drained> {
        let one = self.core.one_drain();
        let mut report = self.core.drain_held(&one)?;
        let mut rebased = 0;
        while report.stopped.is_none() && report.unavailable.is_none() {
            let now = self.rebase_thinned()? + self.make_edges_gone_before_their_move()?;
            if now == 0 {
                break;
            }
            rebased += now;
            report.absorb(self.core.drain_held(&one)?);
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
    ///
    /// Pulls again from the start where the copy changed under it, such as a
    /// catch-up applying a purge, since what it read is then stale.
    pub fn pull(&self) -> Result<PullReport> {
        self.refuse_while_waiting()?;
        let mut earlier = PullReport::default();
        let mut attempts = 1;
        loop {
            let mut report = PullReport::default();
            match self.pull_into(None, &mut report) {
                Ok(()) => {
                    report.add_writes(&earlier);
                    return Ok(report);
                }
                // What an attempt wrote stays written, and the next attempt
                // finds it unchanged, so its count is carried.
                Err(error) if copy_changed(&error) && attempts < PULL_ATTEMPTS => {
                    earlier.add_writes(&report);
                    attempts += 1;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// With `planning`, stops where each file's path is chosen and counts the
    /// files it would write, leaving the directory as it is.
    fn pull_into(&self, planning: Option<&mut PullPlan>, report: &mut PullReport) -> Result<()> {
        if let Some(gone) = self.root_gone() {
            report.root_gone = Some(gone);
            return Ok(());
        }
        let context = crate::read_view::Context::capture(&*self.core.conn()?)?;
        state::settle_landings(&*self.core.conn()?, &self.root)?;
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
        let mut retained = Vec::new();
        for item in held {
            // A folder that has never synced writes no file, so what a pass
            // would let go of is not its to count.
            if !settings.holds_state(item.state) || planning.is_some() {
                continue;
            }
            context.same_copy(&*self.core.conn()?)?;
            match self.let_go(&item.id, &peers, &context, report)? {
                LetGo::Inapplicable => work.push((item, true)),
                LetGo::Retained => retained.push(item.id),
                LetGo::Removed => {}
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
        let names = Names::load(&*self.core.conn()?, &catalog, &BoundFiles)?;
        report.unplaced = withheld.len();
        let mut placing: Vec<Placing> = Vec::new();
        let unmatched_ids: Vec<String> = work
            .iter()
            .filter(|(_, unmatched)| *unmatched)
            .map(|(item, _)| item.id.clone())
            .chain(retained)
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
                    Some(bound) if crate::names::same(&bound.path, &want) => bound.path.clone(),
                    _ => want,
                })
            else {
                let named = placed.as_ref().and_then(path_of).unwrap_or_default();
                report.not_written(
                    NotWritten::Outside,
                    &item.id,
                    named,
                    "the placement's path has a `..` in it, or names no file",
                );
                continue;
            };
            if let Some(reason) = self.not_writing_at(&lists, &want) {
                report.not_written(NotWritten::Outside, &item.id, &want, reason);
                continue;
            }
            if !suited(item, &want, &catalog) {
                report.not_written(
                    NotWritten::Unsuited,
                    &item.id,
                    &want,
                    "a file at the path would be another kind of file than the item",
                );
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
            .map(|entry| crate::names::folded(&entry.want))
            .collect();
        let mut taken: HashSet<String> = HashSet::new();
        for entry in &mut placing {
            if taken.contains(&crate::names::folded(&entry.want)) {
                let own = entry.bound.as_ref().map(|bound| bound.path.as_str());
                let free = |candidate: &str| {
                    let name = crate::names::folded(candidate);
                    !taken.contains(&name)
                        && self.writes_at(&lists, candidate)
                        && (own == Some(candidate)
                            || !wanted.contains(&name) && !self.root.join(candidate).exists())
                };
                entry.want = beside(&entry.want, |candidate| !free(candidate));
                report.beside += 1;
            }
            taken.insert(crate::names::folded(&entry.want));
        }
        if let Some(plan) = planning {
            // Every entry still unbound is a file the pull will write: where
            // the person's file holds its path, one of the two takes a number,
            // as the scan's creates, sent by then, rank among the others.
            for entry in placing.iter().filter(|entry| entry.bound.is_none()) {
                plan.write += 1;
                if self.root.join(&entry.want).exists() {
                    plan.beside += 1;
                }
            }
            return Ok(());
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
            .map(|bound| crate::names::folded(&bound.path))
            .collect();
        let mut waiting = Vec::new();
        context.same_copy(&*self.core.conn()?)?;
        let filesystem = crate::read_view::Context::capture(&*self.core.conn()?)?;
        let rendering = Rendering {
            context: std::cell::RefCell::new(filesystem),
            catalog: &catalog,
            edge_types: &edge_types,
            names: &names,
        };
        let mut refused = HashSet::new();
        for entry in placing {
            context.same_copy(&*self.core.conn()?)?;
            match self.write_placed(&entry, &rendering, &withheld, Some(&leaving), report)? {
                PlacementWrite::Waiting => waiting.push(entry),
                PlacementWrite::Refused => {
                    refused.insert(crate::names::folded(&entry.want));
                }
                PlacementWrite::Done => {}
            }
        }
        for entry in waiting {
            context.same_copy(&*self.core.conn()?)?;
            if matches!(
                self.write_placed(&entry, &rendering, &withheld, None, report)?,
                PlacementWrite::Refused
            ) {
                refused.insert(crate::names::folded(&entry.want));
            }
        }
        context.same_copy(&*self.core.conn()?)?;
        self.remove_departed(&members, &settings, &lists, &refused, report)?;
        report.flagged.extend({
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
                        item: None,
                    });
                    held.into_iter().chain(refused)
                })
                .collect::<Vec<_>>()
        });
        report.uncarried = fields::uncarried(&catalog, &edge_types, |r#type| {
            settings.holds_type(&catalog, r#type)
        });
        context.same_copy(&*self.core.conn()?)?;
        report.settings = self.write_settings_if_moved()?;
        Ok(())
    }

    /// Leaves a file changed since the scan read it alone: the permission is
    /// then the person's.
    fn keep_executable(
        &self,
        item: &Item,
        want: &str,
        context: &crate::read_view::Context,
    ) -> Result<()> {
        let path = self.root.join(want);
        let wanted = executable::held(item);
        if !self.keeps_permissions()
            || std::fs::symlink_metadata(&path).is_ok_and(|found| executable::of(&found) == wanted)
        {
            return Ok(());
        }
        let conn = self.core.conn()?;
        context.check(&conn)?;
        let read = state::stat_of(&conn, want)?;
        // Made runnable by the server's word, it is marked first, and left as
        // it is where it cannot be.
        if read.is_some()
            && read == stat_of(&path)
            && (!wanted || executable::quarantine(&path).is_ok())
        {
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

    /// Refusal protects the destination through this pull, including from
    /// removal under an older binding restored by a failed landing.
    fn write_placed(
        &self,
        entry: &Placing<'_>,
        rendering: &Rendering<'_>,
        withheld: &placement::Withheld,
        leaving: Option<&HashSet<String>>,
        report: &mut PullReport,
    ) -> Result<PlacementWrite> {
        if let Some(how) = fault::named("copy-changes-during-pull") {
            static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let call = CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if match how.as_str() {
                "once" => call == 0,
                "second" => call == 1,
                _ => true,
            } {
                crate::read_view::pins_changed(&*self.core.conn()?)?;
            }
        }
        rendering.context.borrow().check(&*self.core.conn()?)?;
        let Placing {
            item,
            bound,
            want,
            taken,
            ..
        } = entry;
        let (item, want) = (*item, want.clone());
        let catalog = rendering.catalog;
        if taken.is_some() {
            match self.take_in(entry, rendering, withheld, report)? {
                TakeIn::Taken => return Ok(PlacementWrite::Done),
                TakeIn::Refused(reason) => {
                    report.not_written(
                        NotWritten::Unwritten,
                        &item.id,
                        &want,
                        format!("it could not be taken in from another folder: {reason}"),
                    );
                    return Ok(PlacementWrite::Refused);
                }
                TakeIn::Inapplicable => {}
            }
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
                        Err(
                            error @ (CoreError::Unauthorized { .. }
                            | CoreError::RenewalFailed(_)
                            | CoreError::Redirected { .. }),
                        ) => return Err(error),
                        // A held copy that cannot be read is one file's failure too.
                        Ok(Err(error)) => {
                            report.not_written(
                                NotWritten::Absent,
                                &item.id,
                                &want,
                                format!("its bytes could not be read: {error}"),
                            );
                            return Ok(PlacementWrite::Done);
                        }
                        Err(error) => {
                            report.not_written(
                                NotWritten::Absent,
                                &item.id,
                                &want,
                                format!("its bytes could not be fetched: {error}"),
                            );
                            return Ok(PlacementWrite::Done);
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
                    .map(|text| document::read(&text));
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
                rendering.context.borrow().check(&*self.core.conn()?)?;
                let text = match rendered.text {
                    Ok(text) => text,
                    Err(error) => {
                        report.not_written(
                            NotWritten::Unwritten,
                            &item.id,
                            &want,
                            error.to_string(),
                        );
                        return Ok(PlacementWrite::Refused);
                    }
                };
                (text.into_bytes(), rendered.links, rendered.lines)
            }
        };
        rendering.context.borrow().check(&*self.core.conn()?)?;
        let hash = state::hash(&bytes);
        let presentation = if bytes_of(item, catalog).is_none() {
            std::str::from_utf8(&bytes).ok().map(|text| {
                if carries_frontmatter(Path::new(&want)) {
                    document::read(text)
                } else {
                    document::read_body(text)
                }
                .presentation()
            })
        } else {
            None
        };
        let ours = bound.as_ref().is_some_and(|bound| bound.path == want);
        // A file the person deleted whose item moved on in nothing it shows is
        // the scan's, and its journaled delete stands.
        if let Some(bound) = &bound
            && bytes_of(item, catalog).is_none()
            && self.deleted_as_agreed(item, bound, rendering)?
        {
            return Ok(PlacementWrite::Done);
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
                report.not_written(
                    NotWritten::Unwritten,
                    &item.id,
                    &bound.path,
                    "the file changed since the scan read it, and the next scan sends it",
                );
                return Ok(PlacementWrite::Done);
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
            if leaving.is_some_and(|leaving| leaving.contains(&crate::names::folded(&want))) {
                return Ok(PlacementWrite::Waiting);
            }
            report.not_written(
                NotWritten::Unwritten,
                &item.id,
                &want,
                "a file the folder did not write is at the path",
            );
            return Ok(PlacementWrite::Done);
        }
        if rebound {
            let conn = self.core.conn()?;
            refuse_unless_held(&conn, &item.id)?;
            rendering.bind(
                &conn,
                &state::Bound {
                    path: want.clone(),
                    item_id: item.id.clone(),
                    identity: None,
                    content_hash: hash.clone(),
                    presentation: presentation.clone(),
                    written_hash: Some(hash),
                    links: wrote,
                    lines,
                    edit_line: None,
                    held: None,
                    own,
                    writes: state::Writes::default(),
                },
            )?;
            state::journal_clear_for(&conn, &want, &item.id)?;
            report.unchanged += 1;
            return Ok(PlacementWrite::Done);
        }
        if in_place {
            if bytes_of(item, catalog).is_some() {
                self.keep_executable(item, &want, &rendering.context.borrow())?;
            }
            report.placed += usize::from(self.place(&item.id, &want, withheld)?);
            report.unchanged += 1;
            return Ok(PlacementWrite::Done);
        }

        // Written over an edit still waiting, the line it writes is spent
        // too, since the file holds that edit. A dead edit remains projected,
        // but cannot spend a newer line until it is released.
        let mut writes = bound
            .as_ref()
            .map(|bound| bound.writes.clone())
            .unwrap_or_default();
        let mut edit_line = bound.as_ref().and_then(|bound| bound.edit_line);
        let waiting: HashSet<String> =
            crate::store::waiting_writes_for_item(&*self.core.conn()?, &item.id)?
                .into_iter()
                .filter(|write| write.verdict != Some(crate::model::Verdict::Dead))
                .map(|write| write.id)
                .collect();
        if carries_frontmatter(Path::new(&want)) && !waiting.is_empty() {
            let mut lifted = false;
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
            presentation: presentation.clone(),
            written_hash: Some(hash.clone()),
            links: wrote.clone(),
            lines: lines.clone(),
            edit_line,
            held: None,
            own: own.clone(),
            writes: state::Writes {
                landing: None,
                ..writes.clone()
            },
        };
        // What the path was bound as before, put back where the bytes do not
        // land, and kept beside the new binding until they do, so a crash in
        // between leaves the old file the folder's own.
        let before = state::bound_at(&*self.core.conn()?, &want)?;
        // What the file at the path was when this pull chose to write it: its
        // own file as the scan last read it, or none.
        let over = bound
            .as_ref()
            .filter(|_| ours && path.exists())
            .map(|bound| bound.content_hash.clone());
        let file_item = bytes_of(item, catalog).is_some();
        // Bound before the write, so the scan never reads it back; a path the
        // filesystem refuses, or a write that fails part way, leaves the old
        // file, and every other, as it was.
        let conn = self.core.conn()?;
        if fault::named("purge-during-pull").as_deref() == Some(item.id.as_str()) {
            crate::store::purge_item(&conn, &item.id)?;
        }
        refuse_unless_held(&conn, &item.id)?;
        rendering.bind(
            &conn,
            &state::Bound {
                writes: state::Writes {
                    landing: Some(state::Landing {
                        before: before.clone().map(Box::new),
                    }),
                    ..writes.clone()
                },
                ..binding(None)
            },
        )?;
        drop(conn);
        if fault::named("move-folder-before-write").is_some() {
            let _ = std::fs::rename(
                &self.root,
                self.root.with_file_name(format!(
                    "{}-away",
                    self.root.file_name().unwrap_or_default().to_string_lossy()
                )),
            );
        }
        // Expiry and rebuild take this same lock. Keep authority stable through
        // the filesystem commit and its binding, not only the preceding check.
        let conn = self.core.conn()?;
        rendering.context.borrow().check(&conn)?;
        let written = self.land(
            &path,
            |file, beside| {
                std::io::Write::write_all(file, &bytes)?;
                if file_item {
                    executable::quarantine(beside)?;
                    if self.keeps_permissions() {
                        // The bytes are written whatever the permission does.
                        let _ = executable::set(beside, executable::held(item));
                    }
                }
                Ok(())
            },
            |found| found.map(state::hash) == over,
        );
        if let Err(error) = written {
            // The path keeps the binding it had, or a scan that can reach the
            // file again would make it a new item.
            match &before {
                Some(before) => rendering.bind(&conn, before)?,
                None => rendering.unbind(&conn, &want)?,
            }
            report.not_written(
                NotWritten::Unwritten,
                &item.id,
                &want,
                format!("the file system refused it: {error}"),
            );
            return Ok(PlacementWrite::Refused);
        }
        // Landed: the old bytes are no longer the folder's own.
        rendering.bind(&conn, &binding(None))?;
        drop(conn);
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
            // reach is journaled and deleted. One changed since the scan read
            // it holds the person's edit, and stays for the next scan.
            let conn = self.core.conn()?;
            rendering.context.borrow().check(&conn)?;
            if plainly_inside(&self.root, &bound.path) {
                let _ = landing::remove(&self.root.join(&bound.path), |found| {
                    state::hash(found) == bound.content_hash
                });
            }
            rendering.unbind(&conn, &bound.path)?;
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
            rendering.bind(&*self.core.conn()?, &binding(Some(found.key())))?;
        }
        if bound.is_none() {
            report.written += 1;
        } else {
            report.rewritten += 1;
        }
        Ok(PlacementWrite::Done)
    }

    /// A failed move has already decided against this destination. It must not
    /// fall through to writing or adopting a byte-identical competing file.
    fn take_in(
        &self,
        entry: &Placing<'_>,
        rendering: &Rendering<'_>,
        withheld: &placement::Withheld,
        report: &mut PullReport,
    ) -> Result<TakeIn> {
        let item = entry.item;
        let want = entry.want.as_str();
        let Some((from, theirs)) = &entry.taken else {
            return Ok(TakeIn::Inapplicable);
        };
        let path = self.root.join(want);
        if path.exists() {
            return Ok(TakeIn::Inapplicable);
        }
        let Ok(source) = transfer::Source::open(from, theirs) else {
            return Ok(TakeIn::Inapplicable);
        };
        let binding = |identity: Option<String>| state::Bound {
            path: want.to_string(),
            item_id: item.id.clone(),
            identity,
            content_hash: theirs.content_hash.clone(),
            presentation: theirs.presentation.clone(),
            written_hash: Some(theirs.content_hash.clone()),
            links: theirs.links.clone(),
            lines: theirs.lines.clone(),
            edit_line: None,
            held: None,
            own: theirs.own.clone(),
            writes: state::Writes::default(),
        };
        // Kept beside the new binding until the file is here, as a write's is.
        let conn = self.core.conn()?;
        rendering.context.borrow().check(&conn)?;
        refuse_unless_held(&conn, &item.id)?;
        let before = state::bound_at(&conn, want)?;
        rendering.bind(
            &conn,
            &state::Bound {
                writes: state::Writes {
                    landing: Some(state::Landing {
                        before: before.clone().map(Box::new),
                    }),
                    ..state::Writes::default()
                },
                ..binding(None)
            },
        )?;
        let moved = self.inside(path.parent()).and_then(|()| {
            landing::crash_if_asked(&path);
            landing::appear_if_asked(&path, "create-before-move")?;
            source.check()?;
            let renamed = if fault::named("cross-volume-move").is_some() {
                Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices))
            } else {
                landing::rename_new(from, &path)
            };
            renamed.or_else(|error| {
                if error.kind() != std::io::ErrorKind::CrossesDevices && !source.protected(&error) {
                    return Err(error);
                }
                self.land(
                    &path,
                    |file, _| source.fill(file),
                    |found| found.is_none() && source.check().is_ok(),
                )
                .map_err(std::io::Error::from)
                .map(|()| {
                    landing::crash_if_named(&path, "crash-after-copy-publish");
                    if source.check().is_ok() {
                        let _ = landing::remove(from, |found| {
                            source.check().is_ok() && state::hash(found) == theirs.content_hash
                        });
                    }
                })
            })
        });
        if let Err(error) = moved {
            match &before {
                Some(before) => rendering.bind(&conn, before)?,
                None => rendering.unbind(&conn, want)?,
            }
            return Ok(TakeIn::Refused(error.to_string()));
        }
        rendering.bind(&conn, &binding(None))?;
        state::journal_clear_for(&conn, want, &item.id)?;
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && let Some(found) = identity::of(&metadata)
        {
            rendering.bind(&conn, &binding(Some(found.key())))?;
        }
        drop(conn);
        report.placed += usize::from(self.place(&item.id, want, withheld)?);
        report.taken += 1;
        Ok(TakeIn::Taken)
    }

    /// Trashes nothing. Answers whether it did.
    fn let_go(
        &self,
        item_id: &str,
        peers: &Peers<'_>,
        context: &crate::read_view::Context,
        report: &mut PullReport,
    ) -> Result<LetGo> {
        let Some(bound) = state::bound_to_item(&*self.core.conn()?, item_id)? else {
            return Ok(LetGo::Inapplicable);
        };
        let path = self.root.join(&bound.path);
        let own = std::fs::read(&path)
            .is_ok_and(|found| bound.written_hash.as_deref() == Some(state::hash(&found).as_str()));
        if !own || !plainly_inside(&self.root, &bound.path) || !peers.filed_elsewhere(item_id) {
            return Ok(LetGo::Inapplicable);
        }
        let Ok(source) = transfer::Source::open(&path, &bound) else {
            return Ok(LetGo::Inapplicable);
        };
        // Checked again as it goes, so an edit saved meanwhile stays.
        let conn = self.core.conn()?;
        context.same_copy(&conn)?;
        let removed = match landing::remove_checked(&path, |found| {
            source.check().is_ok()
                && bound.written_hash.as_deref() == Some(state::hash(found).as_str())
        }) {
            Ok(removed) => removed,
            Err(landing::RemoveError::Remove(error)) => {
                report.unwritten += 1;
                report.flagged.push(Flagged {
                    path: bound.path.clone(),
                    flag: "retained",
                    reason: format!("cannot let it go to another folder: {error}"),
                    item: Some(item_id.to_string()),
                });
                return Ok(LetGo::Retained);
            }
            Err(landing::RemoveError::Read(error)) => {
                return Err(CoreError::Store(format!(
                    "cannot read {}: {error}",
                    path.display()
                )));
            }
        };
        if !removed {
            return Ok(LetGo::Inapplicable);
        }
        state::unbind(&conn, &bound.path)?;
        state::journal_clear(&conn, &bound.path)?;
        drop(conn);
        report.ended += self.end_placement(item_id)?;
        report.let_go += 1;
        Ok(LetGo::Removed)
    }

    /// Answered as a list in the folder is, so the two hold the same items.
    fn members(&self, settings: &Settings) -> Result<HashSet<String>> {
        Ok(self
            .core
            .held_by(settings)?
            .into_iter()
            .map(|item| item.id)
            .collect())
    }

    fn remove_departed(
        &self,
        members: &HashSet<String>,
        settings: &Settings,
        lists: &Lists,
        refused: &HashSet<String>,
        report: &mut PullReport,
    ) -> Result<()> {
        let mut context = crate::read_view::Context::capture(&*self.core.conn()?)?;
        let (bound, of) = {
            let conn = self.core.conn()?;
            (state::every_bound(&conn)?, state::bound_count(&conn)?)
        };
        let mut going: Vec<state::Bound> = Vec::new();
        for row in bound {
            if refused.contains(&crate::names::folded(&row.path)) {
                continue;
            }
            match self.departing(&row, members, settings, lists)? {
                Departing::No => {}
                Departing::Kept => report.kept += 1,
                Departing::Unread(reason) => report.not_written(
                    NotWritten::Unwritten,
                    &row.item_id,
                    &row.path,
                    format!("the file could not be read to tell whether it changed: {reason}"),
                ),
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
            context.check(&*self.core.conn()?)?;
            let purged = crate::store::purged(&*self.core.conn()?, &row.item_id)?;
            if let Some(ended) = self.take_away(&row, &mut context)? {
                report.removed += 1;
                report.purged += usize::from(purged);
                report.ended += ended;
            } else {
                report.kept += 1;
            }
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
        // A purged row's file goes as a trashed one's does; a row the copy
        // lost otherwise is the scan's to report.
        match held {
            None if !crate::store::purged(&*self.core.conn()?, &row.item_id)? => {
                return Ok(Departing::No);
            }
            Some(item) if settings.holds_state(item.state) => return Ok(Departing::No),
            _ => {}
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
            Err(error) => Departing::Unread(error.to_string()),
        })
    }

    /// A journal row here is a file put back since its scan, so it asks for
    /// nothing now. Answers `None`, and keeps the file bound, where it
    /// changed since it was found to be the folder's own: the person's edit
    /// is theirs. Otherwise answers how many placements it ended with the
    /// file.
    fn take_away(
        &self,
        row: &state::Bound,
        context: &mut crate::read_view::Context,
    ) -> Result<Option<usize>> {
        let conn = self.core.conn()?;
        context.check(&conn)?;
        let path = self.root.join(&row.path);
        if plainly_inside(&self.root, &row.path) {
            let still =
                |found: &[u8]| row.written_hash.as_deref() == Some(state::hash(found).as_str());
            if path.exists()
                && !landing::remove(&path, still).map_err(|error| {
                    CoreError::Store(format!("cannot remove {}: {error}", path.display()))
                })?
                && path.exists()
            {
                return Ok(None);
            }
        }
        context.change_pins(&conn, || state::unbind(&conn, &row.path))?;
        state::journal_clear(&conn, &row.path)?;
        drop(conn);
        self.end_placement(&row.item_id).map(Some)
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
        let previous = bound
            .presentation
            .as_ref()
            .map(document::Presentation::document);
        let rendered = self.render(
            item,
            &bound.path,
            line,
            rendering.catalog,
            rendering.edge_types,
            (rendering.names, previous.as_ref(), &bound.lines),
        )?;
        let Ok(text) = rendered.text else {
            return Ok(false);
        };
        let presented = if carries_frontmatter(Path::new(&bound.path)) {
            document::read(&text)
        } else {
            document::read_body(&text)
        };
        Ok(bound
            .presentation
            .as_ref()
            .is_some_and(|agreed| agreed.agrees(&presented.presentation(), rendering.edge_types)))
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
        let document = document::read(&found);
        let line = line_of(&document.front);
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
            (rendering.names, Some(&document), &bound.lines),
        )?;
        Ok(rendered.text.as_ref().is_ok_and(|text| {
            bound.presentation.as_ref().is_some_and(|agreed| {
                agreed.agrees(&document::read(text).presentation(), rendering.edge_types)
            })
        }))
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
            name_from_title(title, None)
        } else {
            name_from_title(title, Some(".md"))
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
        let links = self.body_links(item, &body, catalog, lines.0)?;
        if !carries_frontmatter(Path::new(path)) {
            return Ok(Rendered {
                text: Ok(body),
                links,
                lines: Vec::new(),
            });
        }
        let embedded: Vec<String> = self
            .shown_in(item, path, &body, catalog)?
            .into_iter()
            .filter_map(|shown| shown.item)
            .collect();
        let (names, typed, recorded) = lines;
        let mut front = fields::lines_of(item);
        // A file that already says when the item happened goes on saying it.
        if typed.is_some_and(|document| document.front.contains_key(fields::OCCURRED_AT_FIELD)) {
            front.insert(
                fields::OCCURRED_AT_FIELD.into(),
                Value::String(item.occurred_at.clone()),
            );
        }
        for (field, value) in &item.properties {
            if field != body_field && !fields::reserved(field, edge_types) {
                front.insert(field.clone(), value.clone());
            }
        }
        let (entries, written) = self.lines_for(
            item,
            edge_types,
            catalog,
            names,
            typed.map(|document| &document.front),
            (&links, &embedded),
            recorded,
        )?;
        front.extend(entries);
        front.insert(ID_FIELD.into(), Value::String(item.id.clone()));
        if let Some(line) = line {
            front.insert(VERSION_FIELD.into(), Value::from(line));
        }
        if let Some(typed) = typed {
            fields::keep_equivalent(&mut front, &typed.front, edge_types);
        }
        Ok(Rendered {
            text: if fault::named("render-frontmatter").as_deref() == Some(path) {
                Err(CoreError::Invalid(
                    "cannot preserve this frontmatter: injected rendering failure".into(),
                ))
            } else {
                document::write(&front, &body, typed)
            },
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
type LinesBy<'a> = (&'a Names, Option<&'a document::Document>, &'a [state::Line]);

struct Rendering<'a> {
    context: std::cell::RefCell<crate::read_view::Context>,
    catalog: &'a Catalog,
    edge_types: &'a EdgeTypes,
    names: &'a Names,
}

impl Rendering<'_> {
    fn bind(&self, conn: &rusqlite::Connection, bound: &state::Bound) -> Result<()> {
        self.context
            .borrow_mut()
            .change_pins(conn, || state::bind(conn, bound))
    }

    fn unbind(&self, conn: &rusqlite::Connection, path: &str) -> Result<()> {
        self.context
            .borrow_mut()
            .change_pins(conn, || state::unbind(conn, path))
    }
}

struct Rendered {
    // Byte preservation can fail for one document. Read authority and store
    // errors from constructing its fields still fail the whole operation.
    text: Result<String>,
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
    occurred_at: Option<String>,
}

impl OwnChanges {
    fn is_empty(&self) -> bool {
        self.r#type.is_none()
            && self.tier.is_none()
            && self.added.is_empty()
            && self.removed.is_empty()
            && self.state.is_none()
            && self.occurred_at.is_none()
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
    if let Some(time) = lines
        .occurred_at
        .clone()
        .filter(|time| *time != base.occurred_at)
    {
        agreed.occurred_at = time.clone();
        changes.occurred_at = (time != now.occurred_at).then_some(time);
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
    if lines
        .occurred_at
        .as_ref()
        .is_some_and(|time| *time != shown.occurred_at)
    {
        differ.push("occurred_at".into());
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
    /// Why the file could not be read.
    Unread(String),
    Yes,
}

enum PlacementWrite {
    Done,
    Waiting,
    Refused,
}

enum LetGo {
    Inapplicable,
    Removed,
    Retained,
}

enum TakeIn {
    Inapplicable,
    Taken,
    /// Why the file could not be moved here.
    Refused(String),
}

struct Placing<'a> {
    item: &'a Item,
    bound: Option<state::Bound>,
    want: String,
    rank: placement::Rank,
    taken: Option<(PathBuf, state::Bound)>,
}

/// The status change time where the system keeps one, which an editor
/// restoring the modification time does not move back.
fn changed_within(path: &Path, settle: Duration) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        u64::try_from(metadata.ctime())
            .ok()
            .map(|seconds| {
                std::time::UNIX_EPOCH
                    + Duration::new(seconds, u32::try_from(metadata.ctime_nsec()).unwrap_or(0))
            })
            .or_else(|| metadata.modified().ok())
    };
    #[cfg(not(unix))]
    let changed = metadata.modified().ok();
    changed.is_some_and(|changed| {
        std::time::SystemTime::now()
            .duration_since(changed)
            .is_ok_and(|since| since < settle)
    })
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

/// What a pull would write, counted without writing it.
#[derive(Debug, Default)]
struct PullPlan {
    write: usize,
    beside: usize,
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
    /// Placements the pull ended, for the files it took away or let go.
    pub ended: usize,
    pub removed: usize,
    /// Of `removed`, the files of items purged.
    pub purged: usize,
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
    /// Why the pull wrote nothing, where the folder's directory is gone.
    pub root_gone: Option<String>,
}

/// Why a pull did not write an item's file, each a count of its report.
#[derive(Debug, Clone, Copy)]
enum NotWritten {
    Unwritten,
    Outside,
    Unsuited,
    Absent,
}

impl PullReport {
    fn add_writes(&mut self, other: &PullReport) {
        self.written += other.written;
        self.rewritten += other.rewritten;
        self.moved += other.moved;
        self.revived += other.revived;
        self.placed += other.placed;
        self.ended += other.ended;
        self.removed += other.removed;
        self.purged += other.purged;
        self.taken += other.taken;
        self.let_go += other.let_go;
    }

    fn not_written(&mut self, why: NotWritten, item: &str, path: &str, reason: impl Into<String>) {
        let (count, flag) = match why {
            NotWritten::Unwritten => (&mut self.unwritten, "unwritten"),
            NotWritten::Outside => (&mut self.outside, "outside"),
            NotWritten::Unsuited => (&mut self.unsuited, "unsuited"),
            NotWritten::Absent => (&mut self.absent, "absent"),
        };
        *count += 1;
        self.flagged.push(Flagged {
            path: path.to_string(),
            flag,
            reason: reason.into(),
            item: Some(item.to_string()),
        });
    }
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

/// A file's name for a title, with `extension` where the title carries none.
fn name_from_title(title: &str, extension: Option<&str>) -> String {
    let cleaned: String = title
        .chars()
        .map(|glyph| match glyph {
            '/' | '\\' | ':' => '-',
            glyph if glyph.is_control() => ' ',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    let stem = if trimmed.is_empty() {
        "untitled"
    } else {
        trimmed
    };
    match extension {
        Some(extension) => names::fitted(stem, extension),
        None => {
            let (stem, extension) = names::split_extension(stem);
            names::fitted(stem, extension)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held_at(occurred_at: &str) -> Item {
        Item {
            id: "item".into(),
            r#type: "core.note".into(),
            properties: Map::new(),
            state: ItemState::Active,
            tier: Some(crate::model::Tier::Library),
            version: 2,
            schema_version: 1,
            source: "test".into(),
            source_id: None,
            occurred_at: occurred_at.into(),
            created_at: "2026-09-01T10:00:00.000Z".into(),
            updated_at: "2026-09-01T10:00:00.000Z".into(),
            tags: Vec::new(),
        }
    }

    fn naming(time: Option<&str>) -> fields::Lines {
        fields::Lines {
            occurred_at: time.map(str::to_string),
            ..fields::Lines::default()
        }
    }

    #[test]
    fn a_current_files_time_is_sent_only_where_it_differs_from_the_items() {
        let held = held_at("2026-10-06T00:00:00.000Z");
        let moved = own_changes(
            &naming(Some("2026-10-07T00:00:00.000Z")),
            Standing::Current,
            &held,
            None,
            Some(2),
        );
        assert_eq!(
            moved.changes.occurred_at.as_deref(),
            Some("2026-10-07T00:00:00.000Z")
        );
        for same in [Some("2026-10-06T00:00:00.000Z"), None] {
            let quiet = own_changes(&naming(same), Standing::Current, &held, None, Some(2));
            assert!(quiet.changes.is_empty(), "{same:?} was sent as a change");
            assert_eq!(quiet.flag, None);
        }
    }

    #[test]
    fn a_files_time_behind_the_item_is_flagged_and_never_sent() {
        let held = held_at("2026-10-06T00:00:00.000Z");
        let behind = own_changes(
            &naming(Some("2026-10-01T00:00:00.000Z")),
            Standing::Behind(1),
            &held,
            None,
            Some(1),
        );
        assert!(behind.changes.is_empty());
        assert!(
            behind
                .flag
                .is_some_and(|reason| reason.contains("occurred_at")),
            "the line was not named"
        );
    }

    #[test]
    fn blob_transport_failure_does_not_complete_a_folder_pull() {
        use crate::store;
        for cause in [
            CoreError::SignedOut {
                origin: "https://marfa.example".into(),
            },
            CoreError::NoKeychain("locked".into()),
            CoreError::Network("token endpoint unavailable".into()),
            CoreError::Redirected {
                origin: String::new(),
                status: 307,
                location: Some("/next".into()),
            },
        ] {
            let server = crate::scripted::Scripted::start();
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join(STATE_DIR).join("core.sqlite");
            std::fs::create_dir_all(db.parent().unwrap()).unwrap();
            let core = working(Core::open(&db, None).unwrap()).unwrap();
            settings_file::bind(&core, "folder").unwrap();
            {
                let conn = core.conn().unwrap();
                store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
                store::meta_set(&conn, crate::read_view::FENCE, crate::scripted::FENCE).unwrap();
                store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
                store::meta_set(
                    &conn,
                    store::META_SLICE_TYPES,
                    "[\"core.note\",\"core.file\"]",
                )
                .unwrap();
                store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
                store::replace_types(
                    &conn,
                    &[
                        store::testing::wire_type("core.note", None, Some("title")),
                        store::testing::wire_type("core.file", None, Some("title")),
                    ],
                )
                .unwrap();
            }
            core.create_item(&Draft {
                r#type: "core.note".into(),
                properties: serde_json::json!({ "title": "queued", "body": "keep me" })
                    .as_object()
                    .unwrap()
                    .clone(),
                ..Default::default()
            })
            .unwrap();
            drop(core);
            let folder = Folder::open(
                dir.path(),
                Some(Server {
                    url: server.url(),
                    key: "fixture".into(),
                }),
            )
            .unwrap();
            let before = folder.core.queue().unwrap();
            let (expected, answer) = if let CoreError::Redirected {
                status, location, ..
            } = cause
            {
                (
                    CoreError::Redirected {
                        origin: server.url(),
                        status,
                        location,
                    },
                    crate::scripted::Answer::Json {
                        status,
                        body: "{}".into(),
                        headers: vec![("Location".into(), "/next".into())],
                    },
                )
            } else {
                let expected = CoreError::RenewalFailed(Box::new(cause.clone()));
                folder
                    .core
                    .renew_credential_with(Box::new(move |_| Err(cause.clone())));
                (expected, crate::scripted::refusal(401, "unauthorized"))
            };
            let hash = crate::blob::name_of(b"fixture");
            server.on(&format!("/blobs/{hash}/url"), vec![answer]);
            let mut item = store::testing::note("file", "fixture.bin", "", "2026-01-01T00:00:00Z");
            item.r#type = "core.file".into();
            item.properties
                .insert("blob_ref".into(), hash.clone().into());
            let item = {
                let conn = folder.core.conn().unwrap();
                store::upsert_item(&conn, &item, None, &Default::default()).unwrap();
                store::item_by_id(&conn, "file").unwrap().unwrap()
            };
            let catalog = Catalog::load(&folder.core.conn().unwrap()).unwrap();
            let names = Names::load(&folder.core.conn().unwrap(), &catalog, &BoundFiles).unwrap();
            let edge_types = EdgeTypes::default();
            let context = crate::read_view::Context::capture(&folder.core.conn().unwrap()).unwrap();
            let rendering = Rendering {
                context: std::cell::RefCell::new(context),
                catalog: &catalog,
                names: &names,
                edge_types: &edge_types,
            };
            let entry = Placing {
                item: &item,
                bound: None,
                want: "fixture.bin".into(),
                rank: placement::unplaced_rank(true),
                taken: None,
            };
            let mut report = PullReport::default();
            let outcome =
                folder.write_placed(&entry, &rendering, &Default::default(), None, &mut report);
            assert_eq!(outcome.err(), Some(expected));
            assert_eq!(report.absent, 0);
            assert_eq!(folder.core.queue().unwrap(), before);
            assert!(!dir.path().join("fixture.bin").exists());
            assert_eq!(server.seen(&format!("/blobs/{hash}/url")).len(), 1);
        }
    }

    #[test]
    fn a_name_from_a_title_fits_a_file_system_and_holds_no_control_character() {
        assert_eq!(name_from_title("a/b\\c:d", Some(".md")), "a-b-c-d.md");
        assert_eq!(
            name_from_title("Line one\nLine two\tend\u{7f}", Some(".md")),
            "Line one Line two end.md"
        );
        assert_eq!(name_from_title(" \n.hidden\r", Some(".md")), "hidden.md");
        assert_eq!(name_from_title("\t\n", Some(".md")), "untitled.md");

        let long = "\u{65e5}".repeat(100);
        let named = name_from_title(&long, Some(".md"));
        assert!(named.len() <= 255, "{} bytes", named.len());
        assert_eq!(named, format!("{}.md", "\u{65e5}".repeat(84)));
        let emoji = format!("x{}", "\u{1f600}".repeat(80));
        let named = name_from_title(&emoji, Some(".md"));
        assert_eq!(named, format!("x{}.md", "\u{1f600}".repeat(62)));

        // A file item's title carries its extension, which the cut keeps.
        let photo = name_from_title(&format!("{}.jpeg", "p".repeat(300)), None);
        assert_eq!(photo, format!("{}.jpeg", "p".repeat(250)));
        // Text after a dot too long to be an extension is cut as the name.
        let dotted = format!("Plan.{}", "q".repeat(300));
        let named = name_from_title(&dotted, None);
        assert_eq!(named.len(), 255);
        assert!(named.starts_with("Plan.q"));
        // A name at the limit already is left whole.
        let exact = format!("{}.md", "e".repeat(252));
        assert_eq!(name_from_title(&"e".repeat(252), Some(".md")), exact);
    }

    #[test]
    fn a_folder_another_process_holds_is_refused_before_it_is_worked() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let holder = Core::open(state.join("core.sqlite"), None).unwrap();
        settings_file::bind(&holder, "01a00000-0000-7000-8000-000000000001").unwrap();
        assert!(
            matches!(
                Folder::open(dir.path(), None),
                Err(CoreError::ReadingHandle)
            ),
            "a second opener was handed a folder to work beside the one holding it"
        );
        assert!(working(holder).is_ok());
    }

    #[test]
    fn a_folder_waiting_for_its_first_sync_refuses_every_step_that_writes_or_sends() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join(STATE_DIR);
        std::fs::create_dir_all(&state).unwrap();
        let core = Core::open(state.join("core.sqlite"), None).unwrap();
        settings_file::bind(&core, "01a00000-0000-7000-8000-000000000001").unwrap();
        drop(core);
        let folder = Folder::open(dir.path(), None).unwrap();
        assert!(
            !folder.awaiting_confirmation().unwrap(),
            "a store made without an add has never been asked"
        );
        folder.wait_for_confirmation().unwrap();
        assert!(folder.awaiting_confirmation().unwrap());

        assert!(matches!(folder.drain(), Err(CoreError::FirstSyncWaiting)));
        assert!(matches!(folder.pull(), Err(CoreError::FirstSyncWaiting)));
        assert!(matches!(
            folder.send_settings_edit(),
            Err(CoreError::FirstSyncWaiting)
        ));
        assert!(matches!(folder.restore(), Err(CoreError::FirstSyncWaiting)));
        let stop = AtomicBool::new(false);
        assert!(matches!(
            folder.watch(&stop, |_| Ok::<(), ()>(())),
            Err(WatchError::Core(CoreError::FirstSyncWaiting))
        ));

        // The witness: confirmed, the same calls are not refused for waiting.
        assert!(folder.confirm_first_sync().unwrap());
        assert!(!folder.confirm_first_sync().unwrap());
        assert!(!matches!(folder.pull(), Err(CoreError::FirstSyncWaiting)));
        assert!(!matches!(folder.drain(), Err(CoreError::FirstSyncWaiting)));
    }
}
