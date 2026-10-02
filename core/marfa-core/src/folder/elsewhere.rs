use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use super::lists::Lists;
use super::registry::{Registered, Registry, gone, resolved};
use super::{Folder, STATE_DIR, carries_frontmatter, identity, plainly_inside, state};
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
    /// Its store, read only; `None` where it cannot be opened.
    folder: Option<Folder>,
    members: OnceCell<Option<HashSet<String>>>,
    walked: OnceCell<Walked>,
    /// Its bindings by path, as item and bytes.
    bound: OnceCell<HashMap<String, (String, String)>>,
}

/// Another folder's directory, walked once a pass.
struct Walked {
    files: Vec<OnDisk>,
    partial: Option<String>,
}

struct OnDisk {
    key: String,
    path: PathBuf,
    mark: Option<String>,
    id: Option<String>,
    hash: OnceCell<Option<String>>,
}

impl OnDisk {
    fn hash(&self) -> Option<&str> {
        self.hash
            .get_or_init(|| {
                std::fs::read(&self.path)
                    .ok()
                    .map(|bytes| state::hash(&bytes))
            })
            .as_deref()
    }
}

impl Peer {
    fn open(root: PathBuf) -> Peer {
        let folder = Core::open_reader(root.join(STATE_DIR).join("core.sqlite"))
            .ok()
            .and_then(|core| {
                let folder = super::settings_file::bound(&core).ok()??;
                Some(Folder {
                    root: root.clone(),
                    folder,
                    core,
                    key: std::sync::Mutex::new(None),
                    permissions: std::sync::OnceLock::new(),
                    store_mark: super::store_mark(&root.join(STATE_DIR)),
                })
            });
        Peer {
            root,
            folder,
            members: OnceCell::new(),
            walked: OnceCell::new(),
            bound: OnceCell::new(),
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

    fn present(&self, key: &str) -> bool {
        plainly_inside(&self.root, key) && self.root.join(key).is_file()
    }

    fn walked(&self) -> &Walked {
        self.walked.get_or_init(|| {
            let mut walked = super::Walked::default();
            let partial = if self.root.is_dir() {
                let include = self
                    .folder
                    .as_ref()
                    .and_then(|folder| folder.settings().ok())
                    .map(|settings| settings.include)
                    .unwrap_or_default();
                match Lists::wider(&include) {
                    Ok(lists) => {
                        super::walk(&self.root, &self.root, &lists, &mut walked);
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
                    let mark = std::fs::symlink_metadata(&path)
                        .ok()
                        .and_then(|metadata| identity::of(&metadata))
                        .map(|found| found.key());
                    let id = carries_frontmatter(&path).then(|| id_of(&path)).flatten();
                    Some(OnDisk {
                        key,
                        path,
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

/// The `marfa_id` line of a Markdown file, read no further than its
/// frontmatter, so a walk does not read every body.
fn id_of(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut lines = BufReader::new(file).lines();
    let line = lines.next()?.ok()?;
    let first = line.strip_prefix(super::document::MARK).unwrap_or(&line);
    if first.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.ok()?;
        if line.trim_end() == "---" {
            return None;
        }
        if let Some(id) = line.strip_prefix("marfa_id:") {
            let id = id.trim().trim_matches(['"', '\'']);
            return (!id.is_empty()).then(|| id.to_string());
        }
    }
    None
}

pub(super) enum Look {
    Moved,
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
            let own = resolved(&self.of.root);
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
                .filter(|entry| resolved(&entry.dir) != own)
                .collect();
            for entry in known {
                let listed = others.iter().any(|other| {
                    other.dir == entry.dir || (entry.store.is_some() && other.store == entry.store)
                });
                if !listed && !gone(&entry) && resolved(&entry.dir) != own {
                    others.push(entry);
                }
            }
            if let (Some(conn), Ok(json)) = (&conn, serde_json::to_string(&others)) {
                let _ = store::meta_set(conn, META_OTHERS, &json);
            }
            (
                others
                    .into_iter()
                    .map(|entry| Peer::open(entry.dir))
                    .collect(),
                None,
            )
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
    /// or unique bytes, its path given whole.
    pub(super) fn left_behind(&self, mark: Option<&str>, hash: &str) -> Option<state::Bound> {
        let mut same_bytes = Vec::new();
        for peer in self.all() {
            let Some(folder) = &peer.folder else {
                continue;
            };
            let Ok(conn) = folder.core.conn() else {
                continue;
            };
            let whole = |bound: state::Bound| state::Bound {
                path: peer.root.join(&bound.path).display().to_string(),
                ..bound
            };
            if let Some(mark) = mark
                && let Some(found) = state::bound_with_identity(&conn, mark)
                    .unwrap_or_default()
                    .into_iter()
                    .find(|bound| !peer.present(&bound.path))
            {
                return Some(whole(found));
            }
            same_bytes.extend(
                state::bound_with_hash(&conn, hash)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|bound| {
                        !carries_frontmatter(Path::new(&bound.path)) && !peer.present(&bound.path)
                    })
                    .map(whole),
            );
        }
        (same_bytes.len() == 1).then(|| same_bytes.remove(0))
    }

    pub(super) fn moved_to(&self, lost: &state::Bound, held_here: bool) -> Look {
        if let Some(why) = self.doubt.as_deref().or(self.unreadable()) {
            return Look::Unsure(why.to_string());
        }
        let peers = self.all();
        if let Some(why) = peers.iter().find_map(|peer| peer.walked().partial.clone()) {
            return Look::Unsure(why);
        }
        let item = lost.item_id.as_str();
        if lost.identity.is_some()
            && peers
                .iter()
                .flat_map(|peer| peer.files())
                .any(|file| file.mark == lost.identity)
        {
            return Look::Moved;
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
        if carries_frontmatter(Path::new(&lost.path)) {
            let found = peers.iter().any(|peer| {
                peer.files()
                    .iter()
                    .any(|file| file.id.as_deref() == Some(item) && !theirs(peer, file))
            });
            return if found { Look::Moved } else { Look::Nowhere };
        }
        let mut matches = 0;
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
                if carries_frontmatter(&file.path) || theirs(peer, file) {
                    continue;
                }
                let same = match bound.get(&file.key) {
                    Some((bound, hash)) => bound == item && *hash == lost.content_hash,
                    None => file.hash() == Some(lost.content_hash.as_str()),
                };
                matches += usize::from(same);
            }
        }
        match matches {
            0 => Look::Nowhere,
            1 => Look::Moved,
            _ => Look::Unsure(format!(
                "{} files in other folders have its bytes, and which it became cannot be told",
                matches
            )),
        }
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
    pub(super) fn let_go(&self, item_id: &str) -> Option<(PathBuf, state::Bound)> {
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
            if std::fs::read(&path).is_ok_and(|bytes| state::hash(&bytes) == bound.content_hash) {
                return Some((path, bound));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
