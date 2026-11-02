//! Which items a folder watch's pull reads and which files it renders: those
//! a change since its last pull reaches, and every file once an hour, which
//! checks that choice.
//!
//! A file renders from its item, the item's edges, each item at their other
//! ends, the names the copy's items answer to, the types, the folder's
//! settings and its own binding. A change to any of these marks the items it
//! touches; a pull renders each marked item's file and each file whose item
//! has an edge to a marked item, other than a placement, which no file shows.
//!
//! A narrow pull reads only those items, with the items whose file a pull
//! goes over every time it runs: those it did not leave as they render, and
//! those bound here that the query does not hold. Every other item's file is
//! as the last pull left it, so the pull leaves it unread.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

use super::{Catalog, Folder, Names, PLACEMENT_EDGE, Result, Settings, state};

/// Past this many changed items a pull renders every file, which costs less
/// than finding each one's neighbors.
const MOST_CHANGED: usize = 4096;

/// How long a watch renders only what a change reaches before it renders
/// every file again, which finds a change the choice missed.
pub(super) const FULL_RENDER: Duration = Duration::from_secs(60 * 60);

/// What a watch's pulls choose by, kept from one pull to the next.
#[derive(Default)]
pub(super) struct Selection {
    last: Option<Baseline>,
    rendered_all_at: Option<Instant>,
    /// Files the last full render rewrote that the choice would have left,
    /// each as its path, for the watch to tell.
    missed: Vec<String>,
    /// The items narrow pulls reached that did not run to their end, which
    /// the next pull reaches too: the names they brought up to date no
    /// longer differ.
    owed: HashSet<String>,
    /// Whether the next pull reads every item, where a narrow one met what
    /// only a pull of every item settles.
    widen: bool,
}

impl std::fmt::Debug for Selection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Selection")
            .field("chosen", &self.last.is_some())
            .field("rendered_all_at", &self.rendered_all_at)
            .field("missed", &self.missed)
            .finish_non_exhaustive()
    }
}

/// Where the last pull that ran to its end began.
struct Baseline {
    change: i64,
    generation: u64,
    settings: Settings,
    bound: HashMap<String, state::Bound>,
    names: Names,
    /// The items whose file the pull found or left as their item renders.
    settled: HashSet<String>,
    /// The items the folder's query holds.
    members: HashSet<String>,
    /// The items the query does not hold whose file is here as a document's
    /// embed or attachment.
    shown: HashSet<String>,
}

/// What changed since the last pull began: the items, those bound since to
/// another path or none, and those whose binding changed in what it records
/// of its own file alone.
struct Changes {
    changed: HashSet<String>,
    moved: HashSet<String>,
    rebound: HashSet<String>,
}

/// One pull's choice.
pub(super) struct Pick {
    change: i64,
    generation: u64,
    bound: HashMap<String, state::Bound>,
    /// The items a change reaches; `None` where every file renders.
    reached: Option<HashSet<String>>,
    /// Where the pull reads only what a change reaches, the items it reads:
    /// those in `reached` and those attached to them.
    read: HashSet<String>,
    /// Every file renders, and one the choice would have left is noted
    /// where it is rewritten.
    checking: bool,
    settled_before: HashSet<String>,
    settled: RefCell<HashSet<String>>,
    missed: RefCell<Vec<String>>,
}

/// What a narrow pull reads by.
pub(super) struct Narrow {
    /// The items it reads: every other item's file is as the last pull
    /// left it.
    pub(super) read: HashSet<String>,
    /// The items the query holds.
    pub(super) members: HashSet<String>,
    /// The items the query does not hold whose file the last pulls kept
    /// here as a document's embed or attachment, other than those it reads.
    pub(super) shown: HashSet<String>,
    /// How many items the last pull left as they render that this one does
    /// not read, which a full pull counts unchanged.
    pub(super) unread: usize,
}

