//! What a listing, a count or a search reads, compiled to SQL over the item
//! tables.
//!
//! A [`Reach`] is what a caller may list, and only [`Reach::of`] makes one, in
//! the read transaction that also answers. Every door here compiles through
//! [`compile::selection`], which takes a reach, so no query of the item tables
//! leaves this module without the caller's type map, the `system.*` default
//! and the source filter in its `WHERE`.

mod compile;
mod cursor;
mod listing;
mod order;
mod reach;
mod search;
mod views;

pub use compile::{Ask, Filter, States};
pub use cursor::{SECRET_KEY, Secret};
pub use listing::{By, Listing, list, stats};
pub use order::Sort;
pub use search::{Search, search};
pub use views::{VIEW_TYPE, ViewPage, view_items};

#[cfg(test)]
mod tests;
