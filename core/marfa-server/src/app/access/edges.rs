use super::{Axis, Caller, Level};
use crate::app::refusal::Result;

impl Caller {
    pub fn may_read_edge(&self, edge_type: &str, source_type: &str) -> bool {
        self.level_on(Axis::Edge, edge_type) >= Level::Read && self.may_read_type(source_type)
    }

    /// A cascading edge puts its target in reach of every move of its source to the bin,
    /// so it takes what writing that row takes. The reserved namespaces fence the item doors, not this one.
    pub fn require_cascade_target(&self, target_type: &str) -> Result<()> {
        self.require_type_map(target_type, Level::Write)
    }
}
