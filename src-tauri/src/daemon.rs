//! Shell-side daemon connection logic.
//!
//! The shell never proxies the daemon. Once the daemon answers, the main window
//! navigates to its origin and the existing web client talks to it directly
//! (same-origin HTTP and WebSocket). This module only decides *whether* the
//! daemon is up, starts the existing systemd user unit when nothing is
//! listening, and verifies the daemon identity through `GET /api/build`.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use url::Url;

/// Must match the daemon default (`OMP_DESKTOP_PORT` in `src/daemon.ts`).
pub const DEFAULT_PORT: u16 = 4180;

/// The existing systemd user unit that runs the daemon. It is only ever
/// started, never restarted or stopped: a running daemon keeps its sessions.
const SYSTEMD_UNIT: &str = "omp-desktopd";

const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(800);
const PROBE_READ_TIMEOUT: Duration = Duration::from_millis(2_000);
const SYSTEMCTL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to keep polling `/api/build` after starting the unit.
const START_WAIT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// `/api/build` is a tiny JSON document; anything larger is not the daemon.
const RESPONSE_LIMIT: usize = 16 * 1024;

pub fn daemon_port() -> u16 {
    std::env::var("OMP_DESKTOP_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or(DEFAULT_PORT)
}

pub fn daemon_url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).expect("loopback URL is always valid")
}

/// The bundled connection page used by the retained Tauri shells.
#[cfg(not(target_os = "linux"))]
pub fn is_bootstrap_url(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}
#[cfg(not(target_os = "linux"))]
pub fn is_daemon_url(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
}
#[cfg(not(target_os = "linux"))]
pub fn is_shell_url(url: &Url, port: u16) -> bool {
    is_bootstrap_url(url) || is_daemon_url(url, port)
}
#[cfg(not(target_os = "linux"))]
pub fn is_web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// Opens an external link in the system default browser (xdg-open on Linux).
/// Called from the navigation policy in Rust; the page never gets a shell API.
pub fn open_in_browser(url: &Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("omp-desktop: could not open {url} in the system browser: {error}");
    }
}

/// Blocking connect used from an async command on a worker thread:
///
/// 1. probe `GET /api/build` (fast path: the daemon is already running),
/// 2. if nothing is listening, `systemctl --user start omp-desktopd`,
/// 3. poll `/api/build` for a bounded time and report a readable failure.
pub fn connect_blocking(port: u16) -> Result<String, String> {
    match probe_build(port) {
        Ok(build) => return Ok(build),
        Err(ProbeError::NotDaemon(detail)) => {
            return Err(format!(
                "something is listening on 127.0.0.1:{port} but it does not answer GET /api/build like the \
                 omp-desktop daemon ({detail}); {SYSTEMD_UNIT} was not started because the port is taken"
            ));
        }
        Err(ProbeError::Unreachable(detail)) if port != DEFAULT_PORT => {
            return Err(format!(
                "no daemon at http://127.0.0.1:{port}: {detail}. Start the daemon with OMP_DESKTOP_PORT={port}; \
                 custom ports do not start {SYSTEMD_UNIT}"
            ));
        }
        Err(ProbeError::Unreachable(_)) => {}
    }

    let start_detail = match start_systemd_unit() {
        Ok(()) => format!("{SYSTEMD_UNIT} was started"),
        Err(detail) => detail,
    };

    let deadline = Instant::now() + START_WAIT;
    let mut last;
    loop {
        match probe_build(port) {
            Ok(build) => return Ok(build),
            Err(ProbeError::Unreachable(detail)) | Err(ProbeError::NotDaemon(detail)) => last = detail,
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(POLL_INTERVAL);
    }

    Err(format!(
        "the omp-desktop daemon did not answer http://127.0.0.1:{port}/api/build within {}s ({start_detail}; last error: {last})",
        START_WAIT.as_secs()
    ))
}

#[derive(Debug)]
enum ProbeError {
    /// Nothing is listening (or the connection failed before a response).
    Unreachable(String),
    /// A server answered, but not with the daemon's `/api/build` shape.
    NotDaemon(String),
}

fn probe_build(port: u16) -> Result<String, ProbeError> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), PROBE_CONNECT_TIMEOUT)
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;
    let _ = stream.set_read_timeout(Some(PROBE_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_READ_TIMEOUT));

    let request = format!(
        "GET /api/build HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| ProbeError::Unreachable(error.to_string()))?;

    let mut response = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                response.extend_from_slice(&chunk[..read]);
                if response.len() > RESPONSE_LIMIT {
                    return Err(ProbeError::NotDaemon("response larger than any /api/build reply".to_owned()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            // A read timeout or reset after the first bytes just means the peer
            // closed late: judge the bytes we did get instead of calling it
            // unreachable.
            Err(_) if !response.is_empty() => break,
            Err(error) => return Err(ProbeError::Unreachable(error.to_string())),
        }
    }

    parse_build_response(&response)
}

/// The daemon answers `/api/build` with a small `Content-Length` JSON body
/// (`{"build":"<id>"}`, verified against the live daemon), so the bytes after
/// the header block are the document.
fn parse_build_response(raw: &[u8]) -> Result<String, ProbeError> {
    let text = std::str::from_utf8(raw).map_err(|_| ProbeError::NotDaemon("response is not valid UTF-8".to_owned()))?;
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| ProbeError::NotDaemon("incomplete HTTP response".to_owned()))?;

    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default();
    if status != "200" {
        return Err(ProbeError::NotDaemon(format!(
            "HTTP status {}",
            if status.is_empty() { "missing" } else { status }
        )));
    }

    let value: serde_json::Value =
        serde_json::from_str(body.trim()).map_err(|error| ProbeError::NotDaemon(format!("/api/build is not JSON: {error}")))?;
    let build = value
        .get("build")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| ProbeError::NotDaemon("/api/build has no string `build` field".to_owned()))?;
    if !is_build_id(build) {
        return Err(ProbeError::NotDaemon(format!("`build` is not a build identity: {build:?}")));
    }

    Ok(build.to_owned())
}

