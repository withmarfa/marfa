use super::selective::{Pick, Selection};
use super::{
    ATTACHMENT_EDGE, BoundFiles, Catalog, CoreError, EdgeTypes, FOLDER_TYPE, Flagged, Folder,
    HashMap, HashSet, Item, ItemState, Lists, Look, Mode, Names, OFlags, Path, Peers, Result,
    Serialize, Settings, SettingsFileReport, Uncarried, Value, beside, bytes_of,
    carries_frontmatter, cleaned, document, executable, fields, identity, landing, line_of,
    name_of, names, path_of, placement, plainly_inside, read_file, stat_metadata, state, suited,
    transfer,
};

/// What a render of an item's file reads besides the item.
pub(super) type Basis<'a> = (&'a Catalog, &'a EdgeTypes, &'a Names);

/// Where `Folder::found_as_written` meets a found file.
#[derive(Clone, Copy)]
enum Found<'a> {
    /// At its placement, with the hash of what the pull would write there.
    InPlace(&'a str),
    /// Its item has left the folder.
    Departed,
}

/// The state a file's state line shows: active where it has none.
fn shown_state(front: &serde_json::Map<String, Value>) -> Option<ItemState> {
    match front.get(fields::STATE_FIELD) {
        None | Some(Value::Null) => Some(ItemState::Active),
        Some(Value::String(state)) if state == "active" => Some(ItemState::Active),
        Some(Value::String(state)) if state == "archived" => Some(ItemState::Archived),
        Some(_) => None,
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
        Err(crate::reach::Context::changed())
    }
}

pub fn copy_changed(error: &CoreError) -> bool {
    matches!(error, CoreError::StreamIncomplete { reason } if reason == "local_copy_changed")
}

/// What a rename that follows a title may take: the paths other items are
/// placed at, by folded name, and the lists the folder writes within.
struct Renaming<'a> {
    reserved: HashMap<String, Vec<crate::model::Edge>>,
    lists: &'a Lists,
}

fn journaled_for(conn: &rusqlite::Connection, path: &str, item_id: &str) -> Result<bool> {
    Ok(state::journaled(conn)?
        .iter()
        .any(|row| row.path == path && row.item_id == item_id))
}

struct Rendering<'a> {
    context: std::cell::RefCell<crate::reach::Context>,
    catalog: &'a Catalog,
    edge_types: &'a EdgeTypes,
    names: &'a Names,
    lists: &'a Lists,
    peers: &'a Peers<'a>,
    members: &'a HashSet<String>,
    /// A watch's choice of the files to render; `None` renders every one.
    pick: Option<&'a Pick>,
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

pub(super) enum Departing {
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
    taken: Option<(transfer::Entry, state::Bound)>,
}

