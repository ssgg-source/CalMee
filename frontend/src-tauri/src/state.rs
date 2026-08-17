use crate::database::manager::DatabaseManager;
use serde::Serialize;
use std::sync::RwLock;

pub struct AppState {
    pub db_manager: DatabaseManager,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DatabaseStartupStatus {
    Initializing,
    Ready,
    Failed { message: String },
}

pub struct DatabaseStartupState {
    status: RwLock<DatabaseStartupStatus>,
}

impl Default for DatabaseStartupState {
    fn default() -> Self {
        Self {
            status: RwLock::new(DatabaseStartupStatus::Initializing),
        }
    }
}

impl DatabaseStartupState {
    pub fn ready(&self) {
        *self
            .status
            .write()
            .expect("database startup state poisoned") = DatabaseStartupStatus::Ready;
    }

    pub fn fail(&self, message: String) {
        *self
            .status
            .write()
            .expect("database startup state poisoned") = DatabaseStartupStatus::Failed { message };
    }

    pub fn snapshot(&self) -> DatabaseStartupStatus {
        self.status
            .read()
            .expect("database startup state poisoned")
            .clone()
    }
}

#[tauri::command]
pub fn get_database_startup_status(
    state: tauri::State<'_, DatabaseStartupState>,
) -> DatabaseStartupStatus {
    state.snapshot()
}
