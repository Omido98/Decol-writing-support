use ego_tree::NodeRef;
use futures_util::StreamExt;
use keyring::Entry;
use scraper::{ElementRef, Node, Selector};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

mod repository;

/// Service name under which API keys are stored in the OS keychain.
const KEYCHAIN_SERVICE: &str = "com.decol-writing-support.app";

/// Browser-like user agent so DuckDuckGo and typical websites serve normal
/// HTML instead of bot-blocking pages.
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Shared HTTP clients, built once and reused so connection pools, DNS
/// lookups and TLS sessions persist between calls ("reqwest::Client" is an
/// internally reference-counted handle and cheap to clone).
#[derive(Clone)]
struct HttpClients {
    /// Client for chat/model endpoints. Deliberately has NO overall request
    /// timeout: streamed responses may legitimately run for many minutes and
    /// already end via "[DONE]"/"message_stop" or user cancellation, so only
    /// the connect phase is bounded.
    chat: reqwest::Client,
    /// Client for HTML scraping with a browser user agent and bounded
    /// redirects. Call sites apply their own per-request timeouts.
    scrape: reqwest::Client,
}

impl HttpClients {
    /// The scrape client configuration, shared by the pooled client and by
    /// the per-hop PINNED clients of `fetch_public_validated`.
    fn scrape_builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(BROWSER_USER_AGENT)
            // Redirects are followed MANUALLY by `fetch_public_validated`
            // so every hop is checked against the private-address block
            // list — an automatic policy would happily follow a redirect
            // into http://169.254.169.254/ and bypass the network controls.
            .redirect(reqwest::redirect::Policy::none())
    }

    fn new() -> Result<Self, String> {
        let chat = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        let scrape = Self::scrape_builder()
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        Ok(Self { chat, scrape })
    }
}

/// Upper bound on tool calls tracked for a single streamed response, so a
/// malformed stream advertising huge index values cannot balloon memory.
const MAX_STREAM_TOOL_CALLS: usize = 128;

/// Maximum redirect hops `fetch_public_validated` follows.
const MAX_RESEARCH_REDIRECTS: usize = 5;

/// Block research access to local/private addresses: the web tools are for
/// PUBLIC web research — the user's configured chat endpoint may be a local
/// model server (an explicit choice), but tool calls must never be able to
/// reach loopback, private ranges, or link-local metadata services.
fn is_public_url(url: &reqwest::Url) -> Result<(), String> {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Unsupported URL scheme: {scheme}"));
    }
    let Some(host) = url.host_str() else {
        return Err("Blocked: the URL has no host.".to_string());
    };
    let host = host.to_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
    {
        return Err(format!("Blocked: {host} is a local/private address."));
    }
    if let Some(ip) = parse_host_ip(&host) {
        if is_blocked_ip(ip) {
            return Err(format!("Blocked: {host} is a local/private address."));
        }
    }
    Ok(())
}

/// Every IPv4 address an IPv6 form can carry to an IPv4 network: IPv4-
/// mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`, deprecated but
/// still routable), 6to4 (`2002:WWXX:YYZZ::/48`), Teredo
/// (`2001:0::/32`, server + obfuscated client) and NAT64
/// (`64:ff9b::/96`). Each is classified with the IPv4 rules, so a
/// loopback/private IPv4 cannot slip past the block list behind one of
/// these forms (F08). The pinning/race behavior is unchanged.
fn embedded_ipv4_addrs(v6: std::net::Ipv6Addr) -> Vec<std::net::Ipv4Addr> {
    fn from_segments(hi: u16, lo: u16) -> std::net::Ipv4Addr {
        std::net::Ipv4Addr::new(
            (hi >> 8) as u8,
            hi as u8,
            (lo >> 8) as u8,
            lo as u8,
        )
    }
    let segments = v6.segments();
    let mut out = Vec::new();
    if let Some(v4) = v6.to_ipv4_mapped() {
        out.push(v4);
    } else if segments[0..6].iter().all(|s| *s == 0) {
        // IPv4-compatible (::/96).
        out.push(from_segments(segments[6], segments[7]));
    }
    if segments[0] == 0x2002 {
        // 6to4: 2002:WWXX:YYZZ::/48 embeds the IPv4 in segments 1-2.
        out.push(from_segments(segments[1], segments[2]));
    }
    if segments[0] == 0x2001 && segments[1] == 0 {
        // Teredo: the server is segments 2-3; the client is segments 4-5
        // with every bit flipped.
        out.push(from_segments(segments[2], segments[3]));
        out.push(from_segments(
            segments[4] ^ 0xffff,
            segments[5] ^ 0xffff,
        ));
    }
    if segments[0] == 0x0064
        && segments[1] == 0xff9b
        && segments[2..6].iter().all(|s| *s == 0)
    {
        // NAT64 well-known prefix (64:ff9b::/96).
        out.push(from_segments(segments[6], segments[7]));
    }
    out
}

/// The IP block list (single source of truth for hostname checks AND for
/// the connect-time resolution check below).
fn is_blocked_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
        }
        std::net::IpAddr::V6(v6) => {
            // IPv6 forms that carry an IPv4 address reach IPv4 networks:
            // classify every embedded address with the IPv4 rules, so
            // e.g. 2002:7f00:1:: cannot dodge the block list.
            for v4 in embedded_ipv4_addrs(v6) {
                if is_blocked_ip(std::net::IpAddr::V4(v4)) {
                    return true;
                }
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link local
        }
    }
}

/// Extract the IP from a URL host string. `reqwest::Url::host_str` returns
/// IPv6 literals WITH brackets ("[::1]"), which `IpAddr::from_str` rejects —
/// stripping them keeps literal IPv6 addresses on the block-list path.
fn parse_host_ip(host: &str) -> Option<std::net::IpAddr> {
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    bare.parse::<std::net::IpAddr>().ok()
}

/// Validate a set of RESOLVED addresses (DNS-rebinding defense, R9 note):
/// a public hostname that resolves to a private address is refused BEFORE
/// any connection is made, and the connection pins to a VERIFIED address.
/// Pure and testable offline.
fn verify_resolved_addrs(addrs: Vec<std::net::SocketAddr>) -> Result<std::net::SocketAddr, String> {
    let mut first_allowed: Option<std::net::SocketAddr> = None;
    for addr in addrs {
        if is_blocked_ip(addr.ip()) {
            return Err(format!(
                "Blocked: the host resolved to a local/private address ({addr})."
            ));
        }
        if first_allowed.is_none() {
            first_allowed = Some(addr);
        }
    }
    first_allowed.ok_or_else(|| "Blocked: the host resolved to no addresses.".to_string())
}

/// The cancellation error every abortable native phase returns. The
/// frontend classifies a stop by its abort signal, not by this text.
const CANCELLED: &str = "Request cancelled.";

/// Await `fut`, resolving early with the cancellation error when `token`
/// fires. Every awaited native phase a Stop can reach goes through here
/// (DNS lookup, headers, body reading, one-shot fallback requests), so an
/// abort terminates the native work instead of only abandoning the caller.
async fn race_cancel<F, T>(token: Option<&CancellationToken>, fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = T>,
{
    match token {
        Some(t) => tokio::select! {
            biased;
            _ = t.cancelled() => Err(CANCELLED.to_string()),
            out = fut => Ok(out),
        },
        None => Ok(fut.await),
    }
}

/// Resolve a host and verify EVERY address against the block list,
/// returning the verified socket address the connection must pin to. The
/// lookup itself is cancellable, so a Stop during DNS resolution returns
/// promptly without leaking a pending task.
async fn resolve_verified_host(
    host: &str,
    port: u16,
    token: Option<&CancellationToken>,
) -> Result<std::net::SocketAddr, String> {
    if token.is_some_and(|t| t.is_cancelled()) {
        return Err(CANCELLED.to_string());
    }
    // An IP literal is validated directly (no lookup). Host strings from
    // reqwest carry IPv6 brackets; parse_host_ip strips them, and the
    // socket address is built TYPED so an IPv6 literal needs no
    // error-prone string round-trip.
    if let Some(ip) = parse_host_ip(host) {
        if is_blocked_ip(ip) {
            return Err(format!("Blocked: {host} is a local/private address."));
        }
        return Ok(std::net::SocketAddr::new(ip, port));
    }
    let lookup = tokio::net::lookup_host((host, port));
    let addrs: Vec<std::net::SocketAddr> = race_cancel(token, lookup)
        .await?
        .map_err(|e| format!("DNS lookup failed for {host}: {e}"))?
        .collect();
    verify_resolved_addrs(addrs)
}

/// GET a PUBLIC url, following up to MAX_RESEARCH_REDIRECTS redirects and
/// validating EVERY hop: the scheme/hostname checks of `is_public_url`,
/// PLUS the connect-time DNS verification (R9 note) — every resolved
/// address must be public and the connection PINS to the verified socket
/// address (a rebinding hostname resolving to a private IP is refused
/// before any bytes are sent). DNS, headers, and every redirect hop honour
/// the cancellation token (B17a).
async fn fetch_public_validated(
    url: reqwest::Url,
    token: Option<&CancellationToken>,
) -> Result<reqwest::Response, String> {
    let mut target = url;
    for _hop in 0..=MAX_RESEARCH_REDIRECTS {
        if token.is_some_and(|t| t.is_cancelled()) {
            return Err(CANCELLED.to_string());
        }
        is_public_url(&target)?;
        let host = target
            .host_str()
            .ok_or_else(|| "Blocked: the URL has no host.".to_string())?
            .to_lowercase();
        let port = target
            .port_or_known_default()
            .ok_or_else(|| "Blocked: the URL has no port.".to_string())?;
        let verified = resolve_verified_host(&host, port, token).await?;
        // Per-hop client pinned to the verified address (resolve() keeps
        // the URL hostname for TLS/SNI while forcing the connect IP).
        let pinned = HttpClients::scrape_builder()
            .resolve(&host, verified)
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        let response = race_cancel(
            token,
            pinned
                .get(target.clone())
                .timeout(Duration::from_secs(30))
                .send(),
        )
        .await?
        .map_err(|e| format!("Network error: {e}"))?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| format!("Redirect without a location (HTTP {})", response.status()))?;
            target = response
                .url()
                .join(location)
                .map_err(|e| format!("Invalid redirect target: {e}"))?;
            continue;
        }
        return Ok(response);
    }
    Err(format!("Too many redirects (more than {MAX_RESEARCH_REDIRECTS})."))
}

