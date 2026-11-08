//! Reading the lines of a `recurrence`: one `RRULE`, and the dates an `RDATE` adds and an
//! `EXDATE` removes.

use std::collections::{BTreeSet, HashMap};

use super::calendar::{DAY, Zone, days_from_civil, days_in_month};

pub const SECONDLY: u8 = 0;
pub const MINUTELY: u8 = 1;
pub const HOURLY: u8 = 2;
pub const DAILY: u8 = 3;
pub const WEEKLY: u8 = 4;
pub const MONTHLY: u8 = 5;
pub const YEARLY: u8 = 6;

const FREQUENCIES: [&str; 7] = [
    "SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY",
];
const WEEKDAYS: [&str; 7] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateValue {
    /// A day number.
    Date(i64),
    /// Seconds of a wall clock that names no zone.
    Floating(i64),
    /// Milliseconds since the epoch.
    Instant(i64),
}

#[derive(Clone, Debug)]
pub struct Rule {
    pub freq: u8,
    pub interval: i64,
    pub count: Option<i64>,
    pub until: Option<DateValue>,
    pub bysecond: Option<Vec<i64>>,
    pub byminute: Option<Vec<i64>>,
    pub byhour: Option<Vec<i64>>,
    pub byweekday: Option<BTreeSet<i64>>,
    pub bynweekday: Option<Vec<(i64, i64)>>,
    pub bymonthday: Option<Vec<i64>>,
    pub byyearday: Option<Vec<i64>>,
    pub byweekno: Option<Vec<i64>>,
    pub bymonth: Option<Vec<i64>>,
    pub bysetpos: Option<Vec<i64>>,
    pub wkst: i64,
}

pub type Refusal = String;

fn read_int(raw: &str, part: &str, min: i64, max: i64) -> Result<i64, Refusal> {
    let digits = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    if digits.is_empty() || digits.len() > 6 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("{part} has an unreadable value: {raw}"));
    }
    let number: i64 = raw
        .trim_start_matches('+')
        .parse()
        .map_err(|_| format!("{part} has an unreadable value: {raw}"))?;
    if number < min || number > max {
        return Err(format!("{part} value {raw} is out of range"));
    }
    Ok(number)
}

fn read_list(raw: &str, part: &str, min: i64, max: i64, signed: bool) -> Result<Vec<i64>, Refusal> {
    let mut values = BTreeSet::new();
    for entry in raw.split(',') {
        let number = if signed {
            read_int(entry, part, -max, max)?
        } else {
            read_int(entry, part, min, max)?
        };
        if signed && number == 0 {
            return Err(format!("{part} may not be 0"));
        }
        values.insert(number);
    }
    Ok(values.into_iter().collect())
}

pub struct Line<'a> {
    pub name: String,
    pub params: HashMap<String, &'a str>,
    pub value: &'a str,
}

/// Splits `NAME;PARAM=V;PARAM="V":VALUE` at the first colon outside quotes.
pub fn split_line(line: &str) -> Result<Line<'_>, Refusal> {
    let mut quoted = false;
    let mut colon = None;
    for (at, ch) in line.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                colon = Some(at);
                break;
            }
            _ => {}
        }
    }
    let Some(colon) = colon else {
        return Err(format!("not a property line: {line}"));
    };
    let mut head = line[..colon].split(';');
    let name = head.next().unwrap_or_default().trim().to_uppercase();
    let mut params = HashMap::new();
    for param in head {
        let Some((key, value)) = param.split_once('=') else {
            return Err(format!("unreadable parameter: {param}"));
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|inner| inner.strip_suffix('"'))
            .unwrap_or(value);
        params.insert(key.trim().to_uppercase(), value);
    }
    Ok(Line {
        name,
        params,
        value: line[colon + 1..].trim(),
    })
}

fn read_day(year: i64, month: i64, day: i64, raw: &str) -> Result<i64, Refusal> {
    if year < 1 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return Err(format!("not a calendar date: {raw}"));
    }
    Ok(days_from_civil(year, month, day))
}