impl Selection {
    /// Called as a pull begins, before it reads the copy, so a change made
    /// while it runs is one the next pull finds.
    pub(super) fn begin(&self, folder: &Folder) -> Result<Pick> {
        let conn = folder.core.conn()?;
        Ok(Pick {
            change: crate::store::last_change(&conn, crate::store::Changes::Items)?,
            generation: crate::reach::generation(&conn)?,
            bound: state::every_bound(&conn)?
                .into_iter()
                .map(|bound| (bound.path.clone(), bound))
                .collect(),
            reached: None,
            read: HashSet::new(),
            checking: false,
            settled_before: HashSet::new(),
            settled: RefCell::default(),
            missed: RefCell::default(),
        })
    }

    /// The last pull's baseline where it still holds: the same generation
    /// and settings.
    fn holding(&self, pick: &Pick, settings: &Settings) -> Option<&Baseline> {
        self.last
            .as_ref()
            .filter(|last| last.generation == pick.generation && last.settings == *settings)
    }

    /// What changed since the last pull began; `None` where more changed
    /// than a choice is worth, or the types did.
    fn changes(folder: &Folder, last: &Baseline, pick: &Pick) -> Result<Option<Changes>> {
        let changed = {
            let conn = folder.core.conn()?;
            crate::store::changed_since(
                &conn,
                crate::store::Changes::Items,
                last.change,
                MOST_CHANGED,
            )?
        };
        let Some(changed) = changed else {
            return Ok(None);
        };
        // Another file shows an item by the path its file is at, so a
        // binding that changed only in what it records of its own file
        // reaches that file alone.
        let mut moved = HashSet::new();
        let mut rebound = HashSet::new();
        for path in last.bound.keys().chain(pick.bound.keys()) {
            match (last.bound.get(path), pick.bound.get(path)) {
                (Some(before), Some(now)) if before.item_id == now.item_id => {
                    if before != now {
                        rebound.insert(now.item_id.clone());
                    }
                }
                (before, now) => {
                    moved.extend(before.into_iter().chain(now).map(|b| b.item_id.clone()));
                }
            }
        }
        Ok(Some(Changes {
            changed,
            moved,
            rebound,
        }))
    }

    /// Each changed item and each item at the other end of one of its edges,
    /// other than a placement.
    fn with_neighbors(folder: &Folder, changed: &HashSet<String>) -> Result<HashSet<String>> {
        let mut reached = changed.clone();
        if !neighbors_left_out() {
            let conn = folder.core.conn()?;
            for id in changed {
                for (source, target) in crate::store::edge_neighbors(&conn, id, PLACEMENT_EDGE)? {
                    reached.insert(source);
                    reached.insert(target);
                }
            }
        }
        Ok(reached)
    }

