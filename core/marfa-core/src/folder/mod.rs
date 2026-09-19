//! A directory on a machine that holds a slice as files.
//!
//! A folder is a device like any other (`device.md`, `queue-and-verdicts.md`)
//! with a filesystem as its face: the same working copy, the same queue, the
//! same verdicts. What is here is only the translation — a path to an item, a
//! file's bytes to an item's fields — and the state that translation needs to
//! survive a restart.

pub mod document;
pub mod identity;
pub mod state;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::CoreError;
use crate::model::{Draft, Edit, Item, Tier};
use crate::{Core, Result, Server};

/// Where a folder keeps what is its own (`folders.md` 18).
pub const STATE_DIR: &str = ".marfa";

/// How long a missing file is journaled before it becomes a delete
/// (`folders.md` 15).
///
/// The first half of a rename looks exactly like a delete — the old path
/// stops existing — and this is the window in which the other half can
/// arrive. A grace of zero sends a delete for every rename.
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
    /// Tags every item in this folder carries, narrowing the slice further.
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
    /// Files that became new items.
    pub created: usize,
    /// Files whose changes were queued against an item already bound.
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
    /// Items moved off a name another file wanted, and back again
    /// (`folders.md` 24). Not files: a swap of two files is two
    /// renames and one of these, and a line that counted only the
    /// renames would say two where three writes went out.
    pub parked: usize,
}

impl Folder {
    /// Writes a folder's slice into a directory and opens it.
    ///
    /// The directory need not be empty and need not exist: a folder in a
    /// container is the same thing (`folders.md` 3), and requiring an
    /// existing one would make that a special case.
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
        let slice: Slice = serde_json::from_str(&text)?;
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

    /// Every file the folder watches, in a stable order.
    ///
    /// Dot-led directories are excluded at any depth (`folders.md` 17), which
    /// is also what keeps `.marfa/` out: the folder's own state is never
    /// watched and never pushed, and a rule that named it alone would let
    /// every other dot-led directory through.
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
        // A directory that went while we were walking it is not an error:
        // the scan that follows will not find its files either.
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
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.is_dir() {
            walk(&path, into)?;
        } else if metadata.is_file() {
            into.push(path);
        }
        // A symlink is neither: it is not the file it points at, and
        // following one would give two paths one identity on purpose.
    }
    Ok(())
}

