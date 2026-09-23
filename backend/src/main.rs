// ... existing imports
use axum::routing::{get, post};
use crate::file::{download_file, upload_file};

#[tokio::main]
async fn main() {
    // ... existing setup

    let app = Router::new()
        // ... existing routes
        .route("/api/upload", post(upload_file))
        .route("/api/download/:id", get(download_file));

    // ... run server
}
