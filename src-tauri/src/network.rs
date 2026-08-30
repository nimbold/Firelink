//! Shared network-target policy and route plumbing.
//!
//! Hostname resolution is deliberately not part of URL policy. The selected
//! route (the OS/TUN resolver, an explicit proxy, or the consumer's own
//! resolver) owns that decision. Only literal local targets and reserved local
//! names are rejected here.

use std::net::IpAddr;

use reqwest::{ClientBuilder, Proxy, Url};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NetworkRoute {
    /// Preserve reqwest's normal environment/OS route selection.
    Inherited,
    /// Bypass configured/environment proxies and use the direct OS route.
    Direct,
    /// Route the consumer through this configured proxy.
    Proxy(String),
}

impl NetworkRoute {
    pub(crate) fn from_proxy(proxy: Option<&str>) -> Self {
        match proxy.map(str::trim) {
            None => Self::Inherited,
            Some(value) if value.is_empty() || value.eq_ignore_ascii_case("none") => Self::Direct,
            Some(value) => Self::Proxy(value.to_string()),
        }
    }

    pub(crate) fn configure_reqwest(
        &self,
        builder: ClientBuilder,
    ) -> Result<ClientBuilder, String> {
        match self {
            Self::Inherited => Ok(builder),
            Self::Direct => Ok(builder.no_proxy()),
            Self::Proxy(value) => {
                let proxy = Proxy::all(value)
                    .map_err(|error| crate::redact_sensitive_text(&error.to_string()))?;
                Ok(builder.proxy(proxy))
            }
        }
    }

    /// Translate the route into Aria2's all-proxy option without changing the
    /// target hostname. Aria2 accepts HTTP-family proxy endpoints for normal
    /// transfers; reqwest and yt-dlp consumers may still retain SOCKS routes.
    pub(crate) fn aria2_proxy_value(&self) -> Result<Option<String>, String> {
        match self {
            Self::Inherited => Ok(None),
            Self::Direct => Ok(Some(String::new())),
            Self::Proxy(value) => {
                let parsed = Url::parse(value).map_err(|error| {
                    crate::redact_sensitive_text(&format!("invalid Aria2 proxy URL: {error}"))
                })?;
                if parsed.host_str().is_none_or(str::is_empty) {
                    return Err("invalid Aria2 proxy URL: proxy must include a host".to_string());
                }
                let is_socks = parsed.scheme().eq_ignore_ascii_case("socks")
                    || parsed.scheme().to_ascii_lowercase().starts_with("socks");
                if is_socks {
                    return Err(
                        "SOCKS system proxies are not supported for normal file downloads because aria2 only accepts HTTP/HTTPS/FTP proxy URLs. Use an HTTP proxy endpoint for normal downloads, or use media downloads where yt-dlp supports SOCKS."
                            .to_string(),
                    );
                }
                if !matches!(parsed.scheme(), "http" | "https" | "ftp") {
                    return Err(
                        "Aria2 proxy must use an HTTP, HTTPS, or FTP proxy URL".to_string(),
                    );
                }
                Ok(Some(value.clone()))
            }
        }
    }

    /// Translate the route into yt-dlp's explicit proxy argument. `None`
    /// means inherit the process/OS route; an empty value deliberately disables
    /// inherited proxies for an explicit direct route.
    pub(crate) fn ytdlp_proxy_value(&self) -> Option<&str> {
        match self {
            Self::Inherited => None,
            Self::Direct => Some(""),
            Self::Proxy(value) => Some(value),
        }
    }

