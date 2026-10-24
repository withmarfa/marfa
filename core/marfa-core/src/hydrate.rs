use std::collections::HashMap;
use std::io::BufReader;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::catalog::Catalog;
use crate::error::CoreError;
use crate::http::{Http, ItemsQuery, Registration, Replacement};
use crate::model::{
    Draft, EdgeDraft, HydrateReport, HydrateRestart, SliceTier, Tier, UnregisteredType, WriteKind,
};
use crate::sse::{Frame, Frames};
use crate::store;
use crate::wire::{WireCatalog, WireEdge, WireEdgeBlock, WireItemWithMetadata};
use crate::{Core, Result};

const HEAD_ATTEMPTS: usize = 3;
const HEAD_READ_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) fn hydrate(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: SliceTier,
    edge_types: &[String],
    stop: &AtomicBool,
) -> Result<HydrateReport> {
    let result = hydrate_inner(core, http, types, tier, edge_types, stop);
    crate::catch_up::unless_stopped(result, stop)
}

fn hydrate_inner(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: SliceTier,
    edge_types: &[String],
    stop: &AtomicBool,
) -> Result<HydrateReport> {
    let types = declared_types(types)?;
    let edge_types = declared_edge_types(edge_types)?;
    let mut restart = None;
    let mut pages = 0;
    loop {
        let before = crate::reach::Before::capture(&*core.conn()?)?;
        match attempt(
            core,
            http,
            &types,
            tier,
            &edge_types,
            restart,
            &mut pages,
            stop,
        )
        .map_err(|error| before.failed(core, error).unwrap_or_else(|error| error))?
        {
            Attempt::Done(report) => return Ok(*report),
            // Only an attempt that would resume asks to start again, and one
            // that starts again never resumes, so this goes round at most
            // twice.
            Attempt::Again(reason) => restart = Some(reason),
        }
    }
}

enum Attempt {
    Done(Box<HydrateReport>),
    Again(HydrateRestart),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Items,
    Edges,
    Pins,
    Replay,
}

/// Where a hydration has reached, kept in `store::META_HYDRATE_RESUME` in the
/// transaction of each page it commits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Reached {
    phase: Phase,
    /// The declared type, `store::EVERY_TYPE` for the listing naming none, or
    /// the edge type, whose listing is walked next.
    listing: Option<String>,
    /// The page cursor to send next, `None` for the listing's first page.
    cursor: Option<String>,
    pages: u64,
}

impl Reached {
    fn first(types: &[String], edge_types: &[String]) -> Self {
        Self::after_items(types, edge_types, 0, 0)
    }

    /// The first page of the listing at `index` of `types`, or of what
    /// follows the item listings.
    fn after_items(types: &[String], edge_types: &[String], index: usize, pages: u64) -> Self {
        match types.get(index) {
            Some(listing) => Reached {
                phase: Phase::Items,
                listing: Some(listing.clone()),
                cursor: None,
                pages,
            },
            None => Self::after_edges(edge_types, 0, pages),
        }
    }

    fn after_edges(edge_types: &[String], index: usize, pages: u64) -> Self {
        match edge_types.get(index) {
            Some(listing) => Reached {
                phase: Phase::Edges,
                listing: Some(listing.clone()),
                cursor: None,
                pages,
            },
            None => Reached {
                phase: Phase::Pins,
                listing: None,
                cursor: None,
                pages,
            },
        }
    }

    fn at(phase: Phase, pages: u64) -> Self {
        Reached {
            phase,
            listing: None,
            cursor: None,
            pages,
        }
    }

    /// The index of the item listing to walk next, and of the edge listing,
    /// each past its end where the walk has gone beyond it. `None` where the
    /// listing it names is not one the slice walks.
    fn indices(&self, types: &[String], edge_types: &[String]) -> Option<(usize, usize)> {
        let position = |listings: &[String]| {
            let named = self.listing.as_deref()?;
            listings.iter().position(|listing| listing == named)
        };
        match self.phase {
            Phase::Items => Some((position(types)?, 0)),
            Phase::Edges => Some((types.len(), position(edge_types)?)),
            Phase::Pins | Phase::Replay => Some((types.len(), edge_types.len())),
        }
    }

    fn keep(&self, conn: &rusqlite::Connection) -> Result<()> {
        store::meta_set(
            conn,
            store::META_HYDRATE_RESUME,
            &serde_json::to_string(self)?,
        )
    }
}

enum Start {
    Fresh(Option<HydrateRestart>),
    Resume(Reached),
    /// Start again from the first page, under a head and catalog read again:
    /// the ones read for this attempt are of a reach that has gone.
    Reread(HydrateRestart),
}

