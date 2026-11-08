use super::*;

fn ms(text: &str) -> i64 {
    crate::time::epoch_ms(text).unwrap()
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

/// A start, a rule, the end of the window and the occurrences expected in it.
struct Case(
    &'static str,
    &'static str,
    &'static str,
    &'static [&'static str],
);

fn series<'a>(starts_at: &'a str, zone: Option<&'a str>, lines: &'a [&'a str]) -> Schedule {
    compile(&Input {
        starts_at,
        ends_at: None,
        duration: Some(3600.0),
        all_day: false,
        timezone: zone,
        recurrence: lines,
    })
    .unwrap()
}

fn between(schedule: &Schedule, from: &str, to: &str) -> Vec<String> {
    let mut meter = Meter::new(WORK_LIMIT);
    schedule
        .starts(ms(from), ms(to), &mut meter, usize::MAX)
        .unwrap()
        .into_iter()
        .map(iso)
        .collect()
}

#[test]
fn secondly_until_stops_without_spending_the_budget() {
    let schedule = series(
        "2027-06-01T09:00:00Z",
        None,
        &["RRULE:FREQ=SECONDLY;UNTIL=20270601T130000Z"],
    );
    let mut meter = Meter::new(WORK_LIMIT);
    let rows = schedule
        .starts(ms("2027-06-01"), ms("2027-06-02"), &mut meter, usize::MAX)
        .unwrap();
    assert_eq!(rows.len(), 14_401);
    assert_eq!(meter.spent(), rows.len() as u64 + 1);
}

#[test]
fn fractional_exdates_match_whole_seconds() {
    for start in ["2027-01-01T09:00:00.500Z", "1969-01-01T09:00:00.500Z"] {
        let year = &start[..4];
        for suffix in ["Z", ""] {
            let excluded = format!("EXDATE:{year}0102T090000{suffix}");
            let from = format!("{year}-01-01");
            let to = format!("{year}-01-05");
            let witness = series(start, None, &["RRULE:FREQ=DAILY;COUNT=4"]);
            assert_eq!(between(&witness, &from, &to).len(), 4);
            let schedule = series(start, None, &["RRULE:FREQ=DAILY;COUNT=4", &excluded]);
            assert_eq!(
                between(&schedule, &from, &to),
                [1, 3, 4].map(|day| format!("{year}-01-0{day}T09:00:00Z")),
                "{excluded}"
            );
        }
    }
}

#[test]
fn fractional_until_includes_its_whole_second() {
    for suffix in ["Z", ""] {
        let rule = format!("RRULE:FREQ=DAILY;UNTIL=20270103T090000{suffix}");
        let schedule = series("2027-01-01T09:00:00.500Z", None, &[&rule]);
        assert_eq!(
            between(&schedule, "2027-01-01", "2027-01-05"),
            [
                "2027-01-01T09:00:00Z",
                "2027-01-02T09:00:00Z",
                "2027-01-03T09:00:00Z"
            ],
            "{rule}"
        );
    }
}

#[test]
fn interval_uses_the_starts_week_year() {
    let schedule = series(
        "2024-12-30T09:00:00Z",
        None,
        &["RRULE:FREQ=YEARLY;INTERVAL=2;BYWEEKNO=1;BYDAY=MO"],
    );
    assert_eq!(
        between(&schedule, "2024-12-31", "2027-02-01"),
        ["2027-01-04T09:00:00Z"]
    );
}

#[test]
fn january_start_keeps_the_previous_week_year() {
    let schedule = series(
        "2021-01-01T09:00:00Z",
        None,
        &["RRULE:FREQ=YEARLY;BYWEEKNO=53;BYDAY=SU"],
    );
    assert_eq!(
        between(&schedule, "2021-01-02", "2021-02-01"),
        ["2021-01-03T09:00:00Z"]
    );
}

