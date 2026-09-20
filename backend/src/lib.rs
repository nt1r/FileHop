pub mod storage;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    routing::get,
};
use std::path::PathBuf;

pub fn app(database: PathBuf, files: PathBuf) -> Router {
    Router::new()
        .route("/internal/live", get(|| async { StatusCode::NO_CONTENT }))
        .route(
            "/api/status",
            get(move || {
                let database = database.clone();
                let files = files.clone();
                async move {
                    let state = storage::inspect(&database, &files).await;
                    (
                        [(header::CACHE_CONTROL, "no-store")],
                        Json(serde_json::json!({"state": state})),
                    )
                }
            }),
        )
}
