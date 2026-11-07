//! The settings that can change while the server runs. An entry here is all a
//! new one needs: it resolves from the environment, then its stored row, then
//! its default, and reads back typed from the snapshot.

use std::collections::HashMap;
use std::marker::PhantomData;

use super::Environment;
use super::rule;

#[derive(Clone, Copy, Debug)]
pub enum Rule {
    Whole { min: u64, max: u64 },
    Boolean,
}

/// One setting's name, rule and default.
#[derive(Debug)]
pub struct Entry {
    pub name: &'static str,
    pub rule: Rule,
    pub default: &'static str,
}

/// A registered setting, typed by what it reads as.
pub struct Setting<T: 'static> {
    pub entry: &'static Entry,
    kind: PhantomData<T>,
}

impl<T> Clone for Setting<T> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<T> Copy for Setting<T> {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Value {
    Whole(u64),
    Boolean(bool),
}

/// What a typed setting reads a resolved value as.
pub trait Kind {
    fn from_value(value: Value) -> Self;
}

impl Kind for u64 {
    fn from_value(value: Value) -> u64 {
        match value {
            Value::Whole(number) => number,
            Value::Boolean(flag) => u64::from(flag),
        }
    }
}

impl Kind for bool {
    fn from_value(value: Value) -> bool {
        match value {
            Value::Whole(number) => number != 0,
            Value::Boolean(flag) => flag,
        }
    }
}

macro_rules! registry {
    ($($constant:ident: $kind:ty = $name:literal, $rule:expr, $default:literal;)*) => {
        $(pub const $constant: Setting<$kind> = Setting {
            entry: &Entry { name: $name, rule: $rule, default: $default },
            kind: PhantomData,
        };)*
        pub const ENTRIES: &[&Entry] = &[$($constant.entry),*];
    };
}

registry! {
    MAX_REQUEST_BYTES: u64 = "MARFA_MAX_REQUEST_BYTES", Rule::Whole { min: 1, max: u64::MAX }, "1048576";
    DISK_RESERVE_BYTES: u64 = "MARFA_DISK_RESERVE_BYTES", Rule::Whole { min: 0, max: u64::MAX }, "134217728";
}

fn parse(entry: &Entry, text: &str) -> Result<Value, String> {
    match entry.rule {
        Rule::Whole { min, max } => rule::whole_number(text, min, max).map(Value::Whole),
        Rule::Boolean => rule::boolean(text).map(Value::Boolean),
    }
}

/// Every registered setting's value at one moment.
#[derive(Debug)]
pub struct Snapshot {
    values: HashMap<&'static str, Value>,
}

impl Snapshot {
    /// Resolves each entry. A value outside its rule adds its line to
    /// `problems`, and a stored row that has no entry is left alone.
    pub fn resolve(
        environment: &Environment,
        stored: &[(String, String)],
        problems: &mut Vec<String>,
    ) -> Snapshot {
        let mut values = HashMap::with_capacity(ENTRIES.len());
        for entry in ENTRIES {
            let row = stored
                .iter()
                .find(|(name, _)| name == entry.name)
                .map(|(_, value)| value.as_str());
            let text = environment.get(entry.name).or(row).unwrap_or(entry.default);
            match parse(entry, text) {
                Ok(value) => {
                    values.insert(entry.name, value);
                }
                Err(broken) => problems.push(rule::line(entry.name, &broken, text)),
            }
        }
        Snapshot { values }
    }

    pub fn get<T: Kind>(&self, setting: Setting<T>) -> T {
        let value = self.values.get(setting.entry.name).copied();
        T::from_value(value.unwrap_or_else(|| {
            parse(setting.entry, setting.entry.default)
                .expect("a registered default is inside its own rule")
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_is_inside_its_own_rule() {
        for entry in ENTRIES {
            assert!(parse(entry, entry.default).is_ok(), "{}", entry.name);
        }
    }
}
