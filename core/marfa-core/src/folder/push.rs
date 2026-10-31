use super::{
    BoundFiles, Catalog, CoreError, Draft, EdgeTypes, EdgeWork, Edit, FILE_TYPE, Flagged, Folder,
    HashSet, Item, ItemState, Kept, LOCAL_ADMISSION_REFUSAL, Map, Names, Path, Resolver, Result,
    Retitle, Scanned, Settings, Value, blank, bytes_of, bytes_type, carries_frontmatter, document,
    executable, fields, identity, local_admission_refusal, local_properties_refusal, name_of,
    names, placement, state, title_of,
};

fn named_item(queued: crate::model::QueuedWrite, key: &str) -> Result<String> {
    queued
        .item_id
        .ok_or_else(|| CoreError::Invalid(format!("the create queued for {key} names no item")))
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

fn unsuited_type(r#type: &str, catalog: &Catalog) -> Option<String> {
    if crate::store::is_system(r#type) {
        return Some(format!(
            "{type} is written only through its own operation, never as a document"
        ));
    }
    if !catalog.known(r#type) {
        return Some(format!("{type} is not a type this copy holds"));
    }
    catalog
        .matches(FILE_TYPE, r#type)
        .then(|| format!("{type} is a file type, whose items are bytes rather than documents"))
}

/// What a document the folder has not bound would be created as.
pub(super) struct NewDocument {
    pub(super) draft: Draft,
    pub(super) read: fields::Read,
}

/// The draft a new document makes, or the hold the scan puts on it instead:
/// the type it names is one no document can be. The scan and the status make
/// it the same way, so the status says a file is held when the scan holds it.
pub(super) fn new_document(
    key: &str,
    document: &document::Document,
    (settings, catalog, edge_types): (&Settings, &Catalog, &EdgeTypes),
) -> std::result::Result<NewDocument, Flagged> {
    let mut read = fields::read(&document.front, edge_types).unwrap_or_default();
    let r#type = read
        .lines
        .r#type
        .clone()
        .unwrap_or_else(|| settings.new_type(catalog));
    if let Some(reason) = unsuited_type(&r#type, catalog) {
        return Err(Flagged::of(key, &format!("{}{reason}", state::REFUSED)));
    }
    let mut properties = std::mem::take(&mut read.properties);
    properties.insert(
        fields::body_field(catalog, &r#type).into(),
        Value::String(document.body.clone()),
    );
    for (field, value) in &settings.defaults.properties {
        properties.entry(field.clone()).or_insert(value.clone());
    }
    properties
        .entry(fields::title_field(catalog, &r#type))
        .or_insert(Value::String(title_of(key)));
    let draft = Draft {
        r#type,
        properties,
        tags: read
            .lines
            .tags
            .clone()
            .unwrap_or_else(|| settings.defaults.tags.clone()),
        tier: Some(read.lines.tier.unwrap_or_else(|| settings.new_tier())),
        occurred_at: read.lines.occurred_at.clone(),
        ..Default::default()
    };
    Ok(NewDocument { draft, read })
}

/// What the copy says of a draft before queueing it: the hold the scan puts
/// on a document the copy would refuse.
pub(super) fn admission_hold(catalog: &Catalog, key: &str, draft: &Draft) -> Option<Flagged> {
    match crate::check_create(catalog, draft) {
        Err(error) if local_admission_refusal(&error) => Some(Flagged::of(
            key,
            &format!("{LOCAL_ADMISSION_REFUSAL}{error}"),
        )),
        _ => None,
    }
}

impl Folder {
    /// Whether the file's item was made. A file naming a type no document
    /// can be is flagged instead; a default edge the copy refuses flags the
    /// file and leaves its item made and bound.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn queue_create(
        &self,
        file: &Scanned,
        (settings, embedded): (&Settings, bool),
        catalog: &Catalog,
        edge_types: &EdgeTypes,
        withheld: &placement::Withheld,
        work: &mut Vec<EdgeWork>,
        flagged: &mut Vec<Flagged>,
    ) -> Result<bool> {
        // An embedded file goes as its bytes' type whatever the query holds.
        let file_type = self
            .file_type_of(&file.path, settings, catalog)
            .or_else(|| embedded.then(|| bytes_type(&file.path, catalog)).flatten());
        if let Some(file_type) = file_type {
            self.queue_create_file(file, file_type, settings, catalog, withheld, flagged)?;
            return Ok(true);
        }
        let document = file.document();
        let NewDocument { draft, read } =
            match new_document(&file.key, &document, (settings, catalog, edge_types)) {
                Ok(made) => made,
                Err(held) => {
                    flagged.push(held);
                    return Ok(false);
                }
            };
        let created = match self.core.write_create(&draft, crate::Body::Folder) {
            Err(error) if local_admission_refusal(&error) => {
                flagged.push(Flagged::of(
                    &file.key,
                    &format!("{LOCAL_ADMISSION_REFUSAL}{error}"),
                ));
                return Ok(false);
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
        self.queue_default_edges(
            &file.key,
            &item_id,
            settings,
            Some((&document.front, edge_types)),
            flagged,
        )?;
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
        Ok(true)
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
        flagged: &mut Vec<Flagged>,
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
        let item_id = named_item(
            self.core.create_file_item_from(
                &file.path,
                file.source
                    .as_deref()
                    .ok_or_else(|| CoreError::Io("file not captured".into()))?,
                &draft,
            )?,
            &file.key,
        )?;
        self.queue_default_edges(&file.key, &item_id, settings, None, flagged)?;
        self.place(&item_id, &file.key, withheld)?;
        let kept = Kept {
            bytes: true,
            blob: file.source.as_deref().map(crate::blob::name_of),
            ..Kept::default()
        };
        self.bind_scanned(file, &item_id, Vec::new(), Vec::new(), kept)
    }

    /// The defaults' edges for a new item. A `parent-of` default names the
    /// parent, as the child's file writes it, so a new file lands beneath
    /// what the query follows. A type the file's own frontmatter writes a
    /// line for is no blank. One the copy refuses, as the server would, flags
    /// the file at `path` and leaves the rest queued.
    fn queue_default_edges(
        &self,
        path: &str,
        item_id: &str,
        settings: &Settings,
        front: Option<(&Map<String, Value>, &EdgeTypes)>,
        flagged: &mut Vec<Flagged>,
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
                match self.core.create_edge(&crate::model::EdgeDraft {
                    source_id,
                    target_id,
                    edge_type: edge_type.clone(),
                    ..Default::default()
                }) {
                    Err(error) if local_admission_refusal(&error) => flagged.push(Flagged::of(
                        path,
                        &format!("{LOCAL_ADMISSION_REFUSAL}{error}"),
                    )),
                    other => {
                        other?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Whole only where the file's version line is the copy's. `retitle` is
    /// the title a rename gives an item whose title line was not rewritten.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn queue_update(
        &self,
        item_id: &str,
        bound: Option<&state::Bound>,
        file: &Scanned,
        retitle: Option<&Retitle>,
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
        let named = bound.and_then(|bound| {
            self.named_title(
                bound,
                file,
                &document,
                fields::title_field(catalog, &held.r#type),
            )
        });
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
        // A title sent while the file's line was left as it was only keeps
        // that line from being sent as a title: while the line shows what it
        // did, it is no edit, whatever title the item holds now. A changed
        // line, or a pull, ends it, and the save is an ordinary one.
        let deferred = match retitle {
            Some(retitle) => document
                .front
                .get(&retitle.field)
                .filter(|shown| shown.as_str() != Some(retitle.title.as_str()))
                .map(|shown| state::DeferredTitle {
                    field: retitle.field.clone(),
                    shown: shown.clone(),
                }),
            None => bound
                .and_then(|bound| bound.writes.deferred_title.clone())
                .filter(|deferred| document.front.get(&deferred.field) == Some(&deferred.shown)),
        };
        if let Some(retitle) = retitle {
            properties.insert(retitle.field.clone(), Value::String(retitle.title.clone()));
        } else if let Some(deferred) = &deferred {
            // Left out, so the line sends nothing: the item's own title would
            // read as a change against the older version the file was read
            // at. A save that replaces every property keeps the item's.
            match held.properties.get(&deferred.field).filter(|_| whole) {
                Some(held) => properties.insert(deferred.field.clone(), held.clone()),
                None => properties.remove(&deferred.field),
            };
        }
        if whole {
            // No file can carry these, so leaving them out is no clear. A
            // `type` line holding no type identifier reads as the property,
            // and the person's word replaces the one an app set.
            for (field, value) in &held.properties {
                if !fields::carried(field, value, edge_types)? {
                    properties
                        .entry(field.clone())
                        .or_insert_with(|| value.clone());
                }
            }
        }
        if let Err(error) = crate::validation::property_names(&properties) {
            let held_for = format!("{LOCAL_ADMISSION_REFUSAL}{error}");
            flagged.push(Flagged::of(&file.key, &held_for));
            return self
                .bind_held(file, item_id, bound, held_for, named.as_ref())
                .map(|()| false);
        }
        let mut effective_properties = catalog.projected_properties(
            changes.r#type.as_deref().unwrap_or(&held.r#type),
            &properties,
            whole,
        );
        // An unchanged stored null is presentation, even though sending it
        // under replace would clear the property.
        for (field, value) in &properties {
            if value.is_null() && held.properties.get(field).is_some_and(Value::is_null) {
                effective_properties.insert(field.clone(), Value::Null);
            }
        }
        let unchanged = (!whole || effective_properties.len() == held.properties.len())
            && effective_properties.iter().all(|(field, value)| {
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
        writes.deferred_title = deferred;
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
                    .bind_held(file, item_id, bound, held_for, named.as_ref())
                    .map(|()| false);
            }
            // The tags are checked before the edit is queued, so a tag the
            // server would refuse leaves no write of the file half queued.
            // The server takes tag writes one at a time in queue order, which
            // queues a file's removals ahead of its adds, so its count is
            // checked as those writes will leave the item.
            let kept: HashSet<&str> = held
                .tags
                .iter()
                .map(String::as_str)
                .filter(|tag| !changes.removed.iter().any(|removed| removed == tag))
                .collect();
            let mut after = kept.clone();
            after.extend(changes.added.iter().map(String::as_str));
            if let Err(error) = crate::validation::tags(&changes.added)
                .and_then(|()| crate::validation::tag_count(kept.len(), after.len()))
            {
                let held_for = format!("{LOCAL_ADMISSION_REFUSAL}{error}");
                flagged.push(Flagged::of(&file.key, &held_for));
                return self
                    .bind_held(file, item_id, bound, held_for, named.as_ref())
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
                // The edges the file's lines no longer name go before a
                // retype, which the server holds to every edge still standing,
                // so taking out the line that blocks it works in one save.
                let mut removed: Vec<state::Line> = Vec::new();
                if changes.r#type.is_some() && bound.is_some() {
                    let mut ids = Vec::new();
                    let mut resolver = Resolver::new(&self.core, catalog, &BoundFiles);
                    // A line that cannot be read yet removes nothing, and the
                    // retype is judged with its edge standing.
                    let _ = self.queue_edges(
                        &self.edge_work(file, item_id, bound),
                        edge_types,
                        catalog,
                        &mut resolver,
                        &mut ids,
                        Some(&mut removed),
                    );
                    queued.extend(ids.into_iter().map(|id| (id, None)));
                }
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
                        // The removals stand: the file no longer names them.
                        let removing = bound.filter(|_| !queued.is_empty()).map(|bound| {
                            let mut kept = bound.clone();
                            kept.lines.retain(|line| !removed.contains(line));
                            kept.writes.save = save;
                            kept.writes.queued.extend(
                                queued
                                    .drain(..)
                                    .map(|(id, line)| state::Queued { id, save, line }),
                            );
                            kept
                        });
                        return self
                            .bind_held(
                                file,
                                item_id,
                                removing.as_ref().or(bound),
                                held_for,
                                named.as_ref(),
                            )
                            .map(|()| false);
                    }
                    other => other?.id,
                };
                queued.push((id, Some(file.line.unwrap_or(0))));
            }
            for tag in &changes.removed {
                queued.push((self.core.remove_tag(item_id, tag)?.id, None));
            }
            for tag in &changes.added {
                queued.push((self.core.add_tag(item_id, tag)?.id, None));
            }
            if let Some(state) = changes.state {
                queued.push((self.core.transition_item(item_id, state)?.id, None));
            }
        } else if let Some(retitle) = retitle {
            // Bytes already answered send nothing of their own, so the new
            // name's title goes alone, spending no version line.
            match self.queue_title(item_id, retitle, &retitle.title, file.line) {
                Err(error) if local_admission_refusal(&error) => {
                    let held_for = format!("{LOCAL_ADMISSION_REFUSAL}{error}");
                    flagged.push(Flagged::of(&file.key, &held_for));
                    return self
                        .bind_held(file, item_id, bound, held_for, named.as_ref())
                        .map(|()| false);
                }
                other => queued.extend(other?.map(|id| (id, None))),
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
                named,
                bytes: false,
                blob: bound.and_then(|bound| bound.blob.clone()),
            },
        )?;
        work.push(self.edge_work(file, item_id, bound));
        Ok(!in_step)
    }

    /// The title a person's rename of a document's file gives its item: the
    /// new name's stem, where the name changed and is not the one the title
    /// makes. The title is the line `shown` says, else the item's.
    pub(super) fn renamed_title(
        &self,
        item_id: &str,
        bound: &state::Bound,
        file: &Scanned,
        shown: Option<&document::Document>,
        catalog: &Catalog,
    ) -> Result<Option<Retitle>> {
        let name = name_of(&file.key);
        if !carries_frontmatter(Path::new(&file.key))
            || crate::names::same(name_of(&bound.path), name)
        {
            return Ok(None);
        }
        let Some(held) = self.core.get(item_id)? else {
            return Ok(None);
        };
        if bytes_of(&held, catalog).is_some() {
            return Ok(None);
        }
        let field = fields::title_field(catalog, &held.r#type);
        let title = match shown.and_then(|document| document.front.get(field)) {
            Some(line) => line.as_str(),
            None => held.properties.get(field).and_then(Value::as_str),
        };
        if title.is_some_and(|title| names::in_step(name, title)) {
            return Ok(None);
        }
        Ok(Some(Retitle {
            r#type: held.r#type.clone(),
            field: field.to_string(),
            title: title_of(&file.key),
            held: held.properties.get(field).cloned(),
            version: held.version,
        }))
    }

    /// The file as it is once its title line says the rename's title, every
    /// other byte kept. `None` where it shows no title line or the line says
    /// it already, its frontmatter cannot be edited in place, or it changed
    /// since the scan read it.
    pub(super) fn retitle_file(&self, file: &Scanned, retitle: &Retitle) -> Option<Scanned> {
        let document = file.document();
        let shown = document.front.get(&retitle.field)?;
        if shown.as_str() == Some(retitle.title.as_str()) {
            return None;
        }
        let mut front = document.front.clone();
        front.insert(retitle.field.clone(), Value::String(retitle.title.clone()));
        let text = document::write(&front, &document.body, Some(&document)).ok()?;
        let text = match file.text.strip_prefix(document::MARK) {
            Some(_) => format!("{}{text}", document::MARK),
            None => text,
        };
        let bytes = text.clone().into_bytes();
        self.land(
            &file.path,
            |written, _| std::io::Write::write_all(written, &bytes),
            |found| found.map(state::hash).as_deref() == Some(file.hash.as_str()),
        )
        .ok()?;
        let metadata = self.metadata(&file.path).ok();
        Some(Scanned {
            key: file.key.clone(),
            path: file.path.clone(),
            hash: state::hash(&bytes),
            mark: metadata
                .as_ref()
                .and_then(identity::of)
                .map(|found| found.key()),
            born: metadata.as_ref().and_then(identity::born),
            id: file.id.clone(),
            line: file.line,
            unreadable: None,
            deferred: false,
            source: Some(bytes),
            executable: file.executable,
            folded: file.folded,
            text,
        })
    }

    /// Queues `title` as an edit of the rename's title property alone, on the
    /// version the file last showed, `line`, unless the item holds it
    /// already. Answers the write's id.
    pub(super) fn queue_title(
        &self,
        item_id: &str,
        retitle: &Retitle,
        title: &str,
        line: Option<i64>,
    ) -> Result<Option<String>> {
        if retitle
            .held
            .as_ref()
            .is_some_and(|held| held.as_str() == Some(title))
        {
            return Ok(None);
        }
        let mut properties = Map::new();
        properties.insert(retitle.field.clone(), Value::String(title.into()));
        let read_at = line.filter(|line| *line < retitle.version);
        let edit = Edit {
            properties,
            base_version: Some(read_at.unwrap_or(retitle.version)),
            ..Edit::default()
        };
        let written = if read_at.is_some() {
            self.core
                .write_update(item_id, &edit, crate::Based::AsRead, crate::Body::Folder)?
        } else {
            self.core
                .write_update(item_id, &edit, crate::Based::OnHeld, crate::Body::Folder)?
        };
        Ok(Some(written.id))
    }

    /// The title a document's agreed presentation goes on showing where the
    /// person edited its title line away from the title its name was made
    /// from, so the pull renames the file once the new title is the item's.
    fn named_title(
        &self,
        bound: &state::Bound,
        file: &Scanned,
        document: &document::Document,
        field: &str,
    ) -> Option<(String, Option<Value>)> {
        if bound.path != file.key || !carries_frontmatter(Path::new(&file.key)) {
            return None;
        }
        let title = document.front.get(field)?.as_str()?;
        let was = bound.presentation.as_ref()?.front().get(field);
        let shown = match was {
            Some(Value::String(was)) => Some(was.as_str()),
            Some(Value::Null) | None => None,
            Some(_) => return None,
        };
        (shown != Some(title) && self.follows_title(&file.key, shown, title))
            .then(|| (field.to_string(), was.cloned()))
    }

    /// A move carries the new name as the title where the old name was it.
    pub(super) fn queue_update_file(
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
            self.core.update_file_item_from(
                &held.id,
                &file.path,
                file.source
                    .as_deref()
                    .ok_or_else(|| CoreError::Io("file not captured".into()))?,
                &edit,
                based,
            )?;
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
            bytes: true,
            blob: if bound.content_hash == file.hash {
                bound.blob.clone()
            } else {
                file.source.as_deref().map(crate::blob::name_of)
            },
            ..Kept::default()
        };
        self.bind_scanned(file, &held.id, Vec::new(), Vec::new(), kept)?;
        Ok(queued)
    }

    pub(super) fn bind_scanned(
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
                presentation: (file.unreadable.is_none() && !kept.bytes).then(|| {
                    let presentation = file.document().presentation();
                    match kept.named {
                        Some((field, title)) => presentation.with(&field, title),
                        None => presentation,
                    }
                }),
                blob: kept.blob,
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
            capture_latitude: None,
            capture_longitude: None,
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
}
