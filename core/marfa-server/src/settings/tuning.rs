//! Timings and batch sizes the server fixes in code. Only a server built with test hooks reads
//! `MARFA_TEST_TUNING`, so a fixture can shorten one without an owner ever having the setting.

use std::time::Duration;

/// A job's name follows this, or `*` for every job a name does not give.
#[cfg(feature = "test-hooks")]
const INTERVAL: &str = "interval.";

#[derive(Clone, Debug)]
pub struct Tuning {
    pub housekeeping_poll: Duration,
    pub write_wait: Duration,
    pub upload_idle: Duration,
    pub blob_read_idle: Duration,
    pub inbound_read: Duration,
    pub connector_hold: Duration,
    pub enrichment_batch: u64,
    pub blob_replicate_batch: u64,
    pub blob_replicate_batch_bytes: u64,
    pub blob_integrity_batch: u64,
    pub blob_integrity_batch_bytes: u64,
    intervals: Vec<(String, u64)>,
}

impl Default for Tuning {
    fn default() -> Tuning {
        Tuning {
            housekeeping_poll: Duration::from_secs(1),
            write_wait: Duration::from_secs(5),
            upload_idle: Duration::from_secs(60),
            blob_read_idle: Duration::from_secs(30),
            inbound_read: Duration::from_secs(30),
            connector_hold: Duration::from_secs(180),
            enrichment_batch: 8,
            blob_replicate_batch: 100,
            blob_replicate_batch_bytes: 1 << 30,
            blob_integrity_batch: 500,
            blob_integrity_batch_bytes: 1 << 30,
            intervals: Vec::new(),
        }
    }
}

impl Tuning {
    /// How often a job runs: what a test names for it or for every job, else `fixed_ms`.
    pub fn interval_ms(&self, job: &str, fixed_ms: u64) -> u64 {
        let named = |name: &str| self.intervals.iter().rfind(|(held, _)| held == name);
        named(job)
            .or_else(|| named("*"))
            .map_or(fixed_ms, |(_, ms)| *ms)
    }
}

#[cfg(feature = "test-hooks")]
impl Tuning {
    pub fn read(text: &str, jobs: &[&str]) -> Result<Tuning, String> {
        let mut tuning = Tuning::default();
        for pair in text
            .split(',')
            .map(str::trim)
            .filter(|pair| !pair.is_empty())
        {
            let (name, value) = pair
                .split_once('=')
                .ok_or_else(|| format!("must be name=value pairs, and {pair} is not one"))?;
            let least = u64::from(name != "write_wait_ms");
            let number = super::rule::whole_number(value, least, super::rule::YEAR_SECONDS * 1_000)
                .map_err(|rule| format!("{name} {rule}"))?;
            let millis = Duration::from_millis(number);
            match name {
                "housekeeping_poll_ms" => tuning.housekeeping_poll = millis,
                "write_wait_ms" => tuning.write_wait = millis,
                "upload_idle_ms" => tuning.upload_idle = millis,
                "blob_read_idle_ms" => tuning.blob_read_idle = millis,
                "inbound_read_ms" => tuning.inbound_read = millis,
                "connector_hold_ms" => tuning.connector_hold = millis,
                "enrichment_batch" => tuning.enrichment_batch = number,
                "blob_replicate_batch" => tuning.blob_replicate_batch = number,
                "blob_replicate_batch_bytes" => tuning.blob_replicate_batch_bytes = number,
                "blob_integrity_batch" => tuning.blob_integrity_batch = number,
                "blob_integrity_batch_bytes" => tuning.blob_integrity_batch_bytes = number,
                _ => {
                    let job = name
                        .strip_prefix(INTERVAL)
                        .filter(|job| *job == "*" || jobs.contains(job))
                        .ok_or_else(|| {
                            format!("names {name}, which is not a timing the server has")
                        })?;
                    tuning.intervals.push((job.to_string(), number));
                }
            }
        }
        Ok(tuning)
    }
}

#[cfg(all(test, feature = "test-hooks"))]
mod tests {
    use super::*;

    const JOBS: [&str; 2] = ["feed-expiry", "backup"];

    #[test]
    fn a_named_interval_beats_the_wildcard_and_the_wildcard_beats_the_fixed_one() {
        let tuning = Tuning::read("interval.*=7000,interval.feed-expiry=1000", &JOBS).unwrap();
        assert_eq!(tuning.interval_ms("feed-expiry", 3_600_000), 1_000);
        assert_eq!(tuning.interval_ms("audit-cleanup", 3_600_000), 7_000);
        assert_eq!(
            Tuning::default().interval_ms("audit-cleanup", 3_600_000),
            3_600_000
        );
        let later = Tuning::read("interval.feed-expiry=5,interval.feed-expiry=9", &JOBS).unwrap();
        assert_eq!(later.interval_ms("feed-expiry", 1), 9);
    }

    #[test]
    fn a_timing_the_server_lacks_or_a_value_outside_its_rule_is_refused() {
        for text in [
            "nothing_at_all_ms=5",
            "interval.no-such-job=5",
            "upload_idle_ms=0",
            "upload_idle_ms=soon",
            "upload_idle_ms",
        ] {
            assert!(Tuning::read(text, &JOBS).is_err(), "{text}");
        }
        let tuning = Tuning::read(
            "upload_idle_ms=200, blob_integrity_batch=1, write_wait_ms=0",
            &JOBS,
        )
        .unwrap();
        assert_eq!(tuning.upload_idle, Duration::from_millis(200));
        assert_eq!(tuning.blob_integrity_batch, 1);
        assert_eq!(tuning.write_wait, Duration::ZERO);
    }
}
