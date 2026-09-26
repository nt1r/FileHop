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
async fn deletion_preserves_history_and_send_identity_until_physical_cleanup() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"delete.txt","size":3,"mime":"","source_label":"Desk"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    let r = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("abc"),
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    let original: Value =
        serde_json::from_slice(&to_bytes(r.into_body(), 4096).await.unwrap()).unwrap();
    let file = original["file_id"].as_str().unwrap();
    let path = format!("/api/files/{file}");
    let (code, accepted) = f.json("DELETE", &path, Value::Null).await;
    assert_eq!(code, StatusCode::ACCEPTED);
    assert_eq!(
        accepted,
        json!({"file_id":file,"file_state":"deleting","state_version":"2"})
    );
    assert_eq!(f.json("DELETE", &path, Value::Null).await.1, accepted);
    assert_ne!(
        f.request("GET", &path, Body::empty()).await.status(),
        StatusCode::OK
    );
    let usage = f.json("GET", "/api/storage", Value::Null).await.1;
    assert_eq!(usage["saved_bytes"], "0");
    assert_eq!(usage["cleaning_bytes"], "3");
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let state = f
                .json("GET", &format!("{path}/status"), Value::Null)
                .await
                .1;
            if state["file_state"] == "deleted" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert!(!f._root.path().join("files").join(file).exists());
    assert_eq!(
        f.json("DELETE", &path, Value::Null).await,
        (
            StatusCode::OK,
            json!({"file_id":file,"file_state":"deleted","state_version":"3"})
        )
    );
    let mut expected = original;
    expected["file_state"] = json!("deleted");
    expected["state_version"] = json!("3");
    assert_eq!(f.json("POST", "/api/file-sends", input).await.1, expected);
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        expected
    );
    assert_eq!(
        f.json("GET", "/api/messages", Value::Null).await.1["messages"][0],
        expected
    );
    assert_eq!(
        f.json("GET", "/api/files", Value::Null).await.1["files"],
        json!([])
    );
    assert_eq!(
        f.json("GET", "/api/storage", Value::Null).await.1["cleaning_bytes"],
        "0"
    );
}

#[tokio::test]
async fn active_read_rejects_delete_and_cancellation_releases_it_without_queued_deletion() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4();
    let attempt = uuid::Uuid::new_v4();
    let input = json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"reading","size":1048576,"mime":"","source_label":"Desk"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let r = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from(vec![42; 1048576]),
        )
        .await;
    let original: Value =
        serde_json::from_slice(&to_bytes(r.into_body(), 4096).await.unwrap()).unwrap();
    let file = original["file_id"].as_str().unwrap();
    let path = format!("/api/files/{file}");
    // 不消费有界响应，保证服务器仍持有真实文件读取句柄。
    let download = f.request("GET", &path, Body::empty()).await;
    assert_eq!(download.status(), StatusCode::OK);
    let (code, conflict) = f.json("DELETE", &path, Value::Null).await;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "FILE_IN_USE");
    assert_eq!(
        f.json("GET", &format!("{path}/status"), Value::Null)
            .await
            .1["state_version"],
        "1"
    );
    drop(download);
    // 只等待任务释放资源，不通过自动重发 DELETE 把冲突变成排队删除。
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let r = f.request("GET", &path, Body::empty()).await;
            let data = to_bytes(r.into_body(), 1048576).await.unwrap();
            assert_eq!(data.len(), 1048576);
            if std::fs::read_dir("/proc/self/fd")
                .unwrap()
                .filter_map(Result::ok)
                .filter_map(|e| std::fs::read_link(e.path()).ok())
                .all(|p| p != f._root.path().join("files").join(file))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        f.json("GET", &format!("{path}/status"), Value::Null)
            .await
            .1["file_state"],
        "available"
    );
    assert_eq!(
        f.request("HEAD", &path, Body::empty()).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        f.json("DELETE", &path, Value::Null).await.0,
        StatusCode::ACCEPTED
    );
}

