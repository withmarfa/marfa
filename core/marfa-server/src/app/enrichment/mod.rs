mod queue;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use marfa_enrichment::{
    DEFAULT_OCR_LANGUAGES, Limit, NATIVE, OcrOptions, Options, Reading, Refusal as Unread,
};
use serde_json::json;

use super::App;
use super::access::Caller;
use super::blobs::{Blob, CopyRecord, Hash, Opened};
use super::catalog::{self, Snapshot};
use super::housekeeping::{Report, Run};
use super::items::write::{
    Enriched, Offer, Offered, Standing, Written, apply_enrichment, offer, standing,
};
use super::refusal::{Code, Refusal, Result};
use crate::settings::registry::{
    ENRICHMENT_ENABLED, ENRICHMENT_MAX_ATTEMPTS, ENRICHMENT_MAX_BLOB_BYTES,
    ENRICHMENT_MAX_INFLATED_BYTES, ENRICHMENT_MAX_MEMORY_BYTES, ENRICHMENT_MAX_TEXT_CHARS,
    ENRICHMENT_OCR_ENABLED, Snapshot as Settings,
};
use queue::{Cap, Signatures, Why};

/// How long reading one file may take.
const ITEM_TIME_LIMIT: Duration = Duration::from_secs(60);

const ACTION: &str = "item.enrich";

/// What one run reads by: the settings as they stand when it starts.
struct Plan {
    options: Options,
    ocr: bool,
    batch: usize,
    max_attempts: u64,
    max_blob_bytes: u64,
    max_inflated_bytes: u64,
    max_memory_bytes: u64,
    signatures: Signatures,
}

impl Plan {
    fn of(app: &App) -> Plan {
        Plan::with(
            &app.settings.live(),
            app.settings.start.enrichment_tessdata_dir.clone(),
            app.settings.start.tuning.enrichment_batch,
        )
    }

    fn with(live: &Settings, data_dir: Option<PathBuf>, batch: u64) -> Plan {
        let ocr = live.get(ENRICHMENT_OCR_ENABLED);
        let max_blob_bytes = live.get(ENRICHMENT_MAX_BLOB_BYTES);
        let max_inflated = live.get(ENRICHMENT_MAX_INFLATED_BYTES);
        let max_memory = live.get(ENRICHMENT_MAX_MEMORY_BYTES);
        let options = Options {
            max_text_chars: usize::try_from(live.get(ENRICHMENT_MAX_TEXT_CHARS))
                .unwrap_or(usize::MAX),
            max_inflated_bytes: max_inflated,
            max_memory_bytes: max_memory,
            ocr: ocr.then(|| OcrOptions {
                languages: DEFAULT_OCR_LANGUAGES.to_string(),
                data_dir: data_dir.clone(),
            }),
            time_limit: ITEM_TIME_LIMIT,
            time_budget: None,
        };
        let languages = DEFAULT_OCR_LANGUAGES;
        let folder = data_dir
            .map(|folder| folder.display().to_string())
            .unwrap_or_default();
        Plan {
            options,
            ocr,
            batch: usize::try_from(batch).unwrap_or(usize::MAX - 1),
            max_attempts: live.get(ENRICHMENT_MAX_ATTEMPTS),
            max_blob_bytes,
            max_inflated_bytes: max_inflated,
            max_memory_bytes: max_memory,
            signatures: Signatures {
                native: NATIVE.to_string(),
                ocr: format!("{ocr}:{NATIVE}:{languages}:{folder}"),
                blob: max_blob_bytes,
                inflated: max_inflated,
                memory: max_memory,
            },
        }
    }

    fn attempts(&self) -> i64 {
        i64::try_from(self.max_attempts).unwrap_or(i64::MAX)
    }
}

/// What becomes of a file once it has been read or refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fate {
    Read,
    Skip(Why),
    /// Tried and failed: offered again until its attempts run out.
    Retry,
    /// No reader could start or confine itself. The file was not tried.
    Untried,
    /// The store did not give the bytes. The file was not tried.
    Unreached,
}

