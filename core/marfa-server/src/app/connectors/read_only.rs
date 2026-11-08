use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arc_swap::ArcSwap;
use rusqlite::{OptionalExtension, Transaction};

use super::store;
use crate::app::access::{Axis, Level};
use crate::app::auth;
use crate::app::catalog::Snapshot;
use crate::app::keys;
use crate::app::refusal::{Refusal, Result};

const GENERATION: &str = "read_only_generation";

struct Holding {
    until: Option<i64>,
    declared: HashSet<String>,
}

/// The registrations that reach each source, as the database stood at `generation`.
pub struct Registry {
    generation: i64,
    holdings: HashMap<String, Vec<Holding>>,
}

impl Registry {
    pub fn empty() -> Registry {
        Registry {
            generation: -1,
            holdings: HashMap::new(),
        }
    }

    fn load(tx: &Transaction<'_>, generation: i64) -> Result<Registry> {
        let mut holdings: HashMap<String, Vec<Holding>> = HashMap::new();
        for (key_id, declared) in store::declared_by_keys(tx)? {
            let Some(key) = keys::unrevoked_by_id(tx, &key_id)? else {
                continue;
            };
            let map = key.grants.map(Axis::Type);
            let declared: HashSet<String> = declared
                .into_iter()
                .filter(|name| Axis::Type.level(map, name) == Level::Write)
                .collect();
            let until = key.expires_at.as_deref().map(auth::millis_of).transpose()?;
            let reached: HashSet<&String> = std::iter::once(&key.source)
                .chain(&key.grants.sources)
                .collect();
            for source in reached {
                holdings.entry(source.clone()).or_default().push(Holding {
                    until,
                    declared: declared.clone(),
                });
            }
        }
        Ok(Registry {
            generation,
            holdings,
        })
    }
}

fn generation(tx: &Transaction<'_>) -> Result<i64> {
    let held: Option<String> = tx
        .query_row(
            "SELECT value FROM instance WHERE key = ?1",
            [GENERATION],
            |row| row.get(0),
        )
        .optional()?;
    held.map_or(Ok(0), |text| {
        text.parse()
            .map_err(|_| Refusal::internal("the read-only generation did not read"))
    })
}

/// The registrations as they stand, answered for a moment `now`.
#[derive(Clone)]
pub struct ReadOnly {
    registry: Arc<Registry>,
    now: i64,
}

impl ReadOnly {
    pub fn of(&self, source: &str, type_id: &str) -> bool {
        let Some(held) = self.registry.holdings.get(source) else {
            return false;
        };
        let mut live = held
            .iter()
            .filter(|holding| holding.until.is_none_or(|until| until > self.now))
            .peekable();
        live.peek().is_some() && live.all(|holding| holding.declared.contains(type_id))
    }
}

/// A shared registry read from a newer snapshot is never replaced by an older one.
pub fn current(
    cache: &ArcSwap<Registry>,
    tx: &Transaction<'_>,
    now: &str,
    snapshot: Snapshot,
) -> Result<ReadOnly> {
    let held = cache.load_full();
    let wanted = generation(tx)?;
    let registry = if held.generation == wanted {
        held
    } else {
        let loaded = Arc::new(Registry::load(tx, wanted)?);
        if snapshot == Snapshot::Committed {
            cache.rcu(|shared| {
                if shared.generation < wanted {
                    loaded.clone()
                } else {
                    shared.clone()
                }
            });
        }
        loaded
    };
    Ok(ReadOnly {
        registry,
        now: auth::millis_of(now)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_767_225_600_000;

    type Held<'a> = (Option<i64>, &'a [&'a str]);

    fn registry(held: &[Held<'_>]) -> ReadOnly {
        let holdings = held
            .iter()
            .map(|(until, declared)| Holding {
                until: *until,
                declared: declared.iter().map(|name| name.to_string()).collect(),
            })
            .collect();
        ReadOnly {
            registry: Arc::new(Registry {
                generation: 0,
                holdings: HashMap::from([("rss".to_string(), holdings)]),
            }),
            now: NOW,
        }
    }

    #[test]
    fn a_source_nobody_registered_is_never_read_only() {
        assert!(!registry(&[]).of("other", "rss.entry"));
        assert!(!registry(&[]).of("rss", "rss.entry"));
    }

    #[test]
    fn every_live_holding_must_list_the_type() {
        let both = registry(&[(None, &["rss.entry"]), (None, &["rss.entry", "x"])]);
        assert!(both.of("rss", "rss.entry"));
        let one = registry(&[(None, &["rss.entry"]), (None, &["other"])]);
        assert!(!one.of("rss", "rss.entry"));
    }

    #[test]
    fn an_expired_holding_no_longer_counts() {
        let lapsed = NOW - 86_400_000;
        let beside = registry(&[(Some(lapsed), &[]), (None, &["rss.entry"])]);
        assert!(beside.of("rss", "rss.entry"));
        let alone = registry(&[(Some(lapsed), &["rss.entry"])]);
        assert!(!alone.of("rss", "rss.entry"));
    }
}
