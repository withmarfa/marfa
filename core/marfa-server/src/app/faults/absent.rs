use std::time::Duration;

use super::{Lie, Resolved, Volume};
use crate::db::Pulse;

#[derive(Debug)]
pub struct Point;

macro_rules! points {
    ($($constant:ident = $kind:ident $name:literal $argument:ident;)*) => {
        $(pub const $constant: &Point = &Point;)*
    };
}

point_list!(points);

#[must_use]
pub struct Released;

#[derive(Debug, Default)]
pub struct Faults;

impl Faults {
    pub async fn hold(&self, _point: &Point, _action: Option<&str>) {}

    pub async fn hold_job(&self, _job: &str) {}

    pub fn hold_beating(&self, _point: &Point, _pulse: &Pulse) {}

    pub fn hold_blocking(&self, _point: &Point) {}

    pub fn hold_writing(&self, _point: &Point) {}

    pub fn fail(&self, _point: &Point, _action: Option<&str>) -> bool {
        false
    }

    pub fn fail_job(&self, _job: &str) -> bool {
        false
    }

    pub fn resolve(&self, _host: &str) -> Option<Resolved> {
        None
    }

    pub fn stall(&self, _host: &str) -> Option<Duration> {
        None
    }

    pub fn deadline(&self, _job: &str) -> Option<Duration> {
        None
    }

    pub fn limit(&self, _lane: &str) -> Option<i64> {
        None
    }

    pub fn store_check_deadline(&self) -> Option<Duration> {
        None
    }

    pub fn lie(&self, _hash: &str) -> Option<Lie> {
        None
    }

    pub fn heal(&self, _hash: &str, _placed: bool) {}

    pub fn unfold_deadline(&self) -> Option<u64> {
        None
    }

    pub fn hides_position(&self) -> bool {
        false
    }

    pub fn hidden_events(&self) -> Option<(i64, i64)> {
        None
    }

    pub fn unreadable(&self, _stored: &str, _id: &str) -> bool {
        false
    }

    pub fn free(&self, _volume: Volume) -> Option<Option<u64>> {
        None
    }

    pub fn refusing(&self, _point: &Point) -> bool {
        false
    }

    pub fn is_refusing(&self, _point: &Point) -> bool {
        false
    }

    pub fn health_admitted(&self) -> Option<Released> {
        None
    }

    pub fn health_answered(&self, _released: Released) {}
}