/// How a run counts a file that wrote nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Count {
    Extracted,
    Skipped,
    Failed,
    None,
}

impl Fate {
    fn count(self) -> Count {
        match self {
            Fate::Read | Fate::Untried | Fate::Unreached => Count::None,
            Fate::Skip(_) => Count::Skipped,
            Fate::Retry => Count::Failed,
        }
    }
}

fn fate_of_refusal(refusal: &Unread, plan: &Plan) -> Fate {
    match refusal {
        Unread::Unsupported => Fate::Skip(Why::Unsupported),
        Unread::Encrypted => Fate::Skip(Why::Encrypted),
        Unread::OverLimit(limit, _) => Fate::Skip(Why::OverLimit(match limit {
            Limit::Inflated => Cap::Inflated(plan.max_inflated_bytes),
            Limit::Memory => Cap::Memory(plan.max_memory_bytes),
            Limit::Fixed => Cap::Fixed,
        })),
        Unread::OcrUnavailable(_) => Fate::Skip(Why::Ocr),
        Unread::Malformed(_) | Unread::TimedOut | Unread::Crashed(_) => Fate::Retry,
        Unread::ReaderUnavailable(_) => Fate::Untried,
    }
}

/// What a reading gives the item, and the file's fate.
struct Judged {
    text: Option<String>,
    size: Option<(u32, u32)>,
    duration: Option<f64>,
    fate: Fate,
}

fn judge(read: std::result::Result<Reading, Unread>, mime: &str, plan: &Plan) -> Judged {
    let nothing = |fate| Judged {
        text: None,
        size: None,
        duration: None,
        fate,
    };
    let reading = match read {
        Ok(reading) => reading,
        Err(refusal) => return nothing(fate_of_refusal(&refusal, plan)),
    };
    let size = reading.dimensions.map(|size| (size.width, size.height));
    let text = (!reading.text.is_empty()).then_some(reading.text);
    let fate = if let Some(refusal) = &reading.text_refused {
        fate_of_refusal(refusal, plan)
    } else if (marfa_enrichment::is_image(mime) && size.is_none() && text.is_none())
        || (marfa_enrichment::ocr_applies(mime) && text.is_none() && !(plan.ocr && NATIVE))
    {
        Fate::Skip(Why::Ocr)
    } else {
        Fate::Read
    };
    Judged {
        text,
        size,
        duration: reading.duration,
        fate,
    }
}

#[derive(Default)]
struct Tally {
    extracted: u64,
    skipped: u64,
    failed: u64,
}

impl Tally {
    fn add(&mut self, count: Count) {
        match count {
            Count::Extracted => self.extracted += 1,
            Count::Skipped => self.skipped += 1,
            Count::Failed => self.failed += 1,
            Count::None => {}
        }
    }

    fn result(&self) -> serde_json::Value {
        json!({
            "extracted": self.extracted,
            "skipped": self.skipped,
            "failed": self.failed,
        })
    }
}

fn blocked(error: tokio::task::JoinError) -> Refusal {
    Refusal::internal(&format!("a file reading did not finish: {error}"))
}

/// The files to read next, once the settings have brought back the skips they reverse.
async fn pick(app: &Arc<App>, plan: &Plan) -> Result<(Vec<(i64, String)>, bool)> {
    let (signatures, attempts) = (plan.signatures.clone(), plan.attempts());
    let due = {
        let signatures = signatures.clone();
        app.db
            .read(move |tx| queue::due(tx, attempts, &signatures))
            .await?
    };
    if !due {
        return Ok((Vec::new(), false));
    }
    let limit = i64::try_from(plan.batch.saturating_add(1)).unwrap_or(i64::MAX);
    let mut files = app
        .write(&Caller::Server, ACTION, move |unit| {
            queue::requeue(unit.tx(), &signatures)?;
            queue::next(unit.tx(), attempts, limit)
        })
        .await?;
    let more = files.len() > plan.batch;
    files.truncate(plan.batch);
    Ok((files, more))
}

