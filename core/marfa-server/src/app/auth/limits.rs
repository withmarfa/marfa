//! The lanes an attempt at a sign-in door is counted in. Each is a fixed window on the one
//! limiter.

use std::net::IpAddr;

use super::owner::MAX_EMAIL_CHARS;
use crate::app::App;
use crate::app::limiter::{Lane, Limiter, retry_seconds};
use crate::app::refusal::{Code, Refusal, Result};
use crate::settings::registry::RATE_LIMIT_ENABLED;

const MINUTE_MS: i64 = 60_000;
const ADDRESS: &str = "sign-in-address";
const ACCOUNT_ADDRESS: &str = "sign-in-account-address";
const ACCOUNT: &str = "sign-in-account";
const SETUP_ADDRESS: &str = "instance-claim-address";
const DEVICE_ADDRESS: &str = "device-user-code-address";
const DEVICE_INSTANCE: &str = "device-user-code-instance";
const DEVICE_OWNER: &str = "device-user-code-owner";
const DEVICE_OWNER_INSTANCE: &str = "device-user-code-owner-instance";
const DOCUMENT_ADDRESS: &str = "client-document-address";
const DOCUMENT_INSTANCE: &str = "client-document-instance";
const REGISTER_ADDRESS: &str = "client-register-address";
const DEVICE_CODE_ADDRESS: &str = "device-code-address";
const PASSKEY_ADDRESS: &str = "passkey-challenge-address";
const ALL: &str = "all";
const NO_ADDRESS: &str = "unknown";

fn bucket(address: Option<IpAddr>) -> String {
    let Some(address) = address else {
        return NO_ADDRESS.to_string();
    };
    match address.to_canonical() {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => {
            let [a, b, c, d, ..] = address.segments();
            format!("{a:x}:{b:x}:{c:x}:{d:x}::/64")
        }
    }
}

pub(super) fn account_key(email: &str) -> String {
    email
        .trim()
        .to_lowercase()
        .chars()
        .take(MAX_EMAIL_CHARS)
        .collect()
}

pub fn password_lanes(email: &str, address: Option<IpAddr>) -> [Lane; 3] {
    let account = account_key(email);
    [
        Lane::new(ADDRESS, bucket(address), 30, 15 * MINUTE_MS),
        Lane::new(
            ACCOUNT_ADDRESS,
            format!("{account}|{}", bucket(address)),
            10,
            15 * MINUTE_MS,
        ),
        Lane::new(ACCOUNT, account, 100, 60 * MINUTE_MS),
    ]
}

pub fn setup_code_lanes(address: Option<IpAddr>) -> [Lane; 1] {
    [Lane::new(
        SETUP_ADDRESS,
        bucket(address),
        10,
        15 * MINUTE_MS,
    )]
}

pub fn device_lookup_lanes(address: Option<IpAddr>) -> [Lane; 2] {
    [
        Lane::new(DEVICE_ADDRESS, bucket(address), 10, 15 * MINUTE_MS),
        Lane::new(DEVICE_INSTANCE, ALL.to_string(), 100, 15 * MINUTE_MS),
    ]
}

pub fn device_owner_lanes(user_id: &str, instance_limit: Option<i64>) -> [Lane; 2] {
    [
        Lane::new(DEVICE_OWNER, user_id.to_string(), 10, 15 * MINUTE_MS),
        Lane::new(
            DEVICE_OWNER_INSTANCE,
            ALL.to_string(),
            instance_limit
                .and_then(|limit| u64::try_from(limit).ok())
                .unwrap_or(100),
            15 * MINUTE_MS,
        ),
    ]
}

pub fn document_lanes(address: Option<IpAddr>) -> [Lane; 2] {
    [
        Lane::new(DOCUMENT_ADDRESS, bucket(address), 10, MINUTE_MS),
        Lane::new(DOCUMENT_INSTANCE, ALL.to_string(), 30, MINUTE_MS),
    ]
}

pub fn register_lanes(address: Option<IpAddr>) -> [Lane; 1] {
    [Lane::new(REGISTER_ADDRESS, bucket(address), 10, MINUTE_MS)]
}

pub fn passkey_challenge_lanes(address: Option<IpAddr>) -> [Lane; 1] {
    [Lane::new(PASSKEY_ADDRESS, bucket(address), 30, MINUTE_MS)]
}

pub fn device_code_lanes(address: Option<IpAddr>) -> [Lane; 1] {
    [Lane::new(
        DEVICE_CODE_ADDRESS,
        bucket(address),
        30,
        MINUTE_MS,
    )]
}

/// The milliseconds to wait when the attempt is refused.
pub fn admit(app: &App, lanes: &[Lane]) -> Option<i64> {
    app.limiter.admit(app.clock.now_ms(), lanes)
}

/// For the doors a switch can turn the limiter off for.
pub fn hold_to(app: &App, lanes: [Lane; 1], message: &'static str) -> Result<()> {
    if !app.settings.live().get(RATE_LIMIT_ENABLED) {
        return Ok(());
    }
    admit(app, &lanes).map_or(Ok(()), |wait| Err(spent(message, wait)))
}

