use crate::state::AppState;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Connection, Executor, Sqlite, SqlitePool, Transaction};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

const LEGACY_IDENTIFIER: &str = "com.calmee.app";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCategoryPreview {
    pub key: String,
    pub rows: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataImportPreview {
    pub source_path: String,
    pub target_path: String,
    pub categories: Vec<ImportCategoryPreview>,
    pub audio_references: i64,
    pub missing_audio_references: i64,
    pub excluded_rows: i64,
    pub excluded_items: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataImportOptions {
    pub source_path: String,
    #[serde(default)]
    pub include_audio_references: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataImportReport {
    pub inserted_rows: u64,
    pub skipped_existing_rows: u64,
    pub preserved_audio_references: u64,
    pub missing_audio_references: u64,
}

#[derive(Debug, sqlx::FromRow)]
struct AudioReference {
    id: String,
    folder_path: String,
}

const EXCLUDED_ITEMS: &[&str] = &[
    "database migration history",
    "model and application settings",
    "API keys and provider credentials",
    "license and grace-period state",
    "Dedao preferences and responses",
    "legacy commercial service configuration",
    "calendar accounts and credentials",
    "people profiles, voiceprints, and speaker embeddings",
    "AI Harness customization and generation preferences",
];

const EXCLUDED_TABLES: &[&str] = &[
    "_sqlx_migrations",
    "licensing",
    "settings",
    "transcript_settings",
    "transcript_provider_credentials",
    "calendar_settings",
    "calendar_collections",
    "calendar_events",
    "people",
    "voiceprints",
    "voiceprint_audit_log",
    "meeting_speaker_assignments",
    "transcript_speaker_overrides",
    "hotwords",
    "correction_events",
    "ai_harness_settings",
    "generation_preferences",
    "document_templates",
    "document_generation_jobs",
    "summary_processes",
];

const IMPORT_TABLES: &[(&str, &str)] = &[
    (
        "meetings",
        "INSERT OR IGNORE INTO meetings (id,title,created_at,updated_at,folder_path,meeting_start_time,meeting_end_time,calendar_event_id,source,external_id) SELECT id,title,created_at,updated_at,NULL,meeting_start_time,meeting_end_time,NULL,'calmee',NULL FROM legacy.meetings",
    ),
    (
        "transcripts",
        "INSERT OR IGNORE INTO transcripts (id,meeting_id,transcript,timestamp,summary,action_items,key_points,speaker,audio_start_time,audio_end_time,duration) SELECT id,meeting_id,transcript,timestamp,summary,action_items,key_points,speaker,audio_start_time,audio_end_time,duration FROM legacy.transcripts",
    ),
    (
        "transcript_chunks",
        "INSERT OR IGNORE INTO transcript_chunks (meeting_id,meeting_name,transcript_text,model,model_name,chunk_size,overlap,created_at) SELECT meeting_id,meeting_name,transcript_text,model,model_name,chunk_size,overlap,created_at FROM legacy.transcript_chunks",
    ),
    (
        "transcript_versions",
        "INSERT OR IGNORE INTO transcript_versions (meeting_id,version_kind,speaker_count,segments_json,created_at,updated_at) SELECT meeting_id,version_kind,speaker_count,segments_json,created_at,updated_at FROM legacy.transcript_versions",
    ),
    (
        "transcript_refinements",
        "INSERT OR IGNORE INTO transcript_refinements (meeting_id,prompt_version,provider,model,result_json,created_at,updated_at) SELECT meeting_id,prompt_version,provider,model,result_json,created_at,updated_at FROM legacy.transcript_refinements",
    ),
    (
        "meeting_notes",
        "INSERT OR IGNORE INTO meeting_notes (meeting_id,notes_markdown,notes_json,created_at,updated_at) SELECT meeting_id,notes_markdown,notes_json,created_at,updated_at FROM legacy.meeting_notes",
    ),
    (
        "meeting_record_state",
        "INSERT OR IGNORE INTO meeting_record_state (meeting_id,source_hash,version,summary_stale,created_at,updated_at,document_markdown) SELECT meeting_id,source_hash,version,summary_stale,created_at,updated_at,document_markdown FROM legacy.meeting_record_state",
    ),
    (
        "meeting_record_blocks",
        "INSERT OR IGNORE INTO meeting_record_blocks (id,meeting_id,sequence,local_speaker,person_id,start_ms,end_ms,text,source_transcript_ids,is_edited,created_at,updated_at) SELECT id,meeting_id,sequence,local_speaker,NULL,start_ms,end_ms,text,source_transcript_ids,is_edited,created_at,updated_at FROM legacy.meeting_record_blocks",
    ),
    (
        "meeting_documents",
        "INSERT OR IGNORE INTO meeting_documents (meeting_id,kind,context_key,markdown,previous_markdown,language,template_id,created_at,updated_at) SELECT meeting_id,kind,context_key,markdown,previous_markdown,language,NULL,created_at,updated_at FROM legacy.meeting_documents",
    ),
    (
        "meeting_tags",
        "INSERT OR IGNORE INTO meeting_tags (id,name,color,created_at,updated_at) SELECT id,name,color,created_at,updated_at FROM legacy.meeting_tags",
    ),
    (
        "meeting_tag_links",
        "INSERT OR IGNORE INTO meeting_tag_links (meeting_id,tag_id,created_at) SELECT meeting_id,tag_id,created_at FROM legacy.meeting_tag_links",
    ),
];

fn target_database_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("meeting_minutes.sqlite"))
        .map_err(|error| format!("Could not resolve the public CalMee data directory: {error}"))
}

fn canonical_database_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("The selected source database does not exist or is not a file.".into());
    }
    path.canonicalize()
        .map_err(|error| format!("Could not resolve the selected source database: {error}"))
}