impl Folder {
    /// Reads the folder and queues what has changed.
    ///
    /// **One identity rule, and this is where it lives** (`folders.md` 9).
    /// The watcher calls this too: the same bytes present at startup and the
    /// same bytes arriving while running reach the same item, because there
    /// is one path through here and not two.
    pub fn scan(&self) -> Result<ScanReport> {
        let mut report = ScanReport::default();
        let paths = self.files()?;
        // Resolving is fail-closed on a shared identity, so a file the
        // folder never touches — a hard link to a note, a copy some tool
        // made — would take the note's identity away with it and the
        // note's next rename would become a second item.
        let held: Vec<PathBuf> = paths
            .iter()
            .filter(|path| self.holds(path))
            .cloned()
            .collect();
        let identities = identity::resolve(&held);
        // The mapping as it stood before this scan touched anything.
        //
        // **Which item a file belongs to** is decided against this, so that
        // answer does not depend on where the file fell in the walk — which
        // it did before, and a swap was two files each written onto the
        // other's item. What still depends on the order is the sequence of
        // writes: which of two contesting items gets parked, and in which
        // order the moves go out. That is order in the queue rather than
        // order in the answer, and the queue is ordered on purpose.
        let snapshot = {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        };
        let at_path: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .map(|row| (row.path.as_str(), row))
            .collect();
        let identified: HashMap<&str, &state::Bound> = snapshot
            .iter()
            .filter_map(|row| row.identity.as_deref().map(|mark| (mark, row)))
            .collect();
        // Which item holds which natural key, as far as this folder is
        // concerned, kept current as writes are queued.
        //
        // The mapping's path is the server's key only for rows this folder
        // created or has moved. A row the pull bound for an item from
        // another source sits at a path taken from its title, and the server
        // holds something else entirely — so a contest against one of those
        // is not a contest, and `keyed_at` is what asks before parking.
        let mut holder: HashMap<String, String> = snapshot
            .iter()
            .map(|row| (row.path.clone(), row.item_id.clone()))
            .collect();
        // Rows some file in this walk claims by its identity. A path
        // match must not overrule one: a stranger's file sitting at a bound
        // path would otherwise be written onto that item while the file that
        // really is that item, one rename away, becomes a second.
        let spoken_for: HashSet<&str> = paths
            .iter()
            .filter_map(|path| identities.get(path))
            .filter_map(|found| identified.get(found.key().as_str()))
            .map(|row| row.item_id.as_str())
            .collect();
        let mut unresolved: Vec<Unresolved> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        for path in &paths {
            let key = identity::natural_key(&self.root, path)?;
            // Seen before it is judged. A file the walk found is a file
            // that is there, whatever its extension, and leaving an unheld
            // one out of `seen` journals it missing and then deletes the
            // item it is bound to — which reaches any file the folder wrote
            // under a name `holds` rejects.
            seen.insert(key.clone());
            if !self.holds(path) {
                report.skipped += 1;
                continue;
            }
            // Read after it is seen. A file the walk found is a file that
            // is there, and journaling it because the read failed starts
            // the delete clock on a file sitting on the disk — which two
            // scans later deletes the item, because `journal_missing` pins
            // the moment to the first failure. A dataless placeholder in
            // iCloud or Dropbox fails to materialize routinely.
            let Ok(bytes) = std::fs::read(path) else {
                // Unreadable now. The next scan reads it, and until then
                // the folder holds what it last agreed with.
                continue;
            };
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let hash = state::hash(&bytes);
            let mark = identities.get(path).map(|found| found.key());
            let seen = Seen {
                key: &key,
                text: &text,
                hash: &hash,
                mark: mark.as_deref(),
            };

            // **Identity decides which file is which, and the path follows**
            // (`folders.md` 8). Asking the path first meant two files that
            // swapped places were each written onto the other's item: the
            // path said one thing, the inode said the other, and the code
            // took the path without either statement saying it should.
            //
            // Both lookups go to the snapshot taken before the walk, not to
            // the mapping as it stands. A swap is two moves, and applying
            // the first changes what the second would find — the second file
            // would look up its own identity, find the row the first move
            // had just overwritten, and become a new item.
            let by_identity = mark.as_deref().and_then(|mark| identified.get(mark));
            let here = at_path
                .get(key.as_str())
                .filter(|row| !spoken_for.contains(row.item_id.as_str()));
            match by_identity.or(here) {
                Some(bound) if bound.path == key => {
                    // A write the folder made never comes back as a change
                    // (`folders.md` 14). The bytes it last agreed with are
                    // the bytes it wrote, so a file that still holds them is
                    // a file nobody else has touched.
                    if bound.content_hash == hash {
                        report.unchanged += 1;
                        continue;
                    }
                    self.queue_update(bound, &seen, &mut unresolved)?;
                    report.updated += 1;
                }
                Some(bound) => {
                    // **The name this file wants may be one another item has
                    // not let go of yet** (`folders.md` 24). Two files that
                    // swap places are two moves whose names collide with each
                    // other, and the server refuses a name another item
                    // holds — so whichever went first would land and the
                    // other would be refused, leaving one item under the
                    // wrong name and the other under none.
                    //
                    // The holder is parked under a name that is not a
                    // path, which frees this one. Its own move is the next
                    // row in an ordered, durable queue — but queued is not
                    // landed, and a refusal or a blocked queue would leave
                    // it parked, where a second device would make a second
                    // item for the same file. The pass at the end of the
                    // scan is what takes it back out.
                    if let Some(other) = holder.get(key.as_str())
                        && other != &bound.item_id
                    {
                        let other = other.clone();
                        // **Only an item whose key this folder's mapping
                        // actually is.** A row the pull bound for an item
                        // from somewhere else is at a path taken from its
                        // title, and the server holds a different key for
                        // it; parking that would write a name that is not a
                        // path over a real one belonging to another device.
                        // Nothing here contests it either, because it never
                        // held the name this file wants.
                        if self.keyed_at(&other, key.as_str())? {
                            let parked = parked_key(&other);
                            self.queue_rekey(&other, &parked)?;
                            holder.insert(parked, other);
                            report.parked += 1;
                        }
                        holder.remove(key.as_str());
                    }
                    // Only where the old name is still recorded as this
                    // item's. In a cycle longer than a swap the snapshot's
                    // path for this item can already have been taken by an
                    // earlier move, and removing it then would drop a record
                    // that is live.
                    //
                    // No fixture holds this, and none can: for the wrong
                    // removal to cost anything, a later file would have to
                    // want a name an earlier file had already been given,
                    // which is two files at one path. The rotation and the
                    // chain below both come out right with the loose version
                    // in place. It is written the strict way because the map
                    // is meant to say who holds what, and a map that is
                    // wrong in a way nothing can reach is still wrong.
                    if holder.get(bound.path.as_str()) == Some(&bound.item_id) {
                        holder.remove(&bound.path);
                    }
                    holder.insert(key.clone(), bound.item_id.clone());
                    // The same file under a new name, so the old name
                    // stops naming it — **unless something else has taken
                    // that name since the walk began**. In a swap, this
                    // file's old path is the other file's new one, and the
                    // other file has already been bound there: unbinding by
                    // the snapshot's path then deletes the row the earlier
                    // iteration wrote, and the item it named is left with no
                    // mapping at all. The pull's byte-for-byte re-adoption
                    // hides that whenever the bytes are untouched, which is
                    // why a swap looked right and a swap with an edit did
                    // not.
                    {
                        let conn = self.core.conn()?;
                        let still_ours = state::bound_at(&conn, &bound.path)?
                            .is_some_and(|row| row.item_id == bound.item_id);
                        if still_ours {
                            state::unbind(&conn, &bound.path)?;
                            // It moved rather than went, so the delete the
                            // old path journaled is not a delete.
                            state::journal_clear(&conn, &bound.path)?;
                        }
                    }
                    // **A rename is a write even when the bytes are the
                    // same** (`folders.md` 23). The name is the natural key,
                    // so a move with no edit still has something to tell the
                    // server — and telling it nothing is what left the item
                    // under the old key and had the next pull put the old
                    // name back.
                    self.queue_update(bound, &seen, &mut unresolved)?;
                    report.renamed += 1;
                }
                // No identity the mapping knows and no row at this path: a
                // new item, never a guess (`folders.md` 8).
                None => {
                    self.queue_create(&seen, &mut unresolved)?;
                    report.created += 1;
                }
            }
        }

        // **A second pass, now that every file the walk found is bound.**
        // A link naming a file that arrived in the same scan could not
        // resolve when the walk reached it, and nothing would have asked
        // again: the next scan finds both files unchanged and skips them
        // (`folders.md` 25).
        for pending in unresolved {
            let (named, _) = self.queue_links(&pending.item_id, &pending.links, &pending.had)?;
            let conn = self.core.conn()?;
            if let Some(bound) = state::bound_at(&conn, &pending.path)? {
                state::bind(
                    &conn,
                    &state::Bound {
                        links: named,
                        ..bound
                    },
                )?;
            }
        }

        // **A park that was never followed by its move.** The two are
        // ordered rows in a durable queue, so this only happens when the
        // move was refused or the queue is blocked — and then the item sits
        // under a name that is not a path, where the next device to enrol on
        // this folder would make a second item for the same file
        // (`folders.md` 24, and 10 for what it costs).
        for row in {
            let conn = self.core.conn()?;
            state::every_bound(&conn)?
        } {
            let Some(item) = self.core.get(&row.item_id)? else {
                continue;
            };
            if item.source_id.as_deref().is_some_and(is_parked) {
                self.queue_rekey(&row.item_id, &row.path)?;
                report.parked += 1;
            }
        }

        // Bound files that were not there. Journaled rather than deleted:
        // the first half of a rename looks exactly like a delete
        // (`folders.md` 15), and a file absent at startup is journaled the
        // same way one that vanished while watching is (16) — which is this
        // loop, because a scan does not know which it is looking at.
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
                // **The file came back.** The grace exists because it
                // might (`folders.md` 15). Clearing the journal here and not
                // only on a rename is what makes the grace mean anything: a
                // file deleted and restored inside it is one the server
                // never hears about, rather than one deleted and re-created
                // as a new item with none of its edges.
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
            // The row may already be gone — a delete answered, or one a
            // catch-up evicted — and a folder that refused on that would
            // stop sweeping its journal for ever. That is the only excuse:
            // testing `is_ok` instead swallows an unhydrated store and a
            // reading handle, and then clears the journal and the binding,
            // so a real deletion never reaches the server and nothing says
            // so.
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

    /// The row the copy holds under this natural key, if any.
    ///
    /// What a folder create is conditional on: the server resolves a create
    /// by `(source, source_id)`, so the version that create is based on is
    /// this row's.
    fn held_under_key(&self, key: &str) -> Result<Option<crate::model::Item>> {
        let held = self.core.list(
            &crate::model::ListFilters {
                all_states: true,
                ..Default::default()
            },
            crate::model::Sort::default(),
        )?;
        Ok(held
            .into_iter()
            .find(|item| item.source_id.as_deref() == Some(key)))
    }

    /// Whether this path is one the folder pushes (`folders.md` 19).
    fn holds(&self, path: &Path) -> bool {
        // By extension, because a file's type is decided by the folder's
        // defaults and a file that is not a document is not one of them.
        // Anything else is left alone rather than pushed as a note.
        matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("md" | "markdown" | "txt")
        )
    }

