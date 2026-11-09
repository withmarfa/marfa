//! A backup's name is the instant it was taken, as the archive's `created_at` writes it, and
//! `.tar`. Which backups thinning keeps follows from the names alone.

use std::collections::HashSet;

use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};

const SUFFIX: &str = ".tar";
const DAILY_FOR_DAYS: i64 = 30;

/// The name of a backup taken at `created_at`, an instant in the server's own form.
pub fn name_of(created_at: &str) -> Option<String> {
    let at = DateTime::parse_from_rfc3339(created_at)
        .ok()?
        .with_timezone(&Utc);
    let name = format!(
        "{}{SUFFIX}",
        at.to_rfc3339_opts(SecondsFormat::Millis, true)
    );
    (parse(&name) == Some(at)).then_some(name)
}

/// Whether `folder` names an instance's backups: an instance id in its canonical form.
pub fn instance_of(folder: &str) -> bool {
    uuid::Uuid::try_parse(folder).is_ok_and(|id| id.hyphenated().to_string() == folder)
}

/// When the backup `name` was taken, for a name exactly as `name_of` writes one.
pub fn parse(name: &str) -> Option<DateTime<Utc>> {
    let stamp = name.strip_suffix(SUFFIX)?;
    let at = DateTime::parse_from_rfc3339(stamp)
        .ok()?
        .with_timezone(&Utc);
    (at.to_rfc3339_opts(SecondsFormat::Millis, true) == stamp).then_some(at)
}

/// The listed names to delete: every backup of the last day is kept, then the newest of each
/// day for thirty days, and the newest backup always. A name that does not read as a backup is
/// never named.
pub fn doomed(listed: &[String], now: DateTime<Utc>) -> Vec<String> {
    let mut backups: Vec<(DateTime<Utc>, &String)> = listed
        .iter()
        .filter_map(|name| parse(name).map(|at| (at, name)))
        .collect();
    backups.sort_by(|a, b| b.cmp(a));
    let day = Duration::days(1);
    let oldest_daily = now - day - Duration::days(DAILY_FOR_DAYS);
    let mut days: HashSet<NaiveDate> = HashSet::new();
    let mut doomed = Vec::new();
    for (index, (at, name)) in backups.into_iter().enumerate() {
        let kept =
            index == 0 || at > now - day || (at > oldest_daily && days.insert(at.date_naive()));
        if !kept {
            doomed.push(name.clone());
        }
    }
    doomed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_name_is_the_instant_and_reads_back_as_it() {
        let name = name_of("2026-11-09T10:15:30.250Z").unwrap();
        assert_eq!(name, "2026-11-09T10:15:30.250Z.tar");
        assert_eq!(parse(&name), Some(at("2026-11-09T10:15:30.250Z")));
    }

    #[test]
    fn only_a_name_written_exactly_as_a_backup_reads() {
        for stray in [
            "2026-11-09T10:15:30.250Z",
            "2026-11-09T10:15:30.250Z.tar.partial",
            "2026-11-09T10:15:30Z.tar",
            "2026-11-09T10:15:30.250+00:00.tar",
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
    fn the_last_day_is_kept_whole_then_one_a_day_for_thirty_days() {
        let now = at("2026-11-09T12:00:00.000Z");
        let names = [
            "2026-11-09T11:00:00.000Z.tar",
            "2026-11-09T01:00:00.000Z.tar",
            "2026-11-08T13:00:00.000Z.tar",
            "2026-11-08T10:00:00.000Z.tar",
            "2026-11-08T09:00:00.000Z.tar",
            "2026-11-07T23:00:00.000Z.tar",
            "2026-11-07T01:00:00.000Z.tar",
            "2026-10-10T12:00:00.000Z.tar",
            "2026-10-09T13:00:00.000Z.tar",
            "2026-10-08T12:00:00.000Z.tar",
            "notes.tar",
        ]
        .map(String::from);
        let mut doomed = doomed(&names, now);
        doomed.sort();
        assert_eq!(
            doomed,
            [
                "2026-10-08T12:00:00.000Z.tar",
                "2026-11-07T01:00:00.000Z.tar",
                "2026-11-08T09:00:00.000Z.tar",
            ]
        );
    }

    #[test]
    fn the_newest_backup_is_kept_however_old() {
        let now = at("2026-11-09T12:00:00.000Z");
        let names = [
            "2026-01-02T00:00:00.000Z.tar",
            "2026-01-01T00:00:00.000Z.tar",
        ]
        .map(String::from);
        assert_eq!(doomed(&names, now), ["2026-01-01T00:00:00.000Z.tar"]);
    }

    #[test]
    fn a_backup_from_ahead_of_the_clock_is_kept() {
        let now = at("2026-11-09T12:00:00.000Z");
        let names = [
            "2026-11-10T12:00:00.000Z.tar",
            "2026-11-09T11:00:00.000Z.tar",
        ]
        .map(String::from);
        assert!(doomed(&names, now).is_empty());
    }
}
