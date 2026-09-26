use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::Connection;
use tower::ServiceExt;

struct Instance {
    _root: tempfile::TempDir,
    app: Router,
    cookie: String,
    database: std::path::PathBuf,
    files: std::path::PathBuf,
}
impl Instance {
    async fn new() -> Self {
        Self::with_limits(3, 120).await
    }
    async fn with_limits(quota: i64, idle_seconds: u64) -> Self {
        Self::with_prepare_timeout(quota, idle_seconds, 120).await
    }
    async fn with_prepare_timeout(quota: i64, idle_seconds: u64, prepare_seconds: u64) -> Self {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("database");
        let files = root.path().join("files");
        std::fs::create_dir(&database).unwrap();
        std::fs::create_dir(&files).unwrap();
        backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
            .await
            .unwrap();
        let mut config = backend::session::Config::default();
        config.transfer.quota = quota;
        config.transfer.max_file_size = quota;
        config.transfer.idle_timeout = std::time::Duration::from_secs(idle_seconds);
        config.transfer.prepare_timeout = std::time::Duration::from_secs(prepare_seconds);
        let app = backend::app_with_config(database.clone(), files.clone(), config);
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
        Self {
            _root: root,
            app,
            cookie,
            database,
            files,
        }
    }
    async fn request(&self, method: &str, path: &str, body: Body) -> (StatusCode, Value) {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("origin", "https://filehop.invalid")
                    .header("cookie", &self.cookie)
                    .header("content-type", "application/json")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        (status, body)
    }
}
// 只轮询只读状态接口；不能用准备/后继请求顺带触发协调，冒充后台清理证据。
async fn wait_for_state(i: &Instance, send: &str, expected: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let (status, body) = i
                .request("GET", &format!("/api/file-sends/{send}"), Body::empty())
                .await;
            assert_eq!(status, StatusCode::OK);
            if body["state"] == expected {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("background maintenance did not reach the expected state");
}

#[tokio::test]
async fn unused_preparation_expires_without_another_write_request() {
    let i = Instance::with_prepare_timeout(3, 120, 1).await;
    let send = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":uuid::Uuid::new_v4().to_string(),
        "name":"unused","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(input.to_string()))
            .await
            .0,
        StatusCode::OK
    );
    wait_for_state(&i, &send, "failed").await;
    assert_eq!(
        i.request("GET", &format!("/api/sends/{send}"), Body::empty())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // 先观察后台终结，再申请完整额度；新请求不是清理的触发器。
    let next = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),
        "name":"next","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(next.to_string()))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn background_cleanup_retries_after_failure_without_another_write_request() {
    let i = Instance::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,
        "name":"blocked","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(input.to_string()))
            .await
            .0,
        StatusCode::OK
    );
    // 仅用存储边界注入不可删除实体；状态及最终额度从 HTTP 验证。
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(i.database.join("transfer.db")),
    )
    .await
    .unwrap();
    let file_id: String = sqlx::query_scalar("SELECT file_id FROM file_send WHERE send_id=?")
        .bind(&send)
        .fetch_one(&mut db)
        .await
        .unwrap();
    drop(db);
    let abnormal = i.files.join(format!("{file_id}.partial"));
    std::fs::create_dir(&abnormal).unwrap();
    std::fs::write(abnormal.join("blocker"), b"synthetic").unwrap();
    // 等到写入请求明确报告清理失败再解除故障，避免只看 cleaning 就与首次删除竞争。
    let (status, body) = i
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("abc"),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "cleanup_pending");
    wait_for_state(&i, &send, "cleaning").await;
    assert!(abnormal.join("blocker").exists());
    // 解除故障后不发任何写请求，等待后台重试。
    std::fs::remove_file(abnormal.join("blocker")).unwrap();
    std::fs::remove_dir(&abnormal).unwrap();
    std::fs::write(&abnormal, b"abc").unwrap();
    wait_for_state(&i, &send, "failed").await;
    assert!(!abnormal.exists());
    assert_eq!(
        i.request("GET", &format!("/api/sends/{send}"), Body::empty())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let next = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),
        "name":"next","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(next.to_string()))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn broken_cleanup_does_not_starve_items_beyond_first_page() {
    let i = Instance::new().await;
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(i.database.join("transfer.db")),
    )
    .await
    .unwrap();
    let mut last = String::new();
    // 注入 64 个无法删除的受管实体以及一个正常待清理记录，模拟失败队列积压。
    for n in 1..=65u128 {
        let send = uuid::Uuid::from_u128(n).to_string();
        let attempt = uuid::Uuid::from_u128(n + 100).to_string();
        let file = uuid::Uuid::from_u128(n + 200).to_string();
        sqlx::query("INSERT INTO file_send (send_id,attempt_id,file_id,name,size,mime,source_label,state,reserved,prepared_at) VALUES (?,?,?,'old',1,'','Web','cleaning',1,0)")
            .bind(&send).bind(&attempt).bind(&file).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'cleaning')")
            .bind(&attempt)
            .bind(&send)
            .execute(&mut db)
            .await
            .unwrap();
        if n <= 64 {
            std::fs::create_dir(i.files.join(format!("{file}.partial"))).unwrap();
        }
        last = send;
    }
    let input = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),
        "name":"new","size":1,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(input.to_string()))
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    // 第二轮绕过失败页，清理第 65 项；剩余 64 字节仍预留，准入应拒绝。
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(input.to_string()))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let reserved: i64 = sqlx::query_scalar("SELECT reserved FROM file_send WHERE send_id=?")
        .bind(last)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(
        reserved, 0,
        "失败项不能长期占据协调窗口，让后面的正常记录无法释放"
    );
}

