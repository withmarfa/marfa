use std::collections::HashMap;
use std::path::Path;

use super::dead::{DeadEffect, effect_key, remaining_dead_fields};
use super::forget::read_of_row_owed_elsewhere;
use super::open::{OLDEST_UPGRADED, UPGRADES, make, statement, upgrade};
use super::queue::{QUEUE_COLUMNS, waiting_writes_for_edge};
use super::reads::tags_for;
use super::*;
use crate::error::CoreError;
use crate::model::{BlockedReason, ItemState, QueuedWrite, Subject, Tier, Verdict, WriteKind};
use crate::wire::WireItem;
use marfa_rules::catalog::Indexing;
use marfa_rules::wire::WireCatalog;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

mod attached_files;
mod catalog_and_index;
mod dead_effects;
mod forgetting;
mod laid_writes;
mod meta_keys;
mod meta_plans;
mod opening;
mod queue_writes;
mod row_writes;