fn number(text: &str) -> i64 {
    text.bytes()
        .fold(0, |sum, byte| sum * 10 + i64::from(byte - b'0'))
}

/// A date or date-time value; a `TZID` anchors a zone-less reading at once.
pub fn read_date_value(raw: &str, params: &HashMap<String, &str>) -> Result<DateValue, Refusal> {
    let kind = params.get("VALUE").copied();
    let value = raw.trim().to_uppercase();
    let bytes = value.as_bytes();
    let digits = |from: usize, to: usize| {
        bytes
            .get(from..to)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    if bytes.len() == 8 && digits(0, 8) {
        if kind.is_some_and(|kind| kind != "DATE") {
            return Err(format!("{raw} is not a {}", kind.unwrap_or_default()));
        }
        let day = read_day(
            number(&value[0..4]),
            number(&value[4..6]),
            number(&value[6..8]),
            raw,
        )?;
        return Ok(DateValue::Date(day));
    }
    let zulu = bytes.len() == 16 && bytes[15] == b'Z';
    let shape = (bytes.len() == 15 || zulu) && bytes[8] == b'T' && digits(0, 8) && digits(9, 15);
    if !shape {
        return Err(format!("not a date or date-time: {raw}"));
    }
    if kind.is_some_and(|kind| kind != "DATE-TIME") {
        return Err(format!("{raw} is not a {}", kind.unwrap_or_default()));
    }
    let (hour, minute, second) = (
        number(&value[9..11]),
        number(&value[11..13]),
        number(&value[13..15]),
    );
    if hour > 23 || minute > 59 || second > 59 {
        return Err(format!("not a time of day: {raw}"));
    }
    let wall = read_day(
        number(&value[0..4]),
        number(&value[4..6]),
        number(&value[6..8]),
        raw,
    )? * DAY
        + hour * 3600
        + minute * 60
        + second;
    if zulu {
        return Ok(DateValue::Instant(wall * 1000));
    }
    if let Some(tzid) = params.get("TZID") {
        let Some(zone) = Zone::named(tzid) else {
            return Err(format!("TZID does not name a time zone: {tzid}"));
        };
        return Ok(DateValue::Instant(zone.instant_of(wall)));
    }
    Ok(DateValue::Floating(wall))
}

pub fn read_rule(value: &str) -> Result<Rule, Refusal> {
    let mut parts: Vec<(String, String)> = Vec::new();
    for piece in value.split(';') {
        if piece.trim().is_empty() {
            continue;
        }
        let Some((key, raw)) = piece.split_once('=') else {
            return Err(format!("unreadable rule part: {piece}"));
        };
        let key = key.trim().to_uppercase();
        if parts.iter().any(|(held, _)| *held == key) {
            return Err(format!("{key} appears twice"));
        }
        parts.push((key, raw.trim().to_uppercase()));
    }
    let Some((_, name)) = parts.iter().find(|(key, _)| key == "FREQ") else {
        return Err("the rule names no FREQ".to_string());
    };
    let Some(freq) = FREQUENCIES.iter().position(|held| held == name) else {
        return Err(format!("unknown FREQ: {name}"));
    };
    let mut rule = Rule {
        freq: freq as u8,
        interval: 1,
        count: None,
        until: None,
        bysecond: None,
        byminute: None,
        byhour: None,
        byweekday: None,
        bynweekday: None,
        bymonthday: None,
        byyearday: None,
        byweekno: None,
        bymonth: None,
        bysetpos: None,
        wkst: 0,
    };
    for (key, raw) in &parts {
        match key.as_str() {
            "FREQ" => {}
            "INTERVAL" => rule.interval = read_int(raw, key, 1, 1_000_000)?,
            "COUNT" => rule.count = Some(read_int(raw, key, 1, 1_000_000)?),
            "UNTIL" => rule.until = Some(read_date_value(raw, &HashMap::new())?),
            "BYSECOND" => rule.bysecond = Some(read_list(raw, key, 0, 60, false)?),
            "BYMINUTE" => rule.byminute = Some(read_list(raw, key, 0, 59, false)?),
            "BYHOUR" => rule.byhour = Some(read_list(raw, key, 0, 23, false)?),
            "BYMONTHDAY" => rule.bymonthday = Some(read_list(raw, key, 1, 31, true)?),
            "BYYEARDAY" => rule.byyearday = Some(read_list(raw, key, 1, 366, true)?),
            "BYWEEKNO" => rule.byweekno = Some(read_list(raw, key, 1, 53, true)?),
            "BYMONTH" => rule.bymonth = Some(read_list(raw, key, 1, 12, false)?),
            "BYSETPOS" => rule.bysetpos = Some(read_list(raw, key, 1, 366, true)?),
            "WKST" => {
                let Some(day) = WEEKDAYS.iter().position(|held| held == raw) else {
                    return Err(format!("unknown WKST: {raw}"));
                };
                rule.wkst = day as i64;
            }
            "BYDAY" => read_days(&mut rule, raw)?,
            _ => return Err(format!("unknown rule part: {key}")),
        }
    }
    judge_parts(&rule)?;
    Ok(rule)
}

fn read_days(rule: &mut Rule, raw: &str) -> Result<(), Refusal> {
    let mut seen = BTreeSet::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        let unreadable = || format!("unreadable BYDAY entry: {entry}");
        let Some(name) = entry.get(entry.len().saturating_sub(2)..) else {
            return Err(unreadable());
        };
        let Some(day) = WEEKDAYS.iter().position(|held| *held == name) else {
            return Err(unreadable());
        };
        let prefix = &entry[..entry.len() - 2];
        if prefix.is_empty() {
            rule.byweekday
                .get_or_insert_with(BTreeSet::new)
                .insert(day as i64);
            continue;
        }
        let digits = prefix.strip_prefix(['+', '-']).unwrap_or(prefix);
        if digits.is_empty()
            || digits.len() > 2
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(unreadable());
        }
        let n = read_int(prefix, "BYDAY", -53, 53)?;
        if n == 0 {
            return Err("BYDAY may not number a weekday 0".to_string());
        }
        if seen.insert((n, day)) {
            rule.bynweekday
                .get_or_insert_with(Vec::new)
                .push((day as i64, n));
        }
    }
    Ok(())
}

