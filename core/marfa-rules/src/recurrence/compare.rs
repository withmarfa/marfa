//! Old (chrono-tz 2025b) against new (jiff, tzdata 2026f) answers for every zone name.

use std::collections::BTreeMap;

use jiff::Timestamp;
use jiff::tz::{AmbiguousOffset, TimeZone};

use super::calendar::{DAY, Zone, civil_from_days, days_from_civil};
use super::old_zone::OldZone;

fn names() -> Vec<&'static str> {
    include_str!("zone-names.txt").lines().collect()
}

fn iso(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    let s = ms.rem_euclid(86_400_000) / 1000;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        s / 3600,
        s / 60 % 60,
        s % 60
    )
}

fn ms_of(y: i64, m: i64, d: i64) -> i64 {
    days_from_civil(y, m, d) * 86_400_000
}

fn threads<T: Send>(work: impl Fn(&'static str) -> T + Sync) -> Vec<(&'static str, T)> {
    let names = names();
    let workers = 4;
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|worker| {
                let names = &names;
                let work = &work;
                scope.spawn(move || {
                    names
                        .iter()
                        .enumerate()
                        .filter(|(at, _)| at % workers == worker)
                        .map(|(_, name)| (*name, work(name)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let mut all: Vec<_> = handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap())
            .collect();
        all.sort_by_key(|(name, _)| *name);
        all
    })
}

/// Every transition of the zone from its first, to the end of 2109, as milliseconds.
fn transitions(tz: &TimeZone) -> Vec<i64> {
    let stop = ms_of(2110, 1, 1);
    let mut found = Vec::new();
    for transition in tz.following(Timestamp::MIN) {
        let ms = transition.timestamp().as_millisecond();
        if ms >= stop {
            break;
        }
        found.push(ms);
    }
    found
}

/// Transitions the old zone has, found by a daily scan from 1800 to 2100 and a bisection to the second.
fn old_transitions(old: OldZone) -> Vec<i64> {
    let mut found = Vec::new();
    let mut day = days_from_civil(1800, 1, 1);
    let stop = days_from_civil(2100, 1, 1);
    while day < stop {
        let (a, b) = (day * 86_400, (day + 1) * 86_400);
        if old.wall_of(a * 1000) - a != old.wall_of(b * 1000) - b {
            let (mut low, mut high) = (a, b);
            while high - low > 1 {
                let mid = (low + high) / 2;
                if old.wall_of(mid * 1000) - mid == old.wall_of(a * 1000) - a {
                    low = mid;
                } else {
                    high = mid;
                }
            }
            found.push(high * 1000);
        }
        day += 1;
    }
    found
}

#[derive(Default)]
struct Differences {
    probes: u64,
    after_2099: u64,
    gap_day_before: u64,
    other: Vec<(i64, i64, i64)>,
}

fn after_2099(ms: i64) -> bool {
    ms >= ms_of(2100, 1, 1)
}

fn wall_probes(name: &str, tz: &TimeZone, old: OldZone) -> Vec<i64> {
    let mut at: Vec<i64> = Vec::new();
    for ms in transitions(tz).into_iter().chain(old_transitions(old)) {
        at.extend([ms - 1000, ms, ms + 1000]);
    }
    let hour = 3_600_000;
    let mut ms = ms_of(1970, 1, 1);
    while ms < ms_of(2041, 1, 1) {
        at.push(ms);
        ms += hour;
    }
    let mut ms = ms_of(2100, 1, 1);
    while ms < ms_of(2111, 1, 1) {
        at.push(ms);
        ms += hour;
    }
    for year in (2111..=9999).filter(|year| year % 37 == 0 || *year >= 9998) {
        let mut ms = ms_of(year, 1, 1);
        while ms < ms_of(year + 1, 1, 1) {
            at.push(ms);
            ms += hour;
        }
    }
    let mut ms = ms_of(0, 1, 1);
    let mut step = 0;
    while ms < ms_of(1970, 1, 1) {
        at.push(ms + (step % 24) * hour);
        step += 7;
        ms += 5 * 86_400_000;
    }
    at.extend([
        ms_of(0, 1, 1),
        ms_of(0, 1, 1) + 1,
        ms_of(10_000, 1, 1) - 1,
        ms_of(9999, 12, 31),
        ms_of(9999, 12, 31) + 22 * hour,
    ]);
    let _ = name;
    at
}

#[test]
fn wall_of_old_against_new() {
    let results = threads(|name| {
        let new = Zone::named(name).unwrap();
        let old = OldZone::named(name).unwrap();
        let tz = TimeZone::get(name).unwrap();
        let mut found = Differences::default();
        for ms in wall_probes(name, &tz, old) {
            found.probes += 1;
            let (a, b) = (old.wall_of(ms), new.wall_of(ms));
            if a != b {
                if after_2099(ms)
                    && a == old.wall_of(ms_of(2100, 1, 1)) - ms_of(2100, 1, 1) / 1000
                        + ms.div_euclid(1000)
                {
                    found.after_2099 += 1;
                } else {
                    found
                        .other
                        .push((ms, a - ms.div_euclid(1000), b - ms.div_euclid(1000)));
                }
            }
        }
        found
    });
    let probes: u64 = results.iter().map(|(_, d)| d.probes).sum();
    let after: u64 = results.iter().map(|(_, d)| d.after_2099).sum();
    let zones_after = results.iter().filter(|(_, d)| d.after_2099 > 0).count();
    eprintln!("wall_of: {probes} probes, {after} differ only after 2099 ({zones_after} zones)");
    for (name, found) in &results {
        let mut grouped: BTreeMap<(i64, i64), (i64, i64, u64)> = BTreeMap::new();
        for (ms, a, b) in &found.other {
            let entry = grouped.entry((*a, *b)).or_insert((*ms, *ms, 0));
            entry.0 = entry.0.min(*ms);
            entry.1 = entry.1.max(*ms);
            entry.2 += 1;
        }
        for ((a, b), (first, last, count)) in grouped {
            eprintln!(
                "wall_of DIFF {name}: old offset {a} new offset {b}, {count} probes, {} to {}",
                iso(first),
                iso(last)
            );
        }
    }
}

fn gap_before(tz: &TimeZone, wall: i64) -> Option<i64> {
    let (y, m, d) = civil_from_days(wall.div_euclid(DAY));
    let s = wall.rem_euclid(DAY);
    let reading = jiff::civil::DateTime::new(
        i16::try_from(y).ok()?,
        m as i8,
        d as i8,
        (s / 3600) as i8,
        (s / 60 % 60) as i8,
        (s % 60) as i8,
        0,
    )
    .ok()?;
    match tz.to_ambiguous_timestamp(reading).offset() {
        AmbiguousOffset::Gap { before, .. } => Some(i64::from(before.seconds())),
        _ => None,
    }
}

#[test]
fn instant_of_old_against_new() {
    let results = threads(|name| {
        let new = Zone::named(name).unwrap();
        let old = OldZone::named(name).unwrap();
        let tz = TimeZone::get(name).unwrap();
        let mut walls: Vec<i64> = Vec::new();
        for ms in transitions(&tz).into_iter().chain(old_transitions(old)) {
            let second = ms.div_euclid(1000);
            let before = new.wall_of(ms - 1000) - (second - 1);
            let after = new.wall_of(ms) - second;
            for base in [second + before, second + after] {
                for step in -8..=8 {
                    for nudge in [-1, 0, 1] {
                        walls.push(base + step * 900 + nudge);
                    }
                }
            }
        }
        let mut wall = ms_of(1970, 1, 1) / 1000 + 1800;
        while wall < ms_of(2041, 1, 1) / 1000 {
            walls.push(wall);
            wall += 3600;
        }
        walls.extend([
            ms_of(0, 1, 1) / 1000,
            ms_of(9999, 12, 31) / 1000,
            ms_of(9999, 12, 31) / 1000 + 10 * 3600,
            ms_of(10_000, 1, 1) / 1000 - 1,
            ms_of(10_000, 1, 1) / 1000 + 5 * 86_400,
        ]);
        let mut found = Differences::default();
        for wall in walls {
            found.probes += 1;
            let (a, b) = (old.instant_of(wall), new.instant_of(wall));
            if a != b {
                if wall >= days_from_civil(2100, 1, 1) * DAY {
                    found.after_2099 += 1;
                } else if let Some(before) = gap_before(&tz, wall)
                    && b == (wall - before) * 1000
                {
                    found.gap_day_before += 1;
                } else {
                    found.other.push((wall * 1000, a, b));
                }
            }
        }
        found
    });
    let probes: u64 = results.iter().map(|(_, d)| d.probes).sum();
    let after: u64 = results.iter().map(|(_, d)| d.after_2099).sum();
    let gaps: u64 = results.iter().map(|(_, d)| d.gap_day_before).sum();
    eprintln!(
        "instant_of: {probes} probes, {after} differ after 2099, {gaps} in a gap where the old code took the offset a day before"
    );
    for (name, found) in &results {
        if found.gap_day_before > 0 {
            eprintln!("instant_of GAP {name}: {}", found.gap_day_before);
        }
        let tz = TimeZone::get(name).unwrap();
        let mut grouped: BTreeMap<(i64, i64, &str), (i64, i64, u64)> = BTreeMap::new();
        for (wall_ms, a, b) in &found.other {
            let wall = wall_ms / 1000;
            let kind = match kind_at(&tz, wall) {
                Some(AmbiguousOffset::Gap { .. }) => "gap",
                Some(AmbiguousOffset::Fold { .. }) => "fold",
                _ => "plain",
            };
            let key = (wall - a / 1000, wall - b / 1000, kind);
            let entry = grouped.entry(key).or_insert((*wall_ms, *wall_ms, 0));
            entry.0 = entry.0.min(*wall_ms);
            entry.1 = entry.1.max(*wall_ms);
            entry.2 += 1;
        }
        for ((a, b, kind), (first, last, count)) in grouped {
            eprintln!(
                "instant_of DIFF {name}: old offset {a} new offset {b} ({kind}), {count} probes, walls {} to {}",
                iso(first),
                iso(last)
            );
        }
    }
}

fn kind_at(tz: &TimeZone, wall: i64) -> Option<AmbiguousOffset> {
    let (y, m, d) = civil_from_days(wall.div_euclid(DAY));
    let s = wall.rem_euclid(DAY);
    let reading = jiff::civil::DateTime::new(
        i16::try_from(y).ok()?,
        m as i8,
        d as i8,
        (s / 3600) as i8,
        (s / 60 % 60) as i8,
        (s % 60) as i8,
        0,
    )
    .ok()?;
    Some(tz.to_ambiguous_timestamp(reading).offset())
}

#[test]
fn names_old_against_new() {
    let listed = names();
    assert_eq!(listed.len(), 597);
    for name in &listed {
        assert!(OldZone::named(name).is_some());
        assert!(Zone::named(name).is_some());
    }
    for name in [
        "Factory",
        "posixrules",
        "utc",
        "europe/london",
        "Etc/Unknown",
        "",
    ] {
        assert!(OldZone::named(name).is_none(), "{name:?} old");
        assert!(Zone::named(name).is_none(), "{name:?} new");
    }
}