    /// Chooses a narrow pull, which reads only what a change reaches, where
    /// the last pull's baseline holds, no check of the choice is due, and
    /// nothing outside the changed items and their neighbors decides which
    /// items the query holds. Brings the baseline's names and members up to
    /// date for what it reaches.
    pub(super) fn narrow(
        &mut self,
        folder: &Folder,
        pick: &mut Pick,
        settings: &Settings,
        catalog: &Catalog,
    ) -> Result<Option<Narrow>> {
        // `beneath` walks edges from its root down, so an edge changed
        // above an item takes it in or leaves it out.
        if std::mem::take(&mut self.widen)
            || self.full_render_due()
            || settings.query.beneath.is_some()
            || self.holding(pick, settings).is_none()
        {
            return Ok(None);
        }
        let last = self.last.as_ref().expect("a baseline that holds");
        let Some(Changes {
            mut changed,
            moved,
            rebound,
        }) = Self::changes(folder, last, pick)?
        else {
            return Ok(None);
        };
        let renamed: BTreeSet<String> = changed.iter().chain(&moved).cloned().collect();
        let paths: Vec<(String, String)> = pick
            .bound
            .values()
            .filter(|bound| renamed.contains(&bound.item_id))
            .map(|bound| (bound.path.clone(), bound.item_id.clone()))
            .collect();
        let last = self.last.as_mut().expect("a baseline that holds");
        let differing = last
            .names
            .refresh(&*folder.core.conn()?, catalog, &renamed, &paths)?;
        changed.extend(moved);
        changed.extend(differing);
        let mut reached = Self::with_neighbors(folder, &changed)?;
        reached.extend(rebound);
        reached.extend(self.owed.iter().cloned());
        let last = self.last.as_mut().expect("a baseline that holds");
        let ids: Vec<String> = reached.iter().cloned().collect();
        let held = folder.core.held_among(settings, &ids)?;
        for id in &ids {
            if held.contains(id) {
                last.members.insert(id.clone());
            } else {
                last.members.remove(id);
            }
        }
        let bound_items: HashSet<&String> = pick.bound.values().map(|b| &b.item_id).collect();
        // An item whose file the last pull did not leave as it renders.
        for id in last.members.iter().chain(bound_items.iter().copied()) {
            if !last.settled.contains(id) {
                reached.insert(id.clone());
            }
        }
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| "folder-selection-narrow") {
            reached.clear();
        }
        // What every pull goes over, and renders only where its file is not
        // as it renders: a file here the query does not hold but as a
        // document's embed or attachment, and a file the folder keeps
        // unmatched, a refused placement, a journaled delete or a paused
        // removal names.
        let mut read = reached.clone();
        for id in bound_items {
            if !last.members.contains(id) && !last.shown.contains(id) {
                read.insert(id.clone());
            }
        }
        {
            let conn = folder.core.conn()?;
            read.extend(state::unmatched(&conn)?);
            read.extend(state::journaled(&conn)?.into_iter().map(|row| row.item_id));
            let paused: HashSet<String> = state::paused(&conn, state::Removal::Pull)?
                .into_iter()
                .collect();
            read.extend(
                pick.bound
                    .values()
                    .filter(|bound| paused.contains(&bound.path))
                    .map(|bound| bound.item_id.clone()),
            );
        }
        read.extend(folder.withheld()?.into_keys());
        // Where an attachment's file goes rests on every document it is
        // attached to, so a pull reads them all together.
        if !attached_together(folder, &mut read)? {
            return Ok(None);
        }
        let unread = last.settled.iter().filter(|id| !read.contains(*id)).count();
        let shown = last
            .shown
            .iter()
            .filter(|id| !read.contains(*id))
            .cloned()
            .collect();
        self.owed.extend(reached.iter().cloned());
        pick.reached = Some(reached);
        pick.read = read.clone();
        pick.settled_before = last.settled.clone();
        Ok(Some(Narrow {
            read,
            members: last.members.clone(),
            shown,
            unread,
        }))
    }

    /// The names a narrow pull renders by: the baseline's, brought up to
    /// date.
    pub(super) fn names(&self) -> Option<&Names> {
        self.last.as_ref().map(|last| &last.names)
    }

    /// Called where a narrow pull met what only a pull of every item
    /// settles, so the next one reads every item.
    pub(super) fn widen(&mut self) {
        self.widen = true;
    }

    /// Called once the pull has read the copy and held the ends of its
    /// edges, with the names it renders by.
    pub(super) fn choose(
        &self,
        folder: &Folder,
        pick: &mut Pick,
        settings: &Settings,
        names: &Names,
    ) -> Result<()> {
        let Some(last) = self.holding(pick, settings) else {
            return Ok(());
        };
        let Some(Changes {
            mut changed,
            moved,
            rebound,
        }) = Self::changes(folder, last, pick)?
        else {
            return Ok(());
        };
        changed.extend(moved);
        changed.extend(names.differing(&last.names));
        changed.extend(self.owed.iter().cloned());
        let mut reached = Self::with_neighbors(folder, &changed)?;
        reached.extend(rebound);
        #[cfg(debug_assertions)]
        if crate::fault::fails(|| "folder-selection-narrow") {
            reached.clear();
        }
        // Every file renders anyway, so an item the choice left out shows.
        pick.checking = self.full_render_due();
        pick.reached = Some(reached);
        pick.settled_before = last.settled.clone();
        Ok(())
    }

    /// Called where a pull that read every item ran to its end, with what it
    /// rendered by: the names, the items the query holds and those it shows
    /// as embeds or attachments only.
    pub(super) fn end(
        &mut self,
        pick: Pick,
        settings: &Settings,
        names: Names,
        members: HashSet<String>,
        shown: HashSet<String>,
    ) {
        if pick.reached.is_none() || pick.checking {
            self.rendered_all_at = Some(crate::clock::now());
        }
        self.owed.clear();
        self.missed.extend(pick.missed.into_inner());
        self.last = Some(Baseline {
            change: pick.change,
            generation: pick.generation,
            settings: settings.clone(),
            bound: pick.bound,
            names,
            settled: pick.settled.into_inner(),
            members,
            shown,
        });
    }

    /// Called where a narrow pull ran to its end, with the items it found
    /// shown as embeds or attachments only.
    pub(super) fn end_narrow(&mut self, pick: Pick, shown: HashSet<String>) {
        self.owed.clear();
        let Some(last) = self.last.as_mut() else {
            return;
        };
        let reached = pick.reached.unwrap_or_default();
        last.settled.retain(|id| !reached.contains(id));
        last.settled.extend(pick.settled.into_inner());
        last.shown.retain(|id| !reached.contains(id));
        last.shown.extend(shown);
        last.change = pick.change;
        last.generation = pick.generation;
        last.bound = pick.bound;
    }

    /// Where the folder's directory went, what the files were rendered from
    /// says nothing of what is on the disk when it comes back.
    pub(super) fn forget(&mut self) {
        self.last = None;
        self.owed.clear();
    }

    /// Whether the next pull renders every file, to check the choice, even
    /// where the copy and the disk are as the last pull left them.
    pub(super) fn full_render_due(&self) -> bool {
        self.last.is_some()
            && self
                .rendered_all_at
                .is_none_or(|at| crate::clock::now().saturating_duration_since(at) >= FULL_RENDER)
    }

    pub(super) fn take_missed(&mut self) -> Vec<String> {
        std::mem::take(&mut self.missed)
    }

    #[cfg(all(test, debug_assertions))]
    pub(super) fn render_all_next(&mut self) {
        self.rendered_all_at = None;
    }
}

