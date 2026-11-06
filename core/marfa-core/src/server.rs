//! The rules and tables a Marfa server shares with the working copy, for a
//! server built on this crate. Each item is the copy's own, so the two judge
//! a write the same way.

pub use crate::builtin::catalog as builtin_catalog;
pub use crate::catalog::{Catalog, Indexing, edge_type, edge_types, item_type, item_types};
pub use crate::store::{
    CatalogChange, META_CATALOG_VERSION, SCHEMA, index_item, replace_edge_types, replace_types,
};
pub use crate::time::normalize as normalize_time;
pub use crate::validation::{
    MAX_TAG_LENGTH, MAX_TAGS_PER_ITEM, id as validate_id,
    property_names as validate_property_names, tags as validate_tags,
};
pub use crate::wire::{WireCatalog, WireDisplayHints, WireType};