#[test]
fn week_year_boundaries() {
    for (start, rule, from, to, expected) in [
        (
            "2021-01-04T09:00:00Z",
            "RRULE:FREQ=YEARLY;INTERVAL=2;BYWEEKNO=1;BYDAY=MO",
            "2024-12-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "2024-12-30T09:00:00Z",
        ),
        (
            "2018-01-01T09:00:00Z",
            "RRULE:FREQ=YEARLY;INTERVAL=2;BYWEEKNO=-1;BYDAY=SU",
            "2020-12-01T00:00:00Z",
            "2021-02-01T00:00:00Z",
            "2021-01-03T09:00:00Z",
        ),
        (
            "2018-01-01T09:00:00Z",
            "RRULE:FREQ=YEARLY;INTERVAL=2;BYWEEKNO=53;BYDAY=SU",
            "2020-12-01T00:00:00Z",
            "2021-02-01T00:00:00Z",
            "2021-01-03T09:00:00Z",
        ),
        (
            "2021-01-04T09:00:00Z",
            "RRULE:FREQ=YEARLY;INTERVAL=2;BYWEEKNO=1;WKST=SU;BYSETPOS=1",
            "2024-12-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            "2024-12-29T09:00:00Z",
        ),
    ] {
        assert_eq!(
            between(&series(start, None, &[rule]), from, to),
            [expected],
            "{rule}"
        );
    }
}

#[test]
fn spring_gap_does_not_end_utc_until_early() {
    let schedule = compile(&Input {
        starts_at: "2027-03-28T00:00:00Z",
        ends_at: None,
        duration: None,
        all_day: false,
        timezone: Some("Europe/London"),
        recurrence: &["RRULE:FREQ=MINUTELY;INTERVAL=40;UNTIL=20270328T011000Z"],
    })
    .unwrap();
    assert_eq!(
        between(&schedule, "2027-03-28T00:45:00Z", "2027-03-28T02:00:00Z"),
        ["2027-03-28T01:00:00Z"]
    );
}

#[test]
fn spring_gap_count_and_window_end_follow_wall_candidates() {
    for (rule, expected) in [
        (
            "RRULE:FREQ=MINUTELY;INTERVAL=40;COUNT=4",
            vec!["2027-03-28T01:00:00Z"],
        ),
        ("RRULE:FREQ=MINUTELY;INTERVAL=40;COUNT=3", vec![]),
        (
            "RRULE:FREQ=MINUTELY;INTERVAL=40",
            vec!["2027-03-28T01:00:00Z"],
        ),
    ] {
        let schedule = compile(&Input {
            starts_at: "2027-03-28T00:00:00Z",
            ends_at: None,
            duration: None,
            all_day: false,
            timezone: Some("Europe/London"),
            recurrence: &[rule],
        })
        .unwrap();
        assert_eq!(
            between(&schedule, "2027-03-28T00:45:00Z", "2027-03-28T01:10:00Z"),
            expected,
            "{rule}"
        );
    }
}

#[test]
fn fractional_starts_match_moved_slots() {
    let schedule = series(
        "2027-01-01T09:00:00.500Z",
        None,
        &["RRULE:FREQ=DAILY;COUNT=2"],
    );
    let slot = ms("2027-01-02T09:00:00.500Z");
    let rows = schedule
        .unfold(
            ms("2027-01-01"),
            ms("2027-01-03"),
            &mut Meter::new(WORK_LIMIT),
            10,
            &[slot],
        )
        .unwrap();
    assert_eq!(rows[0].start_ms, ms("2027-01-01T09:00:00.500Z"));
    assert_eq!(rows[1].start_ms, slot);
    assert_eq!(rows[1].replaced_by, Some(0));
}