/// Hard cap on page bytes handed to the HTML parser in "zen_fetch_page";
/// readable article content sits far below this and larger downloads would
/// only spend parse time on text that gets truncated away anyway.
const MAX_PAGE_BYTES: usize = 1024 * 1024;

/// Text-collection budget for "zen_fetch_page", slightly above the
/// 8000-character output cap so whitespace normalisation cannot undershoot.
const FETCH_TEXT_BUDGET_CHARS: usize = 9000;

// ──────────────────────────────────────────────
// Pre-parsed CSS selectors (compiled once, reused by every scrape call)
// ──────────────────────────────────────────────

static DDG_RESULT_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("div.result").expect("valid static selector"));
static DDG_TITLE_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("a.result__a").expect("valid static selector"));
static DDG_SNIPPET_SELECTOR: LazyLock<Selector> = LazyLock::new(|| {
    Selector::parse("a.result__snippet, div.result__snippet").expect("valid static selector")
});
static FETCH_SKIP_SELECTOR: LazyLock<Selector> = LazyLock::new(|| {
    Selector::parse(
        "script, style, noscript, template, svg, nav, header, footer, aside, iframe, form",
    )
    .expect("valid static selector")
});
static FETCH_BODY_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("body").expect("valid static selector"));
static ZEN_TABLE_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("table").expect("valid static selector"));
static ZEN_ROW_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("tr").expect("valid static selector"));
static ZEN_CELL_SELECTOR: LazyLock<Selector> =
    LazyLock::new(|| Selector::parse("th, td").expect("valid static selector"));

/// A single web search result.
#[derive(Serialize, Deserialize, Clone)]
pub struct WebResult {
    title: String,
    url: String,
    snippet: String,
}

/// OpenAI-compatible model list response: `{ "data": [{ "id": "..." }] }`.
#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

/// Build the full endpoint URL for the Anthropic API. Accepts the base URL
/// with or without a trailing `/v1` and appends the given path.
fn anthropic_endpoint(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    format!("{base}/v1{path}")
}

/// Hard cap on automatic retries for HTTP 429 (rate limit) responses, and
/// the longest delay we are willing to wait based on a `Retry-After` header.
const MAX_RATE_LIMIT_RETRIES: u32 = 3;
const MAX_RETRY_AFTER_SECS: u64 = 30;

/// Whether a 429 response signals an exhausted quota (not retryable) rather
/// than a transient rate limit. Retrying quota errors would only waste calls.
fn is_quota_error(status: reqwest::StatusCode, body: &str) -> bool {
    if status != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return false;
    }
    let lower = body.to_lowercase();
    lower.contains("free usage") || lower.contains("freeusagelimit") || lower.contains("quota")
}

/// Seconds to wait before retrying, from the `Retry-After` header (capped),
/// or `None` when the header is missing or unparsable.
fn retry_after_secs(response: &reqwest::Response) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .map(|secs| secs.min(MAX_RETRY_AFTER_SECS))
}

/// Exponential backoff for retry attempt `attempt` (0-indexed): 1s, 2s, 4s.
fn backoff_secs(attempt: u32) -> u64 {
    [1, 2, 4]
        .get(attempt as usize)
        .copied()
        .unwrap_or(MAX_RETRY_AFTER_SECS)
}

fn friendly_rate_limit_message(status: reqwest::StatusCode, retry_after: Option<u64>) -> String {
    match retry_after {
        Some(secs) => format!(
            "Rate limit reached ({status}). Please try again in about {secs} seconds."
        ),
        None => format!("Rate limit reached ({status}). Please wait a moment and try again."),
    }
}

fn friendly_quota_message(status: reqwest::StatusCode) -> String {
    format!(
        "Free usage limit reached ({status}). The free allowance resets daily, so please try again later."
    )
}

/// Send a POST request to a provider endpoint, retrying HTTP 429 responses
/// up to `MAX_RATE_LIMIT_RETRIES` times with `Retry-After` or exponential
/// backoff. Quota-type 429s fail immediately with a friendly message; any
/// other non-2xx status fails with the usual API error text. Returns the
/// response only for a successful status. When a cancellation token is
/// supplied and it fires during a backoff wait, the request is aborted.
async fn send_with_retry(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    provider: &str,
    payload: &serde_json::Value,
    token: Option<&CancellationToken>,
) -> Result<reqwest::Response, String> {
    for attempt in 0..=MAX_RATE_LIMIT_RETRIES {
        let mut request = client.post(url).json(payload);
        if provider == "anthropic" {
            request = request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        } else {
            request = request.bearer_auth(api_key);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Network error: {e}"))?;

        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }

        let retry_after = retry_after_secs(&response);
        let body = response
            .text()
            .await
            .map_err(|e| format!("Failed to read response: {e}"))?;

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if is_quota_error(status, &body) {
                return Err(friendly_quota_message(status));
            }
            if attempt < MAX_RATE_LIMIT_RETRIES {
                if token.is_some_and(|t| t.is_cancelled()) {
                    return Err("Request cancelled.".to_string());
                }
                let wait = retry_after.unwrap_or_else(|| backoff_secs(attempt));
                // Abort promptly when cancellation fires during the wait,
                // instead of finishing the sleep and firing another API call.
                let cancelled = match token {
                    Some(t) => {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(wait)) => false,
                            _ = t.cancelled() => true,
                        }
                    }
                    None => {
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                        false
                    }
                };
                if cancelled {
                    return Err("Request cancelled.".to_string());
                }
                continue;
            }
            return Err(friendly_rate_limit_message(status, retry_after));
        }

        let snippet: String = body.chars().take(500).collect();
        return Err(format!("API error ({status}): {snippet}"));
    }
    Err("Rate limit retries exhausted.".to_string())
}

/// List available models from a `/models` endpoint (OpenAI-compatible shape:
/// `{ "data": [{ "id": "..." }] }`, which Anthropic also uses).
/// Used to populate the model dropdown.
#[tauri::command]
async fn zen_list_models(
    clients: State<'_, HttpClients>,
    base_url: String,
    api_key: String,
    provider: String,
) -> Result<Vec<String>, String> {
    let base = base_url.trim_end_matches('/').to_string();
    let url = if provider == "anthropic" {
        anthropic_endpoint(&base, "/models")
    } else {
        format!("{base}/models")
    };

    let mut request = clients.chat.get(&url);
    if !api_key.is_empty() {
        request = if provider == "anthropic" {
            request
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(&api_key)
        };
    }

    let response = request
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Models endpoint returned HTTP {}", response.status()));
    }

    let parsed: ModelsResponse = response
        .json()
        .await
        .map_err(|e| format!("Invalid response from models endpoint: {e}"))?;

    // Deduplicate and sort so the dropdown is stable for providers that
    // return repeated or unordered model ids.
    let mut models: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    models.sort();
    models.dedup();
    Ok(models)
}

/// The one-shot (non-streaming) chat request: send with 429 retries, read
/// the response body, parse JSON. Every awaited phase honours the token.
async fn run_chat(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    provider: &str,
    payload: &serde_json::Value,
    token: Option<&CancellationToken>,
) -> Result<serde_json::Value, String> {
    let base = base_url.trim_end_matches('/').to_string();
    let url = if provider == "anthropic" {
        anthropic_endpoint(&base, "/messages")
    } else {
        format!("{base}/chat/completions")
    };

    // Overall cap for the one-shot request (streaming runs without such a
    // cap because its progress and cancellation are observable).
    const NON_STREAM_TIMEOUT: Duration = Duration::from_secs(300);
    let response = race_cancel(
        token,
        tokio::time::timeout(
            NON_STREAM_TIMEOUT,
            send_with_retry(client, &url, api_key, provider, payload, token),
        ),
    )
    .await?
    .map_err(|_| "Chat request timed out after 300 seconds.".to_string())??;

    let text = race_cancel(token, response.text())
        .await?
        .map_err(|e| format!("Failed to read response: {e}"))?;

    serde_json::from_str(&text).map_err(|e| format!("Invalid response from API: {e}"))
}

