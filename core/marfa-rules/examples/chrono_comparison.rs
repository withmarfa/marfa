//! Compares the reader and writer chrono gave Marfa with the ones in `marfa_rules::time`.
//! Run in release: `cargo run --release -p marfa-rules --example chrono_comparison`.

use std::collections::BTreeMap;

use marfa_rules::time;

mod old {
    use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, Timelike, Utc};

    pub fn epoch_ms(value: &str) -> Option<i64> {
        let text = normalize_bound(value, "").ok().or_else(|| {
            let zoned = value
                .as_bytes()
                .get(16)
                .is_some_and(|b| matches!(b, b'Z' | b'z' | b'+' | b'-'));
            let minutes = value.get(..16).filter(|_| zoned)?;
            rfc3339(&format!("{minutes}:00{}", &value[16..]), "").ok()
        })?;
        chrono::DateTime::parse_from_rfc3339(&text)
            .ok()
            .map(|instant| instant.timestamp_millis())
    }

    pub fn rfc3339(value: &str, field: &str) -> Result<String, String> {
        instant(value, field).map(|instant| written(&instant))
    }

    pub fn instant(value: &str, field: &str) -> Result<DateTime<Utc>, String> {
        let bytes = value.as_bytes();
        let zoned = matches!(bytes.last(), Some(b'Z' | b'z'))
            || bytes.len() > 6 && bytes[bytes.len() - 3] == b':';
        let instant = (zoned && matches!(bytes.get(10), Some(b'T' | b't')))
            .then(|| DateTime::parse_from_rfc3339(value).ok())
            .flatten()
            .map(|instant| instant.naive_utc())
            .filter(|instant| instant.nanosecond() < 1_000_000_000)
            .ok_or_else(|| invalid(field, "expected an RFC 3339 timestamp"))?;
        in_range(instant, field).map(|instant| instant.and_utc())
    }

    pub fn written(instant: &DateTime<Utc>) -> String {
        instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    }

    pub fn iso(ms: i64) -> String {
        chrono::DateTime::from_timestamp_millis(ms)
            .map(|at| at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
            .unwrap_or_default()
    }

    pub fn normalize_bound(value: &str, field: &str) -> Result<String, String> {
        match date_alone(value) {
            Some(instant) => in_range(instant, field).map(|instant| written(&instant.and_utc())),
            None => rfc3339(value, field),
        }
    }

    fn date_alone(value: &str) -> Option<NaiveDateTime> {
        let bytes = value.as_bytes();
        let shaped = bytes.len() == 10
            && bytes.iter().enumerate().all(|(at, byte)| {
                if at == 4 || at == 7 {
                    *byte == b'-'
                } else {
                    byte.is_ascii_digit()
                }
            });
        shaped
            .then(|| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
            .flatten()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
    }

    fn in_range(instant: NaiveDateTime, field: &str) -> Result<NaiveDateTime, String> {
        if !(0..=9999).contains(&instant.year()) {
            return Err(invalid(field, "the UTC year must be between 0000 and 9999"));
        }
        Ok(instant)
    }

    fn invalid(field: &str, reason: &str) -> String {
        format!("Invalid {field}: {reason}")
    }
}

#[derive(Default)]
struct Tally {
    compared: u64,
    same: u64,
    listed: BTreeMap<&'static str, u64>,
    unlisted: Vec<String>,
}

impl Tally {
    fn agree(&mut self) {
        self.compared += 1;
        self.same += 1;
    }

    fn differ(&mut self, why: Option<&'static str>, what: String) {
        self.compared += 1;
        match why {
            Some(why) => *self.listed.entry(why).or_default() += 1,
            None if self.unlisted.len() < 20 => self.unlisted.push(what),
            None => self.unlisted.push(String::new()),
        }
    }
}

struct Tallies(BTreeMap<&'static str, Tally>);

impl Tallies {
    fn get(&mut self, name: &'static str) -> &mut Tally {
        self.0.entry(name).or_default()
    }
}

fn minus_fixed(input: &str) -> String {
    input.replace('\u{2212}', "-")
}

/// Every difference must be a Unicode minus the old reader took as `-` and the new one refuses.
fn compare<T: PartialEq + std::fmt::Debug>(
    tallies: &mut Tallies,
    name: &'static str,
    input: &str,
    old: T,
    new: T,
    new_of_fixed: impl FnOnce() -> T,
) {
    let tally = tallies.get(name);
    if old == new {
        tally.agree();
    } else if input.contains('\u{2212}') && new_of_fixed() == old {
        tally.differ(Some("U+2212 refused"), String::new());
    } else {
        tally.differ(None, format!("{name} {input:?}: old {old:?}, new {new:?}"));
    }
}

fn check(tallies: &mut Tallies, input: &str) {
    let old = old::rfc3339(input, "t");
    let new = time::rfc3339(input, "t").map_err(|e| e.to_string());
    let fixed = minus_fixed(input);
    compare(tallies, "rfc3339", input, old, new, || {
        time::rfc3339(&fixed, "t").map_err(|e| e.to_string())
    });

    let old = old::instant(input, "t").map(|at| at.timestamp_millis());
    let new = time::instant(input, "t").map_err(|e| e.to_string());
    compare(tallies, "instant", input, old, new, || {
        time::instant(&fixed, "t").map_err(|e| e.to_string())
    });

    let old = old::normalize_bound(input, "t");
    let new = time::normalize_bound(input, "t").map_err(|e| e.to_string());
    compare(tallies, "normalize_bound", input, old, new, || {
        time::normalize_bound(&fixed, "t").map_err(|e| e.to_string())
    });

    let old = old::epoch_ms(input);
    let new = time::epoch_ms(input);
    compare(tallies, "epoch_ms", input, old, new, || {
        time::epoch_ms(&fixed)
    });

    let direct = chrono::DateTime::parse_from_rfc3339(input);
    let new = time::read(input);
    let tally = tallies.get("direct reader");
    match (&direct, new) {
        (Ok(old), Ok(ms)) if old.timestamp_millis() == ms => tally.agree(),
        (Err(_), Err(_)) => tally.agree(),
        (Ok(old), new) => {
            let old = old.timestamp_millis();
            let mut fixed = minus_fixed(input);
            let spaced = fixed.as_bytes().get(10) == Some(&b' ');
            if spaced {
                fixed.replace_range(10..11, "T");
            }
            let leap = input.get(17..19) == Some("60");
            let why = if time::read(&fixed) == Ok(old) {
                Some(if input.contains('\u{2212}') {
                    "U+2212 refused"
                } else {
                    "a space for T refused"
                })
            } else if leap
                && fixed.get(17..19) == Some("60")
                && time::read(&format!("{}59{}", &fixed[..17], &fixed[19..])).map(|ms| ms + 1000)
                    == Ok(old)
            {
                Some("a leap second refused")
            } else if time::read(&fixed) == Err(time::Fault::Range) {
                Some("a UTC year outside 0000 to 9999 refused")
            } else {
                None
            };
            tally.differ(
                why,
                format!("direct {input:?}: old {direct:?}, new {new:?}"),
            );
        }
        (Err(_), new) => tally.differ(
            None,
            format!("direct {input:?}: old {direct:?}, new {new:?}"),
        ),
    }
}

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

const REPLACEMENTS: [char; 21] = [
    '0', '1', '2', '5', '9', ':', '-', '+', 'T', 't', 'Z', 'z', '.', ' ', 'a', '\u{2212}', 'é',
    '２', '😀', '\0', '\n',
];

fn mutations(seed: &str, tallies: &mut Tallies) {
    let chars: Vec<char> = seed.chars().collect();
    let text = |chars: &[char]| chars.iter().collect::<String>();
    check(tallies, seed);
    for at in 0..=chars.len() {
        for replacement in REPLACEMENTS {
            let mut inserted = chars.clone();
            inserted.insert(at, replacement);
            check(tallies, &text(&inserted));
            if at < chars.len() && chars[at] != replacement {
                let mut changed = chars.clone();
                changed[at] = replacement;
                check(tallies, &text(&changed));
            }
        }
        if at < chars.len() {
            let mut deleted = chars.clone();
            deleted.remove(at);
            check(tallies, &text(&deleted));
        }
    }
}

fn untidy() -> Vec<String> {
    let mut inputs: Vec<String> = [
        "",
        " ",
        "Z",
        "T",
        "2026",
        "2026-01-01",
        "2026-01-01T",
        "2026-01-01T00:00:00",
        "2026-01-01T00:00:60Z",
        "2016-12-31T23:59:60Z",
        "2016-12-31T23:59:60.999999999Z",
        "2016-12-31 23:59:60Z",
        "2026-01-01T00:00:61Z",
        "2026-01-01T00:00:00.Z",
        "2026-01-01T00:00:00.1234567890Z",
        "2026-01-01T00:00:00.1234567890123456789012345678901234567890Z",
        "2026-01-01T00:00:00.9999999999999Z",
        "2026-01-01T00:00:00.999999999Z",
        "2026-01-01T00:00:00.9999Z",
        "2026-01-01t00:00:00z",
        "2026-01-01t00:00:00Z",
        "2026-01-01T00:00:00z",
        "2026-01-01 00:00:00Z",
        "2026-01-01 00:00:00",
        " 2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z ",
        "2026-01-01T00:00:00-00:00",
        "2026-01-01T00:00:00+00:00",
        "2026-01-01T00:00:00-23:59",
        "2026-01-01T00:00:00+23:59",
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:00-24:00",
        "2026-01-01T00:00:00+99:99",
        "2026-01-01T00:00:00+00:60",
        "2026-01-01T00:00:00+0000",
        "2026-01-01T00:00:00+00",
        "2026-01-01T00:00:00+00:00:00",
        "2026-01-01T00:00:00\u{2212}05:00",
        "2026-01-01T00:00\u{2212}05:00",
        "2026-01-01T00:00:00 +05:00",
        "2026-01-01T00:00:00 UTC",
        "2026-01-01T00:00:00UTC",
        "2026-01-01T00:00:00[Europe/London]",
        "2026-01-01T00:00:00+01:00[Europe/London]",
        "-0001-01-01T00:00:00Z",
        "+2026-01-01T00:00:00Z",
        "10000-01-01T00:00:00Z",
        "0000-01-01T00:00:00Z",
        "0000-01-01T00:00:00+00:01",
        "0000-01-01T00:00:00-00:01",
        "0000-01-01T00:00:00.001+00:01",
        "9999-12-31T23:59:59.999Z",
        "9999-12-31T23:59:59.9999Z",
        "9999-12-31T23:59:59-00:01",
        "9999-12-31T23:59:59.999-00:01",
        "9999-12-31T23:59:59+23:59",
        "9999-12-31T00:00:00-23:59",
        "0000-01-01T23:59:59+23:59",
        "0000-02-29T00:00:00Z",
        "0100-02-29T00:00:00Z",
        "0400-02-29T00:00:00Z",
        "1900-02-29T00:00:00Z",
        "2000-02-29T00:00:00Z",
        "2026-02-29T00:00:00Z",
        "2026-1-5T00:00:00Z",
        "226-01-05T00:00:00Z",
        "2026-01-05",
        "2026-1-5",
        "+2026-01-05",
        " 2026-01-05",
        "226-01-05",
        "-0001-01-05",
        "0000-01-01",
        "9999-12-31",
        "0000-02-29",
        "2026-02-29",
        "2026-00-10",
        "2026-13-10",
        "2026-01-32",
        "2026-01-00",
        "2026-01-01T00:00",
        "2026-01-01T00:00Z",
        "2026-01-01T00:00+01:00",
        "2026-01-01T00:00-01:00",
        "2026-01-01T00:00z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T23:60:00Z",
        "２０２６-01-01T00:00:00Z",
        "2026-01-01T00:00:00Ｚ",
        "2026-01-01T००:00:00Z",
        "2026-01-01T00:00:00.١Z",
        "2026-01-01T00:00:00\0Z",
        "\0",
        "2026-01-01\u{a0}00:00:00Z",
        "2026-01-01T00:00:00Z\n",
        "2026-01-01T00:00:00+01:00\n",
        "2026-01-01\tT00:00:00Z",
        "é2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Zé",
        "😀",
        "2026-01-01T00:00:00😀",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    inputs.extend(["Z", "z", "+", "-", ":", "."].map(String::from));
    inputs
}

fn seeds() -> Vec<String> {
    let mut seeds = Vec::new();
    let years = [
        0, 1, 4, 99, 100, 399, 400, 1600, 1899, 1900, 1970, 1999, 2000, 2023, 2024, 2026, 2100,
        2400, 9996, 9999,
    ];
    let tails = ["Z", ".789Z", "+05:30", "-23:59", ".5-00:00"];
    for year in years {
        for month in 1..=12 {
            let last = time::days_in_month(year, month);
            for day in [1, last, last + 1] {
                for (n, tail) in tails.iter().enumerate() {
                    let clock = ["00:00:00", "23:59:59", "12:34:56"][n % 3];
                    seeds.push(format!("{year:04}-{month:02}-{day:02}T{clock}{tail}"));
                }
            }
        }
        seeds.push(format!("{year:04}-02-28"));
        seeds.push(format!("{year:04}-02-29"));
        seeds.push(format!("{year:04}-12-31T23:59"));
        seeds.push(format!("{year:04}-12-31T23:59Z"));
        seeds.push(format!("{year:04}-12-31T23:59+05:30"));
    }
    seeds
}

fn template(random: &mut Random) -> String {
    let mut digits = |count: usize| -> String {
        (0..count)
            .map(|_| char::from(b'0' + (random.next() % 10) as u8))
            .collect()
    };
    let year = digits(4);
    let (month, day) = (
        format!("{:02}", 1 + digits(2).parse::<u64>().unwrap() % 13),
        format!("{:02}", 1 + digits(2).parse::<u64>().unwrap() % 32),
    );
    let clock = format!(
        "{:02}:{:02}:{:02}",
        digits(2).parse::<u64>().unwrap() % 25,
        digits(2).parse::<u64>().unwrap() % 61,
        digits(2).parse::<u64>().unwrap() % 62
    );
    let fraction = match digits(1).parse::<u64>().unwrap() % 4 {
        0 => String::new(),
        1 => format!(".{}", digits(3)),
        2 => format!(".{}", digits(9)),
        _ => {
            let length = 1 + digits(2).parse::<usize>().unwrap() % 20;
            format!(".{}", digits(length))
        }
    };
    let zone = match digits(1).parse::<u64>().unwrap() % 5 {
        0 => "Z".to_string(),
        1 => "z".to_string(),
        2 => format!(
            "+{:02}:{:02}",
            digits(2).parse::<u64>().unwrap() % 25,
            digits(2).parse::<u64>().unwrap() % 61
        ),
        3 => format!(
            "-{:02}:{:02}",
            digits(2).parse::<u64>().unwrap() % 25,
            digits(2).parse::<u64>().unwrap() % 61
        ),
        _ => format!(
            "\u{2212}{:02}:{:02}",
            digits(2).parse::<u64>().unwrap() % 25,
            digits(2).parse::<u64>().unwrap() % 61
        ),
    };
    let separator = if digits(1).parse::<u64>().unwrap() % 8 == 0 {
        ' '
    } else {
        'T'
    };
    format!("{year}-{month}-{day}{separator}{clock}{fraction}{zone}")
}

fn writer(tallies: &mut Tallies, ms: i64) {
    let old = old::iso(ms);
    let new = time::written(ms);
    let tally = tallies.get("written");
    if old == new {
        tally.agree();
    } else if old.is_empty() {
        tally.differ(
            Some("beyond chrono's own range, which wrote nothing"),
            String::new(),
        );
    } else {
        tally.differ(None, format!("written {ms}: old {old:?}, new {new:?}"));
    }
    let tally = tallies.get("date_text");
    match chrono::DateTime::from_timestamp_millis(ms) {
        Some(at) => {
            let old = at.format("%Y-%m-%d").to_string();
            let new = time::date_text(ms);
            if old == new {
                tally.agree();
            } else {
                tally.differ(None, format!("date_text {ms}: old {old:?}, new {new:?}"));
            }
        }
        None => {}
    }
    if (time::FIRST_MS..=time::LAST_MS).contains(&ms) {
        let tally = tallies.get("written read back");
        let at = chrono::DateTime::from_timestamp_millis(ms).unwrap();
        let old = old::written(&at);
        if time::read(&old) == Ok(ms)
            && old::instant(&old, "t").map(|a| a.timestamp_millis()) == Ok(ms)
        {
            tally.agree();
        } else {
            tally.differ(None, format!("round trip {ms}: {old}"));
        }
    }
}

fn main() {
    let mut tallies = Tallies(BTreeMap::new());
    let mut random = Random(0x2545_f491_4f6c_dd1d);

    for input in untidy() {
        mutations(&input, &mut tallies);
    }
    println!("untidy inputs and their one-character changes done");
    for seed in seeds() {
        mutations(&seed, &mut tallies);
    }
    println!("seeds across leap rules and month lengths done");
    for year in 0..=9999 {
        mutations(&format!("{year:04}-02-29T12:34:56.789+05:30"), &mut tallies);
        mutations(&format!("{year:04}-12-31T23:59:59.5Z"), &mut tallies);
    }
    println!("every year from 0000 to 9999 done");
    for _ in 0..5_000_000 {
        let bytes: Vec<u8> = (0..random.next() % 41)
            .map(|_| random.next() as u8)
            .collect();
        check(&mut tallies, &String::from_utf8_lossy(&bytes));
    }
    println!("random bytes done");
    for _ in 0..5_000_000 {
        let text = template(&mut random);
        check(&mut tallies, &text);
    }
    println!("random times of the right shape done");

    for ms in (0..10_000).flat_map(|n| [time::FIRST_MS + n, time::LAST_MS - n]) {
        writer(&mut tallies, ms);
    }
    for ms in (0..10_000).flat_map(|n| [time::FIRST_MS - 1 - n, time::LAST_MS + 1 + n]) {
        writer(&mut tallies, ms);
    }
    for _ in 0..20_000_000 {
        let ms = time::FIRST_MS + (random.next() % (time::LAST_MS - time::FIRST_MS) as u64) as i64;
        writer(&mut tallies, ms);
    }
    for _ in 0..2_000_000 {
        writer(&mut tallies, random.next() as i64);
    }
    for day in time::days_from_civil(-300, 1, 1)..=time::days_from_civil(10_300, 12, 31) {
        writer(
            &mut tallies,
            day * 86_400_000 + (random.next() % 86_400_000) as i64,
        );
        writer(&mut tallies, day * 86_400_000);
        writer(&mut tallies, day * 86_400_000 + 86_399_999);
    }
    {
        use chrono::Datelike;
        let tally = tallies.get("iso week text");
        for day in time::days_from_civil(0, 1, 1)..=time::days_from_civil(9999, 12, 31) {
            let (y, m, d) = time::civil_from_days(day);
            let at = chrono::NaiveDate::from_ymd_opt(y as i32, m as u32, d as u32).unwrap();
            let old = format!("{}-W{:02}", at.iso_week().year(), at.iso_week().week());
            let week = jiff::civil::date(y as i16, m as i8, d as i8).iso_week_date();
            let new = format!("{}-W{:02}", week.year(), week.week());
            if old == new {
                tally.agree();
            } else {
                tally.differ(None, format!("week {y}-{m}-{d}: old {old}, new {new}"));
            }
        }
    }
    {
        let span = (time::LAST_MS - time::FIRST_MS) as u64;
        for n in 0..10_000_000_u64 {
            let ms = time::FIRST_MS + (random.next() % span) as i64;
            let us = ms * 1000 + (n % 1000) as i64;
            let old = chrono::DateTime::from_timestamp_micros(us)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
            let new = format!(
                "{}{:03}Z",
                time::written(us.div_euclid(1000)).trim_end_matches('Z'),
                us.rem_euclid(1000)
            );
            if old == new {
                tallies.get("log time, microseconds").agree();
            } else {
                tallies
                    .get("log time, microseconds")
                    .differ(None, format!("micros {us}: old {old}, new {new}"));
            }
            let old = chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .format("%b %-d, %Y")
                .to_string();
            let new = time::date_of(ms)
                .unwrap()
                .strftime("%b %-d, %Y")
                .to_string();
            if old == new {
                tallies.get("passkey day text").agree();
            } else {
                tallies
                    .get("passkey day text")
                    .differ(None, format!("day {ms}: old {old}, new {new}"));
            }
        }
    }
    println!("writer done");

    let mut bad = false;
    println!(
        "\n| What | Compared | Same | Differences listed in the plan | Unlisted |\n|---|---|---|---|---|"
    );
    for (name, tally) in &tallies.0 {
        let listed: Vec<String> = tally
            .listed
            .iter()
            .map(|(why, count)| format!("{count} ({why})"))
            .collect();
        println!(
            "| {name} | {} | {} | {} | {} |",
            tally.compared,
            tally.same,
            if listed.is_empty() {
                "none".into()
            } else {
                listed.join("; ")
            },
            tally.unlisted.len()
        );
        for line in tally.unlisted.iter().filter(|line| !line.is_empty()) {
            println!("  UNLISTED {line}");
            bad = true;
        }
        bad |= !tally.unlisted.is_empty();
    }
    if bad {
        std::process::exit(1);
    }
}
