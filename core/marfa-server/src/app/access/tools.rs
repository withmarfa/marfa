use super::{Axis, Caller, Level, Permission};

macro_rules! admin_tasks {
    ($($task:ident => [$($permission:ident),+];)*) => {
        /// A group of `/mcp/admin` tools, opened by holding any one of its permissions.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum AdminTask {
            $($task,)*
        }

        impl AdminTask {
            pub const ALL: &[AdminTask] = &[$(AdminTask::$task,)*];

            pub const fn opened_by(self) -> &'static [Permission] {
                match self {
                    $(AdminTask::$task => &[$(Permission::$permission),+],)*
                }
            }
        }
    };
}

admin_tasks! {
    Health => [InstanceRead, ConnectorsManage];
    Audit => [AuditRead];
    Keys => [KeysManage, KeysMint];
    Webhooks => [WebhooksManage];
    Settings => [ConfigManage];
    Trash => [ItemsPurge];
    Apps => [GrantsManage];
    Backups => [BackupsManage];
    Maintain => [InstanceMaintain];
    Connectors => [ConnectorsManage];
    Files => [BlobsManage];
    SignIns => [SignInsManage];
    EndSignIn => [SignInsManage, GrantsManage];
}

impl AdminTask {
    /// Every permission that opens an `/mcp/admin` tool, each once.
    pub fn permissions() -> Vec<Permission> {
        let mut all: Vec<Permission> = Vec::new();
        for permission in Self::ALL.iter().flat_map(|task| task.opened_by()) {
            if !all.contains(permission) {
                all.push(*permission);
            }
        }
        all
    }
}

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

    pub fn may_do(&self, task: AdminTask) -> bool {
        task.opened_by()
            .iter()
            .any(|permission| self.holds(*permission))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_permission_but_schema_write_opens_an_admin_task() {
        let opening = AdminTask::permissions();
        for permission in Permission::ALL {
            assert_eq!(
                opening.contains(&permission),
                permission != Permission::SchemaWrite,
                "{}",
                permission.word()
            );
        }
        assert_eq!(opening.len(), Permission::ALL.len() - 1);
    }
}
