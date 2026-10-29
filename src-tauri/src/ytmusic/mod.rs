//! Shared plumbing for talking to YouTube Music's internal `youtubei` API:
//! the shared HTTP client, request headers, auth headers and the client context.

pub(crate) mod parse;

use sha1::{Digest, Sha1};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Desktop Chrome user agent sent with every YouTube Music API request.
pub(crate) const CHROME_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Safari user agent used by the Google sign-in window.
pub(crate) const SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const YTM_ORIGIN: &str = "https://music.youtube.com";
const YTM_REFERER: &str = "https://music.youtube.com/";

/// One HTTP client for every YouTube Music request, so connections and TLS sessions are
/// reused instead of rebuilt per call. Equivalent to the former per-call
/// `reqwest::Client::new()`: no cookie store (cookies are attached by hand per request),
/// default redirect policy, no timeout.
pub(crate) static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

/// The `context` object every `youtubei/v1` request body carries.
pub(crate) fn web_remix_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": "1.20240101.01.00"
        }
    })
}

/// Adds the browser identity headers YouTube Music expects (User-Agent, Referer, Origin).
pub(crate) fn with_ytm_headers(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    req.header(reqwest::header::USER_AGENT, CHROME_USER_AGENT)
        .header("Referer", YTM_REFERER)
        .header("Origin", YTM_ORIGIN)
}

fn extract_cookie_value<'a>(cookies: &'a str, key: &str) -> Option<&'a str> {
    for part in cookies.split(';') {
        let trimmed = part.trim();
        if let Some((k, v)) = trimmed.split_once('=') {
            if k.trim() == key {
                return Some(v.trim());
            }
        }
    }
    None
}

fn generate_sapisid_hash(sapisid: &str, origin: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let payload = format!("{} {} {}", timestamp, sapisid, origin);
    let mut hasher = Sha1::new();
    hasher.update(payload.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    format!("{}_{}", timestamp, hash)
}

pub(crate) fn attach_youtube_auth(mut req: reqwest::RequestBuilder, cookies_opt: &Option<String>) -> reqwest::RequestBuilder {
    if let Some(cookies) = cookies_opt {
        req = req.header("Cookie", cookies);
        let sapisid_opt = extract_cookie_value(cookies, "SAPISID")
            .or_else(|| extract_cookie_value(cookies, "__Secure-3PAPISID"))
            .or_else(|| extract_cookie_value(cookies, "__Secure-1PAPISID"));
        if let Some(sapisid) = sapisid_opt {
            let auth = generate_sapisid_hash(sapisid, YTM_ORIGIN);
            req = req.header("Authorization", format!("SAPISIDHASH {}", auth));
            req = req.header("X-Origin", YTM_ORIGIN);
            req = req.header("X-Goog-AuthUser", "0");
        }
    }
    req
}
