//! Shell-side connection logic for the bundled connection page.
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

use tauri::Url;

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

/// The bundled connection page. On Linux Tauri serves `frontendDist` from the
/// `tauri://localhost` custom protocol; `tauri.localhost` is the Windows form
/// and is accepted so the policy stays correct if this shell is ever ported.
pub fn is_bootstrap_url(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

/// The daemon origin: loopback IPv4 on the configured port, nothing else.
pub fn is_daemon_url(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(port)
}

pub fn is_shell_url(url: &Url, port: u16) -> bool {
    is_bootstrap_url(url) || is_daemon_url(url, port)
}

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
