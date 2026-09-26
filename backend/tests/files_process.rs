use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    time::Duration,
};

#[path = "support/resource_probe.rs"]
mod resource_probe;

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
async fn real_download_delete_race_and_disconnect_obey_handle_lifetime() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("database");
    let files = root.path().join("files");
    std::fs::create_dir(&database).unwrap();
    std::fs::create_dir(&files).unwrap();
    backend::storage::initialize(&database, &files, "Admin", " synthetic password ")
        .await
        .unwrap();
    let (_server, address) = start(&database, &files);
    let second = Command::new(env!("CARGO_BIN_EXE_backend"))
        .args([
            "--database-dir",
            database.to_str().unwrap(),
            "--files-dir",
            files.to_str().unwrap(),
            "serve",
            "--listen",
            "127.0.0.1:0",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut second = Server(second);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = second.0.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "second backend was not rejected"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let (_, login) = http(
        address,
        "POST",
        "/api/session",
        "",
        r#"{"username":"Admin","password":" synthetic password "}"#,
    );
    let cookie = login
        .lines()
        .find_map(|l| l.strip_prefix("set-cookie: "))
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    for race in [false, true] {
        let send = uuid::Uuid::new_v4();
        let attempt = uuid::Uuid::new_v4();
        let input = serde_json::json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"reading","size":16777216,"mime":"","source_label":"Web"}).to_string();
        assert_eq!(
            http(address, "POST", "/api/file-sends", &cookie, &input).0,
            200
        );
        let (code, response) = http(
            address,
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            &cookie,
            &"x".repeat(16777216),
        );
        assert_eq!(code, 200);
        let message: serde_json::Value =
            serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let file = message["file_id"].as_str().unwrap();
        let path = format!("/api/files/{file}");
        let mut download = TcpStream::connect(address).unwrap();
        download
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            download,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nCookie: {cookie}\r\n\r\n"
        )
        .unwrap();
        let mut reader = BufReader::new(download);
        let mut status = String::new();
        if !race {
            reader.read_line(&mut status).unwrap();
            assert!(status.contains("200"));
        }
        let (code, response) = http(address, "DELETE", &path, &cookie, "");
        if race {
            reader.read_line(&mut status).unwrap();
        }
        if code == 202 {
            assert!(race);
            assert!(status.contains("410"), "{status}");
        } else {
            assert_eq!(code, 409, "{response}");
            assert!(response.contains("FILE_IN_USE"));
            assert!(status.contains("200"));
        }
        drop(reader); // 真实 TCP 断连后，仅查询状态；拒绝的删除不会自动重发。
        if code == 409 {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                let pid = _server.0.id();
                let still_open = std::fs::read_dir(format!("/proc/{pid}/fd"))
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter_map(|e| std::fs::read_link(e.path()).ok())
                    .any(|p| p == files.join(file));
                if !still_open {
                    break;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "disconnected read retained its handle"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            let (_, state) = http(address, "GET", &format!("{path}/status"), &cookie, "");
            assert!(state.contains("\"file_state\":\"available\""), "{state}");
            assert_eq!(http(address, "DELETE", &path, &cookie, "").0, 202);
        }
        assert_eq!(http(address, "GET", &path, &cookie, "").0, 410);
    }
}

#[tokio::test]
async fn accepted_deletion_recovers_after_kill_before_unlink_or_final_commit() {
    use sqlx::Connection;
    for after_unlink in [false, true] {
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
            .find_map(|l| l.strip_prefix("set-cookie: "))
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let send = uuid::Uuid::new_v4();
        let attempt = uuid::Uuid::new_v4();
        let input = serde_json::json!({"send_id":send.to_string(),"attempt_id":attempt.to_string(),"name":"delete","size":4,"mime":"","source_label":"Desk"}).to_string();
        assert_eq!(
            http(address, "POST", "/api/file-sends", cookie, &input).0,
            200
        );
        let (code, response) = http(
            address,
            "PUT",
            &format!("/api/file-sends/{send}/attempts/{attempt}/content"),
            cookie,
            "data",
        );
        assert_eq!(code, 200);
        let message: serde_json::Value =
            serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let file = message["file_id"].as_str().unwrap();
        let path = format!("/api/files/{file}");
        let mut db = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new().filename(database.join("transfer.db")),
        )
        .await
        .unwrap();
        // 仅在隔离数据库注入持久化失败，不用表结构断言行为，也不发布故障入口。
        sqlx::query("CREATE TRIGGER reject_delete_completion BEFORE UPDATE OF file_state ON message WHEN NEW.file_state='deleted' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
            .execute(&mut db).await.unwrap();
        if !after_unlink {
            std::fs::remove_file(files.join(file)).unwrap();
            std::fs::create_dir(files.join(file)).unwrap();
        }
        assert_eq!(http(address, "DELETE", &path, cookie, "").0, 202);
        if after_unlink {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while files.join(file).exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "cleanup did not unlink"
                );
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        let (_, state) = http(address, "GET", &format!("{path}/status"), cookie, "");
        assert!(state.contains("\"file_state\":\"deleting\""), "{state}");
        let (_, usage) = http(address, "GET", "/api/storage", cookie, "");
        assert!(usage.contains("\"cleaning_bytes\":\"4\""), "{usage}");
        drop(server); // 在删除已接受／实体已删除但额度未释放时真正 SIGKILL。
        if !after_unlink {
            std::fs::remove_dir(files.join(file)).unwrap();
        }
        sqlx::query("DROP TRIGGER reject_delete_completion")
            .execute(&mut db)
            .await
            .unwrap();
        db.close().await.unwrap();
        let (server, address) = start(&database, &files);
        let (code, state) = http(address, "DELETE", &path, cookie, "");
        assert_eq!(code, 200, "{state}");
        assert!(state.contains("\"state_version\":\"3\""), "{state}");
        let (_, replay) = http(address, "POST", "/api/file-sends", cookie, &input);
        assert!(replay.contains("\"file_state\":\"deleted\""), "{replay}");
        let (_, usage) = http(address, "GET", "/api/storage", cookie, "");
        assert!(usage.contains("\"cleaning_bytes\":\"0\""), "{usage}");
        assert!(!files.join(file).exists());
        drop(server);
        let (_server, address) = start(&database, &files);
        let (_, state) = http(address, "DELETE", &path, cookie, "");
        assert!(state.contains("\"state_version\":\"3\""), "{state}");
    }
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
