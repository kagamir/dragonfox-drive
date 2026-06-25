pub fn parse_user_agent(ua: Option<&str>) -> String {
    let ua = match ua {
        Some(s) if !s.is_empty() => s,
        _ => return "Unknown browser · Unknown OS".into(),
    };
    let browser = parse_browser(ua);
    let os = parse_os(ua);
    format!("{browser} · {os}")
}

fn parse_browser(ua: &str) -> String {
    if let Some(v) = version_after(ua, "Firefox/") {
        return format!("Firefox {v}");
    }
    if ua.contains("Edg/") {
        let v = version_after(ua, "Edg/").unwrap_or_default();
        return format!("Edge {v}");
    }
    if ua.contains("OPR/") || ua.contains("Opera/") {
        let v = version_after(ua, "OPR/").or_else(|| version_after(ua, "Opera/")).unwrap_or_default();
        return format!("Opera {v}");
    }
    if let Some(v) = version_after(ua, "Chrome/") {
        return format!("Chrome {v}");
    }
    if ua.contains("Safari/") && !ua.contains("Chrome/") {
        return "Safari".into();
    }
    "Unknown browser".into()
}

fn parse_os(ua: &str) -> String {
    if ua.contains("Windows NT") {
        return "Windows".into();
    }
    if ua.contains("iPhone") || ua.contains("iPad") {
        return "iOS".into();
    }
    if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        return "macOS".into();
    }
    if ua.contains("Android") {
        return "Android".into();
    }
    if ua.contains("Linux") || ua.contains("X11") {
        return "Linux".into();
    }
    "Unknown OS".into()
}

fn version_after(ua: &str, marker: &str) -> Option<String> {
    let idx = ua.find(marker)?;
    let rest = &ua[idx + marker.len()..];
    let major: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if major.is_empty() { None } else { Some(major) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_none_input() {
        assert_eq!(parse_user_agent(None), "Unknown browser · Unknown OS");
    }

    #[test]
    fn handles_empty_string() {
        assert_eq!(parse_user_agent(Some("")), "Unknown browser · Unknown OS");
    }

    #[test]
    fn handles_curl_or_unknown_agent() {
        assert_eq!(parse_user_agent(Some("curl/8.0")), "Unknown browser · Unknown OS");
    }

    #[test]
    fn parses_chrome_on_macos() {
        let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
                  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
        assert_eq!(parse_user_agent(Some(ua)), "Chrome 120 · macOS");
    }

    #[test]
    fn parses_firefox_on_windows() {
        let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) \
                  Gecko/20100101 Firefox/121.0";
        assert_eq!(parse_user_agent(Some(ua)), "Firefox 121 · Windows");
    }

    #[test]
    fn parses_safari_on_iphone() {
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) \
                  AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
        assert_eq!(parse_user_agent(Some(ua)), "Safari · iOS");
    }

    #[test]
    fn parses_android_with_chrome() {
        let ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) \
                  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
        assert_eq!(parse_user_agent(Some(ua)), "Chrome 120 · Android");
    }

    #[test]
    fn parses_linux_without_browser_info() {
        let ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
        assert_eq!(parse_user_agent(Some(ua)), "Chrome 120 · Linux");
    }
}
