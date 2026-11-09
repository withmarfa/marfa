//! The bounds on a listener's open connections, judged before any request is read.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, PoisonError};

use super::answer::refusal_body;
use super::listening::Peer;
use crate::app::refusal::{Code, Refusal};
use crate::listener::{Trust, network};

/// What a refused caller is told to wait, in seconds.
const RETRY_AFTER_SECONDS: u64 = 5;

#[derive(Clone, Debug)]
pub struct Caps {
    pub total: usize,
    pub per_address: usize,
    /// A believed proxy carries many callers, so it counts in the total alone.
    pub trust: Trust,
}

#[derive(Debug, Default)]
struct Held {
    total: usize,
    networks: HashMap<IpAddr, usize>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Turned {
    Listener,
    Address,
}

pub struct Gate {
    caps: Caps,
    held: Mutex<Held>,
}

/// Frees its place when the connection ends.
pub struct Slot {
    gate: Arc<Gate>,
    network: Option<IpAddr>,
}

impl Gate {
    pub fn new(caps: Caps) -> Arc<Gate> {
        Arc::new(Gate {
            caps,
            held: Mutex::new(Held::default()),
        })
    }

    pub fn enter(self: &Arc<Gate>, peer: Peer) -> Result<Slot, Turned> {
        let counted = peer
            .0
            .filter(|address| !self.caps.trust.believes(*address))
            .map(network);
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        if held.total >= self.caps.total {
            return Err(Turned::Listener);
        }
        if let Some(network) = counted {
            if held.networks.get(&network).copied().unwrap_or(0) >= self.caps.per_address {
                return Err(Turned::Address);
            }
            *held.networks.entry(network).or_default() += 1;
        }
        held.total += 1;
        Ok(Slot {
            gate: self.clone(),
            network: counted,
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut held = self
            .gate
            .held
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        held.total = held.total.saturating_sub(1);
        if let Some(network) = self.network
            && let Some(count) = held.networks.get_mut(&network)
        {
            *count -= 1;
            if *count == 0 {
                held.networks.remove(&network);
            }
        }
    }
}

/// The whole answer to a connection that is turned away.
pub fn turned_away() -> Vec<u8> {
    let body = refusal_body(&Refusal::new(
        Code::TooManyConnections,
        "This server holds as many connections as it allows. Try again shortly.",
    ));
    let mut answer = format!(
        "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n\
         X-Error-Code: {}\r\nRetry-After: {RETRY_AFTER_SECONDS}\r\nConnection: close\r\n\
         Content-Length: {}\r\n\r\n",
        Code::TooManyConnections.wire(),
        body.len()
    )
    .into_bytes();
    answer.extend(body);
    answer
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(total: usize, per_address: usize, trust: Trust) -> Arc<Gate> {
        Gate::new(Caps {
            total,
            per_address,
            trust,
        })
    }

    fn peer(text: &str) -> Peer {
        Peer(Some(text.parse().unwrap()))
    }

    #[test]
    fn the_listener_holds_no_more_than_its_total_and_frees_a_place_when_one_ends() {
        let gate = gate(3, 3, Trust::Nothing);
        let held: Vec<_> = ["192.0.2.1", "192.0.2.2", "192.0.2.3"]
            .into_iter()
            .map(|address| gate.enter(peer(address)).unwrap())
            .collect();
        assert_eq!(gate.enter(peer("192.0.2.4")).err(), Some(Turned::Listener));
        drop(held);
        assert!(gate.enter(peer("192.0.2.4")).is_ok());
    }

    #[test]
    fn one_address_holds_no_more_than_its_share_and_another_is_not_held_back() {
        let gate = gate(10, 2, Trust::Nothing);
        let first = gate.enter(peer("192.0.2.1")).unwrap();
        let _second = gate.enter(peer("192.0.2.1")).unwrap();
        assert_eq!(gate.enter(peer("192.0.2.1")).err(), Some(Turned::Address));
        assert!(gate.enter(peer("192.0.2.2")).is_ok());
        drop(first);
        assert!(gate.enter(peer("192.0.2.1")).is_ok());
    }

    #[test]
    fn an_address_is_one_whether_mapped_or_not_and_an_ipv6_network_shares_a_share() {
        let gate = gate(10, 2, Trust::Nothing);
        let _a = gate.enter(peer("192.0.2.1")).unwrap();
        let _b = gate.enter(peer("::ffff:192.0.2.1")).unwrap();
        assert_eq!(gate.enter(peer("192.0.2.1")).err(), Some(Turned::Address));
        let _c = gate.enter(peer("2001:db8:1:2::1")).unwrap();
        let _d = gate.enter(peer("2001:db8:1:2:ffff::9")).unwrap();
        assert_eq!(
            gate.enter(peer("2001:db8:1:2::77")).err(),
            Some(Turned::Address)
        );
        assert!(gate.enter(peer("2001:db8:1:3::1")).is_ok());
    }

    #[test]
    fn a_proxy_the_listener_believes_counts_in_the_total_alone() {
        let ranges = crate::listener::proxy_ranges("10.0.0.0/8").unwrap();
        let gate = gate(4, 1, Trust::Proxies(ranges));
        let _held: Vec<_> = (0..3)
            .map(|_| gate.enter(peer("10.0.0.1")).unwrap())
            .collect();
        let _outside = gate.enter(peer("192.0.2.1")).unwrap();
        assert_eq!(gate.enter(peer("192.0.2.1")).err(), Some(Turned::Listener));
        assert_eq!(gate.enter(peer("10.0.0.1")).err(), Some(Turned::Listener));
    }

    #[test]
    fn a_peer_with_no_address_counts_in_the_total_alone() {
        let gate = gate(2, 1, Trust::Nothing);
        let _a = gate.enter(Peer(None)).unwrap();
        let _b = gate.enter(Peer(None)).unwrap();
        assert_eq!(gate.enter(Peer(None)).err(), Some(Turned::Listener));
    }

    #[test]
    fn the_answer_is_a_whole_503_that_names_its_wait_and_closes() {
        let answer = String::from_utf8(turned_away()).unwrap();
        let (head, body) = answer.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(head.contains("Retry-After: 5"));
        assert!(head.contains("Connection: close"));
        assert!(head.contains(&format!("Content-Length: {}", body.len())));
        let envelope: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(envelope["error"]["code"], "too_many_connections");
    }
}
