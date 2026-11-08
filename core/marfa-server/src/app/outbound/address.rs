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

pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => !NOT_PUBLIC_V4.iter().any(|block| within_v4(v4, *block)),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    if let Some(v4) = ip.to_ipv4() {
        return is_public(IpAddr::V4(v4));
    }
    let in_prefix = |a, b, c, prefix| within_v6(ip, Ipv6Addr::new(a, b, c, 0, 0, 0, 0, 0), prefix);
    if in_prefix(0x64, 0xff9b, 0, 96) {
        let bytes = ip.octets();
        return is_public(IpAddr::V4(Ipv4Addr::new(
            bytes[12], bytes[13], bytes[14], bytes[15],
        )));
    }
    // IANA IPv6 Special-Purpose Address Registry, 2025-10-09.
    if in_prefix(0x2001, 0, 0, 23) {
        return matches!(ip.segments(), [0x2001, 1, 0, 0, 0, 0, 0, 1..=3])
            || in_prefix(0x2001, 3, 0, 32)
            || in_prefix(0x2001, 4, 0x112, 48)
            || in_prefix(0x2001, 0x20, 0, 28)
            || in_prefix(0x2001, 0x30, 0, 28);
    }
    in_prefix(0x2000, 0, 0, 3)
        && !in_prefix(0x2001, 0xdb8, 0, 32)
        && !in_prefix(0x2002, 0, 0, 16)
        && !in_prefix(0x3fff, 0, 0, 20)
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
            "2002:7f00:1::1",
            "2002:a00:1::1",
            "2002:808:808::1",
            "2001::1",
            "2001:2::1",
            "2001:10::1",
            "3fff::1",
            "3fff:fff::1",
            "64:ff9b:1::808:808",
            "100:0:0:1::1",
            "5f00::1",
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
            "::93.184.216.34",
            "64:ff9b::808:808",
            "2001:1::1",
            "2001:1::2",
            "2001:1::3",
            "2001:3::1",
            "2001:4:112::1",
            "2001:20::1",
            "2001:30::1",
            "3fff:1000::1",
        ] {
            assert!(public(address), "{address}");
        }
    }
}