/// One walk of the slice, adding each listing page it reads to `pages`,
/// which counts every page of the call.
#[allow(clippy::too_many_arguments)]
fn attempt(
    core: &Core,
    http: &Http,
    types: &[String],
    tier: SliceTier,
    edge_types: &[String],
    restart: Option<HydrateRestart>,
    pages: &mut u64,
    stop: &AtomicBool,
) -> Result<Attempt> {
    // Nothing is cleared until the copy is about to be replaced, so a stop
    // raised before then leaves it as it was.
    crate::catch_up::refuse_if_stopped(stop)?;
    let (mut instance, mut cursor, mut fence) = read_head(http, stop)?;
    let mut ended = expire_if_built_elsewhere(core, &instance, &fence)?;
    let mut under_reach = http.for_reach(&fence);
    crate::catch_up::refuse_if_stopped(stop)?;
    let mut catalog_rows = under_reach.catalog()?;
    let declared = declare_on_instance(core, &under_reach, &catalog_rows, stop)?;
    if declared.changed {
        // A registration or a replacement changes what the instance's reach certifies, so
        // the head and the catalog read before it are of a reach that has gone.
        (instance, cursor, fence) = read_head(http, stop)?;
        ended = ended.or(expire_if_built_elsewhere(core, &instance, &fence)?);
        under_reach = http.for_reach(&fence);
        catalog_rows = under_reach.catalog()?;
    }
    let plain = http;
    let http = &under_reach;
    refuse_unheld(&catalog_rows, types, edge_types)?;
    let start = match restart.or(ended) {
        Some(reason) => Start::Fresh(Some(reason)),
        None => resume_point(core, http, &instance, &fence, types, tier, edge_types, stop)?,
    };
    let (reached, restarted) = match start {
        Start::Reread(reason) => return Ok(Attempt::Again(reason)),
        // Rows already taken were indexed by the catalog the copy holds, and
        // a resumed walk would index the rest by another.
        Start::Resume(_) if catalog_differs(core, &catalog_rows)? => {
            (None, Some(HydrateRestart::CatalogChanged))
        }
        Start::Resume(reached) => (Some(reached), None),
        Start::Fresh(reason) => (None, reason),
    };
    // The key it reads names the source a write naming none is stamped with
    // (`items/source-own`), so a copy's first such create finds the row it
    // holds under it. A resume carries on under the reach its walk was
    // allowed under, so it asks no first page again.
    if let Some(source) = refuse_unreadable(http, types, tier, &catalog_rows, reached.is_none())? {
        store::learn_source(
            &*core.conn()?,
            &store::credential_digest(&http.authorization()),
            source.as_deref(),
        )?;
    }
    crate::catch_up::refuse_if_stopped(stop)?;
    if reached.is_some() {
        let mut conn = core.conn()?;
        let tx = conn.transaction()?;
        crate::reach::advance_generation(&tx)?;
        store::meta_set(&tx, store::META_SERVER_ORIGIN, &http.origin())?;
        tx.commit()?;
    }
    let resumed = reached.is_some();
    let reached = match reached {
        Some(reached) => reached,
        None => {
            let counts = counted(plain, types, tier);
            crate::catch_up::refuse_if_stopped(stop)?;
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            // A copy whose cursor aged out is filled again over what it holds
            // when the instance, the reach and the slice are those it was
            // built under; anything else may hold rows the key no longer
            // reads, so it is cleared first.
            // A log that ends before the head the refill began from, or
            // before the cursor the copy held when it went stale, is a server
            // restored to an earlier point, whose rows the later versions held
            // would refuse.
            let in_place = restarted != Some(HydrateRestart::HeadPastLog)
                && store::refill(&tx)?.is_some_and(|refill| {
                    refill.instance == instance
                        && refill.reach == fence
                        && not_behind(&cursor, &refill.cursor)
                })
                && store::meta_get(&tx, store::META_SLICE_TYPES)?
                    == Some(serde_json::to_string(types)?)
                && store::meta_get(&tx, store::META_SLICE_TIER)?.as_deref() == Some(tier.as_str())
                && store::whole_edge_types(&tx)? == edge_types;
            crate::reach::advance_generation(&tx)?;
            store::meta_set(&tx, store::META_HYDRATE_STATE, store::HYDRATE_IN_PROGRESS)?;
            store::attachments_start_growing(&tx)?;
            store::meta_set(&tx, store::META_EVENT_CURSOR, &cursor)?;
            store::meta_set(&tx, crate::reach::FENCE, &fence)?;
            store::meta_set(&tx, store::META_INSTANCE_ID, &instance)?;
            store::meta_set(&tx, store::META_SERVER_ORIGIN, &http.origin())?;
            store::meta_set(&tx, store::META_SLICE_TYPES, &serde_json::to_string(types)?)?;
            store::meta_set(&tx, store::META_SLICE_TIER, tier.as_str())?;
            store::meta_set(
                &tx,
                store::META_SLICE_EDGE_TYPES,
                &serde_json::to_string(edge_types)?,
            )?;
            crate::body::rule::before_rebuild(&tx)?;
            if in_place {
                store::start_refill(&tx)?;
            } else {
                store::meta_delete(&tx, store::META_REFILL)?;
                store::clear_slice(&tx)?;
            }
            store::replace_catalog(&tx, &catalog_rows)?;
            // A copy filling up answers reads, so it shows what is waiting
            // from the start, as each row that arrives does.
            lay_queue_over(
                &tx,
                &Catalog::load(&tx)?,
                edge_types,
                Some(&store::credential_digest(&http.authorization())),
            )?;
            match &counts {
                Some(counts) => store::meta_set(
                    &tx,
                    store::META_ITEMS_EXPECTED,
                    &expected(&Catalog::load(&tx)?, types, counts).to_string(),
                )?,
                None => store::meta_delete(&tx, store::META_ITEMS_EXPECTED)?,
            }
            store::meta_set(&tx, store::META_ITEMS_LISTED, "0")?;
            let first = Reached::first(types, edge_types);
            first.keep(&tx)?;
            tx.commit()?;
            // A drain waiting on the store would otherwise wait out the hold
            // too, and never see that the copy it read has been replaced.
            drop(conn);
            #[cfg(debug_assertions)]
            crate::fault::hold(|| "hydration-replacing");
            first
        }
    };
    let (context, in_place) = {
        let conn = core.conn()?;
        (
            crate::reach::Context::capture_build(&conn)?,
            store::refilling(&conn)?,
        )
    };
    let result = (|| {
        let catalog = {
            let conn = core.conn()?;
            Catalog::load(&conn)?
        };
        let Some((item_from, edge_from)) = reached.indices(types, edge_types) else {
            return Ok(Attempt::Again(HydrateRestart::SliceChanged));
        };
        let mut pages_total = reached.pages;

        for (index, declared) in types.iter().enumerate().skip(item_from) {
            let listing = (declared != store::EVERY_TYPE).then_some(declared.as_str());
            let mut page_cursor = if index == item_from {
                reached.cursor.clone()
            } else {
                None
            };
            // Only a cursor an earlier call kept can be one the server has
            // since stopped taking.
            let mut kept = resumed && page_cursor.is_some();
            let mut seen: std::collections::HashSet<String> = page_cursor.iter().cloned().collect();
            loop {
                crate::catch_up::refuse_if_stopped(stop)?;
                let page = match http.items_page(&ItemsQuery {
                    r#type: listing,
                    tier: listed_tier(listing, tier),
                    cursor: page_cursor.as_deref(),
                }) {
                    Err(CoreError::Validation { .. }) if kept => {
                        return Ok(Attempt::Again(HydrateRestart::CursorRefused));
                    }
                    page => page?,
                };
                kept = false;
                *pages += 1;
                pages_total += 1;
                let mut overflow: Vec<WireEdge> = Vec::new();
                for row in &page.data {
                    if let Some(blocks) = &row.item.edges {
                        for (edge_type, block) in blocks {
                            overflow.extend(fetch_overflow(http, &row.item.id, edge_type, block)?);
                        }
                    }
                }
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                context.check(&tx)?;
                // The expected count is of the slice's listings, so pinned
                // rows and queued creates, which `items` also counts, stay out
                // of this one. A row two listings bring counts once.
                let mut listed: u64 = store::meta_get(&tx, store::META_ITEMS_LISTED)?
                    .and_then(|count| count.parse().ok())
                    .unwrap_or(0);
                for row in &page.data {
                    if !crate::reach::answered(&tx, &row.item.id)? {
                        listed += 1;
                    }
                    crate::reach::set_listed(
                        &tx,
                        &row.item.id,
                        row.listed.ok_or_else(crate::reach::invalid)?,
                    )?;
                    store::take_server_item(&tx, &row.item, Some(&row.metadata.tags), &catalog)?;
                    for block in row.item.edges.iter().flat_map(|blocks| blocks.values()) {
                        for edge in &block.data {
                            store::put_server_edge(&tx, edge)?;
                        }
                    }
                }
                for edge in &overflow {
                    store::put_server_edge(&tx, edge)?;
                }
                store::meta_set(&tx, store::META_ITEMS_LISTED, &listed.to_string())?;
                // A server can report more while handing back the same cursor;
                // without this check a hydration spins forever.
                if let Some(next) = &page.next_cursor
                    && !seen.insert(next.clone())
                {
                    return Err(crate::reach::invalid());
                }
                match &page.next_cursor {
                    Some(next) => Reached {
                        phase: Phase::Items,
                        listing: Some(declared.clone()),
                        cursor: Some(next.clone()),
                        pages: pages_total,
                    },
                    None => Reached::after_items(types, edge_types, index + 1, pages_total),
                }
                .keep(&tx)?;
                tx.commit()?;
                let Some(next) = page.next_cursor else {
                    break;
                };
                page_cursor = Some(next);
            }
        }

        for (index, edge_type) in edge_types.iter().enumerate().skip(edge_from) {
            let mut page_cursor = if index == edge_from && reached.phase == Phase::Edges {
                reached.cursor.clone()
            } else {
                None
            };
            let mut kept = resumed && page_cursor.is_some();
            let mut seen: std::collections::HashSet<String> = page_cursor.iter().cloned().collect();
            loop {
                crate::catch_up::refuse_if_stopped(stop)?;
                let page = match http.edges_page(edge_type, page_cursor.as_deref()) {
                    Err(CoreError::Validation { .. }) if kept => {
                        return Ok(Attempt::Again(HydrateRestart::CursorRefused));
                    }
                    page => page?,
                };
                kept = false;
                *pages += 1;
                pages_total += 1;
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                context.check(&tx)?;
                for edge in &page.data {
                    store::put_server_edge(&tx, edge)?;
                }
                // Rows the key cannot read leave a page short or empty, not last.
                if let Some(next) = &page.next_cursor
                    && !seen.insert(next.clone())
                {
                    return Err(crate::reach::invalid());
                }
                match &page.next_cursor {
                    Some(next) => Reached {
                        phase: Phase::Edges,
                        listing: Some(edge_type.clone()),
                        cursor: Some(next.clone()),
                        pages: pages_total,
                    },
                    None => Reached::after_edges(edge_types, index + 1, pages_total),
                }
                .keep(&tx)?;
                tx.commit()?;
                let Some(next) = page.next_cursor else {
                    break;
                };
                page_cursor = Some(next);
            }
        }

        if reached.phase != Phase::Replay {
            // A pin the answer leaves out names no row the key may read
            // outside the bin, and stays without one (`device/pin-gone-kept`).
            // A pin the queue alone holds is a create whose answer may have
            // been lost after the server took it, so only a row the listings
            // brought is skipped.
            let pinned: Vec<String> = {
                let conn = core.conn()?;
                let mut unheld = Vec::new();
                for id in store::pins(&conn)? {
                    if !crate::reach::answered(&conn, &id)? {
                        unheld.push(id);
                    }
                }
                unheld
            };
            for ids in pinned.chunks(crate::http::BULK_GET_LIMIT) {
                crate::catch_up::refuse_if_stopped(stop)?;
                let rows = http.items_by_id(ids)?;
                let mut overflow: Vec<WireEdge> = Vec::new();
                for row in &rows {
                    for (edge_type, block) in row.item.edges.iter().flatten() {
                        overflow.extend(fetch_overflow(http, &row.item.id, edge_type, block)?);
                    }
                }
                let mut conn = core.conn()?;
                let tx = conn.transaction()?;
                context.check(&tx)?;
                for row in &rows {
                    crate::reach::set_listed(
                        &tx,
                        &row.item.id,
                        row.listed.ok_or_else(crate::reach::invalid)?,
                    )?;
                    store::take_server_item(&tx, &row.item, Some(&row.metadata.tags), &catalog)?;
                    for block in row.item.edges.iter().flat_map(|blocks| blocks.values()) {
                        for edge in &block.data {
                            store::put_server_edge(&tx, edge)?;
                        }
                    }
                }
                for edge in &overflow {
                    store::put_server_edge(&tx, edge)?;
                }
                tx.commit()?;
            }
            let conn = core.conn()?;
            context.check(&conn)?;
            Reached::at(Phase::Replay, pages_total).keep(&conn)?;
        }

        let replay = match crate::catch_up::replay_build(
            core,
            http,
            &context,
            core.catch_up_idle,
            stop,
            &mut false,
        ) {
            // The head a resumed hydration kept is older than this call, so
            // the log may have let it go; filled again, the copy starts from
            // a head read now.
            Err(CoreError::CopyExpired { reason }) if resumed => {
                match crate::catch_up::divergence(&reason) {
                    Some(gap) => return Ok(Attempt::Again(gap)),
                    None => return Err(CoreError::CopyExpired { reason }),
                }
            }
            replay => replay?,
        };
        let cursor = replay.cursor;
        let (items, edges) = {
            let mut conn = core.conn()?;
            let tx = conn.transaction()?;
            context.check(&tx)?;
            let catalog = Catalog::load(&tx)?;
            lay_queue_over(
                &tx,
                &catalog,
                edge_types,
                Some(&store::credential_digest(&http.authorization())),
            )?;
            store::meta_delete(&tx, store::META_HYDRATE_STATE)?;
            store::meta_delete(&tx, store::META_ITEMS_EXPECTED)?;
            store::meta_delete(&tx, store::META_ITEMS_LISTED)?;
            store::meta_delete(&tx, store::META_HYDRATE_RESUME)?;
            if in_place {
                store::sweep_refill(&tx)?;
            }
            store::attachments_whole(&tx)?;
            let counts = (store::count(&tx, "items")?, store::count(&tx, "edges")?);
            tx.commit()?;
            counts
        };

        Ok(Attempt::Done(Box::new(HydrateReport {
            types: types.to_vec(),
            tier,
            edge_types: edge_types.to_vec(),
            items,
            edges,
            pages: *pages,
            pages_total,
            resumed,
            restarted,
            in_place,
            cursor,
            registered_types: declared.registered.clone(),
            unregistered_types: declared.unregistered.clone(),
            replaced_types: declared.replaced.clone(),
            unreplaced_types: declared.unreplaced.clone(),
        })))
    })();
    result.map_err(|error| context.failed(core, error).unwrap_or_else(|error| error))
}

/// Whether the head `head` is at or past the cursor `held`: a log that ends
/// before the cursor a copy held is a server restored to an earlier point.
fn not_behind(head: &str, held: &str) -> bool {
    matches!(
        (crate::reach::cursor(head), crate::reach::cursor(held)),
        (Some(head), Some(held)) if head >= held
    )
}

/// A whole or stale copy built under another instance or reach than the head
/// names may hold rows the key no longer reads, so it stops answering at once,
/// before a later step of the hydration can fail and leave it answering. The
/// expiry takes the resume point too, so it answers why an interrupted refill
/// it ended starts again.
fn expire_if_built_elsewhere(
    core: &Core,
    instance: &str,
    fence: &str,
) -> Result<Option<HydrateRestart>> {
    let mut conn = core.conn()?;
    let elsewhere = if store::hydrated(&conn)? {
        if store::meta_get(&conn, store::META_INSTANCE_ID)?.as_deref() != Some(instance) {
            Some(HydrateRestart::InstanceChanged)
        } else if store::meta_get(&conn, crate::reach::FENCE)?.as_deref() != Some(fence) {
            Some(HydrateRestart::ReachChanged)
        } else {
            None
        }
    } else {
        store::refill(&conn)?.and_then(|built| {
            if built.instance != instance {
                Some(HydrateRestart::InstanceChanged)
            } else if built.reach != fence {
                Some(HydrateRestart::ReachChanged)
            } else {
                None
            }
        })
    };
    let Some(reason) = elsewhere else {
        return Ok(None);
    };
    let interrupted = store::meta_get(&conn, store::META_HYDRATE_RESUME)?.is_some();
    let tx = conn.transaction()?;
    crate::reach::expire(&tx)?;
    tx.commit()?;
    Ok(interrupted.then_some(reason))
}