    fn queue_create(&self, seen: &Seen<'_>, unresolved: &mut Vec<Unresolved>) -> Result<()> {
        let Seen {
            key,
            text,
            hash,
            mark,
        } = *seen;
        let document = document::read(text);
        // The version this create is based on, read and never invented.
        //
        // The server resolves a create by its natural key, so the version it
        // is based on is the version of the row the copy holds under that
        // key. **Zero where it holds none**, which is the device saying it
        // read no row rather than a version it made up: the server mints
        // from one, so a create carrying zero onto a row that exists is
        // refused — which is the protection statement 13 is about — and one
        // carrying the row's real version lands, which is what a second
        // edit from this folder needs.
        //
        // Zero always, rather than the row's version, would refuse every
        // create onto an existing row for ever and leave the file
        // permanently unpushable. The zero-means-absent convention is this
        // device's and not yet the contract's; it is in the open questions.
        let version = self
            .held_under_key(key)?
            .map(|item| item.version)
            .unwrap_or(0);
        let mut properties = sendable(document.properties);
        for (field, value) in &self.slice.defaults {
            properties.entry(field.clone()).or_insert(value.clone());
        }
        properties
            .entry(document::TITLE_FIELD)
            .or_insert(Value::String(title_of(key)));
        let draft = Draft {
            r#type: self.slice.default_type.clone(),
            properties,
            tags: self.slice.tags.clone(),
            tier: Some(self.slice.tier),
            source_id: Some(key.to_string()),
            // **A folder create carries the version it is based on**
            // (`folders.md` 13), and the version is *read*, never invented:
            // a number the device chose would be a version it minted, which
            // `device.md` 20 forbids and which can never match, so the
            // create would be refused for ever and the file would be
            // permanently unpushable.
            //
            // The natural key is what the server resolves a create against,
            // so the version this create is based on is the version of the
            // row the copy already holds under that key. No such row means
            // this file is new to the whole instance, and the create is
            // unconditional — there is nothing for it to be conditional on.
            base_version: Some(version),
            ..Default::default()
        };
        let queued = self.core.create_item(&draft)?;
        let item_id = queued.item_id.unwrap_or_default();
        // No bytes this folder agreed with before, so no link it can say has
        // gone: a create only ever adds.
        let (named, resolved) = self.queue_links(&item_id, &document.links, &[])?;
        if !resolved {
            unresolved.push(Unresolved {
                path: key.to_string(),
                item_id: item_id.clone(),
                links: document.links.clone(),
                had: Vec::new(),
            });
        }
        let conn = self.core.conn()?;
        state::bind(
            &conn,
            &state::Bound {
                path: key.to_string(),
                item_id,
                identity: mark.map(str::to_string),
                content_hash: hash.to_string(),
                links: named,
            },
        )?;
        Ok(())
    }

