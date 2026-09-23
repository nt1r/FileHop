use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::messages::Message;

pub struct Storage {
    pub db: sqlx::SqlitePool,
    pub base_dir: PathBuf,
}

impl Storage {
    /// Return the absolute path where a file with the given id should be stored.
    pub fn file_path(&self, id: &Uuid) -> PathBuf {
        self.base_dir.join(id.to_string())
    }

    /// Retrieve the original filename for a stored file.
    pub fn get_message_filename(&self, id: &Uuid) -> Option<String> {
        // Query the messages table for the filename.
        // This is a lightweight helper used only by the download endpoint.
        let mut stmt = self
            .db
            .prepare("SELECT filename FROM messages WHERE id = ? AND type = 'file'")
            .ok()?;
        let row = stmt.query_row([id.to_string()], |row| {
            row.get::<String, _>("filename")
        }).ok()?;
        Some(row)
    }

    /// Persist a message record to the database.
    pub fn save_message(&self, msg: &Message) -> Result<(), sqlx::Error> {
        match msg {
            Message::Text { id, content, .. } => {
                sqlx::query(
                    "INSERT INTO messages (id, type, content, created_at) VALUES (?, 'text', ?, datetime('now'))",
                )
                .bind(id.to_string())
                .bind(content)
                .execute(&self.db)
                .map(|_| ())
            }
            Message::File { id, filename, size } => {
                sqlx::query(
                    "INSERT INTO messages (id, type, filename, size, created_at) VALUES (?, 'file', ?, ?, datetime('now'))",
                )
                .bind(id.to_string())
                .bind(filename)
                .bind(*size as i64)
                .execute(&self.db)
                .map(|_| ())
            }
        }
    }
}
