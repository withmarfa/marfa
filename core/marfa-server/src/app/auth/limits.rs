//! The lanes an attempt at a sign-in door is counted in. Each is a fixed window on the one
//! limiter.

use std::net::IpAddr;

use super::device::Known;
use crate::app::App;
use crate::app::limiter::{Lane, Limiter, retry_seconds};
use crate::app::refusal::{Code, Refusal, Result};
use crate::listener::network;
use crate::settings::registry::RATE_LIMIT_ENABLED;
use marfa_rules::validation::MAX_USERNAME_CHARS;

const MINUTE_MS: i64 = 60_000;
const ADDRESS: &str = "sign-in-address";
const USERNAME_ADDRESS: &str = "sign-in-username-address";
const UNKNOWN_DEVICES: &str = "sign-in-unknown-devices";
const OWNERS_USERNAME: &str = "sign-in-owners-username";
const DEVICE: &str = "sign-in-device";
const KNOWN_DEVICES: &str = "sign-in-known-devices";
const SETUP_ADDRESS: &str = "instance-claim-address";
const DEVICE_ADDRESS: &str = "device-user-code-address";
const DEVICE_INSTANCE: &str = "device-user-code-instance";
const DEVICE_OWNER: &str = "device-user-code-owner";
const DEVICE_OWNER_INSTANCE: &str = "device-user-code-owner-instance";
const DOCUMENT_ADDRESS: &str = "client-document-address";
const DOCUMENT_INSTANCE: &str = "client-document-instance";
const DOCUMENT_OWNER: &str = "client-document-owner";
const REGISTER_ADDRESS: &str = "client-register-address";
const DEVICE_CODE_ADDRESS: &str = "device-code-address";
const PASSKEY_ADDRESS: &str = "passkey-challenge-address";
const ALL: &str = "all";
const NO_ADDRESS: &str = "unknown";
const PASSWORD_FAMILIES: [&str; 6] = [
    ADDRESS,
    USERNAME_ADDRESS,
    UNKNOWN_DEVICES,
    OWNERS_USERNAME,
    DEVICE,
    KNOWN_DEVICES,
];

fn bucket(address: Option<IpAddr>) -> String {
    let Some(address) = address else {
        return NO_ADDRESS.to_string();
    };
    match network(address) {
        IpAddr::V4(address) => address.to_string(),
        IpAddr::V6(address) => format!("{address}/64"),
    }
}

/// A username as sign-in matches it, kept to one character past the longest a username may be so
/// that a name too long to be one never equals one.
pub(super) fn account_key(username: &str) -> String {
    username
        .trim()
        .to_ascii_lowercase()
        .chars()
        .take(MAX_USERNAME_CHARS + 1)
        .collect()
}

/// Who sends a password, as far as the server can tell before it judges it.
#[derive(Clone, Copy, Debug)]
pub enum Sender<'a> {
    /// A browser the server signed in before.
    Known(&'a Known),
    /// A caller that already holds the owner's credential, from a browser the server does not know.
    Credential,
    /// Anyone else; `owners_username` when the username named is the owner's.
    Stranger { owners_username: bool },
}

/// The lanes one password attempt is counted in.
#[derive(Clone, Debug)]
pub struct PasswordLanes {
    /// Spent, these refuse the attempt before its password is judged.
    pub before: Vec<Lane>,
    /// Spent, this answers the attempt `429`; only one the owner's share takes is still judged.
    pub shared: Option<Lane>,
    /// Spent, this leaves a password at the owner's username unchecked and answered as a wrong one.
    pub owner: Option<Lane>,
}

impl PasswordLanes {
    pub fn all(&self) -> Vec<Lane> {
        let mut all = self.before.clone();
        all.extend(self.shared.iter().chain(&self.owner).cloned());
        all
    }
}