fn ensure_distinct_databases(source: &Path, target: &Path) -> Result<(), String> {
    if let Ok(target) = target.canonicalize() {
        if source == target {
            return Err("The source and target databases must be different files.".into());
        }
    }
    Ok(())
}

async fn open_read_only_source(path: &Path) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("Could not open the source database read-only: {error}"))
}

async fn table_exists(pool: &SqlitePool, table: &str) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
    )
    .bind(table)
    .fetch_one(pool)
    .await
    .map(|value| value != 0)
    .map_err(|error| error.to_string())
}

async fn table_count(pool: &SqlitePool, table: &str) -> Result<i64, String> {
    if !table_exists(pool, table).await? {
        return Ok(0);
    }
    let sql = format!("SELECT COUNT(*) FROM \"{table}\"");
    sqlx::query_scalar(&sql)
        .fetch_one(pool)
        .await
        .map_err(|error| error.to_string())
}

async fn audio_references(pool: &SqlitePool) -> Result<Vec<AudioReference>, String> {
    if !table_exists(pool, "meetings").await? {
        return Ok(Vec::new());
    }
    sqlx::query_as::<_, AudioReference>(
        "SELECT id,folder_path FROM meetings WHERE folder_path IS NOT NULL AND trim(folder_path)<>''",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| error.to_string())
}

async fn build_preview(
    source_path: &Path,
    target_path: &Path,
) -> Result<DataImportPreview, String> {
    ensure_distinct_databases(source_path, target_path)?;
    let source = open_read_only_source(source_path).await?;
    if !table_exists(&source, "meetings").await? || !table_exists(&source, "transcripts").await? {
        return Err("This file is not a supported CalMee meeting database.".into());
    }

    let category_tables = [
        ("meetings", "meetings"),
        ("rawTranscripts", "transcripts"),
        ("transcriptVersions", "transcript_versions"),
        ("aiRefinements", "transcript_refinements"),
        ("meetingNotes", "meeting_notes"),
        ("publicDocuments", "meeting_documents"),
        ("recordBlocks", "meeting_record_blocks"),
        ("tags", "meeting_tags"),
    ];
    let mut categories = Vec::new();
    for (key, table) in category_tables {
        categories.push(ImportCategoryPreview {
            key: key.to_string(),
            rows: table_count(&source, table).await?,
        });
    }

    let audio = audio_references(&source).await?;
    let missing_audio_references = audio
        .iter()
        .filter(|item| !Path::new(&item.folder_path).exists())
        .count() as i64;
    let mut excluded_rows = 0;
    for table in EXCLUDED_TABLES {
        excluded_rows += table_count(&source, table).await?;
    }

    source.close().await;
    Ok(DataImportPreview {
        source_path: source_path.display().to_string(),
        target_path: target_path.display().to_string(),
        categories,
        audio_references: audio.len() as i64,
        missing_audio_references,
        excluded_rows,
        excluded_items: EXCLUDED_ITEMS.iter().map(|item| item.to_string()).collect(),
    })
}

