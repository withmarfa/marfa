//! [`compile::selection`] compiles the filter, states and reach that a listing, a search, an
//! export and the event queries share. A module that needs one row, a count or a queue reads
//! `items` with its own SQL.

mod compile;
mod counts;
mod cursor;
mod events;
mod export;
mod listing;
mod matched;
mod order;
mod overview;
mod reach;
mod search;
mod sorted;
mod sources;
mod views;

pub use compile::{Ask, Filter, States};
pub(crate) use compile::{Sql, judge_type, judge_type_within};
pub use counts::{Count, Counted, counts};
pub use cursor::{Position, SECRET_KEY, Secret, refused as bad_cursor};
pub(crate) use events::{Event, Recurrence, events, parents};
pub(crate) use export::selected;
pub use listing::{By, Listing, list, stats};
pub(crate) use matched::{count_of_exact_type, matched, of_exact_type};
pub use order::Sort;
pub(crate) use overview::{Listed, held};
pub(crate) use reach::readable_types;
pub use search::{Search, search};
pub(crate) use sources::{carried, carries};
pub use views::{VIEW_TYPE, ViewPage, view_items};

#[cfg(test)]
mod parity;
#[cfg(test)]
mod tests;