#[test]
fn every_frequency_with_its_parts() {
    let cases: [Case; 8] = [
        Case(
            "2026-01-31T09:00:00Z",
            "RRULE:FREQ=MONTHLY;BYDAY=-1FR",
            "2026-05-01T00:00:00Z",
            &["2026-03-27T09:00:00Z", "2026-04-24T09:00:00Z"],
        ),
        Case(
            "2026-01-01T09:00:00Z",
            "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29",
            "2029-01-01T00:00:00Z",
            &["2028-02-29T09:00:00Z"],
        ),
        Case(
            "2026-11-02T09:00:00Z",
            "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
            "2026-11-10T00:00:00Z",
            &["2026-11-04T09:00:00Z", "2026-11-09T09:00:00Z"],
        ),
        Case(
            "2026-11-02T09:00:00Z",
            "RRULE:FREQ=DAILY;INTERVAL=3",
            "2026-11-10T00:00:00Z",
            &["2026-11-05T09:00:00Z", "2026-11-08T09:00:00Z"],
        ),
        Case(
            "2026-11-02T09:00:00Z",
            "RRULE:FREQ=HOURLY;INTERVAL=5;BYMINUTE=15,45",
            "2026-11-02T15:00:00Z",
            &[
                "2026-11-02T09:45:00Z",
                "2026-11-02T14:15:00Z",
                "2026-11-02T14:45:00Z",
            ],
        ),
        Case(
            "2026-11-02T09:00:00Z",
            "RRULE:FREQ=MINUTELY;INTERVAL=20;BYSECOND=0,30",
            "2026-11-02T09:41:00Z",
            &[
                "2026-11-02T09:00:30Z",
                "2026-11-02T09:20:00Z",
                "2026-11-02T09:20:30Z",
                "2026-11-02T09:40:00Z",
                "2026-11-02T09:40:30Z",
            ],
        ),
        Case(
            "2026-11-02T09:00:00Z",
            "RRULE:FREQ=SECONDLY;INTERVAL=7",
            "2026-11-02T09:00:22Z",
            &[
                "2026-11-02T09:00:07Z",
                "2026-11-02T09:00:14Z",
                "2026-11-02T09:00:21Z",
            ],
        ),
        Case(
            "2026-01-01T09:00:00Z",
            "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
            "2026-03-01T00:00:00Z",
            &["2026-01-30T09:00:00Z", "2026-02-27T09:00:00Z"],
        ),
    ];
    for Case(start, rule, to, expected) in cases {
        let lines = [rule];
        let schedule = series(start, None, &lines);
        let got = between(&schedule, "2026-01-02T00:00:00Z", to);
        let got: Vec<&str> = got
            .iter()
            .map(String::as_str)
            .filter(|held| expected.contains(held))
            .collect();
        assert_eq!(got, expected, "{rule}");
    }
}

#[test]
fn week_and_year_numbering_parts() {
    let weekly = ["RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"];
    let got = between(
        &series("2025-01-01T09:00:00Z", None, &weekly),
        "2026-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z",
    );
    assert_eq!(got, ["2026-05-11T09:00:00Z"]);
    let by_day = ["RRULE:FREQ=YEARLY;BYYEARDAY=1,-1"];
    let got = between(
        &series("2025-06-01T09:00:00Z", None, &by_day),
        "2026-01-01T00:00:00Z",
        "2027-01-01T00:00:00Z",
    );
    assert_eq!(got, ["2026-01-01T09:00:00Z", "2026-12-31T09:00:00Z"]);
}

