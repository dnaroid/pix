//! OpenRouter account balance and key spend for the Usage panel.
//! The API key never leaves this module and is never logged.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenRouterBudget {
    limit_usd: f64,
    remaining_usd: f64,
    reset_interval: Option<String>,
    resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenRouterUsage {
    /// Account balance (`total_credits - total_usage`); absent when `/credits` is unavailable.
    balance: Option<f64>,
    total_credits: Option<f64>,
    usage_daily: Option<f64>,
    usage_weekly: Option<f64>,
    usage_monthly: Option<f64>,
    usage_total: Option<f64>,
    byok_usage_monthly: Option<f64>,
    key_limit: Option<f64>,
    key_limit_remaining: Option<f64>,
    key_limit_reset: Option<String>,
    effective_budget: Option<OpenRouterBudget>,
    is_free_tier: Option<bool>,
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.chars().take(64).collect())
}

fn parse_usage(key: Option<&Value>, credits: Option<&Value>) -> Option<OpenRouterUsage> {
    if key.is_none() && credits.is_none() {
        return None;
    }
    let empty = Value::Null;
    let key = key.unwrap_or(&empty);
    let credits = credits.unwrap_or(&empty);
    let total_credits = number(credits, "total_credits");
    let balance = total_credits
        .zip(number(credits, "total_usage"))
        .map(|(total, used)| total - used);
    let effective_budget = key.get("effective_budget").and_then(|budget| {
        Some(OpenRouterBudget {
            limit_usd: number(budget, "limit_usd")?,
            remaining_usd: number(budget, "remaining_usd")?,
            reset_interval: text(budget, "reset_interval"),
            resets_at: text(budget, "resets_at"),
        })
    });
    Some(OpenRouterUsage {
        balance,
        total_credits,
        usage_daily: number(key, "usage_daily"),
        usage_weekly: number(key, "usage_weekly"),
        usage_monthly: number(key, "usage_monthly"),
        usage_total: number(key, "usage"),
        byok_usage_monthly: number(key, "byok_usage_monthly"),
        key_limit: number(key, "limit"),
        key_limit_remaining: number(key, "limit_remaining"),
        key_limit_reset: text(key, "limit_reset"),
        effective_budget,
        is_free_tier: key.get("is_free_tier").and_then(Value::as_bool),
    })
}

fn fetch_data(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: &str,
) -> Result<Option<Value>, String> {
    let response = client
        .get(url)
        .bearer_auth(api_key)
        .header("X-Title", "Pix Desktop")
        .send()
        .map_err(|error| format!("failed to reach OpenRouter: {error}"))?;
    let status = response.status();
    // `/credits` may require a management key; treat 403 as "not available".
    if status.as_u16() == 403 || status.as_u16() == 404 {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("OpenRouter usage request failed ({})", status.as_u16()));
    }
    let body: Value = response
        .json()
        .map_err(|_| "OpenRouter returned a malformed usage response".to_owned())?;
    Ok(body.get("data").cloned())
}

/// Returns `None` when no OpenRouter key is configured (env or Pi auth).
#[tauri::command]
pub(crate) async fn openrouter_usage() -> Result<Option<OpenRouterUsage>, String> {
    crate::run_blocking(move || {
        let Some(api_key) = crate::native_repository_semantic_config::openrouter_api_key() else {
            return Ok(None);
        };
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| format!("failed to create the OpenRouter HTTP client: {error}"))?;
        let key = fetch_data(&client, OPENROUTER_KEY_URL, &api_key)?;
        let credits = fetch_data(&client, OPENROUTER_CREDITS_URL, &api_key).unwrap_or(None);
        parse_usage(key.as_ref(), credits.as_ref())
            .map(Some)
            .ok_or_else(|| "OpenRouter returned no usage data".to_owned())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn computes_balance_and_spend_without_exposing_labels() {
        let key = json!({ "label": "sk-or-…", "usage": 10.0, "usage_daily": 0.5, "usage_weekly": 1.0,
            "usage_monthly": 3.0, "limit": null, "limit_remaining": null, "is_free_tier": false,
            "effective_budget": { "limit_usd": 50, "remaining_usd": 10, "reset_interval": "weekly", "resets_at": null } });
        let credits = json!({ "total_credits": 100.5, "total_usage": 25.25 });
        let usage = parse_usage(Some(&key), Some(&credits)).unwrap();
        assert_eq!(usage.balance, Some(75.25));
        assert_eq!(usage.usage_daily, Some(0.5));
        assert_eq!(usage.key_limit, None);
        assert_eq!(usage.effective_budget.as_ref().unwrap().remaining_usd, 10.0);
        assert!(!serde_json::to_string(&usage).unwrap().contains("sk-or"));
    }

    #[test]
    fn tolerates_missing_credits_endpoint() {
        let usage = parse_usage(Some(&json!({ "usage_monthly": 2.0 })), None).unwrap();
        assert_eq!(usage.balance, None);
        assert_eq!(usage.usage_monthly, Some(2.0));
        assert!(parse_usage(None, None).is_none());
    }
}
