use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct CloudModel {
    pub id: String,
    pub owned_by: Option<String>,
    pub context_length: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CloudModelsResponse {
    data: Vec<CloudModelResponse>,
}

#[derive(Debug, Deserialize)]
struct CloudModelResponse {
    id: String,
    owned_by: Option<String>,
    context_length: Option<u64>,
}

fn models_url(provider: &str) -> Result<&'static str, String> {
    match provider.to_lowercase().as_str() {
        "minimax" => Ok("https://api.minimaxi.com/v1/models"),
        "deepseek" => Ok("https://api.deepseek.com/models"),
        "kimi" | "moonshot" => Ok("https://api.moonshot.cn/v1/models"),
        "gemini" => Ok("https://generativelanguage.googleapis.com/v1beta/openai/models"),
        "qwen" => Ok("https://dashscope.aliyuncs.com/compatible-mode/v1/models"),
        "doubao" => Ok("https://ark.cn-beijing.volces.com/api/v3/models"),
        "zhipu" => Ok("https://open.bigmodel.cn/api/paas/v4/models"),
        _ => Err(format!("Unsupported cloud model provider: {}", provider)),
    }
}

fn is_text_generation_model(provider: &str, model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    match provider.to_lowercase().as_str() {
        "minimax" => {
            id.starts_with("minimax-")
                && !id.contains("speech")
                && !id.contains("image")
                && !id.contains("video")
                && !id.contains("hailuo")
                && !id.contains("music")
        }
        "deepseek" => id.starts_with("deepseek-"),
        "kimi" | "moonshot" => id.starts_with("kimi-") || id.starts_with("moonshot-"),
        "gemini" => id.starts_with("gemini-"),
        "qwen" => id.starts_with("qwen"),
        "doubao" => !id.contains("embedding") && !id.contains("image"),
        "zhipu" => id.starts_with("glm-") || id.starts_with("codegeex-"),
        _ => false,
    }
}

/// Fetches the models visible to the supplied provider account.
#[tauri::command]
pub async fn get_china_cloud_models(
    provider: String,
    api_key: String,
) -> Result<Vec<CloudModel>, String> {
    if api_key.trim().is_empty() {
        return Err("API Key is required to fetch models".to_string());
    }

    let url = models_url(&provider)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(url)
        .bearer_auth(api_key.trim())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch {} models: {}", provider, e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read {} model response: {}", provider, e))?;

    if !status.is_success() {
        return Err(format!(
            "{} model API returned {}: {}",
            provider,
            status,
            body.chars().take(500).collect::<String>()
        ));
    }

    let parsed: CloudModelsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse {} model list: {}", provider, e))?;

    let mut models = parsed
        .data
        .into_iter()
        .filter(|model| is_text_generation_model(&provider, &model.id))
        .map(|model| CloudModel {
            id: model.id,
            owned_by: model.owned_by,
            context_length: model.context_length,
        })
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.to_lowercase().cmp(&right.id.to_lowercase()));
    models.dedup_by(|left, right| left.id == right.id);

    if models.is_empty() {
        return Err(format!(
            "{} did not return any text generation models",
            provider
        ));
    }

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_minimax_non_text_models_without_hiding_future_text_models() {
        assert!(is_text_generation_model("minimax", "MiniMax-M3"));
        assert!(is_text_generation_model(
            "minimax",
            "MiniMax-M2.7-highspeed"
        ));
        assert!(!is_text_generation_model("minimax", "speech-2.8-hd"));
        assert!(!is_text_generation_model("minimax", "MiniMax-Hailuo-2.3"));
    }

    #[test]
    fn accepts_deepseek_and_kimi_text_families() {
        assert!(is_text_generation_model("deepseek", "deepseek-v4-pro"));
        assert!(is_text_generation_model("kimi", "kimi-k3"));
        assert!(is_text_generation_model("kimi", "moonshot-v1-128k"));
    }
}
