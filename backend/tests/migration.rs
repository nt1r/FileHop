use std::{fs, path::PathBuf, process::Command};

struct Instance {
    _root: tempfile::TempDir,
    database: PathBuf,
    files: PathBuf,
}
impl Instance {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("database");
        let files = root.path().join("files");
        fs::create_dir(&database).unwrap();
        fs::create_dir(&files).unwrap();
        Self {
            _root: root,
            database,
            files,
        }
    }
    fn command(&self, command: &str) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_backend"));
        cmd.arg("--database-dir")
            .arg(&self.database)
            .arg("--files-dir")
            .arg(&self.files)
            .arg(command);
        cmd
    }
    async fn initialize(&self) {
        backend::storage::initialize(&self.database, &self.files, "Admin", " synthetic password ")
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn migration_refuses_missing_mismatched_and_partial_storage_without_replacement() {
    for fault in [
        "empty", "database", "identity", "mismatch", "account", "history", "checksum", "dirty",
        "future",
    ] {
        let i = Instance::new();
        if fault != "empty" {
            i.initialize().await;
        }
        match fault {
            "database" => fs::rename(
                i.database.join("transfer.db"),
                i.database.join("original.db"),
            )
            .unwrap(),
            "identity" => fs::remove_file(i.files.join("storage-id")).unwrap(),
            "mismatch" => {
                fs::write(i.files.join("storage-id"), uuid::Uuid::new_v4().to_string()).unwrap()
            }
            "account" | "history" | "checksum" | "dirty" | "future" => {
                use sqlx::Connection;
                let mut db = sqlx::SqliteConnection::connect_with(
                    &sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(i.database.join("transfer.db")),
                )
                .await
                .unwrap();
                let sql = match fault {
                    "account" => "DELETE FROM account",
                    "history" => "DROP TABLE _sqlx_migrations",
                    "checksum" => "UPDATE _sqlx_migrations SET checksum=X'00'",
                    "dirty" => "UPDATE _sqlx_migrations SET success=0",
                    _ => "UPDATE _sqlx_migrations SET version=9999",
                };
                sqlx::query(sql).execute(&mut db).await.unwrap();
                db.close().await.unwrap();
            }
            _ => (),
        }
        let before: Vec<_> = [&i.database, &i.files]
            .into_iter()
            .flat_map(|p| fs::read_dir(p).unwrap())
            .map(|entry| {
                let p = entry.unwrap().path();
                let bytes = fs::read(&p).unwrap();
                (p, bytes)
            })
            .collect();
        let output = i.command("migrate").output().unwrap();
        assert!(!output.status.success(), "{fault}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("migration failed"),
            "{fault}: {:?}",
            output
        );
        for (path, bytes) in before {
            assert_eq!(fs::read(path).unwrap(), bytes, "{fault}");
        }
        if fault == "empty" || fault == "database" {
            assert!(!i.database.join("transfer.db").exists());
        }
    }
}

struct Process(std::process::Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn running_backend_excludes_migration_and_releases_lock_on_exit() {
    use std::io::{BufRead, BufReader, Read, Write};
    for initialize_before_start in [true, false] {
        let i = Instance::new();
        if initialize_before_start {
            i.initialize().await;
        }
        let mut server = Process(
            i.command("serve")
                .args(["--listen", "127.0.0.1:0"])
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let stdout = server.0.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(address) = line.strip_prefix("listening=") {
                    let _ = tx.send(address.parse::<std::net::SocketAddr>().unwrap());
                    break;
                }
            }
        });
        let address = rx.recv_timeout(std::time::Duration::from_secs(15)).unwrap();
        if !initialize_before_start {
            i.initialize().await;
        }
        let mut socket =
            std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5))
                .unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        write!(
            socket,
            "GET /internal/ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let output = i.command("migrate").output().unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("another backend or migration"));
        drop(server);
        assert!(i.command("migrate").output().unwrap().status.success());
    }
}

#[tokio::test]
async fn migrating_process_excludes_backend_and_second_migration() {
    use sqlx::Connection;
    let i = Instance::new();
    i.initialize().await;
    // 真实 SQLite 排他事务暂停迁移的身份读取，不增加应用故障开关。
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(i.database.join("transfer.db"))
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete),
    )
    .await
    .unwrap();
    sqlx::query("BEGIN EXCLUSIVE")
        .execute(&mut db)
        .await
        .unwrap();
    let mut migration = Process(i.command("migrate").spawn().unwrap());
    let identity = fs::File::open(i.database.join("storage-id")).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        if fs2::FileExt::try_lock_exclusive(&identity).is_err() {
            break;
        }
        fs2::FileExt::unlock(&identity).unwrap();
        assert!(migration.0.try_wait().unwrap().is_none());
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(!i.command("migrate").output().unwrap().status.success());
    assert!(
        !i.command("serve")
            .args(["--listen", "127.0.0.1:0"])
            .output()
            .unwrap()
            .status
            .success()
    );
    sqlx::query("ROLLBACK").execute(&mut db).await.unwrap();
    db.close().await.unwrap();
    assert!(migration.0.wait().unwrap().success());
}

#[tokio::test]
async fn independent_migration_accepts_existing_instance_without_reinitializing() {
    let i = Instance::new();
    i.initialize().await;
    let identity = fs::read(i.files.join("storage-id")).unwrap();
    let output = i.command("migrate").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Migration completed"));
    assert_eq!(fs::read(i.files.join("storage-id")).unwrap(), identity);
}
