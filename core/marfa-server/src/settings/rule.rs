//! What a value may be, and the line a refusal gives when it is not.

const BOOLEAN_RULE: &str = "must be true or false (also 1/0, yes/no, on/off)";

pub fn line(name: &str, rule: &str, value: &str) -> String {
    format!("{name} {rule} (got \"{value}\")")
}

pub fn whole_number(text: &str, min: u64, max: u64) -> Result<u64, String> {
    let rule = if max == u64::MAX {
        format!("must be a whole number, {min} or more")
    } else {
        format!("must be a whole number, from {min} to {max}")
    };
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

pub fn one_of<'a>(text: &str, allowed: &[&'a str]) -> Result<&'a str, String> {
    allowed
        .iter()
        .find(|name| **name == text)
        .copied()
        .ok_or_else(|| format!("must be one of {}", allowed.join(", ")))
}
