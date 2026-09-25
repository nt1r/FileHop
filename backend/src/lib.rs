mod files;
pub use files::{TransferConfig, recover as files_recover};
mod messages;
pub mod session;
pub mod storage;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    routing::get,
};
use std::path::PathBuf;

pub fn app(database: PathBuf, files: PathBuf) -> Router {
    app_with_config(database, files, session::Config::default())
}

pub fn app_with_config(database: PathBuf, files: PathBuf, config: session::Config) -> Router {
    app_router(database, files, config, false)
}

// 启动命令先协调再监听；嵌入式路由仍会在后台协调并拒绝未就绪的上传。
pub fn app_after_recovery(database: PathBuf, files: PathBuf, config: session::Config) -> Router {
    app_router(database, files, config, true)
}

fn app_router(
    database: PathBuf,
    files: PathBuf,
    config: session::Config,
    recovered: bool,
) -> Router {
    Router::new()
        .merge(if recovered {
            session::recovered_router(database.clone(), files.clone(), config)
        } else {
            session::router(database.clone(), files.clone(), config)
        })
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
