use serde::{Deserialize, Serialize};
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
use ts_rs::TS;

use crate::ipc::DownloadCategory;

#[tauri::command]
pub async fn get_system_proxy(caller: tauri::WebviewWindow) -> Result<Option<String>, String> {
    crate::properties_window::ensure_main_window(&caller)?;
    match bounded_native_system_proxy(&SystemProxyCommandRunner, PROXY_DISCOVERY_TIMEOUT).await {
        Ok(Some(proxy)) => Ok(Some(proxy)),
        Ok(None) => Ok(proxy_from_environment()),
        Err(native_error) => proxy_from_environment()
            .map(Some)
            .ok_or_else(|| format!("failed to read system proxy settings: {native_error}")),
    }
}

const PROXY_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(12);
const PROXY_COMMAND_OUTPUT_LIMIT: u64 = 64 * 1024;
const PROXY_NETWORK_SERVICE_LIMIT: usize = 32;

async fn bounded_native_system_proxy(
    runner: &dyn ProxyCommandRunner,
    timeout: Duration,
) -> Result<Option<String>, String> {
    tokio::time::timeout(timeout, native_system_proxy(runner))
        .await
        .map_err(|_| "system proxy discovery timed out".to_string())?
}

#[async_trait::async_trait]
trait ProxyCommandRunner: Sync {
    async fn stdout(&self, program: &str, args: &[String]) -> Result<String, String>;
}

struct SystemProxyCommandRunner;

#[async_trait::async_trait]
impl ProxyCommandRunner for SystemProxyCommandRunner {
    async fn stdout(&self, program: &str, args: &[String]) -> Result<String, String> {
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("{program} is unavailable: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("failed to capture {program} output"))?;
        let operation = async {
            let mut bytes = Vec::new();
            stdout
                .take(PROXY_COMMAND_OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|error| format!("failed to read {program} output: {error}"))?;
            if bytes.len() as u64 > PROXY_COMMAND_OUTPUT_LIMIT {
                return Err(format!("{program} output exceeded the safety limit"));
            }
            let status = child
                .wait()
                .await
                .map_err(|error| format!("failed to wait for {program}: {error}"))?;
            if !status.success() {
                return Err(format!("{program} exited unsuccessfully"));
            }
            String::from_utf8(bytes).map_err(|_| format!("{program} returned non-UTF-8 output"))
        };

        tokio::time::timeout(PROXY_COMMAND_TIMEOUT, operation)
            .await
            .map_err(|_| format!("{program} timed out"))?
    }
}

#[cfg(target_os = "windows")]
async fn native_system_proxy(runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    windows_system_proxy(runner).await
}

#[cfg(target_os = "macos")]
async fn native_system_proxy(runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    macos_system_proxy(runner).await
}

#[cfg(target_os = "linux")]
async fn native_system_proxy(runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    linux_system_proxy(runner).await
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
async fn native_system_proxy(_runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    Ok(None)
}

fn string_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|value| (*value).to_string()).collect()
}

#[cfg_attr(
    all(not(target_os = "windows"), not(target_os = "linux"), not(target_os = "macos")),
    allow(dead_code)
)]
fn is_probe_unavailable(error: &str) -> bool {
    error.contains("is unavailable") || error.contains("exited unsuccessfully")
}

fn proxy_from_environment() -> Option<String> {
    [
        ("HTTPS_PROXY", "http"),
        ("https_proxy", "http"),
        ("HTTP_PROXY", "http"),
        ("http_proxy", "http"),
        ("ALL_PROXY", "socks5"),
        ("all_proxy", "socks5"),
    ]
    .into_iter()
    .find_map(|(name, scheme)| {
        std::env::var(name)
            .ok()
            .and_then(|value| normalize_proxy_address(&value, scheme))
    })
}

fn normalize_proxy_address(raw: &str, default_scheme: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("{default_scheme}://{trimmed}")
    };
    let parsed = url::Url::parse(&candidate).ok()?;
    match parsed.scheme() {
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h" => {}
        _ => return None,
    }
    parsed.host_str()?;
    if parsed.port() == Some(0)
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(candidate.trim_end_matches('/').to_string())
}

