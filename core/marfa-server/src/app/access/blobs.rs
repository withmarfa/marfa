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

    /// On the state the write commits: the bytes are held, and the caller uploaded or may read them.
    pub fn proves_blob(
        &self,
        held: bool,
        uploaded: impl FnOnce() -> Result<bool>,
        lenders: impl IntoIterator<Item = Result<Lender>>,
    ) -> Result<bool> {
        if matches!(self, Caller::Server) || !held {
            return Ok(false);
        }
        if self.reads_every_blob() || uploaded()? {
            return Ok(true);
        }
        self.may_read_blob(lenders)
    }

    /// A working credential may not name as a file's bytes a blob it did not prove. The answer
    /// is the same whether or not the bytes are held.
    pub fn require_file_bytes(&self, proved: bool) -> Result<()> {
        if proved || !matches!(self, Caller::Key(_) | Caller::App { .. }) {
            return Ok(());
        }
        Err(Refusal::new(
            Code::BlobNotFound,
            "blob_ref names bytes this credential has not uploaded and may not read. Upload \
             them with this credential, then write the item again.",
        )
        .with_detail("field", "blob_ref"))
    }

    pub fn reads_every_blob(&self) -> bool {
        self.holds(Permission::BlobsManage)
    }

    /// Stop at the first readable lender to avoid fetching the rest from storage.
    pub fn may_read_blob(&self, lenders: impl IntoIterator<Item = Result<Lender>>) -> Result<bool> {
        if self.reads_every_blob() {
            return Ok(true);
        }
        for lender in lenders {
            if self.may_read_lender(&lender?) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn may_read_lender(&self, lender: &Lender) -> bool {
        match lender {
            Lender::Item { type_id } => self.may_read_type(type_id),
            Lender::Edge {
                edge_type,
                source_type,
            } => self.may_read_edge(edge_type, source_type),
            Lender::Extension {
                namespace,
                item_type,
            } => self.may_read_extension(namespace) && self.may_read_type(item_type),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::access::Standing;

    fn asked() -> Result<bool> {
        panic!("not asked")
    }

    fn none() -> std::iter::Empty<Result<Lender>> {
        std::iter::empty()
    }

    #[test]
    fn a_write_for_no_credential_proves_nothing_whatever_it_holds() {
        let proved = Caller::Server.proves_blob(true, || Ok(true), none());
        assert!(!proved.unwrap());
        assert!(Caller::Server.require_file_bytes(false).is_ok());
    }

    #[test]
    fn a_local_caller_proves_every_held_blob_and_none_that_is_not_held() {
        let local = Caller::Local(Standing::default());
        assert!(local.proves_blob(true, asked, none()).unwrap());
        assert!(!local.proves_blob(false, asked, none()).unwrap());
        assert!(local.require_file_bytes(false).is_ok());
    }
}