async fn attached_table_exists(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "SELECT EXISTS(SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name=?)",
    )
    .bind(table)
    .fetch_one(&mut **transaction)
    .await
    .map(|value| value != 0)
}

async fn import_allowlisted_data(
    target: &SqlitePool,
    source_path: &Path,
    include_audio_references: bool,
) -> Result<DataImportReport, String> {
    let source = open_read_only_source(source_path).await?;
    let audio = audio_references(&source).await?;
    let mut selected_rows = 0_i64;
    for (table, _) in IMPORT_TABLES {
        selected_rows += table_count(&source, table).await?;
    }

    let existing_audio: Vec<_> = audio
        .iter()
        .filter(|item| Path::new(&item.folder_path).exists())
        .collect();
    let missing_audio_references = audio.len().saturating_sub(existing_audio.len()) as u64;

    let source_url = url::Url::from_file_path(source_path).map_err(|_| {
        "Could not convert the source path to a read-only database URL.".to_string()
    })?;
    let attach_url = format!("{}?mode=ro", source_url.as_str());
    let mut connection = target.acquire().await.map_err(|error| error.to_string())?;
    sqlx::query("ATTACH DATABASE ? AS legacy")
        .bind(&attach_url)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Could not attach the source database read-only: {error}"))?;

    let mut transaction = connection
        .begin()
        .await
        .map_err(|error| error.to_string())?;
    let result: Result<(u64, u64), String> = async {
        let mut inserted_rows = 0_u64;
        for (table, statement) in IMPORT_TABLES {
            if attached_table_exists(&mut transaction, table)
                .await
                .map_err(|error| error.to_string())?
            {
                inserted_rows += transaction
                    .execute(*statement)
                    .await
                    .map_err(|error| {
                        format!("Could not import {table}; all changes were rolled back: {error}")
                    })?
                    .rows_affected();
            }
        }

        let mut preserved_audio_references = 0_u64;
        if include_audio_references {
            for item in &existing_audio {
                preserved_audio_references += sqlx::query(
                    "UPDATE meetings SET folder_path=? WHERE id=? AND folder_path IS NULL",
                )
                .bind(&item.folder_path)
                .bind(&item.id)
                .execute(&mut *transaction)
                .await
                .map_err(|error| error.to_string())?
                .rows_affected();
            }
        }
        Ok((inserted_rows, preserved_audio_references))
    }
    .await;

    let report = match result {
        Ok((inserted_rows, preserved_audio_references)) => {
            transaction
                .commit()
                .await
                .map_err(|error| error.to_string())?;
            DataImportReport {
                inserted_rows,
                skipped_existing_rows: (selected_rows as u64).saturating_sub(inserted_rows),
                preserved_audio_references,
                missing_audio_references,
            }
        }
        Err(error) => {
            transaction
                .rollback()
                .await
                .map_err(|rollback| format!("{error}; rollback also failed: {rollback}"))?;
            let _ = sqlx::query("DETACH DATABASE legacy")
                .execute(&mut *connection)
                .await;
            source.close().await;
            return Err(error);
        }
    };

    sqlx::query("DETACH DATABASE legacy")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Import completed but source detach failed: {error}"))?;
    source.close().await;
    Ok(report)
}