    pub(crate) fn label(&self) -> &'static str {
        match self {
            Self::Inherited => "inherited",
            Self::Direct => "direct",
            Self::Proxy(_) => "configured",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CredentialPolicy {
    Allow,
    Reject(&'static str),
}

/// Validate a parsed URL without resolving its hostname.
pub(crate) fn validate_url(
    parsed: &Url,
    allowed_schemes: &[&str],
    credentials: CredentialPolicy,
) -> Result<(), String> {
    if !allowed_schemes
        .iter()
        .any(|scheme| parsed.scheme() == *scheme)
    {
        return Err("Unsupported URL scheme".to_string());
    }

    let host = parsed
        .host_str()
        .filter(|host| !host.trim().is_empty())
        .ok_or_else(|| "SSRF blocked: No host".to_string())?;

    if let CredentialPolicy::Reject(message) = credentials {
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(message.to_string());
        }
    }

    validate_host(host)
}

pub(crate) fn parse_and_validate_url(
    raw: &str,
    allowed_schemes: &[&str],
    credentials: CredentialPolicy,
) -> Result<Url, String> {
    let parsed = Url::parse(raw).map_err(|_| "SSRF blocked: Invalid URL".to_string())?;
    validate_url(&parsed, allowed_schemes, credentials)?;
    Ok(parsed)
}

pub(crate) fn is_local_hostname(host: &str) -> bool {
    let normalized = host.trim().trim_end_matches('.').to_ascii_lowercase();
    normalized == "localhost"
        || normalized.ends_with(".localhost")
        || matches!(
            normalized.as_str(),
            "localhost.localdomain" | "ip6-localhost" | "ip6-loopback"
        )
        || normalized.ends_with(".local")
}

/// Validate a network hostname without asking the application to resolve it.
///
/// This is also used for hostname/port pairs embedded in Torrent metadata,
/// where no URL parser has normalized legacy numeric IPv4 spellings for us.
pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty()
        || host
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err("SSRF blocked: Invalid host".to_string());
    }
    let normalized_host = host.trim_end_matches('.');
    let bracketed = normalized_host.starts_with('[') || normalized_host.ends_with(']');
    let normalized_host = match (
        normalized_host.starts_with('['),
        normalized_host.ends_with(']'),
    ) {
        (true, true) => &normalized_host[1..normalized_host.len() - 1],
        (false, false) => normalized_host,
        _ => return Err("SSRF blocked: Invalid host".to_string()),
    };
    if normalized_host.is_empty() {
        return Err("SSRF blocked: Invalid host".to_string());
    }
    if bracketed && (!normalized_host.contains(':') || parse_literal_ip(normalized_host).is_none())
    {
        return Err("SSRF blocked: Invalid host".to_string());
    }
    if is_local_hostname(normalized_host)
        || parse_literal_ip(normalized_host).is_some_and(is_blocked_network_address)
    {
        return Err("SSRF blocked: Private/local IP not allowed".to_string());
    }
    if normalized_host.contains(':') && parse_literal_ip(normalized_host).is_none() {
        return Err("SSRF blocked: Invalid host".to_string());
    }
    if !normalized_host.contains(':') && url::Host::parse(normalized_host).is_err() {
        return Err("SSRF blocked: Invalid host".to_string());
    }
    Ok(())
}

fn parse_literal_ip(host: &str) -> Option<IpAddr> {
    let host = host.trim_end_matches('.');
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Some((address, _zone)) = host.split_once("%25") {
        if let Ok(ip) = address.parse::<IpAddr>() {
            return Some(ip);
        }
    }

    // URL parsers commonly canonicalize legacy IPv4 literals such as 127.1,
    // decimal IPv4, hexadecimal IPv4, and octal IPv4. Reuse that canonical
    // parser for raw Torrent node hosts so those spellings cannot bypass the
    // literal-target policy without performing DNS.
    let candidate = if host.contains(':') {
        format!("http://[{host}]/")
    } else {
        format!("http://{host}/")
    };
    let parsed = Url::parse(&candidate).ok()?;
    parsed.host_str()?.parse::<IpAddr>().ok()
}