/// Past the shared hour, an attempt at the owner's username keeps a share; every password sent for
/// the owner from anywhere but a known device counts in that one hundred an hour.
pub fn password_lanes(
    username: &str,
    address: Option<IpAddr>,
    sender: Sender<'_>,
) -> PasswordLanes {
    let mut before = vec![
        Lane::new(ADDRESS, bucket(address), 30, 15 * MINUTE_MS),
        Lane::new(
            USERNAME_ADDRESS,
            format!("{}|{}", account_key(username), bucket(address)),
            10,
            15 * MINUTE_MS,
        ),
    ];
    let hour = |family| Lane::pinned(family, ALL.to_string(), 100, 60 * MINUTE_MS);
    match sender {
        Sender::Known(device) => {
            before.push(Lane::new(
                DEVICE,
                device.id().to_string(),
                10,
                15 * MINUTE_MS,
            ));
            before.push(hour(KNOWN_DEVICES));
            PasswordLanes {
                before,
                shared: None,
                owner: None,
            }
        }
        Sender::Credential => {
            before.push(hour(OWNERS_USERNAME));
            PasswordLanes {
                before,
                shared: None,
                owner: None,
            }
        }
        Sender::Stranger { owners_username } => PasswordLanes {
            before,
            shared: Some(hour(UNKNOWN_DEVICES)),
            owner: owners_username.then(|| hour(OWNERS_USERNAME)),
        },
    }
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
        Lane::pinned(DEVICE_INSTANCE, ALL.to_string(), 100, 15 * MINUTE_MS),
    ]
}