/// Forward a chat request to the configured provider's endpoint.
/// OpenAI-compatible providers use `/chat/completions` with a Bearer token;
/// Anthropic uses `/v1/messages` with `x-api-key` + `anthropic-version`.
/// Runs on the Rust side so the Tauri webview never hits CORS restrictions.
///
/// One-shot (non-streaming) fallback for providers that reject streaming:
/// when the frontend supplies an `id`, the request registers in the shared
/// cancellation registry, so Stop cancels the send AND the body read
/// (B17a) instead of leaving a native request running.
#[tauri::command]
async fn zen_chat(
    clients: State<'_, HttpClients>,
    state: State<'_, StreamState>,
    id: Option<String>,
    base_url: String,
    api_key: String,
    provider: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let (request_id, token) = request_token(&state, &id);
    let result = run_chat(
        &clients.chat,
        &base_url,
        &api_key,
        &provider,
        &payload,
        token.as_ref(),
    )
    .await;
    release_request(&state, &request_id);
    result
}

// ──────────────────────────────────────────────
// Streamed chat (SSE) with cancellation
// ──────────────────────────────────────────────

/// Registry of in-flight cancellable requests (streams, the one-shot chat
/// fallback, and research tool calls), keyed by request id. Used so the
/// frontend can cancel a request mid-flight (`zen_chat_stream_cancel`).
///
/// A cancel for an id that has not registered yet leaves a PRE-CANCELLED
/// TOMBSTONE so a Stop cannot race past its request. Tombstones are
/// bounded and expirable (F07): a Stop that never gets a request (a lost
/// or bogus id) must not grow the registry forever, while the
/// pre-registration race protection is preserved for recent cancels.
const CANCEL_TOMBSTONE_TTL: Duration = Duration::from_secs(30);
const MAX_CANCEL_TOMBSTONES: usize = 32;

#[derive(Clone)]
struct RequestSlot {
    token: CancellationToken,
    /// Some(instant) while this slot is a tombstone (created by a cancel
    /// for an unregistered id); the late request adopts the token and
    /// clears the marker. Live entries are never evicted by the bound.
    tombstone_since: Option<Instant>,
}

#[derive(Clone, Default)]
struct StreamState(Arc<Mutex<HashMap<String, RequestSlot>>>);

impl StreamState {
    /// Lock the registry, recovering from poisoning: registry operations
    /// never leave the map in an invalid state, so a panic while a guard
    /// is held must not wedge cancellation and cleanup for every later
    /// request.
    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, RequestSlot>> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The cancellation token for a request id, inserting a fresh one when
    /// absent. A token already present — e.g. a PRE-CANCELLED tombstone
    /// left by a Stop that arrived before the request started — is
    /// returned as-is, so a cancel can never race past its request.
    fn token_for(&self, id: &str) -> CancellationToken {
        let mut map = self.lock();
        if let Some(slot) = map.get_mut(id) {
            // The late request adopts a tombstone: it is live from here on.
            slot.tombstone_since = None;
            return slot.token.clone();
        }
        let token = CancellationToken::new();
        map.insert(
            id.to_string(),
            RequestSlot {
                token: token.clone(),
                tombstone_since: None,
            },
        );
        token
    }

    /// Cancel a request by id. When the id is not registered yet, leave a
    /// PRE-CANCELLED tombstone: the late request picks it up instead of
    /// running to completion. Tombstones are pruned by TTL and capped hard
    /// so abandoned cancel ids cannot accumulate without bound.
    fn cancel(&self, id: &str) {
        let mut map = self.lock();
        if let Some(slot) = map.get(id) {
            slot.token.cancel();
            return;
        }
        let tombstone = CancellationToken::new();
        tombstone.cancel();
        map.insert(
            id.to_string(),
            RequestSlot {
                token: tombstone,
                tombstone_since: Some(Instant::now()),
            },
        );
        prune_cancel_tombstones(&mut map, Instant::now());
    }

    /// Test seam: how many pre-cancelled tombstones the registry holds.
    #[cfg(test)]
    fn tombstone_count(&self) -> usize {
        self.lock()
            .values()
            .filter(|slot| slot.tombstone_since.is_some())
            .count()
    }
}

/// Drop expired tombstones, then evict the oldest beyond the hard cap.
/// Live request entries are never touched.
fn prune_cancel_tombstones(
    map: &mut HashMap<String, RequestSlot>,
    now: Instant,
) {
    map.retain(|_, slot| match slot.tombstone_since {
        Some(at) => now.saturating_duration_since(at) < CANCEL_TOMBSTONE_TTL,
        None => true,
    });
    let mut tombstones: Vec<(String, Instant)> = map
        .iter()
        .filter_map(|(id, slot)| {
            slot.tombstone_since.map(|at| (id.clone(), at))
        })
        .collect();
    if tombstones.len() <= MAX_CANCEL_TOMBSTONES {
        return;
    }
    tombstones.sort_by_key(|(_, at)| *at);
    let excess = tombstones.len() - MAX_CANCEL_TOMBSTONES;
    for (id, _) in tombstones.into_iter().take(excess) {
        map.remove(&id);
    }
}

/// Events emitted to the frontend while a chat response streams in.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ChatStreamEvent {
    /// A chunk of answer text (rendered live by the chat UI).
    Delta { text: String },
    /// The stream finished: `data` is the fully assembled response JSON in
    /// the same shape zen_chat returns (OpenAI or Anthropic).
    Done { data: serde_json::Value },
    /// The stream failed before completing.
    Error { message: String },
}

/// A tool call being assembled from OpenAI streaming deltas.
#[derive(Default)]
struct OpenAIToolCallAcc {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

/// A content block being assembled from Anthropic streaming events.
struct AnthropicBlockAcc {
    block_type: String,
    text: String,
    id: Option<String>,
    name: Option<String>,
    input_json: String,
}

/// Accumulates SSE events for one streamed response, in either the OpenAI or
/// the Anthropic wire format, and emits text deltas to the frontend.
struct StreamAccumulator {
    provider: String,
    openai_content: String,
    openai_tool_calls: Vec<OpenAIToolCallAcc>,
    openai_finished: bool,
    openai_finish_reason: Option<String>,
    /// True when the OpenAI protocol's `[DONE]` sentinel was seen.
    openai_done: bool,
    /// Bounded drain budget after a finish_reason: OpenAI sends the usage
    /// chunk (and `[DONE]`) AFTER the finish chunk, so the stream must be
    /// read a little further before stopping.
    openai_drain_remaining: u8,
    usage: Option<serde_json::Value>,
    anthropic_blocks: Vec<AnthropicBlockAcc>,
    anthropic_stop_reason: Option<String>,
    anthropic_finished: bool,
}

impl StreamAccumulator {
    fn new(provider: &str) -> Self {
        Self {
            provider: provider.to_string(),
            openai_content: String::new(),
            openai_tool_calls: Vec::new(),
            openai_finished: false,
            openai_finish_reason: None,
            openai_done: false,
            openai_drain_remaining: 0,
            usage: None,
            anthropic_blocks: Vec::new(),
            anthropic_stop_reason: None,
            anthropic_finished: false,
        }
    }

    /// True once the response signals the end of the stream.
    fn is_finished(&self) -> bool {
        if self.provider == "anthropic" {
            self.anthropic_finished
        } else {
            self.openai_finished
        }
    }

    /// True when more events must be read even though the response is
    /// finished: OpenAI's usage chunk arrives after finish_reason.
    fn wants_drain(&self) -> bool {
        self.provider != "anthropic" && self.openai_finished && self.openai_drain_remaining > 0
    }

    /// True when nothing was accumulated at all (no text, no tool calls).
    fn is_empty(&self) -> bool {
        if self.provider == "anthropic" {
            self.anthropic_blocks
                .iter()
                .all(|b| b.text.is_empty() && b.input_json.is_empty())
        } else {
            self.openai_content.is_empty()
                && self
                    .openai_tool_calls
                    .iter()
                    .all(|c| c.id.is_none() && c.name.is_none() && c.arguments.is_empty())
        }
    }

    /// Process one SSE `data:` payload. Returns the answer-text delta to
    /// forward to the frontend, if this payload carried one.
    fn feed(&mut self, data: &str) -> Result<Option<String>, String> {
        if data == "[DONE]" {
            self.openai_done = true;
            self.openai_finished = true;
            self.openai_drain_remaining = 0;
            return Ok(None);
        }
        let parsed: serde_json::Value = serde_json::from_str(data)
            .map_err(|e| format!("Failed to parse streamed event: {e}"))?;
        // Explicit provider error payloads end the stream with an error,
        // even mid-text (the frontend preserves the partial text). OpenAI
        // sends `{"error": {...}}`; Anthropic an `error` event type.
        let error_payload = parsed
            .get("error")
            .filter(|e| !e.is_null())
            .or_else(|| {
                if parsed.get("type").and_then(|t| t.as_str()) == Some("error") {
                    parsed.get("error")
                } else {
                    None
                }
            });
        if let Some(err) = error_payload {
            let message = err
                .get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| err.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| err.to_string());
            return Err(format!("The provider reported an error: {message}"));
        }
        // Usage can arrive on a dedicated final chunk (OpenAI), on
        // message_delta (Anthropic, root level), or in message_start
        // (`message.usage`) — MERGE it whenever seen, so an Anthropic
        // output_tokens delta does not discard the input_tokens captured
        // at message_start.
        if let Some(u) = parsed.get("usage").filter(|u| !u.is_null()) {
            self.capture_usage(u);
            self.openai_drain_remaining = 0;
        }
        if self.provider == "anthropic" {
            self.feed_anthropic(&parsed)
        } else {
            self.feed_openai(&parsed)
        }
    }

