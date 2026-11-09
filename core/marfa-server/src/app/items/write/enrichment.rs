use arc_swap::ArcSwap;
use rusqlite::Transaction;
use serde_json::{Map, Value, json};

use super::{FILE_BYTES, FILE_TYPE, Job, Referencing, Writing, parsed};
use crate::app::blobs::{Hash, references};
use crate::app::catalog::{self, Catalog, Snapshot as Reading};
use crate::app::items::{index, rows};
use crate::app::refusal::Result;
use crate::app::unit::Unit;

const TEXT: &str = "extracted_text";
const WIDTH: &str = "width";
const HEIGHT: &str = "height";
const DURATION: &str = "duration";

/// What a reading is made from, so that its result is kept only while the item still names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offered {
    pub id: String,
    pub type_id: String,
    /// The item's own `mime_type`, when it holds one.
    pub mime_type: Option<String>,
}

#[derive(Debug)]
pub enum Offer {
    /// The item no longer qualifies to read these bytes.
    Dropped,
    /// The item is in the bin. It is offered again once it is out.
    Binned,
    /// Everything its type declares is there already.
    Complete,
    Reading(Offered),
}

fn lacks(properties: &Map<String, Value>, name: &str) -> bool {
    properties.get(name).is_none_or(Value::is_null)
}

/// Judged on the state the transaction holds, so that what is read is what the item names now.
pub fn offer(tx: &Transaction<'_>, catalog: &Catalog, seq: i64, hash: &Hash) -> Result<Offer> {
    let Some(item) = rows::by_seq(tx, seq)? else {
        return Ok(Offer::Dropped);
    };
    let properties = parsed(&item.properties)?;
    let names = properties.get(FILE_BYTES).and_then(Value::as_str) == Some(hash.as_str());
    let lends =
        references::held(tx, Referencing::Item(item.seq))?.get(hash.as_str()) == Some(&true);
    if !names || !lends || !catalog.rules.matches(FILE_TYPE, &item.type_id) {
        return Ok(Offer::Dropped);
    }
    if item.state == "trashed" {
        return Ok(Offer::Binned);
    }
    let declared = catalog
        .rules
        .resolved(&item.type_id)
        .map_err(super::ruled)?;
    let wanted = [TEXT, WIDTH, HEIGHT, DURATION]
        .iter()
        .any(|name| declared.contains_key(*name) && lacks(&properties, name));
    if !wanted {
        return Ok(Offer::Complete);
    }
    let mime_type = properties
        .get("mime_type")
        .and_then(Value::as_str)
        .filter(|mime| !mime.trim().is_empty())
        .map(str::to_string);
    Ok(Offer::Reading(Offered {
        id: item.id,
        type_id: item.type_id,
        mime_type,
    }))
}

/// Whether a reading's inputs still stand on the state the transaction holds.
#[derive(Debug, PartialEq, Eq)]
pub enum Standing {
    /// The item offers the same reading, or needs none.
    Same,
    /// The item's type or `mime_type` is not what the reading used.
    Moved,
    /// The item no longer qualifies, or is in the bin.
    Out,
}

pub fn standing(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    seq: i64,
    hash: &Hash,
    read: &Offered,
) -> Result<Standing> {
    Ok(match offer(tx, catalog, seq, hash)? {
        Offer::Reading(now) if now != *read => Standing::Moved,
        Offer::Reading(_) | Offer::Complete => Standing::Same,
        Offer::Dropped | Offer::Binned => Standing::Out,
    })
}

/// What a reading found, for the item that named the bytes.
#[derive(Debug)]
pub struct Enriched {
    pub id: String,
    pub hash: Hash,
    pub text: Option<String>,
    pub size: Option<(u32, u32)>,
    pub duration: Option<f64>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Written {
    Landed,
    /// The item holds every field the reading gave.
    Nothing,
    /// The item no longer qualifies to receive this reading.
    Changed,
}

/// A change the server makes to a file item. No door that takes a caller's item may lead here.
pub(crate) fn apply_enrichment(
    unit: &Unit<'_, '_>,
    cache: &ArcSwap<Catalog>,
    enriched: Enriched,
) -> Result<Written> {
    let job = Job {
        unit,
        catalog: catalog::current(cache, unit.tx(), Reading::Pending)?,
        read_only: unit.read_only()?,
        claim: None,
        server_own: true,
    };
    job.enrich(enriched)
}

impl Job<'_, '_, '_> {
    fn enrich(&self, enriched: Enriched) -> Result<Written> {
        let tx = self.unit.tx();
        let Some(row) = rows::by_id(tx, &enriched.id)? else {
            return Ok(Written::Changed);
        };
        let current = parsed(&row.properties)?;
        let names = current.get(FILE_BYTES).and_then(Value::as_str) == Some(enriched.hash.as_str());
        let lends = references::held(tx, Referencing::Item(row.seq))?.get(enriched.hash.as_str())
            == Some(&true);
        if !names || !lends || row.state == "trashed" || !self.is_file(&row.type_id) {
            return Ok(Written::Changed);
        }
        let declared = self
            .catalog
            .rules
            .resolved(&row.type_id)
            .map_err(super::ruled)?;
        let mut fill = Map::new();
        let mut give = |name: &str, value: Option<Value>| {
            if let Some(value) = value
                && declared.contains_key(name)
                && lacks(&current, name)
            {
                fill.insert(name.to_string(), value);
            }
        };
        give(TEXT, enriched.text.map(Value::from));
        give(WIDTH, enriched.size.map(|(width, _)| Value::from(width)));
        give(HEIGHT, enriched.size.map(|(_, height)| Value::from(height)));
        give(DURATION, enriched.duration.map(Value::from));
        if fill.is_empty() {
            return Ok(Written::Nothing);
        }
        let names: Vec<&String> = fill.keys().collect();
        let details = json!({ "type": row.type_id, "fields": names });
        let (item, _) = self.landed(
            &row,
            &Writing {
                properties: Some(fill.clone()),
                version: Some(row.version),
                ..Writing::default()
            },
        )?;
        self.unit.audit("item", &item.id, Some(details))?;
        index::settle(tx, &self.catalog.rules)?;
        Ok(Written::Landed)
    }
}
