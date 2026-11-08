use super::{Axis, Caller, Level, Permission};

/// Which MCP tools a credential is offered; a tool it is not offered is not listed or run.
impl Caller {
    pub fn may_register_types(&self) -> bool {
        self.level_on(Axis::Metadata, "types") >= Level::Write
    }

    pub fn may_save_types(&self) -> bool {
        self.holds(Permission::SchemaWrite) || self.may_register_types()
    }

    pub fn writes_views(&self) -> bool {
        self.level_on(Axis::Type, "system.view") >= Level::Write
    }

    pub fn may_read_health(&self) -> bool {
        self.holds(Permission::InstanceRead) || self.holds(Permission::ConnectorsManage)
    }

    pub fn may_read_audit(&self) -> bool {
        self.holds(Permission::AuditRead)
    }

    pub fn may_use_key_door(&self) -> bool {
        self.manages_keys() || self.holds(Permission::KeysMint)
    }
}