    /// Merge one usage payload into the accumulated usage (objects merge
    /// key-by-key; anything else replaces).
    fn capture_usage(&mut self, u: &serde_json::Value) {
        self.usage = Some(match (self.usage.take(), u) {
            (Some(serde_json::Value::Object(mut prev)), serde_json::Value::Object(next)) => {
                for (key, value) in next {
                    prev.insert(key.clone(), value.clone());
                }
                serde_json::Value::Object(prev)
            }
            (_, next) => next.clone(),
        });
    }

    fn feed_openai(&mut self, parsed: &serde_json::Value) -> Result<Option<String>, String> {
        // Spend one unit of the post-finish drain budget per consumed
        // event, so a provider that never sends usage/[DONE] cannot make
        // the stream wait forever (EOF/cancellation still ends it).
        if self.openai_drain_remaining > 0 {
            self.openai_drain_remaining -= 1;
        }
        let Some(choice) = parsed.pointer("/choices/0") else {
            return Ok(None);
        };
        if let Some(reason) = choice.get("finish_reason") {
            if !reason.is_null() {
                self.openai_finished = true;
                self.openai_finish_reason =
                    reason.as_str().map(|s| s.to_string());
                // OpenAI sends the usage chunk and [DONE] AFTER this one.
                if !self.openai_done {
                    self.openai_drain_remaining = 2;
                }
            }
        }
        let Some(delta) = choice.get("delta") else {
            return Ok(None);
        };

        let mut text_delta: Option<String> = None;
        if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
            if !content.is_empty() {
                self.openai_content.push_str(content);
                text_delta = Some(content.to_string());
            }
        }

        if let Some(tool_calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for call in tool_calls {
                let index = call
                    .get("index")
                    .and_then(|i| i.as_u64())
                    .unwrap_or(0) as usize;
                // Guard against malformed streams advertising huge indices.
                if index >= MAX_STREAM_TOOL_CALLS {
                    continue;
                }
                while self.openai_tool_calls.len() <= index {
                    self.openai_tool_calls
                        .push(OpenAIToolCallAcc::default());
                }
                let acc = &mut self.openai_tool_calls[index];
                if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                    acc.id = Some(id.to_string());
                }
                if let Some(name) = call
                    .pointer("/function/name")
                    .and_then(|n| n.as_str())
                {
                    acc.name = Some(name.to_string());
                }
                if let Some(args) = call
                    .pointer("/function/arguments")
                    .and_then(|a| a.as_str())
                {
                    acc.arguments.push_str(args);
                }
            }
        }
        Ok(text_delta)
    }

    fn feed_anthropic(&mut self, parsed: &serde_json::Value) -> Result<Option<String>, String> {
        let event_type = parsed
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        match event_type {
            "content_block_start" => {
                let block = parsed.get("content_block").cloned().unwrap_or_default();
                let block_type = block
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("text")
                    .to_string();
                let mut acc = AnthropicBlockAcc {
                    block_type,
                    text: String::new(),
                    id: block
                        .get("id")
                        .and_then(|i| i.as_str())
                        .map(|s| s.to_string()),
                    name: block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string()),
                    input_json: String::new(),
                };
                if acc.block_type != "tool_use" {
                    acc.id = None;
                    acc.name = None;
                }
                self.anthropic_blocks.push(acc);
            }
            "content_block_delta" => {
                let delta = parsed.get("delta").cloned().unwrap_or_default();
                match delta
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                {
                    "text_delta" => {
                        let text = delta
                            .get("text")
                            .and_then(|t| t.as_str())
                            .unwrap_or("");
                        if !text.is_empty() {
                            if let Some(last) = self.anthropic_blocks.last_mut() {
                                last.text.push_str(text);
                            } else {
                                self.anthropic_blocks.push(AnthropicBlockAcc {
                                    block_type: "text".to_string(),
                                    text: text.to_string(),
                                    id: None,
                                    name: None,
                                    input_json: String::new(),
                                });
                            }
                            return Ok(Some(text.to_string()));
                        }
                    }
                    "input_json_delta" => {
                        let partial = delta
                            .get("partial_json")
                            .and_then(|p| p.as_str())
                            .unwrap_or("");
                        if let Some(last) = self.anthropic_blocks.last_mut() {
                            last.input_json.push_str(partial);
                        }
                    }
                    _ => {}
                }
            }
            "message_start" => {
                // Anthropic reports input_tokens inside message_start.
                if let Some(u) = parsed.pointer("/message/usage") {
                    self.capture_usage(u);
                }
            }
            "message_delta" => {
                if let Some(stop) = parsed
                    .pointer("/delta/stop_reason")
                    .and_then(|r| r.as_str())
                {
                    self.anthropic_stop_reason = Some(stop.to_string());
                }
                // Root-level usage was already merged by feed().
            }
            "message_stop" => {
                self.anthropic_finished = true;
            }
            _ => {}
        }
        Ok(None)
    }

    /// Assemble the final response JSON in the same shape the non-streaming
    /// zen_chat command returns, preserving finish reason, usage, and an
    /// explicit truncation marker (EOF without the provider's completion
    /// signal is INTERRUPTED, never a success).
    fn finish(&self) -> serde_json::Value {
        if self.provider == "anthropic" {
            let content: Vec<serde_json::Value> = self
                .anthropic_blocks
                .iter()
                .map(|block| {
                    if block.block_type == "tool_use" {
                        let input: serde_json::Value =
                            serde_json::from_str(&block.input_json)
                                .unwrap_or_else(|_| serde_json::json!({}));
                        serde_json::json!({
                            "type": "tool_use",
                            "id": block.id,
                            "name": block.name,
                            "input": input,
                        })
                    } else {
                        serde_json::json!({ "type": "text", "text": block.text })
                    }
                })
                .collect();
            serde_json::json!({
                "content": content,
                "stop_reason": self.anthropic_stop_reason,
                "usage": self.usage,
                "truncated": !self.anthropic_finished,
            })
        } else {
            let content = if self.openai_content.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(self.openai_content.clone())
            };
            let tool_calls: Vec<serde_json::Value> = self
                .openai_tool_calls
                .iter()
                .filter(|c| c.id.is_some() && c.name.is_some())
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "type": "function",
                        "function": { "name": c.name, "arguments": c.arguments },
                    })
                })
                .collect();
            serde_json::json!({
                "choices": [{
                    "message": {
                        "content": content,
                        "tool_calls": if tool_calls.is_empty() {
                            serde_json::Value::Null
                        } else {
                            serde_json::Value::Array(tool_calls)
                        },
                    },
                    "finish_reason": self.openai_finish_reason,
                    "truncated": !self.openai_finished,
                }],
                // Normalized root-level usage (the same value the
                // choice-level field carried before B16).
                "usage": self.usage,
            })
        }
    }
}

/// Read an SSE response body chunk-by-chunk, feed events into the
/// accumulator (emitting text deltas as they arrive), and finish with the
/// fully assembled response. When `token` is cancelled, the HTTP connection
/// is dropped and whatever text was accumulated so far is still delivered.
async fn stream_sse(
    response: reqwest::Response,
    provider: &str,
    on_event: &Channel<ChatStreamEvent>,
    token: &CancellationToken,
) -> Result<(), String> {
    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut event_data = String::new();
    let mut acc = StreamAccumulator::new(provider);

    let consume = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| format!("Failed to read response stream: {e}"))?;
            buffer.extend_from_slice(&chunk);
            loop {
                let Some(pos) = buffer.iter().position(|&b| b == b'\n') else {
                    break;
                };
                let line: Vec<u8> = buffer.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let line = line.trim_end_matches(['\r', '\n']);
                if line.is_empty() {
                    if !event_data.is_empty() {
                        if let Some(delta) = acc.feed(&event_data)? {
                            on_event
                                .send(ChatStreamEvent::Delta { text: delta })
                                .map_err(|e| format!("Failed to send stream event: {e}"))?;
                        }
                        event_data.clear();
                        if acc.is_finished() && !acc.wants_drain() {
                            return Ok::<(), String>(());
                        }
                    }
                } else if let Some(data) = line.strip_prefix("data:") {
                    if !event_data.is_empty() {
                        event_data.push('\n');
                    }
                    event_data.push_str(data.trim_start());
                }
                // "event:", "id:" and "retry:" lines are ignored.
            }
        }
        // A trailing event that was not terminated by a blank line.
        if !event_data.is_empty() {
            if let Some(delta) = acc.feed(&event_data)? {
                on_event
                    .send(ChatStreamEvent::Delta { text: delta })
                    .map_err(|e| format!("Failed to send stream event: {e}"))?;
            }
        }
        Ok::<(), String>(())
    };

    tokio::select! {
        biased;
        _ = token.cancelled() => {}
        result = consume => result?,
    }

    // EOF without the provider's completion signal is an INTERRUPTED
    // stream, never a success. With no content at all it is an error;
    // with partial content it is delivered as an explicitly truncated
    // answer (the Done payload carries `truncated: true`).
    if !acc.is_finished() {
        if acc.is_empty() {
            return Err(
                "The response stream ended before the model finished (connection interrupted); no answer was produced."
                    .to_string(),
            );
        }
    }

    on_event
        .send(ChatStreamEvent::Done {
            data: acc.finish(),
        })
        .map_err(|e| format!("Failed to send stream event: {e}"))
}