fn judge_parts(rule: &Rule) -> Result<(), Refusal> {
    if rule.count.is_some() && rule.until.is_some() {
        return Err("COUNT and UNTIL may not both be given".to_string());
    }
    if rule.bynweekday.is_some() && rule.freq != MONTHLY && rule.freq != YEARLY {
        return Err("a numbered BYDAY needs FREQ=MONTHLY or FREQ=YEARLY".to_string());
    }
    if rule.bynweekday.is_some() && rule.freq == YEARLY && rule.byweekno.is_some() {
        return Err("a numbered BYDAY may not be combined with BYWEEKNO".to_string());
    }
    if rule.bymonthday.is_some() && rule.freq == WEEKLY {
        return Err("BYMONTHDAY does not apply to FREQ=WEEKLY".to_string());
    }
    if rule.byyearday.is_some() && matches!(rule.freq, DAILY | WEEKLY | MONTHLY) {
        return Err(format!(
            "BYYEARDAY does not apply to FREQ={}",
            FREQUENCIES[usize::from(rule.freq)]
        ));
    }
    if rule.byweekno.is_some() && rule.freq != YEARLY {
        return Err("BYWEEKNO needs FREQ=YEARLY".to_string());
    }
    let selectable = rule.bysecond.is_some()
        || rule.byminute.is_some()
        || rule.byhour.is_some()
        || rule.byweekday.is_some()
        || rule.bynweekday.is_some()
        || rule.bymonthday.is_some()
        || rule.byyearday.is_some()
        || rule.byweekno.is_some()
        || rule.bymonth.is_some();
    if rule.bysetpos.is_some() && !selectable {
        return Err("BYSETPOS needs another BY rule part to select from".to_string());
    }
    Ok(())
}
