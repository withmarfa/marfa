use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use super::lists::Lists;
use super::registry::{Registered, Registry};
use super::{Catalog, Folder, STATE_DIR, carries_frontmatter, identity, plainly_inside, state};
use crate::directory::Directory;
use crate::{Core, Result, store};

const META_STORE: &str = "folder_store";
const META_LISTED_IN: &str = "folder_listed_in";
/// The other folders it last found, kept for a registry that loses them.
pub(super) const META_OTHERS: &str = "folder_others";

/// This folder's store id, made the first time it is asked for.
pub(super) fn store_id(core: &Core) -> Result<String> {
    let conn = core.conn()?;
    if let Some(id) = store::meta_get(&conn, META_STORE)? {
        return Ok(id);
    }
    let id = uuid::Uuid::now_v7().to_string();
    store::meta_set(&conn, META_STORE, &id)?;
    Ok(id)
}

/// This folder's store id where it has one, without making one.
pub(super) fn listed_store(core: &Core) -> Option<String> {
    let conn = core.conn().ok()?;
    store::meta_get(&conn, META_STORE).ok()?
}

pub(super) fn listed_in(core: &Core, registry: &Registry) {
    if let Ok(conn) = core.conn() {
        let _ = store::meta_set(
            &conn,
            META_LISTED_IN,
            &registry.path().display().to_string(),
        );
    }
}

pub(super) fn lost(core: &Core, registry: &Registry) -> bool {
    !registry.path().exists()
        && core
            .conn()
            .ok()
            .and_then(|conn| store::meta_get(&conn, META_LISTED_IN).ok()?)
            == Some(registry.path().display().to_string())
}

#[cfg(test)]
pub(super) fn remembered_dirs(folder: &Folder) -> Vec<PathBuf> {
    store::meta_get(&folder.core.conn().unwrap(), META_OTHERS)
        .unwrap()
        .map(|json| serde_json::from_str::<Vec<Registered>>(&json).unwrap())
        .unwrap_or_default()
        .into_iter()
        .map(|entry| entry.dir)
        .collect()
}

pub(super) struct Peer {
    root: PathBuf,
    /// Found in an earlier pass, though the registry no longer lists it.
    remembered: bool,
    root_dir: Option<Directory>,
    /// Its store, read only; `None` where it cannot be opened.
    folder: Option<Folder>,
    members: OnceCell<Option<HashSet<String>>>,
    walked: OnceCell<Walked>,
    /// Its bindings by path; `None` where its store cannot be read.
    bound: OnceCell<Option<HashMap<String, Binding>>>,
    catalog: OnceCell<Option<Catalog>>,
}

struct Binding {
    item: String,
    hash: String,
    identity: Option<String>,
}

/// Another folder's directory, walked once a pass.
struct Walked {
    files: Vec<OnDisk>,
    partial: Option<String>,
}

struct OnDisk {
    key: String,
    path: PathBuf,
    captured: Option<super::Captured>,
    mark: Option<String>,
    id: Option<String>,
    hash: OnceCell<Option<String>>,
}

impl OnDisk {
    fn hash(&self) -> Option<&str> {
        self.hash
            .get_or_init(|| {
                self.captured
                    .as_ref()?
                    .read()
                    .ok()
                    .map(|bytes| state::hash(&bytes))
            })
            .as_deref()
    }
}

impl Peer {
    fn open(entry: Registered, remembered: bool) -> Peer {
        let root = entry.dir;
        let mut root_dir = Directory::open(&root)
            .ok()
            .filter(|root| super::admitted_root(root).is_ok());
        let folder = root_dir.as_ref().and_then(|root_dir| {
            let state_dir = root_dir.child(Path::new(STATE_DIR), false).ok()?;
            let core =
                Core::read_directory(&state_dir, &root.join(STATE_DIR).join("core.sqlite")).ok()?;
            let folder = super::settings_file::bound(&core).ok()??;
            if folder != entry.folder
                || entry.store.as_ref().is_some_and(|expected| {
                    core.conn()
                        .ok()
                        .and_then(|conn| store::meta_get(&conn, META_STORE).ok().flatten())
                        .as_ref()
                        != Some(expected)
                })
            {
                return None;
            }
            Some(Folder {
                root: root.clone(),
                root_dir: root_dir.clone(),
                store_mark: state_dir.entry_identity(Path::new("core.sqlite")).ok()?,
                state_dir,
                unflushed: Default::default(),
                writers: Default::default(),
                writer_wait: Default::default(),
                folder,
                core,
                key: std::sync::Mutex::new(None),
                unread_give_ways: std::sync::Mutex::new(Default::default()),
                kept_looked: std::sync::Mutex::new(None),
                released: std::sync::Mutex::default(),
                permissions: std::sync::OnceLock::new(),
                refused_renames: std::sync::Mutex::new(Default::default()),
                barred: std::sync::Mutex::new(None),
                health_status: std::sync::Mutex::new(None),
                last_reads: std::sync::Mutex::default(),
                inventory: std::sync::Mutex::default(),
                every_addition: std::sync::atomic::AtomicBool::new(false),
                unwatched: std::sync::atomic::AtomicUsize::new(0),
                replaced: None,
            })
        });
        if folder.is_none() {
            root_dir = None;
        }
        Peer {
            root,
            remembered,
            root_dir,
            folder,
            members: OnceCell::new(),
            walked: OnceCell::new(),
            bound: OnceCell::new(),
            catalog: OnceCell::new(),
        }
    }