/// What the write before a reading found.
enum Begun {
    /// Nothing to read, and nothing to count.
    Nothing,
    Reading(Offered),
}

/// Persist the attempt before reading so a crash counts.
async fn begin(app: &Arc<App>, seq: i64, hash: &Hash) -> Result<Begun> {
    let (cache, hash) = (app.catalog_handle(), hash.clone());
    app.write(&Caller::Server, ACTION, move |unit| {
        let tx = unit.tx();
        let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
        Ok(match offer(tx, &catalog, seq, &hash)? {
            Offer::Dropped => {
                queue::drop_row(tx, seq, hash.as_str())?;
                Begun::Nothing
            }
            Offer::Binned => Begun::Nothing,
            Offer::Complete => {
                queue::read(tx, seq, hash.as_str(), &unit.at)?;
                Begun::Nothing
            }
            Offer::Reading(offered) => {
                queue::attempt(tx, seq, hash.as_str(), &unit.at)?;
                Begun::Reading(offered)
            }
        })
    })
    .await
}

fn record(
    tx: &rusqlite::Transaction<'_>,
    fate: Fate,
    seq: i64,
    hash: &Hash,
    signatures: &Signatures,
    at: &str,
) -> Result<()> {
    match fate {
        Fate::Read => queue::read(tx, seq, hash.as_str(), at),
        Fate::Skip(Why::Missing) => {
            queue::skip(tx, seq, hash.as_str(), Why::Missing, "", at)?;
            queue::refund(tx, seq, hash.as_str(), at)
        }
        Fate::Skip(why) => queue::skip(tx, seq, hash.as_str(), why, signatures.of(why), at),
        Fate::Retry => queue::defer(tx, seq, hash.as_str(), at),
        Fate::Untried | Fate::Unreached => queue::refund(tx, seq, hash.as_str(), at),
    }
}

/// Settles a reading in the transaction that checks its inputs still stand.
async fn store(
    app: &Arc<App>,
    plan: &Plan,
    seq: i64,
    hash: &Hash,
    offered: &Offered,
    judged: Judged,
) -> Result<Count> {
    let cache = app.catalog_handle();
    let (hash, signatures, offered) = (hash.clone(), plan.signatures.clone(), offered.clone());
    let Judged {
        text,
        size,
        duration,
        fate,
    } = judged;
    app.write(&Caller::Server, ACTION, move |unit| {
        let tx = unit.tx();
        let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
        if standing(tx, &catalog, seq, &hash, &offered)? != Standing::Same {
            queue::refund(tx, seq, hash.as_str(), &unit.at)?;
            return Ok(Count::None);
        }
        let enriched = Enriched {
            id: offered.id,
            hash: hash.clone(),
            text,
            size,
            duration,
        };
        let written = apply_enrichment(unit, &cache, enriched)?;
        if written == Written::Changed {
            return Ok(Count::None);
        }
        record(tx, fate, seq, &hash, &signatures, &unit.at)?;
        Ok(if written == Written::Landed {
            Count::Extracted
        } else {
            fate.count()
        })
    })
    .await
}

/// A reading that did not happen is settled the way a refusal of the same kind is.
async fn settle(
    app: &Arc<App>,
    plan: &Plan,
    seq: i64,
    hash: &Hash,
    offered: &Offered,
    fate: Fate,
) -> Result<Count> {
    let cache = app.catalog_handle();
    let (hash, signatures, offered) = (hash.clone(), plan.signatures.clone(), offered.clone());
    app.write(&Caller::Server, ACTION, move |unit| {
        let tx = unit.tx();
        let catalog = catalog::current(&cache, tx, Snapshot::Pending)?;
        let stands = standing(tx, &catalog, seq, &hash, &offered)? == Standing::Same;
        let restored = fate == Fate::Skip(Why::Missing) && App::copy_recorded(tx, &hash)?;
        if !stands || restored {
            queue::refund(tx, seq, hash.as_str(), &unit.at)?;
            return Ok(Count::None);
        }
        record(tx, fate, seq, &hash, &signatures, &unit.at)?;
        Ok(fate.count())
    })
    .await
}

