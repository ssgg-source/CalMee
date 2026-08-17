use crate::state::AppState;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use regex::Regex;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use std::collections::HashMap;
use std::process::Command;
use tauri::{AppHandle, Runtime};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSettings {
    pub local_enabled: bool,
    pub caldav_enabled: bool,
    pub caldav_url: Option<String>,
    pub caldav_username: Option<String>,
    pub caldav_password: Option<String>,
    pub caldav_calendar_path: Option<String>,
    pub sync_mode: String,
    pub last_sync_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub source: String,
    pub external_id: String,
    pub calendar_name: Option<String>,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub meeting_id: Option<String>,
    pub calendar_id: Option<String>,
    pub href: Option<String>,
    pub etag: Option<String>,
    pub all_day: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCollection {
    pub id: String,
    pub source: String,
    pub account_key: String,
    pub href: String,
    pub name: String,
    pub color: String,
    pub read_only: bool,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventInput {
    pub id: Option<String>,
    pub calendar_id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub all_day: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalMeetingImportResult {
    pub meeting_id: String,
    pub transcript_blocks: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct ExternalTranscriptBlock {
    speaker: Option<String>,
    start_seconds: Option<f64>,
    text: String,
}

fn transcript_seconds(value: &str) -> Option<f64> {
    let parts = value
        .trim()
        .split(':')
        .map(str::parse::<f64>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    match parts.as_slice() {
        [minutes, seconds] => Some(minutes * 60.0 + seconds),
        [hours, minutes, seconds] => Some(hours * 3600.0 + minutes * 60.0 + seconds),
        _ => None,
    }
}

fn clean_external_speaker(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .trim_matches(|character: char| {
            character.is_whitespace()
                || matches!(
                    character,
                    '*' | '_' | '#' | '-' | '🟢' | '🟣' | '🔵' | '🟡' | '🟠' | '🔴'
                )
        })
        .trim()
        .trim_end_matches("(我)")
        .trim_end_matches("（我）")
        .trim()
        .to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn blocks_from_matches(
    content: &str,
    regex: &Regex,
    inline_text_group: Option<&str>,
) -> Vec<ExternalTranscriptBlock> {
    let matches = regex.captures_iter(content).collect::<Vec<_>>();
    let mut blocks = Vec::new();
    for (index, captures) in matches.iter().enumerate() {
        let whole = captures.get(0).expect("regex match exists");
        let following_end = matches
            .get(index + 1)
            .and_then(|next| next.get(0))
            .map(|next| next.start())
            .unwrap_or(content.len());
        let inline = inline_text_group
            .and_then(|group| captures.name(group))
            .map(|value| value.as_str().trim())
            .unwrap_or_default();
        let continuation = content[whole.end()..following_end].trim();
        let text = match (inline.is_empty(), continuation.is_empty()) {
            (false, false) => format!("{}\n{}", inline, continuation),
            (false, true) => inline.to_string(),
            (true, false) => continuation.to_string(),
            (true, true) => String::new(),
        };
        if text.is_empty() {
            continue;
        }
        blocks.push(ExternalTranscriptBlock {
            speaker: captures
                .name("speaker")
                .and_then(|value| clean_external_speaker(value.as_str())),
            start_seconds: captures
                .name("time")
                .and_then(|value| transcript_seconds(value.as_str())),
            text,
        });
    }
    blocks
}

fn parse_external_transcript(content: &str) -> Vec<ExternalTranscriptBlock> {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");

    // A common external recording export, for example:
    // “🟣 鲁立 [00:05:16]” followed by the utterance on the next line.
    let bracket_header = Regex::new(
        r"(?m)^[ \t]*(?P<speaker>[^\n\[\]]{1,48}?)\s*\[(?P<time>\d{1,2}:\d{2}(?::\d{2})?)\][ \t]*$",
    )
    .expect("valid transcript header regex");
    let blocks = blocks_from_matches(&normalized, &bracket_header, None);
    if !blocks.is_empty() {
        return blocks;
    }

    // Plain-text exports, for example: “鲁立 00:00:04 发言内容”。
    let inline_header = Regex::new(
        r"(?m)^[ \t]*(?P<speaker>[^\n]{1,40}?)[ \t]+(?P<time>\d{1,2}:\d{2}:\d{2})[ \t]+(?P<text>[^\n]+)$",
    )
    .expect("valid inline transcript regex");
    let blocks = blocks_from_matches(&normalized, &inline_header, Some("text"));
    if !blocks.is_empty() {
        return blocks;
    }

    // Older exports place the participant name and timestamp on separate lines.
    let split_header = Regex::new(
        r"(?m)^(?:[ \t]*[^\n\d:]{1,4}[ \t]*\n)?[ \t]*(?P<speaker>[^\n]{1,40})[ \t]*\n[ \t]*(?P<time>\d{1,2}:\d{2}:\d{2})[ \t]*$",
    )
    .expect("valid split transcript regex");
    let blocks = blocks_from_matches(&normalized, &split_header, None);
    if !blocks.is_empty() {
        return blocks;
    }

    normalized
        .split("\n\n")
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| ExternalTranscriptBlock {
            speaker: None,
            start_seconds: None,
            text: text.to_string(),
        })
        .collect()
}

fn generic_speaker_number(value: &str) -> Option<String> {
    Regex::new(r"(?i)^(?:speaker|说话人)\s*([0-9]+)$")
        .expect("valid generic speaker regex")
        .captures(value.trim())
        .and_then(|captures| captures.get(1))
        .map(|number| number.as_str().to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeEvent {
    uid: String,
    calendar: String,
    title: String,
    start_ms: i64,
    end_ms: i64,
    location: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NativeCalendar {
    name: String,
}

#[derive(Debug, Deserialize)]
struct NativePayload {
    calendars: Vec<NativeCalendar>,
    events: Vec<NativeEvent>,
}

async fn read_settings(pool: &SqlitePool) -> Result<CalendarSettings, String> {
    sqlx::query_as::<_, CalendarSettings>("SELECT local_enabled,caldav_enabled,caldav_url,caldav_username,caldav_password,caldav_calendar_path,sync_mode,last_sync_at FROM calendar_settings WHERE id='default'")
        .fetch_one(pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_get_calendar_settings<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<CalendarSettings, String> {
    read_settings(state.db_manager.pool()).await
}

#[tauri::command]
pub async fn api_save_calendar_settings<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    settings: CalendarSettings,
) -> Result<(), String> {
    sqlx::query("UPDATE calendar_settings SET local_enabled=?,caldav_enabled=?,caldav_url=?,caldav_username=?,caldav_password=?,caldav_calendar_path=?,sync_mode=?,updated_at=? WHERE id='default'")
        .bind(settings.local_enabled).bind(settings.caldav_enabled).bind(settings.caldav_url)
        .bind(settings.caldav_username).bind(settings.caldav_password).bind(settings.caldav_calendar_path)
        .bind(settings.sync_mode).bind(Utc::now().to_rfc3339())
        .execute(state.db_manager.pool()).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_get_calendar_events<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    start_at: String,
    end_at: String,
) -> Result<Vec<CalendarEvent>, String> {
    sqlx::query_as::<_, CalendarEvent>("SELECT id,source,external_id,calendar_name,title,start_at,end_at,location,notes,meeting_id,calendar_id,href,etag,all_day FROM calendar_events WHERE start_at < ? AND COALESCE(end_at,start_at) >= ? ORDER BY start_at")
        .bind(end_at).bind(start_at).fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_get_calendar_collections<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CalendarCollection>, String> {
    sqlx::query_as::<_, CalendarCollection>("SELECT id,source,account_key,href,name,color,read_only,enabled FROM calendar_collections ORDER BY source,name")
        .fetch_all(state.db_manager.pool()).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn api_set_calendar_enabled<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    calendar_id: String,
    enabled: bool,
) -> Result<(), String> {
    sqlx::query("UPDATE calendar_collections SET enabled=?,updated_at=? WHERE id=?")
        .bind(enabled)
        .bind(Utc::now().to_rfc3339())
        .bind(calendar_id)
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ics_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace(',', "\\,")
        .replace(';', "\\;")
}

fn event_ics(uid: &str, input: &CalendarEventInput) -> Result<String, String> {
    let start = DateTime::parse_from_rfc3339(&input.start_at)
        .map_err(|_| "Invalid start time")?
        .with_timezone(&Utc);
    let end = input
        .end_at
        .as_ref()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or_else(|| start + chrono::Duration::hours(1));
    let (dtstart, dtend) = if input.all_day {
        (
            format!("DTSTART;VALUE=DATE:{}", start.format("%Y%m%d")),
            format!("DTEND;VALUE=DATE:{}", end.format("%Y%m%d")),
        )
    } else {
        (
            format!("DTSTART:{}", start.format("%Y%m%dT%H%M%SZ")),
            format!("DTEND:{}", end.format("%Y%m%dT%H%M%SZ")),
        )
    };
    let location = input
        .location
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(|v| format!("LOCATION:{}\r\n", ics_escape(v)))
        .unwrap_or_default();
    let notes = input
        .notes
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(|v| format!("DESCRIPTION:{}\r\n", ics_escape(v)))
        .unwrap_or_default();
    Ok(format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CalMee//Calendar//ZH-CN\r\nBEGIN:VEVENT\r\nUID:{}\r\nDTSTAMP:{}\r\n{}\r\n{}\r\nSUMMARY:{}\r\n{}{}END:VEVENT\r\nEND:VCALENDAR\r\n", uid, Utc::now().format("%Y%m%dT%H%M%SZ"), dtstart, dtend, ics_escape(input.title.trim()), location, notes))
}

#[tauri::command]
pub async fn api_save_calendar_event<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    event: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    if event.title.trim().is_empty() {
        return Err("Enter an event title".into());
    }
    let pool = state.db_manager.pool();
    let calendar = sqlx::query_as::<_, CalendarCollection>("SELECT id,source,account_key,href,name,color,read_only,enabled FROM calendar_collections WHERE id=?")
        .bind(&event.calendar_id).fetch_optional(pool).await.map_err(|e| e.to_string())?.ok_or("Target calendar not found")?;
    if calendar.read_only {
        return Err("This calendar is read-only".into());
    }
    if calendar.source != "caldav" {
        return Err("Editing On My Mac calendars requires EventKit support. Choose a writable CalDAV calendar.".into());
    }
    let settings = read_settings(pool).await?;
    let existing = if let Some(id) = &event.id {
        sqlx::query_as::<_, CalendarEvent>("SELECT id,source,external_id,calendar_name,title,start_at,end_at,location,notes,meeting_id,calendar_id,href,etag,all_day FROM calendar_events WHERE id=?")
            .bind(id).fetch_optional(pool).await.map_err(|e| e.to_string())?
    } else {
        None
    };
    let uid = existing
        .as_ref()
        .map(|v| v.external_id.clone())
        .unwrap_or_else(|| format!("{}@calmee", Uuid::new_v4()));
    let base = settings.caldav_url.clone().ok_or("CalDAV URL is missing")?;
    let collection_url = absolute_caldav_url(&base, &calendar.href)?;
    let resource_href = existing
        .as_ref()
        .and_then(|v| v.href.clone())
        .unwrap_or_else(|| format!("{}/{}.ics", calendar.href.trim_end_matches('/'), uid));
    let resource_url = absolute_caldav_url(&collection_url, &resource_href)?;
    let mut request = reqwest::Client::new()
        .put(&resource_url)
        .basic_auth(
            settings.caldav_username.clone().unwrap_or_default(),
            settings.caldav_password.clone(),
        )
        .header("Content-Type", "text/calendar; charset=utf-8")
        .body(event_ics(&uid, &event)?);
    request = if let Some(etag) = existing.as_ref().and_then(|v| v.etag.clone()) {
        request.header("If-Match", etag)
    } else {
        request.header("If-None-Match", "*")
    };
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to save event: {}", e))?;
    if !response.status().is_success() {
        return Err(if response.status().as_u16() == 412 {
            "The event changed on another device. Sync before editing it again.".into()
        } else {
            format!("CalDAV save failed: HTTP {}", response.status())
        });
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let saved = CalendarEvent {
        id: existing
            .as_ref()
            .map(|v| v.id.clone())
            .unwrap_or_else(|| format!("event-{}", Uuid::new_v4())),
        source: "caldav".into(),
        external_id: uid,
        calendar_name: Some(calendar.name),
        title: event.title,
        start_at: event.start_at,
        end_at: event.end_at,
        location: event.location,
        notes: event.notes,
        meeting_id: existing.as_ref().and_then(|v| v.meeting_id.clone()),
        calendar_id: Some(calendar.id),
        href: Some(resource_href),
        etag,
        all_day: event.all_day,
    };
    upsert_event(pool, &saved).await?;
    Ok(saved)
}

#[tauri::command]
pub async fn api_delete_calendar_event<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    event_id: String,
) -> Result<(), String> {
    let pool = state.db_manager.pool();
    let event = sqlx::query_as::<_, CalendarEvent>("SELECT id,source,external_id,calendar_name,title,start_at,end_at,location,notes,meeting_id,calendar_id,href,etag,all_day FROM calendar_events WHERE id=?")
        .bind(&event_id).fetch_optional(pool).await.map_err(|e| e.to_string())?.ok_or("Event not found")?;
    if event.source != "caldav" {
        return Err("On My Mac events cannot be deleted from CalMee yet".into());
    }
    let settings = read_settings(pool).await?;
    let base = settings.caldav_url.clone().ok_or("CalDAV URL is missing")?;
    let href = event.href.clone().ok_or("Event server URL is missing")?;
    let mut request = reqwest::Client::new()
        .delete(absolute_caldav_url(&base, &href)?)
        .basic_auth(
            settings.caldav_username.unwrap_or_default(),
            settings.caldav_password,
        );
    if let Some(etag) = event.etag {
        request = request.header("If-Match", etag);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to delete event: {}", e))?;
    if !response.status().is_success() && response.status().as_u16() != 404 {
        return Err(format!("CalDAV delete failed: HTTP {}", response.status()));
    }
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE meetings SET calendar_event_id=NULL WHERE calendar_event_id=?")
        .bind(&event_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM calendar_events WHERE id=?")
        .bind(&event_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_update_meeting_schedule<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    meeting_id: String,
    start_at: Option<String>,
    end_at: Option<String>,
    calendar_event_id: Option<String>,
) -> Result<(), String> {
    let mut tx = state
        .db_manager
        .pool()
        .begin()
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE meetings SET meeting_start_time=?,meeting_end_time=?,calendar_event_id=?,updated_at=? WHERE id=?")
        .bind(&start_at).bind(&end_at).bind(&calendar_event_id).bind(Utc::now()).bind(&meeting_id)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    sqlx::query("UPDATE calendar_events SET meeting_id=NULL WHERE meeting_id=?")
        .bind(&meeting_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(event_id) = &calendar_event_id {
        sqlx::query("UPDATE calendar_events SET meeting_id=? WHERE id=?")
            .bind(&meeting_id)
            .bind(event_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn insert_external_meeting_record(
    pool: &SqlitePool,
    title: &str,
    raw_content: &str,
    record_content: Option<&str>,
    meeting_start_time: &str,
    source: &str,
    external_id: Option<&str>,
    overwrite: bool,
) -> Result<(ExternalMeetingImportResult, bool), String> {
    if title.trim().is_empty() {
        return Err("Enter a meeting title".into());
    }
    if raw_content.trim().is_empty() {
        return Err("The note has no body or recording transcript to import".into());
    }
    DateTime::parse_from_rfc3339(meeting_start_time)
        .map_err(|_| "Invalid meeting time format".to_string())?;
    let blocks = parse_external_transcript(raw_content);
    if blocks.is_empty() {
        return Err("The recording transcript contains no readable speech segments".into());
    }
    let incoming_is_structured = blocks.len() > 1
        && blocks.iter().any(|block| block.start_seconds.is_some())
        && blocks.iter().any(|block| block.speaker.is_some());
    let existing = if let Some(external_id) = external_id {
        sqlx::query_scalar::<_, String>(
            "SELECT id FROM meetings WHERE source=? AND external_id=? LIMIT 1",
        )
        .bind(source)
        .bind(external_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| error.to_string())?
    } else {
        None
    };
    let repair_legacy_import = if let Some(existing_id) = existing.as_deref() {
        if !overwrite && incoming_is_structured {
            let row = sqlx::query_as::<_, (i64, i64)>(
                "SELECT COUNT(*),COALESCE(SUM(CASE WHEN audio_start_time IS NOT NULL THEN 1 ELSE 0 END),0) FROM transcripts WHERE meeting_id=?",
            )
            .bind(existing_id)
            .fetch_one(pool)
            .await
            .map_err(|error| error.to_string())?;
            row.0 <= 1 || row.1 == 0
        } else {
            false
        }
    } else {
        false
    };
    if existing.is_some() && !overwrite && !repair_legacy_import {
        return Ok((
            ExternalMeetingImportResult {
                meeting_id: existing.unwrap(),
                transcript_blocks: 0,
            },
            true,
        ));
    }
    let replacing = existing.is_some() && (overwrite || repair_legacy_import);
    let meeting_id = existing.unwrap_or_else(|| format!("meeting-{}", Uuid::new_v4()));
    let now = Utc::now();
    let meeting_start = DateTime::parse_from_rfc3339(meeting_start_time)
        .map_err(|error| error.to_string())?
        .with_timezone(&Utc);
    let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
    if replacing {
        sqlx::query("UPDATE meetings SET title=?,updated_at=?,meeting_start_time=? WHERE id=?")
            .bind(title.trim())
            .bind(now)
            .bind(meeting_start_time)
            .bind(&meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query("DELETE FROM transcripts WHERE meeting_id=?")
            .bind(&meeting_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
    } else {
        sqlx::query("INSERT INTO meetings (id,title,created_at,updated_at,meeting_start_time,source,external_id) VALUES (?,?,?,?,?,?,?)")
            .bind(&meeting_id).bind(title.trim()).bind(now).bind(now).bind(meeting_start_time)
            .bind(source).bind(external_id).execute(&mut *tx).await.map_err(|error| error.to_string())?;
    }
    let mut speaker_numbers = HashMap::<String, usize>::new();
    for (index, block) in blocks.iter().enumerate() {
        let transcript_id = format!("transcript-{}", Uuid::new_v4());
        let speaker_number = block.speaker.as_ref().map(|speaker| {
            let next = speaker_numbers.len() + 1;
            *speaker_numbers.entry(speaker.clone()).or_insert(next)
        });
        let local_speaker = speaker_number.map(|number| format!("Speaker {}", number));
        let transcript = local_speaker
            .as_ref()
            .map(|speaker| format!("[{}] {}", speaker, block.text.trim()))
            .unwrap_or_else(|| block.text.trim().to_string());
        let end_seconds = blocks
            .get(index + 1)
            .and_then(|next| next.start_seconds)
            .filter(|end| block.start_seconds.is_some_and(|start| *end > start));
        let duration = block
            .start_seconds
            .zip(end_seconds)
            .map(|(start, end)| end - start);
        let timestamp = meeting_start
            + chrono::Duration::milliseconds(
                (block.start_seconds.unwrap_or(index as f64 / 1000.0) * 1000.0) as i64,
            );
        sqlx::query("INSERT INTO transcripts (id,meeting_id,transcript,timestamp,audio_start_time,audio_end_time,duration,speaker) VALUES (?,?,?,?,?,?,?,?)")
            .bind(&transcript_id).bind(&meeting_id).bind(&transcript)
            .bind(timestamp).bind(block.start_seconds).bind(end_seconds).bind(duration).bind(&local_speaker)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;

        let Some(speaker_name) = block.speaker.as_ref() else {
            continue;
        };
        if generic_speaker_number(speaker_name).is_some() {
            continue;
        }
        let person_id = sqlx::query_scalar::<_, String>(
            "SELECT id FROM people WHERE lower(trim(name))=lower(trim(?)) LIMIT 1",
        )
        .bind(speaker_name)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| format!("person-{}", Uuid::new_v4()));
        sqlx::query("INSERT INTO people (id,name,aliases,auto_identify,created_at,updated_at) VALUES (?,?,'[]',1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at")
            .bind(&person_id).bind(speaker_name).bind(now).bind(now)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
        sqlx::query("INSERT INTO transcript_speaker_overrides (meeting_id,transcript_id,person_id,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(meeting_id,transcript_id) DO UPDATE SET person_id=excluded.person_id,updated_at=excluded.updated_at")
            .bind(&meeting_id).bind(&transcript_id).bind(&person_id).bind(now).bind(now)
            .execute(&mut *tx).await.map_err(|error| error.to_string())?;
        if let Some(local_speaker) = &local_speaker {
            sqlx::query("INSERT INTO meeting_speaker_assignments (meeting_id,local_speaker,person_id,confidence,confirmed,updated_at,match_state) VALUES (?,?,?,1.0,1,?,'confirmed') ON CONFLICT(meeting_id,local_speaker) DO UPDATE SET person_id=excluded.person_id,confidence=1.0,confirmed=1,updated_at=excluded.updated_at,match_state='confirmed'")
                .bind(&meeting_id).bind(local_speaker).bind(&person_id).bind(now)
                .execute(&mut *tx).await.map_err(|error| error.to_string())?;
        }
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    if let Some(record_content) = record_content.filter(|value| !value.trim().is_empty()) {
        crate::knowledge::replace_external_meeting_record(pool, &meeting_id, record_content)
            .await?;
        let updated_at = Utc::now().to_rfc3339();
        // Keep the previous smart record in the built-in previous_markdown slot,
        // so confirming an external refresh remains reversible.
        sqlx::query("INSERT INTO meeting_documents (meeting_id,kind,context_key,markdown,language,template_id,created_at,updated_at) VALUES (?,'smart_record','',?,'auto',NULL,?,?) ON CONFLICT(meeting_id,kind,context_key) DO UPDATE SET previous_markdown=CASE WHEN meeting_documents.markdown<>excluded.markdown THEN meeting_documents.markdown ELSE meeting_documents.previous_markdown END,markdown=excluded.markdown,updated_at=excluded.updated_at")
            .bind(&meeting_id).bind(record_content.trim()).bind(&updated_at).bind(&updated_at)
            .execute(pool).await.map_err(|error| error.to_string())?;
    }
    Ok((
        ExternalMeetingImportResult {
            meeting_id,
            transcript_blocks: blocks.len(),
        },
        false,
    ))
}

#[tauri::command]
pub async fn api_import_external_meeting_record<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    title: String,
    content: String,
    meeting_start_time: String,
    source: Option<String>,
    external_id: Option<String>,
) -> Result<ExternalMeetingImportResult, String> {
    let source = source.unwrap_or_else(|| "external".into());
    insert_external_meeting_record(
        state.db_manager.pool(),
        &title,
        &content,
        Some(&content),
        &meeting_start_time,
        &source,
        external_id.as_deref(),
        false,
    )
    .await
    .map(|(result, _)| result)
}

#[tauri::command]
pub async fn api_test_caldav<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let settings = read_settings(state.db_manager.pool()).await?;
    let calendars = discover_caldav_calendars(state.db_manager.pool(), &settings).await?;
    Ok(format!(
        "Connected successfully. Discovered {} calendars.",
        calendars.len()
    ))
}

fn parse_ics_date(value: &str) -> Option<String> {
    let value = value.trim();
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(value.with_timezone(&Utc).to_rfc3339());
    }
    let is_utc = value.ends_with('Z');
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value.trim_end_matches('Z'), "%Y%m%dT%H%M%S")
    {
        return Some(
            if is_utc {
                Utc.from_utc_datetime(&parsed)
            } else {
                Local
                    .from_local_datetime(&parsed)
                    .single()?
                    .with_timezone(&Utc)
            }
            .to_rfc3339(),
        );
    }
    NaiveDate::parse_from_str(value, "%Y%m%d")
        .ok()
        .and_then(|d| Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).single())
        .map(|d| d.with_timezone(&Utc).to_rfc3339())
}

fn ics_field(block: &str, name: &str) -> Option<String> {
    block.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.split(';').next()? == name).then(|| value.replace("\\n", "\n").replace("\\,", ","))
    })
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn xml_element(block: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r"(?is)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_-]+:)?{}\s*>",
        regex::escape(name),
        regex::escape(name)
    );
    Regex::new(&pattern)
        .ok()?
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|v| xml_unescape(v.as_str().trim()))
}

fn xml_elements(block: &str, name: &str) -> Vec<String> {
    let pattern = format!(
        r"(?is)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_-]+:)?{}\s*>",
        regex::escape(name),
        regex::escape(name)
    );
    Regex::new(&pattern)
        .ok()
        .map(|re| {
            re.captures_iter(block)
                .filter_map(|capture| {
                    capture
                        .get(1)
                        .map(|value| xml_unescape(value.as_str().trim()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_calendar_color(raw: &str) -> Option<String> {
    let value = raw.trim();
    let hex = value.strip_prefix('#')?;
    let normalized = match hex.len() {
        3 => hex.chars().flat_map(|ch| [ch, ch]).collect::<String>(),
        6 | 8 => hex[..6].to_owned(),
        _ => return None,
    };
    normalized
        .chars()
        .all(|ch| ch.is_ascii_hexdigit())
        .then(|| format!("#{}", normalized.to_ascii_uppercase()))
}

fn calendar_color(block: &str) -> Option<String> {
    xml_elements(block, "calendar-color")
        .into_iter()
        .find_map(|value| normalize_calendar_color(&value))
}

fn fallback_calendar_color(seed: &str) -> String {
    const COLORS: [&str; 8] = [
        "#0A84FF", "#BF5AF2", "#FF375F", "#FF9F0A", "#30D158", "#64D2FF", "#5E5CE6", "#FF6482",
    ];
    let hash = seed.bytes().fold(0usize, |value, byte| {
        value.wrapping_mul(31).wrapping_add(byte as usize)
    });
    COLORS[hash % COLORS.len()].to_owned()
}

fn xml_response_blocks(body: &str) -> Vec<String> {
    Regex::new(
        r"(?is)<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_-]+:)?response\s*>",
    )
    .ok()
    .map(|re| {
        re.captures_iter(body)
            .filter_map(|c| c.get(1).map(|v| v.as_str().to_owned()))
            .collect()
    })
    .unwrap_or_default()
}

fn xml_property_href(block: &str, property: &str) -> Option<String> {
    let pattern = format!(
        r"(?is)<(?:[A-Za-z0-9_-]+:)?{}(?:\s[^>]*)?>.*?<(?:[A-Za-z0-9_-]+:)?href(?:\s[^>]*)?>(.*?)</(?:[A-Za-z0-9_-]+:)?href\s*>",
        regex::escape(property)
    );
    Regex::new(&pattern)
        .ok()?
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|v| xml_unescape(v.as_str().trim()))
}

fn absolute_caldav_url(base: &str, href: &str) -> Result<String, String> {
    if href.starts_with("http://") || href.starts_with("https://") {
        return Ok(href.to_owned());
    }
    url::Url::parse(base)
        .map_err(|e| e.to_string())?
        .join(href)
        .map(|v| v.to_string())
        .map_err(|e| e.to_string())
}

fn parse_ics_events(
    body: &str,
    source: &str,
    calendar: Option<&CalendarCollection>,
    href: Option<String>,
    etag: Option<String>,
) -> Vec<CalendarEvent> {
    let unfolded = body.replace("\r\n ", "").replace("\n ", "");
    unfolded
        .split("BEGIN:VEVENT")
        .skip(1)
        .filter_map(|part| {
            let block = part.split("END:VEVENT").next()?;
            let external_id = ics_field(block, "UID")?;
            Some(CalendarEvent {
                id: format!("event-{}", Uuid::new_v4()),
                source: source.into(),
                external_id,
                calendar_name: calendar
                    .map(|v| v.name.clone())
                    .or_else(|| Some("CalDAV".into())),
                title: ics_field(block, "SUMMARY").unwrap_or_else(|| "Untitled event".into()),
                start_at: parse_ics_date(&ics_field(block, "DTSTART")?)?,
                end_at: ics_field(block, "DTEND").and_then(|v| parse_ics_date(&v)),
                location: ics_field(block, "LOCATION"),
                notes: ics_field(block, "DESCRIPTION"),
                meeting_id: None,
                calendar_id: calendar.map(|v| v.id.clone()),
                href: href.clone(),
                etag: etag.clone(),
                all_day: ics_field(block, "DTSTART")
                    .map(|v| v.len() == 8)
                    .unwrap_or(false),
            })
        })
        .collect()
}

async fn caldav_request(
    settings: &CalendarSettings,
    method: Method,
    url: &str,
    depth: &str,
    body: Option<String>,
) -> Result<reqwest::Response, String> {
    let response = reqwest::Client::new()
        .request(method, url)
        .basic_auth(
            settings.caldav_username.clone().unwrap_or_default(),
            settings.caldav_password.clone(),
        )
        .header("Depth", depth)
        .header("Content-Type", "application/xml; charset=utf-8")
        .body(body.unwrap_or_default())
        .send()
        .await
        .map_err(|e| format!("CalDAV connection failed: {}", e))?;
    if response.status().is_success() || response.status().as_u16() == 207 {
        Ok(response)
    } else {
        Err(format!(
            "CalDAV returned HTTP {}",
            response.status().as_u16()
        ))
    }
}

async fn discover_caldav_calendars(
    pool: &SqlitePool,
    settings: &CalendarSettings,
) -> Result<Vec<CalendarCollection>, String> {
    let base = settings
        .caldav_url
        .clone()
        .filter(|v| !v.trim().is_empty())
        .ok_or("CalDAV URL is missing")?;
    let discovery_body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/><d:displayname/></d:prop></d:propfind>"#;
    let discovery = caldav_request(
        settings,
        Method::from_bytes(b"PROPFIND").unwrap(),
        &base,
        "0",
        Some(discovery_body.into()),
    )
    .await?
    .text()
    .await
    .map_err(|e| e.to_string())?;
    let mut home = settings
        .caldav_calendar_path
        .clone()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| xml_property_href(&discovery, "calendar-home-set"));
    if home.is_none() {
        if let Some(principal) = xml_property_href(&discovery, "current-user-principal") {
            let principal_url = absolute_caldav_url(&base, &principal)?;
            let principal_body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#;
            let principal_xml = caldav_request(
                settings,
                Method::from_bytes(b"PROPFIND").unwrap(),
                &principal_url,
                "0",
                Some(principal_body.into()),
            )
            .await?
            .text()
            .await
            .map_err(|e| e.to_string())?;
            home = xml_property_href(&principal_xml, "calendar-home-set");
        }
    }
    let home = home.unwrap_or_else(|| base.clone());
    let home_url = absolute_caldav_url(&base, &home)?;
    // Servers in the wild expose calendar-color in either the CalendarServer
    // namespace or Apple's iCalendar namespace. Request both variants.
    let list_body = r##"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><cs:calendar-color/><ical:calendar-color/><d:current-user-privilege-set/><c:supported-calendar-component-set/></d:prop></d:propfind>"##;
    let xml = caldav_request(
        settings,
        Method::from_bytes(b"PROPFIND").unwrap(),
        &home_url,
        "1",
        Some(list_body.into()),
    )
    .await?
    .text()
    .await
    .map_err(|e| e.to_string())?;
    let account_key = settings
        .caldav_username
        .clone()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| base.clone());
    for block in xml_response_blocks(&xml) {
        let resource_type = xml_element(&block, "resourcetype").unwrap_or_default();
        if !Regex::new(r"(?i)<(?:[A-Za-z0-9_-]+:)?calendar(?:\s[^>]*)?/?>")
            .unwrap()
            .is_match(&resource_type)
        {
            continue;
        }
        let href = xml_element(&block, "href").ok_or("CalDAV calendar URL is missing")?;
        let name = xml_element(&block, "displayname")
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "Untitled calendar".into());
        let server_color = calendar_color(&block);
        let existing_color = sqlx::query_scalar::<_, String>("SELECT color FROM calendar_collections WHERE source='caldav' AND account_key=? AND href=?")
            .bind(&account_key).bind(&href).fetch_optional(pool).await.map_err(|e| e.to_string())?;
        let color = server_color
            .or(existing_color)
            .unwrap_or_else(|| fallback_calendar_color(&format!("{}:{}", account_key, href)));
        let privileges = xml_element(&block, "current-user-privilege-set").unwrap_or_default();
        let read_only = !privileges.is_empty()
            && !Regex::new(
                r"(?i)<(?:[A-Za-z0-9_-]+:)?write(?:-content|-properties)?(?:\s[^>]*)?/?>",
            )
            .unwrap()
            .is_match(&privileges);
        let id = format!("calendar-{}", Uuid::new_v4());
        sqlx::query("INSERT INTO calendar_collections (id,source,account_key,href,name,color,read_only,enabled,updated_at) VALUES (?,'caldav',?,?,?,?,?,1,?) ON CONFLICT(source,account_key,href) DO UPDATE SET name=excluded.name,color=excluded.color,read_only=excluded.read_only,updated_at=excluded.updated_at")
            .bind(id).bind(&account_key).bind(&href).bind(&name).bind(&color).bind(read_only).bind(Utc::now().to_rfc3339())
            .execute(pool).await.map_err(|e| e.to_string())?;
    }
    sqlx::query_as::<_, CalendarCollection>("SELECT id,source,account_key,href,name,color,read_only,enabled FROM calendar_collections WHERE source='caldav' AND account_key=? ORDER BY name")
        .bind(account_key).fetch_all(pool).await.map_err(|e| e.to_string())
}

async fn sync_caldav(
    pool: &SqlitePool,
    settings: &CalendarSettings,
    start: &str,
    end: &str,
) -> Result<usize, String> {
    let base = settings.caldav_url.clone().ok_or("CalDAV URL is missing")?;
    let calendars = discover_caldav_calendars(pool, settings).await?;
    let start_utc = DateTime::parse_from_rfc3339(start)
        .map_err(|e| e.to_string())?
        .with_timezone(&Utc)
        .format("%Y%m%dT%H%M%SZ");
    let end_utc = DateTime::parse_from_rfc3339(end)
        .map_err(|e| e.to_string())?
        .with_timezone(&Utc)
        .format("%Y%m%dT%H%M%SZ");
    let body = format!("<?xml version=\"1.0\"?><c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\"><c:time-range start=\"{}\" end=\"{}\"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>", start_utc, end_utc);
    let mut total = 0;
    for calendar in calendars.into_iter().filter(|v| v.enabled) {
        let url = absolute_caldav_url(&base, &calendar.href)?;
        let text = caldav_request(
            settings,
            Method::from_bytes(b"REPORT").unwrap(),
            &url,
            "1",
            Some(body.clone()),
        )
        .await?
        .text()
        .await
        .map_err(|e| e.to_string())?;
        let mut server_hrefs = std::collections::HashSet::new();
        for response in xml_response_blocks(&text) {
            let href = xml_element(&response, "href");
            if let Some(value) = &href {
                server_hrefs.insert(value.clone());
            }
            let etag = xml_element(&response, "getetag");
            let Some(data) = xml_element(&response, "calendar-data") else {
                continue;
            };
            for event in
                parse_ics_events(&data, "caldav", Some(&calendar), href.clone(), etag.clone())
            {
                upsert_event(pool, &event).await?;
                total += 1;
            }
        }
        let cached = sqlx::query_as::<_, (String, Option<String>)>("SELECT id,href FROM calendar_events WHERE calendar_id=? AND start_at < ? AND COALESCE(end_at,start_at) >= ?")
            .bind(&calendar.id).bind(end).bind(start).fetch_all(pool).await.map_err(|e| e.to_string())?;
        for (id, href) in cached {
            if href
                .as_ref()
                .map(|value| !server_hrefs.contains(value))
                .unwrap_or(false)
            {
                sqlx::query("UPDATE meetings SET calendar_event_id=NULL WHERE calendar_event_id=?")
                    .bind(&id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                sqlx::query("DELETE FROM calendar_events WHERE id=?")
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(total)
}

async fn sync_native(pool: &SqlitePool, start: &str, end: &str) -> Result<usize, String> {
    let start_ms = DateTime::parse_from_rfc3339(start)
        .map_err(|e| e.to_string())?
        .timestamp_millis();
    let end_ms = DateTime::parse_from_rfc3339(end)
        .map_err(|e| e.to_string())?
        .timestamp_millis();
    let script = r#"function run(a){const C=Application('Calendar'),s=Number(a[0]),e=Number(a[1]),events=[],calendars=[];C.calendars().forEach(c=>{const name=String(c.name());calendars.push({name});c.events().forEach(v=>{try{const b=v.startDate().getTime();if(b>=s&&b<e)events.push({uid:String(v.uid()),calendar:name,title:String(v.summary()||'Untitled event'),start_ms:b,end_ms:v.endDate().getTime(),location:String(v.location()||''),notes:String(v.description()||'')});}catch(_){}})});return JSON.stringify({calendars,events});}"#;
    let output = tokio::task::spawn_blocking(move || {
        Command::new("osascript")
            .args([
                "-l",
                "JavaScript",
                "-e",
                script,
                "--",
                &start_ms.to_string(),
                &end_ms.to_string(),
            ])
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Failed to read On My Mac calendars: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let native: NativePayload = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Invalid calendar response format: {}", e))?;
    for calendar in &native.calendars {
        sqlx::query("INSERT INTO calendar_collections (id,source,account_key,href,name,color,read_only,enabled,updated_at) VALUES (?,'local','macOS',?,?,'#FF9F0A',1,1,?) ON CONFLICT(source,account_key,href) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at")
            .bind(format!("calendar-{}", Uuid::new_v4())).bind(&calendar.name).bind(&calendar.name).bind(Utc::now().to_rfc3339())
            .execute(pool).await.map_err(|e| e.to_string())?;
    }
    for item in &native.events {
        let calendar_id = sqlx::query_scalar::<_, String>("SELECT id FROM calendar_collections WHERE source='local' AND account_key='macOS' AND href=?")
            .bind(&item.calendar).fetch_one(pool).await.map_err(|e| e.to_string())?;
        upsert_event(
            pool,
            &CalendarEvent {
                id: format!("event-{}", Uuid::new_v4()),
                source: "local".into(),
                external_id: item.uid.clone(),
                calendar_name: Some(item.calendar.clone()),
                title: item.title.clone(),
                start_at: Utc
                    .timestamp_millis_opt(item.start_ms)
                    .single()
                    .unwrap()
                    .to_rfc3339(),
                end_at: Utc
                    .timestamp_millis_opt(item.end_ms)
                    .single()
                    .map(|v| v.to_rfc3339()),
                location: item.location.clone().filter(|v| !v.is_empty()),
                notes: item.notes.clone().filter(|v| !v.is_empty()),
                meeting_id: None,
                calendar_id: Some(calendar_id),
                href: None,
                etag: None,
                all_day: false,
            },
        )
        .await?;
    }
    Ok(native.events.len())
}

async fn upsert_event(pool: &SqlitePool, event: &CalendarEvent) -> Result<(), String> {
    sqlx::query("INSERT INTO calendar_events (id,source,external_id,calendar_name,title,start_at,end_at,location,notes,calendar_id,href,etag,all_day,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET calendar_name=excluded.calendar_name,title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,location=excluded.location,notes=excluded.notes,calendar_id=excluded.calendar_id,href=excluded.href,etag=excluded.etag,all_day=excluded.all_day,updated_at=excluded.updated_at")
        .bind(&event.id).bind(&event.source).bind(&event.external_id).bind(&event.calendar_name).bind(&event.title)
        .bind(&event.start_at).bind(&event.end_at).bind(&event.location).bind(&event.notes).bind(&event.calendar_id)
        .bind(&event.href).bind(&event.etag).bind(event.all_day).bind(Utc::now().to_rfc3339())
        .execute(pool).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn api_sync_calendars<R: Runtime>(
    _app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    start_at: String,
    end_at: String,
) -> Result<serde_json::Value, String> {
    let settings = read_settings(state.db_manager.pool()).await?;
    let mut local = 0usize;
    let mut caldav = 0usize;
    let mut warnings = Vec::new();
    if settings.local_enabled {
        match sync_native(state.db_manager.pool(), &start_at, &end_at).await {
            Ok(n) => local = n,
            Err(e) => warnings.push(e),
        }
    }
    if settings.caldav_enabled {
        match sync_caldav(state.db_manager.pool(), &settings, &start_at, &end_at).await {
            Ok(n) => caldav = n,
            Err(e) => warnings.push(e),
        }
    }
    sqlx::query("UPDATE calendar_settings SET last_sync_at=?,updated_at=? WHERE id='default'")
        .bind(Utc::now().to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(state.db_manager.pool())
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"local":local,"caldav":caldav,"warnings":warnings}))
}

#[cfg(test)]
mod external_transcript_tests {
    use super::*;

    #[test]
    fn parses_speaker_headers_from_external_exports() {
        let blocks = parse_external_transcript(
            "会议标题\n\n🟢 说话人1 [00:00:00]\n先说第一件事。\n\n🟣 鲁立 [00:05:16]\n我补充两点。",
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].speaker.as_deref(), Some("说话人1"));
        assert_eq!(blocks[0].start_seconds, Some(0.0));
        assert_eq!(blocks[0].text, "先说第一件事。");
        assert_eq!(blocks[1].speaker.as_deref(), Some("鲁立"));
        assert_eq!(blocks[1].start_seconds, Some(316.0));
    }

    #[test]
    fn parses_inline_plain_text_export() {
        let blocks = parse_external_transcript(
            "鲁立 00:00:04 我近期准备梳理程序体系。\n邓春银 00:00:42 我补充一个问题。",
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].speaker.as_deref(), Some("鲁立"));
        assert_eq!(blocks[0].text, "我近期准备梳理程序体系。");
        assert_eq!(blocks[1].start_seconds, Some(42.0));
    }

    #[test]
    fn parses_older_split_line_export_without_avatar_noise() {
        let blocks = parse_external_transcript(
            "鲁\n鲁立(我)\n00:00:04\n第一段发言。\n鲁\n鲁立(我)\n00:00:42\n第二段发言。",
        );
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].speaker.as_deref(), Some("鲁立"));
        assert_eq!(blocks[0].text, "第一段发言。");
        assert_eq!(blocks[1].text, "第二段发言。");
    }
}