/// Where an interrupted hydration of this slice reached, if it can carry on
/// from there: under the same instance, reach and slice, with the head it
/// started from still in the server's event log, so the replay after its
/// pages can start there. The catalog is held to the copy's as the resume
/// begins. Otherwise why it cannot, where there was one.
#[allow(clippy::too_many_arguments)]
fn resume_point(
    core: &Core,
    http: &Http,
    instance: &str,
    fence: &str,
    types: &[String],
    tier: SliceTier,
    edge_types: &[String],
    stop: &AtomicBool,
) -> Result<Start> {
    let (reached, head) = {
        let conn = core.conn()?;
        if store::hydration_complete(&conn)? {
            return Ok(Start::Fresh(None));
        }
        let point = store::meta_get(&conn, store::META_HYDRATE_RESUME)?;
        let head = store::meta_get(&conn, store::META_EVENT_CURSOR)?;
        let (Some(point), Some(head)) = (point, head) else {
            return Ok(Start::Fresh(None));
        };
        let Ok(reached) = serde_json::from_str::<Reached>(&point) else {
            return Ok(Start::Fresh(None));
        };
        if store::meta_get(&conn, store::META_INSTANCE_ID)?.as_deref() != Some(instance) {
            return Ok(Start::Fresh(Some(HydrateRestart::InstanceChanged)));
        }
        if store::meta_get(&conn, crate::reach::FENCE)?.as_deref() != Some(fence) {
            return Ok(Start::Fresh(Some(HydrateRestart::ReachChanged)));
        }
        if store::meta_get(&conn, store::META_SLICE_TYPES)? != Some(serde_json::to_string(types)?)
            || store::meta_get(&conn, store::META_SLICE_TIER)?.as_deref() != Some(tier.as_str())
            || store::meta_get(&conn, store::META_SLICE_EDGE_TYPES)?
                != Some(serde_json::to_string(edge_types)?)
            || reached.indices(types, edge_types).is_none()
        {
            return Ok(Start::Fresh(Some(HydrateRestart::SliceChanged)));
        }
        (reached, head)
    };
    Ok(match head_held(http, &head, stop)? {
        Some(HydrateRestart::ReachChanged) => Start::Reread(HydrateRestart::ReachChanged),
        Some(gap) => Start::Fresh(Some(gap)),
        None => Start::Resume(reached),
    })
}

/// Whether `catalog` differs from the one the copy holds, leaving the copy's.
fn catalog_differs(core: &Core, catalog: &WireCatalog) -> Result<bool> {
    let mut conn = core.conn()?;
    let tx = conn.transaction()?;
    store::replace_catalog(&tx, catalog)
}