    /// Whether its store, read, follows a folder other than `own`; one of the
    /// same folder holds the same query, perhaps not yet read.
    fn follows_another(&self, own: &str) -> bool {
        self.folder
            .as_ref()
            .is_some_and(|folder| folder.folder != own)
    }

    /// Whether its query holds the item; `None` where its copy cannot say.
    fn holds(&self, item_id: &str) -> Option<bool> {
        self.members
            .get_or_init(|| {
                let folder = self.folder.as_ref()?;
                folder
                    .settings()
                    .and_then(|settings| folder.members(&settings))
                    .ok()
            })
            .as_ref()
            .map(|members| members.contains(item_id))
    }

    /// Whether its copy holds the item as bytes rather than as a document.
    fn file_item(&self, item_id: &str) -> bool {
        let Some(folder) = &self.folder else {
            return false;
        };
        let catalog = self
            .catalog
            .get_or_init(|| crate::catalog::load(&*folder.core.conn().ok()?).ok());
        catalog
            .as_ref()
            .is_some_and(|catalog| folder.file_item(item_id, catalog).unwrap_or(false))
    }

    fn bound(&self) -> &HashMap<String, Binding> {
        static NONE: std::sync::LazyLock<HashMap<String, Binding>> =
            std::sync::LazyLock::new(HashMap::new);
        self.bindings().unwrap_or(&NONE)
    }

    /// Its bindings, or `None` where it has a store that cannot be read.
    fn bindings(&self) -> Option<&HashMap<String, Binding>> {
        self.bound
            .get_or_init(|| {
                let Some(folder) = &self.folder else {
                    return Some(HashMap::new());
                };
                let rows = state::every_bound(&*folder.core.conn().ok()?).ok()?;
                Some(
                    rows.into_iter()
                        .map(|bound| {
                            let binding = Binding {
                                item: bound.item_id,
                                hash: bound.content_hash,
                                identity: bound.identity,
                            };
                            (bound.path, binding)
                        })
                        .collect(),
                )
            })
            .as_ref()
    }

    /// Whether its whole directory and its record were read, so what it
    /// holds can be told.
    fn readable(&self) -> bool {
        self.bindings().is_some() && self.walked().partial.is_none()
    }

    /// Whether its next scan takes `file`, which carries no id and which it
    /// has not bound, as `item_id` by the missing file's binding: it holds no
    /// file of the item already, and its lists take the file. Only that
    /// binding names the item to it (`left_behind`).
    fn awaits(&self, file: &OnDisk, item_id: &str, file_item: bool) -> bool {
        let Some(folder) = &self.folder else {
            return false;
        };
        let bound = self.bound();
        file.id.is_none()
            && (file_item || !carries_frontmatter(&file.path))
            && !bound.contains_key(&file.key)
            && !bound.values().any(|bound| bound.item == item_id)
            && folder
                .settings()
                .and_then(|settings| settings.lists())
                .is_ok_and(|lists| lists.takes(&file.key))
    }

    fn present(&self, key: &str) -> bool {
        self.root_dir.as_ref().is_some_and(|root| {
            plainly_inside(root, key) && root.entry_metadata(Path::new(key)).is_ok()
        })
    }