/// What a pull would write, counted without writing it.
#[derive(Debug, Default)]
pub(super) struct PullPlan {
    pub(super) write: usize,
    pub(super) beside: usize,
    pub(super) left: usize,
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
    /// Items whose path the folder does not write to: left out by its lists,
    /// inside a package or another folder, or not a path inside the folder.
    /// Not a status of a file, which `outside` also names for a file the
    /// folder does not take.
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
    /// Documents whose body the pull rewrote so their links follow an item
    /// retitled since they were written. Each rewrite is queued, not yet
    /// answered.
    pub relinked: usize,
    /// Documents whose links to a retitled item the pull left as they were
    /// because of an error, which the next pull tries again.
    pub unrelinked: usize,
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
    pub(super) fn add_writes(&mut self, other: &PullReport) {
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
        self.relinked += other.relinked;
        self.unrelinked += other.unrelinked;
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

/// The name a new file of `item` takes, from its title or else its id.
pub(super) fn new_name(item: &Item, catalog: &Catalog) -> String {
    let title = item
        .properties
        .get(fields::title_field(catalog, &item.r#type))
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or(&item.id);
    // A file item's title is a file's name already, extension and all.
    if bytes_of(item, catalog).is_some() {
        name_from_title(title, None)
    } else {
        name_from_title(title, Some(".md"))
    }
}

/// A file's name for a title, with `extension` where the title carries none.
fn name_from_title(title: &str, extension: Option<&str>) -> String {
    let stem = names::title_stem(title);
    match extension {
        Some(extension) => names::fitted(&stem, extension),
        None => {
            let (stem, extension) = names::split_extension(&stem);
            names::fitted(stem, extension)
        }
    }
}

impl Folder {
    /// The path beside `path` named from `title`, numbered past a file there
    /// or another item's placement; `None` where the folder does not write
    /// there.
    fn title_path(
        &self,
        item_id: &str,
        path: &str,
        title: &str,
        renaming: &Renaming<'_>,
    ) -> Option<String> {
        let renamed = format!(
            "{}{}",
            crate::body::embed::dir_of(path),
            names::renamed_for(name_of(path), title)
        );
        let taken = |candidate: &str| {
            !crate::names::same(candidate, path)
                && (self.exists(self.root.join(candidate))
                    || renaming
                        .reserved
                        .get(&crate::names::folded(candidate))
                        .is_some_and(|edges| edges.iter().any(|edge| edge.source_id != item_id)))
        };
        let renamed = if taken(&renamed) {
            beside(&renamed, taken)
        } else {
            renamed
        };
        self.writes_at(renaming.lists, &renamed).then_some(renamed)
    }

    /// Each file is bound before its bytes land, so the scan never reads it
    /// back.
    ///
    /// Pulls again from the start where the copy changed under it, such as a
    /// catch-up applying a purge, since what it read is then stale.
    pub fn pull(&self) -> Result<PullReport> {
        self.pull_with(None)
    }

    /// A watch's pull, which renders only the files a change since its last
    /// pull reaches.
    pub(super) fn pull_selecting(&self, selection: &mut Selection) -> Result<PullReport> {
        self.pull_with(Some(selection))
    }

    fn pull_with(&self, mut selection: Option<&mut Selection>) -> Result<PullReport> {
        self.refuse_while_waiting()?;
        let mut earlier = PullReport::default();
        let mut attempts = 1;
        let mut relinking = true;
        loop {
            let mut report = PullReport::default();
            match self.pull_into(None, &mut report, selection.as_deref_mut()) {
                Ok(()) => {
                    // A body rewritten for a retitled link reaches its file
                    // in one more pass.
                    if std::mem::take(&mut relinking) && self.relink(&mut report)? {
                        earlier.add_writes(&report);
                        continue;
                    }
                    report.add_writes(&earlier);
                    report.root_gone = report.root_gone.or_else(|| self.root_gone());
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
    pub(super) fn pull_into(
        &self,
        planning: Option<&mut PullPlan>,
        report: &mut PullReport,
        selection: Option<&mut Selection>,
    ) -> Result<()> {
        if let Some(gone) = self.root_gone() {
            report.root_gone = Some(gone);
            return Ok(());
        }
        let context = crate::reach::Context::capture(&*self.core.conn()?)?;
        state::settle_landings(&*self.core.conn()?, &self.root_dir)?;
        let mut pick = match &selection {
            Some(selection) => Some(selection.begin(self)?),
            None => None,
        };
        let settings = self.settings()?;
        let lists = settings.lists()?;
        let mut members = self.members(&settings)?;
        let listed = self.core.list(
            &crate::model::ListFilters {
                all_states: true,
                ..Default::default()
            },
            crate::model::Sort::default(),
        )?;
        // A row a partial copy has not been given yet, or one a stale copy
        // still holds, says nothing of what the server deleted, so the pass
        // waits for a whole copy.
        if listed.completeness != crate::model::Completeness::Complete {
            return Err(CoreError::HydrationIncomplete);
        }
        let items = listed.rows;
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
        // A bound file whose item left the query, but not by state or the
        // bin, is kept current as a member's is and flagged; it never gets a
        // new file.
        let outside: Vec<String> = bound_items
            .into_iter()
            .filter(|id| !members.contains(id))
            .collect();
        let held = crate::store::items_by_ids(&*self.core.conn()?, &outside)?;
        let peers = Peers::of(self, None);
        let mut retained = Vec::new();
        // A folder that has never synced writes no file, so what a pass
        // would let go of is not its to count.
        let (files, documents): (Vec<Item>, Vec<Item>) = held
            .into_iter()
            .filter(|item| settings.holds_state(item.state) && planning.is_none())
            .partition(|item| bytes_of(item, &catalog).is_some());
        // Documents first: one let go embeds and has attached nothing here.
        self.let_go_outside(
            documents,
            &peers,
            &context,
            report,
            &mut work,
            &mut retained,
        )?;
        self.hold_edge_ends(&work, &edge_types, &catalog)?;
        let withheld = self.withheld()?;
        let renaming = Renaming {
            reserved: self.placed_here()?,
            lists: &lists,
        };
        // After the pins, so an embed names an attachment the copy now holds;
        // an item a file here embeds or has attached is that file's, never
        // unmatched.
        let embedded =
            self.with_documents(&work, &members, &withheld, &settings, &catalog, &renaming)?;
        // A file a document here embeds or has attached is that document's,
        // whatever other folder holds the item, so it is never let go.
        let (shown, files): (Vec<Item>, Vec<Item>) = files
            .into_iter()
            .partition(|item| embedded.at.contains_key(&item.id));
        work.extend(shown.into_iter().map(|item| (item, true)));
        self.let_go_outside(files, &peers, &context, report, &mut work, &mut retained)?;
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
        // A file here only as an attachment leaves with its documents, as
        // `remove_departed` takes it away; it is not kept as unmatched.
        let mut gone_with = HashSet::new();
        for (item, unmatched) in &work {
            if *unmatched && self.left_with_its_documents(&item.id, &settings)? {
                gone_with.insert(item.id.clone());
            }
        }
        work.retain(|(item, _)| !gone_with.contains(&item.id));
        // Held by the file embedding it or attached to it whatever state the
        // query narrows to;
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
        if let (Some(selection), Some(pick)) = (&selection, &mut pick) {
            selection.choose(self, pick, &settings, &names)?;
        }
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
        // Read, not looked for in the other folders: one arriving there is
        // counted, so a watch pulls again at its next pass.
        let kept: HashMap<String, (String, state::Kept)> = state::journaled(&*self.core.conn()?)?
            .into_iter()
            .filter_map(|row| Some((row.path, (row.item_id, row.kept?))))
            .collect();
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
                .is_some_and(|bound| bound.held.is_some() || bound.holds_refusal())
            {
                continue;
            }
            // Gone from the disk it is the scan's to journal; written back,
            // a file another folder took in would return.
            if *unmatched
                && bound
                    .as_ref()
                    .is_some_and(|bound| !self.exists(self.root.join(&bound.path)))
            {
                continue;
            }
            // A missing file the sweep kept bound is another folder's to take,
            // or a full pass's to tell; written anew it would read there as a
            // copy.
            if let Some(bound) = &bound
                && let Some((kept_for, why)) = kept.get(&bound.path)
                && *kept_for == item.id
                && !self.exists(self.root.join(&bound.path))
            {
                report.elsewhere += usize::from(*why == state::Kept::Arriving);
                continue;
            }
            // Moved to another folder here and not yet taken there, written
            // anew it would make the moved file read as a copy.
            if bound.is_none() && peers.arriving(&item.id) {
                report.elsewhere += 1;
                continue;
            }
            let taken = match &bound {
                None if !*unmatched => peers.let_go(&item.id, &members),
                _ => None,
            };
            let placed = self.placement(&item.id)?;
            // An embedded file goes where its link says, any other attachment
            // beside its document, and its placement follows.
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
                        &renaming,
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
                            || !wanted.contains(&name) && !self.exists(self.root.join(candidate)))
                };
                entry.want = beside(&entry.want, |candidate| !free(candidate));
                report.beside += 1;
            }
            taken.insert(crate::names::folded(&entry.want));
        }
        if let Some(plan) = planning {
            // Every entry still unbound is a file the pull will write, but
            // where a file is at its path. A file the scan bound is sent
            // before the pull, so the two are both kept and one takes a
            // number. A file the scan did not bind is the person's to mend,
            // and the pull writes nothing over it. Paths are compared as the
            // pull compares them, so a name in another case or Unicode form
            // is the same file.
            let bound: Vec<String> = state::bound_paths(&*self.core.conn()?)?
                .into_iter()
                .map(|(path, _)| path)
                .collect();
            for entry in placing.iter().filter(|entry| entry.bound.is_none()) {
                if bound
                    .iter()
                    .any(|path| crate::names::same(path, &entry.want))
                {
                    plan.write += 1;
                    plan.beside += 1;
                } else if !self.exists(self.root.join(&entry.want)) {
                    plan.write += 1;
                } else {
                    plan.left += 1;
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
        let filesystem = crate::reach::Context::capture(&*self.core.conn()?)?;
        let rendering = Rendering {
            context: std::cell::RefCell::new(filesystem),
            catalog: &catalog,
            edge_types: &edge_types,
            names: &names,
            lists: &lists,
            peers: &peers,
            members: &members,
            pick: pick.as_ref(),
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
        self.remove_departed(&members, &settings, &lists, &refused, &rendering, report)?;
        if crate::fault::named("copy-changes-after-pull-effects").is_some() {
            static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            if CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                crate::reach::pins_changed(&*self.core.conn()?)?;
                context.check(&*self.core.conn()?)?;
            }
        }
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
                    let refused = bound
                        .writes
                        .refused
                        .iter()
                        .rev()
                        .find(|refused| {
                            !matches!(refused.change, state::Change::DefaultEdge { .. })
                        })
                        .map(|refused| Flagged {
                            path: bound.path.clone(),
                            flag: "refused",
                            reason: refused.reason.clone(),
                            item: None,
                        });
                    let default = bound
                        .writes
                        .refused
                        .iter()
                        .rev()
                        .find(|refused| matches!(refused.change, state::Change::DefaultEdge { .. }))
                        .map(|refused| {
                            Flagged::default_edge_refused(&bound.path, refused.reason.clone())
                        });
                    held.into_iter().chain(refused).chain(default)
                })
                .collect::<Vec<_>>()
        });
        report.uncarried = fields::uncarried(&catalog, &edge_types, |r#type| {
            settings.holds_type(&catalog, r#type)
        });
        context.same_copy(&*self.core.conn()?)?;
        report.settings = self.write_settings_if_moved()?;
        drop(rendering);
        if let (Some(selection), Some(pick)) = (selection, pick) {
            selection.end(pick, &settings, names);
        }
        Ok(())
    }

    /// Leaves a file changed since the scan read it alone: the permission is
    /// then the person's.
    fn keep_executable(
        &self,
        item: &Item,
        want: &str,
        context: &crate::reach::Context,
    ) -> Result<()> {
        if !self.keeps_permissions() {
            return Ok(());
        }
        let path = self.root.join(want);
        let wanted = executable::held(item);
        let Ok((directory, name)) = self.location(&path, false) else {
            return Ok(());
        };
        let Ok(file) = directory.open_file(Path::new(&name), OFlags::RDONLY, Mode::empty()) else {
            return Ok(());
        };
        let Ok(metadata) = file.metadata() else {
            return Ok(());
        };
        if executable::of(&metadata) == wanted {
            return Ok(());
        }
        let conn = self.core.conn()?;
        context.check(&conn)?;
        let read = state::stat_of(&conn, want)?;
        if read.is_some()
            && read == stat_metadata(&metadata)
            && (!wanted || executable::quarantine(&file).is_ok())
        {
            let _ = executable::set(&file, wanted);
        }
        Ok(())
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
        if let Some(how) = crate::fault::named("copy-changes-during-pull") {
            static CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let call = CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if match how.as_str() {
                "once" => call == 0,
                "twice" => call < 2,
                "thrice" => call < 3,
                "second" => call == 1,
                _ => true,
            } {
                crate::reach::pins_changed(&*self.core.conn()?)?;
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
        // The file the last pull found or left as its item renders, which no
        // change since reaches, renders as it is.
        if taken.is_none()
            && let Some(bound) = bound
            && bound.path == want
            && rendering.pick.is_some_and(|pick| pick.skips(&item.id))
            && self.exists(self.root.join(&want))
        {
            return self.stay(item, bound, &want, rendering, withheld, report);
        }
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
                    .and_then(|bound| self.read(self.root.join(&bound.path)).ok())
                    .filter(|found| {
                        crate::blob::named(blob)
                            .is_ok_and(|named| crate::blob::name_of(found) == named)
                    });
                match on_disk {
                    Some(found) => {
                        self.core.let_go_blob(blob);
                        (found, Default::default(), Vec::new())
                    }
                    None => match self.core.blob_file(blob).map(|file| read_file(&file)) {
                        Ok(Ok(found)) => (found, Default::default(), Vec::new()),
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
                    .and_then(|bound| self.read_text(self.root.join(&bound.path)).ok())
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
                (
                    text.into_bytes(),
                    (rendered.links, rendered.embeds),
                    rendered.lines,
                )
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
            && self.deleted_as_agreed(
                item,
                bound,
                (rendering.catalog, rendering.edge_types, rendering.names),
            )?
        {
            return Ok(PlacementWrite::Done);
        }

        // The bytes on the disk, not the mapping's memory of them: a file
        // changed since the scan read it is the person's, and so is one that
        // cannot be read to tell. A file gone since the scan was moved or
        // deleted, and only the next scan can tell which: written back, a
        // moved file would read as its copy. Once journaled, the change it
        // shows may bring it back, as may a restore. No scan reaches a path
        // the lists stopped taking, so a file gone from one is written where
        // the item wants it.
        let changed = |bound: &state::Bound| -> Result<Option<&str>> {
            Ok(match self.read(self.root.join(&bound.path)) {
                Ok(found) => (state::hash(&found) != bound.content_hash).then_some(
                    "the file changed since the scan read it, and the next scan sends it",
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (bound.content_hash
                    != super::removal::PUT_BACK
                    && self.reaches(rendering.lists, &bound.path)
                    && !journaled_for(&*self.core.conn()?, &bound.path, &item.id)?)
                .then_some(
                    "the file is gone since the scan read it, and the next scan tells whether it moved",
                ),
                Err(_) => {
                    Some("the file could not be read to tell whether it changed since the scan")
                }
            })
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
        // A file the pull wrote itself renders as the scan read it, so only
        // the disk tells whether it is still there.
        let in_place = match &bound {
            Some(bound) if ours && bound.content_hash == hash && self.exists(&path) => true,
            Some(bound) => {
                if let Some(reason) = changed(bound)? {
                    report.not_written(NotWritten::Unwritten, &item.id, &bound.path, reason);
                    return Ok(PlacementWrite::Done);
                }
                ours && (bound.content_hash == hash
                    || self.behind_by_its_line_alone(item, bound, rendering)?)
            }
            None => false,
        };
        // Written back from a change made elsewhere, a file moved to another
        // folder here would read there as a copy; the moved file brings the
        // change to the item once that folder binds it. A move that cannot be
        // told yet is the grace sweep's to tell.
        if !in_place
            && let Some(bound) = bound
            && !self.exists(self.root.join(&bound.path))
            && journaled_for(&*self.core.conn()?, &bound.path, &item.id)?
        {
            match rendering.peers.moved_to(
                bound,
                rendering.members.contains(&item.id),
                bytes_of(item, catalog).is_some(),
            ) {
                Look::Nowhere => {}
                Look::Moved | Look::Arriving => {
                    report.elsewhere += 1;
                    return Ok(PlacementWrite::Done);
                }
                Look::Unsure(_) => return Ok(PlacementWrite::Done),
            }
        }
        // Read before a move queues the placement, which is no edit the
        // file holds.
        let waiting: HashSet<String> =
            crate::store::waiting_writes_for_item(&*self.core.conn()?, &item.id)?
                .into_iter()
                .filter(|write| write.verdict != Some(crate::model::Verdict::Dead))
                .map(|write| write.id)
                .collect();
        // A move goes as a rename first, so an editor holding the file
        // follows it, and only then are new bytes written over it.
        let moved = match bound {
            Some(old) if !ours && !self.exists(&path) => {
                self.move_bound(old, &want, item, (rendering, withheld))?
            }
            _ => None,
        };
        if let Some((_, placed)) = &moved {
            report.moved += 1;
            report.placed += usize::from(*placed);
        }
        let moved = moved.map(|(moved, _)| moved);
        let in_place = match &moved {
            Some(moved) if moved.content_hash == hash => true,
            Some(moved) => self.behind_by_its_line_alone(item, moved, rendering)?,
            None => in_place,
        };
        let bound = if moved.is_some() { &moved } else { bound };
        let ours = bound.as_ref().is_some_and(|bound| bound.path == want);
        // Something at the destination that is not this item's own file,
        // unless it is byte for byte this item's render.
        let occupied = !in_place && !ours && self.exists(&path);
        let rebound =
            occupied && bound.is_none() && self.read(&path).is_ok_and(|found| found == bytes);
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
                    blob: bytes_of(item, catalog).map(str::to_string),
                    written_hash: Some(hash),
                    links: wrote.0,
                    embeds: wrote.1,
                    lines,
                    edit_line: None,
                    held: None,
                    own,
                    writes: state::Writes::default(),
                },
            )?;
            state::journal_clear_for(&conn, &want, &item.id)?;
            report.unchanged += 1;
            if let Some(pick) = rendering.pick {
                pick.settle(&item.id);
            }
            return Ok(PlacementWrite::Done);
        }
        if in_place && let Some(bound) = bound {
            let found = self.found_as_written(item, bound, Found::InPlace(&hash), rendering)?;
            return self.stay(
                item,
                found.as_ref().unwrap_or(bound),
                &want,
                rendering,
                withheld,
                report,
            );
        }

        // Written over an edit still waiting, the line it writes is spent
        // too, since the file holds that edit. A dead edit remains projected,
        // but cannot spend a newer line until it is released.
        let mut writes = bound
            .as_ref()
            .map(|bound| bound.writes.clone())
            .unwrap_or_default();
        writes.deferred_title = None;
        let mut edit_line = bound.as_ref().and_then(|bound| bound.edit_line);
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
            blob: bytes_of(item, catalog).map(str::to_string),
            written_hash: Some(hash.clone()),
            links: wrote.0.clone(),
            embeds: wrote.1.clone(),
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
            .filter(|_| ours && self.exists(&path))
            .map(|bound| bound.content_hash.clone());
        let file_item = bytes_of(item, catalog).is_some();
        // Bound before the write, so the scan never reads it back; a path the
        // filesystem refuses, or a write that fails part way, leaves the old
        // file, and every other, as it was.
        let conn = self.core.conn()?;
        if crate::fault::named("purge-during-pull").as_deref() == Some(item.id.as_str()) {
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
        self.move_folder_if_asked();
        // Expiry and rebuild take this same lock. Keep authority stable through
        // the filesystem commit and its binding, not only the preceding check.
        let conn = self.core.conn()?;
        rendering.context.borrow().check(&conn)?;
        let written = self.land(
            &path,
            |file, _| {
                std::io::Write::write_all(file, &bytes)?;
                if file_item {
                    executable::quarantine(file)?;
                    if self.keeps_permissions() {
                        // The bytes are written whatever the permission does.
                        let _ = executable::set(file, executable::held(item));
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
            if plainly_inside(&self.root_dir, &bound.path) {
                let _ = self.remove_file(&self.root.join(&bound.path), |found| {
                    state::hash(found) == bound.content_hash
                });
            }
            rendering.unbind(&conn, &bound.path)?;
            state::set_moved_from(
                &conn,
                &item.id,
                &state::MovedFrom {
                    path: bound.path.clone(),
                    version: item.version,
                },
            )?;
            if journaled_for(&conn, &bound.path, &item.id)? {
                report.revived += 1;
            }
            state::journal_clear(&conn, &bound.path)?;
            report.moved += 1;
        }
        report.placed += usize::from(self.place(&item.id, &want, withheld)?);
        // Read after the write, because the file did not exist until now.
        if let Ok(metadata) = self.metadata(&path)
            && let Some(found) = identity::of(&metadata)
        {
            rendering.bind(&*self.core.conn()?, &binding(Some(found.key())))?;
        }
        if bound.is_none() {
            report.written += 1;
        } else {
            report.rewritten += 1;
        }
        if let Some(pick) = rendering.pick {
            pick.settle(&item.id);
            if entry.taken.is_none() && entry.bound.as_ref().is_some_and(|bound| bound.path == want)
            {
                pick.rewrote(&item.id, &want);
            }
        }
        Ok(PlacementWrite::Done)
    }

    /// Leaves a file that holds what its item renders where it is.
    fn stay(
        &self,
        item: &Item,
        bound: &state::Bound,
        want: &str,
        rendering: &Rendering<'_>,
        withheld: &placement::Withheld,
        report: &mut PullReport,
    ) -> Result<PlacementWrite> {
        if bound.writes.deferred_title.is_some() {
            state::bind(
                &*self.core.conn()?,
                &state::Bound {
                    writes: state::Writes {
                        deferred_title: None,
                        ..bound.writes.clone()
                    },
                    ..bound.clone()
                },
            )?;
        }
        if bytes_of(item, rendering.catalog).is_some() {
            self.keep_executable(item, want, &rendering.context.borrow())?;
        }
        report.placed += usize::from(self.place(&item.id, want, withheld)?);
        report.unchanged += 1;
        if let Some(pick) = rendering.pick {
            pick.settle(&item.id);
        }
        Ok(PlacementWrite::Done)
    }

    /// Moves a bound file to `want` by a rename where it still holds the bytes
    /// it is bound to, and its binding and placement with it, so a crash
    /// before its new bytes land leaves it there. Answers the new binding and
    /// whether a placement was queued; `None` where the file is not as bound,
    /// or the rename is refused, which leaves the file and its binding as
    /// they were.
    fn move_bound(
        &self,
        bound: &state::Bound,
        want: &str,
        item: &Item,
        (rendering, withheld): (&Rendering<'_>, &placement::Withheld),
    ) -> Result<Option<(state::Bound, bool)>> {
        let from = self.root.join(&bound.path);
        let to = self.root.join(want);
        if bound.writes.landing.is_some()
            || !plainly_inside(&self.root_dir, &bound.path)
            || !self
                .read(&from)
                .is_ok_and(|found| state::hash(&found) == bound.content_hash)
        {
            return Ok(None);
        }
        let moved = state::Bound {
            path: want.to_string(),
            ..bound.clone()
        };
        // Bound before the rename, as a write is, so a crash in between
        // leaves the path bound as it was.
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
                    ..moved.writes.clone()
                },
                ..moved.clone()
            },
        )?;
        drop(conn);
        // Queued before the rename, so a crash after it leaves the placement
        // where the file is going, and the next pull finishes the move rather
        // than moving it back.
        let placed = self.place(&item.id, want, withheld)?;
        self.move_folder_if_asked();
        let renamed = self.inside(to.parent()).and_then(|()| {
            let (from_dir, from_name) = self.location(&from, false)?;
            let (to_dir, to_name) = self.location(&to, true)?;
            landing::save_meanwhile(&from_dir, Path::new(&from_name));
            landing::rename_new_at(
                &from_dir,
                Path::new(&from_name),
                &to_dir,
                Path::new(&to_name),
            )
        });
        let conn = self.core.conn()?;
        if renamed.is_err() {
            match &before {
                Some(before) => rendering.bind(&conn, before)?,
                None => rendering.unbind(&conn, want)?,
            }
            drop(conn);
            if placed {
                self.place(&item.id, &bound.path, withheld)?;
                if let Ok(mut refused) = self.refused_renames.lock() {
                    refused.insert(item.id.clone(), (bound.path.clone(), want.to_string()));
                }
            }
            return Ok(None);
        }
        let swap = conn.unchecked_transaction()?;
        rendering.bind(&swap, &moved)?;
        rendering.unbind(&swap, &bound.path)?;
        state::journal_clear(&swap, &bound.path)?;
        state::journal_clear_for(&swap, want, &item.id)?;
        state::set_moved_from(
            &swap,
            &item.id,
            &state::MovedFrom {
                path: bound.path.clone(),
                version: item.version,
            },
        )?;
        swap.commit()?;
        Ok(Some((moved, placed)))
    }

    /// The folder moved away between a write's binding and its landing, where
    /// a debug fixture asks.
    fn move_folder_if_asked(&self) {
        if crate::fault::named("move-folder-before-write").is_some() {
            let _ = std::fs::rename(
                &self.root,
                self.root.with_file_name(format!(
                    "{}-away",
                    self.root.file_name().unwrap_or_default().to_string_lossy()
                )),
            );
        }
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
        if self.exists(&path) {
            return Ok(TakeIn::Inapplicable);
        }
        let Ok(source) = transfer::Source::open_at(from, theirs) else {
            return Ok(TakeIn::Inapplicable);
        };
        let binding = |identity: Option<String>| state::Bound {
            path: want.to_string(),
            item_id: item.id.clone(),
            identity,
            content_hash: theirs.content_hash.clone(),
            presentation: theirs.presentation.clone(),
            blob: theirs.blob.clone(),
            written_hash: Some(theirs.content_hash.clone()),
            links: theirs.links.clone(),
            embeds: theirs.embeds.clone(),
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
            let (target_dir, target_name) = self.location(&path, true)?;
            landing::appear_at(&target_dir, Path::new(&target_name), "create-before-move")?;
            source.check()?;
            let renamed = if crate::fault::named("cross-volume-move").is_some() {
                Err(std::io::Error::from(std::io::ErrorKind::CrossesDevices))
            } else {
                landing::rename_new_at(
                    &from.directory,
                    &from.name,
                    &target_dir,
                    Path::new(&target_name),
                )
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
                        let _ = landing::remove_at(&from.directory, &from.name, |found| {
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
        if let Ok(metadata) = self.metadata(&path)
            && let Some(found) = identity::of(&metadata)
        {
            rendering.bind(&conn, &binding(Some(found.key())))?;
        }
        drop(conn);
        report.placed += usize::from(self.place(&item.id, want, withheld)?);
        report.taken += 1;
        Ok(TakeIn::Taken)
    }

    /// Where each file a document of `work` embeds or has attached is
    /// written, each document read at the path a pull writes it.
    fn with_documents(
        &self,
        work: &[(Item, bool)],
        members: &HashSet<String>,
        withheld: &placement::Withheld,
        settings: &Settings,
        catalog: &Catalog,
        renaming: &Renaming<'_>,
    ) -> Result<super::embeds::Embedded> {
        let mut hosts = Vec::new();
        for (item, _) in work {
            if item.version == 0 || bytes_of(item, catalog).is_some() {
                continue;
            }
            let bound = state::bound_to_item(&*self.core.conn()?, &item.id)?;
            let placed = self.placement(&item.id)?;
            if let Some(path) = self.path_for(
                item,
                placed.as_ref(),
                bound.as_ref(),
                withheld,
                settings,
                catalog,
                renaming,
            ) {
                hosts.push((item, path));
            }
        }
        self.embedded(&hosts, members, catalog, renaming.lists)
    }

    /// The files a pull writes as the embeds or attachments of documents
    /// here: those of members, and of bound documents in a state the query
    /// holds whose file is not among `missing`, since no pull writes back an
    /// unmatched document.
    pub(super) fn written_with_documents(
        &self,
        settings: &Settings,
        members: &HashSet<String>,
        missing: &[String],
    ) -> Result<HashSet<String>> {
        let lists = settings.lists()?;
        let missing: HashSet<&str> = missing.iter().map(String::as_str).collect();
        let (catalog, bound) = {
            let conn = self.core.conn()?;
            let bound: HashSet<String> = state::every_bound(&conn)?
                .into_iter()
                .filter(|bound| !missing.contains(bound.path.as_str()))
                .map(|bound| bound.item_id)
                .collect();
            (Catalog::load(&conn)?, bound)
        };
        // Only a document something is attached to, or one that references
        // something as an embed does, can place a file.
        let mut documents: Vec<String> = self
            .core
            .edges_of_type(ATTACHMENT_EDGE)?
            .into_iter()
            .map(|edge| edge.target_id)
            .chain(
                self.core
                    .edges_of_type(super::LINK_EDGE)?
                    .into_iter()
                    .map(|edge| edge.source_id),
            )
            .filter(|id| members.contains(id) || bound.contains(id))
            .collect();
        documents.sort_unstable();
        documents.dedup();
        let work: Vec<(Item, bool)> = crate::store::items_by_ids(&*self.core.conn()?, &documents)?
            .into_iter()
            .filter(|item| members.contains(&item.id) || settings.holds_state(item.state))
            .map(|item| (item, false))
            .collect();
        let renaming = Renaming {
            reserved: self.placed_here()?,
            lists: &lists,
        };
        let withheld = self.withheld()?;
        let embedded =
            self.with_documents(&work, members, &withheld, settings, &catalog, &renaming)?;
        Ok(embedded.at.into_keys().collect())
    }

    /// Lets go of each file of `items`, outside the query, that another
    /// folder files; the rest stay to be kept current here, unmatched.
    fn let_go_outside(
        &self,
        items: Vec<Item>,
        peers: &Peers<'_>,
        context: &crate::reach::Context,
        report: &mut PullReport,
        work: &mut Vec<(Item, bool)>,
        retained: &mut Vec<String>,
    ) -> Result<()> {
        for item in items {
            context.same_copy(&*self.core.conn()?)?;
            match self.let_go(&item.id, peers, context, report)? {
                LetGo::Inapplicable => work.push((item, true)),
                LetGo::Retained => retained.push(item.id),
                LetGo::Removed => {}
            }
        }
        Ok(())
    }

    /// Trashes nothing. Answers whether it did.
    fn let_go(
        &self,
        item_id: &str,
        peers: &Peers<'_>,
        context: &crate::reach::Context,
        report: &mut PullReport,
    ) -> Result<LetGo> {
        let Some(bound) = state::bound_to_item(&*self.core.conn()?, item_id)? else {
            return Ok(LetGo::Inapplicable);
        };
        let path = self.root.join(&bound.path);
        let own = self
            .read(&path)
            .is_ok_and(|found| bound.written_hash.as_deref() == Some(state::hash(&found).as_str()));
        if !own || !plainly_inside(&self.root_dir, &bound.path) || !peers.filed_elsewhere(item_id) {
            return Ok(LetGo::Inapplicable);
        }
        let Ok((directory, name)) = self.location(&path, false) else {
            return Ok(LetGo::Inapplicable);
        };
        let entry = transfer::Entry {
            directory,
            name: name.into(),
            label: path.clone(),
        };
        let Ok(source) = transfer::Source::open_at(&entry, &bound) else {
            return Ok(LetGo::Inapplicable);
        };
        // Checked again as it goes, so an edit saved meanwhile stays.
        let conn = self.core.conn()?;
        context.same_copy(&conn)?;
        let removed = match landing::remove_checked_at(&entry.directory, &entry.name, |found| {
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
        drop(conn);
        // After the removal, which may be refused, and before the binding
        // goes, so a failure leaves the binding for the scan to settle.
        let ended = self.end_placement(item_id, &bound.path)?;
        let conn = self.core.conn()?;
        state::unbind(&conn, &bound.path)?;
        state::journal_clear(&conn, &bound.path)?;
        report.ended += ended;
        report.let_go += 1;
        Ok(LetGo::Removed)
    }

    fn remove_departed(
        &self,
        members: &HashSet<String>,
        settings: &Settings,
        lists: &Lists,
        refused: &HashSet<String>,
        rendering: &Rendering<'_>,
        report: &mut PullReport,
    ) -> Result<()> {
        let mut context = crate::reach::Context::capture(&*self.core.conn()?)?;
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
                Departing::Kept => match self.found_departed(&row, rendering)? {
                    Some(found) => going.push(found),
                    None => report.kept += 1,
                },
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

    pub(super) fn departing(
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
            Some(item)
                if settings.holds_state(item.state)
                    && (row.blob.is_none()
                        || !self.left_with_its_documents(&item.id, settings)?) =>
            {
                return Ok(Departing::No);
            }
            _ => {}
        }
        Ok(match self.read(self.root.join(&row.path)) {
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

    /// Whether an item the query does not hold is attached to documents
    /// and every one of them left the folder by its state or was purged, so
    /// its file, there only as their attachment, leaves with them. An item
    /// attached to nothing, such as one whose edge was taken away, stays as
    /// any unmatched file does, and so does one attached to a document still
    /// in a state the query holds, wherever that document is.
    fn left_with_its_documents(&self, item_id: &str, settings: &Settings) -> Result<bool> {
        let documents: Vec<String> = self
            .core
            .edges_from(item_id)?
            .into_iter()
            .filter(|edge| edge.edge_type == ATTACHMENT_EDGE)
            .map(|edge| edge.target_id)
            .collect();
        if documents.is_empty() {
            return Ok(false);
        }
        let conn = self.core.conn()?;
        let held = crate::store::items_by_ids(&conn, &documents)?;
        for document in &documents {
            let gone = match held.iter().find(|item| &item.id == document) {
                Some(item) => !settings.holds_state(item.state),
                None => crate::store::purged(&conn, document)?,
            };
            if !gone {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// A journal row here is a file put back since its scan, so it asks for
    /// nothing now. Answers `None`, and keeps the file bound, where it
    /// changed since it was found to be the folder's own: the person's edit
    /// is theirs. Otherwise answers how many placements it ended with the
    /// file.
    pub(super) fn take_away(
        &self,
        row: &state::Bound,
        context: &mut crate::reach::Context,
    ) -> Result<Option<usize>> {
        // First: a failure leaves the file and its binding, and the next pass
        // finds no placement left to end and takes the file away.
        let ended = self.end_placement(&row.item_id, &row.path)?;
        let conn = self.core.conn()?;
        context.check(&conn)?;
        let path = self.root.join(&row.path);
        if plainly_inside(&self.root_dir, &row.path) {
            let still =
                |found: &[u8]| row.written_hash.as_deref() == Some(state::hash(found).as_str());
            if self.exists(&path)
                && !self.remove_file(&path, still).map_err(|error| {
                    CoreError::Store(format!("cannot remove {}: {error}", path.display()))
                })?
                && self.exists(&path)
            {
                return Ok(None);
            }
        }
        context.change_pins(&conn, || state::unbind(&conn, &row.path))?;
        state::journal_clear(&conn, &row.path)?;
        Ok(Some(ended))
    }

    /// Whether another device changed a missing file's item in what the file
    /// showed, so the file comes back rather than the item going to the bin
    /// (`folders/missing-file-changed-revives`). Told from the copy alone,
    /// with no server and no held bytes: a file item by the blob its binding
    /// last agreed at, a document by its agreed presentation.
    pub(super) fn changed_while_missing(
        &self,
        item: &Item,
        bound: &state::Bound,
        basis: Basis<'_>,
    ) -> Result<bool> {
        match bytes_of(item, basis.0) {
            // A binding that names no blob cannot tell, so the file comes back.
            Some(blob) => Ok(bound.agreed_blob(blob) != Some(true)),
            None => Ok(!self.deleted_as_agreed(item, bound, basis)?),
        }
    }

    fn deleted_as_agreed(
        &self,
        item: &Item,
        bound: &state::Bound,
        (catalog, edge_types, names): Basis<'_>,
    ) -> Result<bool> {
        if self.is_file(self.root.join(&bound.path))
            || !journaled_for(&*self.core.conn()?, &bound.path, &item.id)?
        {
            return Ok(false);
        }
        // A file found as its item rendered, by a copy that never wrote it,
        // showed the line its bytes carry.
        let line = carries_frontmatter(Path::new(&bound.path))
            .then(|| {
                bound.own.as_ref().map(|own| own.line).or_else(|| {
                    bound
                        .presentation
                        .as_ref()
                        .and_then(|agreed| line_of(agreed.front()))
                })
            })
            .flatten();
        let previous = bound
            .presentation
            .as_ref()
            .map(document::Presentation::document);
        let rendered = self.render(
            item,
            &bound.path,
            line,
            catalog,
            edge_types,
            (names, previous.as_ref(), &bound.lines),
        )?;
        let Ok(text) = rendered.text else {
            return Ok(false);
        };
        let presented = if carries_frontmatter(Path::new(&bound.path)) {
            document::read(&text)
        } else {
            document::read_body(&text)
        };
        Ok(bound.presentation.as_ref().is_some_and(|agreed| {
            // A file deleted before the folder first wrote its own lines into
            // it never showed them.
            let presented = [
                fields::ID_FIELD,
                fields::VERSION_FIELD,
                fields::TYPE_FIELD,
                fields::TIER_FIELD,
            ]
            .into_iter()
            .filter(|field| !agreed.front().contains_key(*field))
            .fold(presented.presentation(), |presented, field| {
                presented.with(field, None)
            });
            agreed.agrees(&presented, edge_types)
        }))
    }

    /// The binding of a departing file this folder never wrote but found as
    /// its item renders, with those bytes recorded as its own, so the file
    /// leaves with its item: an item put in the bin before a pull recorded
    /// them, or before the folder recorded found bytes at all.
    fn found_departed(
        &self,
        row: &state::Bound,
        rendering: &Rendering<'_>,
    ) -> Result<Option<state::Bound>> {
        let held = {
            let conn = self.core.conn()?;
            crate::store::items_by_ids(&conn, std::slice::from_ref(&row.item_id))?.pop()
        };
        match held {
            Some(item) => self.found_as_written(&item, row, Found::Departed, rendering),
            None => Ok(None),
        }
    }

    /// The binding of a file that this folder never wrote but found holding
    /// byte for byte what it would write there at the version line the file
    /// shows, and at the state it shows where the item has left the folder,
    /// or at the item's own version where the file is in place and
    /// holds what the pull would write now, as a folder added over files an
    /// earlier copy wrote finds them, with those bytes recorded as its own.
    /// `None` where the file is not such a file.
    ///
    /// A document this folder wrote has its own-field lines on record, and a
    /// later change to it is the person's, even one a render would keep: a
    /// render keeps the formatting of the file it renders over. For the same
    /// reason a found document holding a comment, or an empty property its
    /// item does not hold, is the person's: a render keeps both, and neither
    /// is in the item, so removing the file would lose them.
    fn found_as_written(
        &self,
        item: &Item,
        bound: &state::Bound,
        found: Found<'_>,
        rendering: &Rendering<'_>,
    ) -> Result<Option<state::Bound>> {
        let document = carries_frontmatter(Path::new(&bound.path));
        if bound.written_hash.as_deref() == Some(bound.content_hash.as_str())
            || bound.held.is_some()
            || !bound.writes.queued.is_empty()
            || document && bound.own.is_some()
        {
            return Ok(None);
        }
        let Ok(bytes) = self.read(self.root.join(&bound.path)) else {
            return Ok(None);
        };
        if state::hash(&bytes) != bound.content_hash {
            return Ok(None);
        }
        let typed = if document {
            let Ok(text) = std::str::from_utf8(&bytes) else {
                return Ok(None);
            };
            let typed = document::read(text);
            if typed.holds_unread_text()
                || typed.front.iter().any(|(name, value)| {
                    value.is_null() && item.properties.get(name) != Some(&Value::Null)
                })
            {
                return Ok(None);
            }
            Some(typed)
        } else {
            None
        };
        let line = if let Found::InPlace(rendered) = found
            && rendered == bound.content_hash
        {
            item.version
        } else if let Some(typed) = &typed
            && let Some(line) = line_of(&typed.front).filter(|line| *line < item.version)
            && let Some(shown) = match found {
                Found::InPlace(_) => Some(std::borrow::Cow::Borrowed(item)),
                // Leaving the folder is no change the file shows.
                Found::Departed => shown_state(&typed.front).map(|state| {
                    std::borrow::Cow::Owned(Item {
                        state,
                        ..item.clone()
                    })
                }),
            }
            && self
                .render(
                    &shown,
                    &bound.path,
                    Some(line),
                    rendering.catalog,
                    rendering.edge_types,
                    (rendering.names, Some(typed), &bound.lines),
                )?
                .text
                .is_ok_and(|text| state::hash(text.as_bytes()) == bound.content_hash)
        {
            line
        } else {
            return Ok(None);
        };
        rendering.context.borrow().check(&*self.core.conn()?)?;
        let recorded = state::Bound {
            written_hash: Some(bound.content_hash.clone()),
            own: document.then(|| fields::OwnBase::written(None, line, fields::Own::of(item))),
            ..bound.clone()
        };
        state::bind(&*self.core.conn()?, &recorded)?;
        Ok(Some(recorded))
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
        let Ok(found) = self.read_text(self.root.join(&bound.path)) else {
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

    /// The path a bound document's file moves to when its item's title
    /// changed away from the name the file was in step with.
    fn retitled(
        &self,
        item: &Item,
        bound: &state::Bound,
        catalog: &Catalog,
        renaming: &Renaming<'_>,
    ) -> Option<String> {
        if bytes_of(item, catalog).is_some() || !carries_frontmatter(Path::new(&bound.path)) {
            return None;
        }
        let field = fields::title_field(catalog, &item.r#type);
        let title = item.properties.get(field).and_then(Value::as_str)?;
        // A title this copy has not heard the server take renames nothing yet.
        if self
            .core
            .conn()
            .ok()
            .is_none_or(|conn| crate::store::item_waits(&conn, &item.id).unwrap_or(true))
        {
            return None;
        }
        let was = bound.presentation.as_ref()?.front().get(field);
        let was = match was {
            Some(Value::String(was)) => Some(was.as_str()),
            Some(Value::Null) | None => None,
            // A title no file name was made from.
            Some(_) => return None,
        };
        if !self.follows_title(&bound.path, was, title) {
            return None;
        }
        let path = self.title_path(&item.id, &bound.path, title, renaming)?;
        let refused = self.refused_renames.lock().is_ok_and(|refused| {
            refused.get(&item.id) == Some(&(bound.path.clone(), path.clone()))
        });
        (!refused).then_some(path)
    }

    #[allow(clippy::too_many_arguments)]
    fn path_for(
        &self,
        item: &Item,
        placed: Option<&crate::model::Edge>,
        bound: Option<&state::Bound>,
        withheld: &placement::Withheld,
        settings: &Settings,
        catalog: &Catalog,
        renaming: &Renaming<'_>,
    ) -> Option<String> {
        // A placement the server refused never moved the file away from it.
        if let Some(bound) = bound
            && withheld.contains_key(&item.id)
        {
            return Some(bound.path.clone());
        }
        // Where its file stays, a document whose title changed takes the name
        // the new title makes.
        let staying = |path: String| match bound {
            Some(bound) if crate::names::same(&bound.path, &path) => self
                .retitled(item, bound, catalog, renaming)
                .unwrap_or(path),
            _ => path,
        };
        if let Some(placed) = placed {
            return path_of(placed).and_then(cleaned).map(staying);
        }
        if let Some(bound) = bound {
            return Some(staying(bound.path.clone()));
        }
        let name = new_name(item, catalog);
        match settings.first_placement_for(&item.r#type, catalog) {
            Some(dir) => cleaned(&format!("{dir}/{name}")),
            None => Some(name),
        }
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
        let recorded = self.hold_ends(&wanted, |_, error| {
            if matches!(error, CoreError::NoServer) || error.is_environmental() {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        let conn = self.core.conn()?;
        for (id, made) in recorded {
            if !wanted.contains(&id) {
                state::release_edge_end(&conn, &id, made)?;
            }
        }
        Ok(())
    }

    /// Holds the attachments of `members` as `hold_edge_ends` would, for a
    /// scan that runs before any pull has: one that has none of them would
    /// send a file the directory has where a pull writes one as a new item.
    /// Answers each the server could not be asked for or refused to show for
    /// a reason other than that it is gone or hidden, with why. What ends a
    /// drain, a changed copy among it, ends the scan instead, since it is no
    /// one file's: the push after the scan would meet it too.
    pub(super) fn hold_attachments(
        &self,
        members: &HashSet<String>,
    ) -> Result<HashMap<String, String>> {
        let wanted: std::collections::BTreeSet<String> = self
            .core
            .edges_of_type(ATTACHMENT_EDGE)?
            .into_iter()
            .filter(|edge| members.contains(&edge.target_id))
            .map(|edge| edge.source_id)
            .collect();
        let mut unread = HashMap::new();
        self.hold_ends(&wanted, |id, error| {
            if crate::drain::ends_the_drain(&error) || error == CoreError::Canceled {
                return Err(error);
            }
            unread.insert(id.to_string(), error.to_string());
            Ok(())
        })?;
        Ok(unread)
    }

    /// Pins each of `wanted` the record does not hold yet and records it,
    /// passing `unread` each pin that failed for a reason other than that the
    /// item is gone or hidden. Answers the record as it stood before.
    fn hold_ends(
        &self,
        wanted: &std::collections::BTreeSet<String>,
        mut unread: impl FnMut(&str, CoreError) -> Result<()>,
    ) -> Result<HashMap<String, bool>> {
        let recorded: HashMap<String, bool> =
            state::edge_ends(&*self.core.conn()?)?.into_iter().collect();
        for id in wanted {
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
                // A pin the server refuses lets go of the pin it took, which
                // moves the copy revision, so a watch's next pass pulls and
                // asks again.
                match self.core.pin(id) {
                    Ok(_) => true,
                    Err(CoreError::NotFound { .. } | CoreError::Forbidden { .. }) => continue,
                    Err(error) => {
                        unread(id, error)?;
                        continue;
                    }
                }
            };
            state::hold_edge_end(&*self.core.conn()?, id, made)?;
        }
        Ok(recorded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::{STATE_DIR, settings_file, working};
    use crate::model::Draft;
    use crate::{Core, Server};

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
            let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let db = dir.path().join(STATE_DIR).join("core.sqlite");
            std::fs::create_dir_all(db.parent().unwrap()).unwrap();
            let core = working(Core::open(&db, None).unwrap()).unwrap();
            settings_file::bind(&core, "folder").unwrap();
            {
                let conn = core.conn().unwrap();
                store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
                store::meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
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
            let lists = Lists::new(&[], &[]).unwrap();
            let context = crate::reach::Context::capture(&folder.core.conn().unwrap()).unwrap();
            let rendering = Rendering {
                context: std::cell::RefCell::new(context),
                catalog: &catalog,
                names: &names,
                edge_types: &edge_types,
                lists: &lists,
                peers: &Peers::of(&folder, None),
                members: &HashSet::new(),
                pick: None,
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
    fn a_file_gone_from_a_path_no_scan_reaches_is_written_where_its_item_wants_it() {
        use crate::store;
        // The lists stop taking `x/`; the witness takes it still.
        for ignored in [true, false] {
            let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let db = dir.path().join(STATE_DIR).join("core.sqlite");
            std::fs::create_dir_all(db.parent().unwrap()).unwrap();
            let core = working(Core::open(&db, None).unwrap()).unwrap();
            settings_file::bind(&core, "folder").unwrap();
            let item = {
                let conn = core.conn().unwrap();
                store::meta_set(&conn, store::META_EVENT_CURSOR, "10").unwrap();
                store::meta_set(&conn, crate::reach::FENCE, crate::scripted::FENCE).unwrap();
                store::meta_set(&conn, store::META_INSTANCE_ID, crate::scripted::INSTANCE).unwrap();
                store::meta_set(&conn, store::META_SLICE_TYPES, "[\"core.note\"]").unwrap();
                store::meta_set(&conn, store::META_SLICE_TIER, "library").unwrap();
                store::replace_types(
                    &conn,
                    &[store::testing::wire_type("core.note", None, Some("title"))],
                )
                .unwrap();
                let note = store::testing::note("note", "a", "body", "2026-01-01T00:00:00Z");
                store::upsert_item(&conn, &note, None, &Default::default()).unwrap();
                let bound = state::Bound {
                    path: "x/a.md".into(),
                    item_id: "note".into(),
                    identity: None,
                    content_hash: state::hash(b"---\ntitle: a\n---\nbody\n"),
                    presentation: None,
                    blob: None,
                    written_hash: None,
                    links: Vec::new(),
                    embeds: Vec::new(),
                    lines: Vec::new(),
                    edit_line: None,
                    held: None,
                    own: None,
                    writes: state::Writes::default(),
                };
                state::bind(&conn, &bound).unwrap();
                (store::item_by_id(&conn, "note").unwrap().unwrap(), bound)
            };
            drop(core);
            let (item, bound) = item;
            let folder = Folder::open(dir.path(), None).unwrap();
            let catalog = Catalog::load(&folder.core.conn().unwrap()).unwrap();
            let names = Names::load(&folder.core.conn().unwrap(), &catalog, &BoundFiles).unwrap();
            let edge_types = EdgeTypes::default();
            let ignore = if ignored { vec!["x/**".into()] } else { vec![] };
            let lists = Lists::new(&[], &ignore).unwrap();
            let context = crate::reach::Context::capture(&folder.core.conn().unwrap()).unwrap();
            let rendering = Rendering {
                context: std::cell::RefCell::new(context),
                catalog: &catalog,
                names: &names,
                edge_types: &edge_types,
                lists: &lists,
                peers: &Peers::of(&folder, None),
                members: &HashSet::new(),
                pick: None,
            };
            let entry = Placing {
                item: &item,
                bound: Some(bound),
                want: "a.md".into(),
                rank: placement::unplaced_rank(false),
                taken: None,
            };
            let mut report = PullReport::default();
            folder
                .write_placed(&entry, &rendering, &Default::default(), None, &mut report)
                .unwrap();
            let written = dir.path().join("a.md").exists();
            if ignored {
                assert!(written, "{report:?}");
                assert_eq!(report.unwritten, 0, "{report:?}");
                assert!(report.flagged.is_empty(), "{report:?}");
            } else {
                assert!(!written, "{report:?}");
                assert_eq!(report.unwritten, 1, "{report:?}");
                assert_eq!(
                    (
                        report.flagged[0].path.as_str(),
                        report.flagged[0].reason.as_str()
                    ),
                    (
                        "x/a.md",
                        "the file is gone since the scan read it, and the next scan tells whether it moved"
                    )
                );
            }
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
}