impl Pick {
    /// Whether no change since the last pull reaches the item, whose file
    /// that pull found or left as it renders.
    fn unreached(&self, item_id: &str) -> bool {
        self.reached
            .as_ref()
            .is_some_and(|reached| !reached.contains(item_id))
            && self.settled_before.contains(item_id)
    }

    /// Whether the pull reads only what a change reaches, and not this item.
    pub(super) fn leaves(&self, item_id: &str) -> bool {
        !self.read.is_empty() && !self.read.contains(item_id)
    }

    /// Whether the pull leaves the item's file unrendered.
    pub(super) fn skips(&self, item_id: &str) -> bool {
        !self.checking && self.unreached(item_id)
    }

    /// Notes a file the full render rewrote, where the choice would have
    /// left it.
    pub(super) fn rewrote(&self, item_id: &str, path: &str) {
        if self.checking && self.unreached(item_id) {
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "folder-render-missed");
            self.missed.borrow_mut().push(path.to_string());
        }
    }

    /// Notes an item whose file is as it renders.
    pub(super) fn settle(&self, item_id: &str) {
        self.settled.borrow_mut().insert(item_id.to_string());
    }
}

/// Past this many items, a narrow pull would read more than the choice
/// saves.
const MOST_ATTACHED: usize = 4096;

/// Adds to `read` every item joined to one in it by attachments, each
/// document with its attachments and each attachment with its documents;
/// false where that passes `MOST_ATTACHED`.
fn attached_together(folder: &Folder, read: &mut HashSet<String>) -> Result<bool> {
    let conn = folder.core.conn()?;
    let mut statement = conn.prepare_cached(
        "SELECT source_id, target_id FROM edges
          WHERE (source_id = ?1 OR target_id = ?1) AND edge_type = ?2",
    )?;
    let mut next: Vec<String> = read.iter().cloned().collect();
    while let Some(id) = next.pop() {
        let ends = statement
            .query_map(rusqlite::params![id, super::ATTACHMENT_EDGE], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (source, target) in ends {
            for end in [source, target] {
                if read.insert(end.clone()) {
                    next.push(end);
                }
            }
        }
        if read.len() > MOST_ATTACHED {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
thread_local! {
    /// Makes the choice leave out the items at the other end of a changed
    /// item's edges, to show a test of it fails.
    pub(super) static LEAVE_OUT_NEIGHBORS: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

fn neighbors_left_out() -> bool {
    #[cfg(test)]
    return LEAVE_OUT_NEIGHBORS.with(std::cell::Cell::get);
    #[cfg(not(test))]
    false
}