/// A password change or a recovery starts the account's counts afresh.
pub fn clear_account(limiter: &Limiter, email: &str) {
    let account = account_key(email);
    let prefix = format!("{account}|");
    limiter.forget(ACCOUNT, |key| key == account);
    limiter.forget(ACCOUNT_ADDRESS, |key| key.starts_with(&prefix));
}

pub fn spent(message: &'static str, wait_ms: i64) -> Refusal {
    Refusal::new(Code::RateLimited, message).with_detail("retry_after", retry_seconds(wait_ms))
}

pub fn too_many_passwords(wait_ms: i64) -> Refusal {
    spent("Too many password attempts. Try again later.", wait_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attempt(limiter: &Limiter, now: i64, lanes: &[Lane]) -> Option<i64> {
        limiter.admit(now, lanes)
    }

    #[test]
    fn an_address_past_its_limit_leaves_the_account_count_alone() {
        let limiter = Limiter::default();
        let lanes = password_lanes("a@example.test", "203.0.113.1".parse().ok());
        for _ in 0..10 {
            assert_eq!(attempt(&limiter, 0, &lanes), None);
        }
        assert_eq!(
            attempt(&limiter, 1_000, &lanes),
            Some(15 * MINUTE_MS - 1_000)
        );
        let account = [lanes[2].clone()];
        let left = (0..).take_while(|_| attempt(&limiter, 1_000, &account).is_none());
        assert_eq!(left.count(), 90);
    }

    #[test]
    fn one_address_runs_out_of_emails_to_try() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        for n in 0..30 {
            let lanes = password_lanes(&format!("{n}@example.test"), address);
            assert_eq!(attempt(&limiter, 0, &lanes), None);
        }
        let next = password_lanes("next@example.test", address);
        assert_eq!(
            attempt(&limiter, 1_000, &next),
            Some(15 * MINUTE_MS - 1_000)
        );
        let elsewhere = password_lanes("next@example.test", "203.0.113.2".parse().ok());
        assert_eq!(attempt(&limiter, 1_000, &elsewhere), None);
        assert_eq!(attempt(&limiter, 15 * MINUTE_MS, &next), None);
    }

    #[test]
    fn a_window_counts_afresh_once_it_ends() {
        let limiter = Limiter::default();
        let lanes = setup_code_lanes(None);
        for _ in 0..11 {
            attempt(&limiter, 0, &lanes);
        }
        assert!(attempt(&limiter, 15 * MINUTE_MS - 1, &lanes).is_some());
        assert_eq!(attempt(&limiter, 15 * MINUTE_MS, &lanes), None);
    }

    #[test]
    fn an_app_door_holds_one_address_and_not_the_next() {
        let limiter = Limiter::default();
        type Door = fn(Option<IpAddr>) -> [Lane; 1];
        let doors: [(Door, usize); 3] = [
            (register_lanes, 10),
            (device_code_lanes, 30),
            (passkey_challenge_lanes, 30),
        ];
        for (lanes, limit) in doors {
            let one = lanes("203.0.113.1".parse().ok());
            for _ in 0..limit {
                assert_eq!(attempt(&limiter, 0, &one), None);
            }
            assert_eq!(attempt(&limiter, 1_000, &one), Some(MINUTE_MS - 1_000));
            let next = lanes("203.0.113.2".parse().ok());
            assert_eq!(attempt(&limiter, 1_000, &next), None);
            assert_eq!(attempt(&limiter, MINUTE_MS, &one), None);
        }
    }

    #[test]
    fn addresses_share_a_count_only_where_they_should() {
        let v6 = |text: &str| bucket(text.parse().ok());
        assert_eq!(v6("2001:db8:1:2:3::1"), v6("2001:db8:1:2:ffff::9"));
        assert_ne!(v6("2001:db8:1:2::1"), v6("2001:db8:1:3::1"));
        assert_eq!(v6("::ffff:203.0.113.1"), v6("203.0.113.1"));
        assert_eq!(bucket(None), NO_ADDRESS);
    }

    #[test]
    fn a_cleared_account_loses_only_its_own_counts() {
        let limiter = Limiter::default();
        let mine = password_lanes("a@example.test", None);
        let other = password_lanes("aa@example.test", None);
        for lanes in [&mine, &other] {
            for _ in 0..10 {
                attempt(&limiter, 0, lanes);
            }
        }
        clear_account(&limiter, "A@example.test");
        assert_eq!(attempt(&limiter, 1, &mine[1..]), None);
        assert!(attempt(&limiter, 1, &other[1..]).is_some());
    }

    #[test]
    fn the_wait_is_whole_seconds_rounded_up_and_never_under_one() {
        let seconds = |wait_ms| {
            spent("x", wait_ms).details.unwrap()["retry_after"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(seconds(1), 1);
        assert_eq!(seconds(1_000), 1);
        assert_eq!(seconds(1_001), 2);
        assert_eq!(seconds(15 * MINUTE_MS), 900);
    }
}
