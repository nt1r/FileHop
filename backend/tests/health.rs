use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use tower::ServiceExt;

async fn get(app: &axum::Router, path: &str) -> (StatusCode, serde_json::Value) {
    let response = app
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn database_can_be_available_while_recovery_blocks_new_uploads() {
    use sqlx::Connection;
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    // 先取得真实会话，再以 SQLite 写锁阻塞恢复；读取与认证仍然可用。
    let app = backend::app_after_recovery(database.clone(), files.clone(), Default::default());
    let login = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"username":"Admin","password":" synthetic password "}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(database.join("transfer.db")),
    )
    .await
    .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut db)
        .await
        .unwrap();
    let app = backend::app(database, files);
    assert_eq!(
        get(&app, "/internal/ready").await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"database_available":true,"uploads_ready":false})
        )
    );
    let input = serde_json::json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"synthetic.txt","size":4,"mime":"text/plain","source_label":"Web"}).to_string();
    let prepare = || {
        Request::builder()
            .method("POST")
            .uri("/api/file-sends")
            .header("origin", "https://filehop.invalid")
            .header("cookie", &cookie)
            .header("content-type", "application/json")
            .body(Body::from(input.clone()))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(prepare()).await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    sqlx::query("ROLLBACK").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while get(&app, "/internal/ready").await.0 != StatusCode::OK {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        app.oneshot(prepare()).await.unwrap().status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn health_distinguishes_live_database_and_upload_readiness_without_paths() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    let app = backend::app(database.clone(), files.clone());
    assert_eq!(
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/internal/live")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        get(&app, "/internal/ready").await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"database_available":false,"uploads_ready":false})
        )
    );
    drop(app);
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    backend::files_recover(&database, &files).await.unwrap();
    let app = backend::app_after_recovery(database.clone(), files.clone(), Default::default());
    assert_eq!(
        get(&app, "/internal/ready").await,
        (
            StatusCode::OK,
            serde_json::json!({"database_available":true,"uploads_ready":true})
        )
    );
    std::fs::rename(files.join("storage-id"), files.join("original-id")).unwrap();
    assert_eq!(
        get(&app, "/internal/ready").await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"database_available":true,"uploads_ready":false})
        )
    );
    assert_eq!(
        get(&app, "/api/status").await.1,
        serde_json::json!({"state":"storage_error"})
    );
    std::fs::rename(database.join("transfer.db"), database.join("original.db")).unwrap();
    assert_eq!(
        get(&app, "/internal/ready").await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"database_available":false,"uploads_ready":false})
        )
    );
    assert!(!database.join("transfer.db").exists());
}