/// Send a chat request with `stream: true` and forward the response to the
/// frontend via `on_event`. Returns the fully assembled response JSON in the
/// same shape zen_chat returns (works for providers that ignore streaming
/// and reply with a plain JSON body).
async fn run_stream(
    client: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    provider: &str,
    payload: &serde_json::Value,
    on_event: &Channel<ChatStreamEvent>,
    token: &CancellationToken,
) -> Result<(), String> {
    let base = base_url.trim_end_matches('/').to_string();
    let url = if provider == "anthropic" {
        anthropic_endpoint(&base, "/messages")
    } else {
        format!("{base}/chat/completions")
    };

    // A tombstone from a Stop that arrived before startup: never send.
    if token.is_cancelled() {
        return Err(CANCELLED.to_string());
    }

    // Retried on HTTP 429 with backoff. Retries happen while the initial
    // request is rejected, before any SSE data has been emitted, so a retried
    // stream is indistinguishable from a slow first response. The send
    // itself races the token, so a Stop during headers terminates the
    // native request (B17a).
    let response = race_cancel(
        Some(token),
        send_with_retry(client, &url, api_key, provider, payload, Some(token)),
    )
    .await??;

    // Providers that ignore `stream: true` answer with a plain JSON body;
    // treat anything that is not text/event-stream as such.
    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.contains("text/event-stream"))
        .unwrap_or(true);

    if is_sse {
        return stream_sse(response, provider, on_event, token).await;
    }

    let text = race_cancel(Some(token), response.text())
        .await?
        .map_err(|e| format!("Failed to read response: {e}"))?;
    let data: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid response from API: {e}"))?;
    on_event
        .send(ChatStreamEvent::Done { data })
        .map_err(|e| format!("Failed to send stream event: {e}"))
}

/// Unique ids for in-flight streaming requests.
static STREAM_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn stream_request_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{nanos}-{}",
        STREAM_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// Start a streamed chat request. Returns a request id immediately; response
/// chunks arrive as events on `on_event` (`delta` / `done` / `error`).
#[tauri::command]
fn zen_chat_stream(
    clients: State<'_, HttpClients>,
    base_url: String,
    api_key: String,
    provider: String,
    payload: serde_json::Value,
    on_event: Channel<ChatStreamEvent>,
    state: State<'_, StreamState>,
) -> Result<String, String> {
    let id = stream_request_id();
    // token_for: a Stop that arrived before this request registered left a
    // pre-cancelled tombstone, and the stream must honour it.
    let token = state.token_for(&id);

    let chat_client = clients.inner().clone();
    let registry = state.inner().clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_stream(
            &chat_client.chat,
            &base_url,
            &api_key,
            &provider,
            &payload,
            &on_event,
            &token,
        )
        .await;
        if let Err(message) = result {
            let _ = on_event.send(ChatStreamEvent::Error { message });
        }
        registry.lock().remove(&task_id);
    });

    Ok(id)
}

/// Cancel an in-flight request started by `zen_chat_stream` (streams), the
/// one-shot `zen_chat` fallback, or a research tool call. The HTTP
/// connection is closed and any text accumulated so far is delivered as a
/// final `done` event. A cancel for an id that has not registered yet
/// leaves a PRE-CANCELLED tombstone so the late request stops immediately
/// instead of running to completion.
#[tauri::command]
fn zen_chat_stream_cancel(
    id: String,
    state: State<'_, StreamState>,
) -> Result<(), String> {
    state.cancel(&id);
    Ok(())
}

/// The request id + cancellation token for an OPTIONAL frontend-supplied
/// id. Returns `(None, None)` when the caller sent no id (older frontend /
/// tests), keeping the command usable without cancellation.
fn request_token(
    state: &StreamState,
    id: &Option<String>,
) -> (Option<String>, Option<CancellationToken>) {
    match id {
        Some(rid) => (Some(rid.clone()), Some(state.token_for(rid))),
        None => (None, None),
    }
}

/// Release a request's registry entry (consumed token or tombstone) after
/// the command finishes, so the registry does not grow without bound.
fn release_request(state: &StreamState, id: &Option<String>) {
    if let Some(rid) = id.as_deref() {
        state.lock().remove(rid);
    }
}

/// Search the web via DuckDuckGo's HTML endpoint and return the top ~5 results,
/// so the chat agent can research companies with current information. When
/// the frontend supplies an `id`, DNS, headers, the body read, and the
/// redirect chain are all cancellable (B17a).
#[tauri::command]
async fn zen_web_search(
    state: State<'_, StreamState>,
    id: Option<String>,
    query: String,
) -> Result<Vec<WebResult>, String> {
    let (request_id, token) = request_token(&state, &id);
    let result = run_web_search(&query, token.as_ref()).await;
    release_request(&state, &request_id);
    result
}

async fn run_web_search(
    query: &str,
    token: Option<&CancellationToken>,
) -> Result<Vec<WebResult>, String> {
    let url = reqwest::Url::parse_with_params(
        "https://html.duckduckgo.com/html/",
        &[("q", query)],
    )
    .map_err(|e| format!("Failed to build search URL: {e}"))?;

    // The search endpoint (and any redirect it takes) is validated like
    // every other research fetch.
    let response = fetch_public_validated(url, token).await?;

    if !response.status().is_success() {
        return Err(format!("Search endpoint returned HTTP {}", response.status()));
    }

    let html = race_cancel(token, response.text())
        .await?
        .map_err(|e| format!("Failed to read search results: {e}"))?;

    let document = scraper::Html::parse_document(&html);

    let mut results = Vec::new();
    for result in document.select(&DDG_RESULT_SELECTOR).take(5) {
        let mut title = String::new();
        let mut url = String::new();
        if let Some(a) = result.select(&DDG_TITLE_SELECTOR).next() {
            title = a.text().collect::<String>().trim().to_string();
            if let Some(href) = a.value().attr("href") {
                url = decode_duckduckgo_href(href);
            }
        }
        if url.is_empty() {
            continue;
        }
        let snippet = result
            .select(&DDG_SNIPPET_SELECTOR)
            .next()
            .map(|s| s.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        results.push(WebResult {
            title,
            url,
            snippet,
        });
    }

    Ok(results)
}

/// DuckDuckGo result links are redirect URLs (`//duckduckgo.com/l/?uddg=<real url>`);
/// extract the real target when present, otherwise return the link as-is.
fn decode_duckduckgo_href(href: &str) -> String {
    let full = if let Some(rest) = href.strip_prefix("//") {
        format!("https:{rest}")
    } else if let Some(rest) = href.strip_prefix('/') {
        format!("https://duckduckgo.com{rest}")
    } else {
        href.to_string()
    };

    match reqwest::Url::parse(&full) {
        Ok(parsed) => {
            for (key, value) in parsed.query_pairs() {
                if key == "uddg" {
                    return value.to_string();
                }
            }
            parsed.to_string()
        }
        Err(_) => href.to_string(),
    }
}

/// Recursively collect visible text from a node tree, skipping elements that
/// match `skip` (script, style, nav, etc.). Stops early — returning true —
/// once `budget` characters have been gathered: page content worth reading
/// sits at the top of the document, so walking the rest of a huge DOM only
/// wastes time on text that would be truncated anyway.
fn collect_text(
    node: NodeRef<'_, Node>,
    skip: &Selector,
    out: &mut Vec<String>,
    collected: &mut usize,
    budget: usize,
) -> bool {
    if *collected >= budget {
        return true;
    }
    if node.value().is_element() {
        if let Some(el) = ElementRef::wrap(node) {
            if skip.matches(&el) {
                return false;
            }
            for child in el.children() {
                if collect_text(child, skip, out, collected, budget) {
                    return true;
                }
            }
        }
        return false;
    }
    if let Node::Text(text) = node.value() {
        let t = text.text.trim();
        if !t.is_empty() {
            *collected += t.chars().count();
            out.push(t.to_string());
            if *collected >= budget {
                return true;
            }
        }
    }
    false
}

/// Fetch a web page and return its plain text (tags stripped, ~8000 chars max),
/// so the chat agent can read an actual company page. The URL — and every
/// redirect hop — is validated against the private-address block list and
/// connected only through verified (public) resolved addresses. When the
/// frontend supplies an `id`, DNS, headers, and the body read are all
/// cancellable (B17a).
#[tauri::command]
async fn zen_fetch_page(
    state: State<'_, StreamState>,
    id: Option<String>,
    url: String,
) -> Result<String, String> {
    let (request_id, token) = request_token(&state, &id);
    let result = run_fetch_page(&url, token.as_ref()).await;
    release_request(&state, &request_id);
    result
}

async fn run_fetch_page(
    url: &str,
    token: Option<&CancellationToken>,
) -> Result<String, String> {
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    let mut response = fetch_public_validated(parsed, token).await?;

    if !response.status().is_success() {
        return Err(format!("Page returned HTTP {}", response.status()));
    }

    // Read at most MAX_PAGE_BYTES before parsing. Huge pages would spend
    // seconds inside the HTML parser only for their text to be truncated
    // away. The whole loop races the token, so a Stop during the body read
    // terminates it.
    let read_body = async {
        let mut html_bytes: Vec<u8> = Vec::with_capacity(64 * 1024);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("Failed to read page: {e}"))?
        {
            if html_bytes.len() + chunk.len() >= MAX_PAGE_BYTES {
                let remaining = MAX_PAGE_BYTES - html_bytes.len();
                html_bytes.extend_from_slice(&chunk[..remaining]);
                break;
            }
            html_bytes.extend_from_slice(&chunk);
        }
        Ok::<Vec<u8>, String>(html_bytes)
    };
    let html_bytes = race_cancel(token, read_body).await??;
    let html = String::from_utf8_lossy(&html_bytes);

    let document = scraper::Html::parse_document(&html);

    // Stop collecting as soon as we hold more text than the output cap:
    // everything past that point would be truncated away regardless.
    let mut parts: Vec<String> = Vec::new();
    let mut collected = 0usize;
    if let Some(body) = document.select(&FETCH_BODY_SELECTOR).next() {
        for child in body.children() {
            if collect_text(
                child,
                &FETCH_SKIP_SELECTOR,
                &mut parts,
                &mut collected,
                FETCH_TEXT_BUDGET_CHARS,
            ) {
                break;
            }
        }
    }
    let text = parts
        .iter()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    Ok(text.chars().take(8000).collect())
}