    fn queue_update(
        &self,
        bound: &state::Bound,
        seen: &Seen<'_>,
        unresolved: &mut Vec<Unresolved>,
    ) -> Result<()> {
        let Seen {
            key,
            text,
            hash,
            mark,
        } = *seen;
        let item_id = bound.item_id.as_str();
        let had = bound.links.as_slice();
        let document = document::read(text);
        // The row this file is bound to, as the copy holds it. Absent when
        // the server trashed it, when a catch-up evicted it from the slice,
        // or when a refused create made the copy forget it.
        let Some(held) = self.core.get(item_id)? else {
            // **The binding is not touched.** Recording the new hash here
            // would tell the next scan the file is in step with a write
            // that was never made: the person's editing stays on the disk,
            // leaves the machine never, and the report says it did. Left
            // alone, the file is still changed and the next scan tries
            // again — and unbinding it would make it a second item.
            //
            // The refusal ends the scan rather than the file: nothing after
            // it in the sorted order is read, and in a `push` neither the
            // drain nor the pull runs. One file bound to a row the copy has
            // lost holds up the whole folder, which is loud rather than
            // quiet, and quiet is what would lose somebody's writing.
            return Err(CoreError::Invalid(format!(
                "{key} is bound to {item_id}, which this copy no longer holds; \
                 the file is left as it is and nothing is queued for it"
            )));
        };
        let edit = Edit {
            properties: sendable(document.properties),
            base_version: Some(held.version),
            // **The natural key rides only on a move** (`folders.md` 23).
            // Asserting it on every update reached past the rule and cost
            // two things: it stamped this folder's path onto the key of an
            // item from somewhere else, whose path here came from its title;
            // and a name another item held then refused the whole write, the
            // person's editing with it, while the mapping recorded the new
            // hash and the next scan called the file unchanged. An edit that
            // carries no name cannot be refused for a name.
            source_id: (bound.path != key).then(|| key.to_string()),
        };
        self.core.update_item(item_id, &edit)?;
        let (named, resolved) = self.queue_links(item_id, &document.links, had)?;
        if !resolved {
            unresolved.push(Unresolved {
                path: key.to_string(),
                item_id: item_id.to_string(),
                links: document.links.clone(),
                had: had.to_vec(),
            });
        }
        let conn = self.core.conn()?;
        state::bind(
            &conn,
            &state::Bound {
                path: key.to_string(),
                item_id: item_id.to_string(),
                identity: mark.map(str::to_string),
                content_hash: hash.to_string(),
                links: named,
            },
        )?;
        Ok(())
    }