#[tokio::test]
async fn failed_commit_after_entity_is_written_cleans_it_without_reporting_success() {
    let i = Instance::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"abort.txt","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(input.to_string()))
            .await
            .0,
        StatusCode::OK
    );
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(i.database.join("transfer.db")),
    )
    .await
    .unwrap();
    // 在 SQLite 公共存储边界注入 COMMIT 之前的插入故障，不向线上暴露调试路由。
    sqlx::query("CREATE TRIGGER fail_file_commit BEFORE INSERT ON message WHEN NEW.kind='FILE' BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END")
        .execute(&mut db).await.unwrap();
    let (status, _) = i
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("abc"),
        )
        .await;
    assert_ne!(status, StatusCode::OK);
    let (status, _) = i
        .request("GET", &format!("/api/sends/{send}"), Body::empty())
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let reserved: i64 = sqlx::query_scalar("SELECT reserved FROM file_send WHERE send_id=?")
        .bind(&send)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(reserved, 0);
    assert_eq!(
        std::fs::read_dir(&i.files)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name() != "storage-id")
            .count(),
        0
    );
}

#[tokio::test]
async fn cleanup_failure_keeps_quota_until_entity_is_removed() {
    let i = Instance::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"broken","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(input.to_string()))
            .await
            .0,
        StatusCode::OK
    );
    // 在受管目录人为放入同名非文件，模拟清理时遇到不能删除的异常实体。
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(i.database.join("transfer.db")),
    )
    .await
    .unwrap();
    let file_id: String = sqlx::query_scalar("SELECT file_id FROM file_send WHERE send_id=?")
        .bind(&send)
        .fetch_one(&mut db)
        .await
        .unwrap();
    let abnormal = i.files.join(format!("{file_id}.partial"));
    std::fs::create_dir(&abnormal).unwrap();
    let path = format!("/api/file-sends/{send}/attempts/{attempt}/content");
    assert_ne!(
        i.request("PUT", &path, Body::from("abc")).await.0,
        StatusCode::OK
    );
    let reserved: i64 = sqlx::query_scalar("SELECT reserved FROM file_send WHERE send_id=?")
        .bind(&send)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(reserved, 3, "清理未完成不应释放额度");
    std::fs::remove_dir(&abnormal).unwrap();
    // 再一次准备会触发协调，确认实体消失后才释放旧额度。
    let next = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"new","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        i.request("POST", "/api/file-sends", Body::from(next.to_string()))
            .await
            .0,
        StatusCode::OK
    );
    let reserved: i64 = sqlx::query_scalar("SELECT reserved FROM file_send WHERE send_id=?")
        .bind(&send)
        .fetch_one(&mut db)
        .await
        .unwrap();
    assert_eq!(reserved, 0);
}
