//! How a setting's text is taken from the environment.

/// A variable's value without its surrounding space, where it has one: an
/// empty variable is an unset one.
pub fn text(get: &impl Fn(&str) -> Option<String>, name: &str) -> Option<String> {
    get(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Whether `OTEL_SDK_DISABLED` turns every report off. Only `true`, in any
/// case, does, as the OpenTelemetry specification asks; any other value
/// leaves telemetry as the other settings say.
pub fn disabled(get: &impl Fn(&str) -> Option<String>) -> bool {
    text(get, "OTEL_SDK_DISABLED").is_some_and(|value| value.eq_ignore_ascii_case("true"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn getter<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(set, _)| *set == name)
                .map(|(_, value)| value.to_string())
        }
    }

    #[test]
    fn the_sdk_can_be_disabled_the_standard_way() {
        assert!(disabled(&getter(&[("OTEL_SDK_DISABLED", "TRUE")])));
        assert!(disabled(&getter(&[("OTEL_SDK_DISABLED", " true ")])));
        for not in ["false", "1", "yes", ""] {
            assert!(!disabled(&getter(&[("OTEL_SDK_DISABLED", not)])), "{not}");
        }
        assert!(!disabled(&getter(&[])));
    }

    #[test]
    fn an_empty_variable_is_an_unset_one() {
        assert_eq!(text(&getter(&[("A", "  ")]), "A"), None);
        assert_eq!(text(&getter(&[("A", " b ")]), "A").as_deref(), Some("b"));
    }
}
