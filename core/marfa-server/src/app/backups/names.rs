//! A backup's name is its instant in ISO 8601 basic format, which FAT and exFAT accept.

use std::collections::HashSet;

use chrono::{DateTime, Duration, NaiveDate, Utc};

use crate::app::clock::Stamp;

const SUFFIX: &str = ".tar";
/// The newest backup of each of this many days, the most recent that hold one, is kept.
const DAYS_KEPT: usize = 31;

/// The name of a backup taken at `created_at`.
pub fn name_of(created_at: Stamp) -> String {
    let basic: String = created_at
        .text()
        .chars()
        .filter(|c| *c != '-' && *c != ':')
        .collect();
    format!("{basic}{SUFFIX}")
}

/// Whether `folder` names an instance's backups: an instance id in its canonical form.
pub fn instance_of(folder: &str) -> bool {
    uuid::Uuid::try_parse(folder).is_ok_and(|id| id.hyphenated().to_string() == folder)
}

/// When the backup `name` was taken, for a name exactly as `name_of` writes one.
pub fn parse(name: &str) -> Option<Stamp> {
    let basic = name.strip_suffix(SUFFIX)?.as_bytes();
    let shaped = basic.len() == 20
        && basic.iter().enumerate().all(|(index, byte)| match index {
            8 => *byte == b'T',
            15 => *byte == b'.',
            19 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        });
    if !shaped {
        return None;
    }
    let text = std::str::from_utf8(basic).ok()?;
    let extended = format!(
        "{}-{}-{}T{}:{}:{}",
        &text[0..4],
        &text[4..6],
        &text[6..8],
        &text[9..11],
        &text[11..13],
        &text[13..],
    );
    Stamp::parsed(&extended).filter(|at| name_of(*at) == name)
}

/// The backups among `listed` whose names read, newest first.
fn by_age(listed: impl IntoIterator<Item = impl AsRef<str>>) -> Vec<(DateTime<Utc>, String)> {
    let mut backups: Vec<(DateTime<Utc>, String)> = listed
        .into_iter()
        .filter_map(|name| {
            let name = name.as_ref();
            parse(name).map(|at| (at.at(), name.to_string()))
        })
        .collect();
    backups.sort_by(|a, b| b.cmp(a));
    backups
}

/// Days are counted by the backups they hold, never by a span back on the clock.
pub fn doomed(listed: &[String], taken: Stamp) -> Vec<String> {
    let since = taken.at() - Duration::days(1);
    let mut days: HashSet<NaiveDate> = HashSet::new();
    let mut doomed = Vec::new();
    for (index, (at, name)) in by_age(listed).into_iter().enumerate() {
        let kept = index == 0 || at > since || newest_of_a_kept_day(&mut days, at);
        if !kept {
            doomed.push(name);
        }
    }
    doomed
}

fn newest_of_a_kept_day(days: &mut HashSet<NaiveDate>, at: DateTime<Utc>) -> bool {
    days.len() < DAYS_KEPT && days.insert(at.date_naive())
}

/// The days a listing holds backups on, newest first.
pub struct Listed(Vec<NaiveDate>);

