const BOOLEAN_RULE: &str = "must be true or false (also 1/0, yes/no, on/off)";

pub const HOUR_SECONDS: u64 = 3_600;
pub const DAY_SECONDS: u64 = 86_400;
pub const YEAR_SECONDS: u64 = 31_536_000;
pub const TERABYTE: u64 = 1_099_511_627_776;
pub const MILLION: u64 = 1_000_000;

pub fn line(name: &str, rule: &str, value: &str) -> String {
    format!("{name} {rule} (got \"{value}\")")
}

pub fn whole_number(text: &str, min: u64, max: u64) -> Result<u64, String> {
    let rule = format!("must be a whole number, from {min} to {max}");
    let parsed = (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse::<u64>().ok())
        .flatten();
    parsed
        .filter(|number| (min..=max).contains(number))
        .ok_or(rule)
}

pub fn boolean(text: &str) -> Result<bool, String> {
    match text.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(BOOLEAN_RULE.to_string()),
    }
}

/// Digits with an optional fraction, as `0.25`; `.5`, `1e-1` and `NaN` are refused.
pub fn ratio(text: &str) -> Result<f64, String> {
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    let (whole, fraction) = text
        .split_once('.')
        .map_or((text, None), |(whole, fraction)| (whole, Some(fraction)));
    let shaped = digits(whole) && fraction.is_none_or(digits);
    shaped
        .then(|| text.parse::<f64>().ok())
        .flatten()
        .filter(|number| number.is_finite() && (0.0..=1.0).contains(number))
        .ok_or_else(|| "must be a number from 0 to 1".to_string())
}
