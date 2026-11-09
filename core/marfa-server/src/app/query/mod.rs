//! Every door compiles through [`compile::selection`], which takes a [`Reach`], so no query of the
//! item tables leaves this module without the caller's type map, the `system.*` default and the
//! source filter in its `WHERE`.

mod compile;
mod cursor;
mod events;
mod listing;
mod matched;
mod order;
mod overview;
mod reach;
mod search;
mod sources;
mod views;

pub(crate) use compile::judge_type;
pub use compile::{Ask, Filter, States};
pub use cursor::{Position, SECRET_KEY, Secret, refused as bad_cursor};
pub(crate) use events::{Event, Recurrence, events, parents};
pub use listing::{By, Listing, list, stats};
pub(crate) use matched::{count_of_exact_type, matched, of_exact_type};
pub use order::Sort;
pub(crate) use overview::{Listed, held};
pub use search::{Search, search};
pub(crate) use sources::{carried, carries};
pub use views::{VIEW_TYPE, ViewPage, view_items};

#[cfg(test)]
mod tests;