/// The daemon publishes a short ASCII identity (currently a 7-char hash).
fn is_build_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn start_systemd_unit() -> Result<(), String> {
    let output = run_bounded("systemctl", &["--user", "start", SYSTEMD_UNIT], SYSTEMCTL_TIMEOUT)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    Err(if stderr.is_empty() {
        format!("systemctl --user start {SYSTEMD_UNIT} exited with {}", output.status)
    } else {
        format!("systemctl --user start {SYSTEMD_UNIT} failed: {stderr}")
    })
}

fn run_bounded(program: &str, args: &[&str], timeout: Duration) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not run {program}: {error}"))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("could not read {program} output: {error}"));
            }
            Ok(None) => {}
            Err(error) => return Err(format!("could not wait for {program}: {error}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program} did not finish within {}s", timeout.as_secs()));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    fn response_server(response: Vec<u8>) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test HTTP server");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe");
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(&response);
        });
        port
    }

    fn http_response(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn loopback_probe_accepts_the_daemon_build_response() {
        let port = response_server(http_response("200 OK", r#"{"build":"abc1234"}"#));
        assert_eq!(probe_build(port).unwrap(), "abc1234");
    }

    #[test]
    fn loopback_probe_rejects_malformed_non_daemon_and_oversized_responses() {
        for response in [
            http_response("200 OK", "{not-json"),
            http_response("503 Service Unavailable", r#"{"build":"abc1234"}"#),
            http_response("200 OK", &format!(r#"{{"build":"{}"}}"#, "a".repeat(16_500))),
        ] {
            let port = response_server(response);
            assert!(matches!(probe_build(port), Err(ProbeError::NotDaemon(_))));
        }
    }

    #[test]
    fn loopback_probe_bounds_a_peer_that_never_sends_a_response() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind test HTTP server");
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept probe");
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            thread::sleep(PROBE_READ_TIMEOUT + Duration::from_millis(250));
        });

        assert!(matches!(probe_build(port), Err(ProbeError::Unreachable(_))));
        server.join().expect("timeout server exits");
    }

    #[test]
    fn occupied_non_daemon_endpoint_is_not_replaced_by_the_service() {
        let port = response_server(http_response("404 Not Found", "not a daemon"));
        let error = connect_blocking(port).unwrap_err();
        assert!(error.contains("was not started because the port is taken"));
    }

    #[cfg(unix)]
    mod service_start_tests {
        use super::*;
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;
        use std::sync::Mutex;

        static ENV_LOCK: Mutex<()> = Mutex::new(());
        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);

        struct FixtureDirectory(PathBuf);

        impl FixtureDirectory {
            fn new() -> Self {
                let serial = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "omp-desktop-daemon-test-{}-{serial}",
                    std::process::id()
                ));
                fs::create_dir_all(&path).expect("create fixture directory");
                Self(path)
            }
        }

        impl Drop for FixtureDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        struct EnvironmentGuard {
            name: &'static str,
            previous: Option<OsString>,
        }

        impl EnvironmentGuard {
            fn set(name: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
                let previous = std::env::var_os(name);
                std::env::set_var(name, value);
                Self { name, previous }
            }
        }

        impl Drop for EnvironmentGuard {
            fn drop(&mut self) {
                if let Some(value) = self.previous.take() {
                    std::env::set_var(self.name, value);
                } else {
                    std::env::remove_var(self.name);
                }
            }
        }

        fn install_systemctl(directory: &Path) {
            let bin = directory.join("bin");
            fs::create_dir_all(&bin).expect("create fixture bin directory");
            let executable = bin.join("systemctl");
            fs::write(
                &executable,
                "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$OMP_FIXTURE_SYSTEMCTL_LOG\"\nexit 0\n",
            )
            .expect("write fixture systemctl");
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
                .expect("make fixture systemctl executable");
        }

        #[test]
        fn service_start_invokes_the_systemctl_user_unit_command() {
            let _lock = ENV_LOCK.lock().expect("environment test lock");
            let directory = FixtureDirectory::new();
            let log = directory.0.join("systemctl.log");
            install_systemctl(&directory.0);
            let path = directory.0.join("bin");
            let _path = EnvironmentGuard::set("PATH", path.as_os_str());
            let _log = EnvironmentGuard::set("OMP_FIXTURE_SYSTEMCTL_LOG", log.as_os_str());

            start_systemd_unit().expect("fixture service start succeeds");
            assert_eq!(
                fs::read_to_string(&log).expect("fixture wrote its invocation"),
                "--user start omp-desktopd\n"
            );
        }

        #[test]
        fn unreachable_custom_port_never_invokes_the_service_starter() {
            let _lock = ENV_LOCK.lock().expect("environment test lock");
            let directory = FixtureDirectory::new();
            let log = directory.0.join("systemctl.log");
            install_systemctl(&directory.0);
            let path = directory.0.join("bin");
            let _path = EnvironmentGuard::set("PATH", path.as_os_str());
            let _log = EnvironmentGuard::set("OMP_FIXTURE_SYSTEMCTL_LOG", log.as_os_str());

            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("reserve custom port");
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let error = connect_blocking(port).unwrap_err();
            assert!(error.contains("custom ports do not start omp-desktopd"));
            assert!(!log.exists(), "systemctl must not be run for an unreachable custom port");
        }
    }
}
