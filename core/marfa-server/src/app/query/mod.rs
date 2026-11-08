//! Every door compiles through [`compile::selection`], which takes a [`Reach`], so no query of the
//! item tables leaves this module without the caller's type map, the `system.*` default and the
//! source filter in its `WHERE`.

mod compile;
mod cursor;
mod listing;
mod order;
mod reach;
mod search;
mod sources;
mod views;

pub(crate) use compile::judge_type;
pub use compile::{Ask, Filter, States};
pub use cursor::{SECRET_KEY, Secret};
pub use listing::{By, Listing, list, stats};
pub use order::Sort;
pub use search::{Search, search};
pub(crate) use sources::{carried, carries};
pub use views::{VIEW_TYPE, ViewPage, view_items};

#[cfg(test)]
mod tests;
