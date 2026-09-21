use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use sqlx::Connection;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

struct Fixture {
    _root: tempfile::TempDir,
    app: axum::Router,
    clock: Arc<AtomicI64>,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_proxy(None).await
    }
    async fn with_proxy(trusted_proxy: Option<std::net::IpAddr>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("database");
        let files = root.path().join("files");
        std::fs::create_dir(&database).unwrap();
        std::fs::create_dir(&files).unwrap();
        backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
            .await
            .unwrap();
        let clock = Arc::new(AtomicI64::new(1_800_000_000));
        let time = clock.clone();
        let app = backend::app_with_config(
            database,
            files,
            backend::session::Config {
                trusted_proxy,
                now: Arc::new(move || time.load(Ordering::SeqCst)),
                ..Default::default()
            },
        );
        Self {
            _root: root,
            app,
            clock,
        }
    }
    async fn login(&self, username: &str, password: &str) -> axum::response::Response {
        self.app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("origin", "https://filehop.invalid")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"username":username, "password":password}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn logout_is_idempotent_origin_protected_and_only_revokes_current_session() {
    let f = Fixture::new().await;
    let first = f.login("Admin", " synthetic password ").await;
    let second = f.login("Admin", " synthetic password ").await;
    let cookie = |response: &axum::response::Response| {
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    };
    let first = cookie(&first);
    let second = cookie(&second);
    for origin in [None, Some("null"), Some("https://evil.invalid")] {
        let mut request = Request::builder()
            .method("DELETE")
            .uri("/api/session")
            .header("cookie", &first);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.headers().get("set-cookie").is_none());
    }
    for token in [
        Some(first.as_str()),
        Some(first.as_str()),
        Some("__Host-filehop=invalid"),
        None,
    ] {
        let mut request = Request::builder()
            .method("DELETE")
            .uri("/api/session")
            .header("origin", "https://filehop.invalid");
        if let Some(token) = token {
            request = request.header("cookie", token);
        }
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(
            response.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .contains("Max-Age=0")
        );
    }
    for (token, expected) in [(first, StatusCode::UNAUTHORIZED), (second, StatusCode::OK)] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("cookie", token)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}

#[tokio::test]
async fn expired_logout_clears_cookie_but_storage_failure_does_not_claim_revocation() {
    let f = Fixture::new().await;
    let response = f.login("Admin", " synthetic password ").await;
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    f.clock.fetch_add(43_200, Ordering::SeqCst);
    let logout = || {
        f.app.clone().oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
    };
    let response = logout().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    std::fs::write(f._root.path().join("files/storage-id"), "mismatched").unwrap();
    let response = logout().await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().get("set-cookie").is_none());
}

#[tokio::test]
async fn only_exact_controlled_proxy_can_supply_a_single_client_address() {
    let f = Fixture::with_proxy(Some("192.0.2.1".parse().unwrap())).await;
    for (peer, source, expected) in [
        ("192.0.2.1:8080", None, StatusCode::BAD_REQUEST),
        (
            "192.0.2.1:8080",
            Some("203.0.113.1, 203.0.113.2"),
            StatusCode::BAD_REQUEST,
        ),
        ("192.0.2.1:8080", Some("203.0.113.1"), StatusCode::OK),
        ("192.0.2.2:8080", Some("untrusted ignored"), StatusCode::OK),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/session")
            .header("origin", "https://filehop.invalid")
            .header("content-type", "application/json")
            .extension(axum::extract::ConnectInfo(
                peer.parse::<std::net::SocketAddr>().unwrap(),
            ));
        if let Some(source) = source {
            request = request.header("x-filehop-client-ip", source);
        }
        let response = f
            .app
            .clone()
            .oneshot(
                request
                    .body(Body::from(
                        r#"{"username":"Admin","password":" synthetic password "}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
}

#[tokio::test]
async fn uninitialized_login_never_creates_storage() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    let response = backend::app(database.clone(), files.clone())
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
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(std::fs::read_dir(database).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(files).unwrap().count(), 0);
}

#[tokio::test]
async fn session_expires_at_exactly_twelve_hours_without_read_renewal() {
    let f = Fixture::new().await;
    let response = f.login("Admin", " synthetic password ").await;
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    for (elapsed, expected) in [(43199, StatusCode::OK), (43200, StatusCode::UNAUTHORIZED)] {
        f.clock.store(1_800_000_000 + elapsed, Ordering::SeqCst);
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(response.headers().get("set-cookie").is_none());
    }
}

#[tokio::test]
async fn login_rejects_cross_origin_and_non_json_requests_without_leaking_details() {
    let f = Fixture::new().await;
    for origin in [
        None,
        Some("null"),
        Some("https://evil.invalid"),
        Some("https://filehop.invalid/"),
    ] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/session")
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::from("{}")).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    for (content_type, body, expected) in [
        ("text/plain", "{}".into(), StatusCode::BAD_REQUEST),
        ("application/json", "{".into(), StatusCode::BAD_REQUEST),
        (
            "application/json",
            "x".repeat(8193),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        let response = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session")
                    .header("origin", "https://filehop.invalid")
                    .header("content-type", content_type)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert!(response.headers().get("set-cookie").is_none());
    }
    for (username, password) in [
        ("Admin", "wrong password"),
        ("unknown", " synthetic password "),
        (" Admin", " synthetic password "),
    ] {
        let response = f.login(username, password).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"code":"invalid_credentials","message":"用户名或密码错误"})
        );
    }
}