pub(crate) fn is_blocked_network_address(ip: IpAddr) -> bool {
    if ip.is_loopback() || ip.is_multicast() || ip.is_unspecified() {
        return true;
    }
    match ip {
        IpAddr::V4(ipv4) => ipv4.is_private() || ipv4.is_link_local(),
        IpAddr::V6(ipv6) => {
            // Check both IPv4-mapped and deprecated IPv4-compatible forms;
            // either can encode a local IPv4 destination behind an IPv6
            // literal.
            ipv6.to_ipv4_mapped()
                .or_else(|| ipv6.to_ipv4())
                .is_some_and(|ipv4| is_blocked_network_address(ipv4.into()))
                || (ipv6.segments()[0] & 0xfe00) == 0xfc00
                || (ipv6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate(raw: &str, schemes: &[&str]) -> Result<(), String> {
        parse_and_validate_url(raw, schemes, CredentialPolicy::Allow).map(|_| ())
    }

    #[test]
    fn rejects_literal_local_and_mapped_addresses() {
        for raw in [
            "http://127.0.0.1/file",
            "http://10.0.0.8/file",
            "http://169.254.10.2/file",
            "http://[::1]/file",
            "http://[::ffff:127.0.0.1]/file",
            "http://[::ffff:169.254.169.254]/file",
            "http://[fc00::1]/file",
            "http://[fe80::1]/file",
            "http://127.0.0.1./file",
            // URL parsers commonly canonicalize these legacy IPv4 literal
            // spellings, but keep the policy test explicit so a parser
            // upgrade cannot turn them into SSRF bypasses.
            "http://127.1/file",
            "http://2130706433/file",
            "http://0x7f000001/file",
            "http://0177.0.0.1/file",
            "http://0/file",
        ] {
            assert_eq!(
                validate(raw, &["http", "https"]),
                Err("SSRF blocked: Private/local IP not allowed".to_string()),
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_localhost_aliases_without_dns() {
        for raw in [
            "http://localhost/file",
            "http://localhost./file",
            "http://media.localhost/file",
            "http://localhost.localdomain/file",
            "http://printer.local/file",
        ] {
            assert_eq!(
                validate(raw, &["http", "https"]),
                Err("SSRF blocked: Private/local IP not allowed".to_string()),
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_scoped_link_local_literals() {
        assert!(matches!(
            validate("http://[fe80::1%25en0]/file", &["http", "https"]),
            Err(message) if message.contains("SSRF blocked")
        ));
    }

    #[test]
    fn public_hostname_validation_does_not_require_application_dns() {
        assert_eq!(
            validate(
                "https://this-host-does-not-resolve.invalid/file",
                &["http", "https"]
            ),
            Ok(())
        );
        assert_eq!(
            validate("https://[2001:db8::1]/file", &["http", "https"]),
            Ok(())
        );
        assert_eq!(
            validate_host("2001:db8::1"),
            Ok(()),
            "public IPv6 literals must remain usable without DNS"
        );
    }

    #[test]
    fn raw_hosts_reject_legacy_literals_without_resolving_public_names() {
        for host in ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "0"] {
            assert_eq!(
                validate_host(host),
                Err("SSRF blocked: Private/local IP not allowed".to_string()),
                "{host}"
            );
        }
        assert!(validate_host("node-does-not-resolve.invalid").is_ok());
    }

    #[test]
    fn route_mapping_preserves_direct_and_proxy_choices() {
        crate::ensure_reqwest_crypto_provider();
        assert_eq!(NetworkRoute::from_proxy(None), NetworkRoute::Inherited);
        assert_eq!(NetworkRoute::from_proxy(Some("none")), NetworkRoute::Direct);
        assert_eq!(NetworkRoute::from_proxy(Some("  ")), NetworkRoute::Direct);
        assert_eq!(
            NetworkRoute::from_proxy(Some("http://proxy.example:8080")),
            NetworkRoute::Proxy("http://proxy.example:8080".to_string())
        );
        assert_eq!(NetworkRoute::from_proxy(None).ytdlp_proxy_value(), None);
        assert_eq!(
            NetworkRoute::from_proxy(Some("none")).ytdlp_proxy_value(),
            Some("")
        );
        assert_eq!(
            NetworkRoute::from_proxy(Some("http://proxy.example:8080")).ytdlp_proxy_value(),
            Some("http://proxy.example:8080")
        );
        assert_eq!(
            NetworkRoute::from_proxy(Some("none"))
                .aria2_proxy_value()
                .unwrap()
                .as_deref(),
            Some("")
        );
        assert!(
            NetworkRoute::from_proxy(Some("socks5://proxy.example:1080"))
                .aria2_proxy_value()
                .is_err()
        );
        assert!(NetworkRoute::from_proxy(Some("http://[invalid"))
            .aria2_proxy_value()
            .is_err());
        assert!(NetworkRoute::from_proxy(Some("file:///tmp/proxy"))
            .aria2_proxy_value()
            .is_err());
        assert!(
            NetworkRoute::from_proxy(Some("socks5://proxy.example:1080"))
                .configure_reqwest(reqwest::Client::builder())
                .and_then(|builder| builder.build().map_err(|error| error.to_string()))
                .is_ok(),
            "reqwest-backed metadata must retain supported SOCKS routes"
        );
    }

    #[test]
    fn raw_hosts_reject_unbalanced_ipv6_brackets() {
        assert!(validate_host("[2001:db8::1").is_err());
        assert!(validate_host("2001:db8::1]").is_err());
        assert!(validate_host("[download.example]").is_err());
    }

    #[test]
    fn credentials_can_be_rejected_by_the_consumer_policy() {
        let url = Url::parse("https://user:pass@example.com/file").unwrap();
        assert_eq!(
            validate_url(
                &url,
                &["http", "https"],
                CredentialPolicy::Reject("credentials are not allowed")
            ),
            Err("credentials are not allowed".to_string())
        );
    }
}