pub fn device_owner_lanes(owner_id: &str, instance_limit: Option<i64>) -> [Lane; 2] {
    [
        Lane::pinned(DEVICE_OWNER, owner_id.to_string(), 10, 15 * MINUTE_MS),
        Lane::pinned(
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
        Lane::pinned(DOCUMENT_INSTANCE, ALL.to_string(), 30, MINUTE_MS),
    ]
}

/// The fetches of authorization requests that carry the owner's live browser session.
pub fn owner_document_lanes() -> [Lane; 1] {
    [Lane::pinned(DOCUMENT_OWNER, ALL.to_string(), 10, MINUTE_MS)]
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

/// Takes back an attempt `admit` counted at `admitted_ms`.
pub fn give_back(app: &App, admitted_ms: i64, lanes: &[Lane]) {
    app.limiter
        .give_back(admitted_ms, app.clock.now_ms(), lanes);
}

/// For the doors a switch can turn the limiter off for.
pub fn hold_to(app: &App, lanes: [Lane; 1], message: &'static str) -> Result<()> {
    if !app.settings.live().get(RATE_LIMIT_ENABLED) {
        return Ok(());
    }
    admit(app, &lanes).map_or(Ok(()), |wait| Err(spent(message, wait)))
}

/// Preserve every username's address counts so password changes affect them equally.
pub fn clear_for_new_password(limiter: &Limiter) {
    for family in [UNKNOWN_DEVICES, OWNERS_USERNAME, DEVICE, KNOWN_DEVICES] {
        limiter.forget(family, |_| true);
    }
}

/// A recovery is made at the machine, so it lifts every password sign-in limit.
pub fn clear_for_recovery(limiter: &Limiter) {
    for family in PASSWORD_FAMILIES {
        limiter.forget(family, |_| true);
    }
}

pub fn spent(message: &'static str, wait_ms: i64) -> Refusal {
    Refusal::new(Code::RateLimited, message)
        .with_detail("retry_after_seconds", retry_seconds(wait_ms))
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

    fn no_device(username: &str, address: Option<IpAddr>) -> Vec<Lane> {
        password_lanes(
            username,
            address,
            Sender::Stranger {
                owners_username: false,
            },
        )
        .all()
    }

    fn known_device(username: &str, address: Option<IpAddr>, device: &Known) -> Vec<Lane> {
        password_lanes(username, address, Sender::Known(device)).all()
    }

    fn device() -> Known {
        use super::super::device::{Holder, Signer};
        let signer = Signer::derive("a secret for these tests").unwrap();
        let holder = Holder {
            owner_id: "owner",
            credentials: 0,
        };
        let mark = signer.mark(holder, None, 0).unwrap();
        signer.read(holder, &mark, 0).unwrap()
    }

    #[test]
    fn a_known_device_signs_in_while_the_owners_lane_across_addresses_is_full() {
        let limiter = Limiter::default();
        for n in 0..10 {
            let address = format!("203.0.113.{n}").parse().ok();
            for _ in 0..10 {
                attempt(&limiter, 0, &no_device("a", address));
            }
        }
        let stranger = no_device("a", "198.51.100.1".parse().ok());
        assert!(attempt(&limiter, 1, &stranger).is_some());
        let known = device();
        let lanes = known_device("a", "198.51.100.2".parse().ok(), &known);
        assert_eq!(attempt(&limiter, 1, &lanes), None);
    }

    #[test]
    fn a_known_device_is_held_to_its_own_ten_across_addresses() {
        let limiter = Limiter::default();
        let known = device();
        for n in 0..10 {
            let address = format!("203.0.113.{n}").parse().ok();
            let lanes = known_device("a", address, &known);
            assert_eq!(attempt(&limiter, 0, &lanes), None);
        }
        let next = known_device("a", "198.51.100.1".parse().ok(), &known);
        assert!(attempt(&limiter, 1, &next).is_some());
        let other = device();
        let fresh = known_device("a", "198.51.100.1".parse().ok(), &other);
        assert_eq!(attempt(&limiter, 1, &fresh), None);
    }

    #[test]
    fn every_known_device_together_is_held_to_a_hundred_an_hour() {
        let limiter = Limiter::default();
        for n in 0..10 {
            let known = device();
            for m in 0..10 {
                let address = format!("203.0.{n}.{m}").parse().ok();
                let lanes = known_device("a", address, &known);
                assert_eq!(attempt(&limiter, 0, &lanes), None);
            }
        }
        let address = "198.51.100.1".parse().ok();
        let fresh = known_device("a", address, &device());
        assert_eq!(attempt(&limiter, 1, &fresh), Some(60 * MINUTE_MS - 1));
        let stranger = no_device("a", address);
        assert_eq!(attempt(&limiter, 1, &stranger), None);
        assert_eq!(attempt(&limiter, 60 * MINUTE_MS, &fresh), None);
    }

    #[test]
    fn an_attempt_given_back_leaves_every_lane_as_it_was() {
        let limiter = Limiter::default();
        let lanes = no_device("a", "203.0.113.1".parse().ok());
        for n in 0..50 {
            assert_eq!(attempt(&limiter, n, &lanes), None);
            limiter.give_back(n, n, &lanes);
        }
        for _ in 0..10 {
            assert_eq!(attempt(&limiter, 100, &lanes), None);
        }
        assert!(attempt(&limiter, 100, &lanes).is_some());
    }

    #[test]
    fn an_attempt_from_an_ended_window_is_not_given_back_to_the_next() {
        let limiter = Limiter::default();
        let lanes = setup_code_lanes(None);
        assert_eq!(attempt(&limiter, 0, &lanes), None);
        for _ in 0..10 {
            attempt(&limiter, 15 * MINUTE_MS, &lanes);
        }
        limiter.give_back(0, 15 * MINUTE_MS, &lanes);
        assert!(attempt(&limiter, 15 * MINUTE_MS, &lanes).is_some());
    }

    #[test]
    fn an_address_past_its_limit_leaves_the_account_count_alone() {
        let limiter = Limiter::default();
        let lanes = no_device("a", "203.0.113.1".parse().ok());
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
    fn one_address_runs_out_of_usernames_to_try() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        for n in 0..30 {
            let lanes = no_device(&format!("u{n}"), address);
            assert_eq!(attempt(&limiter, 0, &lanes), None);
        }
        let next = no_device("next", address);
        assert_eq!(
            attempt(&limiter, 1_000, &next),
            Some(15 * MINUTE_MS - 1_000)
        );
        let elsewhere = no_device("next", "203.0.113.2".parse().ok());
        assert_eq!(attempt(&limiter, 1_000, &elsewhere), None);
        assert_eq!(attempt(&limiter, 15 * MINUTE_MS, &next), None);
    }

    #[test]
    fn an_address_has_ten_attempts_at_each_username() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        for _ in 0..10 {
            assert_eq!(attempt(&limiter, 0, &no_device("a", address)), None);
        }
        let again = no_device(" A ", address);
        assert!(attempt(&limiter, 1, &again).is_some());
        let other = no_device("b", address);
        assert_eq!(attempt(&limiter, 1, &other), None);
    }

    #[test]
    fn every_username_without_a_known_device_shares_one_count_across_addresses() {
        let limiter = Limiter::default();
        for n in 0..10 {
            let address = format!("203.0.113.{n}").parse().ok();
            for m in 0..10 {
                let lanes = no_device(&format!("{n}.{m}"), address);
                assert_eq!(attempt(&limiter, 0, &lanes), None);
            }
        }
        let address = "198.51.100.1".parse().ok();
        for username in ["ada", "grace"] {
            assert_eq!(
                attempt(&limiter, 1, &no_device(username, address)),
                Some(60 * MINUTE_MS - 1)
            );
        }
    }

    fn v6(n: u32) -> Option<IpAddr> {
        format!("2001:db8:{:x}:{:x}::1", n >> 16, n & 0xffff)
            .parse()
            .ok()
    }

    /// Spends every address lane of 50,000 /64s past its limit.
    fn fill_address_families(limiter: &Limiter, now: i64) {
        for n in 0..50_000 {
            let address = v6(n);
            let password = no_device(&format!("u{n}"), address);
            let passkey = passkey_challenge_lanes(address);
            for _ in 0..31 {
                attempt(limiter, now, &password);
                attempt(limiter, now, &passkey);
            }
            for lanes in [
                setup_code_lanes(address),
                register_lanes(address),
                device_code_lanes(address),
            ] {
                attempt(limiter, now, &lanes);
            }
            attempt(limiter, now, &device_lookup_lanes(address));
            attempt(limiter, now, &document_lanes(address));
        }
    }

    #[test]
    fn with_the_address_families_full_a_known_device_still_signs_in_from_a_new_address() {
        let limiter = Limiter::default();
        fill_address_families(&limiter, 0);
        let known = known_device("a", v6(60_000), &device());
        assert_eq!(attempt(&limiter, 1, &known), None);
        let passkey = passkey_challenge_lanes(v6(60_001));
        assert_eq!(attempt(&limiter, 1, &passkey), None);
    }

    #[test]
    fn with_the_address_families_full_the_count_without_a_known_device_still_holds() {
        let limiter = Limiter::default();
        let first = (0..100)
            .filter(|n| {
                let lanes = no_device("a", v6(60_000 + n));
                attempt(&limiter, 0, &lanes).is_none()
            })
            .count();
        assert_eq!(first, 100);
        fill_address_families(&limiter, 1);
        assert!(attempt(&limiter, 2, &no_device("a", v6(61_000))).is_some());
    }

    #[test]
    fn full_sign_in_families_leave_credential_and_inbound_windows_alone() {
        use crate::app::limiter::{INBOUND_DELIVERIES, REQUESTS};
        let limiter = Limiter::default();
        let spent = [
            Lane::credential(REQUESTS, "key-1", 1, 60_000),
            Lane::credential(INBOUND_DELIVERIES, "endpoint-1", 1, 60_000),
        ];
        for lane in &spent {
            assert_eq!(attempt(&limiter, 0, std::slice::from_ref(lane)), None);
        }
        fill_address_families(&limiter, 0);
        for lane in &spent {
            assert!(attempt(&limiter, 1, std::slice::from_ref(lane)).is_some());
        }
        for family in [REQUESTS, INBOUND_DELIVERIES] {
            for key in ["new-1", "new-2"] {
                let fresh = [Lane::credential(family, key, 1, 60_000)];
                assert_eq!(attempt(&limiter, 1, &fresh), None);
            }
        }
    }

    #[test]
    fn only_the_owners_and_the_instances_windows_are_pinned() {
        let address = "203.0.113.1".parse().ok();
        let pinned = |lanes: &[Lane]| lanes.iter().map(|lane| lane.pinned).collect::<Vec<_>>();
        assert_eq!(pinned(&no_device("b", address)), [false, false, true]);
        assert_eq!(
            pinned(&known_device("a", address, &device())),
            [false, false, false, true]
        );
        let owners_username = password_lanes(
            "a",
            address,
            Sender::Stranger {
                owners_username: true,
            },
        );
        assert_eq!(pinned(&owners_username.all()), [false, false, true, true]);
        let credential = password_lanes("a", address, Sender::Credential);
        assert_eq!(pinned(&credential.all()), [false, false, true]);
        assert_eq!(pinned(&owner_document_lanes()), [true]);
        assert_eq!(pinned(&device_lookup_lanes(address)), [false, true]);
        assert_eq!(pinned(&device_owner_lanes("user", None)), [true, true]);
        assert_eq!(pinned(&document_lanes(address)), [false, true]);
        for lanes in [
            setup_code_lanes(address),
            register_lanes(address),
            passkey_challenge_lanes(address),
            device_code_lanes(address),
        ] {
            assert_eq!(pinned(&lanes), [false]);
        }
    }

    /// Every address without a known device spends the hour they share, at any username.
    fn fill_shared_hour(limiter: &Limiter) {
        for n in 0..10 {
            let address = format!("203.0.113.{n}").parse().ok();
            for m in 0..10 {
                let lanes = no_device(&format!("{n}.{m}"), address);
                assert_eq!(attempt(limiter, 0, &lanes), None);
            }
        }
        let next = no_device("next", "198.51.100.9".parse().ok());
        assert!(attempt(limiter, 1, &next).is_some(), "the witness");
    }

    #[test]
    fn only_an_attempt_at_the_owners_username_counts_in_the_owners_share() {
        let address = "203.0.113.1".parse().ok();
        let owners = password_lanes(
            "a",
            address,
            Sender::Stranger {
                owners_username: true,
            },
        );
        let other = password_lanes(
            "b",
            address,
            Sender::Stranger {
                owners_username: false,
            },
        );
        assert!(owners.owner.is_some());
        assert!(other.owner.is_none());
        assert_eq!(
            owners.shared.map(|lane| (lane.family, lane.key)),
            other.shared.map(|lane| (lane.family, lane.key)),
        );
    }

    #[test]
    fn strangers_who_spend_the_shared_hour_leave_the_owners_share_untouched() {
        let limiter = Limiter::default();
        fill_shared_hour(&limiter);
        let owners = password_lanes(
            "a",
            "198.51.100.1".parse().ok(),
            Sender::Stranger {
                owners_username: true,
            },
        );
        assert_eq!(attempt(&limiter, 1, &owners.before), None);
        let share = owners.owner.unwrap();
        let counted =
            (0..).take_while(|_| attempt(&limiter, 1, std::slice::from_ref(&share)).is_none());
        assert_eq!(counted.count(), 100);
    }

    #[test]
    fn the_owners_credential_counts_with_every_attempt_at_the_owners_username() {
        let limiter = Limiter::default();
        fill_shared_hour(&limiter);
        let share = password_lanes(
            "a",
            "198.51.100.1".parse().ok(),
            Sender::Stranger {
                owners_username: true,
            },
        )
        .owner
        .unwrap();
        for _ in 0..50 {
            assert_eq!(attempt(&limiter, 2, std::slice::from_ref(&share)), None);
        }
        for n in 0..50 {
            let address = format!("192.0.2.{}", n / 10).parse().ok();
            let lanes = password_lanes("a", address, Sender::Credential);
            assert_eq!(attempt(&limiter, 2, &lanes.all()), None, "attempt {n}");
        }
        let address = "198.51.100.2".parse().ok();
        let next = password_lanes("a", address, Sender::Credential);
        assert_eq!(attempt(&limiter, 3, &next.all()), Some(60 * MINUTE_MS - 1));
        assert!(attempt(&limiter, 3, std::slice::from_ref(&share)).is_some());
    }

    #[test]
    fn a_new_password_starts_the_owners_shares_afresh() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        let share = password_lanes(
            "a",
            address,
            Sender::Stranger {
                owners_username: true,
            },
        )
        .owner
        .unwrap();
        for _ in 0..100 {
            attempt(&limiter, 0, std::slice::from_ref(&share));
        }
        assert!(attempt(&limiter, 0, std::slice::from_ref(&share)).is_some());
        clear_for_new_password(&limiter);
        assert_eq!(attempt(&limiter, 1, std::slice::from_ref(&share)), None);
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
    fn a_new_password_starts_the_counts_across_addresses_and_leaves_an_addresss_own() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        for n in 0..30 {
            attempt(&limiter, 0, &no_device(&format!("u{n}"), address));
        }
        for n in 0..10 {
            let elsewhere = format!("198.51.100.{n}").parse().ok();
            for _ in 0..10 {
                attempt(&limiter, 0, &no_device("a", elsewhere));
            }
        }
        let fresh = "192.0.2.1".parse().ok();
        assert!(attempt(&limiter, 1, &no_device("a", fresh)).is_some());
        clear_for_new_password(&limiter);
        assert_eq!(attempt(&limiter, 1, &no_device("a", fresh)), None);
        let back = "198.51.100.0".parse().ok();
        assert!(attempt(&limiter, 1, &no_device("a", back)).is_some());
        assert!(attempt(&limiter, 1, &no_device("a", address)).is_some());
    }

    #[test]
    fn a_new_password_answers_every_username_from_an_address_alike() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        let owner = no_device("owner", address);
        let stranger = no_device("stranger", address);
        for _ in 0..10 {
            assert_eq!(attempt(&limiter, 0, &owner), None);
            assert_eq!(attempt(&limiter, 0, &stranger), None);
        }
        let before = [
            attempt(&limiter, 1, &owner),
            attempt(&limiter, 1, &stranger),
        ];
        assert_eq!(before, [Some(15 * MINUTE_MS - 1); 2]);
        clear_for_new_password(&limiter);
        let after = [
            attempt(&limiter, 2, &owner),
            attempt(&limiter, 2, &stranger),
        ];
        assert_eq!(after, [Some(15 * MINUTE_MS - 2); 2]);
    }

    #[test]
    fn a_recovery_lifts_every_password_limit() {
        let limiter = Limiter::default();
        let address = "203.0.113.1".parse().ok();
        for n in 0..30 {
            attempt(&limiter, 0, &no_device(&format!("u{n}"), address));
        }
        let known = device();
        for n in 0..10 {
            let elsewhere = format!("198.51.100.{n}").parse().ok();
            let lanes = known_device("a", elsewhere, &known);
            assert_eq!(attempt(&limiter, 0, &lanes), None);
        }
        let elsewhere = "198.51.100.99".parse().ok();
        let lanes = known_device("a", elsewhere, &known);
        assert!(attempt(&limiter, 1, &lanes).is_some());
        assert!(attempt(&limiter, 1, &no_device("a", address)).is_some());
        clear_for_recovery(&limiter);
        assert_eq!(attempt(&limiter, 1, &no_device("a", address)), None);
        assert_eq!(attempt(&limiter, 1, &lanes), None);
    }

    #[test]
    fn the_wait_is_whole_seconds_rounded_up_and_never_under_one() {
        let seconds = |wait_ms| {
            spent("x", wait_ms).details.unwrap()["retry_after_seconds"]
                .as_i64()
                .unwrap()
        };
        assert_eq!(seconds(1), 1);
        assert_eq!(seconds(1_000), 1);
        assert_eq!(seconds(1_001), 2);
        assert_eq!(seconds(15 * MINUTE_MS), 900);
    }
}
