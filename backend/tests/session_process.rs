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
fn committed_session_survives_sigkill_and_restart() {
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
    drop(server); // SIGKILL，不经过优雅关闭路径。
    let (_server, address) = start(&database, &files);
    let response = http(
        address,
        &format!(
            "GET /api/session HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n"
        ),
    );
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("cache-control: no-store"));
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