#[tauri::command]
pub fn api_get_default_legacy_calmee_source<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    let public_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let parent = public_dir
        .parent()
        .ok_or_else(|| "Could not resolve the application support directory.".to_string())?;
    let source = parent
        .join(LEGACY_IDENTIFIER)
        .join("meeting_minutes.sqlite");
    Ok(source.is_file().then(|| source.display().to_string()))
}

#[tauri::command]
pub fn api_select_legacy_calmee_source<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .add_filter("CalMee database", &["sqlite", "db"])
        .blocking_pick_file()
        .map(|path| path.to_string())
}

#[tauri::command]
pub async fn api_preview_legacy_calmee_import<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
) -> Result<DataImportPreview, String> {
    let source = canonical_database_path(&source_path)?;
    let target = target_database_path(&app)?;
    build_preview(&source, &target).await
}

#[tauri::command]
pub async fn api_import_legacy_calmee_data<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    options: DataImportOptions,
) -> Result<DataImportReport, String> {
    let source = canonical_database_path(&options.source_path)?;
    let target = target_database_path(&app)?;
    ensure_distinct_databases(&source, &target)?;
    import_allowlisted_data(
        state.db_manager.pool(),
        &source,
        options.include_audio_references,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::manager::DatabaseManager;
    use sqlx::Row;
    use std::fs;
    use std::str::FromStr;
    use tempfile::TempDir;

    async fn create_source(path: &Path, broken_transcripts: bool) -> SqlitePool {
        let url = format!("sqlite://{}", path.display());
        let pool = SqlitePoolOptions::new()
            .connect_with(
                SqliteConnectOptions::from_str(&url)
                    .unwrap()
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        pool.execute("CREATE TABLE meetings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,folder_path TEXT,meeting_start_time TEXT,meeting_end_time TEXT,calendar_event_id TEXT,source TEXT,external_id TEXT)").await.unwrap();
        let transcripts = if broken_transcripts {
            "CREATE TABLE transcripts(id TEXT PRIMARY KEY,meeting_id TEXT,transcript TEXT,timestamp TEXT,summary TEXT,action_items TEXT,key_points TEXT,audio_start_time REAL,audio_end_time REAL,duration REAL)"
        } else {
            "CREATE TABLE transcripts(id TEXT PRIMARY KEY,meeting_id TEXT,transcript TEXT,timestamp TEXT,summary TEXT,action_items TEXT,key_points TEXT,speaker TEXT,audio_start_time REAL,audio_end_time REAL,duration REAL)"
        };
        pool.execute(transcripts).await.unwrap();
        pool.execute("CREATE TABLE settings(id TEXT PRIMARY KEY,openaiApiKey TEXT)")
            .await
            .unwrap();
        pool.execute("CREATE TABLE voiceprints(id TEXT PRIMARY KEY,embedding TEXT)")
            .await
            .unwrap();
        pool.execute("CREATE TABLE licensing(license_key TEXT PRIMARY KEY,grace_period INTEGER)")
            .await
            .unwrap();
        pool
    }

    async fn create_target(temp: &TempDir) -> DatabaseManager {
        let target = temp.path().join("target.sqlite");
        let unused = temp.path().join("unused.db");
        DatabaseManager::new(&target.display().to_string(), &unused.display().to_string())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn imports_only_allowlisted_rows_and_is_idempotent() {
        let temp = TempDir::new().unwrap();
        let source_path = temp.path().join("legacy.sqlite");
        let source = create_source(&source_path, false).await;
        source.execute("INSERT INTO meetings VALUES('m1','Meeting','2026','2026',NULL,NULL,NULL,NULL,'calmee',NULL)").await.unwrap();
        source
            .execute(
                "INSERT INTO transcripts VALUES('t1','m1','hello','0',NULL,NULL,NULL,'mic',0,1,1)",
            )
            .await
            .unwrap();
        source
            .execute("INSERT INTO settings VALUES('default','secret')")
            .await
            .unwrap();
        source
            .execute("INSERT INTO voiceprints VALUES('v1','private-embedding')")
            .await
            .unwrap();
        source
            .execute("INSERT INTO licensing VALUES('private-license',604800)")
            .await
            .unwrap();
        source.close().await;
        let modified = fs::metadata(&source_path).unwrap().modified().unwrap();
        let target = create_target(&temp).await;

        let preview = build_preview(&source_path, &temp.path().join("target.sqlite"))
            .await
            .unwrap();
        assert_eq!(
            preview
                .categories
                .iter()
                .find(|category| category.key == "meetings")
                .unwrap()
                .rows,
            1
        );
        assert_eq!(preview.excluded_rows, 3);

        let first = import_allowlisted_data(target.pool(), &source_path, false)
            .await
            .unwrap();
        let second = import_allowlisted_data(target.pool(), &source_path, false)
            .await
            .unwrap();
        assert_eq!(first.inserted_rows, 2);
        assert_eq!(second.inserted_rows, 0);
        assert!(second.skipped_existing_rows >= 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM meetings")
                .fetch_one(target.pool())
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM settings")
                .fetch_one(target.pool())
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM voiceprints")
                .fetch_one(target.pool())
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            fs::metadata(&source_path).unwrap().modified().unwrap(),
            modified
        );
    }

    #[tokio::test]
    async fn rolls_back_everything_when_a_whitelisted_table_is_incompatible() {
        let temp = TempDir::new().unwrap();
        let source_path = temp.path().join("broken.sqlite");
        let source = create_source(&source_path, true).await;
        source.execute("INSERT INTO meetings VALUES('m1','Meeting','2026','2026',NULL,NULL,NULL,NULL,'calmee',NULL)").await.unwrap();
        source
            .execute("INSERT INTO transcripts VALUES('t1','m1','hello','0',NULL,NULL,NULL,0,1,1)")
            .await
            .unwrap();
        source.close().await;
        let target = create_target(&temp).await;

        assert!(import_allowlisted_data(target.pool(), &source_path, false)
            .await
            .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM meetings")
                .fetch_one(target.pool())
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn preserves_only_existing_audio_references_when_confirmed() {
        let temp = TempDir::new().unwrap();
        let source_path = temp.path().join("audio.sqlite");
        let existing = temp.path().join("recording");
        fs::create_dir(&existing).unwrap();
        let missing = temp.path().join("missing");
        let source = create_source(&source_path, false).await;
        sqlx::query(
            "INSERT INTO meetings VALUES('m1','One','2026','2026',?,NULL,NULL,NULL,'calmee',NULL)",
        )
        .bind(existing.display().to_string())
        .execute(&source)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO meetings VALUES('m2','Two','2026','2026',?,NULL,NULL,NULL,'calmee',NULL)",
        )
        .bind(missing.display().to_string())
        .execute(&source)
        .await
        .unwrap();
        source.close().await;
        let target = create_target(&temp).await;

        let report = import_allowlisted_data(target.pool(), &source_path, true)
            .await
            .unwrap();
        assert_eq!(report.preserved_audio_references, 1);
        assert_eq!(report.missing_audio_references, 1);
        let paths = sqlx::query("SELECT id,folder_path FROM meetings ORDER BY id")
            .fetch_all(target.pool())
            .await
            .unwrap();
        assert_eq!(
            paths[0].get::<Option<String>, _>("folder_path"),
            Some(existing.display().to_string())
        );
        assert_eq!(paths[1].get::<Option<String>, _>("folder_path"), None);
    }

    #[tokio::test]
    async fn clean_public_database_contains_no_private_migration_versions() {
        let temp = TempDir::new().unwrap();
        let target = create_target(&temp).await;
        let versions = sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations")
            .fetch_all(target.pool())
            .await
            .unwrap();
        assert!(!versions.contains(&20251105120000));
        assert!(!versions.contains(&20251110000000));
        assert!(!versions.contains(&20260810010000));
    }
}
