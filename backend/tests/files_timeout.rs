use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn stalled_writer_is_cleaned_before_quota_can_be_reused() {
    check_stalled_writer(1, 30).await;
}

#[tokio::test]
async fn overall_deadline_ends_a_writer_even_when_idle_limit_has_not_elapsed() {
    check_stalled_writer(30, 1).await;
}

#[tokio::test]
async fn progressing_upload_may_take_longer_than_json_timeout() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("db");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let mut config = backend::session::Config::default();
    config.transfer.idle_timeout = std::time::Duration::from_secs(20);
    config.transfer.total_timeout = std::time::Duration::from_secs(25);
    let app = backend::app_with_config(database, files, config);
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"username":"Admin","password":" synthetic password "}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let send = uuid::Uuid::new_v4();
    let attempt = uuid::Uuid::new_v4();
    let request = |method: &str, path: String, body: Body| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("origin", "https://filehop.invalid")
            .header("cookie", cookie)
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    };
    let input = json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"progress","size":2,"mime":"","source_label":"Web"});
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/file-sends".into(),
                Body::from(input.to_string())
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let stream = futures_util::stream::unfold(0, |n| async move {
        match n {
            0 => Some((Ok::<_, std::io::Error>(vec![b'a']), 1)),
            1 => {
                tokio::time::sleep(std::time::Duration::from_secs(16)).await;
                Some((Ok(vec![b'b']), 2))
            }
            _ => None,
        }
    });
    let response = app
        .oneshot(request(
            "PUT",
            format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from_stream(stream),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(value["kind"], "FILE");
}

async fn check_stalled_writer(idle_seconds: u64, total_seconds: u64) {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("db");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let mut config = backend::session::Config::default();
    config.transfer.quota = 4;
    config.transfer.max_file_size = 4;
    config.transfer.idle_timeout = std::time::Duration::from_secs(idle_seconds);
    config.transfer.total_timeout = std::time::Duration::from_secs(total_seconds);
    let app = backend::app_with_config(database, files.clone(), config);
    let login = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"username":"Admin","password":" synthetic password "}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let request = |method: &str, path: String, body: Body| {
        Request::builder()
            .method(method)
            .uri(path)
            .header("origin", "https://filehop.invalid")
            .header("cookie", &cookie)
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    };
    let send = uuid::Uuid::new_v4();
    let attempt = uuid::Uuid::new_v4();
    let prepare = json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"slow","size":4,"mime":"","source_label":"Web"});
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/file-sends".into(),
                Body::from(prepare.to_string())
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let stream = futures_util::stream::pending::<Result<Vec<u8>, std::io::Error>>();
    let upload = app.clone().oneshot(request(
        "PUT",
        format!("/api/file-sends/{send}/attempts/{attempt}/content"),
        Body::from_stream(stream),
    ));
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), upload)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    let next = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"next","size":4,"mime":"","source_label":"Web"});
    let response = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/file-sends".into(),
            Body::from(next.to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&to_bytes(response.into_body(), 65536).await.unwrap())
    );
    assert_eq!(
        std::fs::read_dir(files)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != "storage-id")
            .count(),
        0
    );
}