    fn walked(&self) -> &Walked {
        self.walked.get_or_init(|| {
            #[cfg(test)]
            super::tests::PEERS_WALKED.with(|walked| walked.set(walked.get() + 1));
            let mut walked = super::Walked::default();
            let mut partial = if self
                .folder
                .as_ref()
                .is_some_and(|folder| folder.root_gone().is_some())
            {
                Some("the other folder is no longer at its admitted directory".into())
            } else if let Some(root_dir) = &self.root_dir {
                let include = self
                    .folder
                    .as_ref()
                    .and_then(|folder| folder.settings().ok())
                    .map(|settings| settings.include)
                    .unwrap_or_default();
                match Lists::wider(&include) {
                    Ok(lists) => {
                        super::walk(&self.root, &self.root, root_dir, &lists, &mut walked);
                        walked
                            .directories
                            .iter()
                            .find(|dir| dir.flag != "package")
                            .map(|dir| format!("{} {}", dir.path, dir.reason))
                    }
                    Err(error) => Some(error.to_string()),
                }
            } else if self.remembered {
                Some(format!(
                    "the folder {} cannot be reached, and the registry no longer lists it; if its volume is not mounted, mount it",
                    self.root.display()
                ))
            } else {
                Some(format!(
                    "the folder {} cannot be reached; if it is gone, `folders remove` it",
                    self.root.display()
                ))
            };
            let files = walked
                .files
                .into_iter()
                .filter_map(|path| {
                    let key = identity::relative(&self.root, &path).ok()?;
                    let captured = walked.opened.remove(&path);
                    let mark = match &captured {
                        Some(captured) => identity::unshared(&captured.metadata.borrow()),
                        None => walked.unread.get(&path).copied(),
                    }
                    .map(|found| found.key());
                    let id = if let Some(captured) = &captured {
                        if carries_frontmatter(&path) {
                            match captured.open().and_then(id_of_reader) {
                                Ok(id) => id,
                                Err(error) => {
                                    partial = Some(format!(
                                        "{} cannot be read ({error})",
                                        path.display()
                                    ));
                                    None
                                }
                            }
                        } else {
                            None
                        }
                    } else {
                        partial = Some(format!("{} could not be opened", path.display()));
                        None
                    };
                    Some(OnDisk {
                        key,
                        path,
                        captured,
                        mark,
                        id,
                        hash: OnceCell::new(),
                    })
                })
                .collect();
            Walked { files, partial }
        })
    }

    fn files(&self) -> &[OnDisk] {
        &self.walked().files
    }
}

#[cfg(test)]
fn id_of_file(mut file: std::fs::File) -> Option<String> {
    use std::io::Seek;
    file.rewind().ok()?;
    id_of_reader(file).ok().flatten()
}

type CodeUnit = fn([u8; 2]) -> u16;

/// Read only the frontmatter, preserving an I/O failure as uncertainty. A
/// line that is not UTF-8 is read as the folder's own scan reads it, with its
/// ASCII id line intact, so bytes that are not text hold no id and are not
/// an I/O failure. A file that opens with a UTF-16 byte-order mark, or with
/// a frontmatter fence in UTF-16 and no mark, is read as UTF-16, so a moved
/// file saved again that way still shows where it came from.
pub(super) fn id_of_reader(reader: impl std::io::Read) -> std::io::Result<Option<String>> {
    let mut reader = BufReader::new(reader);
    let (wide, mark): (Option<CodeUnit>, usize) = match reader.fill_buf()? {
        [0xff, 0xfe, ..] => (Some(u16::from_le_bytes), 2),
        [0xfe, 0xff, ..] => (Some(u16::from_be_bytes), 2),
        [b'-', 0, b'-', 0, b'-', 0, ..] => (Some(u16::from_le_bytes), 0),
        [0, b'-', 0, b'-', 0, b'-', ..] => (Some(u16::from_be_bytes), 0),
        _ => (None, 0),
    };
    reader.consume(mark);
    let mut next = || match wide {
        Some(unit) => wide_line(&mut reader, unit),
        None => narrow_line(&mut reader),
    };
    let Some(line) = next()? else {
        return Ok(None);
    };
    let first = line.strip_prefix(super::document::MARK).unwrap_or(&line);
    if first.trim_end() != "---" {
        return Ok(None);
    }
    while let Some(line) = next()? {
        if line.trim_end() == "---" {
            return Ok(None);
        }
        if let Some(value) = line.strip_prefix("marfa_id:") {
            return Ok(super::document::id_value(value.as_bytes()));
        }
    }
    Ok(None)
}

/// The most bytes (UTF-8) or code units (UTF-16) of a line kept. A longer line
/// is neither a fence nor an id line, so the rest of it is read past, and a
/// file that is not text is never held whole.
const LINE_LIMIT: usize = 4096;

/// A line, or an empty one in place of a line past `LINE_LIMIT`.
fn narrow_line(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    if (&mut *reader)
        .take(LINE_LIMIT as u64)
        .read_until(b'\n', &mut line)?
        == 0
    {
        return Ok(None);
    }
    if line.len() == LINE_LIMIT && line.last() != Some(&b'\n') {
        reader.skip_until(b'\n')?;
        return Ok(Some(String::new()));
    }
    let line = String::from_utf8_lossy(&line);
    Ok(Some(line.trim_end_matches(['\n', '\r']).to_string()))
}

/// A line of UTF-16 code units, each read by `unit`, or an empty one in place
/// of a line past `LINE_LIMIT`; a byte left over at the end is no code unit
/// and is dropped.
fn wide_line(
    reader: &mut impl BufRead,
    unit: fn([u8; 2]) -> u16,
) -> std::io::Result<Option<String>> {
    let mut units = Vec::new();
    let mut pair = [0u8; 2];
    let (mut ended, mut long) = (false, false);
    loop {
        match reader.read_exact(&mut pair) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                ended = true;
                break;
            }
            Err(error) => return Err(error),
        }
        let read = unit(pair);
        if read == u16::from(b'\n') {
            break;
        }
        if units.len() == LINE_LIMIT {
            long = true;
        } else {
            units.push(read);
        }
    }
    if ended && units.is_empty() {
        return Ok(None);
    }
    if long {
        return Ok(Some(String::new()));
    }
    let line = String::from_utf16_lossy(&units);
    Ok(Some(line.trim_end_matches('\r').to_string()))
}

