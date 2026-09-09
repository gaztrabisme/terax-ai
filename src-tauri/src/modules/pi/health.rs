use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Outcome of one health probe. A failed probe is a normal value (ok: false
/// plus the error text), never a rejected invoke, so the first-run panel can
/// render it as a red row instead of handling a rejected promise. `url` is
/// the exact URL the GET went to, so a check row can only ever name the
/// request actually made, never a different one.
#[derive(Debug, Serialize)]
pub struct HealthResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub ms: u64,
    pub error: Option<String>,
    pub url: String,
}

/// Hard ceiling for one probe: a down endpoint must not hang the panel.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(4);

/// http and https only; anything else is a soft error for the panel.
fn validate_health_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        scheme => Err(format!("scheme not allowed: {scheme}")),
    }
}

fn failed(ms: u64, error: String, url: String) -> HealthResult {
    HealthResult {
        ok: false,
        status: None,
        ms,
        error: Some(error),
        url,
    }
}

/// The models-list URL for an OpenAI-style endpoint base: `<base>/models`.
/// That is the request the inference path itself answers: oMLX at
/// `http://127.0.0.1:8000/v1` and the llama-server proxies serve
/// `GET /v1/models` with the bearer key, while the bare base answers 404 and
/// the server-root status endpoints sit outside the authenticated API.
/// Whitespace and trailing slashes trim; any `__BPPC_HOST__` placeholder is
/// the caller's to fill before calling.
pub(crate) fn models_url(base: &str) -> String {
    format!("{}/models", base.trim().trim_end_matches('/'))
}