fn proxy_from_host_port(host: &str, port: &str, scheme: &str) -> Option<String> {
    let host = host.trim();
    let host = match (host.strip_prefix('['), host.strip_suffix(']')) {
        (Some(without_open), Some(_)) => without_open.strip_suffix(']')?,
        (None, None) => host,
        _ => return None,
    };
    let port = port.trim().parse::<u16>().ok().filter(|port| *port != 0)?;
    if host.is_empty()
        || host.eq_ignore_ascii_case("(null)")
        || host.contains(['/', '@', '?', '#', '(', ')'])
        || host.chars().any(char::is_whitespace)
    {
        return None;
    }
    let formatted_host = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    normalize_proxy_address(&format!("{scheme}://{formatted_host}:{port}"), scheme)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows_proxy_server(value: &str) -> Option<String> {
    let value = value.trim().trim_matches('"');
    if value.is_empty() {
        return None;
    }

    if !value.contains('=') {
        return normalize_proxy_address(value, "http");
    }

    let mut http = None;
    let mut https = None;
    let mut socks = None;
    for entry in value.split(';') {
        let Some((kind, address)) = entry.split_once('=') else {
            continue;
        };
        let kind = kind.trim().to_ascii_lowercase();
        let address = address.trim();
        match kind.as_str() {
            "http" => http = normalize_proxy_address(address, "http"),
            "https" => https = normalize_proxy_address(address, "http"),
            "socks" => socks = normalize_proxy_address(address, "socks5"),
            _ => {}
        }
    }

    https.or(http).or(socks)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn scutil_dict_value<'a>(output: &'a str, key: &str) -> Option<&'a str> {
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case(key) {
                let val = v.trim();
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }
    }
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_macos_scutil_proxy(output: &str) -> Option<String> {
    for (enable_key, proxy_key, port_key, scheme) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ] {
        if scutil_dict_value(output, enable_key) == Some("1") {
            if let (Some(server), Some(port)) = (
                scutil_dict_value(output, proxy_key),
                scutil_dict_value(output, port_key),
            ) {
                if let Some(proxy) = proxy_from_host_port(server, port, scheme) {
                    return Some(proxy);
                }
            }
        }
    }
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
async fn macos_system_proxy(runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    if let Ok(scutil_output) = runner.stdout("scutil", &string_args(&["--proxy"])).await {
        if let Some(proxy) = parse_macos_scutil_proxy(&scutil_output) {
            return Ok(Some(proxy));
        }
    }

    let services_output = match runner
        .stdout("networksetup", &string_args(&["-listallnetworkservices"]))
        .await
    {
        Ok(output) => output,
        Err(error) => {
            if is_probe_unavailable(&error) {
                return Ok(None);
            }
            return Err(error);
        }
    };
    let services = parse_macos_network_services(&services_output)?;
    for (target, scheme) in [
        ("securewebproxy", "http"),
        ("webproxy", "http"),
        ("socksfirewallproxy", "socks5"),
    ] {
        for service in &services {
            let args = vec![format!("-get{target}"), service.clone()];
            if let Ok(output) = runner.stdout("networksetup", &args).await {
                if let Some(proxy) = parse_macos_networksetup_proxy(&output, scheme) {
                    return Ok(Some(proxy));
                }
            }
        }
    }
    Ok(None)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_macos_network_services(output: &str) -> Result<Vec<String>, String> {
    let services = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.starts_with("An asterisk"))
        .filter(|line| !line.starts_with('*'))
        .map(str::to_string)
        .collect::<Vec<_>>();
    if services.len() > PROXY_NETWORK_SERVICE_LIMIT {
        return Err("macOS returned too many network services".to_string());
    }
    Ok(services)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_macos_networksetup_proxy(output: &str, scheme: &str) -> Option<String> {
    let enabled = macos_networksetup_value(output, "Enabled:")
        .is_some_and(|value| value.eq_ignore_ascii_case("yes"));
    if !enabled {
        return None;
    }
    let server = macos_networksetup_value(output, "Server:")?;
    let port = macos_networksetup_value(output, "Port:")?;
    proxy_from_host_port(server, port, scheme)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_networksetup_value<'a>(output: &'a str, key: &str) -> Option<&'a str> {
    output
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(key).map(str::trim))
        .filter(|value| !value.is_empty())
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
async fn linux_system_proxy(runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    let mode = match runner
        .stdout(
            "gsettings",
            &string_args(&["get", "org.gnome.system.proxy", "mode"]),
        )
        .await
    {
        Ok(mode) => mode,
        Err(error) => {
            if is_probe_unavailable(&error) {
                return Ok(None);
            }
            return Err(error);
        }
    };
    if strip_gsettings_string(&mode) != "manual" {
        return Ok(None);
    }

    for (service, scheme) in [("https", "http"), ("http", "http"), ("socks", "socks5")] {
        if let Some(proxy) = linux_gsettings_proxy(runner, service, scheme).await {
            return Ok(Some(proxy));
        }
    }
    Ok(None)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
async fn linux_gsettings_proxy(
    runner: &dyn ProxyCommandRunner,
    service: &str,
    scheme: &str,
) -> Option<String> {
    let schema = format!("org.gnome.system.proxy.{service}");
    let host = runner
        .stdout("gsettings", &string_args(&["get", &schema, "host"]))
        .await
        .ok()?;
    let host = strip_gsettings_string(&host);
    if host.is_empty() {
        return None;
    }
    let port = runner
        .stdout("gsettings", &string_args(&["get", &schema, "port"]))
        .await
        .ok()?;
    let port = port.trim();
    proxy_from_host_port(&host, port, scheme)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn strip_gsettings_string(value: &str) -> String {
    value
        .trim()
        .trim_matches('\'')
        .trim_matches('"')
        .to_string()
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
async fn windows_system_proxy(runner: &dyn ProxyCommandRunner) -> Result<Option<String>, String> {
    let output = match runner
        .stdout(
            "reg",
            &string_args(&[
                "query",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                "/v",
                "ProxyEnable",
            ]),
        )
        .await
    {
        Ok(output) => output,
        Err(error) => {
            if is_probe_unavailable(&error) {
                return Ok(None);
            }
            return Err(error);
        }
    };
    let enabled = registry_value(&output, "ProxyEnable")
        .as_deref()
        .is_some_and(windows_proxy_enabled);
    if !enabled {
        return Ok(None);
    }

    let output = match runner
        .stdout(
            "reg",
            &string_args(&[
                "query",
                "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
                "/v",
                "ProxyServer",
            ]),
        )
        .await
    {
        Ok(output) => output,
        Err(error) => {
            if is_probe_unavailable(&error) {
                return Ok(None);
            }
            return Err(error);
        }
    };
    Ok(registry_value(&output, "ProxyServer").and_then(|value| parse_windows_proxy_server(&value)))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_proxy_enabled(value: &str) -> bool {
    let value = value.trim();
    if value == "1" {
        return true;
    }
    value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .and_then(|hex| u32::from_str_radix(hex, 16).ok())
        .is_some_and(|enabled| enabled == 1)
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn registry_value(output: &str, name: &str) -> Option<String> {
    for line in output.lines() {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        let Some(key) = parts.next() else {
            continue;
        };
        if !key.eq_ignore_ascii_case(name) {
            continue;
        }
        if parts.next().is_none() {
            continue;
        }
        let data = parts.collect::<Vec<_>>().join(" ");
        if !data.is_empty() {
            return Some(data);
        }
    }
    None
}

#[cfg(test)]
mod proxy_tests {
    use super::{
        bounded_native_system_proxy, normalize_proxy_address, parse_macos_network_services,
        parse_macos_networksetup_proxy, parse_macos_scutil_proxy, parse_windows_proxy_server,
        proxy_from_host_port, registry_value, strip_gsettings_string, windows_proxy_enabled,
        ProxyCommandRunner, SystemProxyCommandRunner,
    };
    use std::time::Duration;

    #[cfg(target_os = "macos")]
    struct MockProxyCommandRunner;

    #[cfg(target_os = "macos")]
    struct SlowProxyCommandRunner;

    #[cfg(target_os = "macos")]
    struct ScutilProxyCommandRunner;

    #[cfg(target_os = "macos")]
    #[async_trait::async_trait]
    impl ProxyCommandRunner for MockProxyCommandRunner {
        async fn stdout(&self, program: &str, args: &[String]) -> Result<String, String> {
            match program {
                "scutil" => {
                    assert_eq!(args, &["--proxy"]);
                    Ok("<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}\n".to_string())
                }
                "networksetup" => match args
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice()
                {
                    ["-listallnetworkservices"] => Ok("Wi-Fi\nEthernet\n".to_string()),
                    ["-getsecurewebproxy", "Wi-Fi"] => {
                        Ok("Enabled: No\nServer: ignored.example\nPort: 443\n".to_string())
                    }
                    ["-getsecurewebproxy", "Ethernet"] => {
                        Ok("Enabled: Yes\nServer: secure.example\nPort: 8443\n".to_string())
                    }
                    ["-getwebproxy", _] | ["-getsocksfirewallproxy", _] => {
                        panic!("lower-priority proxy was queried after HTTPS succeeded")
                    }
                    _ => Err("unexpected command".to_string()),
                },
                _ => Err("unexpected command".to_string()),
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[async_trait::async_trait]
    impl ProxyCommandRunner for ScutilProxyCommandRunner {
        async fn stdout(&self, program: &str, args: &[String]) -> Result<String, String> {
            assert_eq!(program, "scutil");
            assert_eq!(args, &["--proxy"]);
            Ok(r#"<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : scutil.example
}
"#
            .to_string())
        }
    }

    #[cfg(target_os = "macos")]
    #[async_trait::async_trait]
    impl ProxyCommandRunner for SlowProxyCommandRunner {
        async fn stdout(&self, _program: &str, _args: &[String]) -> Result<String, String> {
            tokio::time::sleep(Duration::from_secs(1)).await;
            Ok(String::new())
        }
    }

    #[test]
    fn normalizes_bare_proxy_addresses() {
        assert_eq!(
            normalize_proxy_address("127.0.0.1:8080", "http").as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(
            normalize_proxy_address(" socks5://127.0.0.1:1080/ ", "http").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(normalize_proxy_address("file:///tmp/proxy", "http"), None);
        assert_eq!(
            normalize_proxy_address("http://proxy.test/secret", "http"),
            None
        );
        assert_eq!(
            normalize_proxy_address("http://proxy.test?token=secret", "http"),
            None
        );
        assert_eq!(normalize_proxy_address("http://proxy.test:0", "http"), None);
    }

    #[test]
    fn formats_native_proxy_hosts_without_accepting_structural_injection() {
        assert_eq!(
            proxy_from_host_port("2001:db8::1", "8080", "http").as_deref(),
            Some("http://[2001:db8::1]:8080")
        );
        assert_eq!(
            proxy_from_host_port("proxy.test/path", "8080", "http"),
            None
        );
        assert_eq!(
            proxy_from_host_port("user@proxy.test", "8080", "http"),
            None
        );
        assert_eq!(proxy_from_host_port("[2001:db8::1", "8080", "http"), None);
        assert_eq!(proxy_from_host_port("proxy.test", "0", "http"), None);
    }

    #[test]
    fn parses_windows_protocol_proxy_server_values() {
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:8080;https=127.0.0.1:8081").as_deref(),
            Some("http://127.0.0.1:8081")
        );
        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:1080").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        assert_eq!(
            parse_windows_proxy_server("proxy.local:9000").as_deref(),
            Some("http://proxy.local:9000")
        );
    }

    #[test]
    fn parses_macos_proxy_outputs_with_scheme() {
        let services = r#"
An asterisk (*) denotes that a network service is disabled.
Wi-Fi
*USB 10/100/1000 LAN
Thunderbolt Bridge
"#;
        assert_eq!(
            parse_macos_network_services(services).unwrap(),
            vec!["Wi-Fi".to_string(), "Thunderbolt Bridge".to_string()]
        );

        let proxy = r#"
Enabled: Yes
Server: 127.0.0.1
Port: 1080
Authenticated Proxy Enabled: 0
"#;
        assert_eq!(
            parse_macos_networksetup_proxy(proxy, "socks5").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
        let disabled = proxy.replace("Enabled: Yes", "Enabled: No");
        assert_eq!(parse_macos_networksetup_proxy(&disabled, "socks5"), None);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn bounds_native_command_runtime_and_output() {
        let runner = SystemProxyCommandRunner;
        let oversized = format!("print('x' * {})", super::PROXY_COMMAND_OUTPUT_LIMIT + 1);
        let error = runner
            .stdout("python3", &["-c".to_string(), oversized])
            .await
            .expect_err("oversized output must fail closed");
        assert!(error.contains("safety limit"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn selects_https_across_services_before_lower_priority_proxies() {
        assert_eq!(
            super::macos_system_proxy(&MockProxyCommandRunner)
                .await
                .unwrap()
                .as_deref(),
            Some("http://secure.example:8443")
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn bounds_the_complete_native_proxy_discovery_lifecycle() {
        let error = bounded_native_system_proxy(&SlowProxyCommandRunner, Duration::from_millis(10))
            .await
            .expect_err("the complete native probe must have one bounded deadline");
        assert_eq!(error, "system proxy discovery timed out");
    }

    #[test]
    fn rejects_oversized_macos_network_service_enumeration() {
        let output = (0..100)
            .map(|index| format!("Service {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            parse_macos_network_services(&output).unwrap_err(),
            "macOS returned too many network services"
        );
    }

    #[test]
    fn strips_gsettings_string_quotes() {
        assert_eq!(strip_gsettings_string("'manual'\n"), "manual");
        assert_eq!(strip_gsettings_string("\"127.0.0.1\"\n"), "127.0.0.1");
    }

    #[test]
    fn parses_reg_query_output_values() {
        let output = r#"
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=127.0.0.1:8080;https=127.0.0.1:8081
"#;

        assert!(registry_value(output, "ProxyEnable")
            .as_deref()
            .is_some_and(windows_proxy_enabled));
        assert_eq!(
            registry_value(output, "ProxyServer").as_deref(),
            Some("http=127.0.0.1:8080;https=127.0.0.1:8081")
        );
        assert!(!windows_proxy_enabled("0X0"));
        assert!(windows_proxy_enabled("0X1"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn selects_active_scutil_proxy_before_networksetup() {
        assert_eq!(
            super::macos_system_proxy(&ScutilProxyCommandRunner)
                .await
                .unwrap()
                .as_deref(),
            Some("http://scutil.example:8443")
        );
    }

    #[test]
    fn parses_macos_scutil_proxy_outputs() {
        let scutil_https = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : secure.local
}
"#;
        assert_eq!(
            parse_macos_scutil_proxy(scutil_https).as_deref(),
            Some("http://secure.local:8443")
        );

        let scutil_socks = r#"<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
"#;
        assert_eq!(
            parse_macos_scutil_proxy(scutil_socks).as_deref(),
            Some("socks5://127.0.0.1:1080")
        );

        let scutil_ipv6 = r#"<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : 2001:db8::1
}
"#;
        assert_eq!(
            parse_macos_scutil_proxy(scutil_ipv6).as_deref(),
            Some("http://[2001:db8::1]:8080")
        );

        let scutil_disabled = r#"<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
}
"#;
        assert_eq!(parse_macos_scutil_proxy(scutil_disabled), None);
    }

    struct MockWindowsMissingRegRunner;

    #[async_trait::async_trait]
    impl ProxyCommandRunner for MockWindowsMissingRegRunner {
        async fn stdout(&self, _program: &str, _args: &[String]) -> Result<String, String> {
            Err("reg exited unsuccessfully".to_string())
        }
    }

    struct MockWindowsEnabledRegRunner;

    #[async_trait::async_trait]
    impl ProxyCommandRunner for MockWindowsEnabledRegRunner {
        async fn stdout(&self, program: &str, args: &[String]) -> Result<String, String> {
            assert_eq!(program, "reg");
            if args.iter().any(|a| a == "ProxyEnable") {
                Ok("    ProxyEnable    REG_DWORD    0x1\n".to_string())
            } else if args.iter().any(|a| a == "ProxyServer") {
                Ok("    ProxyServer    REG_SZ       127.0.0.1:8080\n".to_string())
            } else {
                Err("reg exited unsuccessfully".to_string())
            }
        }
    }

    #[tokio::test]
    async fn windows_system_proxy_returns_none_when_value_is_missing() {
        assert_eq!(
            super::windows_system_proxy(&MockWindowsMissingRegRunner)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn windows_system_proxy_returns_configured_proxy() {
        assert_eq!(
            super::windows_system_proxy(&MockWindowsEnabledRegRunner)
                .await
                .unwrap()
                .as_deref(),
            Some("http://127.0.0.1:8080")
        );
    }

    struct MockLinuxUnavailableGsettingsRunner;

    #[async_trait::async_trait]
    impl ProxyCommandRunner for MockLinuxUnavailableGsettingsRunner {
        async fn stdout(&self, _program: &str, _args: &[String]) -> Result<String, String> {
            Err("gsettings is unavailable: not found".to_string())
        }
    }

    #[tokio::test]
    async fn linux_system_proxy_returns_none_when_gsettings_is_unavailable() {
        assert_eq!(
            super::linux_system_proxy(&MockLinuxUnavailableGsettingsRunner)
                .await
                .unwrap(),
            None
        );
    }
}

#[tauri::command]
pub fn get_file_category(filename: String) -> DownloadCategory {
    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    let music_exts = [
        "mp3", "wav", "aac", "flac", "ogg", "m4a", "wma", "alac", "ape", "mid", "midi",
    ];
    let movie_exts = [
        "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpeg", "mpg", "3gp", "ts", "vob",
    ];
    let compressed_exts = [
        "zip", "rar", "7z", "tar", "gz", "xz", "bz2", "lz", "lzma", "zst", "iso", "cab", "tgz",
        "tbz", "z", "sit", "sitx",
    ];
    let picture_exts = [
        "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "svg", "ico", "heic", "raw", "psd",
        "ai",
    ];
    let document_exts = [
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "md", "epub",
        "mobi", "azw3",
    ];
    let app_exts = [
        "exe", "msi", "bat", "cmd", "app", "dmg", "pkg", "apk", "appx", "deb", "rpm", "appimage",
        "run", "sh", "bin", "jar",
    ];

    if ext == "torrent" {
        DownloadCategory::Torrents
    } else if music_exts.contains(&ext.as_str()) {
        DownloadCategory::Musics
    } else if movie_exts.contains(&ext.as_str()) {
        DownloadCategory::Movies
    } else if compressed_exts.contains(&ext.as_str()) {
        DownloadCategory::Compressed
    } else if picture_exts.contains(&ext.as_str()) {
        DownloadCategory::Pictures
    } else if document_exts.contains(&ext.as_str()) {
        DownloadCategory::Documents
    } else if app_exts.contains(&ext.as_str()) {
        DownloadCategory::Applications
    } else {
        DownloadCategory::Other
    }
}

#[derive(Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AvailableReleaseUpdate {
    pub version: String,
    pub tag_name: String,
    pub title: String,
    pub release_notes: String,
    pub release_url: String,
    pub published_at: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(tag = "type")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ReleaseCheckOutcome {
    UpdateAvailable {
        update: AvailableReleaseUpdate,
    },
    UpToDate {
        latest_version: String,
        local_version: String,
    },
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    html_url: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
}

#[tauri::command]
pub async fn check_for_updates(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
) -> Result<ReleaseCheckOutcome, String> {
    crate::properties_window::ensure_main_window(&caller)?;
    let current_version = app_handle.package_info().version.to_string();

    crate::ensure_reqwest_crypto_provider();
    let client = reqwest::Client::new();
    let res = client
        .get("https://api.github.com/repos/nimbold/Firelink/releases?per_page=30")
        .header("User-Agent", "Firelink")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", res.status().as_u16()));
    }

    let releases: Vec<GitHubRelease> = res.json().await.map_err(|e| e.to_string())?;

    let latest_stable = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .max_by(|a, b| cmp_versions(&a.tag_name, &b.tag_name));

    let release = match latest_stable {
        Some(r) => r,
        None => return Err("No stable release was found.".to_string()),
    };

    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();

    if cmp_versions(&latest_version, &current_version) == std::cmp::Ordering::Greater {
        Ok(ReleaseCheckOutcome::UpdateAvailable {
            update: AvailableReleaseUpdate {
                version: latest_version.clone(),
                tag_name: release.tag_name.clone(),
                title: release.name.unwrap_or(release.tag_name),
                release_notes: release.body.unwrap_or_else(|| {
                    "No release notes were provided for this version.".to_string()
                }),
                release_url: release.html_url,
                published_at: release.published_at,
            },
        })
    } else {
        Ok(ReleaseCheckOutcome::UpToDate {
            latest_version,
            local_version: current_version,
        })
    }
}

fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use semver::Version;

    let a_clean = a.trim_start_matches(['v', 'V']);
    let b_clean = b.trim_start_matches(['v', 'V']);

    let a_ver = Version::parse(a_clean).unwrap_or_else(|_| Version::new(0, 0, 0));
    let b_ver = Version::parse(b_clean).unwrap_or_else(|_| Version::new(0, 0, 0));

    a_ver.cmp(&b_ver)
}

#[tauri::command]
pub async fn create_category_directories(
    caller: tauri::WebviewWindow,
    app_handle: tauri::AppHandle,
    base_folder: String,
    subfolders: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    crate::properties_window::ensure_main_window(&caller)?;
    let base = crate::resolve_path(&base_folder, &app_handle);
    let mut errors = Vec::new();

    for subfolder in subfolders.values() {
        let normalized = subfolder.replace('\\', "/");
        let relative = std::path::Path::new(&normalized);
        if relative.is_absolute()
            || normalized
                .split('/')
                .any(|part| part == ".." || part.ends_with(':'))
        {
            return Err(format!(
                "Category subfolder must be a relative path: {subfolder}"
            ));
        }

        let expanded = base.join(relative);
        if !expanded.exists() {
            if let Err(e) = tokio::fs::create_dir_all(&expanded).await {
                errors.push(format!("{}: {}", expanded.display(), e));
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to create one or more category directories ({})",
            errors.join("; ")
        ))
    }
}

pub static SUPPORTED_DOMAINS: &[&str] = &[
    "youtube.com",
    "youtu.be",
    "twitter.com",
    "x.com",
    "vimeo.com",
    "twitch.tv",
    "instagram.com",
    "tiktok.com",
    "facebook.com",
    "fb.watch",
    "reddit.com",
    "v.redd.it",
    "soundcloud.com",
    "pornhub.com",
    "redtube.com",
    "xhamster.com",
    "xnxx.com",
    "xvideos.com",
];

#[tauri::command]
pub fn get_supported_media_domains() -> Vec<String> {
    SUPPORTED_DOMAINS.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
pub fn is_supported_media(url: String) -> bool {
    if let Ok(parsed_url) = reqwest::Url::parse(&url) {
        if !matches!(parsed_url.scheme(), "http" | "https") {
            return false;
        }
        if let Some(host) = parsed_url.host_str() {
            let host_lower = host.to_lowercase();
            for domain in SUPPORTED_DOMAINS.iter() {
                if host_lower == *domain || host_lower.ends_with(&format!(".{}", domain)) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{get_file_category, is_supported_media};
    use crate::ipc::DownloadCategory;

    #[test]
    fn classifies_torrent_files_as_torrents() {
        assert!(matches!(
            get_file_category("Example.TORRENT".to_string()),
            DownloadCategory::Torrents
        ));
        assert!(matches!(
            get_file_category("Example.mkv".to_string()),
            DownloadCategory::Movies
        ));
    }

    #[test]
    fn only_http_urls_are_supported_media_routes() {
        assert!(is_supported_media(
            "https://youtube.com/watch?v=video".to_string()
        ));
        assert!(!is_supported_media("ftp://youtube.com/video".to_string()));
        assert!(!is_supported_media("sftp://youtube.com/video".to_string()));
    }
}