/// What a missing file left to be found by.
pub(super) struct Lost<'a> {
    pub path: &'a str,
    pub item_id: &'a str,
    pub identity: Option<&'a str>,
    /// `None` where its binding is gone, which leaves no bytes to match.
    pub content_hash: Option<&'a str>,
}

impl<'a> From<&'a state::Bound> for Lost<'a> {
    fn from(bound: &'a state::Bound) -> Lost<'a> {
        Lost {
            path: &bound.path,
            item_id: &bound.item_id,
            identity: bound.identity.as_deref(),
            content_hash: Some(&bound.content_hash),
        }
    }
}

/// Which other folders a look for a missing file reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Among {
    /// Every one: one that cannot be read leaves the move untold.
    Every,
    /// Only those read whole, for the person who asked for the delete.
    Readable,
}

pub(super) enum Look {
    Moved,
    /// Moved to a folder whose next scan takes the file by the missing
    /// file's binding, which that folder has not read yet.
    Arriving,
    Nowhere,
    Unsure(String),
}

/// The other folders the registry lists, opened when first asked after.
pub(super) struct Peers<'a> {
    of: &'a Folder,
    doubt: Option<String>,
    loaded: OnceCell<Loaded>,
}

#[derive(Default)]
struct Loaded {
    peers: Vec<Peer>,
    /// Why the registry cannot be read.
    unreadable: Option<String>,
    /// Why the folders found could not be added to those this folder
    /// remembers.
    unrecorded: Option<String>,
}

