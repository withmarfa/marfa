//! Who a request says it came from, believed only as far as its listener
//! trusts the network in front of it.

use std::net::IpAddr;

use axum::http::HeaderMap;
use ipnet::IpNet;

use crate::listener::Trust;

const FORWARDED_FOR: &str = "x-forwarded-for";

/// More hops than any real chain of proxies has. Past it the walk stops as it
/// does at a malformed entry.
const MAX_HOPS: usize = 32;

pub fn caller_address(peer: IpAddr, trust: &Trust, headers: &HeaderMap) -> IpAddr {
    let peer = peer.to_canonical();
    match trust {
        Trust::Nothing => peer,
        Trust::EdgeHeader { header, ranges } if inside(ranges, peer) => {
            edge_address(header, headers).unwrap_or(peer)
        }
        Trust::Proxies(ranges) if inside(ranges, peer) => walked(peer, ranges, headers),
        Trust::EdgeHeader { .. } | Trust::Proxies(_) => peer,
    }
}

fn inside(ranges: &[IpNet], address: IpAddr) -> bool {
    ranges.iter().any(|range| range.contains(&address))
}

/// An edge overwrites its header, so anything but one address did not come
/// from it.
fn edge_address(name: &str, headers: &HeaderMap) -> Option<IpAddr> {
    let mut values = headers.get_all(name).iter();
    match (values.next(), values.next()) {
        (Some(value), None) => address_in(value.as_bytes()),
        _ => None,
    }
}

fn address_in(text: &[u8]) -> Option<IpAddr> {
    let address: IpAddr = str::from_utf8(text).ok()?.parse().ok()?;
    Some(address.to_canonical())
}