/// A single Zen pricing entry scraped from https://opencode.ai/docs/zen.
#[derive(Serialize, Deserialize, Clone)]
pub struct ZenPricingEntry {
    id: String,
    /// Human-readable display name from the docs endpoints table ("Model"
    /// column), e.g. "claude-sonnet-4-5" -> "Claude Sonnet 4.5". Absent in
    /// older caches and when the endpoints table could not be parsed.
    #[serde(default)]
    name: Option<String>,
    input: Option<f64>,
    output: Option<f64>,
    is_free: bool,
}

/// Parse a pricing cell like "$0.30", "Free" or "-" into (price, is_free).
fn parse_zen_price(text: &str) -> (Option<f64>, bool) {
    let t = text.trim().to_lowercase();
    if t == "free" {
        return (None, true);
    }
    let cleaned = t.trim_start_matches('$').replace(',', "").replace(' ', "");
    match cleaned.parse::<f64>() {
        Ok(v) => (Some(v), false),
        Err(_) => (None, false),
    }
}

/// Fetch the OpenCode Zen pricing table from the docs page and return it as
/// model-id → price entries. Display names are slugified to model IDs
/// (lowercase, spaces to dashes); parenthetical price bands such as
/// "(≤ 200K tokens)" are dropped, keeping the first (base) row per model.
#[tauri::command]
async fn zen_fetch_zen_pricing(clients: State<'_, HttpClients>) -> Result<Vec<ZenPricingEntry>, String> {
    let response = clients
        .scrape
        .get("https://opencode.ai/docs/zen")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Pricing page returned HTTP {}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read pricing page: {e}"))?;

    let document = scraper::Html::parse_document(&html);

    let cell_text = |el: ElementRef| -> String {
        el.text().collect::<String>().trim().to_string()
    };

    // Table helper: returns the table whose first-row cells contain all the
    // given keywords (case-insensitive).
    let find_table = |keywords: &[&str]| -> Option<ElementRef> {
        document.select(&ZEN_TABLE_SELECTOR).find(|table| {
            let header: String = table
                .select(&ZEN_CELL_SELECTOR)
                .take(6)
                .map(cell_text)
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            keywords.iter().all(|k| header.contains(k))
        })
    };

    // The endpoints table maps display names to official model IDs
    // (e.g. "Claude Sonnet 4.5" -> "claude-sonnet-4-5"). Both directions are
    // built in this single ordered pass so that the first display name seen
    // for an id always wins, independent of HashMap iteration order.
    let mut name_to_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Some(endpoints) = find_table(&["model", "id"]) {
        for row in endpoints.select(&ZEN_ROW_SELECTOR) {
            let cells: Vec<String> =
                row.select(&ZEN_CELL_SELECTOR).map(cell_text).collect();
            if cells.len() >= 2 && !cells[0].is_empty() && !cells[1].is_empty() {
                id_to_name
                    .entry(cells[1].clone())
                    .or_insert_with(|| cells[0].clone());
                name_to_id.insert(cells[0].clone(), cells[1].clone());
            }
        }
    }

    let table = find_table(&["input", "output"])
        .ok_or_else(|| "Could not find the pricing table on the Zen docs page.".to_string())?;

    let mut entries: Vec<ZenPricingEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in table.select(&ZEN_ROW_SELECTOR) {
        let cells: Vec<String> =
            row.select(&ZEN_CELL_SELECTOR).map(cell_text).collect();
        if cells.len() < 3 {
            continue;
        }
        // Strip price-band parentheticals, e.g. "Claude Sonnet 4.5 (≤ 200K tokens)".
        let name = cells[0].split('(').next().unwrap_or("").trim();
        let id = name_to_id
            .get(name)
            .cloned()
            .unwrap_or_else(|| name.to_lowercase().replace(' ', "-"));
        if id.is_empty() || id == "model" || seen.contains(&id) {
            continue;
        }
        let (input, input_free) = parse_zen_price(&cells[1]);
        let (output, output_free) = parse_zen_price(&cells[2]);
        seen.insert(id.clone());
        let model_name = id_to_name.get(&id).cloned();
        entries.push(ZenPricingEntry {
            id,
            name: model_name,
            input,
            output,
            is_free: input_free || output_free,
        });
    }

    if entries.is_empty() {
        return Err("No pricing rows found on the Zen docs page.".to_string());
    }

    Ok(entries)
}

/// Exclusive file creation for bulk export: the file is created only when
/// it does not already exist (create_new), so a concurrent writer or an
/// existing export can never be silently overwritten. Used by the frontend
/// bulk exporter, which retries with a numbered name only on genuine
/// name collisions.
#[tauri::command]
fn export_write_exclusive(path: String, contents: String) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                format!("A file named '{}' already exists.", path)
            }
            _ => format!("Could not create '{}': {e}", path),
        })?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("Could not write '{}': {e}", path))?;
    Ok(())
}

/// Get a secret (e.g. the API key) from the OS keychain.
/// Returns `null` when no entry exists. Errors if the keychain is unusable,
/// so the frontend can fall back to storing secrets in config.json.
#[tauri::command]
fn keyring_get(key: String) -> Result<Option<String>, String> {
    let entry =
        Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| format!("Keychain unavailable: {e}"))?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

/// Store a secret in the OS keychain (overwrites any existing value).
#[tauri::command]
fn keyring_set(key: String, value: String) -> Result<(), String> {
    let entry =
        Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| format!("Keychain unavailable: {e}"))?;
    entry.set_password(&value).map_err(|e| format!("Keychain error: {e}"))
}

