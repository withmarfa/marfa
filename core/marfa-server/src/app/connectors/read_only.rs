use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arc_swap::ArcSwap;
use rusqlite::{OptionalExtension, Transaction};

use super::store;
use crate::app::access::{Axis, Level};
use crate::app::catalog::Snapshot;
use crate::app::clock::Stamp;
use crate::app::keys;
use crate::app::refusal::{Refusal, Result};

#[derive(Clone, Copy)]
enum End {
    Never,
    At(i64),
    Unread,
}

struct Holding {
    end: End,
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
            let key = match keys::unrevoked_by_id(tx, &key_id) {
                Ok(Some(key)) => key,
                Ok(None) => continue,
                Err(_) => {
                    for source in keys::reach_of_unrevoked(tx, &key_id)? {
                        holdings.entry(source).or_default().push(Holding {
                            end: End::Unread,
                            declared: HashSet::new(),
                        });
                    }
                    continue;
                }
            };
            let map = key.grants.map(Axis::Type);
            let declared: HashSet<String> = declared
                .into_iter()
                .filter(|name| Axis::Type.level(map, name) == Level::Write)
                .collect();
            let end = match key.expires_at.as_deref() {
                None => End::Never,
                Some(at) => Stamp::parsed(at).map_or(End::Unread, |at| End::At(at.ms())),
            };
            let reached: HashSet<&String> = std::iter::once(&key.source)
                .chain(&key.grants.sources)
                .collect();
            for source in reached {
                holdings.entry(source.clone()).or_default().push(Holding {
                    end,
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
    let held: Option<i64> = tx
        .query_row("SELECT value FROM read_only_generation", [], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(held.unwrap_or(0))
}

/// The registrations as they stand, answered for a moment `now`.
#[derive(Clone)]
pub struct ReadOnly {
    registry: Arc<Registry>,
    now: i64,
}

impl ReadOnly {
    /// Refuses only a source a key reaches whose stored row does not read.
    pub fn of(&self, source: &str, type_id: &str) -> Result<bool> {
        let Some(held) = self.registry.holdings.get(source) else {
            return Ok(false);
        };
        let mut live = Vec::new();
        for holding in held {
            match holding.end {
                End::Unread => {
                    return Err(Refusal::internal(
                        "a key that registered a connector has a stored value that does not read",
                    ));
                }
                End::At(until) if until <= self.now => {}
                End::Never | End::At(_) => live.push(holding),
            }
        }
        Ok(!live.is_empty()
            && live
                .iter()
                .all(|holding| holding.declared.contains(type_id)))
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
        now: Stamp::read(now)?.ms(),
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
                end: until.map_or(End::Never, End::At),
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
        assert!(!registry(&[]).of("other", "rss.entry").unwrap());
        assert!(!registry(&[]).of("rss", "rss.entry").unwrap());
    }

    #[test]
    fn every_live_holding_must_list_the_type() {
        let both = registry(&[(None, &["rss.entry"]), (None, &["rss.entry", "x"])]);
        assert!(both.of("rss", "rss.entry").unwrap());
        let one = registry(&[(None, &["rss.entry"]), (None, &["other"])]);
        assert!(!one.of("rss", "rss.entry").unwrap());
    }

    #[test]
    fn an_expired_holding_no_longer_counts() {
        let lapsed = NOW - 86_400_000;
        let beside = registry(&[(Some(lapsed), &[]), (None, &["rss.entry"])]);
        assert!(beside.of("rss", "rss.entry").unwrap());
        let alone = registry(&[(Some(lapsed), &["rss.entry"])]);
        assert!(!alone.of("rss", "rss.entry").unwrap());
    }

    #[test]
    fn a_holding_whose_end_does_not_read_refuses_its_source_alone() {
        let mut beside = registry(&[(None, &["rss.entry"])]);
        Arc::get_mut(&mut beside.registry)
            .unwrap()
            .holdings
            .get_mut("rss")
            .unwrap()
            .push(Holding {
                end: End::Unread,
                declared: HashSet::new(),
            });
        assert!(beside.of("rss", "rss.entry").is_err());
        assert!(!beside.of("other", "rss.entry").unwrap());
    }
}
