use super::{Axis, Caller, Level};
use crate::app::refusal::Result;

impl Caller {
    pub fn may_read_edge(&self, edge_type: &str, from_type: &str) -> bool {
        self.level_on(Axis::Edge, edge_type) >= Level::Read && self.may_read_type(from_type)
    }

    /// As `may_read_edge`, for an edge whose from item is under `from_source`.
    pub fn may_read_edge_from(&self, edge_type: &str, from_type: &str, from_source: &str) -> bool {
        self.level_on(Axis::Edge, edge_type) >= Level::Read
            && self.may_read_item(from_type, from_source)
    }

    /// A cascading edge puts its target in reach of every move of its source to the bin,
    /// so it takes what writing that row takes. The reserved namespaces fence the item doors, not this one.
    pub fn require_cascade_to(&self, to_type: &str) -> Result<()> {
        self.require_type_map(to_type, Level::Write)
    }
}