    /// Whether this folder's path for an item is the natural key the server
    /// holds for it.
    ///
    /// True for anything this folder created or has renamed. False for a row
    /// the pull bound for an item from another source, whose path came from
    /// its title: the folder's mapping says where its file is and nothing
    /// about what the server calls it.
    fn keyed_at(&self, item_id: &str, key: &str) -> Result<bool> {
        Ok(self
            .core
            .get(item_id)?
            .and_then(|item| item.source_id)
            .is_some_and(|held| held == key))
    }

    /// Moves a row's natural key and touches nothing else.
    ///
    /// What parks the holder of a contested name, and what puts one back
    /// afterwards (`folders.md` 24).
    ///
    /// The properties go back as the copy holds them. The door would take a
    /// key on its own, but the device's update carries a whole set and this
    /// keeps that one shape: what is sent is what the copy already believes,
    /// so nothing but the name moves. It is still a write — a version and an
    /// event — rather than the no-op the name alone would be.
    fn queue_rekey(&self, item_id: &str, key: &str) -> Result<()> {
        let Some(held) = self.core.get(item_id)? else {
            // **Loud.** Returning quietly let the walk carry on and assert a
            // name this item still holds, which the server refuses on the
            // first answer and never retries — and the mapping would record
            // the move as if it had happened, so the next pull would put the
            // file back under its old name with nothing saying why.
            return Err(CoreError::Invalid(format!(
                "{item_id} holds the name {key} is meant to free and this copy \
                 no longer has the row, so the file that wants it is left alone"
            )));
        };
        self.core.update_item(
            item_id,
            &Edit {
                properties: held.properties.clone(),
                base_version: Some(held.version),
                source_id: Some(key.to_string()),
            },
        )?;
        Ok(())
    }

