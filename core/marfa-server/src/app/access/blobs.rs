use super::{Axis, Caller, Level, Permission};
use crate::app::blobs::Lender;
use crate::app::refusal::{Code, Refusal, Result};

impl Caller {
    /// The blob doors for a caller whose type map reaches no type, refused ahead of the hash.
    pub fn require_blob_reach(&self) -> Result<()> {
        if self.holds(Permission::BlobsManage) {
            return Ok(());
        }
        self.require_reach()
    }

    /// Whoever manages blobs, or holds write on a registered type outside `system.*`, may upload.
    pub fn require_upload<'a>(&self, registered: impl IntoIterator<Item = &'a str>) -> Result<()> {
        if self.holds(Permission::BlobsManage) {
            return Ok(());
        }
        let may = registered.into_iter().any(|type_id| {
            type_id.split('.').next() != Some("system")
                && self.level_on(Axis::Type, type_id) >= Level::Write
        });
        if may {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::TypeNotPermitted,
                "This credential holds write on no type a file can be kept under, so it may not upload.",
            ))
        }
    }

    pub fn reads_every_blob(&self) -> bool {
        self.holds(Permission::BlobsManage)
    }

    /// A blob is read through a row that lends it and that the caller may read: an item of a
    /// readable type, an edge its map and its source's type reach, or an extension its map
    /// reaches on an item of a readable type. Whoever manages blobs reads every blob held.
    pub fn may_read_blob(&self, lenders: &[Lender]) -> bool {
        if self.reads_every_blob() {
            return true;
        }
        lenders.iter().any(|lender| match lender {
            Lender::Item { type_id } => self.may_read_type(type_id),
            Lender::Edge {
                edge_type,
                source_type,
            } => self.may_read_edge(edge_type, source_type),
            Lender::Extension {
                namespace,
                item_type,
            } => self.may_read_extension(namespace) && self.may_read_type(item_type),
        })
    }
}
