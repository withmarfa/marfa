//! Settings the environment can turn on.

/// Whether the variable `name` is set to a true word (`1`, `true`, `yes` or
/// `on`, in any case). Empty, unset or any other value is off.
pub fn flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| is_true_word(&value))
}

fn is_true_word(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_true_word_turns_a_setting_on() {
        for word in ["1", "true", "TRUE", " yes ", "On"] {
            assert!(is_true_word(word), "{word:?}");
        }
        for word in ["", "0", "false", "no", "off", "2", "enabled"] {
            assert!(!is_true_word(word), "{word:?}");
        }
    }
}