/// The bearer key inference sends for one provider: the rendered models.json
/// in the runtime agent dir is what pi reads, so its
/// `providers.<provider>.apiKey` is exactly the credential a chat request
/// carries. An unresolved `__...__` placeholder, a blank value or an
/// unreadable file means no header: the probe then reports the endpoint's
/// own answer (typically 401), never a guessed key. The key only feeds the
/// request header; it never enters HealthResult or any log.
fn bearer_key(agent_dir: Option<&str>, provider: Option<&str>) -> Option<String> {
    let dir = agent_dir.map(str::trim).filter(|s| !s.is_empty())?;
    let provider = provider.map(str::trim).filter(|s| !s.is_empty())?;
    let raw = std::fs::read_to_string(Path::new(dir).join("models.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let key = parsed
        .get("providers")?
        .get(provider)?
        .get("apiKey")?
        .as_str()?
        .trim();
    let placeholder = key.len() > 4 && key.starts_with("__") && key.ends_with("__");
    (!key.is_empty() && !placeholder).then(|| key.to_string())
}

/// The probe GET, with the bearer header inference would carry. Split from
/// pi_health so the header logic is testable without a server.
fn probe_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    key: Option<&str>,
) -> reqwest::Result<reqwest::Request> {
    let mut request = client.get(url);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    request.build()
}

/// One GET for the Pi first-run panel: `<base>/models` on the endpoint base
/// the caller passes, with the rendered models.json bearer key for
/// `provider` when `agent_dir` names the runtime agent dir, so the probe
/// goes through the same base URL and auth the inference path uses. Meant
/// for local endpoints, but any http(s) base goes. The result echoes the
/// exact URL and never the key.
#[tauri::command]
pub async fn pi_health(
    url: String,
    agent_dir: Option<String>,
    provider: Option<String>,
) -> HealthResult {
    let requested = models_url(&url);
    let parsed = match validate_health_url(&requested) {
        Ok(parsed) => parsed,
        Err(e) => return failed(0, e, requested),
    };
    let started = Instant::now();
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(e) => return failed(0, e.to_string(), parsed.to_string()),
    };
    let key = bearer_key(agent_dir.as_deref(), provider.as_deref());
    let request = match probe_request(&client, parsed.clone(), key.as_deref()) {
        Ok(request) => request,
        Err(e) => return failed(0, e.to_string(), parsed.to_string()),
    };
    let elapsed = || started.elapsed().as_millis() as u64;
    match client.execute(request).await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            HealthResult {
                ok: resp.status().is_success(),
                status: Some(status),
                ms: elapsed(),
                error: None,
                url: parsed.to_string(),
            }
        }
        Err(e) => failed(elapsed(), e.to_string(), parsed.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_health_url("http://127.0.0.1:8000/v1/models").is_ok());
        assert!(validate_health_url("https://example.com/v1/models").is_ok());
    }

    #[test]
    fn rejects_other_schemes_and_garbage() {
        assert!(validate_health_url("file:///etc/passwd").is_err());
        assert!(validate_health_url("ftp://127.0.0.1:8000").is_err());
        assert!(validate_health_url("not a url").is_err());
        assert!(validate_health_url("").is_err());
    }

    #[test]
    fn models_url_appends_models_to_a_v1_base() {
        assert_eq!(
            models_url("http://127.0.0.1:8000/v1"),
            "http://127.0.0.1:8000/v1/models"
        );
    }

    #[test]
    fn models_url_keeps_a_base_without_v1() {
        assert_eq!(
            models_url("http://127.0.0.1:8080"),
            "http://127.0.0.1:8080/models"
        );
    }

    #[test]
    fn models_url_trims_whitespace_and_trailing_slashes() {
        assert_eq!(
            models_url("  http://127.0.0.1:8000/v1/  "),
            "http://127.0.0.1:8000/v1/models"
        );
        assert_eq!(
            models_url("http://127.0.0.1:8080//"),
            "http://127.0.0.1:8080/models"
        );
    }

    /// Writes the rendered models.json a session would run from.
    fn write_models_json(dir: &Path, body: &str) {
        std::fs::write(dir.join("models.json"), body).expect("write models.json");
    }

    #[test]
    fn bearer_key_reads_the_rendered_models_json_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_models_json(
            dir.path(),
            r#"{"providers":{"omlx":{"baseUrl":"http://127.0.0.1:8000/v1","apiKey":"sk-omlx"},"bppc":{"apiKey":"local"},"fixture":{"apiKey":42}}}"#,
        );
        let dir_str = dir.path().to_str().expect("utf8");
        assert_eq!(
            bearer_key(Some(dir_str), Some("omlx")).as_deref(),
            Some("sk-omlx")
        );
        assert_eq!(
            bearer_key(Some(dir_str), Some("bppc")).as_deref(),
            Some("local")
        );
        // Surrounding whitespace trims; a wrong-typed apiKey is no key.
        assert_eq!(bearer_key(Some(dir_str), Some("fixture")), None);
    }

    #[test]
    fn bearer_key_rejects_placeholders_blank_and_missing_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_models_json(
            dir.path(),
            r#"{"providers":{"omlx":{"apiKey":"__OMLX_KEY__"},"blank":{"apiKey":"  "},"openrouter":{"apiKey":"__OPENROUTER_KEY__"}}}"#,
        );
        let dir_str = dir.path().to_str().expect("utf8");
        // An unresolved render placeholder is not a credential: the probe
        // must go out without a header and report the endpoint's own 401.
        assert_eq!(bearer_key(Some(dir_str), Some("omlx")), None);
        assert_eq!(bearer_key(Some(dir_str), Some("openrouter")), None);
        assert_eq!(bearer_key(Some(dir_str), Some("blank")), None);
        assert_eq!(bearer_key(Some(dir_str), Some("missing")), None);
    }

    #[test]
    fn bearer_key_needs_a_dir_and_provider_and_a_readable_file() {
        assert_eq!(bearer_key(Some(""), Some("omlx")), None);
        assert_eq!(bearer_key(Some("  "), Some("omlx")), None);
        assert_eq!(bearer_key(Some("/agents/runtime"), Some("")), None);
        assert_eq!(bearer_key(Some("/agents/runtime"), None), None);
        assert_eq!(bearer_key(None, Some("omlx")), None);
        // A dir without models.json, and one whose file is not JSON.
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            bearer_key(Some(empty.path().to_str().expect("utf8")), Some("omlx")),
            None
        );
        let junk = tempfile::tempdir().expect("tempdir");
        write_models_json(junk.path(), "not json");
        assert_eq!(
            bearer_key(Some(junk.path().to_str().expect("utf8")), Some("omlx")),
            None
        );
    }

    #[test]
    fn probe_request_carries_the_bearer_header_only_with_a_key() {
        let client = reqwest::Client::new();
        let url = reqwest::Url::parse("http://127.0.0.1:8000/v1/models").expect("url");
        let with_key =
            probe_request(&client, url.clone(), Some("sk-omlx")).expect("request");
        assert_eq!(
            with_key
                .headers()
                .get(reqwest::header::AUTHORIZATION)
                .map(|v| v.to_str().expect("ascii")),
            Some("Bearer sk-omlx")
        );
        let without_key = probe_request(&client, url, None).expect("request");
        assert!(without_key
            .headers()
            .get(reqwest::header::AUTHORIZATION)
            .is_none());
    }
}