#[test]
fn count_until_and_the_week_start() {
    let counted = ["RRULE:FREQ=DAILY;COUNT=3"];
    let got = between(
        &series("2026-11-02T09:00:00Z", None, &counted),
        "2026-11-01T00:00:00Z",
        "2026-12-01T00:00:00Z",
    );
    assert_eq!(got.len(), 3);

    let in_utc = ["RRULE:FREQ=DAILY;UNTIL=20261104T090000Z"];
    let zoned = series("2026-11-02T18:00:00+09:00", Some("Asia/Tokyo"), &in_utc);
    let got = between(&zoned, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    assert_eq!(
        got,
        [
            "2026-11-02T09:00:00Z",
            "2026-11-03T09:00:00Z",
            "2026-11-04T09:00:00Z"
        ]
    );

    let floating = ["RRULE:FREQ=DAILY;UNTIL=20261103T180000"];
    let got = between(
        &series("2026-11-02T18:00:00+09:00", Some("Asia/Tokyo"), &floating),
        "2026-11-01T00:00:00Z",
        "2026-12-01T00:00:00Z",
    );
    assert_eq!(got.len(), 2);

    for (wkst, expected) in [
        (
            "MO",
            [
                "2026-11-02T09:00:00Z",
                "2026-11-08T09:00:00Z",
                "2026-11-16T09:00:00Z",
            ],
        ),
        (
            "SU",
            [
                "2026-11-02T09:00:00Z",
                "2026-11-15T09:00:00Z",
                "2026-11-16T09:00:00Z",
            ],
        ),
    ] {
        let line = format!("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST={wkst}");
        let lines = [line.as_str()];
        let got = between(
            &series("2026-11-02T09:00:00Z", None, &lines),
            "2026-11-01T00:00:00Z",
            "2026-11-17T00:00:00Z",
        );
        assert_eq!(got, expected, "WKST={wkst}");
    }
}

#[test]
fn a_series_crosses_both_clock_changes_in_the_north_and_the_south() {
    let daily = ["RRULE:FREQ=DAILY"];
    let london = series("2026-03-27T01:30:00Z", Some("Europe/London"), &daily);
    assert_eq!(
        between(&london, "2026-03-28T00:00:00Z", "2026-03-31T00:00:00Z"),
        [
            "2026-03-28T01:30:00Z",
            // 01:30 does not exist on the 29th: read at the old offset, it lands an hour later.
            "2026-03-29T01:30:00Z",
            "2026-03-30T00:30:00Z"
        ]
    );
    let autumn = series("2026-10-23T00:30:00Z", Some("Europe/London"), &daily);
    assert_eq!(
        between(&autumn, "2026-10-24T00:00:00Z", "2026-10-27T00:00:00Z"),
        [
            "2026-10-24T00:30:00Z",
            // 01:30 happens twice on the 25th: the first reading is kept.
            "2026-10-25T00:30:00Z",
            "2026-10-26T01:30:00Z"
        ]
    );

    // Sydney leaves daylight time in April and enters it in October.
    let sydney = series(
        "2026-04-02T02:30:00+11:00",
        Some("Australia/Sydney"),
        &daily,
    );
    assert_eq!(
        between(&sydney, "2026-04-04T00:00:00Z", "2026-04-07T00:00:00Z"),
        [
            // 02:30 happens twice on the 5th: the first reading is kept.
            "2026-04-04T15:30:00Z",
            "2026-04-05T16:30:00Z",
            "2026-04-06T16:30:00Z"
        ]
    );
    let spring = series(
        "2026-10-03T02:30:00+10:00",
        Some("Australia/Sydney"),
        &daily,
    );
    assert_eq!(
        between(&spring, "2026-10-03T00:00:00Z", "2026-10-06T00:00:00Z"),
        [
            // 02:30 does not exist on the 4th: read at the old offset, it lands an hour later.
            "2026-10-03T16:30:00Z",
            "2026-10-04T15:30:00Z",
            "2026-10-05T15:30:00Z"
        ]
    );
}

#[test]
fn half_hour_and_forty_five_minute_zones_keep_their_local_hour() {
    let weekly = ["RRULE:FREQ=WEEKLY"];
    let kolkata = series("2026-11-02T09:00:00+05:30", Some("Asia/Kolkata"), &weekly);
    assert_eq!(
        between(&kolkata, "2026-11-08T00:00:00Z", "2026-11-10T00:00:00Z"),
        ["2026-11-09T03:30:00Z"]
    );
    let kathmandu = series("2026-11-02T09:00:00+05:45", Some("Asia/Kathmandu"), &weekly);
    assert_eq!(
        between(&kathmandu, "2026-11-08T00:00:00Z", "2026-11-10T00:00:00Z"),
        ["2026-11-09T03:15:00Z"]
    );
}

#[test]
fn no_zone_advances_in_utc_and_a_whole_day_spans_local_days() {
    let daily = ["RRULE:FREQ=DAILY"];
    let floating = series("2026-03-27T01:30:00+01:00", None, &daily);
    assert_eq!(
        between(&floating, "2026-03-29T00:00:00Z", "2026-03-30T00:00:00Z"),
        ["2026-03-29T00:30:00Z"]
    );

    let all_day = compile(&Input {
        starts_at: "2026-03-28",
        ends_at: None,
        duration: None,
        all_day: true,
        timezone: Some("Europe/London"),
        recurrence: &daily,
    })
    .unwrap();
    let mut meter = Meter::new(WORK_LIMIT);
    let days = all_day
        .unfold(
            ms("2026-03-28T12:00:00Z"),
            ms("2026-03-30T12:00:00Z"),
            &mut meter,
            10,
            &[],
        )
        .unwrap();
    let spans: Vec<(String, String)> = days
        .iter()
        .map(|day| (iso(day.start_ms), iso(day.end_ms)))
        .collect();
    assert_eq!(
        spans,
        [
            ("2026-03-28T00:00:00Z".into(), "2026-03-29T00:00:00Z".into()),
            ("2026-03-29T00:00:00Z".into(), "2026-03-29T23:00:00Z".into()),
            ("2026-03-29T23:00:00Z".into(), "2026-03-30T23:00:00Z".into()),
        ]
    );
}

#[test]
fn a_rule_that_never_produces_is_found_and_a_walk_that_cannot_finish_is_stopped() {
    let never = ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"];
    let schedule = series("2026-01-01T09:00:00Z", None, &never);
    assert!(schedule.problem(&mut Meter::new(WORK_LIMIT)).is_some());

    // February the 29th exists in some years, so the walk finds it inside the bound.
    let leap = ["RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"];
    let schedule = series("2026-01-01T09:00:00Z", None, &leap);
    assert!(schedule.problem(&mut Meter::new(WORK_LIMIT)).is_none());

    let busy = ["RRULE:FREQ=SECONDLY"];
    let schedule = series("1990-01-01T00:00:00Z", None, &busy);
    let mut meter = Meter::new(WORK_LIMIT);
    let stopped = schedule.starts(
        ms("2041-01-01T00:00:00Z"),
        ms("2041-01-02T00:00:00Z"),
        &mut meter,
        usize::MAX,
    );
    assert_eq!(stopped, Err(Stop::Candidates));
    assert_eq!(meter.spent(), WORK_LIMIT + 1);

    let expired = || true;
    let mut meter = Meter::with_clock(WORK_LIMIT, &expired);
    let stopped = schedule.starts(
        ms("2041-01-01T00:00:00Z"),
        ms("2041-01-02T00:00:00Z"),
        &mut meter,
        usize::MAX,
    );
    assert_eq!(stopped, Err(Stop::Time));
}

#[test]
fn removed_added_and_moved_instances() {
    let lines = [
        "RRULE:FREQ=DAILY;COUNT=5",
        "EXDATE:20261103T090000Z",
        "RDATE:20261110T090000Z",
    ];
    let schedule = series("2026-11-02T09:00:00Z", None, &lines);
    assert_eq!(
        between(&schedule, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"),
        [
            "2026-11-02T09:00:00Z",
            "2026-11-04T09:00:00Z",
            "2026-11-05T09:00:00Z",
            "2026-11-06T09:00:00Z",
            "2026-11-10T09:00:00Z",
        ]
    );
    let mut meter = Meter::new(WORK_LIMIT);
    let moved = [ms("2026-11-05T09:00:00Z")];
    let occurrences = schedule
        .unfold(
            ms("2026-11-05T00:00:00Z"),
            ms("2026-11-06T00:00:00Z"),
            &mut meter,
            10,
            &moved,
        )
        .unwrap();
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0].replaced_by, Some(0));
    assert_eq!(occurrences[0].end_ms - occurrences[0].start_ms, 3_600_000);
}

