use std::collections::BTreeMap;

/// The process's environment as read once. A blank value counts as unset.
#[derive(Clone, Debug, Default)]
pub struct Environment {
    values: BTreeMap<String, String>,
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