/// Failed opens in a row after which an object store counts as down for the rest of a run.
const STORE_MISSES: u32 = 2;

/// What a run learned about the object stores: a remote store is asked no more once it is down.
#[derive(Default)]
struct Outage {
    down: HashSet<String>,
    /// Failed opens in a row for each remote store, which any file it serves ends.
    misses: HashMap<String, u32>,
    /// Files that failed alone, put behind every other file when the run ends.
    stranded: Vec<(i64, Hash)>,
}

impl Outage {
    async fn live_copies(app: &Arc<App>, hash: &Hash) -> Vec<CopyRecord> {
        let copies = app.blob_copies(&Caller::Server, hash).await;
        let mut live = copies.unwrap_or_default();
        live.retain(|copy| !copy.detached);
        live
    }

    /// Whether every copy of the file is in a store that is down.
    async fn holds(&self, app: &Arc<App>, hash: &Hash) -> bool {
        if self.down.is_empty() {
            return false;
        }
        let live = Self::live_copies(app, hash).await;
        !live.is_empty() && live.iter().all(|copy| self.down.contains(&copy.store_id))
    }

    /// A file served by its only store shows that the store answers.
    async fn opened(&mut self, app: &Arc<App>, hash: &Hash) {
        if self.misses.is_empty() {
            return;
        }
        if let [only] = Self::live_copies(app, hash).await.as_slice() {
            self.misses.remove(&only.store_id);
        }
    }

    /// One file that will not open, or a shortage of room here, says nothing of the stores.
    async fn failed(&mut self, app: &Arc<App>, seq: i64, hash: &Hash, refusal: &Refusal) {
        self.stranded.push((seq, hash.clone()));
        if refusal.code != Code::BlobStoreUnavailable {
            return;
        }
        for copy in Self::live_copies(app, hash).await {
            if copy.kind == "disk" {
                continue;
            }
            let misses = self.misses.entry(copy.store_id.clone()).or_default();
            *misses += 1;
            if *misses >= STORE_MISSES {
                self.down.insert(copy.store_id);
            }
        }
    }

    /// Hands the files that failed alone to the back of the line, behind the files deferred this run.
    async fn put_behind(&mut self, app: &Arc<App>) -> Result<()> {
        let stranded = std::mem::take(&mut self.stranded);
        if stranded.is_empty() {
            return Ok(());
        }
        app.write(&Caller::Server, ACTION, move |unit| {
            for (seq, hash) in &stranded {
                queue::behind(unit.tx(), *seq, hash.as_str(), &unit.at)?;
            }
            Ok(())
        })
        .await
    }
}

/// What one file came to.
enum Step {
    Counted(Count),
    /// Not tried or not readable now, and handed back with its attempt: the sweep gains nothing.
    Refunded,
}

/// The reading itself, on a thread of its own: the file is read in a process of its own too.
async fn read_blocking(
    file: Opened,
    mime: String,
    options: Options,
) -> Result<std::result::Result<Reading, Unread>> {
    tokio::task::spawn_blocking(move || {
        let read = marfa_enrichment::read(file.file(), &mime, &options);
        file.close();
        read
    })
    .await
    .map_err(blocked)
}