    /// Links in the body become edges (`folders.md` 7), and a link the body
    /// has lost takes its edge with it (`folders.md` 21).
    ///
    /// Only the ones whose target this folder holds: a link to something
    /// outside the slice is text in the body and stays there, rather than
    /// becoming an edge to a row the server may not have.
    ///
    /// Answers what the mapping should record: the targets the body named,
    /// and — where a link could not be resolved and the removal stood down —
    /// the ones it recorded before, because forgetting those would take the
    /// removal rule with them.
    fn queue_links(
        &self,
        item_id: &str,
        links: &[String],
        had: &[String],
    ) -> Result<(Vec<String>, bool)> {
        if item_id.is_empty() {
            return Ok((Vec::new(), true));
        }
        // Not `unwrap_or_default`. An error read as "this item has no edges"
        // makes every link in the body a fresh `create_edge` for an edge that
        // already exists, and leaves the removal loop below iterating nothing
        // — a silent wrong answer in the one function whose job is deciding
        // what to destroy.
        let edges = self.core.edges_from(item_id)?;
        let held: Vec<&str> = edges.iter().map(|edge| edge.target_id.as_str()).collect();
        let mut named: Vec<String> = Vec::new();
        let mut every_link_resolved = true;
        for target in links {
            let Some(resolved) = self.resolve_link(target)? else {
                // A link that names nothing the copy can find. It is still a
                // link, and the removal below cannot tell it from a link the
                // person deleted, so the whole pass stands down rather than
                // guess. A rename in the same window is enough to reach this.
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
            // The record grows rather than narrows. Returning only what
            // resolved would drop the unresolvable link's target out of the
            // mapping for good, and statement 21's removal would then never
            // fire for it again — so the guard against destroying an edge
            // would destroy the rule it guards.
            let mut kept = named;
            for target in had {
                if !kept.contains(target) {
                    kept.push(target.clone());
                }
            }
            return Ok((kept, false));
        }
        // **The file used to carry it and now does not.** That is the test,
        // and it is why the mapping holds the links: an edge the copy
        // holds that the body does not name is either a link the person
        // removed or an edge that arrived from somewhere else and has not
        // been rendered yet. Both look identical in the body, and the scan
        // always runs before the pull that would render it — so without this
        // a single keystroke in a file would destroy an edge another device
        // had just made.
        //
        // And only the folder's own kind: an edge of another kind is one the
        // folder could not have made and cannot make again.
        for edge in edges {
            if edge.edge_type != LINK_EDGE
                || named.contains(&edge.target_id)
                || !had.contains(&edge.target_id)
            {
                continue;
            }
            self.core.delete_edge(&edge.id)?;
        }
        Ok((named, true))
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

/// A file's name, without its extension, as the title a new item gets.
fn title_of(key: &str) -> String {
    let name = key.rsplit('/').next().unwrap_or(key);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/// Whether `grace` has passed between two instants in the wire's shape.
fn elapsed_past(since: &str, now: &str, grace: Duration) -> bool {
    // A pair this cannot read has **not** elapsed. Failing open here sends
    // a delete the folder cannot date, and a delete is the one thing in this
    // file that cannot be taken back; a journal row that sits is recoverable
    // by hand and an unwanted delete is not.
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

impl Folder {
    /// Writes the slice out as files: an item in the slice is a file in the
    /// folder (`folders.md` 4).
    ///
    /// Every write here is recorded in the mapping before the bytes land, so
    /// the scan that follows recognizes them as the folder's own and does not
    /// read them back as a change (`folders.md` 14).
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
            crate::catalog::Catalog::load(&conn)?
        };
        // Paths already taken in this pass. Two items resolving to one is
        // ordinary — two notes called "Notes", or the same natural key on
        // two machines — and writing both would have the second silently
        // steal the first's file and its binding, leaving the first with no
        // file at all and the report counting a normal write.
        let mut taken: HashSet<String> = HashSet::new();
        for item in &items {
            // The catalog's rule, which is the one the hydration and the
            // catch-up use: a type is held with its subtree (`device.md` 1).
            // String equality here would hold `core.note.daily` in the copy
            // and never write one as a file, counting every one of them as
            // out of slice.
            if !self
                .slice
                .types
                .iter()
                .any(|declared| catalog.matches(declared, &item.r#type))
            {
                // An item outside the slice does not become a file
                // (`folders.md` 19).
                report.skipped += 1;
                continue;
            }
            let bound = {
                let conn = self.core.conn()?;
                state::bound_to_item(&conn, &item.id)?
            };
            let want = self.path_for(item, bound.as_ref());
            // Nothing is counted as taken until this item is actually going
            // to be written there. A path a pull declines is not a path
            // anything took, and leaving the claim in starves whichever item
            // wanted it next — which, because the list is newest first, is
            // usually the bound one with somebody's edits waiting.
            if !plainly_inside(&self.root, &want) {
                report.outside += 1;
                continue;
            }
            let path = self.root.join(&want);
            let (text, wrote) = self.render(item)?;
            let bytes = text.as_bytes().to_vec();
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
            // **The bytes on the disk, not the mapping's memory of them.**
            // The mapping says what the folder last wrote; it says nothing
            // about what the person has typed since. A pull that trusted it
            // would overwrite an afternoon's editing with no queue row and no
            // line in the report, and `folders pull` runs no scan first.
            //
            // The item keeps the file it has, so it does not take `want`.
            if let Some(bound) = &bound
                && std::fs::read(self.root.join(&bound.path))
                    .is_ok_and(|found| state::hash(&found) != bound.content_hash)
            {
                report.unwritten += 1;
                continue;
            }
            // Something is already at the destination that is not this item's
            // own file — a note somebody typed since the last scan, or
            // another item's file this one is being renamed on top of.
            // `folders.md` 22.
            //
            // Unless the bytes are exactly what this item renders to, in
            // which case it is this item's own file and the mapping has lost
            // it. The bytes are compared rather than their hash: the hash
            // answers "did this change", and adopting a file somebody else
            // wrote on the strength of a 64-bit collision is a different
            // question to ask of it.
            if !ours && path.exists() {
                if bound.is_none() && std::fs::read(&path).is_ok_and(|found| found == bytes) {
                    let conn = self.core.conn()?;
                    state::bind(
                        &conn,
                        &state::Bound {
                            path: want.clone(),
                            item_id: item.id.clone(),
                            identity: None,
                            content_hash: hash,
                            links: wrote,
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

            if let Some(bound) = &bound {
                // A rename on the server moves the file (`folders.md` 12).
                // The old path goes first, so the scan that follows does not
                // find the file under both names and make a second item.
                if bound.path != want {
                    // Only the removal is guarded. The unbinding below has to
                    // happen either way: a mapping still naming a path the
                    // walk cannot reach is a path journaled missing, and the
                    // grace turns that into a delete of the item this pull is
                    // in the middle of writing.
                    if plainly_inside(&self.root, &bound.path) {
                        let from = self.root.join(&bound.path);
                        let _ = std::fs::remove_file(&from);
                    }
                    let conn = self.core.conn()?;
                    state::unbind(&conn, &bound.path)?;
                    state::journal_clear(&conn, &bound.path)?;
                    report.moved += 1;
                }
            }

            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    CoreError::Store(format!("cannot make {}: {error}", parent.display()))
                })?;
            }
            // Recorded before the bytes land. A write announced after it
            // happened leaves a window in which the watcher sees a change
            // the folder made and cannot tell (`folders.md` 14).
            {
                let conn = self.core.conn()?;
                state::bind(
                    &conn,
                    &state::Bound {
                        path: want.clone(),
                        item_id: item.id.clone(),
                        identity: None,
                        content_hash: hash,
                        links: wrote.clone(),
                    },
                )?;
                // A file is about to be here, so a journal row saying it is
                // missing is a delete that is not one. Without this the sweep
                // deletes the item this pull is in the middle of writing back
                // — which is the danger the move above is careful about, at
                // the path it does not cover.
                //
                // Counted when there was a row to clear, because one of the
                // rows this clears is a person's own delete still inside its
                // grace, and that is the one nobody would otherwise see go.
                if state::journaled(&conn)?
                    .iter()
                    .any(|(path, _, _)| path == &want)
                {
                    report.revived += 1;
                }
                state::journal_clear(&conn, &want)?;
            }
            if let Err(error) = std::fs::write(&path, &bytes) {
                // The mapping was written first, so the scan would not read
                // this back as a change. It has to come out again: left
                // there it says bytes are on the disk that are not, and the
                // next scan then pushes the old file's contents back as if
                // they were an edit — or, after a rename, reports the item
                // unchanged for ever with no file anywhere.
                let conn = self.core.conn()?;
                state::unbind(&conn, &want)?;
                return Err(CoreError::Store(format!(
                    "cannot write {}: {error}",
                    path.display()
                )));
            }
            // The identity is read after the write, because the file did not
            // exist until now and a rename can only be followed from here on.
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
                        content_hash: state::hash(&bytes),
                        links: wrote,
                    },
                )?;
            }
            if bound.is_none() {
                report.written += 1;
            } else {
                report.rewritten += 1;
            }
        }
        Ok(report)
    }

    /// Where an item's file goes.
    ///
    /// The natural key the folder gave it, when it has one: the key is the
    /// path, so an item this folder created goes back where it came from. An
    /// item from elsewhere takes its title, which is the only name it has.
    fn path_for(&self, item: &Item, bound: Option<&state::Bound>) -> String {
        if let Some(key) = item.source_id.as_deref()
            && !key.is_empty()
            && !key.starts_with('/')
            && !key.contains("..")
        {
            return key.to_string();
        }
        if let Some(bound) = bound {
            return bound.path.clone();
        }
        let title = item
            .properties
            .get(document::TITLE_FIELD)
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(&item.id);
        format!("{}.md", safe_name(title))
    }

    /// An item as the bytes of a file, with its id written in as the
    /// folder's own identity record (`folders.md` 11), and the targets of
    /// the links it put in the body.
    fn render(&self, item: &Item) -> Result<(String, Vec<String>)> {
        let mut properties = item.properties.clone();
        // The folder's record, not the natural key. A file that has lost it
        // is still the same item when the key matches, and one carrying an
        // id the server does not hold is treated as having none — which is
        // why nothing reads this back for identity.
        properties.insert(ID_FIELD.into(), Value::String(item.id.clone()));
        let mut body = properties
            .get(document::BODY_FIELD)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // An edge the folder cannot express as a link is kept on the item
        // rather than dropped (`folders.md` 7), so this only adds.
        let held = document::links(&body);
        // The targets of the links this answers with, for the mapping.
        // Not the edges considered: an edge skipped below whose link the body
        // already carries is still a link in the file, and recording
        // otherwise would tell the next scan the person never had it.
        //
        // Still short of the whole truth — a link in the body with no edge
        // behind it is named by the bytes and is not here, because this is
        // built from the edges. `folders.md` 21 only ever asks whether an
        // edge's target was named, so what is missing is a target with no
        // edge, which that question never reaches.
        let mut wrote = Vec::new();
        // Also not swallowed: a file rendered with none of its links reads
        // as a person having removed them, and the next scan takes the edges
        // away to match.
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
            // An edge the copy holds nothing for is one the folder cannot
            // express (`folders.md` 7) and one statement 21 will not let it
            // remove. Adding it put a bare id in the body that the person
            // could delete and the next pull would write back, which is the
            // unwinnable fight 21 exists to end.
            if self.core.get(&edge.target_id)?.is_none() {
                continue;
            }
            wrote.push(edge.target_id.clone());
            if !body.ends_with('\n') && !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&document::render_link(&name));
            body.push('\n');
        }
        properties.insert(document::BODY_FIELD.into(), Value::String(body));
        Ok((document::write(&properties)?, wrote))
    }
}

/// A file the walk found, read, and worked out an identity for.
///
/// Grouped because the two writers take all four together and neither has
/// any business with one of them alone.
struct Seen<'a> {
    /// The natural key: the path inside the folder (`folders.md` 10).
    key: &'a str,
    text: &'a str,
    hash: &'a str,
    /// Device, inode and birth time, where the filesystem gave a usable
    /// three. `None` means a rename cannot be followed (`folders.md` 8).
    mark: Option<&'a str>,
}

