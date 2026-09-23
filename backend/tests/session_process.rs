mod support;

use axum::{
    body::{Body, to_bytes},
    http::Request,
};
use portable_pty::CommandBuilder;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tower::ServiceExt;

struct Server(Child);
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn start(database: &std::path::Path, files: &std::path::Path) -> (Server, SocketAddr) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_backend"))
        .args([
            "--database-dir",
            database.to_str().unwrap(),
            "--files-dir",
            files.to_str().unwrap(),
            "serve",
            "--listen",
            "127.0.0.1:0",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(address) = line.strip_prefix("listening=") {
                let _ = tx.send(address.parse::<SocketAddr>().unwrap());
                break;
            }
        }
    });
    let server = Server(child);
    let address = rx
        .recv_timeout(Duration::from_secs(15))
        .expect("server startup");
    (server, address)
}
fn http(address: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn committed_message_and_session_survive_sigkill_and_graceful_restart() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_backend"));
    command.args([
        "--database-dir",
        database.to_str().unwrap(),
        "--files-dir",
        files.to_str().unwrap(),
        "init",
        "--username",
        "Admin",
        "--confirm-paths",
    ]);
    assert!(support::terminal(command, " synthetic password ").0);
    let (server, address) = start(&database, &files);
    let body = r#"{"username":"Admin","password":" synthetic password "}"#;
    let response = http(
        address,
        &format!(
            "POST /api/session HTTP/1.1\r\nHost: localhost\r\nOrigin: https://filehop.invalid\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(response.starts_with("HTTP/1.1 200"));
    let cookie = response
        .lines()
        .find_map(|l| l.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let payload = serde_json::json!({
        "send_id": "12345678-1234-4234-8234-123456789abc",
        "text": "  synthetic persistence\n第二行 <b>plain text</b>  ",
        "source_label": "Lifecycle test"
    });
    let send = |address| {
        let body = payload.to_string();
        http(
            address,
            &format!(
                "POST /api/messages HTTP/1.1\r\nHost: localhost\r\nOrigin: https://filehop.invalid\r\nCookie: {cookie}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
    };
    let get = |address, path| {
        http(
            address,
            &format!(
                "GET {path} HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n"
            ),
        )
    };
    let json = |response: &str| -> serde_json::Value {
        serde_json::from_str(response.split_once("\r\n\r\n").unwrap().1).unwrap()
    };
    let response = send(address);
    assert!(response.starts_with("HTTP/1.1 201"));
    let saved = json(&response);
    assert_eq!(saved["text"], payload["text"]);
    assert_eq!(saved["send_id"], payload["send_id"]);
    assert_eq!(saved["source_label"], payload["source_label"]);
    let session = json(&get(address, "/api/session"));
    drop(server); // SIGKILL，不经过优雅关闭路径；成功响应必须已经持久化。
    let (mut server, mut address) = start(&database, &files);
    for graceful in [false, true] {
        let response = get(address, "/api/session");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("cache-control: no-store"));
        assert_eq!(json(&response)["expires_at"], session["expires_at"]);
        let response = get(address, "/api/sends/12345678-1234-4234-8234-123456789abc");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(json(&response), saved);
        let response = send(address);
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(json(&response), saved);
        let response = get(address, "/api/messages");
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(json(&response)["messages"], serde_json::json!([saved]));
        if !graceful {
            // SIGTERM 走正式优雅关闭路径，限定等待期限以免测试无限挂起。
            assert!(
                Command::new("kill")
                    .args(["-TERM", &server.0.id().to_string()])
                    .status()
                    .unwrap()
                    .success()
            );
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = server.0.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
                assert!(Instant::now() < deadline, "graceful shutdown timed out");
                std::thread::sleep(Duration::from_millis(20));
            }
            // 下一次迭代必须访问新进程，而非已经停止的旧地址。
            let (restarted, new_address) = start(&database, &files);
            server = restarted;
            address = new_address;
        }
    }
}

#[tokio::test]
async fn password_reset_hides_input_revokes_all_sessions_and_preserves_storage() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let sentinel = files.join("synthetic-business-data");
    std::fs::write(&sentinel, b"preserve this content").unwrap();
    let identity = std::fs::read(database.join("storage-id")).unwrap();
    let app = backend::app(database.clone(), files.clone());
    let login = |password: &str| {
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/session")
                .header("origin", "https://filehop.invalid")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"username":"Admin", "password":password}).to_string(),
                ))
                .unwrap(),
        )
    };
    let mut cookies = Vec::new();
    for _ in 0..2 {
        let response = login(" synthetic password ").await.unwrap();
        assert!(response.status().is_success());
        cookies.push(
            response.headers()["set-cookie"]
                .to_str()
                .unwrap()
                .split(';')
                .next()
                .unwrap()
                .to_owned(),
        );
    }
    let reset = |password: &str| {
        let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_backend"));
        command.args([
            "--database-dir",
            database.to_str().unwrap(),
            "--files-dir",
            files.to_str().unwrap(),
            "reset-password",
        ]);
        support::terminal(command, password)
    };
    let (success, output) = reset("short");
    assert!(!success);
    assert!(!output.contains("short"));
    for cookie in &cookies {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let (success, output) = reset(" new synthetic password ");
    assert!(success, "{output}");
    assert!(!output.contains("new synthetic password"));
    for cookie in &cookies {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/session")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 401);
    }
    assert_eq!(login(" synthetic password ").await.unwrap().status(), 401);
    assert_eq!(
        login(" new synthetic password ").await.unwrap().status(),
        200
    );
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"preserve this content");
    assert_eq!(
        std::fs::read(database.join("storage-id")).unwrap(),
        identity
    );
    assert!(matches!(
        backend::storage::inspect(&database, &files).await,
        backend::storage::Status::Initialized
    ));
}

#[tokio::test]
#[ignore = "manual release-mode resource measurement"]
async fn measure_login_budget() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let app = backend::app(database, files);
    let login = || {
        app.clone().oneshot(
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
    };
    for _ in 0..5 {
        let start = Instant::now();
        let response = login().await.unwrap();
        assert!(response.status().is_success());
        let _ = to_bytes(response.into_body(), 8192).await.unwrap();
        println!("single_login_ms={}", start.elapsed().as_millis());
    }
    let start = Instant::now();
    let (a, b) = tokio::join!(login(), login());
    assert!(a.unwrap().status().is_success());
    assert!(b.unwrap().status().is_success());
    println!("two_concurrent_logins_ms={}", start.elapsed().as_millis());
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines().filter(|line| line.starts_with("VmHWM:")) {
            println!("{line}");
        }
    }
}