impl<'a> Peers<'a> {
    /// `doubt` is why this pass cannot tell a move, where it cannot.
    pub(super) fn of(folder: &'a Folder, doubt: Option<String>) -> Peers<'a> {
        Peers {
            of: folder,
            doubt,
            loaded: OnceCell::new(),
        }
    }

    /// The listed folders and those this folder found before, so a registry
    /// that lost them, or a folder taken off the computer while it still held
    /// a moved file, does not hide them; an unreadable registry leaves none,
    /// and says why.
    fn loaded(&self) -> &Loaded {
        self.loaded.get_or_init(|| {
            let Some(registry) = Registry::located() else {
                return Loaded::default();
            };
            // This root and every listed entry are already resolved, and
            // resolving an entry again would follow a link that has replaced
            // its directory since.
            let own = &self.of.root;
            let listed = match registry.folders() {
                Ok(listed) => listed,
                Err(error) => {
                    return Loaded {
                        unreadable: Some(error.to_string()),
                        ..Loaded::default()
                    };
                }
            };
            let conn = self.of.core.conn();
            let stored = conn
                .as_ref()
                .ok()
                .and_then(|conn| store::meta_get(conn, META_OTHERS).ok()?);
            let known: Vec<Registered> = stored
                .as_deref()
                .and_then(|json| serde_json::from_str(json).ok())
                .unwrap_or_default();
            let mut others: Vec<Registered> = listed
                .into_iter()
                .filter(|entry| &entry.dir != own)
                .collect();
            let listed = others.len();
            for entry in known {
                let listed = others.iter().any(|other| {
                    other.dir == entry.dir || (entry.store.is_some() && other.store == entry.store)
                });
                if !listed && &entry.dir != own {
                    others.push(entry);
                }
            }
            let recorded = conn.and_then(|conn| {
                let json = serde_json::to_string(&others)
                    .map_err(|error| crate::CoreError::Store(error.to_string()))?;
                if stored.as_deref() == Some(json.as_str()) {
                    return Ok(());
                }
                store::meta_set(&conn, META_OTHERS, &json)
            });
            Loaded {
                peers: others
                    .into_iter()
                    .enumerate()
                    .map(|(at, entry)| Peer::open(entry, at >= listed))
                    .collect(),
                unreadable: None,
                unrecorded: recorded.err().map(|error| error.to_string()),
            }
        })
    }

    fn all(&self) -> &[Peer] {
        &self.loaded().peers
    }

    /// Adds the other folders there are now to those this folder remembers,
    /// so one taken off the computer before the grace is over still counts;
    /// says why where they could not be added.
    pub(super) fn remember(&self) -> std::result::Result<(), String> {
        match &self.loaded().unrecorded {
            Some(why) => Err(format!(
                "the other folders on this computer could not be recorded ({why}), so Marfa cannot tell its delete from a move into one of them"
            )),
            None => Ok(()),
        }
    }

    /// Why a missing file no other folder is found to hold is not trashed,
    /// or `None` where it is: this computer has no other folder, listed or
    /// remembered (`folder-files/missing-file-trashed`,
    /// `folder-files/missing-file-held`).
    pub(super) fn withheld(&self) -> Option<String> {
        if let Some(why) = &self.doubt {
            return Some(why.clone());
        }
        if let Some(why) = self.unreadable() {
            return Some(format!(
                "the list of folders on this computer cannot be read ({why}), so Marfa cannot tell its delete from a move into another folder"
            ));
        }
        match self.all() {
            [] => None,
            [peer] => Some(format!(
                "another folder is on this computer, at {}, so Marfa cannot tell its delete from a move into it",
                peer.root.display()
            )),
            peers => Some(format!(
                "{} other folders are on this computer, so Marfa cannot tell its delete from a move into one of them",
                peers.len()
            )),
        }
    }

    fn other_folders(&self) -> impl Iterator<Item = &Peer> {
        self.all()
            .iter()
            .filter(|peer| peer.follows_another(&self.of.folder))
    }

    pub(super) fn unreadable(&self) -> Option<&str> {
        self.loaded().unreadable.as_deref()
    }

    /// Directories following one folder can retain the same unmatched item.
    pub(super) fn carry(&self, item_id: &str) -> bool {
        self.other_folders().any(|peer| {
            peer.files()
                .iter()
                .any(|file| file.id.as_deref() == Some(item_id))
        })
    }

    /// Whether another folder holds, unbound, a file carrying the id: a move
    /// its next scan takes.
    pub(super) fn arriving(&self, item_id: &str) -> bool {
        self.all().iter().any(|peer| {
            peer.folder.is_some()
                && peer.files().iter().any(|file| {
                    file.id.as_deref() == Some(item_id)
                        && peer
                            .bound()
                            .get(&file.key)
                            .is_none_or(|bound| bound.item != item_id)
                })
        })
    }

    /// Whether another folder's copy holds the item as a document. A copy
    /// narrowed by its query still holds every item its folder's files name,
    /// since each binding pins its item until the file is let go.
    pub(super) fn held_elsewhere(&self, item_id: &str) -> bool {
        self.all().iter().any(|peer| {
            peer.folder.as_ref().is_some_and(|folder| {
                folder
                    .core
                    .get(item_id)
                    .ok()
                    .flatten()
                    .is_some_and(|item| !marfa_rules::folder::is_hidden(&item.r#type))
            })
        })
    }

    /// Another folder's binding of an id-less file gone from it, by identity
    /// or unique bytes, its path given whole. `markdown` is whether the
    /// arriving file is at a Markdown name.
    ///
    /// A note's Markdown file carries its id line, so an arriving Markdown
    /// file without one is a file item's or a new item, and a note's missing
    /// Markdown file is not known by its bytes. A file item's file is its
    /// bytes whatever its name.
    pub(super) fn left_behind(
        &self,
        mark: Option<&str>,
        hash: &str,
        markdown: bool,
    ) -> Option<state::Bound> {
        let mut same_bytes = Vec::new();
        for peer in self.all() {
            let Some(folder) = &peer.folder else {
                continue;
            };
            // Each read lets go of the connection before `takes`, which asks
            // for it again.
            let read = |rows: fn(&rusqlite::Connection, &str) -> Result<Vec<state::Bound>>,
                        key: &str| {
                folder
                    .core
                    .conn()
                    .ok()
                    .map(|conn| rows(&conn, key).unwrap_or_default())
            };
            let whole = |bound: state::Bound| state::Bound {
                path: peer.root.join(&bound.path).display().to_string(),
                ..bound
            };
            let takes = |bound: &state::Bound, by_bytes: bool| {
                peer.file_item(&bound.item_id)
                    || !(markdown || by_bytes && carries_frontmatter(Path::new(&bound.path)))
            };
            if let Some(found) = mark
                .and_then(|mark| read(state::bound_with_identity, mark))
                .and_then(|rows| rows.into_iter().find(|bound| !peer.present(&bound.path)))
            {
                return takes(&found, false).then(|| whole(found));
            }
            same_bytes.extend(
                read(state::bound_with_hash, hash)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|bound| !peer.present(&bound.path) && takes(bound, true))
                    .map(whole),
            );
        }
        (same_bytes.len() == 1).then(|| same_bytes.remove(0))
    }

    /// Where the lost file went: a move only where one file in one other
    /// folder is it, and no other file of this folder could be that file
    /// instead (`folder-files/moved-file-unique`). `file_item` is
    /// whether this folder's copy holds the lost file's item as bytes: a
    /// note's Markdown file is followed by its id line, and a file item's
    /// file by its bytes whatever its name.
    pub(super) fn moved_to(
        &self,
        lost: &Lost<'_>,
        held_here: bool,
        file_item: bool,
        among: Among,
    ) -> Look {
        let every = among == Among::Every;
        if every && let Some(why) = self.doubt.as_deref().or(self.unreadable()) {
            return Look::Unsure(why.to_string());
        }
        let peers: Vec<&Peer> = self
            .all()
            .iter()
            .filter(|peer| every || peer.readable())
            .collect();
        let item = lost.item_id;
        let arrival = |peer: &Peer, file: &OnDisk| {
            if peer.awaits(file, item, file_item) {
                Look::Arriving
            } else {
                Look::Moved
            }
        };
        if let Some(peer) = peers.iter().find(|peer| peer.bindings().is_none()) {
            return Look::Unsure(format!(
                "the record of the folder at {} cannot be read",
                peer.root.display()
            ));
        }
        if let Some(identity) = lost.identity {
            let same: Vec<(&Peer, &OnDisk)> = peers
                .iter()
                .flat_map(|peer| {
                    peer.files()
                        .iter()
                        .filter(|file| file.mark.as_deref() == Some(identity))
                        .map(move |file| (*peer, file))
                })
                .collect();
            match same.as_slice() {
                [] => {}
                // A file it bound before is its own, unless it took it in by
                // this identity, as a move it read first.
                [(peer, file)] => {
                    return match peer.bound().get(&file.key) {
                        Some(bound)
                            if bound.item != item
                                || bound.identity.as_deref() != Some(identity) =>
                        {
                            Look::Unsure(format!(
                                "{} is the same file on the disk, and the folder there already holds it as a file of its own",
                                file.path.display()
                            ))
                        }
                        _ => arrival(peer, file),
                    };
                }
                _ => {
                    return Look::Unsure(format!(
                        "{} files in other folders are the same file on the disk, and which it became cannot be told",
                        same.len()
                    ));
                }
            }
        }
        if let Some(why) = peers.iter().find_map(|peer| peer.walked().partial.clone()) {
            return Look::Unsure(why);
        }
        // Where both folders hold the item, the other's file of it is its
        // own, not this one moved.
        let theirs = |peer: &Peer, file: &OnDisk| {
            held_here
                && peer.holds(item) == Some(true)
                && peer
                    .bound()
                    .get(&file.key)
                    .is_some_and(|bound| bound.item == item)
        };
        if !file_item && carries_frontmatter(Path::new(lost.path)) {
            let found = peers
                .iter()
                .flat_map(|peer| {
                    peer.files()
                        .iter()
                        .filter(move |file| file.id.as_deref() == Some(item) && !theirs(peer, file))
                })
                .count();
            return match found {
                0 => Look::Nowhere,
                1 => Look::Moved,
                _ => Look::Unsure(format!(
                    "{found} files in other folders carry its id, and which it became cannot be told"
                )),
            };
        }
        let Some(lost_hash) = lost.content_hash else {
            return Look::Nowhere;
        };
        // A file with bytes two of this folder's files had could be either.
        match self
            .of
            .core
            .conn()
            .and_then(|conn| state::bound_with_hash(&conn, lost_hash))
        {
            Ok(sources) if sources.len() > 1 => {
                return Look::Unsure(format!(
                    "{} files in this folder have its bytes, and which of them a file with them is cannot be told",
                    sources.len()
                ));
            }
            Ok(_) => {}
            Err(error) => {
                return Look::Unsure(format!(
                    "which of this folder's files have its bytes cannot be read ({error})"
                ));
            }
        }
        // Bytes another folder knows as another item could be either's.
        if let Some(peer) = peers.iter().find(|peer| {
            peer.bound()
                .values()
                .any(|bound| bound.item != item && bound.hash == lost_hash)
        }) {
            return Look::Unsure(format!(
                "the folder at {} knows another item by its bytes, and which item a file with them is cannot be told",
                peer.root.display()
            ));
        }
        let mut matches = 0;
        let mut last = None;
        for peer in peers {
            let bound = peer.bound();
            for file in peer.files() {
                // A Markdown file with an id line is that id's note, and the
                // arriving side takes one without it only for a file item.
                if carries_frontmatter(&file.path) && (!file_item || file.id.is_some())
                    || theirs(peer, file)
                {
                    continue;
                }
                let same = match bound.get(&file.key) {
                    Some(bound) => bound.item == item && bound.hash == lost_hash,
                    None => match file.hash() {
                        Some(hash) => hash == lost_hash,
                        None => {
                            return Look::Unsure(format!(
                                "{} could not be read in the other folder",
                                file.path.display()
                            ));
                        }
                    },
                };
                if same {
                    matches += 1;
                    last = Some((peer, file));
                }
            }
        }
        match (matches, last) {
            (1, Some((peer, file))) => arrival(peer, file),
            (0, _) => Look::Nowhere,
            _ => Look::Unsure(format!(
                "{} files in other folders have its bytes, and which it became cannot be told",
                matches
            )),
        }
    }
}

#[cfg(test)]
fn id_of(path: &Path) -> Option<String> {
    id_of_file(std::fs::File::open(path).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn an_unreadable_moved_file_keeps_its_peer_identity() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let from = temp.path().join("from");
        let to = temp.path().join("to");
        std::fs::create_dir(&from).unwrap();
        std::fs::create_dir(&to).unwrap();
        let note = from.join("note.md");
        std::fs::write(&note, "---\nmarfa_id: n1\n---\noriginal\n").unwrap();
        let mark = identity::of(&std::fs::metadata(&note).unwrap())
            .unwrap()
            .key();
        let peer = || Peer {
            root: to.clone(),
            remembered: false,
            root_dir: Some(Directory::open(&to).unwrap()),
            folder: None,
            members: OnceCell::new(),
            walked: OnceCell::new(),
            bound: OnceCell::new(),
            catalog: OnceCell::new(),
        };
        let moved = to.join("moved.md");
        std::fs::rename(&note, &moved).unwrap();
        let readable = peer();
        assert_eq!(readable.files()[0].mark.as_deref(), Some(mark.as_str()));
        assert_eq!(readable.files()[0].id.as_deref(), Some("n1"));
        let _sealed = crate::test_folders::locked(&moved, 0o000);
        let unreadable = peer();
        let retained = unreadable
            .files()
            .iter()
            .any(|file| file.mark.as_deref() == Some(mark.as_str()));
        std::fs::set_permissions(&moved, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(retained, "the peer lost the moved file's observed identity");
    }

    #[test]
    fn a_peer_whose_directory_now_leads_into_this_folder_stays_a_peer() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let make = |dir: &Path, folder: &str| {
            std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
            let core = Core::open(dir.join(STATE_DIR).join("core.sqlite"), None).unwrap();
            super::super::settings_file::bind(&core, folder).unwrap();
        };
        let first = temp.path().join("a/notes");
        let second = temp.path().join("b/notes");
        make(&first, "01a00000-0000-7000-8000-000000000001");
        make(&second, "01a00000-0000-7000-8000-000000000002");
        drop(Folder::open(&first, None).unwrap());
        drop(Folder::open(&second, None).unwrap());
        std::fs::rename(temp.path().join("a"), temp.path().join("a-moved")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("b"), temp.path().join("a")).unwrap();

        let folder = Folder::open(&second, None).unwrap();
        let peers = Peers::of(&folder, None);
        let listed = peers.all().iter().find(|peer| peer.root == first);
        assert!(
            listed.is_some_and(|peer| peer.root_dir.is_none()),
            "a folder listed where a link now leads into this one was not kept as a peer it cannot read"
        );
    }

    #[test]
    fn a_remembered_peer_whose_state_was_removed_stays_a_peer_it_cannot_read() {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let make = |dir: &Path, folder: &str| {
            std::fs::create_dir_all(dir.join(STATE_DIR)).unwrap();
            let core = Core::open(dir.join(STATE_DIR).join("core.sqlite"), None).unwrap();
            super::super::settings_file::bind(&core, folder).unwrap();
        };
        let own = temp.path().join("own");
        let removed = temp.path().join("removed");
        let replaced = temp.path().join("replaced");
        make(&own, "01a00000-0000-7000-8000-0000000000a1");
        make(&removed, "01a00000-0000-7000-8000-0000000000a2");
        make(&replaced, "01a00000-0000-7000-8000-0000000000a3");
        let identity = Directory::open(&replaced)
            .unwrap()
            .metadata()
            .ok()
            .and_then(|metadata| identity::of(&metadata))
            .map(|identity| identity.key());
        let remembered = |dir: &Path, folder: &str, root: Option<String>| Registered {
            dir: dir.to_path_buf(),
            folder: folder.to_string(),
            store: Some(format!("store-{folder}")),
            root,
        };
        let known = vec![
            remembered(&removed, "removed", None),
            remembered(&replaced, "replaced", identity),
        ];
        std::fs::remove_dir_all(removed.join(STATE_DIR)).unwrap();
        std::fs::rename(&replaced, temp.path().join("replaced-away")).unwrap();
        std::fs::create_dir(&replaced).unwrap();

        let folder = Folder::open(&own, None).unwrap();
        store::meta_set(
            &folder.core.conn().unwrap(),
            META_OTHERS,
            &serde_json::to_string(&known).unwrap(),
        )
        .unwrap();
        let peers = Peers::of(&folder, None);
        let remaining: Vec<&Path> = peers.all().iter().map(|peer| peer.root.as_path()).collect();
        assert!(
            peers
                .all()
                .iter()
                .any(|peer| peer.root == removed && peer.folder.is_none()),
            "a folder taken off the computer, whose directory may hold a moved file, was dropped"
        );
        assert!(
            remaining.contains(&replaced.as_path()),
            "a remembered folder whose directory was replaced by an empty one was dropped"
        );
    }

    #[test]
    fn a_file_that_is_not_text_leaves_the_other_folder_complete() {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let mut utf16: Vec<u8> = vec![0xff, 0xfe];
        for unit in "---\nmarfa_id: n9\n---\nbody\n".encode_utf16() {
            utf16.extend(unit.to_le_bytes());
        }
        std::fs::write(root.join("utf16.md"), &utf16).unwrap();
        let mut big_endian: Vec<u8> = vec![0xfe, 0xff];
        for unit in "---\r\nmarfa_id: \"n8\"\r\n---\r\nb\u{e9}\u{1f600}\n".encode_utf16() {
            big_endian.extend(unit.to_be_bytes());
        }
        std::fs::write(root.join("utf16be.md"), &big_endian).unwrap();
        // With no mark, the fence alone says the bytes are UTF-16.
        std::fs::write(root.join("bare.md"), &utf16[2..]).unwrap();
        std::fs::write(root.join("barebe.md"), &big_endian[2..]).unwrap();
        // Cut off inside a code unit.
        std::fs::write(root.join("cut.md"), &utf16[..7]).unwrap();
        std::fs::write(
            root.join("latin1.md"),
            b"---\nmarfa_id: n2\ntitle: caf\xe9\n---\nbody\n",
        )
        .unwrap();
        let peer = Peer {
            root: root.clone(),
            remembered: false,
            root_dir: Some(Directory::open(&root).unwrap()),
            folder: None,
            members: OnceCell::new(),
            walked: OnceCell::new(),
            bound: OnceCell::new(),
            catalog: OnceCell::new(),
        };
        let walked = peer.walked();
        assert_eq!(walked.files.len(), 6);
        assert_eq!(
            walked.partial, None,
            "a file whose bytes are not text made the whole folder unreadable"
        );
        let id = |key: &str| {
            walked
                .files
                .iter()
                .find(|file| file.key == key)
                .and_then(|file| file.id.as_deref())
        };
        assert_eq!(
            id("utf16.md"),
            Some("n9"),
            "a file saved as UTF-16 hid the id that shows where it moved from"
        );
        assert_eq!(id("utf16be.md"), Some("n8"));
        assert_eq!(
            id("bare.md"),
            Some("n9"),
            "a file saved as UTF-16 with no mark hid the id that shows where it moved from"
        );
        assert_eq!(id("barebe.md"), Some("n8"));
        assert_eq!(id("cut.md"), None);
        assert_eq!(id("latin1.md"), Some("n2"));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_the_system_will_not_read_still_leaves_the_other_folder_partial() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let shut = root.join("shut.md");
        std::fs::write(&shut, "---\nmarfa_id: n3\n---\nbody\n").unwrap();
        let _sealed = crate::test_folders::locked(&shut, 0o000);
        let peer = Peer {
            root: root.clone(),
            remembered: false,
            root_dir: Some(Directory::open(&root).unwrap()),
            folder: None,
            members: OnceCell::new(),
            walked: OnceCell::new(),
            bound: OnceCell::new(),
            catalog: OnceCell::new(),
        };
        let partial = peer.walked().partial.clone();
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            partial.is_some(),
            "the witness: a file that cannot be read at all is doubt"
        );
    }

    #[test]
    fn a_line_past_the_limit_is_read_past_and_names_no_id() {
        let long = "x".repeat(LINE_LIMIT * 4);
        let id = |text: String| {
            let wide: Vec<u8> = std::iter::once(0xfeff)
                .chain(text.encode_utf16())
                .flat_map(u16::to_le_bytes)
                .collect();
            let narrow = id_of_reader(text.as_bytes()).unwrap();
            assert_eq!(id_of_reader(wide.as_slice()).unwrap(), narrow, "{text:.40}");
            narrow
        };
        // The witness: the id line after a long line is still read.
        assert_eq!(
            id(format!("---\nnote: {long}\nmarfa_id: n1\n---\n")).as_deref(),
            Some("n1")
        );
        assert_eq!(id(format!("---{long}\nmarfa_id: n1\n---\n")), None);
        assert_eq!(id(format!("---\nmarfa_id: {long}\n---\n")), None);
        // A value the folder's own scan takes for no id is none here either.
        let past = "a".repeat(300);
        assert_eq!(
            super::super::document::id_line(&format!("---\nmarfa_id: {past}\n---\n")),
            None
        );
        assert_eq!(id(format!("---\nmarfa_id: {past}\n---\n")), None);
    }

    #[test]
    fn a_byte_order_mark_does_not_hide_the_id() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.md");
        let marked = dir.path().join("marked.md");
        std::fs::write(&plain, "---\nmarfa_id: n1\n---\nbody\n").unwrap();
        std::fs::write(&marked, "\u{feff}---\nmarfa_id: n1\n---\nbody\n").unwrap();
        assert_eq!(id_of(&plain).as_deref(), Some("n1"));
        assert_eq!(id_of(&marked).as_deref(), Some("n1"));
    }
}
