use super::{Caller, Permission};
use crate::app::refusal::{Code, Refusal, Result};

impl Caller {
    /// Whether this is the key a registration was made under. An app's token is no key's.
    pub fn is_connector_key(&self, key_id: &str) -> bool {
        matches!(self, Caller::Key(key) if key.id == key_id)
    }

    pub fn manages_connectors(&self) -> bool {
        self.holds(Permission::ConnectorsManage)
    }

    /// A registration is made under a working key and no other credential.
    pub fn require_registering_key(&self) -> Result<()> {
        if matches!(self, Caller::Key(_)) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only a key registers a connector.",
            ))
        }
    }

    /// Whether the registration is one this caller may see.
    pub fn sees_connector(&self, key_id: &str) -> bool {
        self.is_connector_key(key_id) || self.manages_connectors()
    }

    pub fn require_own_connector_key(&self, key_id: &str) -> Result<()> {
        if self.is_connector_key(key_id) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only the connector's own key can do this.",
            ))
        }
    }

    pub fn require_connector_key_or_manager(&self, key_id: &str) -> Result<()> {
        if self.sees_connector(key_id) {
            Ok(())
        } else {
            Err(Refusal::new(
                Code::Forbidden,
                "Only the connector's own key or a manager can do this.",
            ))
        }
    }
}
