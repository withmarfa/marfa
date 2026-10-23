use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use super::lists::Lists;
use super::registry::{Registered, Registry, gone};
use super::{Catalog, Folder, STATE_DIR, carries_frontmatter, identity, plainly_inside, state};
use crate::directory::Directory;
use crate::{Core, Result, store};

const META_STORE: &str = "folder_store";
const META_LISTED_IN: &str = "folder_listed_in";
/// The other folders it last found, kept for a registry that loses them.
const META_OTHERS: &str = "folder_others";

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

pub(super) struct Peer {
    root: PathBuf,
    root_dir: Option<Directory>,
    /// Its store, read only; `None` where it cannot be opened.
    folder: Option<Folder>,
    members: OnceCell<Option<HashSet<String>>>,
    walked: OnceCell<Walked>,
    /// Its bindings by path, as item and bytes.
    bound: OnceCell<HashMap<String, (String, String)>>,
    catalog: OnceCell<Option<Catalog>>,
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
    fn open(entry: Registered) -> Peer {
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
                folder,
                core,
                key: std::sync::Mutex::new(None),
                unread_give_ways: std::sync::Mutex::new(Default::default()),
                permissions: std::sync::OnceLock::new(),
                refused_renames: std::sync::Mutex::new(Default::default()),
            })
        });
        if folder.is_none() {
            root_dir = None;
        }
        Peer {
            root,
            root_dir,
            folder,
            members: OnceCell::new(),
            walked: OnceCell::new(),
            bound: OnceCell::new(),
            catalog: OnceCell::new(),
        }
    }

    /// Whether its search holds the item; `None` where its copy cannot say.
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

    /// Whether the item left this folder by its state or the bin, whose file
    /// that folder takes away, or pauses, rather than lets go.
    fn left_by_state(&self, item_id: &str) -> bool {
        let Some(folder) = &self.folder else {
            return true;
        };
        match (folder.settings(), folder.core.get(item_id)) {
            (Ok(settings), Ok(Some(item))) => !settings.holds_state(item.state),
            _ => true,
        }
    }

    /// Whether its copy holds the item as bytes rather than as a document.
    fn file_item(&self, item_id: &str) -> bool {
        let Some(folder) = &self.folder else {
            return false;
        };
        let catalog = self
            .catalog
            .get_or_init(|| Catalog::load(&*folder.core.conn().ok()?).ok());
        catalog
            .as_ref()
            .is_some_and(|catalog| folder.file_item(item_id, catalog).unwrap_or(false))
    }

    fn bound_to(&self, item_id: &str) -> Option<state::Bound> {
        let folder = self.folder.as_ref()?;
        state::bound_to_item(&*folder.core.conn().ok()?, item_id)
            .ok()
            .flatten()
    }

    fn bound(&self) -> &HashMap<String, (String, String)> {
        self.bound.get_or_init(|| {
            self.folder
                .as_ref()
                .and_then(|folder| state::every_bound(&*folder.core.conn().ok()?).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|bound| (bound.path, (bound.item_id, bound.content_hash)))
                .collect()
        })
    }

    /// Whether its next scan takes `file`, which carries no id and which it
    /// has not bound, as `item_id` by the missing file's binding: it holds no
    /// file of the item already, and its lists take the file. Only that
    /// binding names the item to it (`left_behind`). `bare` is whether that
    /// scan takes a Markdown file without an id line for the item.
    fn awaits(&self, file: &OnDisk, item_id: &str, bare: bool) -> bool {
        let Some(folder) = &self.folder else {
            return false;
        };
        let bound = self.bound();
        file.id.is_none()
            && (bare || !carries_frontmatter(&file.path))
            && !bound.contains_key(&file.key)
            && !bound.values().any(|(bound, _)| bound == item_id)
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
                    let mark = captured
                        .as_ref()
                        .and_then(|captured| identity::of(&captured.metadata.borrow()))
                        .or_else(|| walked.unread.get(&path).copied())
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
fn id_of_reader(reader: impl std::io::Read) -> std::io::Result<Option<String>> {
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
    loaded: OnceCell<(Vec<Peer>, Option<String>)>,
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

    /// The listed folders and those this folder found before and are still
    /// folders, so a registry that lost them does not hide them; an
    /// unreadable registry leaves none, and says why.
    fn loaded(&self) -> &(Vec<Peer>, Option<String>) {
        self.loaded.get_or_init(|| {
            let Some(registry) = Registry::located() else {
                return (Vec::new(), None);
            };
            // This root and every listed entry are already resolved, and
            // resolving an entry again would follow a link that has replaced
            // its directory since.
            let own = &self.of.root;
            let listed = match registry.folders() {
                Ok(listed) => listed,
                Err(error) => return (Vec::new(), Some(error.to_string())),
            };
            let conn = self.of.core.conn().ok();
            let known: Vec<Registered> = conn
                .as_ref()
                .and_then(|conn| store::meta_get(conn, META_OTHERS).ok()?)
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or_default();
            let mut others: Vec<Registered> = listed
                .into_iter()
                .filter(|entry| &entry.dir != own)
                .collect();
            for entry in known {
                let listed = others.iter().any(|other| {
                    other.dir == entry.dir || (entry.store.is_some() && other.store == entry.store)
                });
                if !listed && !gone(&entry) && &entry.dir != own {
                    others.push(entry);
                }
            }
            if let (Some(conn), Ok(json)) = (&conn, serde_json::to_string(&others)) {
                let _ = store::meta_set(conn, META_OTHERS, &json);
            }
            (others.into_iter().map(Peer::open).collect(), None)
        })
    }

    fn all(&self) -> &[Peer] {
        &self.loaded().0
    }

    pub(super) fn unreadable(&self) -> Option<&str> {
        self.loaded().1.as_deref()
    }

    pub(super) fn carry(&self, item_id: &str) -> bool {
        self.all().iter().any(|peer| {
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
                            .is_none_or(|(bound, _)| bound != item_id)
                })
        })
    }

    /// Whether another folder's copy holds the item as a document.
    pub(super) fn held_elsewhere(&self, item_id: &str) -> bool {
        self.all().iter().any(|peer| {
            peer.folder.as_ref().is_some_and(|folder| {
                folder
                    .core
                    .get(item_id)
                    .ok()
                    .flatten()
                    .is_some_and(|item| !item.r#type.starts_with("system."))
            })
        })
    }

    /// Another folder's binding of an id-less file gone from it, by identity
    /// or unique bytes, its path given whole. `markdown` is whether the
    /// arriving file is at a Markdown name.
    ///
    /// A note's Markdown file carries its id line once that folder wrote it,
    /// so an arriving Markdown file without one is then a file item's or a
    /// new item; before, only its identity follows it. A note's missing
    /// Markdown file is not known by its bytes, which a template's copies
    /// share. A file item's file is its bytes whatever its name.
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
                    || if by_bytes {
                        !(markdown || carries_frontmatter(Path::new(&bound.path)))
                    } else {
                        !markdown || !bound.writes.id_carried
                    }
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

    /// `file_item` is whether this folder's copy holds the lost file's item
    /// as bytes: a note's Markdown file is followed by its id line, and a
    /// file item's file by its bytes whatever its name.
    pub(super) fn moved_to(&self, lost: &state::Bound, held_here: bool, file_item: bool) -> Look {
        if let Some(why) = self.doubt.as_deref().or(self.unreadable()) {
            return Look::Unsure(why.to_string());
        }
        let peers = self.all();
        let item = lost.item_id.as_str();
        let arrival = |peer: &Peer, file: &OnDisk, by_identity: bool| {
            if peer.awaits(
                file,
                item,
                file_item || by_identity && !lost.writes.id_carried,
            ) {
                Look::Arriving
            } else {
                Look::Moved
            }
        };
        if lost.identity.is_some()
            && let Some((peer, file)) = peers.iter().find_map(|peer| {
                peer.files()
                    .iter()
                    .find(|file| file.mark == lost.identity)
                    .map(|file| (peer, file))
            })
        {
            return arrival(peer, file, true);
        }
        if lost.identity.is_some()
            && peers.iter().any(|peer| {
                peer.bound_to(item).is_some_and(|bound| {
                    bound.writes.taken_as == lost.identity
                        && peer.files().iter().any(|file| file.key == bound.path)
                })
            })
        {
            return Look::Moved;
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
                    .is_some_and(|(bound, _)| bound == item)
        };
        if !file_item && carries_frontmatter(Path::new(&lost.path)) {
            let found = peers.iter().any(|peer| {
                peer.files()
                    .iter()
                    .any(|file| file.id.as_deref() == Some(item) && !theirs(peer, file))
            });
            return if found { Look::Moved } else { Look::Nowhere };
        }
        let mut matches = 0;
        let mut last = None;
        for peer in peers {
            let bound = peer.bound();
            // Bytes that folder already knows as another item are that item's.
            if bound
                .values()
                .any(|(other, hash)| other != item && *hash == lost.content_hash)
            {
                continue;
            }
            for file in peer.files() {
                // A Markdown file with an id line is that id's note, and the
                // arriving side takes one without it only for a file item.
                if carries_frontmatter(&file.path) && (!file_item || file.id.is_some())
                    || theirs(peer, file)
                {
                    continue;
                }
                let same = match bound.get(&file.key) {
                    Some((bound, hash)) => bound == item && *hash == lost.content_hash,
                    None => match file.hash() {
                        Some(hash) => hash == lost.content_hash,
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
            (1, Some((peer, file))) => arrival(peer, file, false),
            (0, _) => Look::Nowhere,
            _ => Look::Unsure(format!(
                "{} files in other folders have its bytes, and which it became cannot be told",
                matches
            )),
        }
    }

    /// Whether another folder's own create of the item may still land, so
    /// the server cannot show the item yet. A refused create never lands,
    /// unless it was refused onto a row a read may yet find.
    pub(super) fn creating(&self, item_id: &str) -> bool {
        let may_land = |conn: &rusqlite::Connection| -> Result<bool> {
            let landings = store::pending_landings(conn)?;
            for id in store::untaken_creates_for_item(conn, item_id)? {
                let refused = store::queued_write(conn, &id)?
                    .is_some_and(|write| write.verdict == Some(crate::model::Verdict::Dead));
                if !refused || landings.contains_key(&id) {
                    return Ok(true);
                }
            }
            Ok(false)
        };
        self.all().iter().any(|peer| {
            peer.folder.as_ref().is_some_and(|folder| {
                folder
                    .core
                    .conn()
                    .ok()
                    .is_some_and(|conn| may_land(&conn).unwrap_or(false))
            })
        })
    }

    /// Whether another folder holds the item with a file of it already.
    pub(super) fn filed_elsewhere(&self, item_id: &str) -> bool {
        self.all().iter().any(|peer| {
            peer.holds(item_id) == Some(true)
                && peer
                    .bound_to(item_id)
                    .is_some_and(|bound| peer.present(&bound.path))
        })
    }

    /// A file another folder let go of, holding the bytes it wrote, to take in.
    pub(super) fn let_go(&self, item_id: &str) -> Option<(super::transfer::Entry, state::Bound)> {
        for peer in self.all() {
            let Some(bound) = peer.bound_to(item_id) else {
                continue;
            };
            if bound.held.is_some()
                || !bound.writes.refused.is_empty()
                || bound.written_hash.as_deref() != Some(bound.content_hash.as_str())
                || !peer.present(&bound.path)
                || peer.holds(item_id) != Some(false)
                || peer.left_by_state(item_id)
            {
                continue;
            }
            let path = peer.root.join(&bound.path);
            let root = peer.root_dir.as_ref()?;
            let (directory, name) = root.parent(Path::new(&bound.path), false).ok()?;
            if directory
                .read(Path::new(&name))
                .is_ok_and(|bytes| state::hash(&bytes) == bound.content_hash)
            {
                return Some((
                    super::transfer::Entry {
                        directory,
                        name: name.into(),
                        label: path,
                    },
                    bound,
                ));
            }
        }
        None
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
        std::fs::set_permissions(&moved, std::fs::Permissions::from_mode(0o000)).unwrap();
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
    fn a_remembered_peer_with_no_identity_whose_state_was_removed_is_dropped() {
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
            !remaining.contains(&removed.as_path()),
            "a remembered folder with no identity whose state was removed stayed a peer"
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
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
        let peer = Peer {
            root: root.clone(),
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
