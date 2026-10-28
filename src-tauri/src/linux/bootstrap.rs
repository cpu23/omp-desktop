use gtk4::{gio, glib};
use webkit6::{URISchemeRequest, URISchemeResponse, WebContext};

const INDEX: &[u8] = include_bytes!("../../bootstrap/index.html");
const CSS: &[u8] = include_bytes!("../../bootstrap/bootstrap.css");
const JS: &[u8] = include_bytes!("../../bootstrap/bootstrap.js");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Asset {
    Index,
    Css,
    Js,
}

impl Asset {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Index => INDEX,
            Self::Css => CSS,
            Self::Js => JS,
        }
    }

    fn content_type(self) -> &'static str {
        match self {
            Self::Index => "text/html; charset=utf-8",
            Self::Css => "text/css; charset=utf-8",
            Self::Js => "text/javascript; charset=utf-8",
        }
    }
}

pub fn register(context: &WebContext) {
    context.register_uri_scheme("omp", |request| serve(request));
}

fn asset_for_uri(uri: &str) -> Option<Asset> {
    let url = url::Url::parse(uri).ok()?;
    if url.scheme() != "omp"
        || url.host_str() != Some("bootstrap")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }

    // Exact URI matching intentionally rejects encoded separators, dot segments,
    // alternate authorities and every path outside the three embedded assets.
    match uri {
        "omp://bootstrap/index.html" => Some(Asset::Index),
        "omp://bootstrap/bootstrap.css" => Some(Asset::Css),
        "omp://bootstrap/bootstrap.js" => Some(Asset::Js),
        _ => None,
    }
}

fn serve(request: &URISchemeRequest) {
    let uri = request.uri().unwrap_or_default();
    let (bytes, content_type, status, reason) = match asset_for_uri(uri.as_str()) {
        Some(asset) => (asset.bytes(), asset.content_type(), 200, "OK"),
        None => (&b"Not Found"[..], "text/plain; charset=utf-8", 404, "Not Found"),
    };
    let body = glib::Bytes::from_static(bytes);
    let stream = gio::MemoryInputStream::from_bytes(&body);
    let response = URISchemeResponse::new(&stream, bytes.len() as i64);
    response.set_content_type(content_type);
    response.set_status(status, Some(reason));
    request.finish_with_response(&response);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_three_embedded_bootstrap_resources_are_routable() {
        assert_eq!(asset_for_uri("omp://bootstrap/index.html"), Some(Asset::Index));
        assert_eq!(asset_for_uri("omp://bootstrap/bootstrap.css"), Some(Asset::Css));
        assert_eq!(asset_for_uri("omp://bootstrap/bootstrap.js"), Some(Asset::Js));
        for uri in [
            "omp://bootstrap/",
            "omp://bootstrap/index.html/",
            "omp://bootstrap/../bootstrap.js",
            "omp://bootstrap/%2e%2e/bootstrap.js",
            "omp://bootstrap/index.html?x=1",
            "omp://bootstrap/index.html#x",
            "omp://bootstrap:80/index.html",
            "omp://user@bootstrap/index.html",
            "omp://bootstrap.evil/index.html",
            "file:///tmp/bootstrap.js",
            "not a uri",
        ] {
            assert_eq!(asset_for_uri(uri), None, "{uri}");
        }
    }
}
