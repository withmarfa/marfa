//! Item writes: each is checked against the types the copy holds, then saved and
//! queued in one step.

use std::sync::MutexGuard;

use rusqlite::Connection;
use serde_json::Value;

use crate::catalog::CatalogExt;
use crate::edge_writes::refuse_self_loop;
#[cfg(debug_assertions)]
use crate::fault;
use crate::{
    Completeness, Core, CoreError, Draft, Edit, FOLDER_TYPE, Item, ItemState, QueuedWrite, Result,
    Seen, TagsWrite, Tier, WriteKind, body, catch_up, edge_rules, store,
};

/// The names a write carries held to the server's bounds before anything is
/// saved or queued, so the server's refusal is never the first anyone hears
/// of an empty tag, an unnamed property or a whole number a float would
/// change.
pub(crate) fn refuse_invalid_names(
    tags: &[String],
    properties: &serde_json::Map<String, Value>,
) -> Result<()> {
    marfa_rules::validation::tags(tags)?;
    marfa_rules::validation::property_names(properties)?;
    Ok(marfa_rules::integers::refuse_in_value(properties)?)
}

/// The server refuses a `system.*` write through the item operations to every
/// key (`items/system-types`), so one queued would show a change that never
/// lands until a drain says so.
pub(crate) fn refuse_system_type(r#type: &str) -> Result<()> {
    if !store::is_system(r#type) {
        return Ok(());
    }
    let door = if r#type == FOLDER_TYPE {
        ": a folder is written through the folder operations, `device folders create`, `change` and `revoke` on the command line"
    } else {
        ""
    };
    Err(CoreError::Forbidden {
        server: None,
        code: "type_not_permitted".into(),
        message: format!(
            "{type} is written only through its own operation, never as an item{door}"
        ),
    })
}

