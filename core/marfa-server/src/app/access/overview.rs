use super::{Axis, Caller, Level, Permission};

/// What a key or an app's token is and may do, as the overview tells it.
pub struct Described {
    pub app: bool,
    pub label: Option<String>,
    /// Type patterns by level: write, read, none; unknown stored levels deny.
    pub types: [Vec<String>; 3],
    pub permissions: Vec<Permission>,
}

impl Caller {
    /// Only a key or an app's token is a credential; the owner and the local command are not.
    pub fn described(&self) -> Option<Described> {
        let (key, app) = match self {
            Caller::Key(key) => (key, false),
            Caller::App { key, .. } => (key, true),
            Caller::Local(_) | Caller::Owner(_) | Caller::Server => return None,
        };
        let mut types: [Vec<String>; 3] = Default::default();
        for (pattern, level) in key.grants.map(Axis::Type).patterns() {
            let at = match level {
                Level::Write => 0,
                Level::Read => 1,
                Level::None => 2,
            };
            types[at].push(pattern.to_string());
        }
        for patterns in &mut types {
            patterns.sort_unstable();
        }
        Some(Described {
            app,
            label: (!app).then(|| key.label.clone()),
            types,
            permissions: Permission::ALL
                .into_iter()
                .filter(|permission| key.grants.holds(*permission))
                .collect(),
        })
    }

    pub fn edge_level(&self, edge_type: &str) -> Level {
        self.level_on(Axis::Edge, edge_type)
    }
}
