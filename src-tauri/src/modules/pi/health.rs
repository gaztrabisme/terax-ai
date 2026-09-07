use std::time::{Duration, Instant};

use serde::Serialize;

/// Outcome of one health probe. A failed probe is a normal value (ok: false
/// plus the error text), never a rejected invoke, so the first-run panel can
/// render it as a red row instead of handling a rejected promise.
#[derive(Debug, Serialize)]
pub struct HealthResult {
    pub ok: bool,
    pub status: Option<u16>,
    pub ms: u64,
    pub error: Option<String>,
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

fn failed(ms: u64, error: String) -> HealthResult {
    HealthResult {
        ok: false,
        status: None,
        ms,
        error: Some(error),
    }
}

/// One GET for the Pi first-run panel: bppc `<base>/health`, oMLX
/// `<base>/api/status`. Meant for local endpoints, but any http(s) URL goes.
#[tauri::command]
pub async fn pi_health(url: String) -> HealthResult {
    let parsed = match validate_health_url(url.trim()) {
        Ok(parsed) => parsed,
        Err(e) => return failed(0, e),
    };
    let started = Instant::now();
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(e) => return failed(0, e.to_string()),
    };
    let elapsed = || started.elapsed().as_millis() as u64;
    match client.get(parsed).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            HealthResult {
                ok: resp.status().is_success(),
                status: Some(status),
                ms: elapsed(),
                error: None,
            }
        }
        Err(e) => failed(elapsed(), e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(validate_health_url("http://127.0.0.1:8000/api/status").is_ok());
        assert!(validate_health_url("https://example.com/health").is_ok());
    }

    #[test]
    fn rejects_other_schemes_and_garbage() {
        assert!(validate_health_url("file:///etc/passwd").is_err());
        assert!(validate_health_url("ftp://127.0.0.1:8000").is_err());
        assert!(validate_health_url("not a url").is_err());
        assert!(validate_health_url("").is_err());
    }
}
