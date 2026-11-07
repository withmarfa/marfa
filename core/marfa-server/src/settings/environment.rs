use std::collections::BTreeMap;
use std::fmt;

/// The process's environment as read once. A blank value counts as unset.
#[derive(Clone, Default)]
pub struct Environment {
    values: BTreeMap<String, String>,
}

/// Names only, since some of the values are secrets.
impl fmt::Debug for Environment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.values.keys()).finish()
    }
}

impl Environment {
    pub fn of_process() -> Environment {
        Environment::from_iter(std::env::vars_os().map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        }))
    }

    pub fn from_pairs(pairs: &[(&str, &str)]) -> Environment {
        Environment::from_iter(
            pairs
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string())),
        )
    }

    fn from_iter(pairs: impl Iterator<Item = (String, String)>) -> Environment {
        Environment {
            values: pairs
                .filter(|(_, value)| !value.trim().is_empty())
                .collect(),
        }
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }
}