#[tokio::test]
async fn delete_requires_cookie_origin_and_a_managed_identifier() {
    let f = Fixture::new().await;
    let path = format!("/api/files/{}", uuid::Uuid::new_v4());
    for (cookie, origin, expected) in [
        (
            "",
            Some("https://filehop.invalid"),
            StatusCode::UNAUTHORIZED,
        ),
        (f.cookie.as_str(), None, StatusCode::FORBIDDEN),
        (
            f.cookie.as_str(),
            Some("https://other.invalid"),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let mut request = Request::builder()
            .method("DELETE")
            .uri(&path)
            .header("cookie", cookie);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let response = f
            .app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()["cache-control"], "no-store");
    }
    for path in [
        &path,
        "/api/files/not-a-uuid",
        "/api/files/%2e%2e%2fstorage-id",
    ] {
        assert_eq!(
            f.json("DELETE", path, Value::Null).await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert!(f._root.path().join("files/storage-id").is_file());
}

#[tokio::test]
async fn missing_committed_file_is_versioned_without_rewriting_success_or_releasing_quota() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"missing.txt","size":3,"mime":"text/plain","source_label":"Desk"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("abc"),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let original: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let file = original["file_id"].as_str().unwrap();
    std::fs::remove_file(f._root.path().join("files").join(file)).unwrap();
    // 普通列表只报告已知状态；外部移除直到实际下载打开才被发现。
    assert_eq!(
        f.json("GET", "/api/files", Value::Null).await.1["files"][0],
        original
    );
    let download = format!("/api/files/{file}");
    assert_eq!(
        f.json("GET", &download, Value::Null).await.1["code"],
        "storage_error"
    );
    let mut expected = original.clone();
    expected["file_state"] = json!("storage_error");
    expected["state_version"] = json!("2");
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        expected
    );
    // 重复检测不会不断增加版本；文件恢复也不自动修复已知异常或重新上传。
    std::fs::write(f._root.path().join("files").join(file), "abc").unwrap();
    assert_eq!(
        f.json("GET", &download, Value::Null).await.1["code"],
        "storage_error"
    );
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .1["message"],
        expected
    );
    assert_eq!(f.json("POST", "/api/file-sends", input).await.1, expected);
    assert_eq!(
        f.json("GET", "/api/messages", Value::Null).await.1["messages"],
        json!([expected])
    );
    // 配额调至恰好等于原文件大小；异常不能偷偷释放已报告成功的占用。
    let config = backend::session::Config {
        transfer: backend::TransferConfig {
            quota: 3,
            ..Default::default()
        },
        ..Default::default()
    };
    let app = backend::app_with_config(
        f._root.path().join("database"),
        f._root.path().join("files"),
        config,
    );
    let f = Fixture::with_app(f._root, app).await;
    assert_eq!(f.json("POST", "/api/file-sends", json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"over","size":1,"mime":"","source_label":"Desk"})).await.1["code"], "quota_exceeded");
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        expected
    );
}