#[test]
fn a_write_is_judged_by_its_schedule() {
    let event = |value: serde_json::Value| value.as_object().cloned().unwrap();
    let ok = event(serde_json::json!({
        "title": "x", "starts_at": "2026-11-02T09:00:00Z",
        "timezone": "Europe/Berlin", "recurrence": ["RRULE:FREQ=WEEKLY"]
    }));
    assert!(event_issues(&ok).is_empty());
    for (change, field) in [
        (serde_json::json!({"timezone": "europe/berlin"}), "timezone"),
        (
            serde_json::json!({"end_timezone": "+01:00"}),
            "end_timezone",
        ),
        (serde_json::json!({"duration": -1}), "duration"),
        (serde_json::json!({"duration": 3_162_240_001.0}), "duration"),
        (
            serde_json::json!({"recurrence": ["RRULE:FREQ=WEEKLY;COUNT=2;UNTIL=20270101"]}),
            "recurrence",
        ),
        (
            serde_json::json!({"recurrence": ["EXRULE:FREQ=DAILY"]}),
            "recurrence",
        ),
        (
            serde_json::json!({"recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=1MO"]}),
            "recurrence",
        ),
        (
            serde_json::json!({"recurrence": ["RRULE:FREQ=WEEKLY", "RRULE:FREQ=DAILY"]}),
            "recurrence",
        ),
        (serde_json::json!({"starts_at": null}), "recurrence"),
    ] {
        let mut changed = ok.clone();
        changed.extend(event(change));
        let issues = event_issues(&changed);
        assert_eq!(
            issues.first().map(|held| held.field),
            Some(field),
            "{changed:?}"
        );
    }
    let task = event(serde_json::json!({"title": "t", "recurrence": ["RRULE:FREQ=DAILY"]}));
    assert_eq!(task_issues(&task).len(), 1);
}
