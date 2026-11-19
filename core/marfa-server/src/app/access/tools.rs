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

    pub fn may_manage_webhooks(&self) -> bool {
        self.holds(Permission::WebhooksManage)
    }

    pub fn may_change_settings(&self) -> bool {
        self.holds(Permission::ConfigManage)
    }

    pub fn may_purge_items(&self) -> bool {
        self.holds(Permission::ItemsPurge)
    }

    pub fn may_manage_apps(&self) -> bool {
        self.holds(Permission::GrantsManage)
    }

    pub fn may_manage_backups(&self) -> bool {
        self.holds(Permission::BackupsManage)
    }

    pub fn may_maintain(&self) -> bool {
        self.holds(Permission::InstanceMaintain)
    }

    pub fn may_manage_connectors(&self) -> bool {
        self.holds(Permission::ConnectorsManage)
    }

    pub fn may_manage_files(&self) -> bool {
        self.holds(Permission::BlobsManage)
    }

    pub fn may_manage_sign_ins(&self) -> bool {
        self.holds(Permission::SignInsManage)
    }
}