/// What one file came to. An `Err` is the server's own fault and ends the run.
async fn one(
    app: &Arc<App>,
    plan: &Plan,
    outage: &mut Outage,
    seq: i64,
    stored: &str,
) -> Result<Step> {
    let counted = |count: Result<Count>| count.map(Step::Counted);
    let Ok(hash) = Hash::parse(stored) else {
        let hash = stored.to_string();
        app.write(&Caller::Server, ACTION, move |unit| {
            queue::drop_row(unit.tx(), seq, &hash).map(|()| Count::None)
        })
        .await?;
        return Ok(Step::Counted(Count::None));
    };
    if outage.holds(app, &hash).await {
        let held = hash.clone();
        app.write(&Caller::Server, ACTION, move |unit| {
            queue::defer(unit.tx(), seq, held.as_str(), &unit.at)
        })
        .await?;
        return Ok(Step::Refunded);
    }
    let Begun::Reading(offered) = begin(app, seq, &hash).await? else {
        return Ok(Step::Counted(Count::None));
    };
    let (file, blob): (Opened, Blob) = match app.open_held(&hash).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            let fate = Fate::Skip(Why::Missing);
            return counted(settle(app, plan, seq, &hash, &offered, fate).await);
        }
        Err(refusal) => {
            outage.failed(app, seq, &hash, &refusal).await;
            settle(app, plan, seq, &hash, &offered, Fate::Unreached).await?;
            return Ok(Step::Refunded);
        }
    };
    outage.opened(app, &hash).await;
    let mime = offered
        .mime_type
        .clone()
        .unwrap_or_else(|| blob.mime_type.clone());
    if marfa_enrichment::loads_whole_file(&mime) && blob.size_bytes > plan.max_blob_bytes {
        let fate = Fate::Skip(Why::OverLimit(Cap::Blob(plan.max_blob_bytes)));
        return counted(settle(app, plan, seq, &hash, &offered, fate).await);
    }
    let read = read_blocking(file, mime.clone(), plan.options.clone()).await?;
    if let Err(Unread::ReaderUnavailable(reason)) = &read {
        settle(app, plan, seq, &hash, &offered, Fate::Untried).await?;
        return Err(Refusal::internal(&format!(
            "no file reader could start: {reason}"
        )));
    }
    let judged = judge(read, &mime, plan);
    let refunded = matches!(judged.fate, Fate::Untried | Fate::Unreached);
    let count = store(app, plan, seq, &hash, &offered, judged).await?;
    Ok(if refunded {
        Step::Refunded
    } else {
        Step::Counted(count)
    })
}

