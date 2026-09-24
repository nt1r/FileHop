use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    time::Duration,
};

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
    let output = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            if let Some(addr) = line.strip_prefix("listening=") {
                let _ = tx.send(addr.parse::<SocketAddr>().unwrap());
                break;
            }
        }
    });
    let server = Server(child);
    (
        server,
        rx.recv_timeout(Duration::from_secs(15))
            .expect("recovery before listen"),
    )
}
fn http(address: SocketAddr, method: &str, path: &str, cookie: &str, body: &str) -> (u16, String) {
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    write!(socket,"{method} {path} HTTP/1.1\r\nHost: localhost\r\nOrigin: https://filehop.invalid\r\nCookie: {cookie}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    (response[9..12].parse().unwrap(), response)
}
#[tokio::test]
async fn committed_file_survives_forced_process_exit_and_remains_downloadable() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let (server, address) = start(&database, &files);
    let (_, login) = http(
        address,
        "POST",
        "/api/session",
        "",
        r#"{"username":"Admin","password":" synthetic password "}"#,
    );
    let cookie = login
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let send = uuid::Uuid::new_v4();
    let attempt = uuid::Uuid::new_v4();
    let input = serde_json::json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),
        "name":"saved.txt","size":4,"mime":"text/plain","source_label":"Web"})
    .to_string();
    assert_eq!(
        http(address, "POST", "/api/file-sends", &cookie, &input).0,
        200
    );
    let (status, response) = http(
        address,
        "PUT",
        &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
        &cookie,
        "data",
    );
    assert_eq!(status, 200, "{response}");
    let message: serde_json::Value =
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let file_id = message["file_id"].as_str().unwrap();
    drop(server); // SIGKILL，而非正常关闭，重启前没有机会执行清理。
    let (_server, address) = start(&database, &files);
    assert_eq!(
        http(address, "GET", &format!("/api/sends/{send}"), &cookie, "").0,
        200
    );
    let (status, download) = http(
        address,
        "GET",
        &format!("/api/files/{file_id}"),
        &cookie,
        "",
    );
    assert_eq!(status, 200, "{download}");
    assert!(
        download.ends_with("\r\n\r\ndata") || download.contains("\r\n4\r\ndata\r\n"),
        "{download}"
    );
    let (_, replay) = http(address, "POST", "/api/file-sends", &cookie, &input);
    assert!(replay.contains("\"kind\":\"FILE\""), "{replay}");
}

#[tokio::test]
async fn killed_writer_is_not_committed_and_recovery_releases_its_reservation() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let (server, address) = start(&database, &files);
    let (_, login) = http(
        address,
        "POST",
        "/api/session",
        "",
        r#"{"username":"Admin","password":" synthetic password "}"#,
    );
    let cookie = login
        .lines()
        .find_map(|line| line.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let send = uuid::Uuid::new_v4();
    let attempt = uuid::Uuid::new_v4();
    let input=serde_json::json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"incomplete","size":1000,"mime":"","source_label":"Web"}).to_string();
    assert_eq!(
        http(address, "POST", "/api/file-sends", &cookie, &input).0,
        200
    );
    let mut socket = TcpStream::connect(address).unwrap();
    write!(socket,"PUT /api/file-sends/{send}/attempts/{attempt}/content HTTP/1.1\r\nHost: localhost\r\nOrigin: https://filehop.invalid\r\nCookie: {cookie}\r\nContent-Length: 1000\r\n\r\nabc").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (_, response) = http(address, "POST", "/api/file-sends", &cookie, &input);
        if response.contains("\"state\":\"writing\"") {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "writer never started: {response}"
        );
        std::thread::yield_now();
    }
    drop(server);
    drop(socket);
    let (_server, address) = start(&database, &files);
    assert_eq!(
        http(address, "GET", &format!("/api/sends/{send}"), &cookie, "").0,
        404
    );
    let (_, replay) = http(address, "POST", "/api/file-sends", &cookie, &input);
    assert!(replay.contains("\"state\":\"failed\""), "{replay}");
    assert_eq!(
        std::fs::read_dir(&files)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name() != "storage-id")
            .count(),
        0
    );
}