#[tokio::test]
async fn global_storage_faults_and_file_permissions_do_not_mark_files_missing() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    f.json("POST", "/api/file-sends", json!({"send_id":send,"attempt_id":attempt,"name":"healthy.txt","size":3,"mime":"","source_label":"Desk"})).await;
    let r = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("abc"),
        )
        .await;
    let original: Value =
        serde_json::from_slice(&to_bytes(r.into_body(), 4096).await.unwrap()).unwrap();
    let file = original["file_id"].as_str().unwrap();
    let files = f._root.path().join("files");
    let entity = files.join(file);
    let path = format!("/api/files/{file}");
    let identity = std::fs::read(files.join("storage-id")).unwrap();
    for fault in ["identity", "directory", "permission"] {
        match fault {
            "identity" => {
                std::fs::write(files.join("storage-id"), uuid::Uuid::new_v4().to_string()).unwrap()
            }
            "directory" => {
                std::fs::set_permissions(&files, std::fs::Permissions::from_mode(0o0)).unwrap()
            }
            _ => std::fs::set_permissions(&entity, std::fs::Permissions::from_mode(0o0)).unwrap(),
        }
        let (status, error) = f.json("GET", &path, Value::Null).await;
        // 先恢复测试资源，再断言，保证失败时临时目录仍能安全清理。
        std::fs::set_permissions(&files, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&entity, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(files.join("storage-id"), &identity).unwrap();
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error["code"], "unavailable");
        assert!(!error.to_string().contains(f._root.path().to_str().unwrap()));
        assert_eq!(
            f.json("GET", &format!("/api/sends/{send}"), Value::Null)
                .await
                .1,
            original
        );
    }
    // 目录被替换为空目录（模拟挂载缺失）也不能变成单文件丢失。
    let held = f._root.path().join("held-files");
    std::fs::rename(&files, &held).unwrap();
    std::fs::create_dir(&files).unwrap();
    let result = f.json("GET", &path, Value::Null).await;
    std::fs::remove_dir(&files).unwrap();
    std::fs::rename(&held, &files).unwrap();
    assert_eq!(result.1["code"], "unavailable");
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .1,
        original
    );
    // 既有启动协调遇到明确的大小异常时持久记录；不新增定时扫描或内容校验。
    std::fs::write(&entity, "a").unwrap();
    backend::files_recover(&f._root.path().join("database"), &files)
        .await
        .unwrap();
    let current = f
        .json("GET", &format!("/api/sends/{send}"), Value::Null)
        .await
        .1;
    assert_eq!(current["file_state"], "storage_error");
    assert_eq!(current["state_version"], "2");
    assert_eq!(current["id"], original["id"]);
}