#[tokio::test]
async fn failure_window_is_bounded_and_concurrent_requests_cannot_bypass_it() {
    let f = Fixture::new().await;
    for _ in 0..9 {
        assert_eq!(
            f.login("unknown", "wrong password").await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let (a, b, c) = tokio::join!(
        f.login("unknown", "wrong password"),
        f.login("unknown", "wrong password"),
        f.login("unknown", "wrong password")
    );
    let statuses = [a.status(), b.status(), c.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::UNAUTHORIZED)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::TOO_MANY_REQUESTS)
            .count(),
        2
    );
    let rejected = f.login("Admin", " synthetic password ").await;
    assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(rejected.headers()["retry-after"], "900");
    // 未受信任的来源头不能更换节流身份。
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .header("x-filehop-client-ip", "203.0.113.55")
                .header("x-forwarded-for", "203.0.113.55")
                .body(Body::from(
                    r#"{"username":"Admin","password":" synthetic password "}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    f.clock.fetch_add(900, Ordering::SeqCst);
    assert_eq!(
        f.login("Admin", " synthetic password ").await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn global_verification_overload_rejects_without_an_unbounded_queue() {
    let f = Fixture::new().await;
    let (a, b, c) = tokio::join!(
        f.login("Admin", " synthetic password "),
        f.login("Admin", " synthetic password "),
        f.login("Admin", " synthetic password ")
    );
    let statuses = [a.status(), b.status(), c.status()];
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::OK).count(), 2);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::TOO_MANY_REQUESTS)
            .count(),
        1
    );
}

#[tokio::test]
async fn login_restores_a_fixed_lifetime_session_after_restart() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    // 安全检查需要同时扫描主库与 WAL：登录连接异步关闭时，SQLite 可能删除
    // WAL/SHM，导致列目录后文件消失。先建立真实读取快照并持有到扫描完成，
    // 让登录仍可提交到 WAL，同时避免漏检暂未合并到主库的凭证数据。
    let mut observer = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(database.join("transfer.db"))
            .create_if_missing(false)
            .read_only(true),
    )
    .await
    .unwrap();
    let mut snapshot = observer.begin().await.unwrap();
    sqlx::query("SELECT name FROM sqlite_schema")
        .fetch_all(&mut *snapshot)
        .await
        .unwrap();
    let app = backend::app(database.clone(), files.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"username":"ADMIN","password":" synthetic password "}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .to_owned();
    for attribute in [
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=43200",
    ] {
        assert!(cookie.contains(attribute));
    }
    assert!(!cookie.contains("Domain="));
    // 持久化安全边界：磁盘文件不得包含浏览器拿到的原始凭证，不依赖具体表结构。
    let token = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
    for entry in std::fs::read_dir(&database).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(
            !bytes
                .windows(token.len())
                .any(|window| window == token.as_bytes())
        );
    }
    snapshot.rollback().await.unwrap();
    observer.close().await.unwrap();
    let login: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    let response = backend::app(database, files)
        .oneshot(
            Request::builder()
                .uri("/api/session")
                .header("cookie", cookie.split(';').next().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers().get("set-cookie").is_none());
    let restored: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap();
    assert_eq!(login["expires_at"], restored["expires_at"]);
}
