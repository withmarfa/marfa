//! The NDJSON export: item lines, then the edges between them, each page read on its own, so a
//! slow reader holds no snapshot open. Every page is selected as the credential read when the
//! export began, and sent only while the credential still stands and reads all of it.

use std::io;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::mpsc;

use super::{Body, EDGE_PAGE, PAGE, QUEUED, reads_row};
use crate::app::App;
use crate::app::access::Caller;
use crate::app::faults::FAIL_EXPORT_READ;
use crate::app::items::{self, reading};
use crate::app::query::{self, Ask};
use crate::app::refusal::Result;
use crate::app::edges;
use crate::db::io_refusal;

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
        if read.faults().fail(FAIL_EXPORT_READ, None) {
            return Err(io_refusal());
        }
        let admitted = admitted.unwrap_or_else(|| read.caller.clone());
        let selecting = read.as_caller(admitted.clone());
        let seqs = query::selected(&selecting, &ask, after, PAGE)?;
        let rows = items::archived(read.tx, &admitted, &read.catalog, &read.read_only, &seqs, false)?;
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
        let next = page.last().map(|(edge, ..)| edge.seq());
        let mut text = String::new();
        let mut whole = true;
        for (edge, source, target, _) in page {
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
        let (sender, body) = mpsc::channel(QUEUED);
        let app = self.clone();
        tokio::spawn(async move {
            if let Err(error) = send(&app, &admitted, &ask, first, &sender).await
                && let Some(error) = error
            {
                tracing::warn!(%error, "An NDJSON export ended short");
                let _ = sender.send(Err(error)).await;
            }
        });
        Ok(body)
    }
}

/// `Err(None)` where the client left, and `Err(Some(_))` where the export was cut short.
async fn send(
    app: &App,
    admitted: &Caller,
    ask: &Ask,
    first: Page,
    sender: &mpsc::Sender<io::Result<Bytes>>,
) -> std::result::Result<(), Option<io::Error>> {
    let cut = |what: String| Some(io::Error::other(what));
    let emit = |text: String| async move {
        if text.is_empty() {
            return Ok(());
        }
        let idle = app.blob_read_idle();
        match tokio::time::timeout(idle, sender.send(Ok(Bytes::from(text)))).await {
            Ok(Ok(())) => Ok(()),
            _ => Err(None),
        }
    };
    let mut exported = Vec::new();
    let mut page = first;
    loop {
        if !page.whole {
            return Err(cut("the export's credential no longer reads what it sends".into()));
        }
        exported.extend(page.seqs);
        emit(page.text).await?;
        let Some(after) = page.after else {
            break;
        };
        page = item_page(app, admitted, Some(admitted), ask, after)
            .await
            .map_err(|refusal| cut(refusal.message.into_owned()))?
            .1;
    }
    let exported = Arc::new(exported);
    let mut after = 0;
    loop {
        let page = edge_page(app, admitted, exported.clone(), after)
            .await
            .map_err(|refusal| cut(refusal.message.into_owned()))?;
        if !page.whole {
            return Err(cut("the export's credential no longer reads what it sends".into()));
        }
        emit(page.text).await?;
        match page.after {
            Some(next) => after = next,
            None => return Ok(()),
        }
    }
}
