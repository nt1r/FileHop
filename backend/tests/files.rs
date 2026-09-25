use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use sqlx::Connection;
use tower::ServiceExt;
struct Fixture {
    _root: tempfile::TempDir,
    app: Router,
    cookie: String,
}
impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("database");
        let files = root.path().join("files");
        std::fs::create_dir(&database).unwrap();
        std::fs::create_dir(&files).unwrap();
        backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
            .await
            .unwrap();
        Self::from_paths(root).await
    }
    async fn from_paths(root: tempfile::TempDir) -> Self {
        let app = backend::app(root.path().join("database"), root.path().join("files"));
        Self::with_app(root, app).await
    }
    async fn with_app(root: tempfile::TempDir, app: Router) -> Self {
        let response = app
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
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        Self {
            _root: root,
            app,
            cookie,
        }
    }
    async fn request(&self, method: &str, path: &str, body: Body) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("origin", "https://filehop.invalid")
                    .header("content-type", "application/json")
                    .header("cookie", &self.cookie)
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn json(&self, method: &str, path: &str, value: Value) -> (StatusCode, Value) {
        let r = self
            .request(method, path, Body::from(value.to_string()))
            .await;
        let code = r.status();
        let data =
            serde_json::from_slice(&to_bytes(r.into_body(), 1024 * 1024).await.unwrap()).unwrap();
        (code, data)
    }
}
#[tokio::test]
async fn fresh_initialization_includes_file_schema_in_first_unreleased_migration() {
    let f = Fixture::new().await;
    let path = f._root.path().join("database/transfer.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(path);
    let mut db = sqlx::SqliteConnection::connect_with(&options)
        .await
        .unwrap();
    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(versions, 1, "首次发布前文件结构应与现有 0001 一起初始化");
    assert_eq!(
        f.json("GET", "/api/transfer-limits", Value::Null).await.0,
        StatusCode::OK
    );
    let input = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"fresh","size":0,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn concurrent_reservations_obey_quota_and_text_cannot_reuse_a_file_identity() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let mut config = backend::session::Config::default();
    config.transfer.quota = 5;
    config.transfer.max_file_size = 4;
    config.transfer.disk_reserve = 0;
    let f = Fixture::with_app(root, backend::app_with_config(database, files, config)).await;
    let send1 = uuid::Uuid::new_v4().to_string();
    let send2 = uuid::Uuid::new_v4().to_string();
    let a = json!({"send_id":send1,"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"a","size":3,"mime":"","source_label":"Web"});
    let b = json!({"send_id":send2,"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"b","size":3,"mime":"","source_label":"Web"});
    let (first, second) = tokio::join!(
        f.json("POST", "/api/file-sends", a.clone()),
        f.json("POST", "/api/file-sends", b.clone())
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&s| s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [first.0, second.0]
            .iter()
            .filter(|&&s| s == StatusCode::CONFLICT || s == StatusCode::TOO_MANY_REQUESTS)
            .count(),
        1
    );
    let winning = if first.0 == StatusCode::OK { a } else { b };
    assert_eq!(
        f.json("POST", "/api/file-sends", winning.clone()).await.1["state"],
        "prepared"
    );
    let text = json!({"send_id":winning["send_id"],"text":"not a file","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/messages", text).await.1["code"],
        "send_conflict"
    );
    assert_eq!(
        f.json("GET", "/api/transfer-limits", Value::Null).await.1["max_file_size_bytes"],
        4
    );
}
#[tokio::test]
async fn expired_preparation_cannot_start_writing_even_before_cleanup() {
    use std::sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    };
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let time = Arc::new(AtomicI64::new(now));
    let mut config = backend::session::Config::default();
    let clock = time.clone();
    config.now = Arc::new(move || clock.load(Ordering::SeqCst));
    config.transfer.prepare_timeout = std::time::Duration::from_secs(1);
    let f = Fixture::with_app(root, backend::app_with_config(database, files, config)).await;
    let send = uuid::Uuid::new_v4().to_string();
    let old = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":old,"name":"one","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    time.store(now + 10, Ordering::SeqCst);
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{old}/content"),
            Body::from("abc"),
        )
        .await;
    assert_ne!(response.status(), StatusCode::OK);
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn recovery_ends_uncommitted_attempt_without_creating_a_message() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"one","size":5,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    backend::files_recover(
        &f._root.path().join("database"),
        &f._root.path().join("files"),
    )
    .await
    .unwrap();
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.1["state"],
        "failed"
    );
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn committed_file_survives_recovery_and_missing_entity_reports_storage_error() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"report","size":4,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    let r = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("data"),
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    let message: Value =
        serde_json::from_slice(&to_bytes(r.into_body(), 1024).await.unwrap()).unwrap();
    let database = f._root.path().join("database");
    let files = f._root.path().join("files");
    backend::files_recover(&database, &files).await.unwrap();
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        message
    );
    std::fs::remove_file(files.join(message["file_id"].as_str().unwrap())).unwrap();
    let r = f
        .request(
            "GET",
            &format!("/api/files/{}", message["file_id"].as_str().unwrap()),
            Body::empty(),
        )
        .await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.1["kind"],
        "FILE"
    );
}
#[tokio::test]
async fn missing_or_wrong_origin_cannot_prepare_or_upload() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"private","size":3,"mime":"","source_label":"Web"});
    let request = |method: &str, path: String, origin: Option<&str>, body: Body| {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("cookie", &f.cookie)
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            builder = builder.header("origin", origin);
        }
        builder.body(body).unwrap()
    };
    for origin in [None, Some("https://other.invalid")] {
        let r = f
            .app
            .clone()
            .oneshot(request(
                "POST",
                "/api/file-sends".into(),
                origin,
                Body::from(input.to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let r = f
        .app
        .clone()
        .oneshot(request(
            "PUT",
            format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            None,
            Body::from("abc"),
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn nonempty_file_and_mismatched_length_follow_commit_boundary() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"report.txt","size":5,"mime":"text/plain","source_label":"Desk"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    let path = format!("/api/file-sends/{send}/attempts/{attempt}/content");
    let response = f.request("PUT", &path, Body::from("hello")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let message: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    assert_eq!(message["kind"], "FILE");
    let r = f
        .request(
            "GET",
            &format!("/api/files/{}", message["file_id"].as_str().unwrap()),
            Body::empty(),
        )
        .await;
    assert_eq!(to_bytes(r.into_body(), 1024).await.unwrap(), "hello");
    assert_eq!(
        f.request("PUT", &path, Body::from("changed"))
            .await
            .status(),
        StatusCode::OK
    );
    let (_, page) = f.json("GET", "/api/messages", Value::Null).await;
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    let second = uuid::Uuid::new_v4().to_string();
    let retry = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":second,"attempt_id":retry,"name":"bad.txt","size":5,"mime":"text/plain","source_label":"Desk"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let bad = f
        .request(
            "PUT",
            &format!("/api/file-sends/{second}/attempts/{retry}/content"),
            Body::from("hi"),
        )
        .await;
    assert_ne!(bad.status(), StatusCode::OK);
    assert_eq!(
        f.json("GET", &format!("/api/sends/{second}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}
#[tokio::test]
async fn defaults_allow_100_mib_but_reject_one_byte_above_without_consuming_quota() {
    let f = Fixture::new().await;
    let first = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),
        "name":"boundary","size":104_857_600,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", first).await.0,
        StatusCode::OK
    );
    let above = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),
        "name":"too-big","size":104_857_601,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", above).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn full_default_size_streams_without_collecting_upload_or_download() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let size = 104_857_600usize;
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"full.bin","size":size,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    // 每次只产生 64 KiB；测试端不把完整 100 MiB 预先装入请求体或响应体。
    let chunks = futures_util::stream::unfold(0usize, |n| async move {
        (n < 1600).then(|| (Ok::<_, std::io::Error>(vec![b'z'; 65536]), n + 1))
    });
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from_stream(chunks),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let message: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    let response = f
        .request(
            "GET",
            &format!("/api/files/{}", message["file_id"].as_str().unwrap()),
            Body::empty(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let mut received = 0usize;
    while let Some(chunk) = stream.try_next().await.unwrap() {
        assert!(chunk.iter().all(|byte| *byte == b'z'));
        received += chunk.len();
    }
    assert_eq!(received, size);
}

#[tokio::test]
async fn streamed_multi_megabyte_file_roundtrips_and_filename_cannot_inject_headers() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let size = 4 * 1024 * 1024;
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"报告\r\nX-Injected: 1/../bad.txt","size":size,"mime":"text/html","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    // 逐块产生内容而不在客户端组装整个请求体；服务器仍按固定块写入。
    let chunks =
        futures_util::stream::iter((0..64).map(|_| Ok::<_, std::io::Error>(vec![b'z'; 65536])));
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from_stream(chunks),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let message: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    let response = f
        .request(
            "GET",
            &format!("/api/files/{}", message["file_id"].as_str().unwrap()),
            Body::empty(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], size.to_string());
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    let disposition = response.headers()["content-disposition"].to_str().unwrap();
    assert!(disposition.starts_with("attachment; filename*=UTF-8''"));
    assert!(
        !disposition.contains('\n') && !disposition.contains('\r') && !disposition.contains('/')
    );
    let bytes = to_bytes(response.into_body(), size + 1).await.unwrap();
    assert_eq!(bytes.len(), size);
    assert!(bytes.iter().all(|&byte| byte == b'z'));
}

#[tokio::test]
async fn file_between_text_messages_keeps_history_and_incremental_cursors() {
    let f = Fixture::new().await;
    let first =
        json!({"send_id":uuid::Uuid::new_v4().to_string(),"text":"before","source_label":"Web"});
    let (status, before) = f.json("POST", "/api/messages", first).await;
    assert_eq!(status, StatusCode::CREATED);
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"between.txt","size":0,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::empty(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let file: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    let last =
        json!({"send_id":uuid::Uuid::new_v4().to_string(),"text":"after","source_label":"Web"});
    let (status, after) = f.json("POST", "/api/messages", last).await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, recent) = f.json("GET", "/api/messages?limit=2", Value::Null).await;
    assert_eq!(recent["messages"], json!([file, after]));
    assert_eq!(recent["sync_cursor"], after["id"]);
    let (_, older) = f
        .json(
            "GET",
            &format!(
                "/api/messages?before={}&limit=2",
                file["id"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    assert_eq!(older["messages"], json!([before]));
    let (_, incremental) = f
        .json(
            "GET",
            &format!(
                "/api/messages?after={}&limit=1",
                before["id"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    assert_eq!(incremental["messages"], json!([file]));
    assert_eq!(incremental["has_more"], true);
    let (_, following) = f
        .json(
            "GET",
            &format!("/api/messages?after={}", file["id"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(following["messages"], json!([after]));
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        file
    );
}

#[tokio::test]
async fn unread_download_times_out_and_releases_its_concurrency_slot() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let mut config = backend::session::Config::default();
    config.transfer.active_limit = 1;
    config.transfer.download_idle_timeout = std::time::Duration::from_secs(1);
    let f = Fixture::with_app(root, backend::app_with_config(database, files, config)).await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"slow","size":262144,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let chunks =
        futures_util::stream::iter((0..4).map(|_| Ok::<_, std::io::Error>(vec![b'x'; 65536])));
    let upload = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from_stream(chunks),
        )
        .await;
    assert_eq!(upload.status(), StatusCode::OK);
    let message: Value =
        serde_json::from_slice(&to_bytes(upload.into_body(), 1024).await.unwrap()).unwrap();
    let path = format!("/api/files/{}", message["file_id"].as_str().unwrap());
    let unread = f.request("GET", &path, Body::empty()).await;
    assert_eq!(unread.status(), StatusCode::OK);
    // 不 poll 响应体；生产者的有界队列满后必须独立超时并释放下载名额。
    let released = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let response = f.request("GET", &path, Body::empty()).await;
            if response.status() == StatusCode::OK {
                break true;
            }
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(released);
    drop(unread);
}

#[tokio::test]
async fn simultaneous_puts_have_one_writer_and_single_committed_message() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"raced","size":4,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let path = format!("/api/file-sends/{send}/attempts/{attempt}/content");
    let (one, two) = tokio::join!(
        f.request("PUT", &path, Body::from("aaaa")),
        f.request("PUT", &path, Body::from("bbbb"))
    );
    assert!([one.status(), two.status()].contains(&StatusCode::OK));
    let (_, page) = f.json("GET", "/api/messages", Value::Null).await;
    let messages = page["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    let content = f
        .request(
            "GET",
            &format!("/api/files/{}", messages[0]["file_id"].as_str().unwrap()),
            Body::empty(),
        )
        .await;
    let bytes = to_bytes(content.into_body(), 16).await.unwrap();
    assert!(bytes == "aaaa" || bytes == "bbbb");
}

#[tokio::test]
async fn empty_file_is_committed_once_and_downloaded_only_with_auth() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"empty.txt","size":0,"mime":"text/plain","source_label":"Desk"});
    assert_eq!(
        f.json("GET", "/api/transfer-limits", Value::Null).await.1["max_file_size_bytes"],
        104857600
    );
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    let path = format!("/api/file-sends/{send}/attempts/{attempt}/content");
    let response = f.request("PUT", &path, Body::empty()).await;
    let status = response.status();
    let message: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    assert_eq!(status, StatusCode::OK, "{message}");
    assert_eq!(message["kind"], "FILE");
    assert!(
        message.get("text").is_none(),
        "file messages cannot masquerade as empty text"
    );
    assert_eq!(message["file_state"], "available");
    assert_eq!(message["file_size"], 0);
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.1["kind"],
        "FILE"
    );
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        message
    );
    let r = f
        .request(
            "GET",
            &format!("/api/files/{}", message["file_id"].as_str().unwrap()),
            Body::empty(),
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-type"], "application/octet-stream");
    assert_eq!(to_bytes(r.into_body(), 1024).await.unwrap().len(), 0);
    let r = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/files/{}",
                    message["file_id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
}