/// Delete a secret from the OS keychain. Missing entries are not an error.
#[tauri::command]
fn keyring_delete(key: String) -> Result<(), String> {
    let entry =
        Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| format!("Keychain unavailable: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Keychain error: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Shared across every command for connection/TLS/DNS reuse.
    let http_clients = HttpClients::new().expect("failed to initialise HTTP clients");
    tauri::Builder::default()
        .manage(http_clients)
        .manage(StreamState::default())
        .manage(repository::Db::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            zen_list_models,
            zen_chat,
            zen_chat_stream,
            zen_chat_stream_cancel,
            zen_web_search,
            zen_fetch_page,
            zen_fetch_zen_pricing,
            keyring_get,
            keyring_set,
            keyring_delete,
            repository::db_init,
            repository::db_texts_list,
            repository::db_text_create,
            repository::db_text_save,
            repository::db_text_content,
            repository::db_text_versions,
            repository::db_text_restore,
            repository::db_text_snapshot,
            repository::db_sources_list,
            repository::db_source_get,
            repository::db_source_create,
            repository::db_source_save,
            repository::db_source_delete,
            repository::db_proposals_list,
            repository::db_proposal_create,
            repository::db_proposal_set_status,
            repository::db_text_delete,
            repository::db_projects_list,
            repository::db_project_create,
            repository::db_project_save,
            repository::db_project_brief,
            repository::db_project_delete,
            repository::db_threads_list,
            repository::db_thread_create,
            repository::db_thread_get,
            repository::db_thread_save,
            repository::db_thread_append_message,
            repository::db_thread_replace_message,
            repository::db_thread_rename,
            repository::db_text_set_state,
            repository::db_thread_set_state,
            repository::db_thread_delete,
            repository::db_export,
            repository::db_restore,
            repository::db_prefs_get,
            repository::db_prefs_get_all,
            repository::db_prefs_set,
            repository::db_search,
            repository::db_import_legacy,
            repository::db_import_legacy_at,
            export_write_exclusive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_endpoint_normalises_base_urls() {
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com", "/models"),
            "https://api.anthropic.com/v1/models"
        );
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com/", "/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        // A base that already ends in /v1 must not get a double prefix.
        assert_eq!(
            anthropic_endpoint("https://proxy.example.com/v1/", "/models"),
            "https://proxy.example.com/v1/models"
        );
    }

    #[test]
    fn decode_duckduckgo_href_extracts_real_target() {
        assert_eq!(
            decode_duckduckgo_href("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fjobs"),
            "https://example.com/jobs"
        );
        assert_eq!(
            decode_duckduckgo_href("/l/?uddg=https%3A%2F%2Fexample.org"),
            "https://example.org"
        );
        // Non-redirect links pass through untouched; reqwest::Url
        // normalises special-scheme URLs to gain a trailing slash.
        assert_eq!(decode_duckduckgo_href("https://example.com"), "https://example.com/");
        assert_eq!(decode_duckduckgo_href("not a url"), "not a url");
    }

    // ── Research network controls (R9) ──

    #[test]
    fn research_urls_block_private_and_local_addresses() {
        let blocked = [
            "http://localhost:8080/x",
            "http://127.0.0.1/admin",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.10/router",
            "http://10.0.0.5/x",
            "http://172.16.0.1/x",
            "http://metadata.google.internal/",
            "http://nas.home.local/",
            "file:///etc/passwd",
            "ftp://example.com/x",
        ];
        for url in blocked {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(is_public_url(&parsed).is_err(), "must block {url}");
        }
        let allowed = [
            "https://example.com/article",
            "http://plainexample.org/x", // host merely CONTAINS a keyword
            "https://docs.rs/reqwest/latest/reqwest/",
        ];
        for url in allowed {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(is_public_url(&parsed).is_ok(), "must allow {url}");
        }
    }

    #[test]
    fn resolved_addresses_are_verified_before_connecting() {
        use std::net::{IpAddr, SocketAddr};
        let sock = |ip: &str| SocketAddr::new(ip.parse::<IpAddr>().unwrap(), 443);
        // A clean public resolution passes and pins to the first address.
        let clean = vec![sock("93.184.216.34"), sock("93.184.216.35")];
        let pinned = verify_resolved_addrs(clean).expect("public addrs must pass");
        assert_eq!(pinned.ip().to_string(), "93.184.216.34");
        // DNS REBINDING: a public hostname resolving to a private address
        // (even mixed with public ones) is refused before any connection.
        let rebinding = vec![
            sock("93.184.216.34"),
            sock("10.0.0.5"),
        ];
        let err = verify_resolved_addrs(rebinding).expect_err("rebinding must be refused");
        assert!(err.contains("local/private"));
        // A resolution to ONLY private addresses is refused.
        let private_only = vec![sock("192.168.1.1")];
        assert!(verify_resolved_addrs(private_only).is_err());
        // Empty resolutions are refused (never connect to a guess).
        assert!(verify_resolved_addrs(Vec::new()).is_err());
        // IPv6 private ranges are caught too.
        let v6 = vec![sock("fc00::1")];
        assert!(verify_resolved_addrs(v6).is_err());
    }

    #[tokio::test]
    async fn ip_literal_hosts_are_verified_directly_without_lookup() {
        // Public literal: allowed.
        assert!(resolve_verified_host("93.184.216.34", 443, None).await.is_ok());
        // Private literals: blocked without any DNS involvement.
        assert!(resolve_verified_host("127.0.0.1", 80, None).await.is_err());
        assert!(resolve_verified_host("169.254.169.254", 80, None).await.is_err());
        // "localhost" resolves to loopback — the rebinding check refuses it.
        assert!(resolve_verified_host("localhost", 80, None).await.is_err());
    }

    #[test]
    fn embedded_ipv4_ipv6_addresses_follow_the_ipv4_rules() {
        let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
        for blocked in [
            // IPv4-mapped (::ffff:a.b.c.d)
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "::ffff:169.254.169.254",
            "::ffff:192.168.1.1",
            // IPv4-compatible (::/96)
            "::7f00:1",
            "::a00:1",
            // 6to4 (2002::/16): the embedded IPv4 is segments 1-2.
            "2002:7f00:1::",
            "2002:a00:1::",
            // Teredo (2001:0::/32): the server (segments 2-3) and the
            // obfuscated client (segments 4-5, XOR 0xffff) carry IPv4.
            "2001:0:7f00:1::",
            "2001:0:5db8:d822:80ff:fffe::",
            // NAT64 (64:ff9b::/96): the embedded IPv4 is the last 32 bits.
            "64:ff9b::a00:1",
            "64:ff9b::7f00:1",
        ] {
            assert!(is_blocked_ip(ip(blocked)), "must block {blocked}");
        }
        // Embedded forms carrying a PUBLIC IPv4 are not blocked, and
        // neither is a real public IPv6 address.
        assert!(!is_blocked_ip(ip("::ffff:93.184.216.34")));
        assert!(!is_blocked_ip(ip("2002:5db8:d822::1")));
        assert!(!is_blocked_ip(ip("64:ff9b::5db8:d822")));
        assert!(!is_blocked_ip(ip("2606:4700:4700::1111")));
    }

    #[tokio::test]
    async fn bracketed_ipv6_literals_are_classified_and_built_typed() {
        use std::net::{IpAddr, SocketAddr};
        // Bracketed host strings (what reqwest::Url::host_str returns) must
        // still reach the IP block list.
        for url in [
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(is_public_url(&parsed).is_err(), "must block {url}");
        }
        // A public IPv6 literal resolves to a TYPED socket address (the old
        // string round-trip rejected every IPv6 literal as "Invalid
        // address").
        let resolved = resolve_verified_host("2606:4700:4700::1111", 443, None)
            .await
            .expect("public IPv6 literal must resolve");
        assert_eq!(
            resolved,
            SocketAddr::new("2606:4700:4700::1111".parse::<IpAddr>().unwrap(), 443)
        );
        // The bracketed form resolves to the same address.
        let bracketed = resolve_verified_host("[2606:4700:4700::1111]", 443, None)
            .await
            .expect("bracketed public IPv6 literal must resolve");
        assert_eq!(bracketed, resolved);
        // Private/bracketed literals are refused.
        assert!(resolve_verified_host("::1", 443, None).await.is_err());
        assert!(resolve_verified_host("[::ffff:10.0.0.5]", 443, None).await.is_err());
    }

    #[tokio::test]
    async fn a_cancelled_token_stops_dns_and_fetch_before_any_network() {
        let token = CancellationToken::new();
        token.cancel();
        let err = resolve_verified_host("example.com", 443, Some(&token))
            .await
            .expect_err("cancelled DNS must fail");
        assert!(err.contains("cancelled"), "{err}");
        let url = reqwest::Url::parse("https://example.com/").unwrap();
        let err = fetch_public_validated(url, Some(&token))
            .await
            .expect_err("cancelled fetch must fail");
        assert!(err.contains("cancelled"), "{err}");
    }

    #[tokio::test]
    async fn race_cancel_aborts_a_pending_future_and_is_transparent_without_a_token() {
        let token = CancellationToken::new();
        let race = race_cancel(Some(&token), std::future::pending::<u32>());
        token.cancel();
        let err = race.await.expect_err("a cancelled race must fail");
        assert!(err.contains("cancelled"), "{err}");
        // No token: the future is awaited normally.
        assert_eq!(race_cancel(None, async { 7 }).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn a_cancelled_one_shot_chat_never_sends() {
        let client = reqwest::Client::new();
        let token = CancellationToken::new();
        token.cancel();
        let err = run_chat(
            &client,
            "http://127.0.0.1:1/v1",
            "key",
            "zen",
            &serde_json::json!({"model": "x", "messages": []}),
            Some(&token),
        )
        .await
        .expect_err("a pre-cancelled one-shot chat must fail");
        assert!(err.contains("cancelled"), "{err}");
    }

    #[test]
    fn cancel_before_registration_leaves_a_pre_cancelled_token() {
        let state = StreamState::default();
        // A Stop that races ahead of its request: tombstone.
        state.cancel("r1");
        assert!(state.token_for("r1").is_cancelled());
        // A normal request gets a live token, and cancelling it works.
        let live = state.token_for("r2");
        assert!(!live.is_cancelled());
        state.cancel("r2");
        assert!(live.is_cancelled());
        // Released entries do not linger.
        state.lock().remove("r1");
        state.lock().remove("r2");
        assert!(!state.lock().contains_key("r1"));
        assert!(!state.lock().contains_key("r2"));
    }

    #[test]
    fn cancel_tombstones_are_bounded_and_expire() {
        let state = StreamState::default();
        // Many cancels for ids that never register: the registry stays
        // bounded instead of accumulating tombstones forever.
        for i in 0..(MAX_CANCEL_TOMBSTONES + 40) {
            state.cancel(&format!("ghost-{i}"));
        }
        assert!(state.tombstone_count() <= MAX_CANCEL_TOMBSTONES);

        // The pre-registration race protection still holds for a RECENT
        // cancel: the late request adopts the cancelled token.
        let latest = format!("ghost-{}", MAX_CANCEL_TOMBSTONES + 39);
        assert!(state.token_for(&latest).is_cancelled());
        // A fresh id gets a live token.
        assert!(!state.token_for("real-request").is_cancelled());

        // Expiry: a tombstone older than the TTL is dropped on the next
        // cancel; a recent one survives.
        state.cancel("stale");
        {
            let mut map = state.lock();
            let slot = map.get_mut("stale").unwrap();
            slot.tombstone_since = Some(
                Instant::now()
                    - CANCEL_TOMBSTONE_TTL
                    - Duration::from_secs(1),
            );
        }
        state.cancel("fresh-ghost");
        let map = state.lock();
        assert!(!map.contains_key("stale"));
        assert!(map.contains_key("fresh-ghost"));
    }

    #[test]
    fn eof_without_protocol_completion_marks_truncation() {
        // OpenAI: the stream ended with content but no finish_reason/[DONE].
        let mut acc = StreamAccumulator::new("openai");
        acc.feed(r#"{"choices":[{"delta":{"content":"partial"}}]}"#).unwrap();
        assert!(!acc.is_finished());
        assert!(!acc.is_empty());
        let data = acc.finish();
        assert_eq!(data.pointer("/choices/0/truncated"), Some(&serde_json::json!(true)));
        assert_eq!(data.pointer("/choices/0/finish_reason"), Some(&serde_json::Value::Null));
        // Finished streams are not truncated.
        let mut done = StreamAccumulator::new("openai");
        done.feed(r#"{"choices":[{"delta":{"content":"full"},"finish_reason":null}]}"#).unwrap();
        done.feed(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap();
        assert!(done.is_finished());
        assert_eq!(done.finish().pointer("/choices/0/truncated"), Some(&serde_json::json!(false)));
        assert_eq!(
            done.finish().pointer("/choices/0/finish_reason"),
            Some(&serde_json::json!("stop"))
        );
        // Anthropic: no message_stop → truncated; usage preserved.
        let mut anthropic = StreamAccumulator::new("anthropic");
        anthropic.feed(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"part"}}"#).unwrap();
        anthropic.feed(r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":9}}"#).unwrap();
        assert!(!anthropic.is_finished());
        let data = anthropic.finish();
        assert_eq!(data.pointer("/truncated"), Some(&serde_json::json!(true)));
        assert_eq!(data.pointer("/stop_reason"), Some(&serde_json::json!("max_tokens")));
        assert_eq!(data.pointer("/usage/output_tokens"), Some(&serde_json::json!(9)));
    }

    #[test]
    fn eof_with_no_content_at_all_is_reported_empty() {
        let mut acc = StreamAccumulator::new("openai");
        assert!(acc.is_empty());
        acc.feed(r#"{"choices":[{"delta":{"content":"text"}}]}"#).unwrap();
        assert!(!acc.is_empty());
    }

    #[test]
    fn openai_usage_arriving_after_finish_is_captured() {
        let mut acc = StreamAccumulator::new("openai");
        acc.feed(r#"{"choices":[{"delta":{"content":"answer"}}]}"#).unwrap();
        acc.feed(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap();
        assert!(acc.is_finished());
        // The finish chunk alone is not everything: usage + [DONE] follow.
        assert!(acc.wants_drain());
        acc.feed(r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}"#)
            .unwrap();
        assert!(!acc.wants_drain());
        acc.feed("[DONE]").unwrap();
        let data = acc.finish();
        assert_eq!(
            data.pointer("/usage/total_tokens"),
            Some(&serde_json::json!(14))
        );
        assert_eq!(
            data.pointer("/choices/0/finish_reason"),
            Some(&serde_json::json!("stop"))
        );
    }

    #[test]
    fn drain_budget_is_bounded_when_usage_never_arrives() {
        let mut acc = StreamAccumulator::new("openai");
        acc.feed(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap();
        assert!(acc.wants_drain());
        acc.feed(r#"{"choices":[{"delta":{"content":"late"}}]}"#).unwrap();
        assert!(acc.wants_drain());
        acc.feed(r#"{"choices":[{"delta":{"content":"later"}}]}"#).unwrap();
        assert!(!acc.wants_drain());
        // A provider that never sends usage/[DONE] still completes.
        let data = acc.finish();
        assert_eq!(
            data.pointer("/choices/0/truncated"),
            Some(&serde_json::json!(false))
        );
    }

    #[test]
    fn anthropic_usage_fields_merge_across_events() {
        let mut acc = StreamAccumulator::new("anthropic");
        acc.feed(
            r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}"#,
        )
        .unwrap();
        acc.feed(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}"#)
            .unwrap();
        acc.feed(
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}"#,
        )
        .unwrap();
        acc.feed(r#"{"type":"message_stop"}"#).unwrap();
        let data = acc.finish();
        assert_eq!(
            data.pointer("/usage/input_tokens"),
            Some(&serde_json::json!(12))
        );
        assert_eq!(
            data.pointer("/usage/output_tokens"),
            Some(&serde_json::json!(7))
        );
    }

    #[test]
    fn provider_error_events_end_the_stream_with_an_error() {
        // OpenAI-style error payload.
        let mut acc = StreamAccumulator::new("openai");
        let err = acc
            .feed(r#"{"error":{"message":"upstream overloaded","type":"server_error"}}"#)
            .unwrap_err();
        assert!(err.contains("upstream overloaded"));
        // Anthropic error event after partial text: the error is explicit
        // and the accumulated text stays available for the error path.
        let mut anthropic = StreamAccumulator::new("anthropic");
        anthropic
            .feed(r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}"#)
            .unwrap();
        let err = anthropic
            .feed(r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#)
            .unwrap_err();
        assert!(err.contains("Overloaded"));
        assert_eq!(
            anthropic.finish().pointer("/content/0/text"),
            Some(&serde_json::json!("partial"))
        );
    }

    #[test]
    fn parse_zen_price_handles_common_cells() {
        assert_eq!(parse_zen_price("Free"), (None, true));
        assert_eq!(parse_zen_price("$0.30"), (Some(0.30), false));
        assert_eq!(parse_zen_price("$1,234.50"), (Some(1234.50), false));
        assert_eq!(parse_zen_price("-"), (None, false));
        assert_eq!(parse_zen_price(""), (None, false));
    }

    #[test]
    fn quota_detection_matches_known_bodies() {
        let limit = reqwest::StatusCode::TOO_MANY_REQUESTS;
        let other = reqwest::StatusCode::BAD_REQUEST;
        assert!(is_quota_error(limit, "You have exceeded your free usage limit"));
        assert!(is_quota_error(limit, "QUOTA_EXHAUSTED"));
        assert!(!is_quota_error(limit, "Slow down and retry shortly"));
        assert!(!is_quota_error(other, "free usage limit exceeded"));
    }

    #[test]
    fn backoff_schedule_is_exponential_then_capped() {
        assert_eq!(backoff_secs(0), 1);
        assert_eq!(backoff_secs(1), 2);
        assert_eq!(backoff_secs(2), 4);
        assert_eq!(backoff_secs(3), MAX_RETRY_AFTER_SECS);
        assert_eq!(backoff_secs(99), MAX_RETRY_AFTER_SECS);
    }

    #[test]
    fn openai_stream_assembles_content_and_tool_calls() {
        let mut acc = StreamAccumulator::new("openai");

        let delta = acc
            .feed(r#"{"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#)
            .unwrap();
        assert_eq!(delta.as_deref(), Some("Hel"));

        assert_eq!(
            acc.feed(r#"{"choices":[{"delta":{"content":"lo"}}]}"#).unwrap(),
            Some("lo".to_string())
        );

        acc.feed(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"zen_web_search","arguments":"{\"q\":"}}]}}]}"#,
        )
        .unwrap();
        acc.feed(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"rust\"}"}}]}}]}"#,
        )
        .unwrap();

        // finish_reason marks completion but carries no text.
        assert_eq!(
            acc.feed(r#"{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#)
                .unwrap(),
            None
        );
        assert!(acc.is_finished());

        acc.feed("[DONE]").unwrap();

        let data = acc.finish();
        assert_eq!(data["choices"][0]["message"]["content"], "Hello");
        let calls = data["choices"][0]["message"]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["type"], "function");
        assert_eq!(calls[0]["function"]["name"], "zen_web_search");
        assert_eq!(calls[0]["function"]["arguments"], r#"{"q":"rust"}"#);
    }

    #[test]
    fn openai_stream_ignores_absurd_tool_indices() {
        let mut acc = StreamAccumulator::new("openai");
        acc.feed(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1000000,"id":"x","function":{"name":"n","arguments":""}}]}}]}"#,
        )
        .unwrap();
        assert!(acc.openai_tool_calls.is_empty());
    }

    #[test]
    fn openai_stream_without_tools_has_null_tool_calls() {
        let mut acc = StreamAccumulator::new("openai");
        acc.feed(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).unwrap();
        acc.feed(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#).unwrap();
        let data = acc.finish();
        assert!(data["choices"][0]["message"]["tool_calls"].is_null());
    }

    #[test]
    fn anthropic_stream_assembles_blocks_and_tool_input() {
        let mut acc = StreamAccumulator::new("anthropic");

        acc.feed(r#"{"type":"content_block_start","index":0,"content_block":{"type":"text"}}"#)
            .unwrap();
        let delta = acc
            .feed(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#)
            .unwrap();
        assert_eq!(delta.as_deref(), Some("Hi"));

        acc.feed(
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"zen_fetch_page","input":{}}}"#,
        )
        .unwrap();
        // input_json_delta belongs to the tool block and emits no text delta.
        assert_eq!(
            acc.feed(
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"url\":\"https://x.dev\"}"}}"#,
            )
            .unwrap(),
            None
        );

        acc.feed(r#"{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null}}"#)
            .unwrap();
        acc.feed(r#"{"type":"message_stop"}"#).unwrap();
        assert!(acc.is_finished());

        let data = acc.finish();
        assert_eq!(data["stop_reason"], "tool_use");
        let blocks = data["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], serde_json::json!({"type": "text", "text": "Hi"}));
        assert_eq!(blocks[1]["type"], "tool_use");
        assert_eq!(blocks[1]["id"], "toolu_1");
        assert_eq!(blocks[1]["name"], "zen_fetch_page");
        assert_eq!(blocks[1]["input"]["url"], "https://x.dev");
    }

    #[test]
    fn malformed_sse_payload_is_an_error_not_a_panic() {
        let mut acc = StreamAccumulator::new("openai");
        assert!(acc.feed("this is not json").is_err());
    }
}