/// A file whose links the scan could not all resolve on the way past.
///
/// A link naming a file that arrives in the same scan cannot resolve when
/// the walk reaches it, because nothing has bound that file yet — and the
/// walk is sorted, so it is always the earlier of the two that loses.
/// Left there, the edge is never made: the next scan finds both files
/// unchanged and asks nothing (`folders.md` 25).
struct Unresolved {
    path: String,
    item_id: String,
    links: Vec<String>,
    had: Vec<String>,
}

/// The kind of edge a link becomes, and the only kind a folder removes.
pub const LINK_EDGE: &str = "references";

/// The frontmatter field a folder writes an item's id into.
pub const ID_FIELD: &str = "marfa_id";

/// What a pull did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PullReport {
    pub written: usize,
    pub rewritten: usize,
    pub moved: usize,
    pub unchanged: usize,
    pub skipped: usize,
    /// Files the pull would not write over: one the person changed since
    /// the folder last wrote it, and one at a path the mapping does not hold
    /// at all. Writing over either loses it with nothing reporting it.
    ///
    /// The two do not end the same way. The first is queued by the next scan
    /// as a change to the item it is bound to. The second becomes a **new**
    /// item, and the item that wanted the path has no file and will not get
    /// one until it wants a different name.
    pub unwritten: usize,
    /// Journal rows this pull cleared by writing the file back.
    ///
    /// **A superset of the deletes a person made**, and deliberately so. Most
    /// rows here are the folder's own bookkeeping — the first half of a
    /// rename journals the old path — and clearing those beside a write is
    /// right. But a person who deleted a file inside the grace
    /// (`folders.md` 15) has a row here too, and a change arriving for that
    /// item from elsewhere writes the file back and takes the delete with it.
    /// Separating the two needs the journal to record which kind it is, which
    /// it does not; counting the superset is what makes the case visible at
    /// all, and the count is named for what it measures rather than for the
    /// case that matters.
    pub revived: usize,
    /// Items whose file would have landed outside the folder, because a
    /// directory on the way to it is a symlink. Reported rather than
    /// written: the folder cannot see what it writes out there, so the
    /// write would be followed by a delete of the item it came from.
    pub outside: usize,
    /// Items whose path another item in the same pass had already taken.
    /// Reported rather than written, because writing would destroy the
    /// file of whichever item got there first.
    pub collided: usize,
}

