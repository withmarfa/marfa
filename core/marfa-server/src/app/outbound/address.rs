//! Which addresses are on the public internet.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use ipnet::{Ipv4Net, Ipv6Net};

const NOT_PUBLIC_V4: [(Ipv4Addr, u8); 16] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 88, 99, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
    (Ipv4Addr::new(255, 255, 255, 255), 32),
];

fn within_v4(ip: Ipv4Addr, (network, prefix): (Ipv4Addr, u8)) -> bool {
    Ipv4Net::new(network, prefix).is_ok_and(|net| net.contains(&ip))
}

fn within_v6(ip: Ipv6Addr, network: Ipv6Addr, prefix: u8) -> bool {
    Ipv6Net::new(network, prefix).is_ok_and(|net| net.contains(&ip))
}

/// IPv6 is public only in `2000::/3`, outside the documentation block; an IPv4 address written
/// as IPv6 is judged as itself.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !NOT_PUBLIC_V4.iter().any(|block| within_v4(v4, *block)),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public(IpAddr::V4(v4)),
            None => {
                within_v6(v6, Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                    && !within_v6(v6, Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32)
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(text: &str) -> bool {
        is_public(text.parse().expect("an address"))
    }

    #[test]
    fn refuses_every_class_that_is_not_public() {
        for address in [
            "127.0.0.1",
            "127.255.255.254",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "192.0.2.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "64:ff9b::7f00:1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            assert!(!public(address), "{address}");
        }
    }

    #[test]
    fn takes_public_addresses_of_both_families() {
        for address in [
            "93.184.216.34",
            "8.8.8.8",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700:4700::1111",
            "2a00:1450:4009:80b::200e",
            "::ffff:93.184.216.34",
        ] {
            assert!(public(address), "{address}");
        }
    }
}