/// Whether the copy would take a new item made from `draft`, answered as
/// `write_create` would refuse it, with nothing queued or saved. A draft
/// naming a natural key is judged by the server, so it is not judged here.
/// Judged against the `catalog` the caller loaded, so a caller judging
/// many drafts keeps them to one revision.
pub(crate) fn check_create(catalog: &marfa_rules::catalog::Catalog, draft: &Draft) -> Result<()> {
    refuse_unmakeable_create(catalog, draft)?;
    if draft.source_id.is_none() {
        catalog.validate_properties(&draft.r#type, &draft.properties, true)?;
    }
    if catalog.request_limit().is_some() {
        // An id the queue mints is as long as this one.
        let id = draft.id.as_deref().unwrap_or(MINTED_ID_SHAPE);
        catalog.refuse_over_request_limit(&draft.payload(id)?)?;
    }
    Ok(())
}

const MINTED_ID_SHAPE: &str = "00000000-0000-7000-8000-000000000000";

/// What no copy could make an item of, whatever it holds: a name the server
/// would refuse, an id that is no id, a system type, or a type it does not hold.
fn refuse_unmakeable_create(catalog: &marfa_rules::catalog::Catalog, draft: &Draft) -> Result<()> {
    refuse_invalid_names(&draft.tags, &draft.properties)?;
    if let Some(id) = &draft.id {
        marfa_rules::validation::id("id", id)?;
    }
    refuse_system_type(&draft.r#type)?;
    if !catalog.known(&draft.r#type) {
        return Err(CoreError::UnknownType {
            server: None,
            message: format!("{} is not a type this copy holds", draft.r#type),
        });
    }
    // The states a type's lifecycle reaches from `active`: a `system.*` type
    // is refused above, and the rest reach every state but `revoked`
    // (`items/initial-state-refused`).
    if draft.state == Some(ItemState::Revoked) {
        return Err(CoreError::Validation {
            server: None,
            code: "validation_error".into(),
            message: format!(
                "{} cannot start in the revoked state; use active, archived or trashed",
                draft.r#type
            ),
            details: None,
        });
    }
    for (name, value) in [
        ("capture_latitude", draft.capture_latitude),
        ("capture_longitude", draft.capture_longitude),
    ] {
        if value.is_some_and(|value| !value.is_finite()) {
            return Err(CoreError::Validation {
                server: None,
                code: "validation_error".into(),
                message: format!("{name} must be a number"),
                details: None,
            });
        }
    }
    for (edge_type, targets) in &draft.edges {
        if edge_type.is_empty() {
            return Err(CoreError::NotFound {
                server: None,
                code: "edge_type_not_found".into(),
                message: "edges names an edge type with an empty id, which no edge type has".into(),
            });
        }
        for target in targets {
            marfa_rules::validation::id("edges", target)?;
            if draft.id.as_deref() == Some(target.as_str()) {
                refuse_self_loop(edge_type, target, target)?;
            }
        }
    }
    Ok(())
}

/// An id is minted here, where the draft names none, so a queued row is
/// readable locally before the server answers.
pub(crate) fn queue_create(
    tx: &Connection,
    catalog: &marfa_rules::catalog::Catalog,
    draft: &Draft,
    after: &[String],
    credential: Option<&str>,
) -> Result<QueuedWrite> {
    refuse_unmakeable_create(catalog, draft)?;
    // A key naming no source is under the credential's own
    // (`items/source-own`), as learned for the credential in use; where it
    // is not known, the tier is chosen here and the drain asks.
    let key_source = match &draft.source_id {
        Some(_) => store::source_of(tx, draft.source.as_deref(), credential)?,
        None => None,
    };
    let target = match (&key_source, &draft.source_id) {
        (Some(source), Some(source_id)) => store::item_under_key(tx, source, source_id)?,
        _ => None,
    };
    // The create lands on that row, under an ID the queue does not name.
    // Where the key's source is not known, it may be any row under the key.
    if let Some(held) = &target {
        store::refuse_removing(tx, &held.id)?;
    } else if let (None, Some(source_id)) = (&key_source, &draft.source_id) {
        for row in store::rows_under_key(tx, source_id, None, None)? {
            store::refuse_removing(tx, &row)?;
        }
    }
    let unresolved = target
        .as_ref()
        .map(|held| store::unanswered_keyed_create(tx, held))
        .transpose()?
        .unwrap_or(false);
    let current = target.as_ref().filter(|held| {
        !unresolved
            && held.r#type == draft.r#type
            && draft.base_version.is_none_or(|base| base == held.version)
    });
    let properties = if let Some(held) = current {
        let mut properties = held.properties.clone();
        properties.extend(catalog.projected_properties(&draft.r#type, &draft.properties, false));
        properties
    } else {
        draft.properties.clone()
    };
    // Landing on a held row, the create is an update of it, and a value it
    // sends back unchanged is not judged (`types/field-tightened-held`),
    // whether or not the copy can judge its merged result.
    let written = match target.as_ref().filter(|held| held.r#type == draft.r#type) {
        Some(held) => marfa_rules::conflict::changed(&draft.properties, &held.properties),
        None => draft.properties.clone(),
    };
    // A natural key may name a row outside this slice. Its required fields
    // and a stale upsert's merged result can only be judged by the server.
    catalog.validate_merged(
        &draft.r#type,
        &properties,
        current.is_some() || draft.source_id.is_none(),
        &written,
    )?;
    // A tier is chosen where none is named: left out, the server gives a new
    // row the key's default, and a row shown at one tier would come back at
    // another. Held and sent in the order the server answers, so the copy
    // shows one order before the answer and after it.
    let mut draft = draft.clone();
    draft.properties = catalog.in_answer_order(
        &draft.r#type,
        &catalog.created_properties(
            &draft.r#type,
            &catalog.coerced_properties(&draft.r#type, &draft.properties),
        ),
    );
    // A key naming a row the server answered sends no tier, since the server
    // leaves that row's tier as it stands (`items/tier-upsert`) and one sent
    // would move it. A key naming a create still waiting takes that create's
    // tier: if the create is refused, this one makes the row, and left out the
    // tier would be the credential's default. A key naming no row the copy
    // holds from the server may name one at a tier the slice leaves out, so
    // the drain asks the server before it sends the tier chosen here
    // (`queue-and-verdicts/keyed-create-lookup`).
    let keyed_tier = target.as_ref().and_then(|held| held.tier);
    let mut chosen = None;
    if draft.tier.is_none() && unresolved {
        draft.tier = keyed_tier;
        chosen = keyed_tier;
    }
    if draft.tier.is_none() && (unresolved || keyed_tier.is_none()) {
        let tier = match store::slice(tx)? {
            Some((_, tier)) => tier.create_tier(),
            // Nothing has named a tier yet, so the copy saves at the one an
            // app is reading unless it says otherwise.
            None if store::never_synced(tx)? => Tier::Library,
            None => return Err(CoreError::HydrationIncomplete),
        };
        draft.tier = Some(tier);
        chosen = Some(tier);
    }
    let chosen = chosen.filter(|_| draft.source_id.is_some());
    let draft = &draft;
    let shown_tier = draft.tier.or(keyed_tier);
    // An id minted here cannot be held by name, and with no natural key the
    // create cannot land on a held item, so a cut trash's hold on every item
    // does not refuse it.
    let fresh = draft.id.is_none() && draft.source_id.is_none();
    let enqueue = if fresh {
        store::enqueue_fresh
    } else {
        store::enqueue
    };
    let id = draft
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let from_id = target.as_ref().map_or(id.as_str(), |held| held.id.as_str());
    let inline: Vec<_> = draft
        .edges
        .iter()
        .flat_map(|(edge_type, targets)| {
            targets.iter().map(|to_id| edge_rules::Proposed {
                edge_type,
                from: edge_rules::FromEnd::Made {
                    id: from_id,
                    r#type: &draft.r#type,
                },
                to_id,
                replacing: None,
            })
        })
        .collect();
    edge_rules::refuse_unwritable_edges(tx, &inline)?;
    let payload = draft.payload(&id)?;
    catalog.refuse_over_request_limit(&payload)?;
    let mut row = draft.wire(&id);
    row.tier = shown_tier.map(|tier| tier.as_str().into());
    store::upsert_item(
        tx,
        &row,
        Some(&draft.tags),
        &catalog.indexing(&draft.r#type),
    )?;
    // Shown at once, as the edges of a write that waits, until the answer
    // brings the server's. The server makes the item and every edge or
    // none, so a refusal takes them out with the item.
    for edge in draft.projected_edges(&id, &row.updated_at) {
        store::upsert_edge(tx, &edge)?;
    }
    // The server needs each target before it can draw an edge to it.
    let mut depends_on = after.to_vec();
    for targets in draft.edges.values() {
        for target in targets {
            for waited in store::untaken_creates_for_item(tx, target)? {
                if !depends_on.contains(&waited) {
                    depends_on.push(waited);
                }
            }
        }
    }
    // The answer's echo would otherwise let go of a row the slice does not
    // hold, and a create shown as saved would vanish with nothing said.
    let declared = match store::slice(tx)? {
        Some((types, tier))
            if store::slice_takes(catalog, &types, tier, &row.r#type, shown_tier) =>
        {
            match store::slice_query(tx)? {
                Some(query) => crate::slice::judge_held(
                    tx,
                    catalog,
                    &query,
                    crate::slice::Reading::Holds,
                    crate::slice::Scope::default(),
                    &id,
                )?,
                None => true,
            }
        }
        _ => false,
    };
    if !declared {
        store::pin(tx, &id)?;
    }
    let queued = enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::CreateItem,
            item_id: Some(&id),
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: draft.base_version,
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    if let Some(tier) = chosen {
        store::choose_tier(tx, &queued.id, tier)?;
    }
    if let (Some(source), Some(source_id)) = (&key_source, &draft.source_id) {
        store::follow_row_under_key(tx, &queued, source, source_id)?;
    }
    // Queued in the same transaction, so a create never drops its tags.
    for tag in &draft.tags {
        let body = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        enqueue(
            tx,
            &store::NewWrite {
                kind: WriteKind::AddTag,
                item_id: Some(&id),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: Some(tag),
                blob: None,
                base_version: None,
                payload: &body,
                depends_on: std::slice::from_ref(&queued.id),
            },
        )?;
    }
    Ok(queued)
}

/// Whether a write reads the item's body as edges. A folder reads its own
/// files' bodies, and keeps its own record of what each showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Body {
    Read,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Based {
    OnHeld,
    /// The held version or an earlier one, which the server merges against.
    AsRead,
    /// The held version, which the server refuses `version_conflict` once
    /// the row has moved past it, rather than merging over another writer.
    Exact,
}

pub(crate) fn queue_update(
    tx: &Connection,
    catalog: &marfa_rules::catalog::Catalog,
    id: &str,
    edit: &Edit,
    after: &[String],
    based: Based,
) -> Result<QueuedWrite> {
    refuse_invalid_names(&[], &edit.properties)?;
    marfa_rules::validation::cleared_names(&edit.clear_properties, &edit.properties)?;
    let Some(held) = store::item_by_id(tx, id)? else {
        return Err(CoreError::NotFound {
            server: None,
            code: "item_not_found".into(),
            message: format!("{id} is not a row this copy holds"),
        });
    };
    refuse_system_type(&held.r#type)?;
    if let Some(r#type) = &edit.r#type {
        refuse_system_type(r#type)?;
    }
    let Some(base) = edit.base_version else {
        return Err(CoreError::Invalid(format!(
            "an update to {id} carries no version; name the version the edit was based on"
        )));
    };
    if edit.clear_occurred_at && edit.occurred_at.is_some() {
        return Err(CoreError::Invalid(
            "an edit sets the item's time or clears it, not both".into(),
        ));
    }
    // The server sets a row's creation time when its create lands, so while
    // the create is unsent the time is cleared by sending none: not in the
    // create, nor in an edit queued behind it, all in this transaction.
    let mut unsent_create = None;
    // A create already sent fixed the time it names, and its row's creation
    // time is the server's, unknown until the answer: the clear is carried
    // out once it comes (`device/edit-occurred-at-clear-sent`).
    let mut sent_create = None;
    let waiting = store::untaken_creates_for_item(tx, id)?;
    if edit.clear_occurred_at
        && let [create] = waiting.as_slice()
    {
        if store::unsent(tx, create)? {
            unsent_create = store::queued_write(tx, create)?;
        } else {
            sent_create = Some(create.clone());
        }
    }
    // A new time sent in an edit is the person's last word on it, so a clear
    // the create's answer would have to carry out is no longer owed. A create
    // already answered still owes it while its answer waits to be read.
    if edit.occurred_at.is_some() {
        store::forget_owed_time_clears(tx, id)?;
    }
    if let Some(create) = &sent_create {
        store::meta_set(tx, &store::cleared_time_key(create), "1")?;
    }
    if let Some(create) = &unsent_create {
        // Once the create lands on a row the server already holds, the clear
        // is kept nowhere else: the create no longer names a time, so the
        // held row's own time stands. A create with no natural key is
        // placed at its own creation time.
        let payload: Value = serde_json::from_str(&store::payload_of(tx, &create.id)?)?;
        if payload.get("source_id").is_some() {
            store::meta_set(tx, &store::cleared_time_key(&create.id), "1")?;
        }
    }
    if unsent_create.is_some() {
        for row in store::waiting_writes_for_item(tx, id)? {
            if !matches!(row.kind, WriteKind::CreateItem | WriteKind::UpdateItem)
                || !store::unsent(tx, &row.id)?
            {
                continue;
            }
            let mut body: Value = serde_json::from_str(&store::payload_of(tx, &row.id)?)?;
            if body
                .as_object_mut()
                .and_then(|body| body.remove("occurred_at"))
                .is_some()
            {
                store::set_unsent_payload(tx, &row.id, &body.to_string())?;
            }
        }
    }
    // An unchanged type or tier is not sent: the drain reads one in a sent
    // edit as a move, and lets the row go where its answer is outside the
    // slice.
    let edit = &Edit {
        r#type: edit.r#type.clone().filter(|r#type| *r#type != held.r#type),
        tier: edit.tier.filter(|tier| Some(*tier) != held.tier),
        properties: catalog.coerced_properties(
            edit.r#type.as_deref().unwrap_or(&held.r#type),
            &edit.properties,
        ),
        // The server holds no empty time: an item with none of its own
        // takes its creation time, which no write changes.
        occurred_at: match (edit.clear_occurred_at, &unsent_create, &sent_create) {
            (true, Some(_), _) | (true, _, Some(_)) => None,
            (true, None, None) => Some(held.created_at.clone()),
            (false, _, _) => edit.occurred_at.clone(),
        },
        clear_occurred_at: false,
        clear_properties: edit
            .clear_properties
            .iter()
            .enumerate()
            .filter(|(at, name)| !edit.clear_properties[..*at].contains(name))
            .map(|(_, name)| name.clone())
            .collect(),
        ..edit.clone()
    };
    if let Some(r#type) = edit.r#type.as_ref().filter(|r#type| !catalog.known(r#type)) {
        return Err(CoreError::UnknownType {
            server: None,
            message: format!("{type} is not a type this copy holds, so {id} cannot move to it"),
        });
    }
    let read_earlier = based == Based::AsRead && base > 0 && base <= held.version;
    if base != held.version && !read_earlier {
        return Err(CoreError::Invalid(format!(
            "the update to {id} is based on version {base} and this copy holds version {}; read it again",
            held.version
        )));
    }
    if let Some(r#type) = &edit.r#type {
        edge_rules::refuse_retype_breaking_edges(tx, id, r#type)?;
    }
    // Judged on any version: whatever the server holds by then, the field
    // ends up empty.
    let target = edit.r#type.as_deref().unwrap_or(&held.r#type);
    let required: Vec<String> = edit
        .clear_properties
        .iter()
        .filter(|name| catalog.requires(target, name))
        .map(|name| format!("{name}: Required"))
        .collect();
    if !required.is_empty() {
        return Err(CoreError::Validation {
            server: None,
            code: "invalid_properties".into(),
            message: required.join("; "),
            details: None,
        });
    }
    let mut payload = edit.payload(base)?;
    if based == Based::Exact {
        let mut body: Value = serde_json::from_str(&payload)?;
        if let Some(body) = body.as_object_mut() {
            body.insert("version_match".into(), Value::String("exact".into()));
        }
        payload = body.to_string();
    }
    catalog.refuse_over_request_limit(&payload)?;
    let projected = catalog.projected_properties(
        edit.r#type.as_deref().unwrap_or(&held.r#type),
        &edit.properties,
        edit.replace_properties,
    );
    // Recorded only where based on the held version: an edit based on an
    // earlier one was not made against the copy's row. A whole-properties
    // edit also changes every property it leaves out.
    let read = (base == held.version).then(|| {
        let cleared = held.properties.keys().filter(|_| edit.replace_properties);
        serde_json::json!({
            "properties": projected
                .keys()
                .chain(cleared)
                .chain(&edit.clear_properties)
                .map(|key| (key.clone(), held.properties.get(key).cloned().unwrap_or(Value::Null)))
                .collect::<serde_json::Map<String, Value>>(),
        })
    });
    let mut next = held.clone();
    // Only an edit that read the copy knows which properties it cleared.
    if edit.replace_properties && read.is_some() {
        next.properties = projected.clone();
    } else {
        for (key, value) in &projected {
            next.properties.insert(key.clone(), value.clone());
        }
    }
    for name in &edit.clear_properties {
        next.properties.shift_remove(name);
    }
    // The natural key moves on the copy too: the folder reads the copy to
    // answer "who holds this name", and the next file to take the old name
    // would otherwise base its create on this row, which the server resolves
    // as an upsert onto it.
    if let Some(source_id) = &edit.source_id {
        next.source_id = Some(source_id.clone());
    }
    if let Some(r#type) = &edit.r#type {
        next.r#type = r#type.clone();
    }
    if let Some(tier) = edit.tier {
        next.tier = Some(tier);
    }
    if let Some(occurred_at) = &edit.occurred_at {
        next.occurred_at = marfa_rules::time::projected(occurred_at);
    }
    // Shown as a create naming no time is shown until its answer.
    if let Some(create) = &unsent_create {
        next.occurred_at.clone_from(&create.queued_at);
        next.created_at.clone_from(&create.queued_at);
    }
    if sent_create.is_some() {
        next.occurred_at.clone_from(&held.created_at);
    }
    // A value is judged where the edit changes it, as the server judges it:
    // a synced file sends every property back, and a value its field no
    // longer admits stands through that. A move changes them all.
    let written = if next.r#type == held.r#type {
        marfa_rules::conflict::changed(&edit.properties, &held.properties)
    } else {
        next.properties.clone()
    };
    // Required nulls remain invalid even where replace projection drops
    // them. Stale edits cannot prove the server's eventual merged result.
    catalog.validate_merged(&next.r#type, &edit.properties, false, &written)?;
    if base == held.version && !store::unanswered_keyed_create(tx, &held)? {
        catalog.validate_merged(&next.r#type, &next.properties, true, &written)?;
    }
    store::hold_beneath_item(tx, id)?;
    store::upsert_item(tx, &next.as_wire(), None, &catalog.indexing(&next.r#type))?;
    // Only the row's untaken create, besides what the caller names: a write
    // held on every unanswered row would be refused with a sibling that
    // failed for its own reasons. Ordering behind earlier writes to the row
    // is recorded apart, by the queue.
    let mut depends_on = store::untaken_creates_for_item(tx, id)?;
    for waited in after {
        if !depends_on.contains(waited) {
            depends_on.push(waited.clone());
        }
    }
    let queued = store::enqueue(
        tx,
        &store::NewWrite {
            kind: WriteKind::UpdateItem,
            item_id: Some(id),
            to_id: None,
            edge_id: None,
            namespace: None,
            tag: None,
            blob: None,
            base_version: Some(base),
            payload: &payload,
            depends_on: &depends_on,
        },
    )?;
    if let Some(read) = &read {
        store::record_read(tx, &queued.id, read)?;
    }
    Ok(queued)
}

impl Core {
    /// The links and embeds in the item's body are queued as edges of their
    /// own, after it.
    pub fn create_item(&self, draft: &Draft) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        self.noting_limit_refusal(self.write_create(draft, Body::Read))
    }

    /// What the edit changes of the item's body's links and embeds is
    /// queued as edge writes of their own, after it.
    pub fn update_item(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        self.noting_limit_refusal(self.write_update(id, edit, Based::OnHeld, Body::Read))
    }

    /// The base may be a version earlier than the one held, which the server
    /// merges against, so another device's write that came in since is kept
    /// rather than overwritten.
    pub fn update_item_as_read(&self, id: &str, edit: &Edit) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        self.noting_limit_refusal(self.write_update(id, edit, Based::AsRead, Body::Read))
    }

    /// Outside the write's transaction, which the refusal rolled back. A
    /// folder's scan keeps a mark of its own for the file it holds.
    fn noting_limit_refusal(&self, written: Result<QueuedWrite>) -> Result<QueuedWrite> {
        if matches!(&written, Err(CoreError::Validation { code, .. })
            if code == crate::model::OVER_REQUEST_LIMIT)
        {
            store::note_limit_refused(&*self.conn()?)?;
        }
        written
    }

    pub(crate) fn write_create(&self, draft: &Draft, body: Body) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        let tx = conn.transaction()?;
        let catalog = crate::catalog::load(&tx)?;
        let queued = queue_create(&tx, &catalog, draft, &[], self.credential().as_deref())?;
        if body == Body::Read
            && let Some(item) = queued
                .item_id
                .as_deref()
                .map(|id| store::item_by_id(&tx, id))
                .transpose()?
                .flatten()
        {
            if completeness == Completeness::Complete {
                body::rule::derive(&tx, &catalog, "", &item, &queued.id)?;
            } else {
                body::rule::derive_on_answer(&tx, &item.id, "", &queued.id)?;
            }
        }
        tx.commit()?;
        Ok(queued)
    }

    /// Destroys a row in the bin on the server at once, and takes it, its edges
    /// and its pin out of the copy once the server accepts it (the device
    /// chapter's section "Purging"). Never queued. Sent at `version`, the
    /// version the caller was shown, or else the version the copy holds;
    /// refused, before anything is sent, `Validation` with `item_being_removed`
    /// while a trash or another purge holds the row, `NotFound` with
    /// `not_held` for a row the copy does not hold where no version is named,
    /// `Validation` with `invalid_transition` for one the copy shows outside
    /// the bin, and `Invalid` while a write to it waits, including a create
    /// under its natural key; then `NoServer` for a copy with no
    /// server. The root confirms the copy's instance first, which expires the
    /// copy where another answers. Otherwise it is refused with what the server
    /// or the network answered, the copy and the queue as they were:
    /// `version_conflict` for a row that moved since it was read. A `Network`
    /// failure after the request went out may follow a purge the server made,
    /// which its `item.purged` event then shows.
    pub fn purge_item(&self, id: &str, version: Option<i64>) -> Result<()> {
        self.lock.refuse_unless_writer()?;
        let (version, _held) = {
            let conn = self.conn()?;
            store::refuse_unless_usable(&conn)?;
            let held = self.hold_removing(&conn, vec![id.to_string()], store::Removing::Purge)?;
            let item = store::items_by_ids(&conn, &[id.to_string()])?.pop();
            if let Some(item) = &item
                && item.state != ItemState::Trashed
            {
                return Err(CoreError::Validation {
                    server: None,
                    code: "invalid_transition".into(),
                    message: format!(
                        "{id} is {}, not in the bin, in this working copy; only a row in the bin can be purged",
                        item.state.as_str()
                    ),
                    details: None,
                });
            }
            let mut waiting = store::waiting_writes_for_item(&conn, id)?;
            waiting.extend(store::waiting_writes_reaching_item(&conn, id)?);
            if !waiting.is_empty() {
                drop(conn);
                return Err(CoreError::Invalid(format!(
                    "{id} has {} write(s) still waiting to be sent, which would go to a row that is gone; clear each before purging it, by the command named for it: {}",
                    waiting.len(),
                    self.exits_of(&waiting)?
                )));
            }
            let Some(version) = version.or(item.as_ref().map(|item| item.version)) else {
                return Err(CoreError::not_held(format!(
                    "{id} is not held in this working copy; name the version it was read at in the bin to purge it"
                )));
            };
            (version, held)
        };
        let http = self.http()?;
        catch_up::refuse_another_instance(self, http)?;
        self.purge_sent(id, || {
            catch_up::write_naming_instance(self, http, |http| http.purge_item(id, version))
        })
    }

    pub(crate) fn write_update(
        &self,
        id: &str,
        edit: &Edit,
        based: Based,
        body: Body,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        let tx = conn.transaction()?;
        let catalog = crate::catalog::load(&tx)?;
        let before = store::item_by_id(&tx, id)?;
        if !store::item_held(&tx, id)? {
            store::refuse_unless_held(completeness)?;
        }
        #[cfg(debug_assertions)]
        fault::gate("gate-local-update");
        let queued = queue_update(&tx, &catalog, id, edit, &[], based)?;
        if body == Body::Read
            && let Some(before) = before
            && let Some(after) = store::item_by_id(&tx, id)?
        {
            let old = body::rule::body_of(&catalog, &before).to_string();
            if completeness != Completeness::Complete
                || edit.base_version.is_some_and(|base| base < before.version)
            {
                body::rule::derive_on_answer(&tx, id, &old, &queued.id)?;
            } else {
                body::rule::derive(&tx, &catalog, &old, &after, &queued.id)?;
            }
        }
        tx.commit()?;
        Ok(queued)
    }

    /// Not a purge: the row stays in the copy, trashed.
    pub fn delete_item(&self, id: &str) -> Result<QueuedWrite> {
        self.transition_locally(id, WriteKind::DeleteItem, ItemState::Trashed, "{}")
    }

    /// An item and the edges at it as the copy holds them, for a decision
    /// about the item to be checked against when it is carried out. `None`
    /// where the copy holds no such row.
    pub(crate) fn seen(&self, id: &str) -> Result<Option<Seen>> {
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        Seen::of(&conn, id)
    }

    /// The same, only while the copy still holds what `seen` read of the
    /// item, checked under the lock that queues the delete, so a change heard
    /// after the caller decided, a tag or an edge included, is never trashed
    /// with it. `None`, with nothing queued, where the row has moved on or
    /// gone.
    pub(crate) fn delete_item_at(&self, id: &str, seen: &Seen) -> Result<Option<QueuedWrite>> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        store::refuse_unless_usable(&conn)?;
        match Seen::of(&conn, id)? {
            Some(now) if now == *seen => self
                .transition_held(
                    conn,
                    now.item,
                    WriteKind::DeleteItem,
                    ItemState::Trashed,
                    "{}",
                )
                .map(Some),
            _ => Ok(None),
        }
    }

    /// A row the copy does not hold, such as one read from the bin, is
    /// restored by id: queued, shown nowhere until the server answers, and
    /// held once the answer's read or its `item.restored` event brings it
    /// where the slice takes it (`queue-and-verdicts/restore-by-id`, `queue-and-verdicts/restore-not-entered` and `queue-and-verdicts/restore-once`).
    pub fn restore_item(&self, id: &str) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        // Looked at and queued under one lock, so a row a held stream brings
        // in meanwhile is restored as a held row is.
        let tx = conn.transaction()?;
        if !store::items_by_ids(&tx, &[id.to_string()])?.is_empty() {
            drop(tx);
            drop(conn);
            return self.transition_locally(id, WriteKind::RestoreItem, ItemState::Active, "{}");
        }
        store::refuse_unless_held(completeness)?;
        if store::waiting_writes_for_item(&tx, id)?
            .iter()
            .any(|row| row.kind == WriteKind::RestoreItem)
        {
            return Err(CoreError::Invalid(format!(
                "a restore of {id} already waits to be sent"
            )));
        }
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind: WriteKind::RestoreItem,
                item_id: Some(id),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: None,
                payload: "{}",
                depends_on: &[],
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Only the server can move an item to `revoked`.
    pub fn transition_item(&self, id: &str, state: ItemState) -> Result<QueuedWrite> {
        if state == ItemState::Revoked {
            return Err(CoreError::Validation {
                server: None,
                code: "validation_error".into(),
                message: format!(
                    "state: a device cannot move {id} to the revoked state; it is reachable only on a reserved type and on the server's authority"
                ),
                details: None,
            });
        }
        let payload = serde_json::to_string(&serde_json::json!({ "state": state.as_str() }))?;
        self.transition_locally(id, WriteKind::TransitionItem, state, &payload)
    }

    fn transition_locally(
        &self,
        id: &str,
        kind: WriteKind,
        state: ItemState,
        payload: &str,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        let Some(held) = store::items_by_ids(&conn, &[id.to_string()])?.pop() else {
            store::refuse_unless_held(completeness)?;
            return Err(CoreError::NotFound {
                server: None,
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        };
        self.transition_held(conn, held, kind, state, payload)
    }

    /// Under the lock `conn` holds since `held` was read, so the write is
    /// queued against the row as read.
    fn transition_held(
        &self,
        mut conn: MutexGuard<'_, Connection>,
        held: Item,
        kind: WriteKind,
        state: ItemState,
        payload: &str,
    ) -> Result<QueuedWrite> {
        let id = held.id.as_str();
        refuse_system_type(&held.r#type)?;
        let deleting = kind == WriteKind::DeleteItem;
        let versioned = serde_json::json!({ "version": held.version }).to_string();
        let payload = if deleting {
            versioned.as_str()
        } else {
            payload
        };
        // Only the create, for the reason `queue_update` gives.
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        store::hold_beneath_item(&tx, id)?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag: None,
                blob: None,
                base_version: deleting.then_some(held.version),
                payload,
                depends_on: &depends_on,
            },
        )?;
        // Stamped with the write's own time, which a re-lay over a row the
        // server sends while it waits takes again.
        store::set_item_state(&tx, id, state, &queued.queued_at)?;
        if deleting {
            store::record_read(&tx, &queued.id, &serde_json::to_value(&held)?)?;
        }
        tx.commit()?;
        Ok(queued)
    }

    pub fn add_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        let payload = serde_json::to_string(&serde_json::json!({ "tags": [tag] }))?;
        let tags = [tag.to_string()];
        self.tag_write(id, WriteKind::AddTag, Some(tag), &tags, &payload, |tx| {
            store::add_tags(tx, id, &tags)
        })
    }

    /// A removal is not held to the bound on a tag's name: an archive restore
    /// writes tags as recorded, so a row can hold one the bound refuses and
    /// must still be able to shed it.
    pub fn remove_tag(&self, id: &str, tag: &str) -> Result<QueuedWrite> {
        self.tag_write(id, WriteKind::RemoveTag, Some(tag), &[], "{}", |tx| {
            store::remove_tag(tx, id, tag)
        })
    }

    /// `admitted` are the tags the write adds, each held to the server's
    /// bound before anything is saved or queued.
    fn tag_write(
        &self,
        id: &str,
        kind: WriteKind,
        tag: Option<&str>,
        admitted: &[String],
        payload: &str,
        apply: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<()>,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        marfa_rules::validation::tags(admitted)?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        if !store::item_held(&conn, id)? {
            store::refuse_unless_held(completeness)?;
            return Err(CoreError::NotFound {
                server: None,
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        store::hold_beneath_item(&tx, id)?;
        let before = store::tag_count(&tx, id)?;
        apply(&tx)?;
        marfa_rules::validation::tag_count(before, store::tag_count(&tx, id)?)?;
        // The index holds a row's tags, so a tag changed here is changed there.
        store::reindex_item(&tx, id)?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                to_id: None,
                edge_id: None,
                namespace: None,
                tag,
                blob: None,
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }

    /// Only the tags land locally; an extension namespace is not part of the
    /// copy and is its own write.
    pub fn replace_tags(&self, id: &str, write: &TagsWrite) -> Result<QueuedWrite> {
        let payload = write.payload()?;
        self.tag_write(
            id,
            WriteKind::ReplaceTags,
            None,
            &write.tags,
            &payload,
            |tx| store::replace_tags(tx, id, &write.tags),
        )
    }

    /// Queued and not applied: the copy holds no extension namespaces.
    pub fn write_extension(&self, id: &str, namespace: &str, body: &str) -> Result<QueuedWrite> {
        self.extension_write(id, namespace, WriteKind::WriteExtension, body)
    }

    pub fn delete_extension(&self, id: &str, namespace: &str) -> Result<QueuedWrite> {
        self.extension_write(id, namespace, WriteKind::DeleteExtension, "{}")
    }

    fn extension_write(
        &self,
        id: &str,
        namespace: &str,
        kind: WriteKind,
        payload: &str,
    ) -> Result<QueuedWrite> {
        self.lock.refuse_unless_writer()?;
        let mut conn = self.conn()?;
        let completeness = store::refuse_unless_writable(&conn)?;
        if namespace.is_empty() {
            return Err(CoreError::Invalid(
                "an extension write names no namespace, and the namespace is where it goes".into(),
            ));
        }
        if kind == WriteKind::WriteExtension {
            marfa_rules::integers::refuse_inexact_integers(payload)?;
        }
        if !store::item_held(&conn, id)? {
            store::refuse_unless_held(completeness)?;
            return Err(CoreError::NotFound {
                server: None,
                code: "item_not_found".into(),
                message: format!("{id} is not a row this copy holds"),
            });
        }
        let depends_on = store::untaken_creates_for_item(&conn, id)?;
        let tx = conn.transaction()?;
        let queued = store::enqueue(
            &tx,
            &store::NewWrite {
                kind,
                item_id: Some(id),
                to_id: None,
                edge_id: None,
                namespace: Some(namespace),
                tag: None,
                blob: None,
                base_version: None,
                payload,
                depends_on: &depends_on,
            },
        )?;
        tx.commit()?;
        Ok(queued)
    }
}