/// A file's frontmatter as the properties of a write, without the folder's
/// own identity record (`folders.md` 11).
///
/// `render` writes the item's id into the file, so every file this folder
/// wrote carries it back on the next scan. Sending it would store the
/// folder's bookkeeping on the item as a property of its own, which the
/// next render would write out again; and a file somebody copied would
/// carry the id of the item it was copied from onto a new one.
fn sendable(mut properties: Map<String, Value>) -> Map<String, Value> {
    // `shift_remove` rather than `remove`: with `preserve_order` on,
    // `remove` is `swap_remove` and moves the last field into the hole,
    // which reorders the frontmatter of any file that carries a `body:`
    // of its own — the one thing `folders.md` 5 says will not happen.
    properties.shift_remove(ID_FIELD);
    properties
}

/// Whether every component of a path the folder is about to write is a plain
/// name inside the folder (`folders.md` 20).
///
/// The question is not where the path *resolves to*. A link pointing out of
/// the folder loses the file; a link pointing back *in* is worse, because the
/// write lands on another item's file and truncates it, the mapping then
/// holds a path the walk will never return, and the grace turns that into a
/// delete of the item that was written. Both are one `symlink_metadata` away,
/// and neither is a place a folder has any business writing.
///
/// A component that does not exist yet is one this pull will make, and
/// `create_dir_all` makes a directory rather than a link.
///
/// This is a guard and not a boundary: `create_dir_all` and the write
/// re-resolve everything checked here, so a component replaced between the
/// two is not caught. Closing that needs `O_NOFOLLOW`, which is not what this
/// module is for.
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

/// A natural key for an item that is between names.
///
/// Deliberately not a path: the `..` is what makes `path_for` refuse it and
/// fall back to the mapping, so a pull that runs while a row is parked
/// writes the file where it already is rather than somewhere under this.
/// That fallback needs the row to still be bound, which is why the unbind
/// in the move arm is conditional — a swap used to destroy one of the two.
fn parked_key(item_id: &str) -> String {
    format!("{PARKED}{item_id}")
}

/// Whether a natural key is one of the folder's parking places.
fn is_parked(key: &str) -> bool {
    key.starts_with(PARKED)
}

/// The prefix a parked key carries. Leads with `..`, which `path_for` and
/// `plainly_inside` both refuse, so no file is ever written under it.
const PARKED: &str = "../parked/";

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
