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

// CLI 拥有存储锁；嵌入式 app 的调用者仍须自行保证单实例。
// 空目录启动只提供诊断，在线初始化后也必须先取得锁并恢复，才能创建业务路由。
pub async fn managed_app(
    database: PathBuf,
    files: PathBuf,
    config: session::Config,
) -> Result<Router, Box<dyn std::error::Error + Send + Sync>> {
    async fn activate(
        database: &std::path::Path,
        files: &std::path::Path,
        config: &session::Config,
    ) -> Result<Option<(Vec<std::fs::File>, Router)>, Box<dyn std::error::Error + Send + Sync>>
    {
        match storage::inspect(database, files).await {
            storage::Status::Uninitialized => Ok(None),
            storage::Status::StorageError => Err("storage unavailable; startup refused".into()),
            storage::Status::Initialized => {
                let locks = storage::lock_instance(database, files)?;
                files_recover(database, files).await?;
                Ok(Some((
                    locks,
                    app_after_recovery(database.to_path_buf(), files.to_path_buf(), config.clone()),
                )))
            }
        }
    }
    let active = std::sync::Arc::new(tokio::sync::Mutex::new(
        activate(&database, &files, &config).await?,
    ));
    Ok(
        Router::new().fallback(move |request: axum::extract::Request| {
            let active = active.clone();
            let database = database.clone();
            let files = files.clone();
            let config = config.clone();
            async move {
                use axum::response::IntoResponse;
                use tower::ServiceExt;
                let mut guard = active.lock().await;
                if guard.is_none()
                    && let Ok(value) = activate(&database, &files, &config).await
                {
                    *guard = value;
                }
                if let Some((_, app)) = guard.as_ref() {
                    let app = app.clone();
                    drop(guard);
                    return app.oneshot(request).await.unwrap();
                }
                // 未初始化不创建业务路由或后台清理者；init 仍可独立取得目录锁。
                match (request.method(), request.uri().path()) {
                    (&axum::http::Method::GET, "/internal/live") => {
                        StatusCode::NO_CONTENT.into_response()
                    }
                    (&axum::http::Method::GET, "/internal/ready") => (
                        StatusCode::SERVICE_UNAVAILABLE,
                        [(header::CACHE_CONTROL, "no-store")],
                        Json(serde_json::json!({"database_available":false,"uploads_ready":false})),
                    )
                        .into_response(),
                    (&axum::http::Method::GET, "/api/status") => (
                        [(header::CACHE_CONTROL, "no-store")],
                        Json(
                            serde_json::json!({"state":storage::inspect(&database, &files).await}),
                        ),
                    )
                        .into_response(),
                    _ => session::unavailable(),
                }
            }
        }),
    )
}

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
