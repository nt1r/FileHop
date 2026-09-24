use argon2::{Argon2, PasswordHasher};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use sha2::{Digest, Sha256};
use sqlx::{
    Connection, SqliteConnection,
    migrate::{Migration, MigrationType, Migrator},
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use tower::ServiceExt;

#[tokio::test]
async fn upgrade_existing_instance_preserves_account_session_message_and_send_identity() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    let path = database.join("transfer.db");
    let identity = uuid::Uuid::new_v4().to_string();
    std::fs::write(database.join("storage-id"), &identity).unwrap();
    std::fs::write(files.join("storage-id"), &identity).unwrap();
    let mut db = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal),
    )
    .await
    .unwrap();
    // 使用仓库原始迁移建立旧实例，不能手工重建一份相似但不等价的旧结构。
    let old = Migration::new(
        1,
        "next release".into(),
        MigrationType::Simple,
        sqlx::SqlStr::from_static(include_str!("../migrations/0001_next_release.sql")),
        false,
    );
    let historical = Migrator {
        migrations: vec![old].into(),
        ..Migrator::DEFAULT
    };
    historical.run(&mut db).await.unwrap();
    sqlx::query("INSERT INTO instance VALUES (1,?)")
        .bind(&identity)
        .execute(&mut db)
        .await
        .unwrap();
    let hash = Argon2::default()
        .hash_password(b" synthetic password ")
        .unwrap()
        .to_string();
    sqlx::query("INSERT INTO account VALUES (1,'admin',?)")
        .bind(&hash)
        .execute(&mut db)
        .await
        .unwrap();
    let old_token = "a".repeat(64);
    let digest = Sha256::digest(old_token.as_bytes()).to_vec();
    sqlx::query("INSERT INTO session VALUES (?,9999999999)")
        .bind(&digest)
        .execute(&mut db)
        .await
        .unwrap();
    let old_send = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO message (send_id,text,source_label,created_at) VALUES (?,'old text','Web','2026-01-01T00:00:00Z')")
        .bind(&old_send)
        .execute(&mut db).await.unwrap();
    sqlx::migrate!("./migrations").run(&mut db).await.unwrap();
    let row: (String, String, String) =
        sqlx::query_as("SELECT send_id,text,kind FROM message WHERE send_id=?")
            .bind(&old_send)
            .fetch_one(&mut db)
            .await
            .unwrap();
    assert_eq!(row, (old_send.clone(), "old text".into(), "TEXT".into()));
    let account: String = sqlx::query_scalar("SELECT password_hash FROM account WHERE singleton=1")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(account, hash);
    let session: i64 = sqlx::query_scalar("SELECT expires_at FROM session WHERE digest=?")
        .bind(&digest)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(session, 9999999999);
    let version: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(version, 2);
    db.close().await.unwrap();
    assert!(matches!(
        backend::storage::inspect(&database, &files).await,
        backend::storage::Status::Initialized
    ));
    // 迁移验证不止于直接查表：通过真实认证与历史/结果接口读取旧消息。
    let app = backend::app(database, files);
    let previous = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/session")
                .header("cookie", format!("__Host-filehop={old_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        previous.status(),
        StatusCode::OK,
        "old session remains usable after migration"
    );
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"username":"Admin","password":" synthetic password "})
                        .to_string(),
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
        .unwrap();
    for uri in [
        "/api/messages".to_string(),
        format!("/api/sends/{old_send}"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("old text"), "{uri}: {text}");
        assert!(text.contains("\"kind\":\"TEXT\""), "{uri}: {text}");
    }
}
