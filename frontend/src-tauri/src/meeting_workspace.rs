use crate::state::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Row};
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

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

    api_get_meeting_notes(state, meeting_id)
        .await?
        .ok_or_else(|| "Failed to read saved meeting notes".to_string())
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
    if markdown.trim().is_empty() {
        return Err("Document cannot be empty".into());
    }
    let context_key = context_key.unwrap_or_default();
    let language = language.unwrap_or_else(|| "auto".into());
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO meeting_documents (meeting_id,kind,context_key,markdown,language,template_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(meeting_id,kind,context_key) DO UPDATE SET previous_markdown=CASE WHEN meeting_documents.markdown<>excluded.markdown THEN meeting_documents.markdown ELSE meeting_documents.previous_markdown END,markdown=excluded.markdown,language=excluded.language,template_id=excluded.template_id,updated_at=excluded.updated_at")
        .bind(&meeting_id).bind(&kind).bind(&context_key).bind(markdown.trim()).bind(&language).bind(&template_id).bind(&now).bind(&now)
        .execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
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
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE calendar_events SET meeting_id=NULL WHERE meeting_id=?")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE meetings SET calendar_event_id=?,updated_at=? WHERE id=?")
        .bind(&event_id)
        .bind(Utc::now().to_rfc3339())
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(id) = event_id {
        let result = sqlx::query("UPDATE calendar_events SET meeting_id=? WHERE id=?")
            .bind(&meeting_id)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if result.rows_affected() == 0 {
            return Err("Calendar event not found".into());
        }
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_get_linked_calendar_event<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
) -> Result<Option<crate::calendar_integration::CalendarEvent>, String> {
    let event_id: Option<String> = sqlx::query("SELECT calendar_event_id FROM meetings WHERE id=?")
        .bind(meeting_id)
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
    let extensions = [
        "wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "mp4", "mov", "webm",
    ];
    let mut candidates = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file = entry.path();
            let extension = file.extension()?.to_str()?.to_ascii_lowercase();
            if !extensions.contains(&extension.as_str()) {
                return None;
            }
            let size = entry.metadata().ok()?.len();
            Some((size, file.to_string_lossy().to_string()))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    let selected = candidates.into_iter().next().map(|(_, file)| file);
    if let Some(file) = selected.as_deref() {
        app.asset_protocol_scope()
            .allow_file(file)
            .map_err(|e| e.to_string())?;
    }
    Ok(selected)
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
