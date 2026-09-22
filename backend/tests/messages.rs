use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

struct Fixture {
    root: tempfile::TempDir,
    app: axum::Router,
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
        let app = backend::app(database, files);
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
            .to_owned();
        Self { root, app, cookie }
    }
    async fn request(&self, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("origin", "https://filehop.invalid")
                    .header("content-type", "application/json")
                    .header("cookie", &self.cookie)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .map(|v| v.to_str().unwrap()),
            Some("no-store")
        );
        let value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
                .unwrap();
        (status, value)
    }
    async fn send(&self, id: &str, text: &str, label: &str) -> (StatusCode, Value) {
        self.request(
            "POST",
            "/api/messages",
            json!({"send_id":id,"text":text,"source_label":label}),
        )
        .await
    }
}

#[tokio::test]
async fn validation_uses_shared_whitespace_and_utf8_boundaries() {
    let f = Fixture::new().await;
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../tests/text-cases.json")).unwrap();
    for case in cases {
        let (status, value) = f
            .send(
                &uuid::Uuid::new_v4().to_string(),
                case["text"].as_str().unwrap(),
                "Web",
            )
            .await;
        assert_eq!(
            status == StatusCode::CREATED,
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if status == StatusCode::CREATED {
            assert_eq!(value["text"], case["text"]);
        }
    }
    for (text, expected) in [
        ("a".repeat(65536), StatusCode::CREATED),
        ("😀".repeat(16384), StatusCode::CREATED),
        (
            format!("{}a", "😀".repeat(16384)),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        assert_eq!(
            f.send(&uuid::Uuid::new_v4().to_string(), &text, "Web")
                .await
                .0,
            expected
        );
    }
    for (label, expected) in [
        ("😀".repeat(64), StatusCode::CREATED),
        ("😀".repeat(65), StatusCode::UNPROCESSABLE_ENTITY),
        (" \u{0085} ".into(), StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        assert_eq!(
            f.send(&uuid::Uuid::new_v4().to_string(), "text", &label)
                .await
                .0,
            expected
        );
    }
}

#[tokio::test]
async fn concurrent_replays_conflicts_and_new_identity_survive_restart_and_reset() {
    let mut f = Fixture::new().await;
    let id = uuid::Uuid::new_v4().to_string();
    let (a, b) = tokio::join!(f.send(&id, "same", "Web"), f.send(&id, "same", "Web"));
    assert!([a.0, b.0].contains(&StatusCode::CREATED));
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert_eq!(a.1, b.1);
    for (text, label) in [("other", "Web"), ("same", "Other")] {
        assert_eq!(f.send(&id, text, label).await.0, StatusCode::CONFLICT);
    }
    assert_eq!(
        f.send(&uuid::Uuid::new_v4().to_string(), "same", "Web")
            .await
            .0,
        StatusCode::CREATED
    );
    f.app = backend::app(f.root.path().join("database"), f.root.path().join("files"));
    assert_eq!(
        f.send(&id, "same", "Web").await,
        (StatusCode::OK, a.1.clone())
    );
    let (_, recent) = f.request("GET", "/api/messages", Value::Null).await;
    assert_eq!(recent["messages"].as_array().unwrap().len(), 2);
    backend::storage::reset_password(
        &f.root.path().join("database"),
        &f.root.path().join("files"),
        " synthetic password ",
    )
    .await
    .unwrap();
    assert_eq!(f.send(&id, "same", "Web").await.0, StatusCode::UNAUTHORIZED);
    let response = f
        .app
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
    f.cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(f.send(&id, "same", "Web").await, (StatusCode::OK, a.1));
}

#[tokio::test]
async fn recent_limit_snapshot_and_invalid_queries() {
    let f = Fixture::new().await;
    let mut sent = Vec::new();
    for n in 0..53 {
        sent.push(
            f.send(
                &uuid::Uuid::new_v4().to_string(),
                &format!("item {n}"),
                "Web",
            )
            .await
            .1,
        );
    }
    let (_, recent) = f.request("GET", "/api/messages", Value::Null).await;
    assert_eq!(recent["messages"], json!(&sent[3..]));
    assert_eq!(recent["has_older"], true);
    assert_eq!(recent["sync_cursor"], sent[52]["id"]);
    let (_, small) = f.request("GET", "/api/messages?limit=2", Value::Null).await;
    assert_eq!(small["messages"], json!(&sent[51..]));
    for query in [
        "limit=0",
        "limit=101",
        "limit=abc",
        "before=2&after=1",
        "before=abc",
    ] {
        assert_eq!(
            f.request("GET", &format!("/api/messages?{query}"), Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn authentication_origin_and_body_errors_do_not_save_messages() {
    let f = Fixture::new().await;
    let body = json!({"send_id": uuid::Uuid::new_v4().to_string(), "text":"private", "source_label":"Web"}).to_string();
    for (method, cookie, origin, expected) in [
        (
            "GET",
            false,
            Some("https://filehop.invalid"),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "POST",
            false,
            Some("https://filehop.invalid"),
            StatusCode::UNAUTHORIZED,
        ),
        ("POST", true, None, StatusCode::FORBIDDEN),
        ("POST", true, Some("null"), StatusCode::FORBIDDEN),
        (
            "POST",
            true,
            Some("https://evil.invalid"),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri("/api/messages")
            .header("content-type", "application/json");
        if cookie {
            request = request.header("cookie", &f.cookie);
        }
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::from(body.clone())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    for (content_type, text, status, code) in [
        ("text/plain", body, StatusCode::BAD_REQUEST, "json_required"),
        (
            "application/json",
            "{".into(),
            StatusCode::BAD_REQUEST,
            "invalid_json",
        ),
        (
            "application/json",
            " ".repeat(512 * 1024 + 1),
            StatusCode::PAYLOAD_TOO_LARGE,
            "body_too_large",
        ),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/messages")
                    .header("cookie", &f.cookie)
                    .header("origin", "https://filehop.invalid")
                    .header("content-type", content_type)
                    .body(Body::from(text))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(value["code"], code);
    }
    let (_, recent) = f.request("GET", "/api/messages", Value::Null).await;
    assert_eq!(recent["messages"], json!([]));
}

#[tokio::test]
async fn database_rejection_never_reports_success_or_leaves_send_identity() {
    use sqlx::Connection;
    let f = Fixture::new().await;
    // 仅在一次性数据库建立写入故障；结果仍通过真实 HTTP 接口观察，不给应用增加调试入口。
    let mut db = sqlx::SqliteConnection::connect(
        f.root.path().join("database/transfer.db").to_str().unwrap(),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE commit_fault (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES commit_fault(id) DEFERRABLE INITIALLY DEFERRED)").execute(&mut db).await.unwrap();
    // 延迟外键在 COMMIT 才拒绝，覆盖已执行 INSERT 却不能报告成功的关键窗口。
    sqlx::query("CREATE TRIGGER reject_message AFTER INSERT ON message BEGIN INSERT INTO commit_fault VALUES (1, 2); END").execute(&mut db).await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let (status, value) = f.send(&id, "atomic text", "Web").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(value["code"], "unavailable");
    assert!(!value.to_string().contains("test failure"));
    assert_eq!(
        f.request("GET", "/api/messages", Value::Null).await.1["messages"],
        json!([])
    );
    sqlx::query("DROP TRIGGER reject_message")
        .execute(&mut db)
        .await
        .unwrap();
    assert_eq!(
        f.send(&id, "atomic text", "Web").await.0,
        StatusCode::CREATED
    );
}

#[tokio::test]
async fn committed_text_is_returned_verbatim_in_recent_snapshot() {
    let f = Fixture::new().await;
    let (_, empty) = f.request("GET", "/api/messages", Value::Null).await;
    assert_eq!(empty["messages"], json!([]));
    assert_eq!(empty["sync_cursor"], "0");
    let id = uuid::Uuid::new_v4().to_string();
    let (status, message) = f
        .send(&id, "  <b>中文</b>\n  code\n", "\u{0085} Desk \u{3000}")
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(message["text"], "  <b>中文</b>\n  code\n");
    assert_eq!(message["source_label"], "Desk");
    assert_eq!(message["send_id"], id);
    assert!(message["id"].as_str().unwrap().parse::<u64>().unwrap() > 0);
    assert!(message["created_at"].as_str().unwrap().ends_with('Z'));
    let (status, recent) = f.request("GET", "/api/messages", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(recent["messages"], json!([message]));
    assert_eq!(recent["sync_cursor"], message["id"]);
    assert_eq!(recent["before"], message["id"]);
    assert_eq!(recent["has_older"], false);
}
