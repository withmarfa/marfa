//! Reading a whole number from a JSON body.

use serde_json::Value;

/// The largest whole number a JSON number carries exactly.
pub const LARGEST: i64 = 9_007_199_254_740_991;

/// A whole number within `-LARGEST..=LARGEST`, written `3` or `3.0`.
pub fn whole_of(value: &Value) -> Option<i64> {
    let whole = value.as_i64().or_else(|| {
        value
            .as_f64()
            .filter(|number| number.fract() == 0.0 && number.abs() <= LARGEST as f64)
            .map(|number| number as i64)
    })?;
    (-LARGEST..=LARGEST).contains(&whole).then_some(whole)
}

/// The refusal text for a `field` that is not a whole number from `least` to `LARGEST`.
pub fn whole_range(field: &str, least: i64) -> String {
    format!("{field} must be a whole number from {least} to {LARGEST}.")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_whole_number_is_read_written_with_or_without_a_fraction() {
        assert_eq!(whole_of(&json!(3)), Some(3));
        assert_eq!(whole_of(&json!(3.0)), Some(3));
        assert_eq!(whole_of(&json!(1e3)), Some(1000));
        assert_eq!(whole_of(&json!(LARGEST)), Some(LARGEST));
    }

    #[test]
    fn a_fraction_a_number_beyond_the_range_and_a_non_number_are_not_read() {
        assert_eq!(whole_of(&json!(1.5)), None);
        assert_eq!(whole_of(&json!(LARGEST + 1)), None);
        assert_eq!(whole_of(&json!(i64::MAX)), None);
        assert_eq!(whole_of(&json!(1e300)), None);
        assert_eq!(whole_of(&json!("2")), None);
        assert_eq!(whole_of(&json!(null)), None);
    }
}
