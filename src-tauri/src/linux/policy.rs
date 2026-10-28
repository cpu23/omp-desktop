use url::Url;

pub const BOOTSTRAP_URI: &str = "omp://bootstrap/index.html";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationDecision {
    Allow,
    OpenExternal(Url),
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    Clipboard,
    Notification,
    Other,
}

pub fn classify_navigation(uri: &str, port: u16) -> NavigationDecision {
    let Ok(url) = Url::parse(uri) else {
        return NavigationDecision::Deny;
    };
    if has_user_info(&url) {
        return NavigationDecision::Deny;
    }

    if is_bootstrap_document(uri, &url) || is_daemon_document(&url, port) {
        return NavigationDecision::Allow;
    }
    if matches!(url.scheme(), "http" | "https") && url.host().is_some() {
        return NavigationDecision::OpenExternal(url);
    }
    NavigationDecision::Deny
}

pub fn is_daemon_origin(uri: &str, port: u16) -> bool {
    Url::parse(uri).is_ok_and(|url| is_daemon_document(&url, port))
}

pub fn permission_allowed(uri: &str, port: u16, kind: PermissionKind) -> bool {
    is_daemon_origin(uri, port) && matches!(kind, PermissionKind::Clipboard | PermissionKind::Notification)
}

fn is_bootstrap_document(uri: &str, url: &Url) -> bool {
    uri == BOOTSTRAP_URI
        && url.scheme() == "omp"
        && url.host_str() == Some("bootstrap")
        && url.path() == "/index.html"
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && !has_user_info(url)
}

fn is_daemon_document(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
        && !has_user_info(url)
}

fn has_user_info(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 4317;

    #[test]
    fn navigation_policy_allows_only_bootstrap_and_configured_loopback() {
        for uri in [
            BOOTSTRAP_URI,
            "http://127.0.0.1:4317/",
            "http://127.0.0.1:4317/?view=workspace",
            "http://127.0.0.1:4317/a/b#section",
        ] {
            assert_eq!(classify_navigation(uri, PORT), NavigationDecision::Allow, "{uri}");
        }
    }

    #[test]
    fn external_http_links_are_classified_without_granting_shell_access() {
        for uri in [
            "http://example.test/path",
            "https://example.test/path",
            "http://127.0.0.1:4318/",
            "https://127.0.0.1:4317/",
            "http://localhost:4317/",
        ] {
            assert!(matches!(classify_navigation(uri, PORT), NavigationDecision::OpenExternal(_)), "{uri}");
        }
    }

    #[test]
    fn non_shell_schemes_ports_hosts_credentials_and_malformed_urls_are_denied() {
        for uri in [
            "file:///tmp/secret",
            "data:text/html,hello",
            "javascript:alert(1)",
            "about:blank",
            
            "http://user@127.0.0.1:4317/",
            "http://127.0.0.1:4317@evil.test/",
            "omp://bootstrap/../bootstrap/index.html",
            "omp://bootstrap/index.html?x=1",
            "omp://bootstrap:81/index.html",
            "omp://bootstrap.evil/index.html",
            "not a url",
        ] {
            assert_eq!(classify_navigation(uri, PORT), NavigationDecision::Deny, "{uri}");
        }
    }

    #[test]
    fn privileged_permissions_require_the_configured_daemon_origin() {
        assert!(permission_allowed("http://127.0.0.1:4317/", PORT, PermissionKind::Clipboard));
        assert!(permission_allowed("http://127.0.0.1:4317/", PORT, PermissionKind::Notification));
        for (uri, kind) in [
            (BOOTSTRAP_URI, PermissionKind::Clipboard),
            ("http://127.0.0.1:4318/", PermissionKind::Notification),
            ("https://127.0.0.1:4317/", PermissionKind::Clipboard),
            ("http://user@127.0.0.1:4317/", PermissionKind::Clipboard),
            ("http://127.0.0.1:4317/", PermissionKind::Other),
            ("file:///tmp/x", PermissionKind::Notification),
        ] {
            assert!(!permission_allowed(uri, PORT, kind), "{uri} {kind:?}");
        }
    }
}