/// Only entries right of the first untrusted address were written by a proxy.
fn walked(peer: IpAddr, ranges: &[IpNet], headers: &HeaderMap) -> IpAddr {
    let hops = headers
        .get_all(FORWARDED_FOR)
        .iter()
        .rev()
        .flat_map(|value| value.as_bytes().rsplit(|byte| *byte == b','))
        .take(MAX_HOPS);
    let mut caller = peer;
    for hop in hops {
        match address_in(hop.trim_ascii()) {
            Some(address) if inside(ranges, address) => caller = address,
            Some(address) => return address,
            None => break,
        }
    }
    caller
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderName, HeaderValue};
    use proptest::collection::vec;
    use proptest::prelude::*;

    use super::*;

    const XFF: &str = "x-forwarded-for";
    const EDGE: &str = "x-client";

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn proxies(text: &str) -> Trust {
        Trust::Proxies(crate::listener::proxy_ranges(text).unwrap())
    }

    fn edge(text: &str) -> Trust {
        Trust::EdgeHeader {
            header: EDGE.to_string(),
            ranges: crate::listener::proxy_ranges(text).unwrap(),
        }
    }

    fn headers<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a [u8])>) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_bytes(value).unwrap(),
            );
        }
        map
    }

    type Case<'a> = (&'a str, &'a str, Trust, &'a [(&'a str, &'a str)], &'a str);

    #[test]
    fn each_kind_of_trust_answers_as_it_should() {
        let inner = "10.0.0.0/8";
        let tunnel = "127.0.0.0/8, ::1/128";
        #[rustfmt::skip]
        let table: &[Case] = &[
            ("no trust ignores a forwarded address", "192.0.2.1", Trust::Nothing, &[(XFF, "203.0.113.9")], "192.0.2.1"),
            ("no trust ignores an edge's header", "192.0.2.1", Trust::Nothing, &[(EDGE, "203.0.113.9")], "192.0.2.1"),
            ("no trust normalizes a mapped peer", "::ffff:192.0.2.1", Trust::Nothing, &[], "192.0.2.1"),

            ("edge from the tunnel: one address is believed", "127.0.0.1", edge(tunnel), &[(EDGE, "203.0.113.9")], "203.0.113.9"),
            ("edge from the tunnel: IPv6", "127.0.0.1", edge(tunnel), &[(EDGE, "2001:db8::9")], "2001:db8::9"),
            ("edge from the tunnel: mapped is normalized", "127.0.0.1", edge(tunnel), &[(EDGE, "::ffff:203.0.113.9")], "203.0.113.9"),
            ("edge from the tunnel: missing", "127.0.0.1", edge(tunnel), &[], "127.0.0.1"),
            ("edge from the tunnel: empty", "127.0.0.1", edge(tunnel), &[(EDGE, "")], "127.0.0.1"),
            ("edge from the tunnel: repeated", "127.0.0.1", edge(tunnel), &[(EDGE, "203.0.113.9"), (EDGE, "203.0.113.10")], "127.0.0.1"),
            ("edge from the tunnel: repeated the same", "127.0.0.1", edge(tunnel), &[(EDGE, "203.0.113.9"), (EDGE, "203.0.113.9")], "127.0.0.1"),
            ("edge from the tunnel: malformed", "127.0.0.1", edge(tunnel), &[(EDGE, "unknown")], "127.0.0.1"),
            ("edge from the tunnel: carries no chain", "127.0.0.1", edge(tunnel), &[(EDGE, "203.0.113.9, 203.0.113.10")], "127.0.0.1"),
            ("edge from the tunnel: a port", "127.0.0.1", edge(tunnel), &[(EDGE, "203.0.113.9:443")], "127.0.0.1"),
            ("edge from the tunnel: brackets", "127.0.0.1", edge(tunnel), &[(EDGE, "[2001:db8::9]")], "127.0.0.1"),
            ("edge from the tunnel: stray whitespace", "127.0.0.1", edge(tunnel), &[(EDGE, " 203.0.113.9")], "127.0.0.1"),
            ("edge from the tunnel: ignores X-Forwarded-For", "127.0.0.1", edge(tunnel), &[(XFF, "203.0.113.9")], "127.0.0.1"),
            ("edge from the tunnel: an IPv6 loopback peer", "::1", edge(tunnel), &[(EDGE, "203.0.113.9")], "203.0.113.9"),
            ("edge from the tunnel: a peer off this machine", "192.0.2.1", edge(tunnel), &[(EDGE, "203.0.113.9")], "192.0.2.1"),
            ("edge from everywhere: one address", "192.0.2.1", edge("0.0.0.0/0, ::/0"), &[(EDGE, "203.0.113.9")], "203.0.113.9"),
            ("edge from everywhere: an IPv6 peer", "2001:db8::1", edge("0.0.0.0/0, ::/0"), &[(EDGE, "203.0.113.9")], "203.0.113.9"),

            ("edge from 10/8: a peer inside is believed", "10.0.0.1", edge(inner), &[(EDGE, "203.0.113.9")], "203.0.113.9"),
            ("edge from 10/8: a mapped peer inside is believed", "::ffff:10.0.0.1", edge(inner), &[(EDGE, "203.0.113.9")], "203.0.113.9"),
            ("edge from 10/8: a peer outside is not", "192.0.2.1", edge(inner), &[(EDGE, "203.0.113.9")], "192.0.2.1"),
            ("edge from 10/8: a mapped peer outside is not", "::ffff:192.0.2.1", edge(inner), &[(EDGE, "203.0.113.9")], "192.0.2.1"),
            ("edge from 10/8: missing from inside", "10.0.0.1", edge(inner), &[], "10.0.0.1"),
            ("edge from 10/8: repeated from inside", "10.0.0.1", edge(inner), &[(EDGE, "203.0.113.9"), (EDGE, "203.0.113.10")], "10.0.0.1"),
            ("edge from 10/8: malformed from inside", "10.0.0.1", edge(inner), &[(EDGE, "unknown")], "10.0.0.1"),
            ("edge from 10/8: ignores X-Forwarded-For", "10.0.0.1", edge(inner), &[(XFF, "203.0.113.9")], "10.0.0.1"),

            ("peer outside the ranges is not believed", "192.0.2.1", proxies(inner), &[(XFF, "203.0.113.9")], "192.0.2.1"),
            ("the first untrusted from the right", "10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9, 10.0.0.2, 10.0.0.3")], "203.0.113.9"),
            ("a spoofed left-most entry loses", "10.0.0.1", proxies(inner), &[(XFF, "198.51.100.66, 203.0.113.9, 10.0.0.2")], "203.0.113.9"),
            ("a spoofed trusted entry loses", "10.0.0.1", proxies(inner), &[(XFF, "10.9.9.9, 203.0.113.9")], "203.0.113.9"),
            ("repeated values are walked in order", "10.0.0.1", proxies(inner), &[(XFF, "198.51.100.66"), (XFF, "203.0.113.9, 10.0.0.2"), (XFF, "10.0.0.3")], "203.0.113.9"),
            ("every entry trusted gives the left-most", "10.0.0.1", proxies(inner), &[(XFF, "10.0.0.2, 10.0.0.3")], "10.0.0.2"),
            ("no entries give the peer", "10.0.0.1", proxies(inner), &[], "10.0.0.1"),
            ("an empty value gives the peer", "10.0.0.1", proxies(inner), &[(XFF, "")], "10.0.0.1"),
            ("malformed on the right gives the peer", "10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9, unknown")], "10.0.0.1"),
            ("malformed stops the walk", "10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9, unknown, 10.0.0.2")], "10.0.0.2"),
            ("an empty entry stops the walk", "10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9,,10.0.0.2")], "10.0.0.2"),
            ("an entry with a port is malformed", "10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9:443")], "10.0.0.1"),
            ("an entry in brackets is malformed", "10.0.0.1", proxies(inner), &[(XFF, "[2001:db8::9]")], "10.0.0.1"),
            ("an entry with a zone is malformed", "10.0.0.1", proxies(inner), &[(XFF, "fe80::1%eth0")], "10.0.0.1"),
            ("whitespace inside an entry is malformed", "10.0.0.1", proxies(inner), &[(XFF, "203.0. 113.9")], "10.0.0.1"),
            ("whitespace around an entry is the list's", "10.0.0.1", proxies(inner), &[(XFF, " 203.0.113.9\t,  10.0.0.2 ")], "203.0.113.9"),
            ("a mapped peer matches an IPv4 range", "::ffff:10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9")], "203.0.113.9"),
            ("a mapped peer outside stays outside", "::ffff:192.0.2.1", proxies(inner), &[(XFF, "203.0.113.9")], "192.0.2.1"),
            ("a mapped entry is normalized", "10.0.0.1", proxies(inner), &[(XFF, "::ffff:203.0.113.9")], "203.0.113.9"),
            ("a mapped entry matches an IPv4 range", "10.0.0.1", proxies(inner), &[(XFF, "203.0.113.9, ::ffff:10.0.0.2")], "203.0.113.9"),
            ("an IPv6 proxy and caller", "fd00::1", proxies("fd00::/8"), &[(XFF, "2001:db8::9, fd00::2")], "2001:db8::9"),
            ("an IPv4 address never matches an IPv6 range", "192.0.2.1", proxies("::/0"), &[(XFF, "203.0.113.9")], "192.0.2.1"),
        ];
        for (name, peer, trust, pairs, answer) in table {
            let sent = headers(pairs.iter().map(|(name, value)| (*name, value.as_bytes())));
            assert_eq!(caller_address(ip(peer), trust, &sent), ip(answer), "{name}");
        }
    }

    #[test]
    fn a_value_that_is_not_text_counts_as_malformed() {
        let opaque: &[u8] = b"203.0.113.9\xff";
        let walked = headers([(XFF, opaque)]);
        let peer = ip("10.0.0.1");
        assert_eq!(caller_address(peer, &proxies("10.0.0.0/8"), &walked), peer);
        let edged = headers([(EDGE, opaque)]);
        assert_eq!(caller_address(peer, &edge("10.0.0.0/8"), &edged), peer);
    }

    #[test]
    fn the_walk_is_bounded() {
        let chain = |length: usize| {
            let trusted = vec!["10.0.0.2"; length].join(",");
            format!("203.0.113.9,{trusted}")
        };
        let trust = proxies("10.0.0.0/8");
        let answer = |length| {
            let value = chain(length);
            caller_address(ip("10.0.0.1"), &trust, &headers([(XFF, value.as_bytes())]))
        };
        assert_eq!(answer(MAX_HOPS - 1), ip("203.0.113.9"));
        assert_eq!(answer(MAX_HOPS), ip("10.0.0.2"));
    }

    fn entry() -> impl Strategy<Value = String> {
        prop_oneof![
            any::<std::net::Ipv4Addr>().prop_map(|address| address.to_string()),
            any::<std::net::Ipv6Addr>().prop_map(|address| address.to_string()),
            any::<std::net::Ipv4Addr>().prop_map(|address| address.to_ipv6_mapped().to_string()),
            "10\\.[0-9]{1,3}\\.0\\.1",
            "[ -~]{0,16}",
        ]
    }

    fn value() -> impl Strategy<Value = Vec<u8>> {
        prop_oneof![
            vec(entry(), 0..6).prop_map(|entries| entries.join(",").into_bytes()),
            vec(any::<u8>(), 0..32),
        ]
        .prop_filter("a header value", |bytes| {
            HeaderValue::from_bytes(bytes).is_ok()
        })
    }

    fn held_in(values: &[Vec<u8>]) -> Vec<IpAddr> {
        values
            .iter()
            .map(|value| String::from_utf8_lossy(value))
            .flat_map(|value| {
                let entries = value.split(',').map(|entry| entry.trim().parse::<IpAddr>());
                entries.flatten().collect::<Vec<_>>()
            })
            .map(|address| address.to_canonical())
            .collect()
    }

    proptest! {
        #[test]
        fn header_text_only_ever_gives_the_peer_or_an_address_it_holds(
            peer in any::<IpAddr>(),
            forwarded in vec(value(), 0..4),
            edged in vec(value(), 0..3),
        ) {
            let mut sent = HeaderMap::new();
            for (name, values) in [(XFF, &forwarded), (EDGE, &edged)] {
                for value in values {
                    sent.append(
                        HeaderName::from_bytes(name.as_bytes()).unwrap(),
                        HeaderValue::from_bytes(value).unwrap(),
                    );
                }
            }
            let peer_answer = peer.to_canonical();
            prop_assert_eq!(caller_address(peer, &Trust::Nothing, &sent), peer_answer);

            for trust in [edge("0.0.0.0/0, ::/0"), edge("10.0.0.0/8")] {
                let answer = caller_address(peer, &trust, &sent);
                prop_assert!(answer == peer_answer || held_in(&edged).contains(&answer));
            }

            let held = held_in(&forwarded);
            for trust in [proxies("0.0.0.0/0, ::/0"), proxies("10.0.0.0/8")] {
                let answer = caller_address(peer, &trust, &sent);
                prop_assert!(answer == peer_answer || held.contains(&answer));
            }
        }
    }
}