#[tokio::test]
async fn file_status_queries_are_bounded_authenticated_and_do_not_probe_entities() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    f.json("POST", "/api/file-sends", json!({"send_id":send,"attempt_id":attempt,"name":"status.txt","size":0,"mime":"","source_label":"Desk"})).await;
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::empty(),
        )
        .await;
    let original: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
    let file = original["file_id"].as_str().unwrap();
    let path = format!("/api/files/{file}/status");
    let expected = json!({"file_id":file,"file_state":"available","state_version":"1"});
    std::fs::remove_file(f._root.path().join("files").join(file)).unwrap();
    assert_eq!(
        f.json("GET", &path, Value::Null).await,
        (StatusCode::OK, expected.clone())
    );
    let unknown = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        f.json(
            "POST",
            "/api/files/status-query",
            json!({"file_ids":[file, unknown]})
        )
        .await
        .1,
        json!({"files":[expected],"not_found":[unknown]})
    );
    for body in [
        json!({"file_ids":[]}),
        json!({"file_ids":vec![file;101]}),
        json!({"file_ids":["../other"]}),
        json!({"file_ids":[file],"extra":true}),
    ] {
        assert_eq!(
            f.json("POST", "/api/files/status-query", body).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        f.json("GET", &format!("/api/files/{unknown}/status"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    for (method, uri) in [("GET", path.as_str()), ("POST", "/api/files/status-query")] {
        let r = f
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header("origin", "https://filehop.invalid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(r.headers()["cache-control"], "no-store");
    }
    for origin in [None, Some("https://other.invalid"), Some("null")] {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/files/status-query")
            .header("cookie", &f.cookie)
            .header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        assert_eq!(
            f.app
                .clone()
                .oneshot(
                    request
                        .body(Body::from(json!({"file_ids":[file]}).to_string()))
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    f.request("HEAD", &format!("/api/files/{file}"), Body::empty())
        .await;
    let changed = json!({"file_id":file,"file_state":"storage_error","state_version":"2"});
    assert_eq!(f.json("GET", &path, Value::Null).await.1, changed);
    assert_eq!(
        f.json(
            "POST",
            "/api/files/status-query",
            json!({"file_ids":[file,file]})
        )
        .await
        .1,
        json!({"files":[changed],"not_found":[]})
    );
}

#[tokio::test]
async fn storage_snapshot_is_private_and_moves_reservations_to_saved() {
    let f = Fixture::new().await;
    let denied = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/storage")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(denied.headers()["cache-control"], "no-store");
    let response = f.request("GET", "/api/storage", Body::empty()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let (_, empty) = f.json("GET", "/api/storage", Value::Null).await;
    assert_eq!(
        empty,
        json!({"quota_bytes":"1073741824", "saved_bytes":"0", "reserved_bytes":"0", "cleaning_bytes":"0", "available_bytes":"1073741824", "over_quota":false})
    );
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"snapshot","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let (_, reserved) = f.json("GET", "/api/storage", Value::Null).await;
    assert_eq!(reserved["reserved_bytes"], "3");
    assert_eq!(reserved["available_bytes"], "1073741821");
    assert_eq!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::from("abc")
        )
        .await
        .status(),
        StatusCode::OK
    );
    let (_, saved) = f.json("GET", "/api/storage", Value::Null).await;
    assert_eq!(saved["saved_bytes"], "3");
    assert_eq!(saved["reserved_bytes"], "0");
    assert_eq!(saved["cleaning_bytes"], "0");
    assert_eq!(saved["available_bytes"], "1073741821");
    // 用同一隔离实例的持久数据重新加载更低额度，不改写或删除已保存文件。
    let mut config = backend::session::Config::default();
    config.transfer.quota = 2;
    let app = backend::app_with_config(
        f._root.path().join("database"),
        f._root.path().join("files"),
        config,
    );
    let f = Fixture::with_app(f._root, app).await;
    let (_, lowered) = f.json("GET", "/api/storage", Value::Null).await;
    assert_eq!(
        lowered,
        json!({"quota_bytes":"2", "saved_bytes":"3", "reserved_bytes":"0", "cleaning_bytes":"0", "available_bytes":"0", "over_quota":true})
    );
    assert_eq!(
        f.json("GET", "/api/files", Value::Null).await.1["files"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn server_file_list_is_authenticated_committed_only_and_cursor_paginated() {
    let f = Fixture::new().await;
    let denied = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/files?limit=bad")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(denied.headers()["cache-control"], "no-store");
    let response = f.request("GET", "/api/files", Body::empty()).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let (_, empty) = f.json("GET", "/api/files", Value::Null).await;
    assert_eq!(empty, json!({"files":[], "before":null, "has_more":false}));
    let pending = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"not committed","size":0,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", pending).await.0,
        StatusCode::OK
    );
    let mut committed = Vec::new();
    for n in 0..52 {
        let send = uuid::Uuid::new_v4().to_string();
        let attempt = uuid::Uuid::new_v4().to_string();
        let input = json!({"send_id":send,"attempt_id":attempt,"name":format!("file-{n}.txt"),"size":0,"mime":"text/plain","source_label":"Desk"});
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
        let message: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(message["state_version"], "1");
        assert_eq!(
            f.json("GET", &format!("/api/sends/{send}"), Value::Null)
                .await
                .1,
            message
        );
        assert_eq!(
            f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
                .await
                .1["message"],
            message
        );
        committed.push(message);
    }
    let (_, text) = f.json("POST", "/api/messages", json!({"send_id":uuid::Uuid::new_v4().to_string(), "text":"not a server file", "source_label":"Desk"})).await;
    assert!(text.get("state_version").is_none());
    committed.reverse();
    let (_, first) = f.json("GET", "/api/files", Value::Null).await;
    assert_eq!(first["files"], json!(committed[..50]));
    assert_eq!(first["has_more"], true);
    assert_eq!(first["before"], committed[49]["id"]);
    let (_, last) = f
        .json(
            "GET",
            &format!("/api/files?before={}", first["before"].as_str().unwrap()),
            Value::Null,
        )
        .await;
    assert_eq!(last["files"], json!(committed[50..]));
    assert_eq!(last["has_more"], false);
    assert_eq!(
        f.json("GET", "/api/files?limit=100", Value::Null).await.1["files"],
        json!(committed)
    );
    for query in [
        "limit=0",
        "limit=101",
        "before=0",
        "before=-1",
        "after=1",
        "limit=bad",
    ] {
        assert_eq!(
            f.json("GET", &format!("/api/files?{query}"), Value::Null)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (_, history) = f.json("GET", "/api/messages?limit=100", Value::Null).await;
    let mut chronological = committed.clone();
    chronological.reverse();
    chronological.push(text);
    assert_eq!(history["messages"], json!(chronological));
    // 重建应用后文件列表和版本保持一致，已提交记录不能随页面或应用对象重建丢失。
    let f = Fixture::from_paths(f._root).await;
    assert_eq!(
        f.json("GET", "/api/files?limit=100", Value::Null).await.1["files"],
        json!(committed)
    );
}

#[tokio::test]
async fn stop_before_prepare_is_durable_and_successor_can_register_missing_metadata() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let first = uuid::Uuid::new_v4().to_string();
    let next = uuid::Uuid::new_v4().to_string();
    let stop = format!("/api/file-sends/{send}/attempts/{first}/stop");
    let input = json!({"send_id":send,"attempt_id":first,"name":"late","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", &stop, Value::Null).await.1["state"],
        "stopped"
    );
    assert_eq!(
        f.json("POST", &stop, Value::Null).await.1["state"],
        "stopped"
    );
    // 纯停止标记尚无元数据；首次准备才决定发送身份的固定文件信息。
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.1["state"],
        "stopped"
    );
    let path = format!("/api/file-sends/{send}/attempts");
    let retry = json!({"attempt_id":next,"previous_attempt_id":first,"name":"late","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", &path, retry.clone()).await.1["state"],
        "prepared"
    );
    assert_eq!(f.json("POST", &path, retry).await.1["attempt_id"], next);
    assert_eq!(f.json("POST", &path, json!({"attempt_id":next,"previous_attempt_id":first,"name":"other","size":3,"mime":"","source_label":"Web"})).await.1["code"], "attempt_conflict");
    assert_eq!(f.json("POST", &path, json!({"attempt_id":uuid::Uuid::new_v4().to_string(),"previous_attempt_id":first,"name":"late","size":3,"mime":"","source_label":"Web"})).await.1["code"], "attempt_conflict");
    assert_eq!(f.json("POST", "/api/file-sends", json!({"send_id":send,"attempt_id":first,"name":"wrong","size":3,"mime":"","source_label":"Web"})).await.1["code"], "send_conflict");
    assert_eq!(
        f.json("POST", &stop, Value::Null).await.1["state"],
        "stopped"
    );
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.1["state"],
        "stopped"
    );
    assert_eq!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{next}/content"),
            Body::from("abc")
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        f.json("GET", "/api/messages", Value::Null).await.1["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn successor_stop_before_prepare_is_bound_to_one_predecessor() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let first = uuid::Uuid::new_v4().to_string();
    let next = uuid::Uuid::new_v4().to_string();
    let sibling = uuid::Uuid::new_v4().to_string();
    let meta = json!({"send_id":send,"attempt_id":first,"name":"no bytes","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", meta).await.1["state"],
        "prepared"
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("/api/file-sends/{send}/attempts/{first}/stop"),
            Value::Null
        )
        .await
        .1["state"],
        "stopped"
    );
    let next_path = format!("/api/file-sends/{send}/attempts");
    assert_eq!(
        f.json(
            "POST",
            &format!("/api/file-sends/{send}/attempts/{next}/stop"),
            Value::Null
        )
        .await
        .1["state"],
        "stopped"
    );
    assert_eq!(
        f.json(
            "POST",
            &next_path,
            json!({"attempt_id":next,"previous_attempt_id":first})
        )
        .await
        .1["state"],
        "stopped"
    );
    assert_eq!(
        f.json(
            "POST",
            &next_path,
            json!({"attempt_id":sibling,"previous_attempt_id":first})
        )
        .await
        .1["code"],
        "attempt_conflict"
    );
    assert_ne!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{next}/content"),
            Body::from("abc")
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn successor_stop_arriving_before_first_prepare_remains_stopped() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let first = uuid::Uuid::new_v4().to_string();
    let next = uuid::Uuid::new_v4().to_string();
    let stop = format!("/api/file-sends/{send}/attempts/{next}/stop");
    assert_eq!(
        f.json("POST", &stop, Value::Null).await.1["state"],
        "stopped"
    );
    let first_meta = json!({"send_id":send,"attempt_id":first,"name":"first","size":1,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", first_meta).await.1["state"],
        "prepared"
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("/api/file-sends/{send}/attempts/{first}/stop"),
            Value::Null
        )
        .await
        .1["state"],
        "stopped"
    );
    assert_eq!(
        f.json(
            "POST",
            &format!("/api/file-sends/{send}/attempts"),
            json!({"attempt_id":next,"previous_attempt_id":first})
        )
        .await
        .1["state"],
        "stopped"
    );
    assert_ne!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{next}/content"),
            Body::from("a")
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn stop_marker_survives_restart_without_inventing_file_metadata() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let first = uuid::Uuid::new_v4().to_string();
    let stop = format!("/api/file-sends/{send}/attempts/{first}/stop");
    assert_eq!(
        f.json("POST", &stop, Value::Null).await.1["state"],
        "stopped"
    );
    backend::files_recover(
        &f._root.path().join("database"),
        &f._root.path().join("files"),
    )
    .await
    .unwrap();
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .1["attempt_id"],
        first
    );
    assert_eq!(f.json("POST", "/api/file-sends", json!({"send_id":send,"attempt_id":first,"name":"after restart","size":0,"mime":"","source_label":"Web"})).await.1["state"], "stopped");
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn stop_during_a_stream_forbids_commit_and_keeps_quota_until_writer_exits() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let mut config = backend::session::Config::default();
    config.transfer.quota = 3;
    config.transfer.disk_reserve = 0;
    let f = Fixture::with_app(root, backend::app_with_config(database, files, config)).await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"stream","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    sender.send(Ok(vec![b'a'])).await.unwrap();
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|chunk| (chunk, receiver))
    });
    let path = format!("/api/file-sends/{send}/attempts/{attempt}/content");
    let app = f.app.clone();
    let cookie = f.cookie.clone();
    let upload = tokio::spawn(async move {
        app.oneshot(
            Request::builder()
                .method("PUT")
                .uri(path)
                .header("cookie", cookie)
                .header("origin", "https://filehop.invalid")
                .body(Body::from_stream(stream))
                .unwrap(),
        )
        .await
        .unwrap()
    });
    let ready = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let (_, state) = f
                .json("GET", &format!("/api/file-sends/{send}"), Value::Null)
                .await;
            if state["state"] == "writing" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    ready.unwrap();
    let stop = format!("/api/file-sends/{send}/attempts/{attempt}/stop");
    assert_eq!(
        f.json("POST", &stop, Value::Null).await.1["state"],
        "stopped"
    );
    let other = json!({"send_id":uuid::Uuid::new_v4().to_string(),"attempt_id":uuid::Uuid::new_v4().to_string(),"name":"other","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", other.clone()).await.1["code"],
        "quota_exceeded"
    );
    sender.send(Ok(vec![b'b', b'c'])).await.unwrap();
    drop(sender);
    assert_ne!(upload.await.unwrap().status(), StatusCode::OK);
    assert_eq!(
        f.json("GET", &format!("/api/sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json("POST", "/api/file-sends", other).await.1["state"],
        "prepared"
    );
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .1["state"],
        "stopped"
    );
}

#[tokio::test]
async fn stop_after_commit_returns_the_original_message_and_is_origin_protected() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"kept","size":0,"mime":"","source_label":"Web"});
    let stop = format!("/api/file-sends/{send}/attempts/{attempt}/stop");
    let denied = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&stop)
                .header("cookie", &f.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            Body::empty()
        )
        .await
        .status(),
        StatusCode::OK
    );
    let (_, original) = f
        .json("GET", &format!("/api/sends/{send}"), Value::Null)
        .await;
    assert_eq!(f.json("POST", &stop, Value::Null).await.1, original);
}

