use crate::state::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row, SqlitePool};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLinkResult {
    pub event: Option<crate::calendar_integration::CalendarEvent>,
    pub displaced_meeting_id: Option<String>,
    pub revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarLinkCandidate {
    pub event: crate::calendar_integration::CalendarEvent,
    pub score: i64,
    pub reason_codes: Vec<String>,
    pub occupied_by_meeting_id: Option<String>,
    pub occupied_by_title: Option<String>,
}

#[cfg(test)]
mod calendar_link_tests {
    use super::*;
    const MIGRATION: &str =
        include_str!("../migrations/20260902100000_add_meeting_calendar_links.sql");
    async fn pool(migrate: bool) -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("PRAGMA foreign_keys=ON;
            CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT,created_at TEXT,updated_at TEXT,meeting_start_time TEXT,meeting_end_time TEXT,calendar_event_id TEXT);
            CREATE TABLE calendar_events(id TEXT PRIMARY KEY,source TEXT,external_id TEXT,calendar_name TEXT,title TEXT,start_at TEXT,end_at TEXT,location TEXT,notes TEXT,meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,calendar_id TEXT,href TEXT,etag TEXT,all_day INTEGER);
            CREATE TABLE calendar_collections(id TEXT PRIMARY KEY,enabled INTEGER);
            INSERT INTO meetings VALUES('a','Fixture A','2026-09-02T10:00:00Z','now','2026-09-02T10:00:00Z',NULL,NULL),('b','Fixture B','2026-09-02T11:00:00Z','now','2026-09-02T11:00:00Z',NULL,NULL);
            INSERT INTO calendar_events(id,source,external_id,title,start_at,all_day) VALUES('e','local','fixture-e','Fixture event','2026-09-02T12:00:00Z',0);")
            .execute(&pool).await.unwrap();
        if migrate {
            sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap();
        }
        pool
    }
    async fn link(
        pool: &SqlitePool,
        meeting: &str,
        event: Option<&str>,
        replace: bool,
        expected: Option<&str>,
    ) -> Result<CalendarLinkResult, String> {
        set_calendar_link(
            pool,
            meeting.into(),
            event.map(str::to_owned),
            replace,
            "manual".into(),
            false,
            expected.map(str::to_owned),
            None,
        )
        .await
    }
    async fn pairs(pool: &SqlitePool) -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT meeting_id,calendar_event_id FROM meeting_calendar_links ORDER BY meeting_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn occupied_event_requires_explicit_current_owner_confirmation() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        assert!(link(&pool, "b", Some("e"), false, None)
            .await
            .unwrap_err()
            .contains("CONFLICT"));
        assert!(link(&pool, "b", Some("e"), true, Some("wrong-owner"))
            .await
            .unwrap_err()
            .contains("CHANGED"));
        assert_eq!(pairs(&pool).await, vec![("a".into(), "e".into())]);
        let result = link(&pool, "b", Some("e"), true, Some("a")).await.unwrap();
        assert_eq!(result.displaced_meeting_id.as_deref(), Some("a"));
        assert_eq!(pairs(&pool).await, vec![("b".into(), "e".into())]);
        let old: Option<String> =
            sqlx::query_scalar("SELECT calendar_event_id FROM meetings WHERE id='a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(old.is_none());
        let reverse: String =
            sqlx::query_scalar("SELECT meeting_id FROM calendar_events WHERE id='e'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(reverse, "b");
    }
    #[tokio::test]
    async fn unlink_preserves_meeting_and_time_and_has_no_dangling_projection() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        link(&pool, "a", None, false, None).await.unwrap();
        assert!(pairs(&pool).await.is_empty());
        let row: (String, Option<String>) = sqlx::query_as(
            "SELECT meeting_start_time,calendar_event_id FROM meetings WHERE id='a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("2026-09-02T10:00:00Z".into(), None));
        let reverse: Option<String> =
            sqlx::query_scalar("SELECT meeting_id FROM calendar_events WHERE id='e'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(reverse.is_none());
    }
    #[tokio::test]
    async fn transfer_failure_rolls_back_entire_pair() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER fail_link BEFORE UPDATE OF meeting_id ON calendar_events WHEN NEW.meeting_id='b' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").execute(&pool).await.unwrap();
        assert!(link(&pool, "b", Some("e"), true, Some("a")).await.is_err());
        assert_eq!(pairs(&pool).await, vec![("a".into(), "e".into())]);
        let reverse: String =
            sqlx::query_scalar("SELECT meeting_id FROM calendar_events WHERE id='e'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(reverse, "a");
        let forward: String =
            sqlx::query_scalar("SELECT calendar_event_id FROM meetings WHERE id='a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(forward, "e");
    }
    #[tokio::test]
    async fn migration_preserves_conflicting_claims_without_guessing() {
        let pool = pool(false).await;
        sqlx::raw_sql(
            "UPDATE meetings SET calendar_event_id='e'; UPDATE calendar_events SET meeting_id='b';",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap();
        assert!(pairs(&pool).await.is_empty());
        let claims: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM meeting_calendar_link_legacy_claims WHERE resolved=0",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(claims, 3);
        let stale: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE calendar_event_id IS NOT NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stale, 0);
    }
    #[tokio::test]
    async fn migration_keeps_unambiguous_one_sided_link() {
        let pool = pool(false).await;
        sqlx::query("UPDATE meetings SET calendar_event_id='e' WHERE id='a'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap();
        assert_eq!(pairs(&pool).await, vec![("a".into(), "e".into())]);
        let reverse: String =
            sqlx::query_scalar("SELECT meeting_id FROM calendar_events WHERE id='e'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(reverse, "a");
    }
    #[tokio::test]
    async fn source_event_delete_keeps_meeting_and_clears_link() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        sqlx::query("DELETE FROM calendar_events WHERE id='e'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(pairs(&pool).await.is_empty());
        let forward: Option<String> =
            sqlx::query_scalar("SELECT calendar_event_id FROM meetings WHERE id='a'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(forward.is_none());
    }
    #[tokio::test]
    async fn missing_target_does_not_remove_existing_link() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        assert!(link(&pool, "a", Some("missing"), false, None)
            .await
            .is_err());
        assert_eq!(pairs(&pool).await, vec![("a".into(), "e".into())]);
    }
    #[tokio::test]
    async fn stale_window_cannot_unlink_a_changed_association() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        let error = set_calendar_link(
            &pool,
            "a".into(),
            None,
            false,
            "manual".into(),
            false,
            None,
            Some("old-event".into()),
        )
        .await
        .unwrap_err();
        assert!(error.contains("CHANGED"));
        assert_eq!(pairs(&pool).await, vec![("a".into(), "e".into())]);
    }
    #[tokio::test]
    async fn candidates_include_current_link_and_search_other_synced_dates() {
        let pool = pool(true).await;
        link(&pool, "a", Some("e"), false, None).await.unwrap();
        let candidates = load_calendar_link_candidates(&pool, Some("a".into()), None, None, None)
            .await
            .unwrap();
        assert_eq!(candidates[0].event.id, "e");
        assert!(candidates[0]
            .reason_codes
            .contains(&"currently_linked".into()));
        sqlx::query("UPDATE calendar_events SET start_at='2020-01-01T00:00:00Z' WHERE id='e'")
            .execute(&pool)
            .await
            .unwrap();
        let candidates = load_calendar_link_candidates(
            &pool,
            Some("b".into()),
            None,
            None,
            Some("Fixture".into()),
        )
        .await
        .unwrap();
        assert_eq!(candidates[0].occupied_by_meeting_id.as_deref(), Some("a"));
        assert!(load_calendar_link_candidates(
            &pool,
            Some("b".into()),
            None,
            None,
            Some("%".into())
        )
        .await
        .unwrap()
        .is_empty());
    }
}

fn replace_count(source: &str, from: &str) -> usize {
    source.match_indices(from).count()
}

fn replace_json_strings(value: &mut serde_json::Value, from: &str, to: &str) -> usize {
    match value {
        serde_json::Value::String(text) => {
            let count = replace_count(text, from);
            if count > 0 {
                *text = text.replace(from, to);
            }
            count
        }
        serde_json::Value::Array(items) => items
            .iter_mut()
            .map(|item| replace_json_strings(item, from, to))
            .sum(),
        serde_json::Value::Object(fields) => fields
            .values_mut()
            .map(|item| replace_json_strings(item, from, to))
            .sum(),
        _ => 0,
    }
}

async fn current_record_source_hash(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    meeting_id: &str,
) -> Result<String, String> {
    let refined = sqlx::query_scalar::<_, String>(
        "SELECT result_json FROM transcript_refinements WHERE meeting_id=?",
    )
    .bind(meeting_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .and_then(|json| {
        serde_json::from_str::<crate::transcript_refinement::TranscriptRefinementResult>(&json).ok()
    })
    .map(|result| {
        result
            .segments
            .into_iter()
            .filter_map(|segment| {
                let text = if segment.proposed_text.trim().is_empty() {
                    segment.optimized_text
                } else {
                    segment.proposed_text
                };
                (!text.trim().is_empty()).then_some((segment.id, text))
            })
            .collect::<HashMap<_, _>>()
    })
    .unwrap_or_default();
    let rows = sqlx::query(
        "SELECT id,transcript,audio_start_time,audio_end_time FROM transcripts WHERE meeting_id=? ORDER BY COALESCE(audio_start_time,0),timestamp",
    )
    .bind(meeting_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for row in rows {
        let id: String = row.get("id");
        let raw: String = row.get("transcript");
        let original = raw
            .trim()
            .strip_prefix("[Speaker ")
            .and_then(|rest| rest.find(']').map(|end| rest[end + 1..].trim()))
            .unwrap_or(raw.trim());
        let text = refined.get(&id).map(String::as_str).unwrap_or(original);
        if text.trim().is_empty() {
            continue;
        }
        let start_ms =
            (row.get::<Option<f64>, _>("audio_start_time").unwrap_or(0.0) * 1000.0) as i64;
        let end_ms = (row.get::<Option<f64>, _>("audio_end_time").unwrap_or(0.0) * 1000.0) as i64;
        id.hash(&mut hasher);
        text.hash(&mut hasher);
        start_ms.hash(&mut hasher);
        end_ms.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

async fn replace_text_column(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    id_expression: &str,
    id_condition: &str,
    text_column: &str,
    meeting_id: &str,
    from: &str,
    to: &str,
) -> Result<usize, String> {
    let select = format!(
        "SELECT {id_expression} AS record_id,{text_column} FROM {table} WHERE meeting_id=? AND {text_column} IS NOT NULL"
    );
    let rows = sqlx::query(&select)
        .bind(meeting_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let update =
        format!("UPDATE {table} SET {text_column}=? WHERE meeting_id=? AND {id_condition}=?");
    let mut total = 0;
    for row in rows {
        let id: String = row.get("record_id");
        let text: String = row.get(text_column);
        let count = replace_count(&text, from);
        if count == 0 {
            continue;
        }
        sqlx::query(&update)
            .bind(text.replace(from, to))
            .bind(meeting_id)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        total += count;
    }
    Ok(total)
}

async fn replace_json_column(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    table: &str,
    id_column: &str,
    json_column: &str,
    meeting_id: &str,
    from: &str,
    to: &str,
) -> Result<usize, String> {
    let select = format!(
        "SELECT {id_column} AS record_id,{json_column} FROM {table} WHERE meeting_id=? AND {json_column} IS NOT NULL"
    );
    let rows = sqlx::query(&select)
        .bind(meeting_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let update = format!("UPDATE {table} SET {json_column}=? WHERE meeting_id=? AND {id_column}=?");
    let mut total = 0;
    for row in rows {
        let id: String = row.get("record_id");
        let encoded: String = row.get(json_column);
        let mut value: serde_json::Value = match serde_json::from_str(&encoded) {
            Ok(value) => value,
            Err(_) => {
                // A few legacy summary rows contain Markdown rather than JSON.
                // They are still safe to correct because the update remains scoped
                // by both meeting_id and the row identifier.
                let count = replace_count(&encoded, from);
                if count > 0 {
                    sqlx::query(&update)
                        .bind(encoded.replace(from, to))
                        .bind(meeting_id)
                        .bind(id)
                        .execute(&mut **tx)
                        .await
                        .map_err(|e| e.to_string())?;
                    total += count;
                }
                continue;
            }
        };
        let count = replace_json_strings(&mut value, from, to);
        if count == 0 {
            continue;
        }
        sqlx::query(&update)
            .bind(serde_json::to_string(&value).map_err(|e| e.to_string())?)
            .bind(meeting_id)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        total += count;
    }
    Ok(total)
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDocument {
    pub meeting_id: String,
    pub kind: String,
    pub context_key: String,
    pub markdown: String,
    pub previous_markdown: Option<String>,
    pub language: String,
    pub template_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MeetingTag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub meeting_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTemplate {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPreference {
    pub meeting_id: String,
    pub kind: String,
    pub language: String,
    pub template_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub parameters_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGenerationRequest {
    pub meeting_id: String,
    pub kind: String,
    pub context_key: Option<String>,
    pub language: String,
    pub template_id: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub parameters_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DocumentGenerationJob {
    pub id: String,
    pub meeting_id: String,
    pub kind: String,
    pub context_key: String,
    pub status: String,
    pub stage: String,
    pub percentage: i64,
    pub message: String,
    pub result_markdown: Option<String>,
    pub error: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerOption {
    pub key: String,
    pub name: String,
    pub local_speaker: Option<String>,
    pub person_id: Option<String>,
    pub segment_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MeetingNotes {
    pub meeting_id: String,
    pub notes_markdown: Option<String>,
    pub notes_json: Option<String>,
    pub updated_at: String,
}

#[tauri::command]
pub async fn api_get_meeting_notes(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<MeetingNotes>, String> {
    sqlx::query_as::<_, MeetingNotes>(
        "SELECT meeting_id,notes_markdown,notes_json,updated_at FROM meeting_notes WHERE meeting_id=?",
    )
    .bind(meeting_id)
    .fetch_optional(state.db_manager.pool())
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn api_save_meeting_notes(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    notes_markdown: String,
    notes_json: Option<String>,
) -> Result<MeetingNotes, String> {
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO meeting_notes(meeting_id,notes_markdown,notes_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(meeting_id) DO UPDATE SET notes_markdown=excluded.notes_markdown,notes_json=excluded.notes_json,updated_at=excluded.updated_at",
    )
    .bind(&meeting_id)
    .bind(&notes_markdown)
    .bind(&notes_json)
    .bind(&now)
    .bind(&now)
    .execute(state.db_manager.pool())
    .await
    .map_err(|error| error.to_string())?;

    if !notes_markdown.trim().is_empty() {
        promote_meeting_draft(state.db_manager.pool(), &meeting_id).await?;
    }

    api_get_meeting_notes(state, meeting_id)
        .await?
        .ok_or_else(|| "Failed to read saved meeting notes".to_string())
}

async fn promote_meeting_draft(pool: &SqlitePool, meeting_id: &str) -> Result<(), String> {
    sqlx::query(
        "UPDATE meetings SET source='calmee',updated_at=? WHERE id=? AND source='calmee-draft'",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(meeting_id)
    .execute(pool)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

async fn discard_empty_meeting_drafts(
    pool: &SqlitePool,
    meeting_id: Option<&str>,
) -> Result<u64, String> {
    let result = sqlx::query(
        "DELETE FROM meetings
         WHERE source='calmee-draft'
           AND (? IS NULL OR id=?)
           AND COALESCE(trim(folder_path),'')=''
           AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.meeting_id=meetings.id AND trim(t.transcript)<>'')
           AND NOT EXISTS (SELECT 1 FROM meeting_notes n WHERE n.meeting_id=meetings.id AND COALESCE(trim(n.notes_markdown),'')<>'')
           AND NOT EXISTS (SELECT 1 FROM meeting_documents d WHERE d.meeting_id=meetings.id AND trim(d.markdown)<>'')
           AND NOT EXISTS (SELECT 1 FROM summary_processes s WHERE s.meeting_id=meetings.id AND COALESCE(trim(s.result),'')<>'')",
    )
    .bind(meeting_id)
    .bind(meeting_id)
    .execute(pool)
    .await
    .map_err(|error| error.to_string())?;
    Ok(result.rows_affected())
}

#[tauri::command]
pub async fn api_create_meeting_draft(
    state: tauri::State<'_, AppState>,
    title: String,
) -> Result<serde_json::Value, String> {
    let meeting_id = format!("meeting-{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let title = title.trim();
    let title = if title.is_empty() {
        "Untitled meeting"
    } else {
        title
    };
    sqlx::query("INSERT INTO meetings(id,title,created_at,updated_at,meeting_start_time,source) VALUES(?,?,?,?,?,?)")
        .bind(&meeting_id)
        .bind(title)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .bind("calmee-draft")
        .execute(state.db_manager.pool())
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "meetingId": meeting_id, "title": title }))
}

#[tauri::command]
pub async fn api_discard_empty_meeting_draft(
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<bool, String> {
    Ok(discard_empty_meeting_drafts(state.db_manager.pool(), Some(&meeting_id)).await? > 0)
}

#[tauri::command]
pub async fn api_cleanup_empty_meeting_drafts(
    state: tauri::State<'_, AppState>,
) -> Result<u64, String> {
    discard_empty_meeting_drafts(state.db_manager.pool(), None).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageStats {
    pub meetings: i64,
    pub recordings: i64,
    pub transcript_characters: i64,
    pub note_characters: i64,
    pub transcribed_seconds: f64,
}

#[tauri::command]
pub async fn api_get_local_usage_stats(
    state: tauri::State<'_, AppState>,
    since: Option<String>,
) -> Result<LocalUsageStats, String> {
    let pool = state.db_manager.pool();
    let meetings = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM meetings WHERE COALESCE(source,'')<>'calmee-draft' AND (? IS NULL OR created_at>=?)",
    )
    .bind(&since).bind(&since).fetch_one(pool).await.map_err(|error| error.to_string())?;
    let recordings = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM meetings WHERE COALESCE(source,'')<>'calmee-draft' AND COALESCE(TRIM(folder_path),'')<>'' AND (? IS NULL OR created_at>=?)",
    )
    .bind(&since).bind(&since).fetch_one(pool).await.map_err(|error| error.to_string())?;
    let transcript_characters = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(LENGTH(t.transcript)),0) FROM transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE COALESCE(m.source,'')<>'calmee-draft' AND (? IS NULL OR m.created_at>=?)",
    )
    .bind(&since).bind(&since).fetch_one(pool).await.map_err(|error| error.to_string())?;
    let note_characters = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(SUM(LENGTH(n.notes_markdown)),0) FROM meeting_notes n JOIN meetings m ON m.id=n.meeting_id WHERE COALESCE(m.source,'')<>'calmee-draft' AND (? IS NULL OR m.created_at>=?)",
    )
    .bind(&since).bind(&since).fetch_one(pool).await.map_err(|error| error.to_string())?;
    let transcribed_seconds = sqlx::query_scalar::<_, f64>(
        "SELECT COALESCE(SUM(last_audio),0.0) FROM (SELECT MAX(COALESCE(t.audio_end_time,0.0)) AS last_audio FROM transcripts t JOIN meetings m ON m.id=t.meeting_id WHERE COALESCE(m.source,'')<>'calmee-draft' AND (? IS NULL OR m.created_at>=?) GROUP BY t.meeting_id)",
    )
    .bind(&since).bind(&since).fetch_one(pool).await.map_err(|error| error.to_string())?;
    Ok(LocalUsageStats {
        meetings,
        recordings,
        transcript_characters,
        note_characters,
        transcribed_seconds,
    })
}

#[tauri::command]
pub async fn api_create_notes_only_meeting(
    state: tauri::State<'_, AppState>,
    title: String,
    notes_markdown: String,
    notes_json: Option<String>,
) -> Result<serde_json::Value, String> {
    let meeting_id = create_notes_only_meeting(
        state.db_manager.pool(),
        &title,
        &notes_markdown,
        notes_json.as_deref(),
    )
    .await?;
    Ok(serde_json::json!({ "meetingId": meeting_id }))
}

async fn create_notes_only_meeting(
    pool: &SqlitePool,
    title: &str,
    notes_markdown: &str,
    notes_json: Option<&str>,
) -> Result<String, String> {
    if notes_markdown.trim().is_empty() {
        return Err("Meeting notes cannot be empty".to_string());
    }

    let meeting_id = format!("meeting-{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT INTO meetings(id,title,created_at,updated_at,meeting_start_time,source) VALUES(?,?,?,?,?,?)",
    )
    .bind(&meeting_id)
    .bind(title.trim())
    .bind(&now)
    .bind(&now)
    .bind(&now)
    .bind("calmee")
    .execute(&mut *transaction)
    .await
    .map_err(|error| error.to_string())?;

    sqlx::query(
        "INSERT INTO meeting_notes(meeting_id,notes_markdown,notes_json,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .bind(&meeting_id)
    .bind(notes_markdown)
    .bind(notes_json)
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    .map_err(|error| error.to_string())?;

    transaction
        .commit()
        .await
        .map_err(|error| error.to_string())?;

    Ok(meeting_id)
}

#[cfg(test)]
mod notes_only_meeting_tests {
    use super::{create_notes_only_meeting, discard_empty_meeting_drafts};
    use sqlx::SqlitePool;

    async fn meeting_schema(pool: &SqlitePool) {
        sqlx::query("CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,meeting_start_time TEXT,source TEXT)")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn notes_only_meeting_is_created_atomically() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        meeting_schema(&pool).await;
        sqlx::query("CREATE TABLE meeting_notes(meeting_id TEXT PRIMARY KEY,notes_markdown TEXT,notes_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,FOREIGN KEY(meeting_id) REFERENCES meetings(id) ON DELETE CASCADE)")
            .execute(&pool)
            .await
            .unwrap();

        let meeting_id = create_notes_only_meeting(
            &pool,
            "Design review",
            "Confirm the release date",
            Some(r#"{"source":"live-recording"}"#),
        )
        .await
        .unwrap();

        let meeting_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE id=?")
            .bind(&meeting_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let notes_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM meeting_notes WHERE meeting_id=?")
                .bind(&meeting_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((meeting_count, notes_count), (1, 1));
    }

    #[tokio::test]
    async fn notes_failure_rolls_back_the_meeting() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        meeting_schema(&pool).await;

        assert!(
            create_notes_only_meeting(&pool, "Design review", "A real note", None)
                .await
                .is_err()
        );

        let meeting_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(meeting_count, 0);
    }

    async fn draft_schema(pool: &SqlitePool) {
        sqlx::query("CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,folder_path TEXT,meeting_start_time TEXT,source TEXT)")
            .execute(pool).await.unwrap();
        sqlx::query(
            "CREATE TABLE transcripts(id TEXT PRIMARY KEY,meeting_id TEXT,transcript TEXT)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE meeting_notes(meeting_id TEXT PRIMARY KEY,notes_markdown TEXT)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE meeting_documents(meeting_id TEXT,markdown TEXT)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE summary_processes(meeting_id TEXT,result TEXT)")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn only_empty_calmee_drafts_are_discarded() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        draft_schema(&pool).await;
        for (id, source) in [("empty-draft", "calmee-draft"), ("normal", "calmee")] {
            sqlx::query(
                "INSERT INTO meetings(id,title,created_at,updated_at,source) VALUES(?,?,?,?,?)",
            )
            .bind(id)
            .bind("Untitled")
            .bind("now")
            .bind("now")
            .bind(source)
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO meetings(id,title,created_at,updated_at,source) VALUES('notes-draft','Untitled','now','now','calmee-draft')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO meeting_notes(meeting_id,notes_markdown) VALUES('notes-draft','Keep this note')")
            .execute(&pool).await.unwrap();

        assert_eq!(discard_empty_meeting_drafts(&pool, None).await.unwrap(), 1);
        let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM meetings ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec!["normal", "notes-draft"]);
    }

    #[tokio::test]
    async fn targeted_discard_never_removes_other_drafts() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        draft_schema(&pool).await;
        for id in ["draft-a", "draft-b"] {
            sqlx::query("INSERT INTO meetings(id,title,created_at,updated_at,source) VALUES(?,?,?,?, 'calmee-draft')")
                .bind(id).bind("Untitled").bind("now").bind("now")
                .execute(&pool).await.unwrap();
        }

        assert_eq!(
            discard_empty_meeting_drafts(&pool, Some("draft-a"))
                .await
                .unwrap(),
            1
        );
        let remaining: Vec<String> = sqlx::query_scalar("SELECT id FROM meetings")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, vec!["draft-b"]);
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    match kind {
        "smart_record" | "meeting_summary" | "speech_summary" => Ok(()),
        _ => Err("Unsupported meeting document type".into()),
    }
}

#[tauri::command]
pub async fn api_get_meeting_document<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    kind: String,
    context_key: Option<String>,
) -> Result<Option<MeetingDocument>, String> {
    validate_kind(&kind)?;
    sqlx::query_as::<_, MeetingDocument>("SELECT meeting_id,kind,context_key,markdown,previous_markdown,language,template_id,updated_at FROM meeting_documents WHERE meeting_id=? AND kind=? AND context_key=?")
        .bind(meeting_id).bind(kind).bind(context_key.unwrap_or_default())
        .fetch_optional(state.db_manager.pool()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_save_meeting_document<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    kind: String,
    context_key: Option<String>,
    markdown: String,
    language: Option<String>,
    template_id: Option<String>,
) -> Result<MeetingDocument, String> {
    validate_kind(&kind)?;
    // Clearing a document is a valid edit. Rejecting an empty Markdown value
    // makes auto-save fail exactly when the user deletes the final block.
    let context_key = context_key.unwrap_or_default();
    let language = language.unwrap_or_else(|| "auto".into());
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO meeting_documents (meeting_id,kind,context_key,markdown,language,template_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(meeting_id,kind,context_key) DO UPDATE SET previous_markdown=CASE WHEN meeting_documents.markdown<>excluded.markdown THEN meeting_documents.markdown ELSE meeting_documents.previous_markdown END,markdown=excluded.markdown,language=excluded.language,template_id=excluded.template_id,updated_at=excluded.updated_at")
        .bind(&meeting_id).bind(&kind).bind(&context_key).bind(markdown.trim()).bind(&language).bind(&template_id).bind(&now).bind(&now)
        .execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    if !markdown.trim().is_empty() {
        promote_meeting_draft(state.db_manager.pool(), &meeting_id).await?;
    }
    if kind == "smart_record" {
        // Meeting summaries depend on the saved Smart Record. Preserve the
        // existing summary, but mark it stale whenever that source changes.
        sqlx::query(
            "UPDATE meeting_record_state SET summary_stale=1,updated_at=? WHERE meeting_id=?",
        )
        .bind(&now)
        .bind(&meeting_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    }
    api_get_meeting_document(_app, state, meeting_id, kind, Some(context_key))
        .await?
        .ok_or_else(|| "Failed to read saved document".into())
}

/// Replace one recognition error throughout the current text of a meeting.
/// Previous document backups remain untouched so the correction can be undone.
#[tauri::command]
pub async fn api_batch_correct_meeting_documents<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    from: String,
    to: String,
) -> Result<usize, String> {
    let from = from.trim();
    let to = to.trim();
    if from.is_empty() || to.is_empty() || from == to {
        return Err("Correction terms must be different and non-empty".into());
    }

    let now = Utc::now().to_rfc3339();
    let mut tx = state
        .db_manager
        .pool()
        .begin()
        .await
        .map_err(|e| e.to_string())?;
    let mut total = 0;

    total += replace_text_column(
        &mut tx,
        "transcripts",
        "id",
        "id",
        "transcript",
        &meeting_id,
        from,
        to,
    )
    .await?;
    total += replace_text_column(
        &mut tx,
        "meeting_record_blocks",
        "id",
        "id",
        "text",
        &meeting_id,
        from,
        to,
    )
    .await?;
    total += replace_text_column(
        &mut tx,
        "meeting_documents",
        "CAST(rowid AS TEXT)",
        "CAST(rowid AS TEXT)",
        "markdown",
        &meeting_id,
        from,
        to,
    )
    .await?;
    total += replace_text_column(
        &mut tx,
        "document_generation_jobs",
        "id",
        "id",
        "result_markdown",
        &meeting_id,
        from,
        to,
    )
    .await?;
    total += replace_json_column(
        &mut tx,
        "transcript_versions",
        "version_kind",
        "segments_json",
        &meeting_id,
        from,
        to,
    )
    .await?;
    total += replace_json_column(
        &mut tx,
        "transcript_refinements",
        "meeting_id",
        "result_json",
        &meeting_id,
        from,
        to,
    )
    .await?;
    total += replace_json_column(
        &mut tx,
        "summary_processes",
        "meeting_id",
        "result",
        &meeting_id,
        from,
        to,
    )
    .await?;

    let record_document: Option<String> =
        sqlx::query_scalar("SELECT document_markdown FROM meeting_record_state WHERE meeting_id=?")
            .bind(&meeting_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?
            .flatten();
    if let Some(document) = record_document {
        let count = replace_count(&document, from);
        if count > 0 {
            sqlx::query("UPDATE meeting_record_state SET document_markdown=?,version=version+1,updated_at=? WHERE meeting_id=?")
                .bind(document.replace(from, to))
                .bind(&now)
                .bind(&meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            total += count;
        }
    }

    let source_hash = current_record_source_hash(&mut tx, &meeting_id).await?;
    sqlx::query("UPDATE meeting_record_state SET source_hash=?,updated_at=? WHERE meeting_id=?")
        .bind(source_hash)
        .bind(&now)
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(total)
}

#[tauri::command]
pub async fn api_restore_previous_meeting_document<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    kind: String,
    context_key: Option<String>,
) -> Result<MeetingDocument, String> {
    validate_kind(&kind)?;
    let key = context_key.unwrap_or_default();
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query("UPDATE meeting_documents SET markdown=previous_markdown,previous_markdown=markdown,updated_at=? WHERE meeting_id=? AND kind=? AND context_key=? AND previous_markdown IS NOT NULL")
        .bind(now).bind(&meeting_id).bind(&kind).bind(&key).execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    if result.rows_affected() == 0 {
        return Err("No previous document version is available".into());
    }
    api_get_meeting_document(_app, state, meeting_id, kind, Some(key))
        .await?
        .ok_or_else(|| "Failed to read restored document".into())
}

async fn list_tags(
    pool: &sqlx::SqlitePool,
    meeting_id: Option<&str>,
) -> Result<Vec<MeetingTag>, String> {
    let query = if meeting_id.is_some() {
        "SELECT t.id,t.name,t.color,(SELECT COUNT(*) FROM meeting_tag_links x WHERE x.tag_id=t.id) AS meeting_count FROM meeting_tags t JOIN meeting_tag_links l ON l.tag_id=t.id WHERE l.meeting_id=? ORDER BY t.name COLLATE NOCASE"
    } else {
        "SELECT t.id,t.name,t.color,(SELECT COUNT(*) FROM meeting_tag_links x WHERE x.tag_id=t.id) AS meeting_count FROM meeting_tags t ORDER BY t.name COLLATE NOCASE"
    };
    let mut sql = sqlx::query_as::<_, MeetingTag>(query);
    if let Some(id) = meeting_id {
        sql = sql.bind(id);
    }
    sql.fetch_all(pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_list_meeting_tags<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: Option<String>,
) -> Result<Vec<MeetingTag>, String> {
    list_tags(state.db_manager.pool(), meeting_id.as_deref()).await
}

#[tauri::command]
pub async fn api_create_meeting_tag<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    name: String,
    color: String,
) -> Result<MeetingTag, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Tag name cannot be empty".into());
    }
    let id = format!("tag-{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO meeting_tags (id,name,color,created_at,updated_at) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&color)
    .bind(&now)
    .bind(&now)
    .execute(state.db_manager.pool())
    .await
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "A tag with this name already exists".into()
        } else {
            e.to_string()
        }
    })?;
    Ok(MeetingTag {
        id,
        name: name.into(),
        color,
        meeting_count: 0,
    })
}

#[tauri::command]
pub async fn api_update_meeting_tag<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    tag_id: String,
    name: String,
    color: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("Tag name cannot be empty".into());
    }
    sqlx::query("UPDATE meeting_tags SET name=?,color=?,updated_at=? WHERE id=?")
        .bind(name.trim())
        .bind(color)
        .bind(Utc::now().to_rfc3339())
        .bind(tag_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_delete_meeting_tag<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    tag_id: String,
) -> Result<(), String> {
    sqlx::query("DELETE FROM meeting_tags WHERE id=?")
        .bind(tag_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_set_meeting_tag<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    tag_id: String,
    assigned: bool,
) -> Result<(), String> {
    if assigned {
        sqlx::query(
            "INSERT OR IGNORE INTO meeting_tag_links (meeting_id,tag_id,created_at) VALUES (?,?,?)",
        )
        .bind(meeting_id)
        .bind(tag_id)
        .bind(Utc::now().to_rfc3339())
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM meeting_tag_links WHERE meeting_id=? AND tag_id=?")
            .bind(meeting_id)
            .bind(tag_id)
            .execute(state.db_manager.pool())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn api_list_document_templates<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    kind: String,
) -> Result<Vec<DocumentTemplate>, String> {
    validate_kind(&kind)?;
    sqlx::query_as::<_, DocumentTemplate>("SELECT id,kind,name,description,prompt,builtin FROM document_templates WHERE kind=? ORDER BY builtin DESC,name COLLATE NOCASE")
        .bind(kind).fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_save_document_template<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    id: Option<String>,
    kind: String,
    name: String,
    description: String,
    prompt: String,
) -> Result<DocumentTemplate, String> {
    validate_kind(&kind)?;
    if name.trim().is_empty() || prompt.trim().is_empty() {
        return Err("Template name and prompt are required".into());
    }
    let id = id.unwrap_or_else(|| format!("template-{}", Uuid::new_v4()));
    let now = Utc::now().to_rfc3339();
    let builtin: i64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT builtin FROM document_templates WHERE id=?),0)",
    )
    .bind(&id)
    .fetch_one(state.db_manager.pool())
    .await
    .map_err(|e| e.to_string())?;
    if builtin != 0 {
        return Err("Built-in templates cannot be edited. Duplicate it first.".into());
    }
    sqlx::query("INSERT INTO document_templates (id,kind,name,description,prompt,builtin,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,description=excluded.description,prompt=excluded.prompt,updated_at=excluded.updated_at")
        .bind(&id).bind(&kind).bind(name.trim()).bind(description.trim()).bind(prompt.trim()).bind(&now).bind(&now)
        .execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    Ok(DocumentTemplate {
        id,
        kind,
        name: name.trim().into(),
        description: description.trim().into(),
        prompt: prompt.trim().into(),
        builtin: false,
    })
}

#[tauri::command]
pub async fn api_delete_document_template<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    template_id: String,
) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM document_templates WHERE id=? AND builtin=0")
        .bind(template_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    if result.rows_affected() == 0 {
        return Err("Built-in templates cannot be deleted".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn api_get_generation_preference<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    kind: String,
) -> Result<Option<GenerationPreference>, String> {
    sqlx::query_as::<_, GenerationPreference>("SELECT meeting_id,kind,language,template_id,provider,model,parameters_json FROM generation_preferences WHERE meeting_id=? AND kind=?")
        .bind(meeting_id).bind(kind).fetch_optional(state.db_manager.pool()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_save_generation_preference<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    preference: GenerationPreference,
) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&preference.parameters_json)
        .map_err(|_| "Generation parameters must be valid JSON")?;
    sqlx::query("INSERT INTO generation_preferences (meeting_id,kind,language,template_id,provider,model,parameters_json,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(meeting_id,kind) DO UPDATE SET language=excluded.language,template_id=excluded.template_id,provider=excluded.provider,model=excluded.model,parameters_json=excluded.parameters_json,updated_at=excluded.updated_at")
        .bind(preference.meeting_id).bind(preference.kind).bind(preference.language).bind(preference.template_id)
        .bind(preference.provider).bind(preference.model).bind(preference.parameters_json).bind(Utc::now().to_rfc3339())
        .execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_link_meeting_calendar_event<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    event_id: Option<String>,
    replace_existing: Option<bool>,
    link_method: Option<String>,
    sync_schedule: Option<bool>,
    expected_occupied_meeting_id: Option<String>,
    expected_current_event_id: Option<String>,
) -> Result<CalendarLinkResult, String> {
    set_calendar_link(
        state.db_manager.pool(),
        meeting_id,
        event_id,
        replace_existing.unwrap_or(false),
        link_method.unwrap_or_else(|| "manual".into()),
        sync_schedule.unwrap_or(false),
        expected_occupied_meeting_id,
        expected_current_event_id,
    )
    .await
}

async fn set_calendar_link(
    pool: &SqlitePool,
    meeting_id: String,
    event_id: Option<String>,
    replace_existing: bool,
    link_method: String,
    sync_schedule: bool,
    expected_occupied_meeting_id: Option<String>,
    expected_current_event_id: Option<String>,
) -> Result<CalendarLinkResult, String> {
    if !["manual", "recording", "suggested"].contains(&link_method.as_str()) {
        return Err("Invalid calendar link method".into());
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;

    let meeting_exists = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM meetings WHERE id=?")
        .bind(&meeting_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if meeting_exists == 0 {
        return Err("Meeting not found".into());
    }
    if let Some(expected) = expected_current_event_id {
        let current = sqlx::query_scalar::<_, String>(
            "SELECT calendar_event_id FROM meeting_calendar_links WHERE meeting_id=?",
        )
        .bind(&meeting_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if current.as_deref().unwrap_or("") != expected {
            return Err("CALENDAR_LINK_CHANGED".into());
        }
    }

    let event = if let Some(id) = event_id.as_ref() {
        Some(sqlx::query_as::<_, crate::calendar_integration::CalendarEvent>("SELECT id,source,external_id,calendar_name,title,start_at,end_at,location,notes,meeting_id,calendar_id,href,etag,all_day FROM calendar_events WHERE id=?")
            .bind(id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?.ok_or("Calendar event not found")?)
    } else {
        None
    };
    let incumbent = if let Some(id) = event_id.as_ref() {
        sqlx::query_scalar::<_, String>("SELECT meeting_id FROM meeting_calendar_links WHERE calendar_event_id=? AND meeting_id<>?")
            .bind(id).bind(&meeting_id).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?
    } else {
        None
    };
    if incumbent.is_some() && !replace_existing {
        return Err("CALENDAR_LINK_CONFLICT".into());
    }
    if replace_existing && incumbent != expected_occupied_meeting_id {
        return Err("CALENDAR_LINK_CHANGED".into());
    }
    let revision = Utc::now().timestamp_micros();

    // Remove this meeting's old pair first. If the selected event is occupied,
    // an explicit transfer also clears the previous meeting's projection.
    sqlx::query("UPDATE calendar_events SET meeting_id=NULL WHERE id IN (SELECT calendar_event_id FROM meeting_calendar_links WHERE meeting_id=?)")
        .bind(&meeting_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM meeting_calendar_links WHERE meeting_id=?")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE meetings SET calendar_event_id=NULL,updated_at=? WHERE id=?")
        .bind(Utc::now().to_rfc3339())
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(previous) = incumbent.as_ref() {
        sqlx::query("UPDATE meetings SET calendar_event_id=NULL,updated_at=? WHERE id=?")
            .bind(Utc::now().to_rfc3339())
            .bind(previous)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM meeting_calendar_links WHERE meeting_id=?")
            .bind(previous)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    // Also repair any contradictory projection left by an older build.
    if let Some(id) = event_id.as_ref() {
        sqlx::query("UPDATE meetings SET calendar_event_id=NULL,updated_at=? WHERE calendar_event_id=? AND id<>?")
            .bind(Utc::now().to_rfc3339()).bind(id).bind(&meeting_id).execute(&mut *tx).await.map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO meeting_calendar_links(meeting_id,calendar_event_id,link_method,sync_schedule,revision,linked_at,updated_at) VALUES(?,?,?,?,?,?,?)")
            .bind(&meeting_id).bind(id).bind(&link_method)
            .bind(sync_schedule).bind(revision).bind(&now).bind(&now)
            .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        sqlx::query("UPDATE calendar_events SET meeting_id=? WHERE id=?")
            .bind(&meeting_id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if sync_schedule {
            let selected = event.as_ref().expect("event checked above");
            sqlx::query("UPDATE meetings SET calendar_event_id=?,meeting_start_time=?,meeting_end_time=?,updated_at=? WHERE id=?")
                .bind(id).bind(&selected.start_at).bind(&selected.end_at).bind(&now).bind(&meeting_id)
                .execute(&mut *tx).await.map_err(|e| e.to_string())?;
        } else {
            sqlx::query("UPDATE meetings SET calendar_event_id=?,updated_at=? WHERE id=?")
                .bind(id)
                .bind(&now)
                .bind(&meeting_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    sqlx::query("UPDATE meeting_calendar_link_legacy_claims SET resolved=1 WHERE meeting_id=?")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let event = event.map(|mut event| {
        event.meeting_id = Some(meeting_id);
        event
    });
    Ok(CalendarLinkResult {
        event,
        displaced_meeting_id: incumbent,
        revision,
    })
}

#[tauri::command]
pub async fn api_get_linked_calendar_event<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<crate::calendar_integration::CalendarEvent>, String> {
    let event_id: Option<String> =
        sqlx::query("SELECT calendar_event_id FROM meeting_calendar_links WHERE meeting_id=?")
            .bind(&meeting_id)
            .fetch_optional(state.db_manager.pool())
            .await
            .map_err(|e| e.to_string())?
            .and_then(|row| row.get("calendar_event_id"));
    let Some(event_id) = event_id else {
        return Ok(None);
    };
    sqlx::query_as::<_, crate::calendar_integration::CalendarEvent>("SELECT id,source,external_id,calendar_name,title,start_at,end_at,location,notes,meeting_id,calendar_id,href,etag,all_day FROM calendar_events WHERE id=?")
        .bind(event_id).fetch_optional(state.db_manager.pool()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_get_calendar_link_candidates<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: Option<String>,
    center_time: Option<String>,
    title: Option<String>,
    query: Option<String>,
) -> Result<Vec<CalendarLinkCandidate>, String> {
    load_calendar_link_candidates(
        state.db_manager.pool(),
        meeting_id,
        center_time,
        title,
        query,
    )
    .await
}

async fn load_calendar_link_candidates(
    pool: &SqlitePool,
    meeting_id: Option<String>,
    center_time: Option<String>,
    title: Option<String>,
    query: Option<String>,
) -> Result<Vec<CalendarLinkCandidate>, String> {
    let (title, center_raw) = if let Some(id) = meeting_id.as_ref() {
        let row = sqlx::query("SELECT title,COALESCE(meeting_start_time,created_at) AS center FROM meetings WHERE id=?")
            .bind(id).fetch_optional(pool).await.map_err(|e| e.to_string())?.ok_or("Meeting not found")?;
        (
            row.get::<String, _>("title"),
            row.get::<String, _>("center"),
        )
    } else {
        (
            title.unwrap_or_default(),
            center_time.unwrap_or_else(|| Utc::now().to_rfc3339()),
        )
    };
    let center = chrono::DateTime::parse_from_rfc3339(&center_raw)
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    let start = (center - chrono::Duration::days(7)).to_rfc3339();
    let end = (center + chrono::Duration::days(7)).to_rfc3339();
    let query = query.unwrap_or_default().trim().to_owned();
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let events = sqlx::query_as::<_, crate::calendar_integration::CalendarEvent>("SELECT e.id,e.source,e.external_id,e.calendar_name,e.title,e.start_at,e.end_at,e.location,e.notes,e.meeting_id,e.calendar_id,e.href,e.etag,e.all_day FROM calendar_events e LEFT JOIN calendar_collections c ON c.id=e.calendar_id WHERE ((c.enabled=1 OR e.calendar_id IS NULL) AND ((?='' AND e.start_at>=? AND e.start_at<?) OR (?<>'' AND (e.title LIKE ? ESCAPE '\\' OR e.calendar_name LIKE ? ESCAPE '\\')))) OR e.id IN (SELECT calendar_event_id FROM meeting_calendar_links WHERE meeting_id=?) ORDER BY ABS(julianday(e.start_at)-julianday(?)) LIMIT 300")
        .bind(&query).bind(start).bind(end).bind(&query).bind(&pattern).bind(&pattern).bind(meeting_id.as_deref().unwrap_or("")).bind(center.to_rfc3339())
        .fetch_all(pool).await.map_err(|e| e.to_string())?;
    let occupancies=sqlx::query_as::<_,(String,String,String)>("SELECT l.calendar_event_id,m.id,m.title FROM meeting_calendar_links l JOIN meetings m ON m.id=l.meeting_id")
        .fetch_all(pool).await.map_err(|e|e.to_string())?.into_iter().map(|(event,id,title)|(event,(id,title))).collect::<HashMap<_,_>>();
    let title_chars = title
        .to_lowercase()
        .chars()
        .filter(|v| v.is_alphanumeric())
        .collect::<std::collections::HashSet<_>>();
    let mut result = Vec::with_capacity(events.len());
    for event in events {
        let Ok(event_time) =
            chrono::DateTime::parse_from_rfc3339(&event.start_at).map(|v| v.with_timezone(&Utc))
        else {
            continue;
        };
        let minutes = (event_time - center).num_minutes().abs();
        let mut score = if minutes <= 30 {
            70
        } else if minutes <= 120 {
            55
        } else if minutes <= 1440 {
            35
        } else {
            10
        };
        let mut reasons = vec![if minutes <= 120 {
            "time_close".into()
        } else {
            "same_week".into()
        }];
        let event_end = event
            .end_at
            .as_ref()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|v| v.with_timezone(&Utc))
            .unwrap_or(event_time + chrono::Duration::hours(1));
        if !event.all_day
            && center >= event_time - chrono::Duration::minutes(15)
            && center <= event_end + chrono::Duration::minutes(30)
        {
            score = 90;
            reasons = vec!["time_overlap".into()];
        } else if event.all_day {
            score = 20;
        }
        let event_chars = event
            .title
            .to_lowercase()
            .chars()
            .filter(|v| v.is_alphanumeric())
            .collect::<std::collections::HashSet<_>>();
        let overlap = title_chars.intersection(&event_chars).count();
        if overlap > 0 {
            score += ((overlap * 30) / title_chars.len().max(event_chars.len()).max(1)) as i64;
            reasons.push("title_similar".into());
        }
        let occupied = occupancies.get(&event.id).cloned();
        if occupied
            .as_ref()
            .is_some_and(|(id, _)| Some(id) == meeting_id.as_ref())
        {
            score += 100;
            reasons.push("currently_linked".into());
        }
        result.push(CalendarLinkCandidate {
            event,
            score,
            reason_codes: reasons,
            occupied_by_meeting_id: occupied.as_ref().map(|v| v.0.clone()),
            occupied_by_title: occupied.map(|v| v.1),
        });
    }
    result.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.event.start_at.cmp(&b.event.start_at))
    });
    Ok(result)
}

#[tauri::command]
pub async fn api_get_calendar_link_review_count<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<i64, String> {
    sqlx::query_scalar("SELECT COUNT(*) FROM meeting_calendar_link_legacy_claims WHERE meeting_id=? AND resolved=0")
        .bind(meeting_id).fetch_one(state.db_manager.pool()).await.map_err(|e|e.to_string())
}

#[tauri::command]
pub async fn api_get_meeting_audio_path<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<String>, String> {
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id=?")
        .bind(meeting_id)
        .fetch_optional(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = Path::new(&folder);
    if path.is_file() {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| e.to_string())?;
        return Ok(Some(folder));
    }
    if !path.is_dir() {
        return Ok(None);
    }
    let selected = find_meeting_audio_file(path);
    if let Some(file) = selected.as_deref() {
        app.asset_protocol_scope()
            .allow_file(file)
            .map_err(|e| e.to_string())?;
    }
    Ok(selected.map(|file| file.to_string_lossy().to_string()))
}

/// Create a seekable M4A playback copy for recordings produced by older
/// CalMee builds. The original MP4 is deliberately retained as a rollback
/// source; this command never modifies arbitrary imported audio files.
#[tauri::command]
pub async fn api_repair_legacy_meeting_audio<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<String, String> {
    let folder: Option<String> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id=?")
        .bind(&meeting_id)
        .fetch_optional(state.db_manager.pool())
        .await
        .map_err(|error| error.to_string())?
        .flatten();
    let folder = folder.ok_or_else(|| "Meeting audio folder is unavailable".to_string())?;
    let stored_path = PathBuf::from(folder);
    let folder = resolve_legacy_repair_folder(&stored_path)?;

    let destination = folder.join("audio.m4a");
    if destination
        .metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        app.asset_protocol_scope()
            .allow_file(&destination)
            .map_err(|error| error.to_string())?;
        return Ok(destination.to_string_lossy().to_string());
    }

    let source = folder.join("audio.mp4");
    if !source
        .metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        return Err("No legacy CalMee MP4 recording was found".to_string());
    }

    let repair_folder = folder.clone();
    let repaired = tokio::task::spawn_blocking(move || repair_legacy_mp4(&repair_folder))
        .await
        .map_err(|error| format!("Audio repair task failed: {error}"))??;
    // Older/manual attachment flows may have replaced the meeting folder with
    // the concrete MP4 path. Restore the durable folder reference only after
    // the repaired copy has been verified and activated.
    if stored_path.is_file() {
        sqlx::query("UPDATE meetings SET folder_path=?, updated_at=? WHERE id=?")
            .bind(folder.to_string_lossy().to_string())
            .bind(chrono::Utc::now())
            .bind(&meeting_id)
            .execute(state.db_manager.pool())
            .await
            .map_err(|error| {
                format!("Audio was repaired, but its meeting link could not be updated: {error}")
            })?;
    }
    app.asset_protocol_scope()
        .allow_file(&repaired)
        .map_err(|error| error.to_string())?;
    Ok(repaired.to_string_lossy().to_string())
}

fn resolve_legacy_repair_folder(stored_path: &Path) -> Result<PathBuf, String> {
    if stored_path.is_dir() {
        return Ok(stored_path.to_path_buf());
    }
    let is_legacy_audio = stored_path.is_file()
        && stored_path.file_name().and_then(|name| name.to_str()) == Some("audio.mp4");
    let Some(parent) = stored_path.parent() else {
        return Err("Only recordings managed by CalMee can be repaired".to_string());
    };
    if is_legacy_audio && parent.join("metadata.json").is_file() {
        return Ok(parent.to_path_buf());
    }
    Err("Only recordings managed by CalMee can be repaired".to_string())
}

fn repair_legacy_mp4(folder: &Path) -> Result<PathBuf, String> {
    let source = folder.join("audio.mp4");
    let destination = folder.join("audio.m4a");
    let temporary = folder.join(".audio-repair.m4a");
    let ffmpeg = crate::audio::ffmpeg::find_ffmpeg_path()
        .ok_or_else(|| "FFmpeg is unavailable; the recording was not changed".to_string())?;

    let _ = std::fs::remove_file(&temporary);
    let output = std::process::Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            source
                .to_str()
                .ok_or_else(|| "Invalid recording path".to_string())?,
            "-map",
            "0:a:0",
            "-c:a",
            "copy",
            "-movflags",
            "+faststart",
            "-f",
            "ipod",
            "-y",
            temporary
                .to_str()
                .ok_or_else(|| "Invalid repair path".to_string())?,
        ])
        .output()
        .map_err(|error| format!("Could not start audio repair: {error}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!(
            "Could not repair the playback copy: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !temporary
        .metadata()
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&temporary);
        return Err("The repaired playback copy was empty".to_string());
    }
    if destination.exists() {
        std::fs::remove_file(&destination)
            .map_err(|error| format!("Could not replace incomplete playback copy: {error}"))?;
    }
    std::fs::rename(&temporary, &destination)
        .map_err(|error| format!("Could not activate repaired audio: {error}"))?;
    if let Err(error) = update_metadata_audio_file(folder, "audio.m4a") {
        log::warn!("Repaired audio is playable but metadata could not be updated: {error}");
    }
    Ok(destination)
}

fn update_metadata_audio_file(folder: &Path, audio_file: &str) -> Result<(), String> {
    let metadata_path = folder.join("metadata.json");
    if !metadata_path.is_file() {
        return Ok(());
    }
    let mut metadata: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    metadata["audio_file"] = serde_json::Value::String(audio_file.to_string());
    let temporary = folder.join(".metadata.json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    std::fs::rename(temporary, metadata_path).map_err(|error| error.to_string())
}

fn find_meeting_audio_file(folder: &Path) -> Option<PathBuf> {
    if let Ok(content) = std::fs::read_to_string(folder.join("metadata.json")) {
        if let Ok(metadata) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(name) = metadata.get("audio_file").and_then(|value| value.as_str()) {
                let relative = Path::new(name);
                if relative.file_name() == Some(relative.as_os_str()) {
                    let candidate = folder.join(relative);
                    if candidate.is_file()
                        && candidate
                            .metadata()
                            .map(|metadata| metadata.len() > 0)
                            .unwrap_or(false)
                    {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    for name in [
        "audio.m4a",
        "audio.mp4",
        "audio.wav",
        "audio.flac",
        "audio.mp3",
    ] {
        let candidate = folder.join(name);
        if candidate.is_file()
            && candidate
                .metadata()
                .map(|metadata| metadata.len() > 0)
                .unwrap_or(false)
        {
            return Some(candidate);
        }
    }

    let extensions = [
        "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "mp4", "mov", "webm",
    ];
    let mut candidates = std::fs::read_dir(folder)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file = entry.path();
            let extension = file.extension()?.to_str()?.to_ascii_lowercase();
            if !extensions.contains(&extension.as_str()) {
                return None;
            }
            let size = entry.metadata().ok()?.len();
            (size > 0).then_some((size, file))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    candidates.into_iter().next().map(|(_, file)| file)
}

#[cfg(test)]
mod meeting_audio_file_tests {
    use super::{
        find_meeting_audio_file, resolve_legacy_repair_folder, update_metadata_audio_file,
    };

    #[test]
    fn metadata_audio_file_is_authoritative() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("audio.m4a"), b"new").unwrap();
        std::fs::write(directory.path().join("other.mp4"), vec![0_u8; 128]).unwrap();
        std::fs::write(
            directory.path().join("metadata.json"),
            r#"{"audio_file":"audio.m4a"}"#,
        )
        .unwrap();

        assert_eq!(
            find_meeting_audio_file(directory.path()).unwrap(),
            directory.path().join("audio.m4a")
        );
    }

    #[test]
    fn m4a_precedes_legacy_mp4_without_metadata() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("audio.mp4"), vec![0_u8; 128]).unwrap();
        std::fs::write(directory.path().join("audio.m4a"), b"new").unwrap();

        assert_eq!(
            find_meeting_audio_file(directory.path()).unwrap(),
            directory.path().join("audio.m4a")
        );
    }

    #[test]
    fn unsafe_metadata_path_is_ignored() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("audio.mp4"), b"legacy").unwrap();
        std::fs::write(
            directory.path().join("metadata.json"),
            r#"{"audio_file":"../outside.m4a"}"#,
        )
        .unwrap();

        assert_eq!(
            find_meeting_audio_file(directory.path()).unwrap(),
            directory.path().join("audio.mp4")
        );
    }

    #[test]
    fn metadata_audio_name_is_updated_without_losing_other_fields() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("metadata.json"),
            r#"{"meeting_name":"Design review","audio_file":"audio.mp4"}"#,
        )
        .unwrap();

        update_metadata_audio_file(directory.path(), "audio.m4a").unwrap();

        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.path().join("metadata.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["meeting_name"], "Design review");
        assert_eq!(metadata["audio_file"], "audio.m4a");
    }

    #[test]
    fn legacy_managed_audio_file_resolves_back_to_its_meeting_folder() {
        let directory = tempfile::tempdir().unwrap();
        let audio = directory.path().join("audio.mp4");
        std::fs::write(&audio, b"legacy audio").unwrap();
        std::fs::write(directory.path().join("metadata.json"), b"{}").unwrap();

        assert_eq!(
            resolve_legacy_repair_folder(&audio).unwrap(),
            directory.path()
        );
    }

    #[test]
    fn arbitrary_external_mp4_is_not_treated_as_a_managed_recording() {
        let directory = tempfile::tempdir().unwrap();
        let audio = directory.path().join("audio.mp4");
        std::fs::write(&audio, b"external audio").unwrap();

        assert!(resolve_legacy_repair_folder(&audio).is_err());
    }
}

#[tauri::command]
pub async fn api_get_meeting_speaker_options<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Vec<MeetingSpeakerOption>, String> {
    let rows = sqlx::query("SELECT b.local_speaker,b.person_id,p.name AS person_name,COUNT(*) AS segment_count FROM meeting_record_blocks b LEFT JOIN people p ON p.id=b.person_id WHERE b.meeting_id=? GROUP BY b.local_speaker,b.person_id,p.name ORDER BY MIN(b.sequence)")
        .bind(meeting_id).fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    // One saved participant may own several local Speaker labels in the same
    // meeting. Present that person only once and add the segment counts; local
    // unbound speakers remain separate choices.
    let mut options: Vec<MeetingSpeakerOption> = Vec::new();
    let mut indexes: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let person_id: Option<String> = row.get("person_id");
        let local_speaker: Option<String> = row.get("local_speaker");
        let key = person_id.clone().unwrap_or_else(|| {
            format!(
                "local:{}",
                local_speaker.clone().unwrap_or_else(|| "speaker".into())
            )
        });
        let name = row
            .get::<Option<String>, _>("person_name")
            .or_else(|| local_speaker.clone())
            .unwrap_or_else(|| "Speaker".into());
        let segment_count: i64 = row.get("segment_count");
        if let Some(index) = indexes.get(&key).copied() {
            options[index].segment_count += segment_count;
            if options[index].person_id.is_some() {
                options[index].local_speaker = None;
            }
            continue;
        }
        indexes.insert(key.clone(), options.len());
        options.push(MeetingSpeakerOption {
            key,
            name,
            local_speaker,
            person_id,
            segment_count,
        });
    }
    Ok(options)
}
