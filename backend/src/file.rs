use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::{messages::Message, storage::Storage};

#[derive(Serialize)]
pub struct UploadResponse {
    pub id: Uuid,
    pub filename: String,
    pub size: u64,
}

/// Upload a single file. The request must contain a multipart form
/// with a single field named `file`. The file is stored on disk
/// and a message record is created in the database.
pub async fn upload_file(
    State(storage): State<Storage>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, StatusCode> {
    // Expect a single file field named "file"
    let field = multipart
        .next_field()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .ok_or(StatusCode::BAD_REQUEST)?;

    let name = field.file_name().ok_or(StatusCode::BAD_REQUEST)?;
    let data = field.bytes().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let size = data.len() as u64;

    // Store file
    let id = Uuid::new_v4();
    let path = storage.file_path(&id);
    std::fs::write(&path, &data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Create message record
    let msg = Message::File {
        id,
        filename: name.to_string(),
        size,
    };
    storage
        .save_message(&msg)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(UploadResponse {
        id,
        filename: name.to_string(),
        size,
    }))
}

/// Download a previously uploaded file. The file is streamed
/// back to the client with the correct MIME type and a
/// `Content-Disposition` header that triggers a download.
pub async fn download_file(
    State(storage): State<Storage>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, StatusCode> {
    let path = storage.file_path(&id);
    if !path.exists() {
        return Err(StatusCode::NOT_FOUND);
    }
    let data = std::fs::read(&path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let filename = storage
        .get_message_filename(&id)
        .unwrap_or_else(|| "file".to_string());
    let mime = mime_guess::from_path(&filename).first_or_octet_stream();

    Ok(axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime.as_ref())
        .header(
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", filename),
        )
        .body(data.into())
        .unwrap())
}
