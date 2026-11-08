const BOOLEAN_RULE: &str = "must be true or false (also 1/0, yes/no, on/off)";

pub const HOUR_MS: u64 = 3_600_000;
pub const DAY_MS: u64 = 86_400_000;
pub const WEEK_MS: u64 = 604_800_000;
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