impl Listed {
    pub fn of<'a>(listed: impl IntoIterator<Item = &'a String>) -> Listed {
        let mut days: Vec<NaiveDate> = by_age(listed)
            .into_iter()
            .map(|(at, _)| at.date_naive())
            .collect();
        days.dedup();
        Listed(days)
    }

    /// Past retention once the listing holds more later days than thinning keeps.
    pub fn past_retention(&self, missing: Stamp) -> bool {
        let after = missing.at().date_naive();
        self.0.iter().take_while(|day| **day > after).count() > DAYS_KEPT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Stamp {
        Stamp::read(text).unwrap()
    }

    fn hours(from: &str, count: i64) -> Vec<String> {
        (0..count)
            .map(|hour| name_of(at(from).plus_ms(hour * 3_600_000).unwrap()))
            .collect()
    }

    fn sorted(mut names: Vec<String>) -> Vec<String> {
        names.sort();
        names
    }

    /// Thins as the listing does after each backup, putting every name of `taken` in turn.
    fn thinned(taken: &[String]) -> Vec<String> {
        let mut listed: Vec<String> = Vec::new();
        for name in taken {
            listed.push(name.clone());
            let gone = doomed(&listed, parse(name).unwrap());
            listed.retain(|kept| !gone.contains(kept));
        }
        sorted(listed)
    }

    #[test]
    fn a_name_is_the_instant_and_reads_back_as_it() {
        let name = name_of(at("2026-11-09T10:15:30.250Z"));
        assert_eq!(name, "20261109T101530.250Z.tar");
        assert_eq!(parse(&name), Some(at("2026-11-09T10:15:30.250Z")));
    }

    #[test]
    fn a_name_holds_only_characters_every_file_system_accepts() {
        for taken in ["0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"] {
            let name = name_of(at(taken));
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'),
                "{name}"
            );
            assert_eq!(parse(&name), Some(at(taken)));
        }
    }

    #[test]
    fn names_sort_as_the_instants_they_name() {
        let instants = [
            "2026-01-09T23:59:59.999Z",
            "2026-11-09T10:15:30.250Z",
            "2026-11-09T10:15:30.251Z",
            "2027-02-01T00:00:00.000Z",
        ];
        let names: Vec<String> = instants.iter().map(|text| name_of(at(text))).collect();
        assert_eq!(sorted(names.clone()), names);
    }

    #[test]
    fn only_a_name_written_exactly_as_a_backup_reads() {
        for stray in [
            "20261109T101530.250Z",
            "20261109T101530.250Z.tar.partial",
            ".20261109T101530.250Z.tar.0190a1b2.partial",
            "20261109T101530Z.tar",
            "20261109T101530.250+0000.tar",
            "20261109t101530.250Z.tar",
            "20261309T101530.250Z.tar",
            "20261109T246030.250Z.tar",
            "2026-11-09T10:15:30.250Z.tar",
            "2026110９T101530.250Z.tar",
            "notes.tar",
            ".marfa-store",
            "",
        ] {
            assert_eq!(parse(stray), None, "{stray}");
        }
    }

    #[test]
    fn only_an_instance_id_in_its_canonical_form_names_a_folder() {
        assert!(instance_of("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"));
        for stray in [
            "0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B",
            "0190a1b2c3d47e5f8a9b0c1d2e3f4a5b",
            "{0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b}",
            "deeper",
            "",
        ] {
            assert!(!instance_of(stray), "{stray}");
        }
    }

    #[test]
    fn the_last_day_is_kept_whole_then_the_newest_of_each_day_that_holds_a_backup() {
        let taken = at("2026-11-09T12:00:00.000Z");
        let names = [
            "2026-11-09T11:00:00.000Z",
            "2026-11-09T01:00:00.000Z",
            "2026-11-08T13:00:00.000Z",
            "2026-11-08T10:00:00.000Z",
            "2026-11-08T09:00:00.000Z",
            "2026-11-07T23:00:00.000Z",
            "2026-11-07T01:00:00.000Z",
            "2026-10-10T12:00:00.000Z",
            "2026-10-09T13:00:00.000Z",
            "2026-10-08T12:00:00.000Z",
        ]
        .map(|text| name_of(at(text)));
        let mut listed = names.to_vec();
        listed.push("notes.tar".into());
        assert_eq!(
            sorted(doomed(&listed, taken)),
            [&names[6], &names[4]].map(String::clone)
        );
    }

    #[test]
    fn only_the_newest_of_each_of_31_days_older_than_a_day_is_kept() {
        let taken = at("2026-11-09T12:00:00.000Z");
        let mut names = vec![name_of(taken)];
        let days: Vec<String> = (2..=33)
            .map(|day| name_of(taken.plus_ms(-day * 86_400_000).unwrap()))
            .collect();
        names.extend(days.iter().cloned());
        assert_eq!(doomed(&names, taken), [days[31].clone()]);
    }

    #[test]
    fn the_newest_backup_is_kept_however_old() {
        let taken = at("2026-11-09T12:00:00.000Z");
        let names = [
            "2026-01-02T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            "2025-01-01T00:00:00.000Z",
        ]
        .map(|text| name_of(at(text)));
        assert!(doomed(&names, taken).is_empty());
    }

    #[test]
    fn three_backups_on_different_days_and_one_40_days_ahead_are_all_kept() {
        let names = [
            "2026-11-07T12:00:00.000Z",
            "2026-11-08T12:00:00.000Z",
            "2026-11-09T12:00:00.000Z",
            "2026-12-19T12:00:00.000Z",
        ]
        .map(|text| name_of(at(text)));
        assert_eq!(thinned(&names), names.to_vec());
    }

    #[test]
    fn backups_after_the_clock_is_put_back_keep_the_one_ahead_and_thin_as_usual() {
        let ahead = name_of(at("2026-12-19T12:00:00.000Z"));
        let mut taken = vec![ahead.clone()];
        taken.extend(hours("2026-11-09T12:00:00.000Z", 40 * 24));
        let kept = thinned(&taken);
        assert!(kept.contains(&ahead));
        let mut usual = thinned(&taken[1..]);
        usual.push(ahead);
        assert_eq!(kept, sorted(usual));
        assert_eq!(kept.len(), 1 + 24 + 31);
    }

    #[test]
    fn a_server_off_for_six_weeks_keeps_the_newest_of_its_last_31_days_after_its_first_new_one() {
        let before = thinned(&hours("2026-09-20T12:00:00.000Z", 40 * 24));
        let mut newest_of_days: Vec<String> = Vec::new();
        for (at, name) in by_age(&before) {
            let date = at.date_naive();
            if newest_of_days
                .iter()
                .all(|kept| parse(kept).unwrap().at().date_naive() != date)
            {
                newest_of_days.push(name);
            }
        }
        newest_of_days.truncate(DAYS_KEPT);
        let back = name_of(at("2026-11-11T12:00:00.000Z"));
        let mut listed = before.clone();
        listed.push(back.clone());
        let mut kept: Vec<String> = listed.clone();
        let gone = doomed(&listed, parse(&back).unwrap());
        kept.retain(|name| !gone.contains(name));
        newest_of_days.push(back);
        assert_eq!(sorted(kept), sorted(newest_of_days));
    }

    #[test]
    fn hourly_backups_over_40_days_thin_as_a_span_back_from_the_clock_did_but_at_23_00() {
        let taken = hours("2026-09-20T00:00:00.000Z", 40 * 24);
        let (mut counted, mut spanned): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
        let mut differ = Vec::new();
        for name in &taken {
            let now = parse(name).unwrap().at();
            counted.push(name.clone());
            let gone = doomed(&counted, parse(name).unwrap());
            counted.retain(|kept| !gone.contains(kept));
            spanned.push(name.clone());
            let mut days = HashSet::new();
            spanned = by_age(&spanned)
                .into_iter()
                .enumerate()
                .filter(|(index, (at, _))| {
                    *index == 0
                        || *at > now - Duration::days(1)
                        || (*at > now - Duration::days(31) && days.insert(at.date_naive()))
                })
                .map(|(_, (_, name))| name)
                .collect();
            let extra: Vec<&String> = counted.iter().filter(|n| !spanned.contains(n)).collect();
            let at_23 = now.format("%H").to_string() == "23";
            if spanned.iter().any(|n| !counted.contains(n)) || extra.len() > usize::from(at_23) {
                differ.push(name.clone());
            }
        }
        assert!(differ.is_empty(), "{differ:#?}");
    }

    #[test]
    fn a_missing_backup_is_past_retention_once_the_listing_holds_32_later_days() {
        let missing = at("2026-10-01T12:00:00.000Z");
        let mut listed: Vec<String> = (0..=31)
            .map(|day| name_of(missing.plus_ms(day * 86_400_000).unwrap()))
            .collect();
        listed.push(name_of(missing.plus_ms(31 * 86_400_000 + 1).unwrap()));
        assert!(!Listed::of(&listed).past_retention(missing));
        listed.push(name_of(missing.plus_ms(32 * 86_400_000).unwrap()));
        assert!(Listed::of(&listed).past_retention(missing));
    }

    #[test]
    fn one_backup_far_ahead_does_not_put_a_missing_backup_past_retention() {
        let missing = at("2026-11-01T12:00:00.000Z");
        let listed = [
            "2026-11-02T12:00:00.000Z",
            "2026-11-09T12:00:00.000Z",
            "2027-11-09T12:00:00.000Z",
        ]
        .map(|text| name_of(at(text)));
        assert!(!Listed::of(&listed).past_retention(missing));
        assert!(!Listed::of(&[]).past_retention(missing));
    }
}
