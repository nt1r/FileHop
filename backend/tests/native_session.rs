use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

struct Fixture {
    root: tempfile::TempDir,
    app: Router,
    clock: Arc<AtomicI64>,
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
        backend::files_recover(&database, &files).await.unwrap();
        let clock = Arc::new(AtomicI64::new(1_800_000_000));
        let time = clock.clone();
        let app = backend::app_with_config(
            database,
            files,
            backend::session::Config {
                now: Arc::new(move || time.load(Ordering::SeqCst)),
                ..Default::default()
            },
        );
        Self { root, app, clock }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        value: Value,
    ) -> axum::response::Response {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        self.app
            .clone()
            .oneshot(request.body(Body::from(value.to_string())).unwrap())
            .await
            .unwrap()
    }
    async fn login(&self) -> Value {
        let r = self
            .request(
                "POST",
                "/api/native/session",
                None,
                json!({"username":"Admin","password":" synthetic password "}),
            )
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.headers().get("set-cookie").is_none());
        assert_eq!(r.headers()["cache-control"], "no-store");
        body(r).await
    }
}
async fn body(r: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(r.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn credential_types_mixed_headers_logout_and_password_reset() {
    let f = Fixture::new().await;
    let login = f.login().await;
    let token = login["token"].as_str().unwrap();
    let web = f
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
    assert_eq!(web.status(), StatusCode::OK);
    let cookie = web.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let web_token = cookie.split_once('=').unwrap().1;
    for path in ["/api/messages", "/api/native/session"] {
        assert_eq!(
            f.request("GET", path, Some(web_token), Value::Null)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for cookie_value in [cookie.clone(), format!("__Host-filehop={token}")] {
            let r = f
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("cookie", cookie_value)
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        }
    }
    let r = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/messages")
                .header("cookie", format!("__Host-filehop={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    for _ in 0..2 {
        let r = f
            .request("DELETE", "/api/native/session", Some(token), Value::Null)
            .await;
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.headers().get("set-cookie").is_none());
    }
    assert_eq!(
        f.request("GET", "/api/messages", Some(token), Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let fresh = f.login().await;
    let web_current = || {
        f.app.clone().oneshot(
            Request::builder()
                .uri("/api/session")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
    };
    assert_eq!(web_current().await.unwrap().status(), StatusCode::OK);
    backend::storage::reset_password(
        &f.root.path().join("database"),
        &f.root.path().join("files"),
        " replacement password ",
    )
    .await
    .unwrap();
    assert_eq!(
        web_current().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request(
            "GET",
            "/api/native/session",
            fresh["token"].as_str(),
            Value::Null
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn native_file_apis_require_real_authentication_without_origin() {
    let f = Fixture::new().await;
    // File preparation timestamps use SQLite's clock; only session expiry tests advance time.
    f.clock.store(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64,
        Ordering::SeqCst,
    );
    let login = f.login().await;
    let token = login["token"].as_str().unwrap();
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let content = format!("/api/file-sends/{send}/attempts/{attempt}/content");
    let prepare = json!({"send_id":send,"attempt_id":attempt,"name":"native.txt","size":3,"mime":"text/plain","source_label":"Phone"});
    for (method, path, data) in [
        ("GET", "/api/messages", Value::Null),
        ("GET", "/api/storage", Value::Null),
        ("GET", "/api/files", Value::Null),
        ("GET", "/api/transfer-limits", Value::Null),
        ("POST", "/api/file-sends", prepare.clone()),
        ("PUT", content.as_str(), Value::Null),
        ("POST", "/api/files/status-query", json!({"file_ids":[]})),
    ] {
        for bad in [
            None,
            Some("invalid"),
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        ] {
            assert!(
                !f.request(method, path, bad, data.clone())
                    .await
                    .status()
                    .is_success(),
                "{method} {path}"
            );
        }
    }
    assert_eq!(
        f.request("POST", "/api/file-sends", Some(token), prepare)
            .await
            .status(),
        StatusCode::OK
    );
    let r = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(&content)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from("abc"))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status();
    let message = body(r).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    let file = message["file_id"].as_str().unwrap();
    let file_path = format!("/api/files/{file}");
    let r = f.request("GET", &file_path, Some(token), Value::Null).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(to_bytes(r.into_body(), 32).await.unwrap(), "abc");
    for path in [
        "/api/storage".to_owned(),
        "/api/files".to_owned(),
        format!("{file_path}/status"),
        format!("/api/file-sends/{send}"),
        format!("/api/sends/{send}"),
    ] {
        assert_eq!(
            f.request("GET", &path, Some(token), Value::Null)
                .await
                .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        f.request("HEAD", &file_path, Some(token), Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/files/status-query",
            Some(token),
            json!({"file_ids":[file]})
        )
        .await
        .status(),
        StatusCode::OK
    );
    for method in ["GET", "HEAD", "DELETE"] {
        assert_eq!(
            f.request(
                method,
                &file_path,
                Some("0000000000000000000000000000000000000000000000000000000000000000"),
                Value::Null
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        f.request("DELETE", &file_path, Some(token), Value::Null)
            .await
            .status(),
        StatusCode::ACCEPTED
    );
}

#[tokio::test]
async fn native_login_shared_text_and_fixed_expiry() {
    let f = Fixture::new().await;
    let login = f.login().await;
    let token = login["token"].as_str().unwrap();
    assert_eq!(login["expires_at"], 1_800_043_200i64);
    assert_eq!(login["server_time"], 1_800_000_000i64);
    let text = json!({"send_id":uuid::Uuid::new_v4().to_string(),"text":"  native\ntext  ","source_label":"Phone"});
    assert_eq!(
        f.request("POST", "/api/messages", Some(token), text.clone())
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        f.request("POST", "/api/messages", Some(token), text)
            .await
            .status(),
        StatusCode::OK
    );
    let history = body(
        f.request("GET", "/api/messages", Some(token), Value::Null)
            .await,
    )
    .await;
    assert_eq!(history["messages"].as_array().unwrap().len(), 1);
    assert_eq!(history["messages"][0]["text"], "  native\ntext  ");
    f.clock.fetch_add(43_199, Ordering::SeqCst);
    assert_eq!(
        body(
            f.request("GET", "/api/native/session", Some(token), Value::Null)
                .await
        )
        .await["expires_at"],
        login["expires_at"]
    );
    f.clock.fetch_add(1, Ordering::SeqCst);
    assert_eq!(
        f.request("GET", "/api/messages", Some(token), Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}