#[tokio::test]
async fn query_and_successor_are_idempotent_and_old_writer_cannot_commit() {
    let f = Fixture::new().await;
    let send = uuid::Uuid::new_v4().to_string();
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    let third = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":first,"name":"retry","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.json("POST", "/api/file-sends", input.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .1["state"],
        "prepared"
    );
    let retry = json!({"attempt_id":second,"previous_attempt_id":first});
    let path = format!("/api/file-sends/{send}/attempts");
    assert_eq!(
        f.json("POST", &path, retry.clone()).await.1["code"],
        "attempt_busy"
    );
    let denied = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&path)
                .header("cookie", &f.cookie)
                .header("content-type", "application/json")
                .body(Body::from(retry.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{first}/content"),
            Body::from("xy")
        )
        .await
        .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .1["state"],
        "failed"
    );
    assert_eq!(
        f.json("POST", &path, retry.clone()).await.1["state"],
        "prepared"
    );
    assert_eq!(f.json("POST", &path, retry).await.1["attempt_id"], second);
    assert_eq!(
        f.json(
            "POST",
            &path,
            json!({"attempt_id":third,"previous_attempt_id":first})
        )
        .await
        .1["code"],
        "attempt_conflict"
    );
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.1["state"],
        "failed"
    );
    assert_ne!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{first}/content"),
            Body::from("abc")
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{second}/content"),
            Body::from("abc")
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .1["message"]["kind"],
        "FILE"
    );
    assert_eq!(
        f.json(
            "POST",
            &path,
            json!({"attempt_id":third,"previous_attempt_id":second})
        )
        .await
        .1["kind"],
        "FILE"
    );
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
async fn authenticated_upload_finishes_after_expiry_but_new_requests_require_login() {
    use std::sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    };
    let original = Fixture::new().await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let time = Arc::new(AtomicI64::new(now));
    let mut config = backend::session::Config::default();
    let clock = time.clone();
    config.now = Arc::new(move || clock.load(Ordering::SeqCst));
    let app = backend::app_with_config(
        original._root.path().join("database"),
        original._root.path().join("files"),
        config,
    );
    let f = Fixture::with_app(original._root, app).await;
    let send = uuid::Uuid::new_v4().to_string();
    let attempt = uuid::Uuid::new_v4().to_string();
    let input = json!({"send_id":send,"attempt_id":attempt,"name":"expiry.txt","size":3,"mime":"","source_label":"Web"});
    assert_eq!(
        f.json("POST", "/api/file-sends", input).await.0,
        StatusCode::OK
    );
    // 首次读取请求体说明鉴权与准入已经完成；此时推进认证时钟，不等待真实十二小时。
    let body = Body::from_stream(futures_util::stream::once(async move {
        time.fetch_add(43_200, Ordering::SeqCst);
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"abc"))
    }));
    let response = f
        .request(
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            body,
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        f.json("GET", &format!("/api/file-sends/{send}"), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let f = Fixture::with_app(f._root, f.app).await;
    let (status, result) = f
        .json("GET", &format!("/api/file-sends/{send}"), Value::Null)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["state"], "success");
    let response = f
        .request(
            "GET",
            &format!(
                "/api/files/{}",
                result["message"]["file_id"].as_str().unwrap()
            ),
            Body::empty(),
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
        b"abc"
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
                assert_eq!(
                    to_bytes(response.into_body(), 262144).await.unwrap().len(),
                    262144
                );
                break true;
            }
            assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert!(released);
    // 原响应尚未销毁，超时已关闭真实句柄，因此不再阻止删除。
    assert_eq!(
        f.json("DELETE", &path, Value::Null).await.0,
        StatusCode::ACCEPTED
    );
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
