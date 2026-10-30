//! Which files a folder watch's pull renders: those a change since its last
//! pull reaches, and every file once an hour, which checks that choice.
//!
//! A file renders from its item, the item's edges, each item at their other
//! ends, the names the copy's items answer to, the types, the folder's
//! settings and its own binding. A change to any of these marks the items it
//! touches; a pull renders each marked item's file and each file whose item
//! has an edge to a marked item, other than a placement, which no file shows.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use super::{Folder, Names, PLACEMENT_EDGE, Result, Settings, state};

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
}

/// One pull's choice.
pub(super) struct Pick {
    change: i64,
    generation: u64,
    bound: HashMap<String, state::Bound>,
    /// The items a change reaches; `None` where every file renders.
    reached: Option<HashSet<String>>,
    /// Every file renders, and one the choice would have left is noted
    /// where it is rewritten.
    checking: bool,
    settled_before: HashSet<String>,
    settled: RefCell<HashSet<String>>,
    missed: RefCell<Vec<String>>,
}

impl Selection {
    /// Called as a pull begins, before it reads the copy, so a change made
    /// while it runs is one the next pull finds.
    pub(super) fn begin(&self, folder: &Folder) -> Result<Pick> {
        let conn = folder.core.conn()?;
        Ok(Pick {
            change: crate::store::last_change(&conn)?,
            generation: crate::reach::generation(&conn)?,
            bound: state::every_bound(&conn)?
                .into_iter()
                .map(|bound| (bound.path.clone(), bound))
                .collect(),
            reached: None,
            checking: false,
            settled_before: HashSet::new(),
            settled: RefCell::default(),
            missed: RefCell::default(),
        })
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
        let Some(last) = self
            .last
            .as_ref()
            .filter(|last| last.generation == pick.generation && last.settings == *settings)
        else {
            return Ok(());
        };
        let changed = {
            let conn = folder.core.conn()?;
            crate::store::changed_since(&conn, last.change, MOST_CHANGED)?
        };
        let Some(mut changed) = changed else {
            return Ok(());
        };
        // Another file shows an item by the path its file is at, so a
        // binding that changed only in what it records of its own file
        // reaches that file alone.
        let mut rebound = HashSet::new();
        for path in last.bound.keys().chain(pick.bound.keys()) {
            match (last.bound.get(path), pick.bound.get(path)) {
                (Some(before), Some(now)) if before.item_id == now.item_id => {
                    if before != now {
                        rebound.insert(now.item_id.clone());
                    }
                }
                (before, now) => {
                    changed.extend(before.into_iter().chain(now).map(|b| b.item_id.clone()));
                }
            }
        }
        changed.extend(names.differing(&last.names));
        let mut reached = changed.clone();
        if !neighbors_left_out() {
            let conn = folder.core.conn()?;
            for id in &changed {
                for (source, target) in crate::store::edge_neighbors(&conn, id, PLACEMENT_EDGE)? {
                    reached.insert(source);
                    reached.insert(target);
                }
            }
        }
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

    /// Called where the pull ran to its end, with what it rendered by.
    pub(super) fn end(&mut self, pick: Pick, settings: &Settings, names: Names) {
        if pick.reached.is_none() || pick.checking {
            self.rendered_all_at = Some(crate::clock::now());
        }
        self.missed.extend(pick.missed.into_inner());
        self.last = Some(Baseline {
            change: pick.change,
            generation: pick.generation,
            settings: settings.clone(),
            bound: pick.bound,
            names,
            settled: pick.settled.into_inner(),
        });
    }

    /// Where the folder's directory went, what the files were rendered from
    /// says nothing of what is on the disk when it comes back.
    pub(super) fn forget(&mut self) {
        self.last = None;
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
