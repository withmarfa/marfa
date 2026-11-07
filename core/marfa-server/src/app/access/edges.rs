//! What a caller may do to edges.

use super::{Axis, Caller, Level};
use crate::app::refusal::Result;

impl Caller {
    /// An edge is read through its type and its source's type. Its target's
    /// type is not asked: an edge names that row by id alone.
    pub fn may_read_edge(&self, edge_type: &str, source_type: &str) -> bool {
        self.level_on(Axis::Edge, edge_type) >= Level::Read && self.may_read_type(source_type)
    }

    /// Whether an edge that cascades may stand on a target of `target_type`:
    /// it puts that row in reach of every move of its source to the bin, so
    /// it takes what writing that row takes. The reserved namespaces fence
    /// the item doors and not this one, since the row itself is not written.
    pub fn require_cascade_target(&self, target_type: &str) -> Result<()> {
        self.require_type_map(target_type, Level::Write)
    }
}