/// Asks the log for the events after `head` and reads only as far as the
/// frame after `stream_cursor`: `None` where the log would replay them, and
/// otherwise why it cannot.
fn head_held(http: &Http, head: &str, stop: &AtomicBool) -> Result<Option<HydrateRestart>> {
    for _ in 0..HEAD_ATTEMPTS {
        crate::catch_up::refuse_if_stopped(stop)?;
        let asked = head.to_string();
        // A stream resumed under a reach that is no longer the key's is
        // refused before it starts (`reach/copy-reach-refused`).
        let reader = match crate::catch_up::ask_unless_stopped(stop, http, move |http| {
            http.open_events(Some(&asked), HEAD_READ_TIMEOUT)
        }) {
            Err(CoreError::CopyExpired { reason }) if reason == "reach_changed" => {
                return Ok(Some(HydrateRestart::ReachChanged));
            }
            reader => reader?,
        };
        let mut frames = Frames::new(BufReader::new(reader));
        let mut opened = false;
        loop {
            crate::catch_up::refuse_if_stopped(stop)?;
            let frame = frames.next_frame();
            crate::catch_up::refuse_if_stopped(stop)?;
            match frame {
                Ok(Some(Frame::Comment(_))) => continue,
                Ok(Some(Frame::Event { id, name, data })) => {
                    let payload =
                        crate::reach::event_payload(name.as_deref(), id.as_deref(), &data)?;
                    let kind = name.as_deref().unwrap_or(&payload.event_type);
                    if let Some(reason) = crate::catch_up::diverged(kind, &payload, head) {
                        return Ok(Some(
                            crate::catch_up::divergence(&reason)
                                .unwrap_or(HydrateRestart::HeadPastLog),
                        ));
                    }
                    match kind {
                        "reach_changed" => return Ok(Some(HydrateRestart::ReachChanged)),
                        "stream_incomplete" => {
                            return Err(CoreError::StreamIncomplete {
                                reason: payload.reason.unwrap_or_default(),
                            });
                        }
                        "stream_cursor" if !opened => opened = true,
                        // A replayed event or the end of the replay: the log
                        // holds what follows the head.
                        _ if opened => return Ok(None),
                        _ => return Err(crate::reach::invalid()),
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
    }
    Err(CoreError::StreamIncomplete {
        reason: "replay_failed".into(),
    })
}

/// The queue survives a hydration and the copy does not, so without this a
/// create still waiting is a row a local read no longer finds, and an edit
/// still waiting reads as undone.
pub(crate) fn lay_queue_over(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    whole: &[String],
    credential: Option<&str>,
) -> Result<()> {
    let waiting = store::current_waiting_writes(conn, &store::waiting_writes(conn)?)?;
    let mut items: Vec<&str> = Vec::new();
    let mut edges: Vec<&str> = Vec::new();
    for row in &waiting {
        match row.kind {
            WriteKind::CreateItem => {
                let draft = Draft::from_payload(&store::payload_of(conn, &row.id)?)?;
                let Some(id) = row.item_id.clone() else {
                    return Err(CoreError::Store(format!(
                        "the queued create {} names no item, so its row cannot be held",
                        row.id
                    )));
                };
                if !store::item_held(conn, &id)? {
                    let mut wire = draft.wire(&id);
                    // A keyed create sent with no tier lands on the row its
                    // key names, at that row's tier, and is shown until the
                    // answer at the tier the slice chose where the copy does
                    // not hold that row.
                    if draft.tier.is_none()
                        && let Some(source_id) = &draft.source_id
                    {
                        let held =
                            match store::source_of(conn, draft.source.as_deref(), credential)? {
                                Some(source) => store::item_under_key(conn, &source, source_id)?,
                                None => None,
                            };
                        if let Some(held) = held {
                            wire.tier = held.tier.map(|tier| tier.as_str().into());
                        } else if let Some(tier) = store::chosen_tier(conn, &row.id)? {
                            wire.tier = Some(tier.as_str().into());
                        }
                    }
                    if draft.occurred_at.is_none() {
                        wire.occurred_at.clone_from(&row.queued_at);
                        wire.created_at.clone_from(&row.queued_at);
                        wire.updated_at.clone_from(&row.queued_at);
                    }
                    store::upsert_item(conn, &wire, Some(&[]), &catalog.indexing(&draft.r#type))?;
                }
            }
            WriteKind::CreateEdge => {
                let (id, draft) = EdgeDraft::from_payload(&store::payload_of(conn, &row.id)?)?;
                if store::edge_ends(conn, &id)?.is_none()
                    && store::takes_edge(conn, &draft.source_id, &draft.edge_type, whole)?
                {
                    let mut wire = draft.wire(&id);
                    wire.created_at.clone_from(&row.queued_at);
                    wire.updated_at.clone_from(&row.queued_at);
                    store::upsert_edge(conn, &wire)?;
                }
            }
            _ => {}
        }
        if let Some(id) = row.edge_id.as_deref() {
            if !edges.contains(&id) {
                edges.push(id);
            }
        } else if let Some(id) = row.item_id.as_deref()
            && !items.contains(&id)
        {
            items.push(id);
        }
    }
    for id in items {
        store::lay_waiting_writes_over(conn, id, &|laid| catalog.indexing(laid))?;
    }
    for id in edges {
        store::lay_waiting_edge_writes_over(conn, id)?;
    }
    Ok(())
}

/// What a hydration did to the instance's types for the ones the app declared.
#[derive(Default)]
struct Declared {
    registered: Vec<String>,
    unregistered: Vec<UnregisteredType>,
    replaced: Vec<String>,
    unreplaced: Vec<UnregisteredType>,
    /// Whether any call changed what the instance holds, which leaves the
    /// catalog and the head the caller read stale.
    changed: bool,
}

/// The rows ordered so that a type whose parent is also in them waits for it.
/// Only parents that name each other leave none to go, and then the first goes
/// and the server answers it.
fn parents_first(mut rows: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut ordered = Vec::with_capacity(rows.len());
    while !rows.is_empty() {
        let next = rows
            .iter()
            .position(|(_, json)| {
                let parent = serde_json::from_str::<serde_json::Value>(json)
                    .ok()
                    .and_then(|row| row.get("parent")?.as_str().map(str::to_string));
                parent.is_none_or(|parent| !rows.iter().any(|(id, _)| *id == parent))
            })
            .unwrap_or(0);
        ordered.push(rows.remove(next));
    }
    ordered
}

/// Brings the instance's types up to what the app declared, parents before
/// their children: registers the ones it does not hold, then replaces each
/// `app.*` type it holds in another definition. A key that may not register or
/// replace is no reason to refuse the hydration: what it queued waits for the
/// server's verdict like any write, and the type stays as the server holds it.
///
/// "Another definition" is the server's judgement: it normalizes the
/// declaration and the registered type alike (`POST /types/normalize`), so key
/// order, a default written out or left out, and a label the server derives
/// never make a declaration differ. Only an `app.*` type is replaced: the
/// namespace an app owns, where a type under `user.*` or a publisher's is
/// shared with whoever else writes there.
fn declare_on_instance(
    core: &Core,
    http: &Http,
    catalog: &WireCatalog,
    stop: &AtomicBool,
) -> Result<Declared> {
    let declared: Vec<(String, String)> = {
        let conn = core.conn()?;
        store::declared_type_rows(&conn)?
    };
    let held = |id: &str| catalog.types.iter().any(|held| held.id == id);
    let (present, missing): (Vec<_>, Vec<_>) = declared.into_iter().partition(|(id, _)| held(id));
    let mut done = Declared::default();
    for (id, json) in parents_first(missing) {
        crate::catch_up::refuse_if_stopped(stop)?;
        match http.register_type(&json)? {
            Registration::Registered => {
                done.registered.push(id);
                done.changed = true;
            }
            Registration::Held => done.changed = true,
            Registration::Refused { code, message } => {
                done.unregistered
                    .push(UnregisteredType { id, code, message })
            }
        }
    }
    let own = present.into_iter().filter(|(id, _)| id.starts_with("app."));
    for (id, json) in parents_first(own.collect()) {
        crate::catch_up::refuse_if_stopped(stop)?;
        // A normalization the server refuses is no verdict that the type
        // matches: the replacement is asked for, and its refusal is the one
        // reported.
        let differs = match http.normalized_type(&json) {
            Ok(normalized) => !normalized.is_held(),
            Err(error) if error.is_environmental() => return Err(error),
            Err(
                CoreError::Validation { .. }
                | CoreError::Forbidden { .. }
                | CoreError::NotFound { .. }
                | CoreError::Server { .. },
            ) => true,
            Err(error) => return Err(error),
        };
        if !differs {
            continue;
        }
        match http.replace_type(&id, &json)? {
            Replacement::Replaced => {
                done.replaced.push(id);
                done.changed = true;
            }
            Replacement::Refused { code, message } => {
                done.unreplaced.push(UnregisteredType { id, code, message })
            }
        }
    }
    Ok(done)
}

/// What a type is, said where a name is refused for breaking the grammar.
pub(crate) const GRAMMAR: &str = "a type is two or more lowercase dotted segments, each a letter followed by letters, digits, hyphens and underscores, at most 128 characters, with exactly three under `app.` and none under a root Marfa reserves";

/// The server's type pattern grammar (`types/id-grammar` and
/// `types/id-reserved-scope-root`): a type identifier, or a namespace under
/// `.*`. The bare `*` is no pattern here; each caller says what it means.
pub(crate) fn type_pattern(name: &str) -> Result<bool> {
    let segment = |part: &str| {
        let mut characters = part.chars();
        characters
            .next()
            .is_some_and(|first| first.is_ascii_lowercase())
            && characters.all(|rest| {
                rest.is_ascii_lowercase() || rest.is_ascii_digit() || rest == '-' || rest == '_'
            })
    };
    if name.len() > 128 {
        return Ok(false);
    }
    // A wildcard's root is a namespace, held to the segments alone.
    if let Some(root) = name.strip_suffix(".*") {
        return Ok(!root.is_empty() && root.split('.').all(segment));
    }
    let segments: Vec<&str> = name.split('.').collect();
    if segments.len() < 2 || !segments.iter().all(|part| segment(part)) {
        return Ok(false);
    }
    Ok(match segments[0] {
        "app" => segments.len() == 3,
        "core" | "system" | "user" | "marfa" => true,
        root => !crate::builtin::reserved_type_roots()?
            .iter()
            .any(|reserved| reserved == root),
    })
}

/// A type identifier the server's grammar takes, and no namespace pattern.
pub(crate) fn type_id(name: &str) -> Result<bool> {
    Ok(!name.ends_with(".*") && type_pattern(name)?)
}

/// The server's count of the rows the slice takes, by type, read once as a
/// hydration starts so a copy filling up can say how far it has come. `None`
/// where the server does not answer, and where one count cannot say it: a
/// slice at one tier that names a `system.*` type lists that type at both.
fn counted(http: &Http, types: &[String], tier: SliceTier) -> Option<HashMap<String, u64>> {
    let system = types.iter().any(|declared| store::is_system(declared));
    if system && tier != SliceTier::All {
        return None;
    }
    http.counts_by_type(tier, system).ok()
}

/// The counts were read at the slice's tier, so only the types are matched.
fn expected(catalog: &Catalog, types: &[String], counts: &HashMap<String, u64>) -> u64 {
    counts
        .iter()
        .filter(|(row_type, _)| {
            store::slice_takes(
                catalog,
                types,
                SliceTier::All,
                row_type,
                Some(Tier::Library),
            )
        })
        .map(|(_, count)| count)
        .sum()
}

/// A `system.*` type is listed at both tiers, as the slice takes it
/// (`store::slice_takes`).
fn listed_tier(declared: Option<&str>, tier: SliceTier) -> SliceTier {
    match declared {
        Some(declared) if store::is_system(declared) => SliceTier::All,
        _ => tier,
    }
}

/// `*` is every type but `system.*`, so it stands beside `system.*` types,
/// which it adds, and beside no other.
fn declared_types(types: &[String]) -> Result<Vec<String>> {
    let mut declared = Vec::new();
    for raw in types {
        let name = raw.trim();
        if name != store::EVERY_TYPE && !type_pattern(name)? {
            return Err(CoreError::Invalid(format!(
                "not a type to declare: {raw:?}; {GRAMMAR}, or a namespace under .*"
            )));
        }
        if !declared.iter().any(|seen| seen == name) {
            declared.push(name.to_string());
        }
    }
    if declared.is_empty() {
        return Err(CoreError::Invalid("declare at least one type".into()));
    }
    if declared.iter().any(|name| name == store::EVERY_TYPE)
        && declared
            .iter()
            .any(|name| name != store::EVERY_TYPE && !store::is_system(name))
    {
        return Err(CoreError::Invalid(format!(
            "`{}` is every type but system.*, so it stands beside system.* types only: leave out the other types, or name the types without it",
            store::EVERY_TYPE
        )));
    }
    Ok(declared)
}

/// The listing refuses a type the credential cannot read `403
/// type_not_permitted`, but only once the copy has been cleared, so it is
/// refused here first, whatever the credential. A key's own map says which
/// types it reads. A credential that is not a key cannot read its own map, so
/// the first page of each named type is asked for instead and the listing's
/// refusal is taken as the answer. A wildcard may match nothing, so it is
/// taken as declared.
///
/// A named type is readable when the credential reads it or any type under
/// it, because the server serves a named type's readable descendants and
/// refuses it only when nothing it selects is readable.
/// Answers the key's own source where it read the key: `Some(None)` for a
/// credential that is not a key.
/// A key that may not read itself, as an app's sign-in may not, is asked
/// for the first page of each named type where `probe` holds; where it does
/// not, the types are taken as readable.
fn refuse_unreadable(
    http: &Http,
    types: &[String],
    tier: SliceTier,
    catalog: &WireCatalog,
    probe: bool,
) -> Result<Option<Option<String>>> {
    let named: Vec<&str> = types
        .iter()
        .map(String::as_str)
        .filter(|name| *name != store::EVERY_TYPE && !name.ends_with(".*"))
        .collect();
    if named.is_empty() {
        return Ok(None);
    }
    let key = http.current_key()?;
    let learned = key.as_ref().and_then(|key| {
        key.get("source")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    });
    let unreadable: Vec<&str> = match &key {
        Some(key) => named
            .into_iter()
            .filter(|name| !reads_under(key, name, catalog))
            .collect(),
        None if !probe => Vec::new(),
        None => {
            let mut refused = Vec::new();
            for name in named {
                let probe = http.items_page(&ItemsQuery {
                    r#type: Some(name),
                    tier: listed_tier(Some(name), tier),
                    cursor: None,
                });
                match probe {
                    Err(CoreError::Forbidden { code, .. }) if code == "type_not_permitted" => {
                        refused.push(name);
                    }
                    Err(error) => return Err(error),
                    Ok(_) => {}
                }
            }
            refused
        }
    };
    if unreadable.is_empty() {
        return Ok(Some(learned));
    }
    Err(CoreError::Forbidden {
        code: "type_not_permitted".into(),
        message: format!(
            "this credential cannot read {}, nor any type under it, so a slice naming it would hold none of it: hydrate with a credential that reads it, or leave it out",
            unreadable.join(", ")
        ),
    })
}

/// Whether the key reads `name` or a type the catalog places under it, by
/// its name or by a declared parent.
fn reads_under(key: &serde_json::Value, name: &str, catalog: &WireCatalog) -> bool {
    use crate::folder::placement::reads;
    reads(key, name)
        || catalog.types.iter().any(|candidate| {
            candidate.id != name && under(catalog, &candidate.id, name) && reads(key, &candidate.id)
        })
}

fn under(catalog: &WireCatalog, id: &str, root: &str) -> bool {
    if id.starts_with(&format!("{root}.")) {
        return true;
    }
    let mut current = id;
    for _ in 0..64 {
        let Some(parent) = catalog
            .types
            .iter()
            .find(|entry| entry.id == current)
            .and_then(|entry| entry.parent.as_deref())
        else {
            return false;
        };
        if parent == root {
            return true;
        }
        current = parent;
    }
    false
}

/// Checked against the catalog just read, before the copy is cleared: the
/// listing refuses a type nobody registered only once the copy is gone.
fn refuse_unheld(catalog: &WireCatalog, types: &[String], edge_types: &[String]) -> Result<()> {
    if let Some(unheld) = types.iter().find(|name| {
        *name != store::EVERY_TYPE
            && !name.ends_with(".*")
            && !catalog.types.iter().any(|held| &held.id == *name)
    }) {
        return Err(CoreError::UnknownType {
            message: format!(
                "the server holds no type {unheld}, so a slice naming it would hold none of it: register it, or leave it out"
            ),
        });
    }
    if let Some(unheld) = edge_types.iter().find(|name| {
        !catalog
            .edge_types
            .iter()
            .any(|held| held.get("id").and_then(|id| id.as_str()) == Some(name.as_str()))
    }) {
        return Err(CoreError::UnknownType {
            message: format!(
                "the server holds no edge type {unheld}, so a slice holding it whole would hold none of it: register it, or leave it out"
            ),
        });
    }
    Ok(())
}

/// A comma is refused because the listing reads one as a list of types.
fn declared_edge_types(edge_types: &[String]) -> Result<Vec<String>> {
    let mut declared: Vec<String> = Vec::new();
    for raw in edge_types {
        let name = raw.trim();
        if name.is_empty()
            || name == "*"
            || name.contains(char::is_whitespace)
            || name.contains(',')
        {
            return Err(CoreError::Invalid(format!(
                "not an edge type to hold whole: {raw:?}"
            )));
        }
        if !declared.iter().any(|seen| seen == name) {
            declared.push(name.to_string());
        }
    }
    Ok(declared)
}

pub(crate) fn read_with_edges(
    http: &Http,
    id: &str,
) -> Result<Option<(WireItemWithMetadata, Vec<WireEdge>)>> {
    let Some(read) = http.item_with_edges(id)? else {
        return Ok(None);
    };
    let mut edges = Vec::new();
    for (edge_type, block) in read.item.edges.iter().flatten() {
        edges.extend(block.data.iter().cloned());
        edges.extend(fetch_overflow(http, id, edge_type, block)?);
    }
    Ok(Some((read, edges)))
}

/// A row held at a later stamp came from an event since the read, and
/// stays.
pub(crate) fn hold_row(
    conn: &rusqlite::Connection,
    catalog: &Catalog,
    row: &WireItemWithMetadata,
    edges: &[WireEdge],
) -> Result<()> {
    crate::reach::set_listed(
        conn,
        &row.item.id,
        row.listed.ok_or_else(crate::reach::invalid)?,
    )?;
    store::take_server_item(conn, &row.item, Some(&row.metadata.tags), catalog)?;
    for edge in edges {
        store::take_server_edge(conn, edge)?;
    }
    Ok(())
}

/// Fetched before any write so no transaction waits on the network.
pub(crate) fn fetch_overflow(
    http: &Http,
    item_id: &str,
    edge_type: &str,
    block: &WireEdgeBlock,
) -> Result<Vec<WireEdge>> {
    let mut edges = Vec::new();
    let mut cursor = block.next_cursor.clone();
    let mut seen = std::collections::HashSet::new();
    while let Some(asked_for) = cursor {
        if !seen.insert(asked_for.clone()) {
            return Err(crate::reach::invalid());
        }
        let page = http.item_edges_page(item_id, edge_type, Some(&asked_for))?;
        edges.extend(page.data);
        // A repeated cursor would loop forever.
        if page.next_cursor.as_deref() == Some(asked_for.as_str()) {
            return Err(crate::reach::invalid());
        }
        cursor = page.next_cursor;
    }
    Ok(edges)
}

/// Read before the first page so the snapshot has a resume point from before
/// it.
fn read_head(http: &Http, stop: &AtomicBool) -> Result<(String, String, String)> {
    for _ in 0..HEAD_ATTEMPTS {
        crate::catch_up::refuse_if_stopped(stop)?;
        let reader = crate::catch_up::ask_unless_stopped(stop, http, |http| {
            http.open_events(None, HEAD_READ_TIMEOUT)
        })?;
        let mut frames = Frames::new(BufReader::new(reader));
        loop {
            crate::catch_up::refuse_if_stopped(stop)?;
            let frame = frames.next_frame();
            crate::catch_up::refuse_if_stopped(stop)?;
            match frame {
                Ok(Some(Frame::Comment(_))) => continue,
                Ok(Some(Frame::Event { id, name, data })) => {
                    let payload =
                        crate::reach::event_payload(name.as_deref(), id.as_deref(), &data)?;
                    if id.is_some() || name.as_deref() != Some(payload.event_type.as_str()) {
                        return Err(crate::reach::invalid());
                    }
                    if payload.event_type == "stream_incomplete" {
                        return Err(CoreError::StreamIncomplete {
                            reason: payload.reason.unwrap_or_default(),
                        });
                    }
                    if payload.event_type == "reach_changed" {
                        return Err(CoreError::CopyExpired {
                            reason: "reach_changed".into(),
                        });
                    }
                    if payload.event_type != "stream_cursor" {
                        return Err(crate::reach::invalid());
                    }
                    let cursor = payload.cursor.ok_or_else(crate::reach::invalid)?;
                    let instance = payload
                        .instance_id
                        .filter(|s| !s.is_empty())
                        .ok_or_else(crate::reach::invalid)?;
                    let fence = payload
                        .reach
                        .filter(|s| crate::reach::valid_fence(s))
                        .ok_or_else(crate::reach::invalid)?;
                    crate::reach::cursor(&cursor).ok_or_else(crate::reach::invalid)?;
                    return Ok((instance, cursor, fence));
                }
                Ok(None) | Err(_) => break,
            }
        }
    }
    Err(CoreError::StreamIncomplete {
        reason: "replay_failed".into(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::{Value, json};

    use crate::scripted::{self, Answer, Scripted, Then};
    use crate::stop_tests::copy;
    use crate::{Core, CoreError, Hydration, SliceTier, store};

    /// A copy whose slice lists nothing, holding `count` pins, and a server
    /// whose head and replay end live.
    fn pinned_copy(server: &Scripted, count: usize) -> (std::sync::Arc<Core>, Vec<String>) {
        let core = copy(server);
        let pinned: Vec<String> = (0..count).map(|at| format!("pin-{at:03}")).collect();
        {
            let conn = core.conn().unwrap();
            for id in &pinned {
                store::pin(&conn, id).unwrap();
            }
        }
        server.on(
            "/items",
            vec![scripted::certified(scripted::json(
                200,
                r#"{"data":[],"next_cursor":null}"#,
            ))],
        );
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                scripted::stream(
                    vec![
                        scripted::copy_marker("stream_cursor", "10"),
                        scripted::copy_marker("stream_live", "11"),
                    ],
                    Then::End,
                ),
            ],
        );
        (core, pinned)
    }

    /// The body `POST /items/bulk-get` answers for `rows`, each an id and
    /// its `listed`.
    fn bulk_body(rows: &[(&str, bool)]) -> Value {
        let items: Vec<Value> = rows
            .iter()
            .map(|(id, _)| {
                serde_json::from_str::<Value>(&scripted::item_payload(
                    "item.updated",
                    id,
                    "core.note",
                    1,
                ))
                .unwrap()["item"]
                    .clone()
            })
            .collect();
        let metadata: Vec<Value> = rows
            .iter()
            .map(|(id, _)| json!({"item_id": id, "tags": [], "extensions": {}}))
            .collect();
        let listed: Vec<bool> = rows.iter().map(|(_, listed)| *listed).collect();
        json!({"items": items, "metadata": metadata, "listed": listed})
    }

    fn bulk(rows: &[(&str, bool)]) -> Answer {
        scripted::certified(scripted::json(200, &bulk_body(rows).to_string()))
    }

    fn hydrate(core: &Core) -> crate::Result<crate::HydrateReport> {
        core.hydrate_until(
            &["core.note".into()],
            SliceTier::Library,
            &[],
            &AtomicBool::new(false),
        )
    }

    #[test]
    fn a_hydration_with_a_changed_catalog_repairs_unreadable_properties() {
        for damaged in [r#"{"title":"#, "[1]"] {
            let server = Scripted::start();
            let core = copy(&server);
            {
                let conn = core.conn().unwrap();
                store::replace_catalog(
                    &conn,
                    &crate::wire::WireCatalog {
                        types: vec![store::testing::wire_type("core.note", None, Some("title"))],
                        edge_types: vec![],
                    },
                )
                .unwrap();
                store::put_server_item(
                    &conn,
                    &store::testing::note("damaged", "original", "body", "2026-01-01T00:00:00Z"),
                    Some(&[]),
                    &crate::catalog::Catalog::load(&conn).unwrap(),
                )
                .unwrap();
                conn.execute(
                    "UPDATE items SET properties = ?1 WHERE id = 'damaged'",
                    [damaged],
                )
                .unwrap();
            }
            let before = store::catalog_version(&core.conn().unwrap()).unwrap();
            assert!(
                core.get_kept("damaged")
                    .unwrap()
                    .unwrap()
                    .1
                    .unreadable_properties
                    .is_some()
            );
            server.on(
                "/types",
                vec![scripted::certified(scripted::types(&[
                    ("core.note", None),
                    ("user.late", Some("core.note")),
                ]))],
            );
            let payload: Value = serde_json::from_str(&scripted::item_payload(
                "item.updated",
                "damaged",
                "core.note",
                2,
            ))
            .unwrap();
            let page = json!({
                "data": [{
                    "item": payload["item"],
                    "metadata": payload["metadata"],
                    "listed": true,
                }],
                "next_cursor": null,
            });
            server.on(
                "/items",
                vec![scripted::certified(scripted::json(200, &page.to_string()))],
            );
            server.on(
                "/events",
                vec![
                    scripted::stream(
                        vec![scripted::copy_marker("stream_cursor", "10")],
                        Then::End,
                    ),
                    scripted::stream(
                        vec![
                            scripted::copy_marker("stream_cursor", "10"),
                            scripted::copy_marker("stream_live", "10"),
                        ],
                        Then::End,
                    ),
                ],
            );

            assert_eq!(hydrate(&core).unwrap().items, 1);

            assert_ne!(
                store::catalog_version(&core.conn().unwrap()).unwrap(),
                before
            );
            assert!(core.item_type("user.late").is_ok());
            let repaired = core.get_shown("damaged").unwrap().unwrap();
            assert_eq!(repaired.0.properties["title"], "damaged");
            assert_eq!(repaired.0.version, 2);
            assert_eq!(repaired.1.unreadable_properties, None);
            assert!(!server.seen("/items").is_empty());
        }
    }

    #[test]
    fn a_hydration_reads_pinned_rows_a_hundred_to_a_request_under_its_reach() {
        let server = Scripted::start();
        let (core, pinned) = pinned_copy(&server, 250);
        server.on(
            "/items/bulk-get",
            vec![
                bulk(&[("pin-000", true), ("pin-001", false)]),
                bulk(&[]),
                bulk(&[("pin-249", true)]),
            ],
        );

        let report = hydrate(&core).unwrap();

        let asked = server.seen("/items/bulk-get");
        let mut named = Vec::new();
        for seen in &asked {
            assert_eq!(seen.reach.as_deref(), Some(scripted::FENCE));
            let body: Value = serde_json::from_slice(&seen.body).unwrap();
            assert_eq!(body["include"], json!(["edges", "metadata", "system"]));
            named.extend(
                body["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().to_string()),
            );
        }
        assert_eq!(
            asked
                .iter()
                .map(
                    |seen| serde_json::from_slice::<Value>(&seen.body).unwrap()["ids"]
                        .as_array()
                        .unwrap()
                        .len()
                )
                .collect::<Vec<_>>(),
            [100, 100, 50],
            "the pinned rows were not read 100 to a request"
        );
        assert_eq!(named, pinned);
        assert_eq!(report.items, 3);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::pins(&conn).unwrap(),
            pinned,
            "a pin left out was dropped"
        );
        for (id, held) in [
            ("pin-000", true),
            ("pin-001", true),
            ("pin-100", false),
            ("pin-249", true),
        ] {
            assert_eq!(store::item_held(&conn, id).unwrap(), held, "{id}");
        }
        assert!(crate::reach::listed(&conn, "pin-000").unwrap());
        assert!(
            !crate::reach::listed(&conn, "pin-001").unwrap(),
            "the answer's listed was not kept for the row it pairs with"
        );
    }

    /// A hundred pinned rows in one answer can pass ureq's default 10 MiB
    /// where each read alone did not, and every hydration of such a copy
    /// would fail.
    #[test]
    fn a_hydration_takes_a_read_of_pinned_rows_over_ten_mib() {
        let server = Scripted::start();
        let (core, pinned) = pinned_copy(&server, 12);
        let mut body = bulk_body(
            &pinned
                .iter()
                .map(|id| (id.as_str(), true))
                .collect::<Vec<_>>(),
        );
        for item in body["items"].as_array_mut().unwrap() {
            item["properties"]["body"] = "x".repeat(900_000).into();
        }
        let body = body.to_string();
        assert!(body.len() > 10 * 1024 * 1024);
        server.on(
            "/items/bulk-get",
            vec![scripted::certified(scripted::json(200, &body))],
        );

        assert_eq!(hydrate(&core).unwrap().items, 12);
    }

    /// Each is an answer the hydration cannot take as the server's word on
    /// its reach, so the copy expires as on any other conditional read.
    #[test]
    fn a_bulk_answer_of_pinned_rows_that_cannot_be_trusted_expires_the_copy() {
        let mut short = bulk_body(&[("pin-000", true), ("pin-001", true)]);
        short["listed"] = json!([true]);
        let mut unlisted = bulk_body(&[("pin-000", true)]);
        unlisted.as_object_mut().unwrap().remove("listed");
        let mut unpaired = bulk_body(&[("pin-000", true), ("pin-001", true)]);
        unpaired["metadata"][0]["item_id"] = json!("pin-001");
        let cases = [
            (
                "listed shorter than items",
                scripted::certified(scripted::json(200, &short.to_string())),
                "reach_invalid",
            ),
            (
                "no listed",
                scripted::certified(scripted::json(200, &unlisted.to_string())),
                "reach_invalid",
            ),
            (
                "metadata of another row",
                scripted::certified(scripted::json(200, &unpaired.to_string())),
                "reach_invalid",
            ),
            (
                "a row not asked for",
                bulk(&[("stranger", true)]),
                "reach_invalid",
            ),
            (
                "a row twice",
                bulk(&[("pin-000", true), ("pin-000", true)]),
                "reach_invalid",
            ),
            (
                "no certificate",
                scripted::json(200, &bulk_body(&[("pin-000", true)]).to_string()),
                "reach_invalid",
            ),
            (
                "a changed reach",
                scripted::refusal(409, "reach_changed"),
                "reach_changed",
            ),
        ];
        for (case, answer, reason) in cases {
            let server = Scripted::start();
            let (core, pinned) = pinned_copy(&server, 2);
            server.on("/items/bulk-get", vec![answer]);
            assert_eq!(
                hydrate(&core).unwrap_err(),
                CoreError::CopyExpired {
                    reason: reason.into()
                },
                "{case}"
            );
            let conn = core.conn().unwrap();
            assert!(crate::reach::expired(&conn).unwrap(), "{case}");
            assert_eq!(store::pins(&conn).unwrap(), pinned, "{case}");
        }
        // The witness: the same copy hydrates on an answer it can trust.
        let server = Scripted::start();
        let (core, _) = pinned_copy(&server, 2);
        server.on(
            "/items/bulk-get",
            vec![bulk(&[("pin-000", true), ("pin-001", true)])],
        );
        assert_eq!(hydrate(&core).unwrap().items, 2);
    }

    fn row_of(id: &str) -> Value {
        let payload: Value =
            serde_json::from_str(&scripted::item_payload("item.updated", id, "core.note", 1))
                .unwrap();
        payload["item"].clone()
    }

    fn page_body() -> Value {
        json!({
            "data": [{"item": row_of("row"), "metadata": {"tags": []}, "listed": true}],
            "next_cursor": null,
        })
    }

    /// The first half of `body`, which no JSON reader takes.
    fn cut_short(body: &Value) -> String {
        let text = body.to_string();
        text[..text.len() / 2].to_string()
    }

    /// An answer that is not JSON says nothing against the copy's reach,
    /// and reading it again fails the same way, so the hydration ends
    /// `decoding` and does not expire the copy.
    #[test]
    fn an_answer_that_is_not_json_ends_a_hydration_decoding_and_keeps_the_copy() {
        let page = page_body();
        let bulk_json = bulk_body(&[("pin-000", true)]);
        let edge_types = json!({"data": [{"id": "link"}], "next_cursor": null});
        let cases = [
            (
                "an items page",
                "/items",
                cut_short(&page),
                scripted::certified(scripted::json(200, &page.to_string())),
            ),
            (
                "a bulk read",
                "/items/bulk-get",
                cut_short(&bulk_json),
                bulk(&[("pin-000", true)]),
            ),
            (
                "the edge types",
                "/edge-types",
                cut_short(&edge_types),
                scripted::certified(scripted::edge_types(&[("link", None)])),
            ),
        ];
        for (case, path, cut, witness) in cases {
            let server = Scripted::start();
            let (core, pinned) = pinned_copy(&server, 1);
            server.on(path, vec![scripted::certified(scripted::json(200, &cut))]);
            match hydrate(&core) {
                Err(CoreError::Decoding(message)) => {
                    assert!(message.starts_with(path), "{case}: {message}");
                }
                other => panic!("{case}: ended {other:?}"),
            }
            let conn = core.conn().unwrap();
            assert!(!crate::reach::expired(&conn).unwrap(), "{case}");
            assert_eq!(store::pins(&conn).unwrap(), pinned, "{case}");
            drop(conn);

            // The witness: the whole answer is read.
            let server = Scripted::start();
            let (core, _) = pinned_copy(&server, 1);
            server.on(path, vec![witness]);
            if path != "/items/bulk-get" {
                server.on("/items/bulk-get", vec![bulk(&[("pin-000", true)])]);
            }
            assert!(hydrate(&core).is_ok(), "{case}: the witness");
        }
    }

    /// Each is an answer that is JSON and is not what a certified answer
    /// carries, so the copy cannot take it as the server's word.
    #[test]
    fn an_answer_that_is_json_and_does_not_fit_expires_the_copy() {
        let edges_without_cursor = |mut row: Value| {
            row["edges"] = json!({"link": {"data": []}});
            row
        };
        let mut pages = Vec::new();
        for listed in [json!("yes"), json!(1), json!(false), json!(null)] {
            let mut page = page_body();
            page["data"][0]["listed"] = listed;
            pages.push(page);
        }
        let mut page = page_body();
        page.as_object_mut().unwrap().remove("next_cursor");
        pages.push(page);
        let mut page = page_body();
        page["data"][0]["item"] = edges_without_cursor(row_of("row"));
        pages.push(page);

        let mut bulks = Vec::new();
        let mut bulk = bulk_body(&[("pin-000", true)]);
        bulk["listed"] = json!([true, "yes"]);
        bulks.push(bulk);
        let mut bulk = bulk_body(&[("pin-000", true)]);
        bulk["listed"] = json!("yes");
        bulks.push(bulk);
        let mut bulk = bulk_body(&[("pin-000", true)]);
        bulk["items"][0] = edges_without_cursor(bulk["items"][0].clone());
        bulks.push(bulk);

        let cases = pages
            .into_iter()
            .map(|body| ("/items", body))
            .chain(bulks.into_iter().map(|body| ("/items/bulk-get", body)))
            .chain([(
                "/edge-types",
                json!({"data": [{"unexpected": 1}], "next_cursor": null}),
            )]);
        for (path, body) in cases {
            let server = Scripted::start();
            let (core, _) = pinned_copy(&server, 1);
            server.on(
                path,
                vec![scripted::certified(scripted::json(200, &body.to_string()))],
            );
            assert_eq!(
                hydrate(&core).unwrap_err(),
                CoreError::CopyExpired {
                    reason: "reach_invalid".into()
                },
                "{path}: {body}"
            );
            assert!(crate::reach::expired(&core.conn().unwrap()).unwrap());
        }
    }

    #[test]
    fn a_hydration_stopped_between_reads_of_pinned_rows_asks_for_no_more() {
        let server = Scripted::start();
        let (core, _) = pinned_copy(&server, 101);
        server.on(
            "/items/bulk-get",
            vec![
                Answer::Slow {
                    after: std::time::Duration::from_millis(400),
                    answer: Box::new(bulk(&[("pin-000", true)])),
                },
                bulk(&[("pin-100", true)]),
            ],
        );
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let hydrating = scope.spawn(|| {
                core.hydrate_until(&["core.note".into()], SliceTier::Library, &[], &stop)
            });
            server.wait_for("/items/bulk-get", 1, std::time::Duration::from_secs(5));
            stop.store(true, Ordering::Relaxed);
            assert!(matches!(
                hydrating.join().unwrap(),
                Err(CoreError::Canceled)
            ));
        });
        assert_eq!(
            server.seen("/items/bulk-get").len(),
            1,
            "a read of pinned rows was sent after the stop"
        );
        assert_eq!(core.status().unwrap().hydration, Hydration::InProgress);
        assert_eq!(core.get("pin-000").unwrap().unwrap().id, "pin-000");
        assert!(matches!(
            core.get("pin-100"),
            Err(CoreError::HydrationIncomplete)
        ));
    }

    /// A credential that is not a key cannot read its own map, so the device
    /// cannot tell before listing whether it may read a type. The listing's
    /// refusal has to arrive before the copy is cleared, or the old slice,
    /// its declaration and the queue are gone and the copy stays empty.
    #[test]
    fn a_type_a_non_key_credential_may_not_read_is_refused_before_anything_is_cleared() {
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/types",
            vec![scripted::certified(scripted::types(&[
                ("core.note", None),
                ("core.bookmark", None),
            ]))],
        );
        server.on(
            "/keys/current",
            vec![scripted::certified(scripted::refusal(403, "forbidden"))],
        );
        server.on(
            "/items",
            vec![
                scripted::certified(scripted::json(200, r#"{"data":[],"next_cursor":null}"#)),
                scripted::certified(scripted::refusal(403, "type_not_permitted")),
            ],
        );
        core.create_item(&crate::Draft {
            r#type: "core.note".into(),
            properties: serde_json::from_value(serde_json::json!({
                "title": "queued before hydration",
                "body": "keep this save"
            }))
            .unwrap(),
            ..Default::default()
        })
        .unwrap();
        let queue = core.queue().unwrap();
        let before = core.status().unwrap();

        let refused = core
            .hydrate_until(
                &["core.note".into(), "core.bookmark".into()],
                SliceTier::Library,
                &[],
                &AtomicBool::new(false),
            )
            .unwrap_err();
        match refused {
            CoreError::Forbidden { code, message } => {
                assert_eq!(code, "type_not_permitted");
                assert!(message.contains("core.bookmark"), "{message}");
                assert!(!message.contains("core.note,"), "{message}");
            }
            other => panic!("expected the listing's refusal, got {other:?}"),
        }

        assert_eq!(core.queue().unwrap(), queue, "the queue was touched");
        let after = core.status().unwrap();
        assert_eq!(after.slice_types, before.slice_types);
        assert_eq!(after.hydration, before.hydration);
        let conn = core.conn().unwrap();
        assert_eq!(
            store::meta_get(&conn, store::META_HYDRATE_STATE).unwrap(),
            None,
            "the copy was left mid-hydration"
        );
        assert_eq!(
            store::meta_get(&conn, store::META_SLICE_TYPES)
                .unwrap()
                .as_deref(),
            Some("[\"core.note\"]"),
            "the slice declaration was overwritten"
        );
    }

    /// The server serves a named type's readable descendants, so a key that
    /// reads only a type under the one declared is not refused for it.
    #[test]
    fn a_hydration_learns_the_source_its_credential_stamps_a_write_naming_none_with() {
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/types",
            vec![scripted::certified(scripted::types(&[("core.note", None)]))],
        );
        server.on(
            "/keys/current",
            vec![scripted::certified(scripted::json(
                200,
                r#"{"source":"reader","type_permissions":{"core.note":"write"}}"#,
            ))],
        );
        server.on(
            "/items",
            vec![scripted::certified(scripted::json(
                200,
                r#"{"data":[],"next_cursor":null}"#,
            ))],
        );
        // What the scripted stream does after the key is read is not this
        // test's subject.
        let _ = hydrate(&core);
        let credential = store::credential_digest(&core.http().unwrap().authorization());
        assert_eq!(
            store::learned_source(&core.conn().unwrap(), &credential).unwrap(),
            Some(Some("reader".into())),
            "a hydration read the key and did not keep its source, so a fresh copy's first create naming none cannot find the row it holds"
        );
    }

    #[test]
    fn a_key_that_reads_only_a_descendant_of_a_declared_type_hydrates_it() {
        let server = Scripted::start();
        let catalog = || {
            server.on(
                "/types",
                vec![scripted::certified(scripted::types(&[
                    ("core.note", None),
                    ("core.entity", None),
                    ("core.entity.person", Some("core.entity")),
                    ("acme.contact", Some("core.entity")),
                ]))],
            )
        };
        for readable in ["core.entity.person", "acme.contact"] {
            // A copy of its own, since a hydration the scripted stream left
            // unfinished would resume past its listings.
            let core = copy(&server);
            catalog();
            server.on(
                "/keys/current",
                vec![scripted::certified(scripted::json(
                    200,
                    &format!(
                        r#"{{"type_permissions":{{"core.note":"read","{readable}":"read"}}}}"#
                    ),
                ))],
            );
            server.on(
                "/items",
                vec![scripted::certified(scripted::json(
                    200,
                    r#"{"data":[],"next_cursor":null}"#,
                ))],
            );
            let listed = server.seen("/items").len();
            let hydrated = core.hydrate_until(
                &["core.note".into(), "core.entity".into()],
                SliceTier::Library,
                &[],
                &AtomicBool::new(false),
            );
            // Past the refusal: what the scripted stream does after that is
            // not this test's subject, the listing being asked is.
            assert!(
                !matches!(hydrated, Err(CoreError::Forbidden { .. })),
                "{readable}: {hydrated:?}"
            );
            assert!(
                server.seen("/items").len() > listed,
                "{readable}: no page was asked for"
            );
        }

        let core = copy(&server);
        catalog();
        server.on(
            "/keys/current",
            vec![scripted::certified(scripted::json(
                200,
                r#"{"type_permissions":{"core.note":"read"}}"#,
            ))],
        );
        match core.hydrate_until(
            &["core.note".into(), "core.entity".into()],
            SliceTier::Library,
            &[],
            &AtomicBool::new(false),
        ) {
            Err(CoreError::Forbidden { code, message }) => {
                assert_eq!(code, "type_not_permitted");
                assert!(message.contains("core.entity"), "{message}");
                assert!(!message.contains("core.note,"), "{message}");
            }
            other => panic!("a key reading nothing under the type was not refused: {other:?}"),
        }
    }

    /// A page of the listing holding the notes named, naming the page after
    /// it by `next`.
    fn page(ids: &[&str], next: Option<&str>) -> Answer {
        let data: Vec<Value> = ids
            .iter()
            .map(|id| {
                let payload: Value = serde_json::from_str(&scripted::item_payload(
                    "item.updated",
                    id,
                    "core.note",
                    1,
                ))
                .unwrap();
                json!({"item": payload["item"], "metadata": payload["metadata"], "listed": true})
            })
            .collect();
        let body = json!({"data": data, "next_cursor": next});
        scripted::certified(scripted::json(200, &body.to_string()))
    }

    /// A copy holding `first` with a tag queued on it, hydrating again in a
    /// thread whose second page waits for the signal returned, once the
    /// first page is in the copy.
    fn filling(
        server: &Scripted,
    ) -> (
        std::sync::Arc<Core>,
        std::sync::Arc<AtomicBool>,
        std::thread::JoinHandle<crate::Result<crate::HydrateReport>>,
    ) {
        let core = copy(server);
        {
            let conn = core.conn().unwrap();
            store::replace_catalog(&conn, &crate::builtin::catalog().unwrap()).unwrap();
            store::put_server_item(
                &conn,
                &store::testing::note("first", "first", "body", "2026-01-01T00:00:00Z"),
                Some(&[]),
                &crate::catalog::Catalog::load(&conn).unwrap(),
            )
            .unwrap();
        }
        core.add_tag("first", "kept").unwrap();
        let ready = std::sync::Arc::new(AtomicBool::new(false));
        server.on(
            "/items",
            vec![
                page(&["first"], Some("2")),
                Answer::WaitFor {
                    ready: std::sync::Arc::clone(&ready),
                    answer: Box::new(page(&["second", "third"], None)),
                },
            ],
        );
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                scripted::stream(
                    vec![
                        scripted::copy_marker("stream_cursor", "10"),
                        scripted::copy_marker("stream_live", "10"),
                    ],
                    Then::End,
                ),
            ],
        );
        let hydrating = {
            let core = std::sync::Arc::clone(&core);
            std::thread::spawn(move || hydrate(&core))
        };
        server.wait_for("/items", 2, std::time::Duration::from_secs(10));
        (core, ready, hydrating)
    }

    #[test]
    fn a_copy_filling_up_answers_what_it_holds_and_says_it_is_partial() {
        let server = Scripted::start();
        server.on(
            "/items/stats",
            vec![scripted::json(200, r#"{"core.note":3}"#)],
        );
        let (core, ready, hydrating) = filling(&server);

        let listed = core
            .list(&crate::ListFilters::default(), crate::Sort::default())
            .unwrap();
        assert_eq!(listed.completeness, crate::Completeness::Partial);
        assert_eq!(
            listed
                .rows
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["first"]
        );
        let found = core
            .search("first", &crate::SearchFilters::default(), 10)
            .unwrap();
        assert_eq!(found.completeness, crate::Completeness::Partial);
        assert_eq!(found.rows.len(), 1);
        let held = core.get("first").unwrap().unwrap();
        assert_eq!(
            held.tags,
            vec!["kept".to_string()],
            "a row taken while the copy fills did not show the tag waiting on it"
        );
        assert_eq!(
            core.get("second"),
            Err(CoreError::HydrationIncomplete),
            "a row not given yet was answered as absent"
        );
        let status = core.status().unwrap();
        assert_eq!(status.items, 1);
        assert_eq!(status.items_listed, Some(1));
        assert_eq!(status.items_expected, Some(3));

        ready.store(true, Ordering::SeqCst);
        assert_eq!(hydrating.join().unwrap().unwrap().items, 3);

        let listed = core
            .list(&crate::ListFilters::default(), crate::Sort::default())
            .unwrap();
        assert_eq!(listed.completeness, crate::Completeness::Complete);
        assert_eq!(listed.rows.len(), 3);
        assert_eq!(
            core.get("first").unwrap().unwrap().tags,
            vec!["kept".to_string()],
            "the queue laid over the row more than once"
        );
        // The witness for the refusal above: a whole copy answers a row it
        // does not hold as absent.
        assert_eq!(core.get("fourth"), Ok(None));
        assert_eq!(core.status().unwrap().items_expected, None);
    }

    /// The queue is laid over the copy before the walk of pins, so a pinned
    /// create the server committed, whose answer never came back, is held as
    /// its queued placeholder when the walk asks which pins it holds.
    #[test]
    fn a_pinned_create_whose_answer_was_lost_is_read_from_the_server() {
        let server = Scripted::start();
        let (core, _) = pinned_copy(&server, 0);
        let queued = core
            .create_item(&crate::Draft {
                r#type: "core.note".into(),
                properties: serde_json::from_value(json!({"title": "sent", "body": "kept"}))
                    .unwrap(),
                ..Default::default()
            })
            .unwrap();
        let id = queued.item_id.unwrap();
        store::pin(&core.conn().unwrap(), &id).unwrap();
        let committed: Value =
            serde_json::from_str(&scripted::item_payload("item.updated", &id, "core.note", 2))
                .unwrap();
        let body = json!({
            "items": [committed["item"]],
            "metadata": [{"item_id": id, "tags": [], "extensions": {}}],
            "listed": [false],
        });
        server.on(
            "/items/bulk-get",
            vec![scripted::certified(scripted::json(200, &body.to_string()))],
        );

        hydrate(&core).unwrap();

        assert_eq!(
            server.seen("/items/bulk-get").len(),
            1,
            "the pinned create was not read"
        );
        assert_eq!(core.get(&id).unwrap().unwrap().version, 2);
    }

    #[test]
    fn a_copy_filling_up_reports_the_rows_its_listings_brought_apart_from_pins_and_the_queue() {
        let server = Scripted::start();
        let core = copy(&server);
        store::replace_catalog(&core.conn().unwrap(), &crate::builtin::catalog().unwrap()).unwrap();
        core.create_item(&crate::Draft {
            r#type: "core.note".into(),
            properties: serde_json::from_value(json!({"title": "waiting", "body": "unsent"}))
                .unwrap(),
            ..Default::default()
        })
        .unwrap();
        store::pin(&core.conn().unwrap(), "pinned").unwrap();
        server.on(
            "/items/stats",
            vec![scripted::json(200, r#"{"core.note":2}"#)],
        );
        server.on("/items", vec![page(&["first", "second"], None)]);
        server.on("/items/bulk-get", vec![bulk(&[("pinned", false)])]);
        let ready = std::sync::Arc::new(AtomicBool::new(false));
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                Answer::WaitFor {
                    ready: std::sync::Arc::clone(&ready),
                    answer: Box::new(scripted::stream(
                        vec![
                            scripted::copy_marker("stream_cursor", "10"),
                            scripted::copy_marker("stream_live", "10"),
                        ],
                        Then::End,
                    )),
                },
            ],
        );
        let hydrating = {
            let core = std::sync::Arc::clone(&core);
            std::thread::spawn(move || hydrate(&core))
        };
        server.wait_for("/events", 2, std::time::Duration::from_secs(10));

        let status = core.status().unwrap();
        assert_eq!(status.hydration, Hydration::InProgress);
        // The witness: `items` counts the pin and the waiting create, so set
        // against the server's count it passes the whole.
        assert_eq!(status.items, 4);
        assert_eq!(
            (status.items_listed, status.items_expected),
            (Some(2), Some(2)),
            "the rows the listings brought counted a pin or a waiting create"
        );

        ready.store(true, Ordering::SeqCst);
        hydrating.join().unwrap().unwrap();
        let status = core.status().unwrap();
        assert_eq!((status.items_listed, status.items_expected), (None, None));
    }

    #[test]
    fn a_copy_filling_up_reports_no_expected_count_where_the_server_gave_none() {
        let server = Scripted::start();
        let (core, ready, hydrating) = filling(&server);
        let status = core.status().unwrap();
        assert_eq!(status.hydration, crate::Hydration::InProgress);
        assert_eq!(status.items_expected, None);
        ready.store(true, Ordering::SeqCst);
        assert!(hydrating.join().unwrap().is_ok());
    }

    /// A page of the listing holding rows of the types named, each an id and
    /// a type.
    fn page_of(rows: &[(&str, &str)]) -> Answer {
        page_then(rows, None)
    }

    fn page_then(rows: &[(&str, &str)], next: Option<&str>) -> Answer {
        let data: Vec<Value> = rows
            .iter()
            .map(|(id, row_type)| {
                let payload: Value =
                    serde_json::from_str(&scripted::item_payload("item.updated", id, row_type, 1))
                        .unwrap();
                json!({"item": payload["item"], "metadata": payload["metadata"], "listed": true})
            })
            .collect();
        let body = json!({"data": data, "next_cursor": next});
        scripted::certified(scripted::json(200, &body.to_string()))
    }

    fn at_head(server: &Scripted) {
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                scripted::stream(
                    vec![
                        scripted::copy_marker("stream_cursor", "10"),
                        scripted::copy_marker("stream_live", "10"),
                    ],
                    Then::End,
                ),
            ],
        );
    }

    fn hydrate_every_type(core: &Core) -> crate::Result<crate::HydrateReport> {
        core.hydrate_until(
            &["*".into()],
            SliceTier::Library,
            &[],
            &AtomicBool::new(false),
        )
    }

    #[test]
    fn a_slice_of_every_type_reads_the_listing_naming_no_type_and_holds_every_type_but_system() {
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/types",
            vec![scripted::certified(scripted::types(&[
                ("core.note", None),
                ("acme.thing", None),
                ("system.connection", None),
            ]))],
        );
        server.on(
            "/items",
            vec![page_of(&[("a", "core.note"), ("b", "acme.thing")])],
        );
        at_head(&server);

        let report = hydrate_every_type(&core).unwrap();

        assert_eq!(report.items, 2);
        assert_eq!(report.types, vec!["*".to_string()]);
        let listings = server.seen("/items");
        assert_eq!(listings.len(), 1);
        assert!(
            !listings[0].query.contains("type="),
            "a slice of every type named a type: {}",
            listings[0].query
        );
        assert_eq!(core.status().unwrap().slice_types, vec!["*".to_string()]);
        assert!(core.get("b").unwrap().is_some());
    }

    #[test]
    fn a_slice_of_every_type_refuses_the_star_beside_another_type_before_any_request() {
        for types in [
            vec!["*", "core.note"],
            vec!["core.note", "*"],
            vec!["*", "acme.*"],
        ] {
            let server = Scripted::start();
            let core = copy(&server);
            let before = server.asked();
            let refused = core
                .hydrate_until(
                    &types
                        .iter()
                        .map(|name| name.to_string())
                        .collect::<Vec<_>>(),
                    SliceTier::Library,
                    &[],
                    &AtomicBool::new(false),
                )
                .unwrap_err();
            assert!(
                matches!(refused, CoreError::Invalid(_)),
                "{types:?}: {refused:?}"
            );
            assert_eq!(server.asked(), before, "{types:?} reached the server");
        }
        // The witnesses: the star alone, repeated, is one declaration, and
        // an empty list is still refused.
        let server = Scripted::start();
        let core = copy(&server);
        server.on("/items", vec![page_of(&[])]);
        at_head(&server);
        assert!(
            core.hydrate_until(
                &["*".into(), " * ".into()],
                SliceTier::Library,
                &[],
                &AtomicBool::new(false),
            )
            .is_ok()
        );
        assert!(matches!(
            core.hydrate_until(&[], SliceTier::Library, &[], &AtomicBool::new(false)),
            Err(CoreError::Invalid(_))
        ));
    }

    #[test]
    fn a_slice_of_every_type_takes_named_system_types_beside_it() {
        for types in [vec!["*", "system.folder"], vec!["system.folder", " * "]] {
            let server = Scripted::start();
            let core = copy(&server);
            server.on(
                "/types",
                vec![scripted::certified(scripted::types(&[
                    ("core.note", None),
                    ("system.folder", None),
                ]))],
            );
            server.on(
                "/keys/current",
                vec![scripted::certified(scripted::refusal(403, "forbidden"))],
            );
            // The first answer is the probe of the named type.
            server.on(
                "/items",
                vec![
                    page_of(&[]),
                    page_of(&[("a", "core.note")]),
                    page_of(&[("f", "system.folder")]),
                ],
            );
            at_head(&server);
            let types: Vec<String> = types.iter().map(|name| name.to_string()).collect();

            let report = core
                .hydrate_until(&types, SliceTier::Library, &[], &AtomicBool::new(false))
                .unwrap();

            assert_eq!(report.items, 2, "{types:?}");
            assert!(core.get("a").unwrap().is_some(), "{types:?}");
            assert!(
                core.get("f").unwrap().is_some(),
                "{types:?}: a system type named beside the star was left out"
            );
        }
    }

    #[test]
    fn a_slice_of_every_type_expects_every_type_but_system_and_leaves_the_count_out_where_none_came()
     {
        let server = Scripted::start();
        server.on(
            "/items/stats",
            vec![scripted::json(
                200,
                r#"{"core.note":2,"acme.thing":3,"system.connection":7}"#,
            )],
        );
        server.on("/items", vec![page_of(&[("a", "core.note")])]);
        let core = copy(&server);
        let ready = std::sync::Arc::new(AtomicBool::new(false));
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                Answer::WaitFor {
                    ready: std::sync::Arc::clone(&ready),
                    answer: Box::new(scripted::stream(
                        vec![
                            scripted::copy_marker("stream_cursor", "10"),
                            scripted::copy_marker("stream_live", "10"),
                        ],
                        Then::End,
                    )),
                },
            ],
        );
        let hydrating = {
            let core = std::sync::Arc::clone(&core);
            std::thread::spawn(move || hydrate_every_type(&core))
        };
        server.wait_for("/events", 2, std::time::Duration::from_secs(10));
        let status = core.status().unwrap();
        assert_eq!(
            status.items_expected,
            Some(5),
            "the count of a slice of every type took a system type, or left a type out"
        );
        let asked = server.seen("/items/stats");
        assert!(
            !asked[0].query.contains("include=system"),
            "{}",
            asked[0].query
        );
        ready.store(true, Ordering::SeqCst);
        hydrating.join().unwrap().unwrap();

        // The count is left out, not zero, where the server gives none.
        let server = Scripted::start();
        server.on("/items/stats", vec![scripted::refusal(500, "internal")]);
        server.on("/items", vec![page_of(&[("a", "core.note")])]);
        let core = copy(&server);
        let ready = std::sync::Arc::new(AtomicBool::new(false));
        server.on(
            "/events",
            vec![
                scripted::stream(
                    vec![scripted::copy_marker("stream_cursor", "10")],
                    Then::End,
                ),
                Answer::WaitFor {
                    ready: std::sync::Arc::clone(&ready),
                    answer: Box::new(scripted::stream(
                        vec![
                            scripted::copy_marker("stream_cursor", "10"),
                            scripted::copy_marker("stream_live", "10"),
                        ],
                        Then::End,
                    )),
                },
            ],
        );
        let hydrating = {
            let core = std::sync::Arc::clone(&core);
            std::thread::spawn(move || hydrate_every_type(&core))
        };
        server.wait_for("/events", 2, std::time::Duration::from_secs(10));
        assert_eq!(core.status().unwrap().items_expected, None);
        ready.store(true, Ordering::SeqCst);
        hydrating.join().unwrap().unwrap();
    }

    #[test]
    fn a_slice_of_every_type_stopped_part_way_resumes_naming_no_type() {
        let server = Scripted::start();
        let core = copy(&server);
        server.on(
            "/items",
            vec![
                Answer::Slow {
                    after: std::time::Duration::from_millis(300),
                    answer: Box::new(page_then(&[("a", "core.note")], Some("after-a"))),
                },
                page_of(&[("b", "acme.thing")]),
            ],
        );
        at_head(&server);
        let stop = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let hydrating =
                scope.spawn(|| core.hydrate_until(&["*".into()], SliceTier::Library, &[], &stop));
            server.wait_for("/items", 1, std::time::Duration::from_secs(5));
            stop.store(true, Ordering::Relaxed);
            let _ = hydrating.join().unwrap();
        });
        assert_eq!(core.status().unwrap().hydration, Hydration::InProgress);

        let report = hydrate_every_type(&core).unwrap();
        assert!(report.resumed, "the second run did not resume the first");
        assert_eq!(report.restarted, None);
        assert_eq!([report.items, report.pages, report.pages_total], [2, 1, 2]);
        assert_eq!(core.status().unwrap().hydration, Hydration::Complete);
        let seen = server.seen("/items");
        assert_eq!(seen.len(), 2, "the resumed run read a page it held");
        assert!(seen[1].query.contains("after-a"), "{}", seen[1].query);
        assert!(
            server
                .seen("/items")
                .iter()
                .all(|seen| !seen.query.contains("type=")),
            "a run named a type"
        );
    }
}
