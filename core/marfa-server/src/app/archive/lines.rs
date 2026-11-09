//! The NDJSON export, a page per read so a slow reader holds no snapshot open. Each page is
//! selected as the credential read at the start, and sent only while it still reads all of it.

use std::io;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::mpsc;

use super::{Body, EDGE_PAGE, Sender, channel, reads_row};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::edges;
use crate::app::faults::{FAIL_EXPORT_READ, HOLD_EXPORT_PAGE};
use crate::app::items::{self, reading};
use crate::app::query::{self, Ask};
use crate::app::refusal::Result;
use crate::db::io_refusal;

/// Items in one page, so a credential that ends or narrows stops the export within a page.
const PAGE: i64 = 100;

/// One page: its lines, where the next begins, and whether the credential now reads all of it.
struct Page {
    text: String,
    seqs: Vec<i64>,
    after: Option<i64>,
    whole: bool,
}

/// A page selected as `admitted` read, or for the first page, as the caller reads now.
async fn item_page(
    app: &App,
    caller: &Caller,
    admitted: Option<&Caller>,
    ask: &Ask,
    after: i64,
) -> Result<(Caller, Page)> {
    let (admitted, ask) = (admitted.cloned(), ask.clone());
    reading(app, caller, move |read| {
        read.faults().hold_blocking(HOLD_EXPORT_PAGE);
        if read.faults().fail(FAIL_EXPORT_READ, None) {
            return Err(io_refusal());
        }
        let admitted = admitted.unwrap_or_else(|| read.caller.clone());
        let selecting = read.as_caller(admitted.clone());
        let seqs = query::selected(&selecting, &ask, after, PAGE)?;
        let rows = items::archived(
            read.tx,
            &admitted,
            &read.catalog,
            &read.read_only,
            &seqs,
            false,
        )?;
        let whole = rows.iter().all(|row| reads_row(read, row));
        let mut text = String::new();
        for row in &rows {
            text.push_str(&row.line);
            text.push('\n');
        }
        Ok((
            read.caller.clone(),
            Page {
                text,
                after: seqs.last().copied(),
                seqs,
                whole,
            },
        ))
    })
    .await
}

async fn edge_page(
    app: &App,
    admitted: &Caller,
    exported: Arc<Vec<i64>>,
    after: i64,
) -> Result<Page> {
    let selecting = admitted.clone();
    reading(app, admitted, move |read| {
        let admitted = selecting;
        let page = edges::with_ends(read.tx, after, EDGE_PAGE)?;
        let next = page.last().map(|ended| ended.edge.seq());
        let mut text = String::new();
        let mut whole = true;
        for edges::Ended {
            edge,
            source,
            target,
            ..
        } in page
        {
            let carried = exported.binary_search(&source.seq).is_ok()
                && exported.binary_search(&target.seq).is_ok();
            if !carried || !admitted.may_read_edge(&edge.edge_type, &source.type_id) {
                continue;
            }
            whole &= read.caller.may_read_edge(&edge.edge_type, &source.type_id);
            text.push_str(&format!("{{\"edge\":{}}}\n", edge.answered()?));
        }
        Ok(Page {
            text,
            seqs: Vec::new(),
            after: next,
            whole,
        })
    })
    .await
}

impl App {
    /// Reads the first page before answering, so a refusal is an ordinary answer, then hands the
    /// rest to a task that reads a page as the client takes the last.
    pub async fn export_lines(self: &Arc<App>, caller: &Caller, ask: Ask) -> Result<Body> {
        let (admitted, first) = item_page(self, caller, None, &ask, 0).await?;
        self.audit_export(caller, "ndjson").await?;
        let (sender, body) = channel(1);
        let app = self.clone();
        tokio::spawn(async move {
            match send(&app, &admitted, &ask, first, &sender).await {
                Ok(()) => sender.finish(),
                Err(None) => tracing::info!("An NDJSON export's client left or stopped reading"),
                Err(Some(error)) => tracing::warn!(%error, "An NDJSON export ended short"),
            }
        });
        Ok(body)
    }
}

/// Waits for room for one page, so a page is read and checked only once it can be queued at
/// once. `None` where the client left or stopped reading.
async fn room<'a>(app: &App, sender: &'a Sender) -> Option<mpsc::Permit<'a, Bytes>> {
    match tokio::time::timeout(app.blob_read_idle(), sender.chunks.reserve()).await {
        Ok(Ok(permit)) => Some(permit),
        _ => None,
    }
}

const NARROWED: &str = "the export's credential no longer reads what it sends";

/// `Err(None)` where the client left, and `Err(Some(_))` where the export was cut short.
async fn send(
    app: &App,
    admitted: &Caller,
    ask: &Ask,
    first: Page,
    sender: &Sender,
) -> std::result::Result<(), Option<io::Error>> {
    let cut = |what: String| Some(io::Error::other(what));
    let mut exported = Vec::new();
    let mut page = Some(first);
    let mut after = 0;
    loop {
        let permit = room(app, sender).await.ok_or(None)?;
        let read = match page.take() {
            Some(first) => first,
            None => {
                item_page(app, admitted, Some(admitted), ask, after)
                    .await
                    .map_err(|refusal| cut(refusal.message.into_owned()))?
                    .1
            }
        };
        if !read.whole {
            return Err(cut(NARROWED.into()));
        }
        exported.extend(read.seqs);
        permit.send(Bytes::from(read.text));
        match read.after {
            Some(next) => after = next,
            None => break,
        }
    }
    let exported = Arc::new(exported);
    let mut after = 0;
    loop {
        let permit = room(app, sender).await.ok_or(None)?;
        let read = edge_page(app, admitted, exported.clone(), after)
            .await
            .map_err(|refusal| cut(refusal.message.into_owned()))?;
        if !read.whole {
            return Err(cut(NARROWED.into()));
        }
        permit.send(Bytes::from(read.text));
        match read.after {
            Some(next) => after = next,
            None => return Ok(()),
        }
    }
}
