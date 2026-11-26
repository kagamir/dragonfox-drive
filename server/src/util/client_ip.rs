//! Resolve the address for an account's device activity from its request.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

use axum::async_trait;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::{request::Parts, HeaderMap};
use ipnet::IpNet;

use crate::state::AppState;

#[derive(Clone, Copy, Debug, Default)]
pub struct ClientIp(pub Option<IpAddr>);

impl ClientIp {
    pub fn from_parts(parts: &Parts, state: &AppState) -> Self {
        Self(parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|peer| {
            resolve(peer.0.ip(), &parts.headers, &state.settings.server.trusted_proxies)
        }))
    }
}

#[async_trait]
impl FromRequestParts<AppState> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(Self::from_parts(parts, state))
    }
}

fn resolve(peer: IpAddr, headers: &HeaderMap, proxies: &[IpNet]) -> IpAddr {
    // Walk backwards from the socket. Only a trusted hop may identify the
    // previous one. Each header line is part of the same ordered XFF chain.
    let mut current = peer.to_canonical();
    if proxies.is_empty() {
        return current;
    }
    for header in headers.get_all("x-forwarded-for").iter().rev() {
        for hop in header.as_bytes().rsplit(|&byte| byte == b',') {
            if !proxies.iter().any(|net| net.contains(&current)) {
                return current;
            }
            let Some(ip) = std::str::from_utf8(hop).ok().and_then(|s| s.trim().parse::<IpAddr>().ok()) else {
                return current;
            };
            current = ip.to_canonical();
        }
    }
    current
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(value: &str) -> IpAddr {
        value.parse().unwrap()
    }

    fn lookup(peer: &str, lines: &[&str], networks: &[&str]) -> IpAddr {
        let mut headers = HeaderMap::new();
        for line in lines {
            headers.append("x-forwarded-for", line.parse().unwrap());
        }
        let proxies: Vec<_> = networks.iter().map(|cidr| cidr.parse().unwrap()).collect();
        resolve(address(peer), &headers, &proxies)
    }

    #[test]
    fn direct_clients_cannot_supply_a_forwarded_address() {
        let peer = "198.51.100.8";
        assert_eq!(lookup(peer, &["203.0.113.7"], &[]), address(peer));
        assert_eq!(lookup(peer, &["203.0.113.7"], &["10.0.0.0/8"]), address(peer));
        assert_eq!(lookup("::ffff:198.51.100.8", &[], &[]), address(peer));
    }

    #[test]
    fn stops_at_first_untrusted_hop_across_all_header_lines() {
        let address = lookup("::ffff:10.0.1.3", &["192.0.2.9, 203.0.113.8", "2001:db8:beef::42"],
            &["10.0.1.3/32", "2001:db8:beef::/48"]);
        assert_eq!(address.to_string(), "203.0.113.8");
    }

    #[test]
    fn invalid_bytes_in_an_untrusted_prefix_do_not_hide_the_client() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", axum::http::HeaderValue::from_bytes(b"\x80, 198.51.100.10").unwrap());
        assert_eq!(resolve(address("::1"), &headers, &["::1/128".parse().unwrap()]), address("198.51.100.10"));
    }

    #[test]
    fn malformed_or_missing_hops_cannot_cross_the_trust_boundary() {
        assert_eq!(lookup("::1", &["203.0.113.7, unknown"], &["::1/128"]), address("::1"));
        assert_eq!(lookup("::1", &[], &["::1/128"]), address("::1"));
        assert_eq!(lookup("::1", &["2001:db8::1234"], &["::1/128"]), address("2001:db8::1234"));
    }
}
