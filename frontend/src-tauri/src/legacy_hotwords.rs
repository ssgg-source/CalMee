use crate::state::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

const LEGACY_SOURCE: &str = "legacy_config";
const LEGACY_CATEGORY: &str = "Existing configuration";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHotwordPreview {
    pub affected_rows: i64,
    pub source_description: String,
    pub shared_source_is_read_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHotwordDisposition {
    pub action: LegacyHotwordAction,
    pub expected_rows: i64,
    pub confirmed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyHotwordAction {
    Keep,
    Delete,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHotwordDispositionReport {
    pub action: String,
    pub affected_rows: u64,
}

const COUNT_SQL: &str =
    "SELECT COUNT(*) FROM hotwords WHERE source=? AND category=? AND usage_count=0";

async fn preview(pool: &SqlitePool) -> Result<LegacyHotwordPreview, String> {
    let affected_rows = sqlx::query_scalar::<_, i64>(COUNT_SQL)
        .bind(LEGACY_SOURCE)
        .bind(LEGACY_CATEGORY)
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())?;
    Ok(LegacyHotwordPreview {
        affected_rows,
        source_description: "Previously copied from the shared legacy FunASR configuration".into(),
        shared_source_is_read_only: true,
    })
}

async fn apply_disposition(
    pool: &SqlitePool,
    disposition: LegacyHotwordDisposition,
) -> Result<LegacyHotwordDispositionReport, String> {
    if !disposition.confirmed {
        return Err("Explicit confirmation is required.".into());
    }
    if disposition.expected_rows <= 0 {
        return Err("The expected affected-row count must be greater than zero.".into());
    }

    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;
    let current_rows = sqlx::query_scalar::<_, i64>(COUNT_SQL)
        .bind(LEGACY_SOURCE)
        .bind(LEGACY_CATEGORY)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| error.to_string())?;
    if current_rows != disposition.expected_rows {
        transaction
            .rollback()
            .await
            .map_err(|error| error.to_string())?;
        return Err(format!(
            "The affected-row count changed from {} to {}. Preview again before continuing.",
            disposition.expected_rows, current_rows
        ));
    }

    let now = Utc::now().to_rfc3339();
    let (action, result) = match disposition.action {
        LegacyHotwordAction::Keep => (
            "keep",
            sqlx::query("UPDATE hotwords SET source='legacy_config_retained',updated_at=? WHERE source=? AND category=? AND usage_count=0")
                .bind(now)
                .bind(LEGACY_SOURCE)
                .bind(LEGACY_CATEGORY)
                .execute(&mut *transaction)
                .await,
        ),
        LegacyHotwordAction::Delete => (
            "delete",
            sqlx::query("DELETE FROM hotwords WHERE source=? AND category=? AND usage_count=0")
                .bind(LEGACY_SOURCE)
                .bind(LEGACY_CATEGORY)
                .execute(&mut *transaction)
                .await,
        ),
    };
    let affected_rows = result.map_err(|error| error.to_string())?.rows_affected();
    if affected_rows != disposition.expected_rows as u64 {
        transaction
            .rollback()
            .await
            .map_err(|error| error.to_string())?;
        return Err(
            "The disposition did not affect the previewed rows; all changes were rolled back."
                .into(),
        );
    }
    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;
    Ok(LegacyHotwordDispositionReport {
        action: action.into(),
        affected_rows,
    })
}

#[tauri::command]
pub async fn api_preview_legacy_hotword_disposition(
    state: tauri::State<'_, AppState>,
) -> Result<LegacyHotwordPreview, String> {
    preview(state.db_manager.pool()).await
}

#[tauri::command]
pub async fn api_apply_legacy_hotword_disposition(
    state: tauri::State<'_, AppState>,
    disposition: LegacyHotwordDisposition,
) -> Result<LegacyHotwordDispositionReport, String> {
    apply_disposition(state.db_manager.pool(), disposition).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::Executor;
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn fixture() -> (TempDir, SqlitePool) {
        let temp = TempDir::new().unwrap();
        let url = format!("sqlite://{}", temp.path().join("fixture.sqlite").display());
        let pool = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::from_str(&url)
                    .unwrap()
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        pool.execute("CREATE TABLE hotwords(id TEXT PRIMARY KEY,source TEXT NOT NULL,category TEXT NOT NULL,usage_count INTEGER NOT NULL,updated_at TEXT NOT NULL)").await.unwrap();
        pool.execute("INSERT INTO hotwords VALUES('legacy-1','legacy_config','Existing configuration',0,'old'),('manual-1','manual','General',0,'old'),('changed-1','legacy_config','Edited by user',0,'old')").await.unwrap();
        (temp, pool)
    }

    #[tokio::test]
    async fn preview_and_keep_touch_only_strict_legacy_provenance() {
        let (_temp, pool) = fixture().await;
        assert_eq!(preview(&pool).await.unwrap().affected_rows, 1);
        let report = apply_disposition(
            &pool,
            LegacyHotwordDisposition {
                action: LegacyHotwordAction::Keep,
                expected_rows: 1,
                confirmed: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.affected_rows, 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT source FROM hotwords WHERE id='legacy-1'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "legacy_config_retained"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT source FROM hotwords WHERE id='changed-1'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "legacy_config"
        );
    }

    #[tokio::test]
    async fn delete_requires_confirmation_and_matching_preview_count() {
        let (_temp, pool) = fixture().await;
        for disposition in [
            LegacyHotwordDisposition {
                action: LegacyHotwordAction::Delete,
                expected_rows: 1,
                confirmed: false,
            },
            LegacyHotwordDisposition {
                action: LegacyHotwordAction::Delete,
                expected_rows: 2,
                confirmed: true,
            },
        ] {
            assert!(apply_disposition(&pool, disposition).await.is_err());
            assert_eq!(preview(&pool).await.unwrap().affected_rows, 1);
        }
        let report = apply_disposition(
            &pool,
            LegacyHotwordDisposition {
                action: LegacyHotwordAction::Delete,
                expected_rows: 1,
                confirmed: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(report.affected_rows, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM hotwords")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
    }
}