pub async fn sweep(app: Arc<App>, run: Run) -> Result<Report> {
    let mut tally = Tally::default();
    let live = app.settings.live();
    if !live.get(ENRICHMENT_ENABLED) {
        return Ok(Report::done(tally.result()));
    }
    let plan = Plan::of(&app);
    let (files, more) = pick(&app, &plan).await?;
    let (mut outage, mut progressed) = (Outage::default(), false);
    let mut again = false;
    for (seq, hash) in files {
        if !run.go_on().await || !app.settings.live().get(ENRICHMENT_ENABLED) {
            again = true;
            break;
        }
        if let Step::Counted(count) = one(&app, &plan, &mut outage, seq, &hash).await? {
            tally.add(count);
            progressed = true;
        }
        again = more && progressed;
    }
    outage.put_behind(&app).await?;
    Ok(Report {
        result: tally.result(),
        again,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    use tempfile::TempDir;

    use super::*;
    use crate::app::items::write::{Change, Put, Update};
    use crate::app::items::{self, Detail};
    use crate::settings::{Environment, Settings};

    async fn started() -> (TempDir, Arc<App>) {
        let dir = TempDir::new().unwrap();
        let database = dir.path().join("marfa.db");
        let blobs = dir.path().join("blobs");
        let socket = dir.path().join("s.sock");
        let pairs = [
            ("MARFA_DATABASE_PATH", database.to_str().unwrap()),
            ("MARFA_BLOB_PATH", blobs.to_str().unwrap()),
            ("MARFA_CONTROL_SOCKET", socket.to_str().unwrap()),
            ("MARFA_TEST_HOOKS", "true"),
            ("MARFA_ENRICHMENT_ENABLED", "true"),
        ];
        let settings = Settings::read(Environment::from_pairs(&pairs)).unwrap();
        (dir, App::start(settings).await.unwrap())
    }

    async fn upload(app: &Arc<App>, bytes: &[u8]) -> String {
        let caller = Caller::local();
        let mut intake = app
            .begin_upload(Some(bytes.len() as u64), "text/plain".into())
            .await
            .unwrap();
        intake.push(bytes.to_vec()).await.unwrap();
        let blob = app.finish_upload(&caller, intake).await.unwrap();
        blob.hash.as_str().to_string()
    }

    fn map(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    async fn file(app: &Arc<App>, bytes: &[u8]) -> (String, Hash) {
        let hash = upload(app, bytes).await;
        let put = Put {
            type_id: "core.file".into(),
            properties: Some(map(json!({ "blob_ref": hash, "mime_type": "text/plain" }))),
            ..Put::default()
        };
        let done = items::write::run(app, &Caller::local(), None, Change::Put(Box::new(put)))
            .await
            .unwrap();
        let made: Value = serde_json::from_str(&done.body).unwrap();
        let id = made["item"]["id"].as_str().unwrap().to_string();
        (id, Hash::parse(&hash).unwrap())
    }

    async fn properties(app: &App, id: &str) -> Value {
        let found = items::detail(
            app,
            &Caller::local(),
            id.to_string(),
            Detail::default(),
            None,
        )
        .await
        .unwrap();
        serde_json::from_str::<Value>(&found).unwrap()["item"]["properties"].clone()
    }

    async fn began(app: &Arc<App>, seq: i64, hash: &Hash) -> Offered {
        match begin(app, seq, hash).await.unwrap() {
            Begun::Reading(offered) => offered,
            Begun::Nothing => panic!("the file was not offered"),
        }
    }

    fn read_text(text: &str) -> Judged {
        Judged {
            text: Some(text.to_string()),
            size: None,
            duration: None,
            fate: Fate::Read,
        }
    }

    #[tokio::test]
    async fn bytes_that_changed_while_they_were_read_write_nothing() {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let (id, hash) = file(&app, b"first bytes").await;
        let (files, _) = pick(&app, &plan).await.unwrap();
        let (seq, _) = files[0].clone();
        let Begun::Reading(offered) = begin(&app, seq, &hash).await.unwrap() else {
            panic!("the file was not offered");
        };
        let other = upload(&app, b"other bytes").await;
        let update = Update {
            id: id.clone(),
            properties: Some(map(json!({ "blob_ref": other }))),
            version: 1,
            ..Update::default()
        };
        items::write::run(
            &app,
            &Caller::local(),
            None,
            Change::Update(Box::new(update)),
        )
        .await
        .unwrap();
        let counted = store(&app, &plan, seq, &hash, &offered, read_text("first bytes"))
            .await
            .unwrap();
        assert_eq!(counted, Count::None);
        assert!(properties(&app, &id).await.get("extracted_text").is_none());
    }

    #[tokio::test]
    async fn a_value_the_client_wrote_while_the_file_was_read_is_kept() {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let (id, hash) = file(&app, b"the file's own words").await;
        let (files, _) = pick(&app, &plan).await.unwrap();
        let (seq, _) = files[0].clone();
        let Begun::Reading(offered) = begin(&app, seq, &hash).await.unwrap() else {
            panic!("the file was not offered");
        };
        let update = Update {
            id: id.clone(),
            properties: Some(map(json!({ "extracted_text": "the client's words" }))),
            version: 1,
            ..Update::default()
        };
        items::write::run(
            &app,
            &Caller::local(),
            None,
            Change::Update(Box::new(update)),
        )
        .await
        .unwrap();
        let counted = store(
            &app,
            &plan,
            seq,
            &hash,
            &offered,
            read_text("the file's own words"),
        )
        .await
        .unwrap();
        assert_eq!(counted, Count::None);
        assert_eq!(
            properties(&app, &id).await["extracted_text"],
            "the client's words"
        );
    }

    #[tokio::test]
    async fn bytes_named_by_another_property_are_not_the_files_bytes() {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let named = upload(&app, b"bytes a description names").await;
        let (id, own) = file(&app, b"the file's own bytes").await;
        let update = Update {
            id,
            properties: Some(map(json!({ "description": format!("see {named}") }))),
            version: 1,
            ..Update::default()
        };
        items::write::run(
            &app,
            &Caller::local(),
            None,
            Change::Update(Box::new(update)),
        )
        .await
        .unwrap();
        let (files, _) = pick(&app, &plan).await.unwrap();
        assert_eq!(files.len(), 2);
        let other = Hash::parse(&named).unwrap();
        for (seq, stored) in files {
            let hash = Hash::parse(&stored).unwrap();
            let began = begin(&app, seq, &hash).await.unwrap();
            assert_eq!(matches!(began, Begun::Reading(_)), hash == own, "{stored}");
            assert_eq!(hash == other, !matches!(began, Begun::Reading(_)));
        }
        assert_eq!(pick(&app, &plan).await.unwrap().0.len(), 1);
    }

    #[tokio::test]
    async fn a_file_in_the_bin_is_not_written_and_waits() {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let (id, hash) = file(&app, b"binned bytes").await;
        let (files, _) = pick(&app, &plan).await.unwrap();
        let (seq, _) = files[0].clone();
        let Begun::Reading(offered) = begin(&app, seq, &hash).await.unwrap() else {
            panic!("the file was not offered");
        };
        items::write::run(
            &app,
            &Caller::local(),
            None,
            Change::Delete {
                id: id.clone(),
                version: None,
            },
        )
        .await
        .unwrap();
        let counted = store(&app, &plan, seq, &hash, &offered, read_text("binned bytes"))
            .await
            .unwrap();
        assert_eq!(counted, Count::None);
        assert!(pick(&app, &plan).await.unwrap().0.is_empty());
    }

    #[tokio::test]
    async fn an_attempt_is_counted_before_the_file_is_read() {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let (_, hash) = file(&app, b"a file that stops the server").await;
        for _ in 0..plan.max_attempts {
            let (files, _) = pick(&app, &plan).await.unwrap();
            assert_eq!(files.len(), 1);
            begin(&app, files[0].0, &hash).await.unwrap();
        }
        assert!(pick(&app, &plan).await.unwrap().0.is_empty());
    }

    async fn waiting_after(cap: Cap, change: impl Fn(&mut Signatures)) -> usize {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let (_, hash) = file(&app, b"a file past a limit").await;
        let (files, _) = pick(&app, &plan).await.unwrap();
        let offered = began(&app, files[0].0, &hash).await;
        settle(
            &app,
            &plan,
            files[0].0,
            &hash,
            &offered,
            Fate::Skip(Why::OverLimit(cap)),
        )
        .await
        .unwrap();
        assert!(pick(&app, &plan).await.unwrap().0.is_empty());
        let mut other = Plan::of(&app);
        change(&mut other.signatures);
        pick(&app, &other).await.unwrap().0.len()
    }

    #[tokio::test]
    async fn a_skip_comes_back_only_when_the_limit_that_stopped_it_is_raised() {
        let now = Plan::of(&started().await.1).signatures;
        let caps = [
            Cap::Blob(now.blob),
            Cap::Inflated(now.inflated),
            Cap::Memory(now.memory),
        ];
        let raise: [fn(&mut Signatures); 3] =
            [|s| s.blob += 1, |s| s.inflated += 1, |s| s.memory += 1];
        let lower: [fn(&mut Signatures); 3] =
            [|s| s.blob -= 1, |s| s.inflated -= 1, |s| s.memory -= 1];
        for (stopped, cap) in caps.into_iter().enumerate() {
            for (changed, (up, down)) in raise.iter().zip(lower.iter()).enumerate() {
                let back = usize::from(stopped == changed);
                assert_eq!(
                    waiting_after(cap, up).await,
                    back,
                    "{cap:?} raised {changed}"
                );
                assert_eq!(
                    waiting_after(cap, down).await,
                    0,
                    "{cap:?} lowered {changed}"
                );
            }
            let unrelated = |s: &mut Signatures| {
                s.ocr.push('+');
                s.native.push('+');
            };
            assert_eq!(waiting_after(cap, unrelated).await, 0);
        }
    }

    #[tokio::test]
    async fn a_skip_for_a_bound_of_the_readers_does_not_come_back() {
        let raised = |s: &mut Signatures| {
            s.blob += 1;
            s.inflated += 1;
            s.memory += 1;
        };
        assert_eq!(waiting_after(Cap::Fixed, raised).await, 0);
    }

    #[tokio::test]
    async fn an_encrypted_file_is_left_whatever_the_settings() {
        let (_dir, app) = started().await;
        let plan = Plan::of(&app);
        let (_, hash) = file(&app, b"locked").await;
        let (files, _) = pick(&app, &plan).await.unwrap();
        let offered = began(&app, files[0].0, &hash).await;
        settle(
            &app,
            &plan,
            files[0].0,
            &hash,
            &offered,
            Fate::Skip(Why::Encrypted),
        )
        .await
        .unwrap();
        let mut changed = Plan::of(&app);
        changed.signatures.native.push('+');
        changed.signatures.blob += 1;
        changed.signatures.inflated += 1;
        changed.signatures.memory += 1;
        changed.signatures.ocr.push('+');
        assert!(pick(&app, &changed).await.unwrap().0.is_empty());
    }

    fn reading(text: &str) -> Reading {
        Reading {
            text: text.to_string(),
            truncated: false,
            cut_short: false,
            dimensions: None,
            duration: None,
            text_refused: None,
        }
    }

    fn plan_with(ocr: bool) -> Plan {
        let mut plan = Plan::with(
            &crate::settings::registry::Snapshot::resolve(&Default::default(), &[], 0),
            None,
            8,
        );
        plan.ocr = ocr;
        plan
    }

    #[test]
    fn a_refusal_is_treated_by_its_kind() {
        let plan = plan_with(true);
        let fate = |refusal| judge(Err(refusal), "application/pdf", &plan).fate;
        assert_eq!(fate(Unread::Unsupported), Fate::Skip(Why::Unsupported));
        assert_eq!(fate(Unread::Encrypted), Fate::Skip(Why::Encrypted));
        assert_eq!(
            fate(Unread::OverLimit(Limit::Memory, "x".into())),
            Fate::Skip(Why::OverLimit(Cap::Memory(plan.max_memory_bytes)))
        );
        assert_eq!(
            fate(Unread::OverLimit(Limit::Inflated, "x".into())),
            Fate::Skip(Why::OverLimit(Cap::Inflated(plan.max_inflated_bytes)))
        );
        assert_eq!(
            fate(Unread::OverLimit(Limit::Fixed, "x".into())),
            Fate::Skip(Why::OverLimit(Cap::Fixed))
        );
        assert_eq!(
            fate(Unread::OcrUnavailable("x".into())),
            Fate::Skip(Why::Ocr)
        );
        assert_eq!(fate(Unread::Malformed("x".into())), Fate::Retry);
        assert_eq!(fate(Unread::TimedOut), Fate::Retry);
        assert_eq!(fate(Unread::Crashed("x".into())), Fate::Retry);
        assert_eq!(fate(Unread::ReaderUnavailable("x".into())), Fate::Untried);
    }

    #[test]
    fn an_image_read_without_ocr_is_left_until_ocr_is_on() {
        let mut sized = reading("");
        sized.dimensions = Some(marfa_enrichment::Dimensions {
            width: 3,
            height: 2,
        });
        let off = judge(Ok(sized), "image/png", &plan_with(false));
        assert_eq!(off.size, Some((3, 2)));
        if NATIVE {
            assert_eq!(off.fate, Fate::Skip(Why::Ocr));
        }
        let none = judge(Ok(reading("")), "image/gif", &plan_with(false));
        assert_eq!(none.fate, Fate::Skip(Why::Ocr));
        let plain = judge(Ok(reading("words")), "text/plain", &plan_with(false));
        assert_eq!(plain.fate, Fate::Read);
    }
}
